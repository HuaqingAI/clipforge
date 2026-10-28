import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { assets, characters, projects, scripts } from "@/lib/db/schema";
import { assetMatchesScript } from "@/lib/asset-context";
import { resolveCurrentScript } from "@/lib/current-script";
import { generationRuns, generationItems } from "@/lib/generation-schema";
import { klingProfiles } from "@/lib/kling/profile-schema";
import { decryptGenerationValue, encryptGenerationValue } from "@/lib/generation-secrets";
import { captureGenerationInputs } from "@/lib/generation-inputs";
import type { GenerationKind, GenerationPayload } from "@/lib/generation-types";
import { executeGenerationItem } from "@/lib/generation-executor";
import { checkKeyframeRefinementContext } from "@/lib/keyframe-refinement-context";
import { isPremiumProductCgProfile, isTideweOutdoorProfile } from "@/lib/creative-profiles";
import { tidewePresenterReference } from "@/lib/tidewe/presenter";
import { resolveCharacterReferenceModel } from "@/lib/character-reference-model";
import { KEYFRAME_REPAIR_ISSUES } from "@/lib/keyframe-refinement";

const ACTIVE = ["queued", "running", "waiting", "importing"];
const RUN_KINDS = ["video_batch", "video", "image", "script", "storyboard_grid", "keyframe_refine", "keyframe_refine_batch"];
const ITEM_KINDS = ["video", "image", "script", "storyboard_grid", "keyframe_refine"];
type Item = typeof generationItems.$inferSelect;

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
    createdAt: new Date(run.createdAt).toISOString(), updatedAt: new Date(Math.max(run.updatedAt, ...items.map((i) => i.updatedAt))).toISOString(),
    items: items.map((item) => ({ id: item.id, kind: item.kind, scriptId: item.scriptId, shotId: item.shotId, status: item.status,
      stage: item.stage, result: publicResult(item.result), error: item.error, errorCode: item.errorCode,
      createdAt: new Date(item.createdAt).toISOString(), updatedAt: new Date(item.updatedAt).toISOString() })) };
}

function publicResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicResult);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !/api.?key|authorization|credential|secret|token|snapshot|request|checkpoint/i.test(key)).map(([key, val]) => [key, publicResult(val)]));
  return value;
}

function hasRecoverableResult(checkpoint: Record<string, unknown>): boolean {
  return Boolean(checkpoint.taskId || checkpoint.remoteTaskId || checkpoint.childJobId || checkpoint.result || checkpoint.resultUrls || checkpoint.response || checkpoint.videoUrl || checkpoint.imageUrl
    || (Array.isArray(checkpoint.generatedScripts) && checkpoint.generatedScripts.length));
}

function safelyUnsubmitted(item: Item): boolean {
  if (!item.checkpoint) return true;
  const checkpoint = decryptGenerationValue<Record<string, unknown>>(item.checkpoint);
  return checkpoint.submissionState === "not_submitted" && !hasRecoverableResult(checkpoint);
}

export function getGenerationRun(id: string) {
  const db = getDb();
  const run = db.select().from(generationRuns).where(eq(generationRuns.id, id)).get();
  if (!run) throw new GenerationRunError("任务批次不存在。", 404, "GENERATION_RUN_NOT_FOUND");
  return runView(run, db.select().from(generationItems).where(eq(generationItems.runId, id)).orderBy(asc(generationItems.createdAt), asc(generationItems.id)).all());
}

