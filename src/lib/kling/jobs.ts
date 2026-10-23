import { resolveCurrentScript } from "@/lib/current-script";
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { aiTasks, assets, projects, scripts } from "@/lib/db/schema";
import { filterAssetsForScript, scriptRevision, shotKey } from "@/lib/asset-context";
import { getDataDir } from "@/lib/paths";
import { klingJobs, klingJobOutputs, type KlingJob, type KlingJobData } from "./job-schema";
import { getProfile } from "./profiles";
import { refreshProfile } from "./auth";
import { runKling, withKlingLease } from "./cli-runner";
import { normalizeKlingTask, record, extractGenerationId, parseCliJson } from "./protocol";
import { KLING_ADAPTER_VERSION } from "./types";
import type { KlingCliResult, KlingLease, KlingNormalizedTask } from "./types";
import { KlingError } from "./errors";
import { classifyKlingSubmissionFailure, createKlingSubmissionDiagnostics } from "./submission-diagnostics";
import { createKlingCliDiagnostics } from "./cli-diagnostics";
import { contentHash, canonicalJson, normalizeVideoParameters, prepareKlingInputs, buildKlingVideoArguments, assertValidKlingPrompt } from "./inputs";
import { VIDEO_PROMPT_VERSION } from "@/lib/video-prompt";
import { getKlingJob, getKlingOutputs, patchKlingJob, isKlingJobUnresolved, listKlingJobs, withKlingJobLease, klingJobView, assertKlingJobLease, withoutKlingJobLease } from "./repository";
import { importKlingOutputs, selectKlingOutput } from "./output-import";
import type { KlingSubmitRequest } from "./job-types";
import { klingFilmRuns } from "./film-schema";
import { KLING_MAX_CONCURRENT_SHOTS, klingJobHasUnknownSubmission, klingJobOccupiesGenerationSlot } from "./concurrency";
import { cleanupDeletedKlingJobs } from "./delete-job";
import { isKlingRuntimeEnabled } from "./runtime";
import { checkCreativeProfileContext, isPremiumProductCgProfile } from "@/lib/creative-profiles";
import { lintCreativeProfileShot } from "@/lib/creative-policy-lint";
import { compilePremiumCgVideoPrompt } from "@/lib/premium-cg-prompt";
import { resolvePremiumCgVideoReferences } from "@/lib/premium-cg-video";
import { filterTrustedPremiumCgAssets } from "@/lib/premium-cg-assets";
import { KLING_AUDIO_PARAMETER_NAMES } from "./model-options";
import type { KlingParameter, KlingVideoModelDescriptor } from "./types";

interface JobRuntime { bootId: string; busy: boolean; timer?: ReturnType<typeof setInterval>; bindingSecret: string; }
const globalState = globalThis as unknown as { __clipforgeKlingJobs?: JobRuntime };
const runtime = globalState.__clipforgeKlingJobs ??= { bootId: randomUUID(), busy: false, bindingSecret: randomUUID() };
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const GENERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;

function disabledAudioValue(parameter: KlingParameter): string | number | boolean | undefined {
  const candidates = parameter.allowedValues ?? (parameter.default !== undefined ? [parameter.default] : []);
  const disabled = new Set(["false", "off", "no", "0", "disabled", "disable"]);
  const matched = candidates.find((value) => disabled.has(String(value).toLowerCase()));
  if (matched !== undefined) return matched;
  return parameter.type === "boolean" && !parameter.allowedValues ? false : undefined;
}

/** CG narration is composed from the approved script later; the image-to-video provider stays silent. */
const PREMIUM_CG_NEGATIVE_PARAMETER_NAMES = ["negative_prompt", "negativePrompt"];

function premiumCgVideoOptions(
  model: KlingVideoModelDescriptor,
  raw: Record<string, unknown>,
  negativePrompt?: string,
): Record<string, string | number | boolean> {
  const source = { ...raw };
  for (const key of KLING_AUDIO_PARAMETER_NAMES) delete source[key];
  // A provider-specific negative prompt is still a model instruction. Premium CG owns it
  // together with the positive prompt so a browser cannot weaken the no-added-text policy.
  for (const key of PREMIUM_CG_NEGATIVE_PARAMETER_NAMES) delete source[key];
  const negative = model.parameters.find((parameter) => PREMIUM_CG_NEGATIVE_PARAMETER_NAMES.includes(parameter.name));
  if (negativePrompt && negative) source[negative.name] = negativePrompt;
  const normalized = normalizeVideoParameters(model, source);
  const audio = model.parameters.find((parameter) => KLING_AUDIO_PARAMETER_NAMES.includes(parameter.name));
  if (!audio) {
    if (model.capabilities.audio) throw new KlingError("CREATIVE_POLICY_UNSUPPORTED", "当前 Kling 模型无法可靠关闭原生音频，不能用于高端产品 CG。", 422);
    return normalized;
  }
  const disabled = disabledAudioValue(audio);
  if (disabled === undefined) throw new KlingError("CREATIVE_POLICY_UNSUPPORTED", "当前 Kling 模型未声明可关闭的音频参数，不能用于高端产品 CG。", 422);
  normalized[audio.name] = disabled;
  return normalized;
}

type KlingReferenceInput = { role: "image" | "tailImage"; sourceUrl: string };

function premiumCgReferenceInputs(
  project: typeof projects.$inferSelect,
  script: typeof scripts.$inferSelect,
  shotId: number,
): KlingReferenceInput[] {
  const selectedAssets = filterTrustedPremiumCgAssets(filterAssetsForScript(
    getDb().select().from(assets).where(and(
      eq(assets.projectId, project.id),
      eq(assets.selected, true),
      eq(assets.status, "done"),
    )).all(),
    script,
  ), project.id, script);
  // The server derives the entire reference chain. Client-provided first/last/reference
  // URLs are intentionally absent here: a saved product image or selected keyframe is the
  // only source that can reach the paid request.
  const resolved = resolvePremiumCgVideoReferences({
    productImages: project.productImages,
    selectedAssets,
    shotIds: script.shots?.map((shot) => shot.shotId) ?? [],
    shotId,
  });
  if (!resolved.ok) {
    throw new KlingError(
      resolved.code,
      resolved.code === "PREMIUM_CG_PRODUCT_REFERENCE_REQUIRED"
        ? "高端产品 CG 需要至少一张已保存的产品参考图。"
        : "高端产品 CG 只能使用已保存的产品图片和当前项目已选关键帧。",
      422,
    );
  }
  const imageUrls = [...new Set([resolved.imageUrl, ...resolved.referenceImageUrls])];
  return [
    ...imageUrls.map((sourceUrl) => ({ role: "image" as const, sourceUrl })),
    ...(resolved.lastImageUrl ? [{ role: "tailImage" as const, sourceUrl: resolved.lastImageUrl }] : []),
  ];
}

function creativeProfileContextError(context: ReturnType<typeof checkCreativeProfileContext>): KlingError | undefined {
  if (context.ok) return undefined;
  return new KlingError(
    context.code,
    context.code === "CREATIVE_CONFIG_STALE"
      ? "脚本基于旧的创作配置，请重新生成脚本后再生成视频。"
      : "当前脚本与项目创作类型不匹配，请切换到匹配类型或重新生成脚本。",
    409,
  );
}

function assertCreativeProfileContext(
  project: Parameters<typeof checkCreativeProfileContext>[0],
  script: Parameters<typeof checkCreativeProfileContext>[1],
) {
  const context = checkCreativeProfileContext(project, script);
  const error = creativeProfileContextError(context);
  if (error) throw error;
  return context;
}

