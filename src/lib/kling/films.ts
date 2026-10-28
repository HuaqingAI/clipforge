import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { assets, scripts } from "@/lib/db/schema";
import { filterAssetsForScript } from "@/lib/asset-context";
import type { KlingFilmRun } from "./film-schema";
import { KlingError } from "./errors";
import { record } from "./protocol";
import { refreshProfile } from "./auth";
import { createKlingFilmShotJob, dispatchKlingFilmShotJob, queryKlingJob, startKlingJobRunner, wakeKlingJobRunner } from "./jobs";
import { getKlingJob, getKlingOutputs, listKlingJobs, isKlingJobUnresolved } from "./repository";
import { getKlingFilm, getKlingFilmShots, patchKlingFilm, patchKlingFilmShot, listKlingFilms, isKlingFilmUnresolved,
  klingFilmView, withKlingFilmLease, assertKlingFilmLease, withoutKlingFilmLease, canRetryKlingFilmShot } from "./film-repository";
import { assertKlingFilmContext, verifyKlingFilmFiles, buildFilmShotJobRequest } from "./film-plan";
import { composeKlingFilm } from "./film-compose";
import type { KlingFilmView } from "./film-types";
import { klingJobOccupiesGenerationSlot } from "./concurrency";
import { isKlingRuntimeEnabled } from "./runtime";

interface FilmRuntime { bootId: string; busy: boolean; timer?: ReturnType<typeof setInterval>; }
const globalState = globalThis as unknown as { __clipforgeKlingFilms?: FilmRuntime };
const runtime = globalState.__clipforgeKlingFilms ??= { bootId: randomUUID(), busy: false };
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const AUTH_TTL = 24 * 60 * 60 * 1000;

function assertEnabled(): void {
  if (!isKlingRuntimeEnabled()) throw new KlingError("KLING_SCOPE_UNSUPPORTED", "Kling 整片编排仅支持本机网页版", 503);
}
function assertConfirmation(body: Record<string, unknown>, run: KlingFilmRun): void {
  if (body.explicitConfirmation !== true || body.planHash !== run.data.planHash) throw new KlingError("KLING_FILM_CONFIRMATION_REQUIRED", "请核对原整片计划并明确确认后继续", 422);
  const acknowledgement = record(body.billingAcknowledgement);
  if (acknowledgement.policyRevision !== "film-credits-v1" || acknowledgement.acceptedForPlanHash !== run.data.planHash) throw new KlingError("KLING_BILLING_ACK_REQUIRED", "请确认按原整片计划继续提交的视频会使用 Kling 账号积分", 422);
}
function authorization(run: KlingFilmRun): void {
  assertKlingFilmLease(run.id);
  const current = getKlingFilm(run.id);
  if (current.status !== "running" || current.data.authorizationBootId !== runtime.bootId || current.data.authorizationEpoch !== run.data.authorizationEpoch || (current.data.authorizedUntil ?? 0) <= Date.now()) {
    throw new KlingError("KLING_FILM_AUTHORIZATION_REVOKED", "整片已暂停、授权过期或服务已重启，请恢复原任务", 409);
  }
}
function assertRenderAllowed(run: KlingFilmRun): void {
  assertKlingFilmLease(run.id);
  const current = getKlingFilm(run.id);
  if (current.status !== "composing" || current.data.authorizationEpoch !== run.data.authorizationEpoch) throw new KlingError("KLING_FILM_AUTHORIZATION_REVOKED", "整片已暂停，停止发布合成结果", 409);
  assertKlingFilmContext(run.id);
}
async function checkProfile(run: KlingFilmRun): Promise<void> {
  const profile = await refreshProfile(run.profileId, undefined, { credits: false });
  if (profile.disabledAt || profile.environmentState !== "ready" || profile.authState !== "authenticated" || profile.principalKey !== run.principalKey) throw new KlingError("KLING_ACCOUNT_MISMATCH", "请登录原 Kling 账号并检测 CLI 环境后恢复整片", 409);
  const model = profile.catalogSnapshot.find((item) => item.selectionKey === run.data.model.selectionKey);
  if (!model || model.catalogRevision !== run.data.model.catalogRevision) throw new KlingError("KLING_CATALOG_CHANGED", "模型目录已变化，请保留已生成视频并重新预览整片计划", 409);
}
function assertNoConflict(run: KlingFilmRun): void {
  const conflict = listKlingFilms().find((row) => row.id !== run.id && isKlingFilmUnresolved(row) && (row.projectId === run.projectId || row.principalKey === run.principalKey));
  if (conflict) throw new KlingError("KLING_FILM_CONFLICT", "已有未完成整片，请先恢复或取消原任务：" + conflict.id, 409);
  const job = listKlingJobs().find((row) => row.principalKey === run.principalKey && isKlingJobUnresolved(row) && row.data.filmRunId !== run.id);
  if (job) {
    const error = new KlingError("KLING_REQUEST_CONFLICT", "原 Kling 任务尚未处理，请先恢复：" + job.id, 409);
    Object.assign(error, { jobId: job.id }); throw error;
  }
}
function authorizeRun(run: KlingFilmRun, status: "running" | "composing" = "running"): KlingFilmRun {
  return patchKlingFilm(run.id, { status }, { authorizationBootId: runtime.bootId, authorizationEpoch: run.data.authorizationEpoch + 1,
    authorizedUntil: Date.now() + AUTH_TTL, error: undefined, stage: status === "composing" ? "正在合成" : "等待生成镜头" });
}
function needsAttention(run: KlingFilmRun, message: string, shotId?: string): void {
  // A pause/cancel/resume performed during an await takes precedence over this worker.
  const current = getKlingFilm(run.id);
  if (!["running", "composing"].includes(current.status) || current.data.authorizationEpoch !== run.data.authorizationEpoch) return;
  if (shotId) patchKlingFilmShot(shotId, { status: "needs_attention" }, { error: message });
  patchKlingFilm(run.id, { status: "needs_attention" }, { error: message, stage: "需要处理", authorizedUntil: undefined });
}