export function listGenerationRuns(projectId?: string) {
  const db = getDb();
  const runs = db.select().from(generationRuns).where(projectId ? eq(generationRuns.projectId, projectId) : undefined).orderBy(desc(generationRuns.createdAt)).all();
  if (!runs.length) return [];
  const items = db.select().from(generationItems).where(inArray(generationItems.runId, runs.map((r) => r.id))).orderBy(asc(generationItems.createdAt), asc(generationItems.id)).all();
  const grouped = new Map<string, Item[]>();
  for (const item of items) { const group = grouped.get(item.runId) ?? []; group.push(item); grouped.set(item.runId, group); }
  return runs.map((run) => runView(run, grouped.get(run.id) ?? []));
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
        inArray(generationItems.status, [...ACTIVE, "needs_attention"]))).get();
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
        if (request.resolution !== "2k" && request.resolution !== "4k") throw new GenerationRunError("请选择 2K 或 4K 精修分辨率。");
        const issues = new Set<string>(KEYFRAME_REPAIR_ISSUES.map((issue) => issue.id));
        if (!Array.isArray(request.issues) || !request.issues.every((issue) => typeof issue === "string" && issues.has(issue))) throw new GenerationRunError("精修项目无效，请重新选择。");
        if ((request.instructions !== undefined && typeof request.instructions !== "string") || (typeof request.instructions === "string" && request.instructions.length > 2000)
          || (!request.issues.length && !(typeof request.instructions === "string" && request.instructions.trim()))) throw new GenerationRunError("请选择精修项目或填写有效的修复说明（最多 2000 字）。");
        if (typeof request.provider !== "string" || typeof request.model !== "string" || typeof request.apiKey !== "string" || !request.apiKey.trim()) throw new GenerationRunError("请配置图片精修平台、模型与 API Key。");
        const context = checkKeyframeRefinementContext(project, script);
        if (!context.ok) throw new GenerationRunError("创作设置或商品事实已变化，请先按当前配置生成脚本再精修。", 409, context.code);
        const shot = script.shots!.find((item) => item.shotId === shotId)!;
        const profile = context.scriptProfile;
        const tidewe = isTideweOutdoorProfile(profile), premiumCg = isPremiumProductCgProfile(profile);
        let presenterReference = tidewe && shot.tidewe?.personVisible !== false ? tidewePresenterReference(profile) : undefined;
        if (!tidewe && !premiumCg) {
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

export function generationRunAction(id: string, action: string) {
  getGenerationRun(id);
  const db = getDb();
  db.transaction((tx) => {
    if (action === "cancel") {
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
        tx.update(generationItems).set({ status: "waiting", stage: "recovering", error: null, errorCode: null, nextRunAt: Date.now(), updatedAt: Date.now() }).where(eq(generationItems.id, item.id)).run();
        eligible++;
      }
      if (!eligible) throw new GenerationRunError("没有可安全恢复的已受理结果；提交结果不明确时，请先核对原平台任务，避免重复扣费。", 409, "GENERATION_RECOVERY_UNSAFE");
    } else throw new GenerationRunError("不支持此任务操作。");
  }, { behavior: "immediate" });
  wakeGenerationRunner();
  return getGenerationRun(id);
}

