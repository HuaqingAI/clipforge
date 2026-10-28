import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { assets, projects, scripts } from "@/lib/db/schema";
import { resolveCurrentScript } from "@/lib/current-script";
import { assetMatchesScript, assetScopeForShot, scriptRevision, type ScriptContext } from "@/lib/asset-context";
import { generationAssetId, persistAssetSource, saveAssetCandidate } from "@/lib/asset-persistence";
import { recordAiTask, updateAiTaskByProviderTaskId } from "@/lib/ai-tasks";
import { createProvider } from "@/lib/providers";
import { projectGenerationSignature } from "@/lib/generation-source-context";
import { assertGenerationInputs } from "@/lib/generation-inputs";
import { generationCheckpoint, withGenerationContext } from "@/lib/generation-context";
import { GenerationExecutionError, type GenerationCheckpoint, type GenerationExecutionItem } from "@/lib/generation-types";
import { klingJobs } from "@/lib/kling/job-schema";
import { createKlingJob, retryKlingImport, startKlingJobRunner } from "@/lib/kling/jobs";
import { getKlingJob, getKlingOutputs } from "@/lib/kling/repository";
import { sanitizeGenerationControlSummary } from "@/lib/video-repair-plan";
import { generationRuns } from "@/lib/generation-schema";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const string = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
const hasGeneratedScripts = (checkpoint: RecordValue): boolean => Array.isArray(checkpoint.generatedScripts) && checkpoint.generatedScripts.length > 0;
const pending = (stage = "cloud_running", retryAfterMs = 5000) => ({ pending: true, stage, retryAfterMs });
const attention = (message: string) => new GenerationExecutionError(message, "GENERATION_NEEDS_ATTENTION");