export interface KlingFilmShotContext {
  filmRunId: string;
  filmShotId: string;
  authorizationEpoch: number;
  expectedInputHashes?: Array<{ role: string; hash: string }>;
}
export interface KlingFilmDispatchGrant extends KlingFilmShotContext {
  /** Must synchronously verify the durable parent run, shot binding, boot and authorization epoch. */
  assertDispatchAllowed(): void;
}
function filmContext(input: KlingFilmShotContext): KlingFilmShotContext {
  if (!input || typeof input.filmRunId !== "string" || typeof input.filmShotId !== "string" || !ID.test(input.filmRunId) || !ID.test(input.filmShotId) || !Number.isSafeInteger(input.authorizationEpoch) || input.authorizationEpoch < 1 ||
    (input.expectedInputHashes !== undefined && (!Array.isArray(input.expectedInputHashes) || input.expectedInputHashes.length > 10 || input.expectedInputHashes.some((item) => !item || !["image", "tailImage"].includes(item.role) || !/^[a-f\d]{64}$/i.test(item.hash))))) throw new KlingError("KLING_FILM_CONTEXT_INVALID", "整片镜头的服务端授权上下文无效。", 409);
  return { filmRunId: input.filmRunId, filmShotId: input.filmShotId, authorizationEpoch: input.authorizationEpoch,
    ...(input.expectedInputHashes !== undefined ? { expectedInputHashes: input.expectedInputHashes.map((item) => ({ role: item.role, hash: item.hash.toLowerCase() })) } : {}) };
}
function assertFilmDispatchAllowed(grant: KlingFilmDispatchGrant): void {
  const result: unknown = grant.assertDispatchAllowed();
  if (result && (typeof result === "object" || typeof result === "function") && typeof (result as { then?: unknown }).then === "function") {
    // An async guard would yield between the parent's check and the durable paid-dispatch claim.
    void Promise.resolve(result).catch(() => {});
    throw new KlingError("KLING_FILM_CONTEXT_INVALID", "整片派发校验必须同步完成，已阻止生成。", 409);
  }
}
function failure(error: unknown, fallback = "Kling 操作暂时失败，请查询原任务"): { code: string; message: string; retryable: boolean } {
  return error instanceof KlingError ? { code: error.code, message: error.message, retryable: true } :
    { code: "KLING_LOCAL_FAILED", message: fallback, retryable: true };
}
function isTerminal(row: KlingJob): boolean { return ["completed", "failed", "cancelled"].includes(row.remoteState); }
function isAuthFailure(code: string): boolean { return /AUTH|LOGIN|PRINCIPAL|ACCOUNT_MISMATCH/.test(code); }
function assertNoUnknownSubmission(rows: KlingJob[]): void {
  const unknown = rows.find(klingJobHasUnknownSubmission);
  if (!unknown) return;
  const error = new KlingError("KLING_REQUEST_CONFLICT", "此账号有提交结果不明的 Kling 任务，请先核对原任务：" + unknown.id, 409);
  Object.assign(error, { jobId: unknown.id }); throw error;
}
function concurrencyLimit(): KlingError {
  return new KlingError("KLING_CONCURRENCY_LIMIT", `此 Kling 账号最多同时生成 ${KLING_MAX_CONCURRENT_SHOTS} 个镜头，请等待其中一个生成结束后再试。`, 409);
}
/** Prepared rows reserve capacity; existing remote work takes precedence over any legacy excess reservations. */
function assertDispatchCapacity(job: KlingJob, rows: KlingJob[]): void {
  assertNoUnknownSubmission(rows);
  const occupying = rows.filter(klingJobOccupiesGenerationSlot);
  const dispatched = occupying.filter((row) => row.submissionState !== "prepared").length;
  const reservations = occupying.filter((row) => row.submissionState === "prepared")
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  if (!reservations.slice(0, Math.max(0, KLING_MAX_CONCURRENT_SHOTS - dispatched)).some((row) => row.id === job.id)) throw concurrencyLimit();
}
function requestPayload(raw: unknown): KlingSubmitRequest {
  const body = record(raw);
  if (body.provider !== "kling-cli" || body.executionScope !== "single-shot") throw new KlingError("KLING_SCOPE_UNSUPPORTED", "Kling CLI 当前仅支持单镜头生成", 422);
  for (const key of ["profileId", "clientRequestId", "projectId", "scriptId"]) {
    if (typeof body[key] !== "string" || !ID.test(body[key])) throw new KlingError("KLING_INPUT_INVALID", "缺少或无效的参数：" + key, 400);
  }
  if (!Number.isSafeInteger(body.shotId) || Number(body.shotId) < 0 ||
    typeof body.selectionKey !== "string" || body.selectionKey.length > 1024 ||
    typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 12000 || body.prompt.startsWith("--") || body.prompt.includes("\0") ||
    !["text-to-video", "image-to-video"].includes(String(body.mode))) throw new KlingError("KLING_INPUT_INVALID", "镜头、模型、模式或提示词无效", 400);
  assertValidKlingPrompt(body.prompt as string);
  const acknowledgement = record(body.billingAcknowledgement);
  if (acknowledgement.policyRevision !== "credits-v1" || acknowledgement.acceptedForRequestId !== body.clientRequestId) throw new KlingError("KLING_BILLING_ACK_REQUIRED", "请确认本次生成将使用 Kling 账号积分", 422);
  if (body.options !== undefined && (!body.options || typeof body.options !== "object" || Array.isArray(body.options))) throw new KlingError("KLING_INPUT_INVALID", "视频参数必须是对象", 400);
  for (const key of ["imageUrl", "lastImageUrl"]) if (body[key] !== undefined && (typeof body[key] !== "string" || (body[key] as string).length > 28 * 1024 * 1024)) throw new KlingError("KLING_INPUT_INVALID", "图片地址无效", 400);
  if (body.referenceImageUrls !== undefined && (!Array.isArray(body.referenceImageUrls) || body.referenceImageUrls.length > 9 || body.referenceImageUrls.some((value) => typeof value !== "string" || value.length > 8192))) throw new KlingError("KLING_INPUT_INVALID", "参考图地址无效", 400);
  if ((Array.isArray(body.referenceVideoUrls) && body.referenceVideoUrls.length) || (Array.isArray(body.referenceAudioUrls) && body.referenceAudioUrls.length)) throw new KlingError("KLING_CAPABILITY_UNSUPPORTED", "首版尚未支持参考视频或参考音频", 422);
  return {
    provider: "kling-cli", executionScope: "single-shot", profileId: body.profileId as string, clientRequestId: body.clientRequestId as string,
    projectId: body.projectId as string, scriptId: body.scriptId as string, shotId: body.shotId as number, selectionKey: body.selectionKey,
    mode: body.mode as KlingSubmitRequest["mode"], prompt: body.prompt,
    imageUrl: body.imageUrl as string | undefined, lastImageUrl: body.lastImageUrl as string | undefined,
    referenceImageUrls: body.referenceImageUrls as string[] | undefined, options: body.options as Record<string, unknown> | undefined,
    expectedSelectedAssetId: typeof body.expectedSelectedAssetId === "string" ? body.expectedSelectedAssetId : null,
    billingAcknowledgement: { policyRevision: "credits-v1", acceptedForRequestId: body.clientRequestId as string },
  };
}

