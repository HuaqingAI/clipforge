import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { assets, characters, projects, scripts } from "@/lib/db/schema";
import { assetMatchesScript } from "@/lib/asset-context";
import { resolveCurrentScript } from "@/lib/current-script";
import { generationRuns, generationItems } from "@/lib/generation-schema";
import { klingProfiles } from "@/lib/kling/profile-schema";
import { klingJobs, klingJobOutputs, type KlingJob } from "@/lib/kling/job-schema";
import { isKlingPreparedAuthorized } from "@/lib/kling/jobs";
import { projectGenerationSignature } from "@/lib/generation-source-context";
import { decryptGenerationValue, encryptGenerationValue } from "@/lib/generation-secrets";
import { captureGenerationInputs } from "@/lib/generation-inputs";
import type { GenerationKind, GenerationPayload } from "@/lib/generation-types";
import { executeGenerationItem } from "@/lib/generation-executor";
import { compactCompletedGenerationCheckpoint } from "@/lib/generation-checkpoint-media";
import { markGenerationAiTasksReleased } from "@/lib/ai-tasks";
import { checkKeyframeRefinementContext } from "@/lib/keyframe-refinement-context";
import { isTideweOutdoorProfile } from "@/lib/creative-profiles";
import { tidewePresenterReference } from "@/lib/tidewe/presenter";
import { resolveCharacterReferenceModel } from "@/lib/character-reference-model";
import { DEFAULT_KEYFRAME_REFINEMENT_RESOLUTION, isKeyframeRefinementResolution, KEYFRAME_REPAIR_ISSUES, supportsKeyframeFocusMask } from "@/lib/keyframe-refinement";
import { validKeyframeFocusRegion } from "@/lib/keyframe-focus-mask";

const ACTIVE = ["queued", "running", "waiting", "importing"];
const RUN_KINDS = ["video_batch", "video", "image", "script", "storyboard_grid", "keyframe_refine", "keyframe_refine_batch"];
const ITEM_KINDS = ["video", "image", "script", "storyboard_grid", "keyframe_refine"];
type Item = typeof generationItems.$inferSelect;
type GenerationStore = Pick<ReturnType<typeof getDb>, "select" | "update">;

export class GenerationRunError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = "INVALID_GENERATION_RUN") { super(message); }
}

export interface EnqueueGenerationRunInput {
  projectId: string;
  clientRequestId: string;
  kind: string;
  label?: string;
  items: Array<{ kind: GenerationKind; scriptId?: string | null; shotId?: number | null; request: Record<string, unknown>; asset?: Record<string, unknown> }>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Status DTOs intentionally omit request snapshots, credentials, and provider checkpoints. */
function runView(run: typeof generationRuns.$inferSelect, items: Item[]) {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  const count = (status: string) => counts.get(status) ?? 0;
  let status = "queued";
  if (items.length && count("completed") === items.length) status = "completed";
  else if (count("running") || count("importing")) status = "running";
  else if (count("queued")) status = "queued";
  else if (count("waiting")) status = "waiting";
  else if (count("needs_attention")) status = "needs_attention";
  else if (count("failed")) status = "failed";
  else if (count("cancelled")) status = "cancelled";
  return { id: run.id, projectId: run.projectId, kind: run.kind, label: run.label, status,
    cancelRequested: run.cancelRequested, total: items.length, done: count("completed"), failed: count("failed") + count("needs_attention"),
    canDelete: individuallyDeletable(items, getDb()),
    createdAt: new Date(run.createdAt).toISOString(), updatedAt: new Date(Math.max(run.updatedAt, ...items.map((i) => i.updatedAt))).toISOString(),
    items: items.map((item) => ({ id: item.id, kind: item.kind, scriptId: item.scriptId, shotId: item.shotId, status: item.status,
      stage: item.stage, result: publicResult(item.result), error: item.error, errorCode: item.errorCode,
      canReleaseBlock: Boolean(releasableKlingJob(item, getDb())),
      canUnbind: Boolean(unbindContext(item, getDb())),
      createdAt: new Date(item.createdAt).toISOString(), updatedAt: new Date(item.updatedAt).toISOString() })) };
}

function publicResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicResult);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !/api.?key|authorization|credential|secret|token|snapshot|request|checkpoint/i.test(key)).map(([key, val]) => [key, publicResult(val)]));
  return value;
}

function hasRecoverableResult(checkpoint: Record<string, unknown>): boolean {
  return Boolean(checkpoint.taskId || checkpoint.remoteTaskId || checkpoint.childJobId || checkpoint.result || checkpoint.resultUrls || checkpoint.response || checkpoint.videoUrl || checkpoint.imageUrl
    || (Array.isArray(checkpoint.imageUrls) && checkpoint.imageUrls.length)
    || (Array.isArray(checkpoint.generatedScripts) && checkpoint.generatedScripts.length));
}

/** Repair only the old, locally identified planner error; unknown submissions stay blocked. */
function reconcileScriptValidationFailures(items: Item[], tx: GenerationStore): Item[] {
  return items.map((item) => {
    if (item.kind !== "script" || item.status !== "needs_attention" || item.errorCode !== "GENERATION_NEEDS_ATTENTION"
      || item.leaseOwner || item.result && Object.keys(item.result).length
      || !/^Shot \d+ has on_camera speech in detail framing; use off_camera narration or choose a framing that includes the speaking face\.$/.test(item.error ?? "")) return item;
    let checkpoint: Record<string, unknown>, payload: GenerationPayload;
    try {
      checkpoint = item.checkpoint ? decryptGenerationValue<Record<string, unknown>>(item.checkpoint) : {};
      payload = decryptGenerationValue<GenerationPayload>(item.payload);
    } catch { return item; }
    if (checkpoint.submissionState !== "submitting" || hasRecoverableResult(checkpoint)
      || checkpoint.completedResult || checkpoint.imageUrls || checkpoint.videoUrls || checkpoint.gridPublicPath
      || !isTideweOutdoorProfile(payload.snapshot?.project?.creativeProfile)
      || (payload.request.generationEndpoint && payload.request.generationEndpoint !== "/api/llm/script")) return item;
    if (tx.select().from(scripts).where(eq(scripts.projectId, item.projectId)).all().some(script => script.generationMetadata?.requestId === item.id)) return item;
    return tx.update(generationItems).set({ status: "failed", stage: "failed", errorCode: "TIDEWE_VALIDATION_FAILED",
      checkpoint: encryptGenerationValue({ ...checkpoint, submissionState: "acknowledged", stage: "failed",
        scriptValidationFailure: { code: "TIDEWE_VALIDATION_FAILED", message: item.error } }), updatedAt: Date.now() })
      .where(and(eq(generationItems.id, item.id), eq(generationItems.status, item.status), eq(generationItems.updatedAt, item.updatedAt), isNull(generationItems.leaseOwner))).returning().get() ?? item;
  });
}