/** No provider call is retried after an ambiguous submission. Recovery only observes known work. */
export async function executeGenerationItem(item: GenerationExecutionItem, save: GenerationCheckpoint): Promise<RecordValue> {
  let checkpoint: RecordValue = { ...item.checkpoint };
  return withGenerationContext({ itemId: item.id, checkpoint, snapshot: item.payload.snapshot,
    deferPolling: item.kind === "video" || item.kind === "image" || item.kind === "keyframe_refine",
    beforeSubmission: () => {
      if (getDb().select({ cancelRequested: generationRuns.cancelRequested }).from(generationRuns).where(eq(generationRuns.id, item.runId)).get()?.cancelRequested) {
        generationCheckpoint({ submissionState: "not_submitted", cancelledBeforeSubmission: true, stage: "cancelled" });
        throw new GenerationExecutionError("任务已在付费提交前取消。", "GENERATION_CANCELLED");
      }
      if (item.kind === "video" || item.kind === "image" || item.kind === "keyframe_refine") assertSourceCurrent(item);
      else assertGenerationInputs(item.payload.snapshot?.referenceInputs);
    },
    save: (value) => { save(value); checkpoint = value; } }, async () => {
    if (checkpoint.completedResult) return record(checkpoint.completedResult);
    const request: RecordValue = { ...item.payload.request, projectId: item.projectId,
      ...(item.scriptId && { scriptId: item.scriptId }), ...(item.shotId !== null && { shotId: item.shotId }) };
    if (item.kind === "script" || item.kind === "storyboard_grid") return executeDocument(item, request, () => checkpoint);
    if (item.kind === "keyframe_refine") return executeRefinement(item, request, () => checkpoint);
    if (request.provider === "kling-cli") return executeKling(item, request, () => checkpoint);

    const urls = () => [...new Set(strings(checkpoint.resultUrls).concat(strings(checkpoint.videoUrls), strings(checkpoint.imageUrls)))];
    if (!urls().length && string(checkpoint.taskId)) {
      const providerName = string(request.provider)!;
      const provider = createProvider({ name: providerName, apiKey: string(request.apiKey) ?? "", baseUrl: string(request.baseUrl) ?? "" });
      let status;
      try { status = await provider.getTaskStatus(string(checkpoint.taskId)!); }
      catch (error) { throw new GenerationExecutionError(error instanceof Error ? error.message : "查询云端任务失败", "GENERATION_QUERY_FAILED", true); }
      if (status.status === "failed" || status.status === "cancelled") {
        await updateAiTaskByProviderTaskId(providerName, status.taskId, { status: "failed", error: status.error ?? "云端生成失败" });
        throw new GenerationExecutionError(status.error ?? "云端生成失败", "GENERATION_PROVIDER_FAILED");
      }
      const result = record(status.result);
      const resultUrls = item.kind === "video" ? strings(result.videoUrls) : strings(result.imageUrls);
      if (resultUrls.length) {
        generationCheckpoint({ resultUrls, generationResult: result, stage: "importing", submissionState: "acknowledged" });
        await updateAiTaskByProviderTaskId(providerName, status.taskId, { status: "completed", resultUrls, error: null });
      } else {
        if (status.status === "completed") throw new GenerationExecutionError("云端已完成，但尚未返回素材地址；后台将继续查询原任务。", "GENERATION_RESULT_NOT_READY", true);
        return pending();
      }
    }
    if (!urls().length) {
      if (checkpoint.submissionState === "submitting" || checkpoint.submissionState === "acknowledged") throw attention("上次付费提交结果不明，已停止自动重试。请先核对原平台任务，避免重复扣费。");
      assertSourceCurrent(item);
      const req = internalRequest(item.kind === "video" ? "/api/ai/video" : "/api/ai/image", request);
      const response = item.kind === "video" ? await (await import("@/app/api/ai/video/route")).POST(req) : await (await import("@/app/api/ai/image/route")).POST(req);
      const body = record(await response.json());
      const resultUrls = item.kind === "video" ? strings(body.videoUrls) : strings(body.imageUrls);
      if (string(body.taskId)) generationCheckpoint({ taskId: body.taskId, modelId: body.modelId ?? request.model, submissionState: "acknowledged" });
      if (resultUrls.length) generationCheckpoint({ resultUrls, generationResult: body, stage: "importing" });
      if (string(checkpoint.taskId)) await recordAiTask({ projectId: item.projectId, shotId: item.shotId ?? undefined, provider: String(request.provider), model: String(checkpoint.modelId ?? request.model ?? ""), mediaType: item.kind, mode: string(request.mode), prompt: string(request.prompt), taskId: String(checkpoint.taskId), controlPlan: sanitizeGenerationControlSummary(item.payload.asset?.generationPlan) ?? undefined });
      if (!response.ok) {
        if (string(checkpoint.taskId) || resultUrls.length) return pending("recovering");
        if (response.status === 429 && checkpoint.submissionState === "not_submitted") return pending("provider_rate_limited", 30_000);
        if (checkpoint.submissionState === "submitting") throw attention(string(body.error) ?? "提交受理情况不明，请核对原平台任务后继续。");
        throw new GenerationExecutionError(string(body.error) ?? "生成请求校验失败", string(body.code) ?? "GENERATION_REJECTED");
      }
      if (!urls().length && string(checkpoint.taskId)) return pending();
      if (!urls().length) throw attention("平台没有返回可恢复的任务编号或素材地址，请核对本次提交。");
    }
    const resultUrls = urls();
    generationCheckpoint({ resultUrls, stage: "importing" });
    const imported: RecordValue[] = [];
    for (const [index, url] of resultUrls.entries()) imported.push(await importMedia(item, request, checkpoint, url, index));
    const first = imported[0];
    const result = { ...first, assetIds: imported.map((output) => output.assetId), filePaths: imported.map((output) => output.filePath),
      [item.kind === "video" ? "videoUrls" : "imageUrls"]: imported.map((output) => output.filePath) };
    const taskId = string(checkpoint.taskId);
    if (taskId) await updateAiTaskByProviderTaskId(String(request.provider), taskId, { status: "completed", resultUrls, importState: "imported", assetId: String(first.assetId), error: null });
    generationCheckpoint({ completedResult: result, assetId: first.assetId, stage: "ready" });
    return result;
  }).catch((error) => {
    if (checkpoint.cancelledBeforeSubmission) throw new GenerationExecutionError("任务已在付费提交前取消。", "GENERATION_CANCELLED");
    throw error;
  });
}

function internalRequest(path: string, body: RecordValue, method = "POST") {
  return new NextRequest(`http://localhost${path}`, { method, headers: { "content-type": "application/json", "accept-language": "zh" }, body: JSON.stringify(body) });
}