export async function createKlingJob(raw: unknown): Promise<KlingJob> {
  const browser = record(raw);
  if (["filmRunId", "filmShotId", "filmAuthorizationEpoch", "filmContext", "suppressAutoDispatch"].some((key) => Object.hasOwn(browser, key))) throw new KlingError("KLING_SCOPE_UNSUPPORTED", "整片镜头必须由整片编排服务创建。", 422);
  return createJob(raw);
}

/** Trusted server-only entrypoint. Creating a child never grants the generic job runner permission to generate. */
export async function createKlingFilmShotJob(raw: unknown, context: KlingFilmShotContext): Promise<KlingJob> {
  return createJob(raw, filmContext(context));
}
async function createJob(raw: unknown, film?: KlingFilmShotContext): Promise<KlingJob> {
  const request = requestPayload(raw);
  const linkage = film ? { filmRunId: film.filmRunId, filmShotId: film.filmShotId, expectedInputHashes: film.expectedInputHashes } : undefined;
  // Preserve the cheap idempotent path for legacy/sales requests. Premium requests are
  // canonicalized below before this same check, so a changed client prompt cannot reuse a job.
  const preliminary = getDb().select().from(klingJobs).where(and(eq(klingJobs.profileId, request.profileId), eq(klingJobs.clientRequestId, request.clientRequestId))).get();
  if (preliminary && preliminary.data.payloadHash === contentHash(film ? { request, linkage } : request)) {
    getKlingJob(preliminary.id);
    return preliminary;
  }
  let profile = getProfile(request.profileId);
  if (profile.environmentState !== "ready" || profile.disabledAt) throw new KlingError("KLING_ENVIRONMENT_REQUIRED", "请先在设置页检测 Kling CLI 环境", 409);
  if (profile.authState !== "authenticated" || !profile.principalKey) throw new KlingError("KLING_LOGIN_REQUIRED", "请先登录并核验 Kling 账号", 401);
  if (!profile.catalogCheckedAt || Date.now() - profile.catalogCheckedAt > 300_000) {
    try { profile = await refreshProfile(profile.id, undefined, { credits: false }); }
    catch (error) {
      if (!(error instanceof KlingError) || error.code !== "KLING_PROFILE_BUSY") throw error;
      const cached = getProfile(profile.id);
      if (cached.environmentState !== "ready" || cached.disabledAt || cached.authState !== "authenticated" ||
        !cached.principalKey || cached.principalKey !== profile.principalKey || cached.region !== profile.region ||
        !cached.catalogCheckedAt || !cached.catalogRevision || !cached.catalogSnapshot.some((item) => item.selectionKey === request.selectionKey && item.available && item.catalogRevision === cached.catalogRevision)) throw error;
      // Persist only a reservation while another command holds the CLI lock. Dispatch must still
      // refresh identity and catalog under its own lock before claiming any paid generation.
      profile = cached;
    }
  }
  const model = profile.catalogSnapshot.find((item) => item.selectionKey === request.selectionKey);
  if (!model?.available) throw new KlingError("KLING_MODEL_UNAVAILABLE", model?.disabledReason ?? "当前账号没有此可用视频模型，请重新选择", 422);
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, request.projectId)).get();
  if (!project) throw new KlingError("KLING_PROJECT_NOT_FOUND", "项目不存在", 404);
  const allScripts = db.select().from(scripts).where(eq(scripts.projectId, request.projectId)).all();
  const script = resolveCurrentScript(allScripts);
  const shot = script?.shots?.find((item) => item.shotId === request.shotId);
  if (!script || script.id !== request.scriptId || !shot) throw new KlingError("KLING_CONTEXT_CHANGED", "当前脚本或镜头已改变，请刷新后生成", 409);
  const creativeContext = assertCreativeProfileContext(project, script);
  const premiumCg = isPremiumProductCgProfile(creativeContext.projectProfile);
  let mode = request.mode;
  let prompt = request.prompt;
  let refs: KlingReferenceInput[] = [
    ...(request.imageUrl ? [{ role: "image" as const, sourceUrl: request.imageUrl }] : []),
    ...(request.referenceImageUrls ?? []).map((sourceUrl) => ({ role: "image" as const, sourceUrl })),
    ...(request.lastImageUrl ? [{ role: "tailImage" as const, sourceUrl: request.lastImageUrl }] : []),
  ];
  let options: Record<string, string | number | boolean>;
  if (premiumCg) {
    const issues = lintCreativeProfileShot(creativeContext.projectProfile, shot);
    if (issues.length) throw new KlingError("CREATIVE_POLICY_VIOLATION", "高端产品 CG 不能包含画面文字、营销图形或不符合旁白策略的内容。", 422);
    if (model.tool !== "image_to_video") throw new KlingError("KLING_CAPABILITY_UNSUPPORTED", "高端产品 CG 仅支持已验证的图生视频模型。", 422);
    const compiled = compilePremiumCgVideoPrompt(shot, creativeContext.projectProfile);
    prompt = compiled.prompt;
    mode = "image-to-video";
    refs = premiumCgReferenceInputs(project, script, request.shotId);
    options = premiumCgVideoOptions(model, request.options ?? {}, compiled.negativePrompt);
  } else {
    if ((model.tool === "image_to_video") !== (mode === "image-to-video")) throw new KlingError("KLING_CAPABILITY_UNSUPPORTED", "生成模式与选择的模型工具不一致", 422);
    options = normalizeVideoParameters(model, request.options ?? {});
  }
  const scopedEligible = filterAssetsForScript(
    db.select().from(assets).where(and(eq(assets.projectId, request.projectId), eq(assets.shotId, request.shotId), eq(assets.selected, true))).all(),
    script,
  );
  const eligible = premiumCg
    ? filterTrustedPremiumCgAssets(scopedEligible, request.projectId, script)
    : scopedEligible;
  if (request.expectedSelectedAssetId !== undefined && (eligible[0]?.id ?? null) !== request.expectedSelectedAssetId) throw new KlingError("KLING_CONTEXT_CHANGED", "当前镜头素材已变化，请刷新后生成", 409);
  const effectiveRequest = premiumCg
    ? {
      ...request,
      mode,
      prompt,
      imageUrl: refs.find((ref) => ref.role === "image")?.sourceUrl,
      referenceImageUrls: refs.filter((ref) => ref.role === "image").slice(1).map((ref) => ref.sourceUrl),
      lastImageUrl: refs.find((ref) => ref.role === "tailImage")?.sourceUrl,
      options,
    }
    : request;
  const payloadHash = contentHash(film ? { request: effectiveRequest, linkage } : effectiveRequest);
  const existing = db.select().from(klingJobs).where(and(eq(klingJobs.profileId, request.profileId), eq(klingJobs.clientRequestId, request.clientRequestId))).get();
  if (existing) {
    getKlingJob(existing.id);
    if (existing.data.payloadHash !== payloadHash) throw new KlingError("KLING_REQUEST_CONFLICT", "相同请求编号不能使用不同的生成内容", 409);
    return existing;
  }
  const id = randomUUID();
  const inputs = await prepareKlingInputs(id, model, refs);
  if (film?.expectedInputHashes !== undefined && canonicalJson(inputs.map(({ role, hash }) => ({ role, hash }))) !== canonicalJson(film.expectedInputHashes)) throw new KlingError("KLING_INPUT_CHANGED", "整片参考图与已确认的输入快照不一致，已阻止生成。", 409);
  const args = buildKlingVideoArguments(model, prompt, options, inputs, id);
  const now = Date.now();
  const data: KlingJobData = {
    scriptRevision: scriptRevision(script), shotKey: shotKey(script.id, shot), expectedSelectedAssetId: eligible[0]?.id ?? null,
    payloadHash, requestHash: contentHash({ principal: profile.principalKey, region: profile.region, model, prompt, options, inputs: inputs.map(({ role, hash }) => ({ role, hash })), scriptRevision: scriptRevision(script), ...(linkage ? { linkage } : {}) }),
    model, prompt, options, inputs, args, accountLabel: profile.accountSummary?.displayName ?? profile.accountSummary?.id,
    videoPromptAudit: { version: VIDEO_PROMPT_VERSION, sourceShot: structuredClone(shot) },
    cliVersion: profile.cliVersion, adapterVersion: KLING_ADAPTER_VERSION,
    authorizedBootId: runtime.bootId, authorizedUntil: now + 120_000, authorizationEpoch: 1, billingAcknowledgedAt: now, queryAttempts: 0,
    ...(film ? { filmRunId: film.filmRunId, filmShotId: film.filmShotId, filmAuthorizationEpoch: film.authorizationEpoch } : {}),
  };
  const created = db.transaction((tx) => {
    const retry = tx.select().from(klingJobs).where(and(eq(klingJobs.profileId, request.profileId), eq(klingJobs.clientRequestId, request.clientRequestId))).get();
    if (retry) {
      getKlingJob(retry.id);
      if (retry.data.payloadHash !== payloadHash) throw new KlingError("KLING_REQUEST_CONFLICT", "相同请求编号的内容不同", 409);
      return retry;
    }
    const films = tx.select().from(klingFilmRuns).all();
    if (!film && films.some((row) => !["draft", "completed", "cancelled"].includes(row.status) && (row.principalKey === profile.principalKey || row.projectId === request.projectId))) {
      throw new KlingError("KLING_FILM_CONFLICT", "已有未完成整片编排，请先恢复或取消原整片", 409);
    }
    if (film && !films.some((row) => row.id === film.filmRunId && row.projectId === request.projectId && row.principalKey === profile.principalKey)) {
      throw new KlingError("KLING_FILM_CONTEXT_INVALID", "整片父任务不存在或账号、项目不一致", 409);
    }
    const accountJobs = tx.select().from(klingJobs).where(and(eq(klingJobs.principalKey, profile.principalKey!), eq(klingJobs.region, profile.region))).all();
    assertNoUnknownSubmission(accountJobs);
    const conflict = tx.select().from(klingJobs).where(and(eq(klingJobs.projectId, request.projectId), eq(klingJobs.scriptId, script.id), eq(klingJobs.shotId, request.shotId))).all().find(isKlingJobUnresolved);
    if (conflict) {
      const error = new KlingError("KLING_REQUEST_CONFLICT", "此镜头已有待处理的 Kling 任务，请先恢复原任务：" + conflict.id, 409);
      Object.assign(error, { jobId: conflict.id }); throw error;
    }
    if (accountJobs.filter(klingJobOccupiesGenerationSlot).length >= KLING_MAX_CONCURRENT_SHOTS) throw concurrencyLimit();
    const latestProject = tx.select().from(projects).where(eq(projects.id, request.projectId)).get();
    const latestScript = tx.select().from(scripts).where(eq(scripts.id, script.id)).get();
    if (!latestScript || scriptRevision(latestScript) !== data.scriptRevision) throw new KlingError("KLING_CONTEXT_CHANGED", "准备期间脚本已变化，请重新确认", 409);
    if (!latestProject) throw new KlingError("KLING_PROJECT_NOT_FOUND", "项目不存在", 404);
    assertCreativeProfileContext(latestProject, latestScript);
    tx.insert(klingJobs).values({
      id, profileId: profile.id, principalKey: profile.principalKey!, region: profile.region, clientRequestId: request.clientRequestId,
      projectId: request.projectId, scriptId: script.id, shotId: request.shotId, submissionState: "prepared", data, createdAt: now, updatedAt: now,
    }).run();
    return tx.select().from(klingJobs).where(eq(klingJobs.id, id)).get()!;
  }, { behavior: "immediate" });
  if (!film) { startKlingJobRunner(); wakeKlingJobRunner(); }
  return created;
}