function safelyUnsubmitted(item: Item): boolean {
  if (!item.checkpoint) return true;
  const checkpoint = decryptGenerationValue<Record<string, unknown>>(item.checkpoint);
  return checkpoint.submissionState === "not_submitted" && !hasRecoverableResult(checkpoint);
}

function leaseStillActive(row: { leaseOwner: string | null; leaseExpiresAt: number | null }): boolean {
  if (!row.leaseOwner) return false;
  const pid = Number(row.leaseOwner.split(":")[0]);
  return !Number.isSafeInteger(pid) || pid <= 0 || (row.leaseExpiresAt ?? 0) > Date.now() || processAlive(row.leaseOwner);
}

/** Release only a stopped, unidentified Kling submission; known cloud work keeps its recovery path. */
function releasableKlingJob(item: Item, tx: GenerationStore): KlingJob | null {
  if (item.kind !== "video" || item.status !== "needs_attention" || !item.scriptId || item.shotId == null || leaseStillActive(item)) return null;
  let payload: GenerationPayload, checkpoint: Record<string, unknown>;
  try {
    payload = decryptGenerationValue<GenerationPayload>(item.payload);
    checkpoint = item.checkpoint ? decryptGenerationValue<Record<string, unknown>>(item.checkpoint) : {};
  } catch { return null; }
  if (!payload?.request || !checkpoint || typeof checkpoint !== "object") return null;
  if (payload.request.provider !== "kling-cli" || checkpoint.remoteTaskId || checkpoint.taskId || checkpoint.completedResult) return null;
  const jobs = tx.select().from(klingJobs).where(and(eq(klingJobs.clientRequestId, item.id), eq(klingJobs.projectId, item.projectId))).all();
  if (jobs.length !== 1) return null;
  const job = jobs[0];
  if (job.profileId !== payload.request.profileId || job.scriptId !== item.scriptId || job.shotId !== item.shotId
    || (job.data.generationItemId && job.data.generationItemId !== item.id)
    || (checkpoint.childJobId && checkpoint.childJobId !== job.id)
    || (item.result?.childJobId && item.result.childJobId !== job.id)
    || job.data.blockingReleasedAt || job.submissionState !== "submission_unknown"
    || job.remoteGenerationId || leaseStillActive(job)) return null;
  return job;
}

/** Explicit abandonment stops local observation while retaining the original paid work. */
function unbindContext(item: Item, tx: GenerationStore): { checkpoint: Record<string, unknown>; job: KlingJob | null } | null {
  if (item.status !== "needs_attention" || leaseStillActive(item)) return null;
  let checkpoint: Record<string, unknown>, payload: GenerationPayload;
  try {
    checkpoint = item.checkpoint ? decryptGenerationValue<Record<string, unknown>>(item.checkpoint) : {};
    payload = decryptGenerationValue<GenerationPayload>(item.payload);
  } catch { return null; }
  if (!payload?.request || !checkpoint || typeof checkpoint !== "object") return null;
  const jobs = tx.select().from(klingJobs).where(and(eq(klingJobs.clientRequestId, item.id), eq(klingJobs.projectId, item.projectId))).all();
  if (!jobs.length) return checkpoint.childJobId || item.result?.childJobId ? null : { checkpoint, job: null };
  if (jobs.length !== 1 || item.kind !== "video" || payload.request.provider !== "kling-cli") return null;
  const job = jobs[0];
  if (job.profileId !== payload.request.profileId || job.scriptId !== item.scriptId || job.shotId !== item.shotId
    || job.data.generationItemId && job.data.generationItemId !== item.id
    || checkpoint.childJobId && checkpoint.childJobId !== job.id
    || item.result?.childJobId && item.result.childJobId !== job.id
    || leaseStillActive(job)) return null;
  return { checkpoint, job };
}

function unbindItem(item: Item, tx: GenerationStore) {
  const context = unbindContext(item, tx);
  if (!context) throw new GenerationRunError("此任务状态已变化或仍在执行，不能解除绑定。请刷新并核对原任务。", 409, "GENERATION_UNBIND_CONFLICT");
  const { checkpoint, job } = context, now = Date.now();
  markItemAiTaskReleased(item, tx, checkpoint);
  if (job) tx.update(klingJobs).set({ autoQueryPaused: true, needsConfirmation: false, nextQueryAt: null,
    leaseOwner: null, leaseExpiresAt: null, revision: job.revision + 1, updatedAt: now,
    data: { ...job.data, blockingReleasedAt: job.data.blockingReleasedAt ?? now, authorizedUntil: 0 },
  }).where(eq(klingJobs.id, job.id)).run();
  tx.update(generationItems).set({ status: "cancelled", stage: "released", leaseOwner: null, leaseExpiresAt: null,
    ...(job ? { result: { ...item.result, childJobId: job.id } } : {}),
    checkpoint: encryptGenerationValue({ ...checkpoint, ...(job ? { childJobId: job.id } : {}), blockingReleasedAt: now, acknowledgedPossibleCharge: true }), updatedAt: now,
  }).where(eq(generationItems.id, item.id)).run();
  tx.update(generationRuns).set({ updatedAt: now }).where(eq(generationRuns.id, item.runId)).run();
}

function individuallyDeletable(items: Item[], tx: GenerationStore): boolean {
  return items.length > 0 && items.every((item) => item.status === "needs_attention" ? Boolean(unbindContext(item, tx))
    : ["completed", "failed", "cancelled"].includes(item.status) && item.leaseOwner === null && item.leaseExpiresAt === null);
}

/** Persist the exact paid identity once, so task discovery never decrypts historical snapshots. */
function markItemAiTaskReleased(item: Item, tx: GenerationStore, checkpoint?: Record<string, unknown>): void {
  let provider: unknown;
  let saved: Record<string, unknown>;
  try {
    const payload = decryptGenerationValue<GenerationPayload>(item.payload);
    saved = checkpoint ?? (item.checkpoint ? decryptGenerationValue<Record<string, unknown>>(item.checkpoint) : {});
    provider = payload.request?.provider;
  } catch { return; /* Unreadable associations must not hide unrelated recoverable paid work. */ }
  if (typeof provider === "string") markGenerationAiTasksReleased(tx, item.projectId, provider,
    [saved.taskId, saved.remoteTaskId].filter((id): id is string => typeof id === "string"));
}