function assertSourceCurrent(item: GenerationExecutionItem): void {
  assertGenerationInputs(item.payload.snapshot?.referenceInputs);
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, item.projectId)).get();
  const current = resolveCurrentScript(db.select().from(scripts).where(eq(scripts.projectId, item.projectId)).all());
  const frozenProject = item.payload.snapshot?.project;
  const frozenScript = item.payload.snapshot?.script as unknown as ScriptContext | undefined;
  if (!project || !current || current.id !== item.scriptId || !current.shots?.some((s) => s.shotId === item.shotId)
    || (frozenProject && projectGenerationSignature(project as unknown as RecordValue) !== projectGenerationSignature(frozenProject))
    || (frozenScript && scriptRevision(current) !== scriptRevision(frozenScript))) {
    throw new GenerationExecutionError("等待期间项目或脚本内容已变化，已阻止首次付费生成。请按当前内容重新确认。", "GENERATION_SOURCE_CHANGED");
  }
  if (item.kind === "keyframe_refine") {
    const frozenSource = item.payload.snapshot?.refinement?.source;
    const source = frozenSource && db.select().from(assets).where(eq(assets.id, String(frozenSource.id))).get();
    if (!frozenSource || !source || source.status !== "done" || source.projectId !== item.projectId || source.shotId !== item.shotId
      || !assetMatchesScript(source, current) || ["filePath", "sourceScriptId", "sourceShotKey", "sourceRevision", "derivedFromAssetId", "type"].some((key) => source[key as keyof typeof source] !== frozenSource[key])) {
      throw new GenerationExecutionError("等待期间精修源图已变化，已阻止首次付费生成。请重新选择并确认源图。", "GENERATION_SOURCE_CHANGED");
    }
  }
}

async function executeRefinement(item: GenerationExecutionItem, request: RecordValue, checkpoint: () => RecordValue): Promise<RecordValue> {
  const urls = () => [...new Set([...strings(checkpoint().imageUrls), ...strings(checkpoint().resultUrls)])];
  const providerName = String(request.provider);
  const taskId = () => string(checkpoint().taskId);
  // A plan is persisted before submission; never rebuild it from edited inputs after payment.
  if ((taskId() || urls().length) && !checkpoint().refinementPlan) throw attention("原精修任务缺少已确认的导入信息，请核对服务商记录后人工恢复。");
  if (!urls().length && taskId()) {
    const provider = createProvider({ name: providerName, apiKey: string(request.apiKey) ?? "", baseUrl: string(request.baseUrl) ?? "" });
    let status;
    try { status = await provider.getTaskStatus(taskId()!); }
    catch (error) { throw new GenerationExecutionError(error instanceof Error ? error.message : "查询精修任务失败", "GENERATION_QUERY_FAILED", true); }
    if (status.status === "failed" || status.status === "cancelled") {
      await updateAiTaskByProviderTaskId(providerName, taskId()!, { status: "failed", error: status.error ?? "云端精修失败" });
      throw new GenerationExecutionError(status.error ?? "云端精修失败", "GENERATION_PROVIDER_FAILED");
    }
    const outputs = strings(record(status.result).imageUrls);
    if (!outputs.length) {
      if (status.status === "completed") throw new GenerationExecutionError("精修任务已完成，后台将继续查询原任务的图片地址。", "GENERATION_RESULT_NOT_READY", true);
      return pending();
    }
    generationCheckpoint({ imageUrls: outputs, resultUrls: outputs, stage: "importing", submissionState: "acknowledged" });
    await updateAiTaskByProviderTaskId(providerName, taskId()!, { status: "completed", resultUrls: outputs, error: null });
  }
  if (!urls().length) {
    if (checkpoint().submissionState === "submitting" || checkpoint().submissionState === "acknowledged") throw attention("上次精修的付费提交结果不明，已停止自动重试，请先核对服务商任务记录。");
    assertSourceCurrent(item);
  }
  const response = await (await import("@/app/api/project/[id]/keyframe-refine/route")).POST(
    internalRequest(`/api/project/${item.projectId}/keyframe-refine`, request), { params: Promise.resolve({ id: item.projectId }) });
  const result = record(await response.json());
  if (checkpoint().cancelledBeforeSubmission) throw new GenerationExecutionError("任务已在付费提交前取消。", "GENERATION_CANCELLED");
  if (string(result.taskId)) generationCheckpoint({ taskId: result.taskId, submissionState: "acknowledged" });
  if (taskId()) await recordAiTask({ projectId: item.projectId, shotId: item.shotId ?? undefined, provider: providerName,
    model: String(checkpoint().modelId ?? request.model ?? ""), mediaType: "image", mode: "image-to-image", taskId: taskId()!, prompt: string(record(checkpoint().refinementPlan).prompt) });
  if (!response.ok) {
    if (response.status === 429 && checkpoint().submissionState === "not_submitted") return pending("provider_rate_limited", 30_000);
    if (urls().length) throw new GenerationExecutionError(string(result.error) ?? "精修结果导入未完成", "GENERATION_IMPORT_FAILED", true);
    if (taskId()) return pending("recovering");
    if (checkpoint().submissionState === "submitting" || checkpoint().submissionState === "acknowledged") throw attention(string(result.error) ?? "精修受理情况不明，请核对原任务。");
    throw new GenerationExecutionError(string(result.error) ?? "精修请求被拒绝", string(result.code) ?? "GENERATION_REJECTED");
  }
  if (result.pending === true || response.status === 202) return pending();
  if (!record(result.asset).id) throw attention("平台未返回可恢复的精修素材，请核对原任务。");
  if (taskId()) await updateAiTaskByProviderTaskId(providerName, taskId()!, { status: "completed", resultUrls: urls(), importState: "imported", assetId: String(record(result.asset).id), error: null });
  generationCheckpoint({ completedResult: result, assetId: record(result.asset).id, stage: "ready" });
  return result;
}