/** Reconcile only acknowledged, already-imported results. This never generates or changes asset selection. */
function reconcileShots(run: KlingFilmRun, dispatchingShotId?: string): void {
  const db = getDb();
  const script = db.select().from(scripts).where(eq(scripts.id, run.scriptId)).get();
  for (const shot of getKlingFilmShots(run.id)) {
    if (!shot.jobId || shot.status === "ready" || shot.id === dispatchingShotId) continue;
    const job = getKlingJob(shot.jobId);
    if (job.data.filmRunId !== run.id || job.data.filmShotId !== shot.id) throw new KlingError("KLING_FILM_CONTEXT_INVALID", "镜头与原整片任务关联不一致", 409);
    const outputs = getKlingOutputs(job.id).filter((output) => output.importState === "imported" && output.assetId);
    if (outputs.length) {
      const selected = script ? filterAssetsForScript(db.select().from(assets).where(and(eq(assets.projectId, run.projectId), eq(assets.shotId, shot.shotId), eq(assets.selected, true))).all(), script)[0] : undefined;
      const output = outputs.find((item) => item.assetId === selected?.id);
      if (output && selected?.filePath) {
        patchKlingFilmShot(shot.id, { status: "ready", assetId: selected.id }, { videoUrl: selected.filePath,
          sourceFilePath: output.data.localPath, sourceFileHash: output.data.contentHash, error: undefined });
      } else {
        patchKlingFilmShot(shot.id, { status: "needs_attention" }, { error: "视频已入库为备选。当前素材已改变，请先在素材页选用原任务视频，再恢复整片。" });
      }
      continue;
    }
    if (job.submissionState === "submission_unknown" || job.submissionState === "submitting") {
      patchKlingFilmShot(shot.id, { status: "needs_attention" }, { error: "提交结果不明，请打开原任务查询或核对绑定平台编号，避免重复计费。" });
    } else if (job.remoteState === "failed" || job.remoteState === "cancelled" || job.submissionState === "not_submitted") {
      patchKlingFilmShot(shot.id, { status: "needs_attention" }, { error: job.data.error?.message ?? "原镜头任务未成功，请查看任务详情。" });
    } else if (job.submissionState === "prepared" && !job.needsConfirmation && !job.data.blockedReason &&
        job.data.error?.code === "KLING_PROFILE_BUSY") {
      patchKlingFilmShot(shot.id, { status: "generating" }, { error: undefined });
    } else if ((job.submissionState !== "prepared" || run.data.authorizationEpoch <= (job.data.filmAuthorizationEpoch ?? 0)) &&
      (job.data.blockedReason || job.data.error || job.needsConfirmation || job.importState === "failed" || job.importState === "partial")) {
      patchKlingFilmShot(shot.id, { status: "needs_attention" }, { error: job.data.error?.message ?? "原任务需要处理，请查询原任务或重新保存视频后恢复整片。" });
    } else patchKlingFilmShot(shot.id, { status: "generating" }, { error: undefined });
  }
}