/** Observe an existing child only. Reads never authorize, submit, query, or import cloud work. */
function reconcileKlingItems(items: Item[], tx: GenerationStore): Item[] {
  return items.map((item) => {
    if (item.kind !== "video" || !item.scriptId || item.shotId == null || item.leaseOwner || item.leaseExpiresAt !== null
      || ["completed", "cancelled"].includes(item.status)) return item;
    let checkpoint: Record<string, unknown>, payload: GenerationPayload;
    try {
      checkpoint = item.checkpoint ? decryptGenerationValue<Record<string, unknown>>(item.checkpoint) : {};
      payload = decryptGenerationValue<GenerationPayload>(item.payload);
    } catch { return item; }
    if (!payload || typeof payload !== "object" || !payload.request || typeof payload.request !== "object"
      || !checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return item;
    const request = payload.request;
    if (request.provider !== "kling-cli" || typeof request.profileId !== "string"
      || request.projectId !== item.projectId || request.scriptId !== item.scriptId || request.shotId !== item.shotId
      || checkpoint.blockingReleasedAt || item.stage === "released") return item;
    const run = tx.select().from(generationRuns).where(eq(generationRuns.id, item.runId)).get();
    const script = tx.select().from(scripts).where(eq(scripts.id, item.scriptId)).get();
    if (!run || run.deletedAt !== null || run.projectId !== item.projectId || script?.projectId !== item.projectId) return item;
    const jobs = tx.select().from(klingJobs).where(and(eq(klingJobs.clientRequestId, item.id), eq(klingJobs.projectId, item.projectId))).all();
    if (jobs.length !== 1) return item;
    const job = jobs[0];
    const frozenKling = payload.snapshot?.kling;
    if (job.data.deletedAt || job.data.blockingReleasedAt || job.data.filmRunId || job.leaseOwner || job.leaseExpiresAt !== null
      || job.profileId !== request.profileId || job.scriptId !== item.scriptId || job.shotId !== item.shotId
      || job.data.generationItemId !== item.id
      || (checkpoint.childJobId != null && checkpoint.childJobId !== job.id)
      || (item.result?.childJobId != null && item.result.childJobId !== job.id)
      || (checkpoint.completedResult && typeof checkpoint.completedResult === "object"
        && "childJobId" in checkpoint.completedResult && checkpoint.completedResult.childJobId !== job.id)
      || (checkpoint.remoteTaskId != null && checkpoint.remoteTaskId !== job.remoteGenerationId)
      || (checkpoint.taskId != null && checkpoint.taskId !== job.remoteGenerationId)
      || (frozenKling && (frozenKling.profileId !== job.profileId || frozenKling.principalKey !== job.principalKey || frozenKling.region !== job.region))
      || (job.data.generationProjectSignature && (!payload.snapshot?.project || job.data.generationProjectSignature !== projectGenerationSignature(payload.snapshot.project)))) return item;

    const update = (status: string, stage: string, result: Record<string, unknown> = { ...item.result, childJobId: job.id }, error: string | null = null, errorCode: string | null = null) => {
      // ACTIVE rows can be claimed by the worker. This durable marker forbids creating a replacement child.
      const nextCheckpoint: Record<string, unknown> = { ...checkpoint, childJobId: job.id, klingObserveOnly: true, stage,
        submissionState: job.submissionState, ...(job.remoteGenerationId ? { remoteTaskId: job.remoteGenerationId } : {}),
        ...(status === "completed" ? { completedResult: result } : {}) };
      if (status !== "completed") delete nextCheckpoint.completedResult;
      if (item.status === status && item.stage === stage && item.error === error && item.errorCode === errorCode
        && canonical(item.result) === canonical(result) && canonical(checkpoint) === canonical(nextCheckpoint)) return item;
      return tx.update(generationItems).set({ status, stage, result, error, errorCode,
        checkpoint: encryptGenerationValue(nextCheckpoint), nextRunAt: Date.now(), updatedAt: Date.now() })
        .where(and(eq(generationItems.id, item.id), eq(generationItems.status, item.status), eq(generationItems.updatedAt, item.updatedAt),
          isNull(generationItems.leaseOwner), isNull(generationItems.leaseExpiresAt))).returning().get() ?? item;
    };
    const attention = (message = job.data.error?.message ?? job.data.blockedReason ?? "原 Kling 任务需要手动确认，请在原任务中继续。", code = "GENERATION_NEEDS_ATTENTION") =>
      update("needs_attention", "needs_attention", undefined, redactError(new Error(message), payload), code);

    const allOutputs = job.remoteState === "completed" ? tx.select().from(klingJobOutputs).where(eq(klingJobOutputs.jobId, job.id)).all() : [];
    const outputs = allOutputs.filter((output) => !output.data.deletedAt);
    if (allOutputs.length && !outputs.length) return item;
    // Already saved local media needs no account authorization or resumed cloud observation.
    if (job.remoteState === "completed" && outputs.length && outputs.every((output) => output.importState === "imported")) {
      if (outputs.some((output) => !output.assetId || !output.data.filePath)) return attention("Kling 已保存结果的素材记录不完整，请核对原任务。", "GENERATION_IMPORT_FAILED");
      const savedAssets = tx.select().from(assets).where(inArray(assets.id, outputs.map((output) => output.assetId!))).all();
      if (outputs.some((output) => !savedAssets.some((asset) => asset.id === output.assetId && asset.projectId === item.projectId
        && asset.shotId === item.shotId && asset.sourceScriptId === item.scriptId && asset.provider === "kling-cli" && asset.status === "done"
        && asset.filePath === output.data.filePath))) return attention("Kling 已保存结果的素材绑定不一致，请核对原任务。", "GENERATION_IMPORT_FAILED");
      return update("completed", "ready", { childJobId: job.id, assetIds: outputs.map((output) => output.assetId!), videoUrls: outputs.map((output) => output.data.filePath!) });
    }

    if (job.submissionState === "submission_unknown" || job.submissionState === "not_submitted" || job.needsConfirmation || job.autoQueryPaused
      || job.data.blockedReason || job.remoteState === "unknown") return attention();
    if (job.submissionState === "prepared") {
      if (job.remoteGenerationId || job.data.dispatchStartedAt || job.remoteState !== "not_started" || !isKlingPreparedAuthorized(job)) return attention();
      return update("queued", "queued_submission");
    }
    if (job.submissionState === "submitting") return job.remoteGenerationId ? attention() : update("running", "submitting");
    if (job.submissionState !== "acknowledged" || !job.remoteGenerationId) return attention();
    if (job.remoteState === "failed") return update("failed", "failed", undefined,
      redactError(new Error(job.data.error?.message ?? "Kling 生成失败"), payload), "GENERATION_PROVIDER_FAILED");
    if (job.remoteState === "cancelled") return update("cancelled", "cancelled");
    if (["pending", "processing"].includes(job.remoteState)) return update("waiting", "cloud_running");
    if (job.remoteState !== "completed") return attention();

    if (job.importState === "failed" || job.importState === "partial" || outputs.some((output) => output.importState === "failed")) {
      return attention(job.data.error?.message ?? outputs.find((output) => output.data.error)?.data.error?.message ?? "Kling 素材保存失败，请在原任务中重试保存。", "GENERATION_IMPORT_FAILED");
    }
    return update("importing", "importing");
  });
}

function liveRun(tx: GenerationStore, id: string) {
  const run = tx.select().from(generationRuns).where(eq(generationRuns.id, id)).get();
  if (!run) throw new GenerationRunError("任务批次不存在。", 404, "GENERATION_RUN_NOT_FOUND");
  if (run.deletedAt !== null) throw new GenerationRunError("任务记录已删除，不能重新执行或恢复。", 410, "GENERATION_RUN_DELETED");
  return run;
}

function runItems(tx: GenerationStore, id: string) {
  return tx.select().from(generationItems).where(eq(generationItems.runId, id)).orderBy(asc(generationItems.createdAt), asc(generationItems.id)).all();
}

function reconciledItems(tx: GenerationStore, items: Item[]) {
  return reconcileScriptValidationFailures(reconcileKlingItems(items, tx), tx);
}

export function getGenerationRun(id: string) {
  // Reads can reconcile existing local child jobs. Serialize that work with
  // deletion and recovery, and check the tombstone before touching any item.
  return getDb().transaction((tx) => {
    const run = liveRun(tx, id);
    return runView(run, reconciledItems(tx, runItems(tx, id)));
  }, { behavior: "immediate" });
}

export function listGenerationRuns(projectId?: string) {
  return getDb().transaction((tx) => {
    const runs = tx.select().from(generationRuns).where(and(isNull(generationRuns.deletedAt), projectId ? eq(generationRuns.projectId, projectId) : undefined)).orderBy(desc(generationRuns.createdAt)).all();
    if (!runs.length) return [];
    const items = reconciledItems(tx, tx.select().from(generationItems).where(inArray(generationItems.runId, runs.map((r) => r.id))).orderBy(asc(generationItems.createdAt), asc(generationItems.id)).all());
    const grouped = new Map<string, Item[]>();
    for (const item of items) { const group = grouped.get(item.runId) ?? []; group.push(item); grouped.set(item.runId, group); }
    return runs.map((run) => runView(run, grouped.get(run.id) ?? []));
  }, { behavior: "immediate" });
}

function deletionProject(tx: GenerationStore, projectId: unknown): string {
  if (typeof projectId !== "string" || !projectId.trim()) throw new GenerationRunError("删除任务记录需要当前项目编号。", 400, "GENERATION_PROJECT_REQUIRED");
  const id = projectId.trim();
  if (!tx.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).get()) throw new GenerationRunError("项目不存在。", 404, "GENERATION_PROJECT_NOT_FOUND");
  return id;
}