async function executeDocument(item: GenerationExecutionItem, request: RecordValue, checkpoint: () => RecordValue): Promise<RecordValue> {
  const db = getDb();
  // A script may have committed just before the worker died; replay its durable request identity.
  if (item.kind === "script") {
    const saved = db.select().from(scripts).where(eq(scripts.projectId, item.projectId)).all().filter((s) => s.generationMetadata?.requestId === item.id);
    if (saved.length) {
      const result = { scripts: saved };
      generationCheckpoint({ completedResult: result, stage: "ready" });
      return result;
    }
  }
  const value = checkpoint();
  if (value.submissionState === "submitting" && !strings(value.imageUrls).length && !string(value.taskId) && !hasGeneratedScripts(value)) throw attention("上次生成中断且受理结果不明，已停止自动重新生成，请核对原任务。");
  // Async grid providers can be observed without paying again, then the route resumes cropping.
  if (item.kind === "storyboard_grid" && !strings(value.imageUrls).length && string(value.taskId)) {
    const provider = createProvider({ name: String(request.provider), apiKey: string(request.apiKey) ?? "", baseUrl: string(request.baseUrl) ?? "" });
    let status;
    try { status = await provider.getTaskStatus(String(value.taskId)); }
    catch (error) { throw new GenerationExecutionError(error instanceof Error ? error.message : "查询分镜任务失败", "GENERATION_QUERY_FAILED", true); }
    if (status.status === "failed" || status.status === "cancelled") throw new GenerationExecutionError(status.error ?? "分镜生成失败", "GENERATION_PROVIDER_FAILED");
    const imageUrls = strings(record(status.result).imageUrls);
    if (!imageUrls.length) return pending();
    generationCheckpoint({ imageUrls, resultUrls: imageUrls, stage: "importing", submissionState: "acknowledged" });
  }
  let response: Response;
  if (item.kind === "storyboard_grid") {
    response = await (await import("@/app/api/project/[id]/storyboard-grid/route")).POST(internalRequest(`/api/project/${item.projectId}/storyboard-grid`, request), { params: Promise.resolve({ id: item.projectId }) });
  } else {
    const body = { ...request, requestId: item.id };
    const endpoint = string(request.generationEndpoint) ?? "/api/llm/script";
    if (endpoint === "/api/topic/script") response = await (await import("@/app/api/topic/script/route")).POST(internalRequest(endpoint, body));
    else if (endpoint === `/api/project/${item.projectId}/scripts` && request.generationMethod === "PATCH") response = await (await import("@/app/api/project/[id]/scripts/route")).PATCH(internalRequest(endpoint, body, "PATCH"), { params: Promise.resolve({ id: item.projectId }) });
    else if (endpoint === "/api/llm/script") response = await (await import("@/app/api/llm/script/route")).POST(internalRequest(endpoint, body));
    else throw new GenerationExecutionError("不支持的脚本生成入口", "GENERATION_ENDPOINT_INVALID");
  }
  const result = record(await response.json());
  if (!response.ok) {
    if (item.kind === "script") {
      const saved = db.select().from(scripts).where(eq(scripts.projectId, item.projectId)).all().filter((script) => script.generationMetadata?.requestId === item.id);
      if (saved.length) {
        const recovered = { scripts: saved, historical: true, warning: string(result.error) ?? "生成结果已作为原项目的历史脚本保存。" };
        generationCheckpoint({ completedResult: recovered, stage: "ready" });
        return recovered;
      }
    }
    if (response.status === 429 && checkpoint().submissionState === "not_submitted") return pending("provider_rate_limited", 30_000);
    if (hasGeneratedScripts(checkpoint()) || strings(checkpoint().imageUrls).length || string(checkpoint().taskId)) throw new GenerationExecutionError(string(result.error) ?? "已生成结果的保存未完成", "GENERATION_IMPORT_FAILED", true);
    if (checkpoint().submissionState === "submitting") throw attention(string(result.error) ?? "生成中断且受理情况不明，请核对原任务。");
    throw new GenerationExecutionError(string(result.error) ?? "生成失败", string(result.code) ?? "GENERATION_FAILED");
  }
  generationCheckpoint({ completedResult: result, stage: "ready" });
  return result;
}