export async function startKlingFilm(raw: unknown): Promise<KlingFilmView> {
  assertEnabled();
  const body = record(raw);
  if (typeof body.planId !== "string" || !ID.test(body.planId) || typeof body.clientRequestId !== "string" || !ID.test(body.clientRequestId)) throw new KlingError("KLING_INPUT_INVALID", "整片计划或请求编号无效", 400);
  let run = getKlingFilm(body.planId);
  assertConfirmation(body, run);
  const ack = record(body.billingAcknowledgement);
  if (ack.policyRevision !== "film-credits-v1" || ack.acceptedForPlanHash !== run.data.planHash) throw new KlingError("KLING_BILLING_ACK_REQUIRED", "请确认整片中新生成镜头会使用 Kling 账号积分", 422);
  if (run.clientRequestId) {
    if (run.clientRequestId !== body.clientRequestId) throw new KlingError("KLING_REQUEST_CONFLICT", "此整片计划已启动，请恢复原任务", 409);
    startKlingFilmRunner(); wakeKlingFilmRunner(); return klingFilmView(run);
  }
  if (run.status !== "draft" || run.data.expiresAt <= Date.now()) throw new KlingError("KLING_FILM_PLAN_EXPIRED", "预览计划已过期，请重新预览后确认", 409);
  if (getKlingFilmShots(run.id).some((shot) => shot.data.missingKeyframe)) throw new KlingError("KLING_FILM_KEYFRAMES_REQUIRED", "请先补齐所有待生成镜头的关键帧，再重新预览", 422);
  await checkProfile(run);
  await verifyKlingFilmFiles(run.id);
  run = getDb().transaction(() => {
    const current = getKlingFilm(run.id);
    if (current.clientRequestId) {
      if (current.clientRequestId !== body.clientRequestId) throw new KlingError("KLING_REQUEST_CONFLICT", "原计划已启动", 409);
      return current;
    }
    if (current.status !== "draft" || current.data.expiresAt <= Date.now()) throw new KlingError("KLING_FILM_PLAN_EXPIRED", "计划已失效，请重新预览", 409);
    const duplicate = listKlingFilms().find((row) => row.profileId === run.profileId && row.clientRequestId === body.clientRequestId && row.id !== run.id);
    if (duplicate) throw new KlingError("KLING_REQUEST_CONFLICT", "请求编号已用于另一整片计划", 409);
    assertKlingFilmContext(run.id); assertNoConflict(current);
    patchKlingFilm(run.id, { clientRequestId: body.clientRequestId as string });
    return authorizeRun(getKlingFilm(run.id));
  });
  startKlingFilmRunner(); wakeKlingFilmRunner(); return klingFilmView(run);
}