function deletableRun(run: typeof generationRuns.$inferSelect, items: Item[]): boolean {
  return items.length > 0 && ["completed", "failed"].includes(runView(run, items).status)
    && items.every((item) => ["completed", "failed"].includes(item.status) && item.leaseOwner === null && item.leaseExpiresAt === null);
}

/** Hide records only; paid outputs, files, request keys, and checkpoints remain intact. */
export function deleteGenerationRuns(projectId: unknown, id?: string) {
  return getDb().transaction((tx) => {
    const scope = deletionProject(tx, projectId);
    const runs = tx.select().from(generationRuns).where(and(eq(generationRuns.projectId, scope), id === undefined ? isNull(generationRuns.deletedAt) : eq(generationRuns.id, id))).all();
    if (id !== undefined && !runs.length) throw new GenerationRunError("任务批次不存在。", 404, "GENERATION_RUN_NOT_FOUND");
    const eligible = runs.filter((run) => run.deletedAt === null && (id === undefined ? deletableRun(run, runItems(tx, run.id)) : individuallyDeletable(runItems(tx, run.id), tx)));
    if (id !== undefined && runs[0].deletedAt === null && !eligible.length) throw new GenerationRunError("只能删除已停止的任务记录；仍在执行的任务请等待结束。", 409, "GENERATION_RUN_NOT_DELETABLE");
    for (const run of eligible) for (const item of runItems(tx, run.id)) if (item.status === "needs_attention") unbindItem(item, tx);
    const deletedIds = eligible.map((run) => run.id);
    for (const id of deletedIds) for (const item of runItems(tx, id)) markItemAiTaskReleased(item, tx);
    if (deletedIds.length) tx.update(generationRuns).set({ deletedAt: Date.now() }).where(and(eq(generationRuns.projectId, scope), isNull(generationRuns.deletedAt), inArray(generationRuns.id, deletedIds))).run();
    return { deletedIds, deletedCount: deletedIds.length };
  }, { behavior: "immediate" });
}