async function executeKling(item: GenerationExecutionItem, request: RecordValue, checkpoint: () => RecordValue): Promise<RecordValue> {
  // Lookup precedes creation even when the item checkpoint never landed after child creation.
  let job = string(checkpoint().childJobId) ? getKlingJob(String(checkpoint().childJobId)) : getDb().select().from(klingJobs).where(and(eq(klingJobs.profileId, String(request.profileId)), eq(klingJobs.clientRequestId, item.id))).get();
  if (job?.data.deletedAt) throw attention("原 Kling 任务已删除，已阻止重新提交。");
  if (!job) {
    assertSourceCurrent(item);
    try {
      job = await createKlingJob({ ...request, clientRequestId: item.id, billingAcknowledgement: { policyRevision: "credits-v1", acceptedForRequestId: item.id } });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "KLING_PROFILE_BUSY") return pending("waiting_for_profile");
      if (code === "KLING_SUBMISSION_UNKNOWN" || code === "KLING_LOGIN_REQUIRED" || code === "KLING_ENVIRONMENT_REQUIRED") throw attention(error instanceof Error ? error.message : "Kling 账号需要确认");
      throw error;
    }
  }
  generationCheckpoint({ childJobId: job.id, stage: "cloud_running", ...(job.remoteGenerationId && { remoteTaskId: job.remoteGenerationId }) });
  startKlingJobRunner();
  if (job.submissionState === "submission_unknown" || job.needsConfirmation || job.autoQueryPaused || job.submissionState === "not_submitted") throw attention(job.data.error?.message ?? job.data.blockedReason ?? "原 Kling 任务需要手动确认，请在原任务中继续。");
  if (job.remoteState === "failed" || job.remoteState === "cancelled") throw new GenerationExecutionError(job.data.error?.message ?? "Kling 生成失败", "GENERATION_PROVIDER_FAILED");
  if (job.remoteState !== "completed") return pending();
  let outputs = getKlingOutputs(job.id).filter((output) => !output.data.deletedAt);
  if (outputs.some((output) => output.importState !== "imported")) {
    try { await retryKlingImport(job.id); }
    catch (error) { throw new GenerationExecutionError(error instanceof Error ? error.message : "Kling 素材导入失败", "GENERATION_IMPORT_FAILED", true); }
    outputs = getKlingOutputs(job.id).filter((output) => !output.data.deletedAt);
  }
  if (!outputs.length || outputs.some((output) => output.importState !== "imported")) return pending("importing");
  const result = { childJobId: job.id, assetIds: outputs.flatMap((output) => output.assetId ? [output.assetId] : []), videoUrls: outputs.flatMap((output) => output.data.filePath ? [output.data.filePath] : []) };
  if (job.remoteGenerationId && result.assetIds[0]) await updateAiTaskByProviderTaskId("kling-cli", job.remoteGenerationId, { status: "completed", importState: "imported", assetId: result.assetIds[0], error: null });
  generationCheckpoint({ completedResult: result, stage: "ready" });
  return result;
}