export async function klingFilmAction(id: string, action: string, raw: unknown): Promise<KlingFilmView> {
  assertEnabled();
  const body = record(raw);
  let run = getKlingFilm(id);
  if (action === "pause" || action === "cancel") {
    return withoutKlingFilmLease(() => getDb().transaction(() => {
      const current = getKlingFilm(id);
      if (["completed", "cancelled"].includes(current.status)) return klingFilmView(current);
      return klingFilmView(patchKlingFilm(id, { status: action === "pause" ? "paused" : "cancelled" }, {
        authorizationEpoch: current.data.authorizationEpoch + 1, authorizedUntil: undefined,
        stage: action === "pause" ? "已暂停；云端任务仍可恢复" : "编排已取消；已提交的云端任务仍可查询入库",
      }));
    }));
  }
  if (!["resume", "retry-shot", "retry-compose"].includes(action)) throw new KlingError("KLING_ACTION_UNSUPPORTED", "不支持此整片操作", 400);
  if (!["paused", "needs_attention"].includes(run.status)) throw new KlingError("KLING_FILM_STATE_INVALID", "请先等待、暂停或查看当前整片状态", 409);
  if (action !== "retry-compose") assertConfirmation(body, run);
  return withKlingFilmLease(id, async () => {
    run = getKlingFilm(id);
    if (!["paused", "needs_attention"].includes(run.status)) throw new KlingError("KLING_FILM_STATE_INVALID", "整片状态已变化，请刷新后重试", 409);
    const epoch = run.data.authorizationEpoch;
    reconcileShots(run);
    if (action !== "retry-compose") await checkProfile(run);
    await verifyKlingFilmFiles(id);
    // Read-only checks above may yield; a concurrent pause/cancel must revoke the pending action.
    if (getKlingFilm(id).data.authorizationEpoch !== epoch || !["paused", "needs_attention"].includes(getKlingFilm(id).status)) throw new KlingError("KLING_FILM_AUTHORIZATION_REVOKED", "整片状态已变化，请刷新后恢复", 409);
    assertKlingFilmContext(id); assertNoConflict(run);
    if (action === "retry-shot") {
      const shot = getKlingFilmShots(id).find((item) => item.shotId === body.shotId);
      if (!shot || !canRetryKlingFilmShot(shot)) throw new KlingError("KLING_FILM_RETRY_UNSAFE", "此镜头不能重新生成，请查询或恢复原任务，避免重复计费", 409);
      patchKlingFilmShot(shot.id, { status: "waiting", jobId: null, assetId: null }, { attempt: shot.data.attempt + 1, error: undefined });
    } else if (action === "retry-compose" && getKlingFilmShots(id).some((shot) => shot.status !== "ready")) {
      throw new KlingError("KLING_FILM_NOT_READY", "所有镜头视频入库后才能重试合成", 409);
    } else if (action === "resume") {
      // Resume queries the original known job after authentication; never retry a definite failure here.
      for (const shot of getKlingFilmShots(id)) {
        if (!shot.jobId || shot.status === "ready") continue;
        const job = getKlingJob(shot.jobId);
        if (job.remoteGenerationId && !["completed", "failed", "cancelled"].includes(job.remoteState) && (job.data.blockedReason || job.autoQueryPaused)) await queryKlingJob(job.id);
      }
      reconcileShots(run);
      const blocked = getKlingFilmShots(id).find((shot) => shot.status === "needs_attention" && (!shot.jobId || getKlingJob(shot.jobId).submissionState !== "prepared"));
      if (blocked) throw new KlingError("KLING_FILM_NEEDS_ATTENTION", blocked.data.error ?? "请先处理原镜头任务，再恢复整片", 409);
    }
    if (getKlingFilm(id).data.authorizationEpoch !== epoch || !["paused", "needs_attention"].includes(getKlingFilm(id).status)) throw new KlingError("KLING_FILM_AUTHORIZATION_REVOKED", "整片状态已变化，请刷新后恢复", 409);
    if (action === "retry-compose" && !getKlingFilm(id).data.compositionId) patchKlingFilm(id, {}, { compositionId: randomUUID() });
    const result = authorizeRun(getKlingFilm(id), action === "retry-compose" ? "composing" : "running");
    startKlingFilmRunner(); wakeKlingFilmRunner(); return klingFilmView(result);
  });
}