interface RunnerState { timer?: ReturnType<typeof setInterval>; ticking: boolean; active: Set<string> }
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
    const candidates = tx.select().from(generationItems).where(and(inArray(generationItems.status, ACTIVE), lte(generationItems.nextRunAt, now))).all();
    const busyProjects = new Map<string, number>();
    const projectDispatch = new Map<string, number>();
    for (const item of tx.select().from(generationItems).all()) {
      projectDispatch.set(item.projectId, Math.max(projectDispatch.get(item.projectId) ?? 0, item.lastDispatchedAt));
      if (item.leaseOwner && processAlive(item.leaseOwner)) busyProjects.set(item.projectId, (busyProjects.get(item.projectId) ?? 0) + 1);
    }
    const ordered = candidates.filter((item) => !item.leaseOwner || (!processAlive(item.leaseOwner) && (!item.leaseExpiresAt || item.leaseExpiresAt <= now)))
      .filter((item) => (busyProjects.get(item.projectId) ?? 0) < 2)
      .sort((a, b) => (projectDispatch.get(a.projectId) ?? 0) - (projectDispatch.get(b.projectId) ?? 0) || a.lastDispatchedAt - b.lastDispatchedAt || a.createdAt - b.createdAt);
    for (const item of ordered) {
      const run = tx.select().from(generationRuns).where(eq(generationRuns.id, item.runId)).get();
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
  const fence = and(eq(generationItems.id, item.id), eq(generationItems.leaseOwner, item.leaseOwner!));
  let lost = false;
  let payload: GenerationPayload | undefined;
  const save = (checkpoint: Record<string, unknown>) => {
    if (lost || db.update(generationItems).set({ checkpoint: encryptGenerationValue(checkpoint),
      stage: String(checkpoint.stage ?? checkpoint.submissionState ?? "running"),
      status: checkpoint.stage === "importing" ? "importing" : "running",
      ...(typeof checkpoint.childJobId === "string" ? { result: { ...item.result, childJobId: checkpoint.childJobId } } : {}),
      updatedAt: Date.now() }).where(fence).run().changes !== 1) throw new Error("后台任务执行锁已失效。");
  };
  const heartbeat = setInterval(() => {
    try { if (db.update(generationItems).set({ leaseExpiresAt: Date.now() + 90_000 }).where(fence).run().changes !== 1) lost = true; } catch { lost = true; }
  }, 15_000);
  heartbeat.unref();
  try {
    payload = decryptGenerationValue<GenerationPayload>(item.payload);
    const checkpoint = item.checkpoint ? decryptGenerationValue<Record<string, unknown>>(item.checkpoint) : null;
    const result = await executeGenerationItem({ id: item.id, runId: item.runId, projectId: item.projectId, kind: item.kind as GenerationKind, scriptId: item.scriptId, shotId: item.shotId, payload, checkpoint }, save);
    if (lost) return;
    const pending = result.pending === true;
    const progress = pending ? { ...db.select({ result: generationItems.result }).from(generationItems).where(eq(generationItems.id, item.id)).get()?.result, ...result } : result;
    db.update(generationItems).set({ status: pending ? "waiting" : "completed", stage: pending ? String(result.stage ?? "cloud_running") : "ready",
      result: progress, error: null, errorCode: null, nextRunAt: Date.now() + Math.max(1000, Math.min(300_000, Number(result.retryAfterMs) || 5000)), updatedAt: Date.now() }).where(fence).run();
  } catch (error) {
    const coded = error as Error & { code?: string; retryable?: boolean };
    const cancelled = coded.code === "GENERATION_CANCELLED";
    const exhaustedImport = coded.retryable && coded.code === "GENERATION_IMPORT_FAILED" && item.attempts >= 6;
    if (!lost) db.update(generationItems).set({ status: cancelled ? "cancelled" : exhaustedImport ? "needs_attention" : coded.retryable ? "waiting" : coded.code === "GENERATION_NEEDS_ATTENTION" ? "needs_attention" : "failed",
      stage: cancelled ? "cancelled" : coded.retryable ? "retry_wait" : "needs_attention", error: cancelled ? null : redactError(error, payload), errorCode: cancelled ? null : coded.code ?? "GENERATION_FAILED",
      nextRunAt: Date.now() + Math.min(300_000, 5000 * 2 ** Math.min(item.attempts, 6)), updatedAt: Date.now() }).where(fence).run();
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
    while (state.active.size < 4) {
      const item = claimNextItem();
      if (!item) break;
      state.active.add(item.id);
      void executeClaimedItem(item).catch((error) => console.error("后台任务执行失败", error)).finally(() => { state.active.delete(item.id); });
    }
  } finally { state.ticking = false; }
}

export function startGenerationRunner() {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const state = runnerState();
  if (state.timer) return;
  state.timer = setInterval(() => { void runGenerationTick().catch((error) => console.error("后台队列扫描失败", error)); }, 2000);
  state.timer.unref();
}
export function wakeGenerationRunner() { startGenerationRunner(); void runGenerationTick().catch((error) => console.error("后台队列启动失败", error)); }
export function stopGenerationRunner() { const state = runnerState(); if (state.timer) clearInterval(state.timer); state.timer = undefined; }