function writeReceipt(job: KlingJob, id: string): void {
  const directory = join(getDataDir(), "integrations", "kling", "receipts");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, job.id + ".json");
  const temp = target + "." + randomUUID() + ".tmp";
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ jobId: job.id, profileId: job.profileId, principalKey: job.principalKey, region: job.region, generationId: id, requestHash: job.data.requestHash }));
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temp, target);
}

function acknowledge(jobId: string, generationId: string, method: "cli" | "receipt" | "manual", bindingCandidateHash?: string): KlingJob {
  return getDb().transaction((tx) => {
    assertKlingJobLease(jobId);
    if (!GENERATION_ID.test(generationId)) throw new KlingError("KLING_TASK_ID_INVALID", "Kling 返回的任务编号无效，请核对原任务。", 409);
    const row = tx.select().from(klingJobs).where(eq(klingJobs.id, jobId)).get()!;
    if (method === "manual" && (row.submissionState !== "submission_unknown" || row.remoteGenerationId)) throw new KlingError("KLING_BINDING_CONFLICT", "任务状态已变化，请刷新后重新核对。", 409);
    if (row.remoteGenerationId && row.remoteGenerationId !== generationId) throw new KlingError("KLING_BINDING_CONFLICT", "任务已经绑定其他平台编号", 409);
    const duplicate = tx.select().from(klingJobs).where(and(eq(klingJobs.region, row.region), eq(klingJobs.principalKey, row.principalKey), eq(klingJobs.remoteGenerationId, generationId))).get();
    if (duplicate && duplicate.id !== row.id) throw new KlingError("KLING_BINDING_CONFLICT", "此平台任务已经关联到其他本地任务", 409);
    const aiTaskId = row.data.aiTaskId ?? randomUUID();
    if (!row.data.aiTaskId) tx.insert(aiTasks).values({
      id: aiTaskId, projectId: row.projectId, shotId: row.shotId, provider: "kling-cli",
      model: row.data.model.remoteModelId, mediaType: "video", mode: row.data.model.tool === "image_to_video" ? "image-to-video" : "text-to-video",
      prompt: row.data.prompt, taskId: generationId, status: "submitted",
    }).run();
    return tx.update(klingJobs).set({
      remoteGenerationId: generationId, submissionState: "acknowledged", remoteState: isTerminal(row) ? row.remoteState : "pending", needsConfirmation: false,
      nextQueryAt: Date.now() + 5000, data: { ...row.data, aiTaskId, acknowledgedAt: Date.now(), bindingMethod: method,
        ...(method === "manual" ? { bindingConfirmedAt: Date.now(), bindingCandidateHash } : {}), error: undefined, blockedReason: undefined },
      revision: row.revision + 1, updatedAt: Date.now(),
    }).where(eq(klingJobs.id, row.id)).returning().get()!;
  });
}

async function checkedProfile(job: KlingJob, lease: KlingLease) {
  const profile = await refreshProfile(job.profileId, lease, { credits: false });
  if (profile.principalKey !== job.principalKey || profile.region !== job.region) throw new KlingError("KLING_ACCOUNT_MISMATCH", "此任务属于原 Kling 账号，请切回原账号", 409);
  if (profile.cliVersion !== job.data.cliVersion || profile.adapterVersion !== job.data.adapterVersion) throw new KlingError("KLING_CLI_VERSION_UNSUPPORTED", "原任务使用的 CLI 版本与当前版本不一致，请恢复支持版本", 409);
  return profile;
}