async function processFilm(id: string): Promise<void> {
  await withKlingFilmLease(id, async () => {
    let run = getKlingFilm(id);
    if (!["running", "composing"].includes(run.status)) return;
    if (run.data.authorizationBootId !== runtime.bootId || (run.data.authorizedUntil ?? 0) <= Date.now()) {
      patchKlingFilm(id, { status: "paused" }, { stage: "服务重启或授权过期，请确认恢复原整片", authorizedUntil: undefined, authorizationEpoch: run.data.authorizationEpoch + 1 }); return;
    }
    try {
      reconcileShots(run);
      assertKlingFilmContext(id);
      const shots = getKlingFilmShots(id);
      const blocked = shots.find((shot) => shot.status === "needs_attention");
      if (blocked) { needsAttention(run, blocked.data.error ?? "镜头需要处理", blocked.id); return; }
      const pending = shots.filter((shot) => shot.status !== "ready");
      if (pending.length) {
        if (run.status !== "running") throw new KlingError("KLING_FILM_NOT_READY", "镜头未全部入库，不能合成", 409);
        // CLI submissions stay serialized; acknowledged cloud jobs may generate concurrently.
        for (const next of pending) {
          authorization(run);
          reconcileShots(run);
          const blocked = getKlingFilmShots(id).find((shot) => shot.status === "needs_attention");
          if (blocked) { needsAttention(run, blocked.data.error ?? "请处理原任务", blocked.id); return; }
          if (next.jobId) {
            const job = getKlingJob(next.jobId);
            if (job.submissionState !== "prepared") continue; // The job runner polls/imports every acknowledged task.
          } else {
            await verifyKlingFilmFiles(id);
            authorization(run); assertKlingFilmContext(id);
            const context = { filmRunId: id, filmShotId: next.id, authorizationEpoch: run.data.authorizationEpoch,
              expectedInputHashes: next.data.inputs.map(({ role, hash }) => ({ role, hash })) };
            const job = await createKlingFilmShotJob(buildFilmShotJobRequest(run, next), context);
            // Link before dispatch. Deterministic clientRequestId recovers an interrupted prepared job.
            patchKlingFilmShot(next.id, { jobId: job.id, status: "generating" }, { error: undefined });
          }
          const linked = getKlingFilmShots(id).find((shot) => shot.id === next.id)!;
          authorization(run);
          await dispatchKlingFilmShotJob(linked.jobId!, {
            filmRunId: id, filmShotId: next.id, authorizationEpoch: run.data.authorizationEpoch,
            expectedInputHashes: next.data.inputs.map(({ role, hash }) => ({ role, hash })),
            assertDispatchAllowed() {
              authorization(run); assertKlingFilmContext(id);
              // Recheck all siblings immediately before the durable paid-dispatch claim.
              reconcileShots(run, next.id);
              const currentShots = getKlingFilmShots(id);
              const blocked = currentShots.find((shot) => shot.status === "needs_attention");
              if (blocked) throw new KlingError("KLING_FILM_NEEDS_ATTENTION", blocked.data.error ?? "请先处理原镜头任务", 409);
              const current = currentShots.find((shot) => shot.id === next.id);
              if (current?.jobId !== linked.jobId || current.status === "ready") throw new KlingError("KLING_FILM_CONTEXT_INVALID", "镜头关联已变化，停止派发", 409);
            },
          });
        }
        authorization(run);
        reconcileShots(run);
        const currentShots = getKlingFilmShots(id);
        const blocked = currentShots.find((shot) => shot.status === "needs_attention");
        if (blocked) { needsAttention(run, blocked.data.error ?? "请处理原任务", blocked.id); return; }
        const active = currentShots.filter((shot) => shot.jobId && klingJobOccupiesGenerationSlot(getKlingJob(shot.jobId))).length;
        patchKlingFilm(id, {}, { stage: `正在生成镜头（${active} 个进行中；${currentShots.filter((shot) => shot.status === "ready").length}/${shots.length} 已就绪）` });
        return;
      }
      await verifyKlingFilmFiles(id);
      if (run.status === "running") {
        authorization(run);
        run = patchKlingFilm(id, { status: "composing" }, { stage: "正在配音、加字幕并合成", compositionId: run.data.compositionId ?? randomUUID() });
      }
      assertRenderAllowed(run);
      const result = await composeKlingFilm(id, { assertOwned: () => assertKlingFilmLease(id), beforeRender: () => assertRenderAllowed(run) });
      assertRenderAllowed(run);
      patchKlingFilm(id, { status: "completed" }, { stage: "整片已完成", error: undefined, authorizedUntil: undefined,
        compositionId: result.compositionId, videoUrl: result.url, thumbnailUrl: result.thumbnailUrl, quality: result.quality });
    } catch (error) {
      if (error instanceof KlingError && ["KLING_FILM_LEASE_LOST", "KLING_FILM_AUTHORIZATION_REVOKED"].includes(error.code)) return;
        if (error instanceof KlingError && error.code === "KLING_PROFILE_BUSY") return;
      needsAttention(run, error instanceof KlingError ? error.message : "整片编排失败，请查看原任务并恢复；已成功镜头会保留");
    }
  });
}
export async function runKlingFilmTick(): Promise<void> {
  if (runtime.busy || !isKlingRuntimeEnabled()) return;
  runtime.busy = true;
  try {
    for (const run of listKlingFilms().filter((row) => ["running", "composing"].includes(row.status))) {
      try { await processFilm(run.id); } catch { /* A competing worker owns this run; persisted state remains recoverable. */ }
    }
  } finally { runtime.busy = false; }
}
export function startKlingFilmRunner(): void {
  if (runtime.timer || process.env.NEXT_PHASE === "phase-production-build" || !isKlingRuntimeEnabled()) return;
  startKlingJobRunner();
  runtime.timer = setInterval(() => { void withoutKlingFilmLease(() => runKlingFilmTick()).catch(() => {}); }, 5000); runtime.timer.unref();
}
export function wakeKlingFilmRunner(): void {
  if (process.env.NEXT_PHASE === "phase-production-build" || !isKlingRuntimeEnabled()) return;
  wakeKlingJobRunner();
  setImmediate(() => { void withoutKlingFilmLease(() => runKlingFilmTick()).catch(() => {}); });
}
export function stopKlingFilmRunner(): void { if (runtime.timer) clearInterval(runtime.timer); runtime.timer = undefined; }