/** One immediate transaction accepts the entire batch or nothing, before any paid work. */
export function enqueueGenerationRun(input: EnqueueGenerationRunInput) {
  if (!input || typeof input.projectId !== "string" || !input.projectId || typeof input.clientRequestId !== "string" || !input.clientRequestId || input.clientRequestId.length > 200 || !RUN_KINDS.includes(input.kind)
    || !Array.isArray(input.items) || !input.items.length || input.items.length > 500) throw new GenerationRunError("请提供项目、请求编号和完整镜头清单（最多 500 项）。");
  if (!["video_batch", "keyframe_refine_batch"].includes(input.kind) && input.items.length !== 1) throw new GenerationRunError("此任务类型一次只能提交一项。");
  const hash = createHash("sha256").update(canonical(input)).digest("hex");
  const db = getDb();
  const runId = db.transaction((tx) => {
    const old = tx.select().from(generationRuns).where(and(eq(generationRuns.projectId, input.projectId), eq(generationRuns.clientRequestId, input.clientRequestId))).get();
    if (old) {
      if (old.deletedAt !== null) throw new GenerationRunError("任务记录已删除，请使用新请求编号创建新任务。", 410, "GENERATION_RUN_DELETED");
      if (old.requestHash !== hash) throw new GenerationRunError("相同请求编号的内容已变化，请重新确认。", 409, "GENERATION_REQUEST_CONFLICT");
      return old.id;
    }
    const project = tx.select().from(projects).where(eq(projects.id, input.projectId)).get();
    if (!project) throw new GenerationRunError("项目不存在。", 404);
    const projectScripts = tx.select().from(scripts).where(eq(scripts.projectId, input.projectId)).all();
    const currentScript = resolveCurrentScript(projectScripts);
    const now = Date.now();
    const id = randomUUID();
    const seen = new Set<string>();
    const values = input.items.map((inputItem, index) => {
      const expectedKind = input.kind === "video_batch" ? "video" : input.kind === "keyframe_refine_batch" ? "keyframe_refine" : input.kind;
      if (!inputItem || !ITEM_KINDS.includes(inputItem.kind) || inputItem.kind !== expectedKind
        || !inputItem.request || typeof inputItem.request !== "object" || Array.isArray(inputItem.request)) throw new GenerationRunError("任务条目无效。");
      const scriptId = inputItem.scriptId ?? (typeof inputItem.request.scriptId === "string" ? inputItem.request.scriptId : currentScript?.id) ?? null;
      const script = scriptId ? projectScripts.find((s) => s.id === scriptId) : null;
      if (scriptId && !script) throw new GenerationRunError("源脚本不属于该项目。", 409);
      const shotId = inputItem.shotId ?? (typeof inputItem.request.shotId === "number" ? inputItem.request.shotId : null);
      if (["video", "image", "keyframe_refine"].includes(inputItem.kind) && (!script || !Number.isSafeInteger(shotId) || !script.shots?.some((s) => s.shotId === shotId))) throw new GenerationRunError("镜头不在源脚本中，请刷新后确认。", 409);
      if (inputItem.kind === "storyboard_grid" && !script) throw new GenerationRunError("请先生成分镜脚本。", 409);
      const dedupeKey = `${inputItem.kind}:${scriptId}:${shotId}`;
      if (seen.has(dedupeKey)) throw new GenerationRunError("同一批次不能重复包含一个镜头。");
      seen.add(dedupeKey);
      const overlap = tx.select({ id: generationItems.id }).from(generationItems).where(and(eq(generationItems.projectId, input.projectId), eq(generationItems.kind, inputItem.kind),
        scriptId ? eq(generationItems.scriptId, scriptId) : isNull(generationItems.scriptId), shotId === null ? isNull(generationItems.shotId) : eq(generationItems.shotId, shotId),
        inArray(generationItems.status, [...ACTIVE, "needs_attention"]),
        inArray(generationItems.runId, tx.select({ id: generationRuns.id }).from(generationRuns).where(isNull(generationRuns.deletedAt))))).get();
      if (overlap) throw new GenerationRunError("该镜头或生成阶段已有未结束任务，请查看原任务。", 409, "GENERATION_ALREADY_ACTIVE");
      const itemId = randomUUID();
      const request: Record<string, unknown> = { ...inputItem.request, projectId: input.projectId, ...(scriptId ? { scriptId } : {}), ...(shotId !== null ? { shotId } : {}), ...(inputItem.kind === "script" ? { requestId: itemId } : {}) };
      const payload: GenerationPayload = { request, ...(inputItem.asset ? { asset: { ...inputItem.asset } } : {}), snapshot: { project: JSON.parse(JSON.stringify(project)), ...(script ? { script: JSON.parse(JSON.stringify(script)) } : {}) } };
      if (inputItem.kind === "keyframe_refine") {
        if (!script || script.id !== currentScript?.id) throw new GenerationRunError("当前脚本已切换，请刷新后重新确认精修。", 409, "SCRIPT_CONTEXT_CHANGED");
        const source = typeof request.sourceAssetId === "string" ? tx.select().from(assets).where(eq(assets.id, request.sourceAssetId)).get() : null;
        if (!source || source.projectId !== project.id || source.shotId !== shotId || !assetMatchesScript(source, script)) throw new GenerationRunError("精修源图不属于当前项目、脚本或分镜。", 409, "SOURCE_CONTEXT_MISMATCH");
        if (source.status !== "done" || !source.filePath?.startsWith(`/api/files/${project.id}/`) || !/\.(?:png|jpe?g|webp|avif|bmp)$/i.test(source.filePath)) throw new GenerationRunError("精修源图不是可用的本地静态关键帧。", 409, "SOURCE_IMAGE_UNAVAILABLE");
        if (request.sourceImageUrl !== undefined && request.sourceImageUrl !== source.filePath) throw new GenerationRunError("精修源图已变化，请刷新后重新确认。", 409, "SOURCE_CONTEXT_MISMATCH");
        if (request.resolution === undefined) request.resolution = DEFAULT_KEYFRAME_REFINEMENT_RESOLUTION;
        if (!isKeyframeRefinementResolution(request.resolution)) throw new GenerationRunError("请选择 720p 或 1080p 精修分辨率。");
        const issues = new Set<string>(KEYFRAME_REPAIR_ISSUES.map((issue) => issue.id));
        if (!Array.isArray(request.issues) || !request.issues.every((issue) => typeof issue === "string" && issues.has(issue))) throw new GenerationRunError("精修项目无效，请重新选择。");
        if (request.focusRegion !== undefined) {
          if (!validKeyframeFocusRegion(request.focusRegion)) throw new GenerationRunError("区域重绘只接受有效的 x、y、width、height 归一化矩形。", 400, "INVALID_FOCUS_REGION");
          if (request.issues.length !== 1 || request.issues[0] !== "integration") throw new GenerationRunError("区域重绘只能单独用于人物环境融合与景深修复。", 400, "FOCUS_REGION_REQUIRES_INTEGRATION");
          if (!supportsKeyframeFocusMask(String(request.provider), String(request.model))) throw new GenerationRunError("此模型不支持区域蒙版重绘，请选择支持的 GPT Image 模型或关闭区域重绘。", 400, "FOCUS_MASK_UNSUPPORTED");
          if (!/\.png$/i.test(source.filePath)) throw new GenerationRunError("区域重绘首版需要 PNG 源关键帧，请先上传或生成 PNG 图片。", 400, "FOCUS_MASK_PNG_REQUIRED");
        }
        if ((request.instructions !== undefined && typeof request.instructions !== "string") || (typeof request.instructions === "string" && request.instructions.length > 2000)
          || (!request.issues.length && !(typeof request.instructions === "string" && request.instructions.trim()))) throw new GenerationRunError("请选择精修项目或填写有效的修复说明（最多 2000 字）。");
        if (typeof request.provider !== "string" || typeof request.model !== "string" || typeof request.apiKey !== "string" || !request.apiKey.trim()) throw new GenerationRunError("请配置图片精修平台、模型与 API Key。");
        const context = checkKeyframeRefinementContext(project, script);
        if (!context.ok) throw new GenerationRunError("创作设置或商品事实已变化，请先按当前配置生成脚本再精修。", 409, context.code);
        const shot = script.shots!.find((item) => item.shotId === shotId)!;
        const profile = context.scriptProfile;
        const tidewe = isTideweOutdoorProfile(profile);
        let presenterReference = tidewe && shot.tidewe?.personVisible !== false ? tidewePresenterReference(profile) : undefined;
        if (!tidewe) {
          for (const id of [...new Set([shot.characterId, project.characterId])]) {
            if (!id) continue;
            const character = tx.select().from(characters).where(eq(characters.id, id)).get();
            presenterReference = character?.referenceImages?.find((reference) => typeof reference === "string" && Boolean(reference.trim()));
            if (presenterReference) break;
          }
        }
        const productRefs = tidewe && shot.tidewe?.productVisible === false ? [] : project.productImages ?? [];
        const editModel = resolveCharacterReferenceModel(request.provider, request.model, 1 + (presenterReference ? 1 : 0) + productRefs.length);
        if (!editModel.ok) throw new GenerationRunError(editModel.error, 400, "KEYFRAME_EDIT_MODEL_UNSUPPORTED");
        request.model = editModel.modelId;
        payload.snapshot!.refinement = { source: JSON.parse(JSON.stringify(source)), ...(presenterReference ? { presenterReference } : {}) };
      }
      if (request.provider === "kling-cli") {
        const profile = typeof request.profileId === "string" ? tx.select().from(klingProfiles).where(eq(klingProfiles.id, request.profileId)).get()?.data : null;
        const model = profile?.catalogSnapshot.find((candidate) => candidate.selectionKey === request.selectionKey);
        if (!profile || profile.disabledAt || profile.environmentState !== "ready" || profile.authState !== "authenticated" || !profile.principalKey || !model || !model.available) {
          throw new GenerationRunError("Kling 账号或模型尚未核验，请先在设置页登录并刷新模型。", 409, "GENERATION_KLING_CONFIGURATION_INVALID");
        }
        payload.snapshot!.kling = { profileId: profile.id, principalKey: profile.principalKey, region: profile.region, model: JSON.parse(JSON.stringify(model)) };
      }
      try {
        payload.snapshot!.referenceInputs = captureGenerationInputs({ request, productImages: project.productImages, creativeProfile: project.creativeProfile, characters: script?.characters,
          ...(payload.snapshot!.refinement ? { sourceImageUrl: payload.snapshot!.refinement.source.filePath, presenterReference: payload.snapshot!.refinement.presenterReference } : {}) });
      } catch (error) {
        throw new GenerationRunError(error instanceof Error ? error.message : "生成参考素材不可用，请重新确认。", 409, (error as { code?: string }).code ?? "GENERATION_REFERENCE_UNREADABLE");
      }
      return { id: itemId, runId: id, projectId: input.projectId, kind: inputItem.kind, scriptId, shotId, payload: encryptGenerationValue(payload), nextRunAt: now, createdAt: now + index, updatedAt: now };
    });
    tx.insert(generationRuns).values({ id, projectId: input.projectId, clientRequestId: input.clientRequestId, requestHash: hash, kind: input.kind, label: input.label?.slice(0, 200), createdAt: now, updatedAt: now }).run();
    for (const value of values) tx.insert(generationItems).values(value).run();
    return id;
  }, { behavior: "immediate" });
  wakeGenerationRunner();
  return getGenerationRun(runId);
}