function assertCurrentContext(job: KlingJob): void {
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, job.projectId)).get();
  if (!project) throw new KlingError("KLING_PROJECT_NOT_FOUND", "项目不存在，已阻止首次生成。", 404);
  const rows = db.select().from(scripts).where(eq(scripts.projectId, job.projectId)).all();
  const selected = resolveCurrentScript(rows);
  if (!selected || selected.id !== job.scriptId || scriptRevision(selected) !== job.data.scriptRevision) throw new KlingError("KLING_CONTEXT_CHANGED", "原脚本或所选脚本已变化，已阻止首次生成。请取消此待提交作业并重新确认。", 409);
  const creativeContext = assertCreativeProfileContext(project, selected);
  if (isPremiumProductCgProfile(creativeContext.projectProfile)) {
    const shot = selected.shots?.find((item) => item.shotId === job.shotId);
    if (!shot) throw new KlingError("KLING_CONTEXT_CHANGED", "原镜头已变化，已阻止首次生成。请取消此待提交作业并重新确认。", 409);
    const issues = lintCreativeProfileShot(creativeContext.projectProfile, shot);
    if (issues.length) throw new KlingError("CREATIVE_POLICY_VIOLATION", "高端产品 CG 不能包含画面文字、营销图形或不符合旁白策略的内容。", 422);
    if (job.data.model.tool !== "image_to_video") throw new KlingError("CREATIVE_POLICY_VIOLATION", "待提交的高端产品 CG 必须使用图生视频模型，请重新创建任务。", 422);
    const compiled = compilePremiumCgVideoPrompt(shot, creativeContext.projectProfile);
    if (job.data.prompt !== compiled.prompt) {
      throw new KlingError("CREATIVE_POLICY_VIOLATION", "待提交的高端产品 CG 未使用当前脚本的服务端提示词，请重新创建任务。", 422);
    }
    const expectedReferences = premiumCgReferenceInputs(project, selected, job.shotId);
    if (canonicalJson(job.data.inputs.map(({ role, sourceUrl }) => ({ role, sourceUrl }))) !== canonicalJson(expectedReferences)) {
      throw new KlingError("CREATIVE_POLICY_VIOLATION", "待提交的高端产品 CG 参考图不再属于当前项目白名单，请重新创建任务。", 422);
    }
    const expectedOptions = premiumCgVideoOptions(job.data.model, job.data.options, compiled.negativePrompt);
    if (canonicalJson(expectedOptions) !== canonicalJson(job.data.options)) {
      throw new KlingError("CREATIVE_POLICY_VIOLATION", "待提交的高端产品 CG 未满足当前音频或提示词策略，请重新创建任务。", 422);
    }
    const expectedArgs = buildKlingVideoArguments(job.data.model, compiled.prompt, expectedOptions, job.data.inputs, job.id);
    if (canonicalJson(expectedArgs) !== canonicalJson(job.data.args)) {
      throw new KlingError("CREATIVE_POLICY_VIOLATION", "待提交的高端产品 CG 参数已失去服务端约束，请重新创建任务。", 422);
    }
  }
  const scopedActive = filterAssetsForScript(
    db.select().from(assets).where(and(eq(assets.projectId, job.projectId), eq(assets.shotId, job.shotId), eq(assets.selected, true))).all(),
    selected,
  );
  const active = isPremiumProductCgProfile(creativeContext.projectProfile)
    ? filterTrustedPremiumCgAssets(scopedActive, job.projectId, selected)
    : scopedActive;
  if ((active[0]?.id ?? null) !== job.data.expectedSelectedAssetId) throw new KlingError("KLING_CONTEXT_CHANGED", "当前镜头素材已变化，已阻止首次生成。请取消此待提交作业并重新确认。", 409);
}