async function importMedia(item: GenerationExecutionItem, request: RecordValue, checkpoint: RecordValue, url: string, outputIndex: number): Promise<RecordValue> {
  const db = getDb();
  const outputKey = `${item.id}:${outputIndex}`;
  const existing = db.select().from(assets).where(eq(assets.id, generationAssetId(item.projectId, outputKey))).get();
  const provider = String(request.provider);
  const taskId = string(checkpoint.taskId);
  try {
    let asset = existing;
    if (!asset) {
      const project = db.select().from(projects).where(eq(projects.id, item.projectId)).get();
      if (!project) throw attention("原项目已删除，已保留云端任务和素材地址，请核对后恢复。");
      const frozen = item.payload.snapshot?.script as unknown as ScriptContext | undefined;
      const source = frozen ?? (item.scriptId ? db.select().from(scripts).where(eq(scripts.id, item.scriptId)).get() : undefined);
      const shot = source?.shots?.find((s) => s.shotId === item.shotId);
      if (!source || !shot) throw attention("缺少原镜头快照，已保留生成结果，请核对后恢复。");
      const localPath = string(record(checkpoint.localPaths)[String(outputIndex)]) ?? (outputIndex === 0 ? string(checkpoint.localPath) : undefined)
        ?? await persistAssetSource(item.projectId, url, item.shotId!, "generation");
      generationCheckpoint({ localPaths: { ...record(checkpoint.localPaths), [outputIndex]: localPath }, ...(outputIndex === 0 && { localPath }), stage: "importing" });
      const input = item.payload.asset ?? {};
      const sourceProject = item.payload.snapshot?.project;
      const unchangedProject = !sourceProject || projectGenerationSignature(project as unknown as RecordValue) === projectGenerationSignature(sourceProject);
      asset = await saveAssetCandidate({ projectId: item.projectId, shotId: item.shotId!, filePath: localPath,
        idempotencyKey: outputKey, type: "ai_generated", provider, model: String(checkpoint.modelId ?? request.model ?? ""),
        prompt: string(input.prompt) ?? string(request.prompt), thumbnailPath: string(input.thumbnailPath),
        generationPlan: sanitizeGenerationControlSummary(input.generationPlan ?? request.controlPlan),
        sourceKeyframeUrl: string(input.sourceKeyframeUrl) ?? string(input.thumbnailPath) ?? string(request.imageUrl),
        scope: assetScopeForShot(source, shot), allowHistoricalScope: true,
        selectedPolicy: unchangedProject && outputIndex === 0 ? { mode: "select-if-unchanged", baseline: { scriptId: source.id, scriptRevision: scriptRevision(source), selectedAssetId: string(input.expectedSelectedAssetId) ?? null, requireRevisionMatch: true } } : { mode: "alternative" },
      });
    }
    const result = { assetId: asset.id, filePath: asset.filePath, selected: asset.selected, [item.kind === "video" ? "videoUrls" : "imageUrls"]: [asset.filePath], ...(taskId && { taskId }) };
    generationCheckpoint({ ...(outputIndex === 0 && { assetId: asset.id }), stage: "importing" });
    return result;
  } catch (error) {
    if (error instanceof GenerationExecutionError) throw error;
    if (taskId) await updateAiTaskByProviderTaskId(provider, taskId, { status: "completed", resultUrls: strings(checkpoint.resultUrls), importState: "failed", error: error instanceof Error ? error.message : String(error) });
    throw new GenerationExecutionError(error instanceof Error ? error.message : "素材导入失败", "GENERATION_IMPORT_FAILED", true);
  }
}