export function generationRunAction(id: string, action: string, options: { itemId?: unknown; projectId?: unknown; acknowledgePossibleCharge?: unknown } = {}) {
  const db = getDb();
  const result = db.transaction((tx) => {
    const run = liveRun(tx, id);
    const items = reconciledItems(tx, runItems(tx, id));
    if (action === "retry_import" && runView(run, items).status === "completed") return runView(run, items);
    if (action === "unbind") {
      if (typeof options.projectId !== "string" || options.projectId !== run.projectId) throw new GenerationRunError("请在原项目中解除该任务的绑定。", 404, "GENERATION_ITEM_NOT_FOUND");
      if (options.acknowledgePossibleCharge !== true) throw new GenerationRunError("请先确认解除绑定不会取消原云端任务，重新生成可能再次计费。", 400, "GENERATION_RELEASE_ACK_REQUIRED");
      const item = items.find((candidate) => candidate.id === options.itemId);
      if (!item) throw new GenerationRunError("没有找到此任务。", 404, "GENERATION_ITEM_NOT_FOUND");
      if (item.status === "cancelled" && item.stage === "released") return runView(run, items);
      unbindItem(item, tx);
    } else if (action === "release_block") {
      if (typeof options.projectId !== "string" || options.projectId !== run.projectId) throw new GenerationRunError("请在原项目中解除该镜头的阻塞。", 404, "GENERATION_ITEM_NOT_FOUND");
      if (options.acknowledgePossibleCharge !== true) throw new GenerationRunError("请先确认原任务可能仍在云端运行或计费，再解除阻塞。", 400, "GENERATION_RELEASE_ACK_REQUIRED");
      const item = items.find((candidate) => candidate.id === options.itemId);
      if (!item) throw new GenerationRunError("没有找到此镜头任务。", 404, "GENERATION_ITEM_NOT_FOUND");
      // Repeated clicks and lost acknowledgements refer to this same local release.
      if (item.status === "cancelled" && item.stage === "released") return runView(run, items);
      const job = releasableKlingJob(item, tx);
      if (!job) throw new GenerationRunError("此任务状态已变化或仍在执行，不能解除。请刷新并核对原镜头任务。", 409, "GENERATION_RELEASE_CONFLICT");
      const now = Date.now();
      const checkpoint = item.checkpoint ? decryptGenerationValue<Record<string, unknown>>(item.checkpoint) : {};
      tx.update(klingJobs).set({ autoQueryPaused: true, needsConfirmation: false, nextQueryAt: null,
        leaseOwner: null, leaseExpiresAt: null, revision: job.revision + 1, updatedAt: now,
        data: { ...job.data, blockingReleasedAt: now, authorizedUntil: 0 },
      }).where(eq(klingJobs.id, job.id)).run();
      tx.update(generationItems).set({ status: "cancelled", stage: "released", leaseOwner: null, leaseExpiresAt: null,
        result: { ...item.result, childJobId: job.id },
        checkpoint: encryptGenerationValue({ ...checkpoint, childJobId: job.id, blockingReleasedAt: now, acknowledgedPossibleCharge: true }), updatedAt: now,
      }).where(eq(generationItems.id, item.id)).run();
      tx.update(generationRuns).set({ updatedAt: now }).where(eq(generationRuns.id, id)).run();
    } else if (action === "cancel") {
      tx.update(generationRuns).set({ cancelRequested: true, updatedAt: Date.now() }).where(eq(generationRuns.id, id)).run();
      // Already dispatched cloud work is still observed and imported; cancellation never loses a paid result.
      for (const item of tx.select().from(generationItems).where(and(eq(generationItems.runId, id), inArray(generationItems.status, ["queued", "waiting"]), isNull(generationItems.leaseOwner))).all()) {
        if (safelyUnsubmitted(item)) tx.update(generationItems).set({ status: "cancelled", stage: "cancelled", updatedAt: Date.now() }).where(eq(generationItems.id, item.id)).run();
      }
    } else if (action === "retry_import") {
      let eligible = 0;
      for (const item of tx.select().from(generationItems).where(eq(generationItems.runId, id)).all()) {
        if (!["needs_attention", "failed"].includes(item.status) || !item.checkpoint) continue;
        const checkpoint = decryptGenerationValue<Record<string, unknown>>(item.checkpoint);
        if (!hasRecoverableResult(checkpoint)) continue;
        tx.update(generationItems).set({ status: "waiting", stage: "recovering", error: null, errorCode: null, checkpoint: encryptGenerationValue({ ...checkpoint, importFailures: 0 }), nextRunAt: Date.now(), updatedAt: Date.now() }).where(eq(generationItems.id, item.id)).run();
        eligible++;
      }
      if (!eligible) throw new GenerationRunError("没有可安全恢复的已受理结果；提交结果不明确时，请先核对原平台任务，避免重复扣费。", 409, "GENERATION_RECOVERY_UNSAFE");
    } else throw new GenerationRunError("不支持此任务操作。");
    return runView(tx.select().from(generationRuns).where(eq(generationRuns.id, id)).get()!, runItems(tx, id));
  }, { behavior: "immediate" });
  wakeGenerationRunner();
  return result;
}