export async function dispatchKlingJob(jobId: string): Promise<void> {
  return dispatchJob(jobId);
}
/** A fresh, parent-validated grant is required each time a FilmRun considers a new paid dispatch. */
export async function dispatchKlingFilmShotJob(jobId: string, grant: KlingFilmDispatchGrant): Promise<void> {
  const context = filmContext(grant);
  if (typeof grant.assertDispatchAllowed !== "function") throw new KlingError("KLING_FILM_CONTEXT_INVALID", "整片镜头缺少服务端派发校验。", 409);
  await dispatchJob(jobId, { ...context, assertDispatchAllowed: () => grant.assertDispatchAllowed() });
  startKlingJobRunner(); wakeKlingJobRunner();
}
async function dispatchJob(jobId: string, grant?: KlingFilmDispatchGrant): Promise<void> {
  await withKlingJobLease(jobId, async () => {
    let job = getKlingJob(jobId);
    if (job.data.filmRunId) {
      if (!grant || grant.filmRunId !== job.data.filmRunId || grant.filmShotId !== job.data.filmShotId || grant.authorizationEpoch < (job.data.filmAuthorizationEpoch ?? 0)) throw new KlingError("KLING_FILM_MANAGED_JOB", "整片镜头只能由原整片编排服务授权派发。", 409);
      if (grant.expectedInputHashes !== undefined && canonicalJson(job.data.inputs.map(({ role, hash }) => ({ role, hash }))) !== canonicalJson(grant.expectedInputHashes)) throw new KlingError("KLING_INPUT_CHANGED", "整片镜头输入与原批次确认快照不一致，已阻止生成。", 409);
      assertFilmDispatchAllowed(grant);
      if (job.submissionState === "prepared") job = patchKlingJob(jobId, { needsConfirmation: false }, { authorizedBootId: runtime.bootId, authorizedUntil: Date.now() + 120_000,
        authorizationEpoch: job.data.authorizationEpoch + 1, filmAuthorizationEpoch: grant.authorizationEpoch });
    } else if (grant) throw new KlingError("KLING_FILM_MANAGED_JOB", "普通单镜头任务不能接管为整片任务。", 409);
    if (job.submissionState !== "prepared" || job.needsConfirmation) return;
    if (job.data.authorizedBootId !== runtime.bootId || job.data.authorizedUntil <= Date.now()) {
      patchKlingJob(jobId, { needsConfirmation: true }); return;
    }
    const attemptStartedAt = Date.now();
    try {
      // Also protect previously prepared jobs, whose stored text may predate current validation.
      assertValidKlingPrompt(job.data.prompt);
      assertDispatchCapacity(job, getDb().select().from(klingJobs).where(and(eq(klingJobs.principalKey, job.principalKey), eq(klingJobs.region, job.region))).all());
      await withKlingLease(getProfile(job.profileId), async (lease) => {
        const profile = await checkedProfile(job, lease);
        const live = profile.catalogSnapshot.find((model) => model.selectionKey === job.data.model.selectionKey);
        if (!live?.available || live.catalogRevision !== job.data.model.catalogRevision) {
          patchKlingJob(jobId, { needsConfirmation: true }, { error: { code: "KLING_CATALOG_CHANGED", message: "模型目录已变化，请重新确认本次提交", retryable: true } }); return;
        }
        for (const input of job.data.inputs) if (contentHash(await readFile(input.path)) !== input.hash) throw new KlingError("KLING_INPUT_CHANGED", "本次输入快照已变化，已阻止生成", 409);
        assertCurrentContext(job);
        assertKlingJobLease(jobId);
        const claimed = getDb().transaction((tx) => {
          assertKlingJobLease(jobId);
          assertDispatchCapacity(job, tx.select().from(klingJobs).where(and(eq(klingJobs.principalKey, job.principalKey), eq(klingJobs.region, job.region))).all());
          // The profile check must happen in the same immediate transaction as the paid-dispatch claim.
          // A profile edit between the earlier preflight and this point invalidates the prepared job.
          assertCurrentContext(job);
          // Root's synchronous guard reads the parent run inside the same SQLite transaction as this claim.
          if (grant) assertFilmDispatchAllowed(grant);
          return tx.update(klingJobs).set({
          submissionState: "submitting", data: { ...job.data, dispatchStartedAt: Date.now() }, revision: job.revision + 1, updatedAt: Date.now(),
        }).where(and(eq(klingJobs.id, jobId), eq(klingJobs.submissionState, "prepared"), eq(klingJobs.needsConfirmation, false), eq(klingJobs.revision, job.revision),
          sql`json_extract(${klingJobs.data}, '$.authorizedBootId') = ${runtime.bootId}`,
          sql`json_extract(${klingJobs.data}, '$.authorizedUntil') > ${Date.now()}`,
          sql`json_extract(${klingJobs.data}, '$.authorizationEpoch') = ${job.data.authorizationEpoch}`)).returning().get();
        }, { behavior: "immediate" });
        if (!claimed) return;
        job = claimed;
        let capturedId: string | undefined;
        let completedResult: KlingCliResult | undefined;
        let beforeSpawnReached = false;
        const commandStartedAt = Date.now();
        const withoutAcknowledgement = (result: KlingCliResult | undefined, error?: unknown) => {
          // Failure before the spawn boundary cannot have reached the generation service.
          const evidence = result ?? (!beforeSpawnReached ? { exitCode: null, signal: null, stdout: "", stderr: "", timedOut: false, aborted: false, spawnFailed: true } : undefined);
          const rejected = classifyKlingSubmissionFailure(evidence, error);
          const summary = createKlingSubmissionDiagnostics(evidence, error);
          const cliDiagnostics = createKlingCliDiagnostics(evidence, error, commandStartedAt, summary);
          if (rejected) patchKlingJob(jobId, { submissionState: "not_submitted", remoteState: "not_started", needsConfirmation: false, nextQueryAt: null }, {
            authorizedUntil: 0, error: { code: rejected.code, message: rejected.message, retryable: true }, blockedReason: undefined, cliDiagnostics,
          });
          else patchKlingJob(jobId, { submissionState: "submission_unknown", remoteState: "unknown", nextQueryAt: null }, {
            error: { code: "KLING_SUBMISSION_UNKNOWN", message: summary?.reason ?? "未取得可靠任务编号，无法确认平台是否受理。请核对官方任务，并查看 CLI 返回与错误。", retryable: false }, cliDiagnostics,
          });
        };
        try {
          const result = await runKling(profile, job.data.args, { lease, timeoutMs: 180_000, allowFailure: true,
            beforeSpawn: () => { assertKlingJobLease(jobId); beforeSpawnReached = true; }, onGenerationId(id) {
            capturedId = id; writeReceipt(job, id);
          } });
          completedResult = result;
          capturedId ??= result.generationId ?? extractGenerationId(result.json) ?? extractGenerationId(parseCliJson(result.stdout));
          if (capturedId) {
            patchKlingJob(jobId, {}, { cliDiagnostics: createKlingCliDiagnostics(result, undefined, commandStartedAt) });
            writeReceipt(job, capturedId); acknowledge(jobId, capturedId, "cli");
          }
          else withoutAcknowledgement(result);
        } catch (error) {
          const result = (error instanceof KlingError ? error.result : undefined) ?? completedResult;
          const id = capturedId ?? result?.generationId ?? extractGenerationId(result?.json) ?? extractGenerationId(parseCliJson(result?.stdout ?? ""));
          if (id) {
            // Keep a captured acknowledgement even if exit, receipt or database persistence failed.
            try { writeReceipt(job, id); } catch { /* HTTP view still retains the known ID if DB is writable. */ }
            acknowledge(jobId, id, "cli");
            patchKlingJob(jobId, {}, { cliDiagnostics: createKlingCliDiagnostics(result, error, commandStartedAt) });
          } else withoutAcknowledgement(result, error);
        }
      });
    } catch (error) {
      const current = getKlingJob(jobId);
      const detail = failure(error);
      if (current.submissionState === "prepared") {
        const waiting = ["KLING_PROFILE_BUSY", "KLING_CONCURRENCY_LIMIT"].includes(detail.code) || (detail.code === "KLING_REQUEST_CONFLICT" && typeof (error as { jobId?: unknown }).jobId === "string");
        const cliDiagnostics = error instanceof KlingError && error.result ? createKlingCliDiagnostics(error.result, error, attemptStartedAt, {
          phase: "startup", outcome: "not_submitted", source: "cli", reason: "首次提交前的账号或模型检查失败，尚未提交视频生成。",
          timedOut: error.result.timedOut, aborted: error.result.aborted, exitCode: error.result.exitCode,
        }) : undefined;
        patchKlingJob(jobId, waiting ? {} : { needsConfirmation: true }, { error: detail, blockedReason: isAuthFailure(detail.code) ? "auth_required" : undefined,
          ...(cliDiagnostics ? { cliDiagnostics } : {}),
        });
      }
      else if (current.submissionState === "submitting") patchKlingJob(jobId, { submissionState: "submission_unknown", remoteState: "unknown" }, { error: detail });
    }
  });
}

function saveRemoteResult(jobId: string, task: KlingNormalizedTask): void {
  getDb().transaction((tx) => {
    assertKlingJobLease(jobId);
    const job = tx.select().from(klingJobs).where(eq(klingJobs.id, jobId)).get()!;
    const state = task.status === "succeeded" ? "completed" : task.status === "failed" ? "failed" : task.status;
    const remoteState = isTerminal(job) ? job.remoteState : state;
    for (const work of task.works) {
      const existing = tx.select().from(klingJobOutputs).where(and(eq(klingJobOutputs.jobId, jobId), eq(klingJobOutputs.workKey, work.id))).get();
      const url = work.watermarkFreeUrl ?? work.url;
      if (existing) tx.update(klingJobOutputs).set({ data: { ...existing.data, url, urlObtainedAt: Date.now() }, updatedAt: Date.now() }).where(eq(klingJobOutputs.id, existing.id)).run();
      else tx.insert(klingJobOutputs).values({
        id: randomUUID(), jobId, workKey: work.id, data: { providerWorkId: work.id, url, urlObtainedAt: Date.now() }, createdAt: Date.now(), updatedAt: Date.now(),
      }).run();
    }
    const attempts = job.data.queryAttempts + 1;
    const completedWithoutWorks = remoteState === "completed" && !task.works.length && !getKlingOutputs(jobId).length;
    const error = remoteState === "failed" ? { code: "KLING_REMOTE_FAILED", message: task.error ?? "Kling 官方确认生成失败，请查看原任务原因", retryable: false } :
      completedWithoutWorks ? { code: "KLING_RESULTS_NOT_READY", message: "云端已完成，但视频作品还未就绪，请继续查询", retryable: true } :
      state === "unknown" && !isTerminal(job) ? { code: "KLING_STATUS_UNKNOWN", message: "平台返回暂未识别的状态，请保留原任务继续查询", retryable: true } : undefined;
    tx.update(klingJobs).set({
      remoteState, importState: remoteState === "completed" && job.importState === "not_ready" ? "pending" : job.importState,
      nextQueryAt: ["failed", "cancelled"].includes(remoteState) || (remoteState === "completed" && !completedWithoutWorks) ? null : Date.now() + Math.min(30_000, 5000 * Math.pow(2, Math.min(attempts, 3))),
      data: { ...job.data, lastCheckedAt: Date.now(), rawStatus: task.rawStatus.slice(0, 120), queryAttempts: attempts, blockedReason: undefined, error },
      revision: job.revision + 1, updatedAt: Date.now(),
    }).where(eq(klingJobs.id, job.id)).run();
    if (job.data.aiTaskId) tx.update(aiTasks).set({
      status: remoteState === "completed" ? "completed" : remoteState === "failed" || remoteState === "cancelled" ? "failed" : remoteState === "unknown" ? "unknown" : "processing",
      resultUrls: tx.select().from(klingJobOutputs).where(eq(klingJobOutputs.jobId, jobId)).all().map((output) => output.data.url), error: error?.message ?? null, updatedAt: new Date(),
    }).where(eq(aiTasks.id, job.data.aiTaskId)).run();
  });
}