interface RunnerState { timer?: ReturnType<typeof setInterval>; ticking: boolean; active: Set<string>; lastReconciledAt?: number }
const globalRunner = globalThis as typeof globalThis & { __clipforgeGenerationRunner?: RunnerState };
function runnerState(): RunnerState { return globalRunner.__clipforgeGenerationRunner ??= { ticking: false, active: new Set() }; }
function processAlive(owner: string) {
  const pid = Number(owner.split(":")[0]);
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Short SQLite leases coordinate multiple server bundles/processes; heartbeats fence late results. */
function claimNextItem(): Item | null {
  return getDb().transaction((tx) => {
    const now = Date.now();
    const visibleRuns = tx.select({ id: generationRuns.id }).from(generationRuns).where(isNull(generationRuns.deletedAt));
    const candidates = tx.select().from(generationItems).where(and(inArray(generationItems.runId, visibleRuns), inArray(generationItems.status, ACTIVE), lte(generationItems.nextRunAt, now))).all();
    if (!candidates.length) return null;
    const busyProjects = new Map<string, number>();
    const projectDispatch = new Map<string, number>();
    for (const item of tx.select({ projectId: generationItems.projectId, lastDispatchedAt: generationItems.lastDispatchedAt, leaseOwner: generationItems.leaseOwner }).from(generationItems).where(inArray(generationItems.runId, visibleRuns)).all()) {
      projectDispatch.set(item.projectId, Math.max(projectDispatch.get(item.projectId) ?? 0, item.lastDispatchedAt));
      if (item.leaseOwner && processAlive(item.leaseOwner)) busyProjects.set(item.projectId, (busyProjects.get(item.projectId) ?? 0) + 1);
    }
    const ordered = candidates.filter((item) => !item.leaseOwner || (!processAlive(item.leaseOwner) && (!item.leaseExpiresAt || item.leaseExpiresAt <= now)))
      .filter((item) => (busyProjects.get(item.projectId) ?? 0) < 2)
      .sort((a, b) => (projectDispatch.get(a.projectId) ?? 0) - (projectDispatch.get(b.projectId) ?? 0) || a.lastDispatchedAt - b.lastDispatchedAt || a.createdAt - b.createdAt);
    for (const item of ordered) {
      const run = tx.select().from(generationRuns).where(eq(generationRuns.id, item.runId)).get();
      if (!run || run.deletedAt !== null) continue;
      if (run?.cancelRequested && safelyUnsubmitted(item)) {
        tx.update(generationItems).set({ status: "cancelled", stage: "cancelled", leaseOwner: null, leaseExpiresAt: null, updatedAt: now }).where(eq(generationItems.id, item.id)).run();
        continue;
      }
      // Script/grid writes within a project serialize, while independent projects keep moving.
      if (["script", "storyboard_grid"].includes(item.kind) && candidates.some((other) => other.id !== item.id && other.projectId === item.projectId && ["script", "storyboard_grid"].includes(other.kind) && other.leaseOwner && processAlive(other.leaseOwner))) continue;
      const owner = `${process.pid}:${randomUUID()}`;
      const claimed = tx.update(generationItems).set({ status: "running", stage: item.checkpoint ? "recovering" : "starting", leaseOwner: owner, leaseExpiresAt: now + 90_000,
        attempts: item.attempts + 1, lastDispatchedAt: now, updatedAt: now }).where(eq(generationItems.id, item.id)).returning().get();
      return claimed ?? null;
    }
    return null;
  }, { behavior: "immediate" });
}

function redactError(error: unknown, payload?: GenerationPayload) {
  let message = error instanceof Error ? error.message : String(error);
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (/api.?key|token|secret|authorization/i.test(key) && typeof child === "string" && child.length > 3) message = message.split(child).join("[redacted]");
      else visit(child);
    }
  };
  visit(payload?.request);
  return message.replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]").slice(0, 2000);
}

async function executeClaimedItem(item: Item) {
  const db = getDb();
  const fence = and(eq(generationItems.id, item.id), eq(generationItems.leaseOwner, item.leaseOwner!),
    inArray(generationItems.runId, db.select({ id: generationRuns.id }).from(generationRuns).where(isNull(generationRuns.deletedAt))));
  let lost = false;
  let payload: GenerationPayload | undefined;
  let latestCheckpoint: Record<string, unknown> | null = null;
  const save = (checkpoint: Record<string, unknown>) => {
    if (lost || db.update(generationItems).set({ checkpoint: encryptGenerationValue(checkpoint),
      stage: String(checkpoint.stage ?? checkpoint.submissionState ?? "running"),
      status: checkpoint.stage === "importing" ? "importing" : "running",
      ...(typeof checkpoint.childJobId === "string" ? { result: { ...item.result, childJobId: checkpoint.childJobId } } : {}),
      updatedAt: Date.now() }).where(fence).run().changes !== 1) throw new Error("后台任务执行锁已失效。");
    latestCheckpoint = checkpoint;
  };
  const heartbeat = setInterval(() => {
    try { if (db.update(generationItems).set({ leaseExpiresAt: Date.now() + 90_000 }).where(fence).run().changes !== 1) lost = true; } catch { lost = true; }
  }, 15_000);
  heartbeat.unref();
  try {
    payload = decryptGenerationValue<GenerationPayload>(item.payload);
    const checkpoint = item.checkpoint ? decryptGenerationValue<Record<string, unknown>>(item.checkpoint) : null;
    latestCheckpoint = checkpoint;
    const result = await executeGenerationItem({ id: item.id, runId: item.runId, projectId: item.projectId, kind: item.kind as GenerationKind, scriptId: item.scriptId, shotId: item.shotId, payload, checkpoint }, save);
    if (lost) return;
    const pending = result.pending === true;
    const progress = pending ? { ...db.select({ result: generationItems.result }).from(generationItems).where(eq(generationItems.id, item.id)).get()?.result, ...result } : result;
    const completedCheckpoint = !pending && latestCheckpoint ? compactCompletedGenerationCheckpoint(item.projectId, latestCheckpoint, result) : null;
    db.update(generationItems).set({ status: pending ? "waiting" : "completed", stage: pending ? String(result.stage ?? "cloud_running") : "ready",
      ...(completedCheckpoint && completedCheckpoint !== latestCheckpoint ? { checkpoint: encryptGenerationValue(completedCheckpoint) } : {}),
      result: progress, error: null, errorCode: null, nextRunAt: Date.now() + Math.max(1000, Math.min(300_000, Number(result.retryAfterMs) || 5000)), updatedAt: Date.now() }).where(fence).run();
  } catch (error) {
    const coded = error as Error & { code?: string; retryable?: boolean };
    const cancelled = coded.code === "GENERATION_CANCELLED";
    const importFailed = coded.retryable && coded.code === "GENERATION_IMPORT_FAILED";
    // Dispatch attempts include successful cloud polls; only actual import errors consume this budget.
    const latest = !lost && importFailed ? db.select({ checkpoint: generationItems.checkpoint }).from(generationItems).where(fence).get() : undefined;
    const checkpoint = latest?.checkpoint ? decryptGenerationValue<Record<string, unknown>>(latest.checkpoint) : {};
    const previousFailures = typeof checkpoint.importFailures === "number" && Number.isSafeInteger(checkpoint.importFailures) && checkpoint.importFailures >= 0 ? checkpoint.importFailures : 0;
    const importFailures = previousFailures + 1;
    const exhaustedImport = importFailed && importFailures >= 6;
    if (!lost) db.update(generationItems).set({ status: cancelled ? "cancelled" : exhaustedImport ? "needs_attention" : coded.retryable ? "waiting" : coded.code === "GENERATION_NEEDS_ATTENTION" ? "needs_attention" : "failed",
      stage: cancelled ? "cancelled" : coded.retryable ? "retry_wait" : coded.code === "TIDEWE_VALIDATION_FAILED" ? "failed" : "needs_attention", error: cancelled ? null : redactError(error, payload), errorCode: cancelled ? null : coded.code ?? "GENERATION_FAILED",
      ...(importFailed ? { checkpoint: encryptGenerationValue({ ...checkpoint, importFailures }) } : {}),
      nextRunAt: Date.now() + Math.min(300_000, 5000 * 2 ** Math.min(importFailed ? importFailures : item.attempts, 6)), updatedAt: Date.now() }).where(fence).run();
  } finally {
    clearInterval(heartbeat);
    db.update(generationItems).set({ leaseOwner: null, leaseExpiresAt: null }).where(fence).run();
  }
}

export async function runGenerationTick(): Promise<void> {
  const state = runnerState();
  if (state.ticking || process.env.NEXT_PHASE === "phase-production-build") return;
  state.ticking = true;
  try {
    if (state.lastReconciledAt === undefined || Date.now() - state.lastReconciledAt >= 15_000) {
      reconcileStoppedGenerationItems();
      state.lastReconciledAt = Date.now();
    }
    while (state.active.size < 4) {
      const item = claimNextItem();
      if (!item) break;
      state.active.add(item.id);
      void executeClaimedItem(item).catch((error) => console.error("后台任务执行失败", error)).finally(() => { state.active.delete(item.id); });
    }
  } finally { state.ticking = false; }
}

/** Local child observation belongs to the runner, independent of whether anyone opens a task list. */
function reconcileStoppedGenerationItems(): void {
  const db = getDb();
  const visibleRuns = db.select({ id: generationRuns.id }).from(generationRuns).where(isNull(generationRuns.deletedAt));
  const candidates = db.select({ id: generationItems.id }).from(generationItems).where(and(
    inArray(generationItems.runId, visibleRuns), isNull(generationItems.leaseOwner), isNull(generationItems.leaseExpiresAt),
    or(and(eq(generationItems.kind, "video"), inArray(generationItems.status, ["needs_attention", "failed"])),
      and(eq(generationItems.kind, "script"), eq(generationItems.status, "needs_attention"), eq(generationItems.errorCode, "GENERATION_NEEDS_ATTENTION"))),
  )).all();
  if (!candidates.length) return;
  db.transaction((tx) => {
    const items = tx.select().from(generationItems).where(and(inArray(generationItems.id, candidates.map((item) => item.id)),
      isNull(generationItems.leaseOwner), isNull(generationItems.leaseExpiresAt), inArray(generationItems.status, ["needs_attention", "failed"]))).all();
    reconciledItems(tx, items);
  }, { behavior: "immediate" });
}

export function startGenerationRunner() {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const state = runnerState();
  if (state.timer) return;
  state.timer = setInterval(() => { void runGenerationTick().catch((error) => console.error("后台队列扫描失败", error)); }, 2000);
  state.timer.unref();
}
export function wakeGenerationRunner() { startGenerationRunner(); void runGenerationTick().catch((error) => console.error("后台队列启动失败", error)); }
export function stopGenerationRunner() { const state = runnerState(); if (state.timer) clearInterval(state.timer); state.timer = undefined; state.lastReconciledAt = undefined; }