async function queryUnderLease(jobId: string): Promise<void> {
  const job = getKlingJob(jobId);
  if (!job.remoteGenerationId) throw new KlingError("KLING_TASK_ID_REQUIRED", "原任务还没有平台编号，请先核对并绑定", 409);
  try {
    await withKlingLease(getProfile(job.profileId), async (lease) => {
      const profile = await checkedProfile(job, lease);
      assertKlingJobLease(jobId);
      const result = await runKling(profile, ["query_tasks", job.remoteGenerationId!], { lease, timeoutMs: 30_000, beforeSpawn: () => assertKlingJobLease(jobId) });
      const task = normalizeKlingTask(result.json);
      if (task.generationId && task.generationId !== job.remoteGenerationId) throw new KlingError("KLING_TASK_ID_MISMATCH", "Kling 返回了其他任务的结果，已停止写入，请核对原任务。", 409);
      saveRemoteResult(jobId, task);
    });
  } catch (error) {
    if (error instanceof KlingError && error.code === "KLING_PROFILE_BUSY") {
      // Other shot submissions share this CLI command lock. Contention says nothing about the cloud task.
      patchKlingJob(jobId, { nextQueryAt: Date.now() + 5000 });
      throw error;
    }
    const detail = failure(error);
    const current = getKlingJob(jobId);
    patchKlingJob(jobId, { nextQueryAt: Date.now() + 30_000 }, {
      error: detail, blockedReason: isAuthFailure(detail.code) ? detail.code === "KLING_ACCOUNT_MISMATCH" ? "account_mismatch" : "auth_required" : undefined,
    });
    // A known completed remote task stays completed even if refreshing a signed URL failed.
    if (!isTerminal(current) && current.data.aiTaskId) getDb().update(aiTasks).set({ status: "unknown", error: detail.message, updatedAt: new Date() }).where(eq(aiTasks.id, current.data.aiTaskId)).run();
    throw error;
  }
}

export async function queryKlingJob(jobId: string): Promise<void> {
  await withKlingJobLease(jobId, async () => {
    await queryUnderLease(jobId);
    const job = getKlingJob(jobId);
    if (job.remoteState === "completed" && getKlingOutputs(jobId).length) await importKlingOutputs(jobId);
  });
}
export async function retryKlingImport(jobId: string): Promise<void> {
  await withKlingJobLease(jobId, async () => {
    const outputs = getKlingOutputs(jobId);
    // No login is required to finish registering an already downloaded result.
    if (!outputs.length || outputs.some((output) => output.importState !== "imported" && (!output.data.localPath || output.data.localPath.endsWith(".part")) && Date.now() - output.data.urlObtainedAt > 60_000)) {
      await queryUnderLease(jobId);
    }
    await importKlingOutputs(jobId);
  });
}

export async function continueKlingJob(jobId: string, raw: unknown): Promise<void> {
  if (getKlingJob(jobId).data.filmRunId) throw new KlingError("KLING_FILM_MANAGED_JOB", "整片镜头需要在原整片任务中确认恢复，不能单独继续付费提交。", 409);
  await withKlingJobLease(jobId, () => continueUnderLease(jobId, raw));
}
async function continueUnderLease(jobId: string, raw: unknown): Promise<void> {
  const body = record(raw);
  const job = getKlingJob(jobId);
  if (job.submissionState !== "prepared" || job.data.dispatchStartedAt) throw new KlingError("KLING_ALREADY_DISPATCHED", "此任务可能已经提交，只能查询原任务", 409);
  if (body.explicitConfirmation !== true) throw new KlingError("KLING_BILLING_ACK_REQUIRED", "继续提交前需要确认本次积分消耗", 422);
  const profile = await refreshProfile(job.profileId, undefined, { credits: false });
  if (profile.principalKey !== job.principalKey) throw new KlingError("KLING_ACCOUNT_MISMATCH", "请登录原账号", 409);
  const model = profile.catalogSnapshot.find((item) => item.selectionKey === job.data.model.selectionKey);
  if (!model?.available || contentHash({ ...model, catalogRevision: "" }) !== contentHash({ ...job.data.model, catalogRevision: "" })) throw new KlingError("KLING_MODEL_CHANGED", "模型能力已变化，请新建并确认正确参数；原任务尚未提交", 409);
  assertCurrentContext(job);
  for (const input of job.data.inputs) if (contentHash(await readFile(input.path)) !== input.hash) throw new KlingError("KLING_INPUT_CHANGED", "原始输入快照已变化，不能继续提交。", 409);
  getDb().transaction((tx) => {
    assertKlingJobLease(jobId);
    const row = tx.select().from(klingJobs).where(eq(klingJobs.id, jobId)).get()!;
    if (row.submissionState !== "prepared" || row.data.dispatchStartedAt) throw new KlingError("KLING_ALREADY_DISPATCHED", "此任务已开始提交", 409);
    tx.update(klingJobs).set({
      needsConfirmation: false, data: { ...row.data, model, authorizedBootId: runtime.bootId, authorizedUntil: Date.now() + 120_000,
        authorizationEpoch: row.data.authorizationEpoch + 1, billingAcknowledgedAt: Date.now(), error: undefined, blockedReason: undefined },
      revision: row.revision + 1, updatedAt: Date.now(),
    }).where(eq(klingJobs.id, jobId)).run();
  });
  startKlingJobRunner(); wakeKlingJobRunner();
}

function bindingSummary(task: KlingNormalizedTask) { return { status: task.rawStatus, workIds: task.works.map((work) => work.id).sort() }; }

export async function bindKlingJob(jobId: string, raw: unknown): Promise<unknown> {
  const body = record(raw);
  const job = getKlingJob(jobId);
  if (job.submissionState !== "submission_unknown" || job.remoteGenerationId) throw new KlingError("KLING_BINDING_CONFLICT", "只有提交不明且没有编号的任务可以手动绑定", 409);
  if (body.action === "preview") {
    if (typeof body.generationId !== "string" || !GENERATION_ID.test(body.generationId)) throw new KlingError("KLING_INPUT_INVALID", "平台任务编号格式无效", 400);
    const task = await withKlingLease(getProfile(job.profileId), async (lease) => {
      const profile = await checkedProfile(job, lease);
      return normalizeKlingTask((await runKling(profile, ["query_tasks", body.generationId as string], { lease })).json);
    });
    if (task.status === "unknown" || (task.generationId && task.generationId !== body.generationId)) throw new KlingError("KLING_BINDING_UNVERIFIED", "未能核验该云端任务，请确认原账号和任务编号。", 409);
    const candidate = { jobId, principalKey: job.principalKey, region: job.region, generationId: body.generationId, summaryHash: contentHash(bindingSummary(task)), expires: Date.now() + 300_000 };
    const payload = Buffer.from(canonicalJson(candidate)).toString("base64url");
    const signature = createHmac("sha256", runtime.bindingSecret).update(payload).digest("base64url");
    return { candidateToken: payload + "." + signature, candidate: { generationId: body.generationId, status: task.rawStatus, ownershipWarning: "请确认这就是本次镜头对应的官方任务，不能只凭时间或提示词相似绑定" } };
  }
  if (body.action !== "confirm" || body.explicitConfirmation !== true || typeof body.candidateToken !== "string" || body.candidateToken.length > 8192) throw new KlingError("KLING_BINDING_CONFIRMATION_REQUIRED", "请先查询候选任务并明确确认", 422);
  const [payload, signature, extra] = body.candidateToken.split(".");
  const expected = createHmac("sha256", runtime.bindingSecret).update(payload ?? "").digest("base64url");
  if (extra || !signature || Buffer.byteLength(signature) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new KlingError("KLING_BINDING_TOKEN_INVALID", "候选确认已失效，请重新查询", 409);
  let candidate: Record<string, unknown>;
  try { candidate = record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))); }
  catch { throw new KlingError("KLING_BINDING_TOKEN_INVALID", "候选确认无效", 409); }
  if (candidate.jobId !== jobId || candidate.principalKey !== job.principalKey || candidate.region !== job.region || !Number.isSafeInteger(candidate.expires) || Number(candidate.expires) <= Date.now() || typeof candidate.generationId !== "string" || !GENERATION_ID.test(candidate.generationId) || typeof candidate.summaryHash !== "string") throw new KlingError("KLING_BINDING_TOKEN_INVALID", "候选确认已失效，请重新查询", 409);
  await withKlingJobLease(jobId, async () => {
    await withKlingLease(getProfile(job.profileId), async (lease) => {
      const current = getKlingJob(jobId);
      if (current.submissionState !== "submission_unknown" || current.remoteGenerationId) throw new KlingError("KLING_BINDING_CONFLICT", "任务状态已变化，请刷新后重新核对。", 409);
      const profile = await checkedProfile(current, lease);
      const task = normalizeKlingTask((await runKling(profile, ["query_tasks", candidate.generationId as string], { lease, timeoutMs: 30_000 })).json);
      if (task.status === "unknown" || (task.generationId && task.generationId !== candidate.generationId) || contentHash(bindingSummary(task)) !== candidate.summaryHash) throw new KlingError("KLING_BINDING_CANDIDATE_CHANGED", "云端候选任务内容已变化，请重新预览并确认。", 409);
      acknowledge(jobId, candidate.generationId as string, "manual", contentHash(candidate));
    });
  });
  wakeKlingJobRunner();
  return { job: klingJobView(getKlingJob(jobId)) };
}

export async function klingJobAction(jobId: string, action: string, body: unknown): Promise<unknown> {
  getKlingJob(jobId);
  switch (action) {
    case "query": await queryKlingJob(jobId); break;
    case "import": await retryKlingImport(jobId); break;
    case "continue": await continueKlingJob(jobId, body); break;
    case "bind": return bindKlingJob(jobId, body);
    case "cancel-prepared": await withKlingJobLease(jobId, async () => {
      const job = getKlingJob(jobId);
      if (job.submissionState !== "prepared" || job.data.dispatchStartedAt || job.remoteGenerationId) throw new KlingError("KLING_ALREADY_DISPATCHED", "此作业可能已经提交，只能查询原任务。", 409);
      patchKlingJob(jobId, { submissionState: "not_submitted", needsConfirmation: false, nextQueryAt: null }, { authorizedUntil: 0, error: undefined, blockedReason: undefined });
    }); break;
    case "pause-query": patchKlingJob(jobId, { autoQueryPaused: true }); break;
    case "resume-query": patchKlingJob(jobId, { autoQueryPaused: false, nextQueryAt: Date.now() }); startKlingJobRunner(); wakeKlingJobRunner(); break;
    case "dismiss": patchKlingJob(jobId, { dismissedAt: Date.now() }); break;
    default: throw new KlingError("KLING_ACTION_UNSUPPORTED", "不支持的任务操作", 400);
  }
  return { job: klingJobView(getKlingJob(jobId)) };
}
export async function selectKlingJobOutput(jobId: string, outputId: string, body: unknown): Promise<void> {
  await withKlingJobLease(jobId, async () => selectKlingOutput(jobId, outputId, record(body).adoptCurrentContext === true));
}

async function reconcileKlingJobs(): Promise<void> {
  for (const row of listKlingJobs()) {
    if (row.submissionState === "prepared" && (row.data.authorizedBootId !== runtime.bootId || row.data.authorizedUntil <= Date.now()) && !row.needsConfirmation) patchKlingJob(row.id, { needsConfirmation: true });
    if (!["submitting", "submission_unknown"].includes(row.submissionState) || row.remoteGenerationId || (row.leaseExpiresAt && row.leaseExpiresAt > Date.now())) continue;
    await withKlingJobLease(row.id, async () => { try {
      const receipt = record(JSON.parse(await readFile(join(getDataDir(), "integrations", "kling", "receipts", row.id + ".json"), "utf8")));
      if (receipt.jobId !== row.id || receipt.profileId !== row.profileId || receipt.principalKey !== row.principalKey || receipt.region !== row.region || receipt.requestHash !== row.data.requestHash || typeof receipt.generationId !== "string" || !GENERATION_ID.test(receipt.generationId)) throw new Error("Invalid receipt");
      acknowledge(row.id, receipt.generationId, "receipt");
    } catch {
      if (row.submissionState === "submitting") patchKlingJob(row.id, { submissionState: "submission_unknown", remoteState: "unknown", nextQueryAt: null }, { error: { code: "KLING_SUBMISSION_UNKNOWN", message: "提交进程已中断，平台可能已受理，请先核对原任务", retryable: false } });
    } }).catch(() => {});
  }
}
export async function runKlingJobTick(): Promise<void> {
  if (runtime.busy || process.env.NEXT_PHASE === "phase-production-build" || !isKlingRuntimeEnabled()) return;
  runtime.busy = true;
  try {
    cleanupDeletedKlingJobs();
    await reconcileKlingJobs();
    const rows = listKlingJobs().reverse();
    for (const job of rows) {
      if (!job.data.filmRunId && job.submissionState === "prepared" && !job.needsConfirmation && job.data.authorizedBootId === runtime.bootId) {
        await dispatchKlingJob(job.id).catch(() => {}); continue;
      }
      if (job.remoteGenerationId && !job.autoQueryPaused && !job.data.blockedReason && job.nextQueryAt && job.nextQueryAt <= Date.now()) {
        await queryKlingJob(job.id).catch(() => {});
      } else if (job.remoteState === "completed" && ["pending", "importing"].includes(job.importState) && getKlingOutputs(job.id).length) {
        await withKlingJobLease(job.id, () => importKlingOutputs(job.id)).catch(() => {});
      }
    }
  } finally { runtime.busy = false; }
}
export function wakeKlingJobRunner(): void {
  if (process.env.NEXT_PHASE === "phase-production-build" || !isKlingRuntimeEnabled()) return;
  withoutKlingJobLease(() => { setImmediate(() => { void runKlingJobTick().catch(() => {}); }); });
}
export function startKlingJobRunner(): void {
  if (runtime.timer || process.env.NEXT_PHASE === "phase-production-build" || !isKlingRuntimeEnabled()) return;
  runtime.timer = setInterval(wakeKlingJobRunner, 5000);
  runtime.timer.unref();
}
export function stopKlingJobRunner(): void { if (runtime.timer) clearInterval(runtime.timer); runtime.timer = undefined; }
