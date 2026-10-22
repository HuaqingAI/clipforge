import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, desc, asc } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { klingFilmRuns, klingFilmShots, type KlingFilmRun, type KlingFilmShot, type KlingFilmData, type KlingFilmShotData } from "./film-schema";
import { getKlingJob } from "./repository";
import { KlingError } from "./errors";
import type { KlingFilmView } from "./film-types";

const leases = new AsyncLocalStorage<Map<string, { owner: string; lost: boolean }>>();
export function withoutKlingFilmLease<T>(run: () => T): T { return leases.run(new Map(), run); }
function processAlive(owner: string): boolean {
  const pid = Number(owner.split(":")[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
export function getKlingFilm(id: string): KlingFilmRun {
  const row = getDb().select().from(klingFilmRuns).where(eq(klingFilmRuns.id, id)).get();
  if (!row) throw new KlingError("KLING_FILM_NOT_FOUND", "整片任务不存在", 404);
  return row;
}
export function getKlingFilmShots(runId: string): KlingFilmShot[] {
  return getDb().select().from(klingFilmShots).where(eq(klingFilmShots.runId, runId)).orderBy(asc(klingFilmShots.ordinal)).all();
}
export function assertKlingFilmLease(id: string): void {
  const context = leases.getStore()?.get(id);
  if (!context) return;
  const row = getKlingFilm(id);
  if (context.lost || row.leaseOwner !== context.owner || !row.leaseExpiresAt || row.leaseExpiresAt <= Date.now()) throw new KlingError("KLING_FILM_LEASE_LOST", "整片执行锁已失效，请恢复原任务", 409);
}
export function patchKlingFilm(id: string, patch: Partial<Omit<KlingFilmRun, "id" | "data">>, data: Partial<KlingFilmData> = {}): KlingFilmRun {
  return getDb().transaction((tx) => {
    assertKlingFilmLease(id);
    const row = getKlingFilm(id);
    return tx.update(klingFilmRuns).set({ ...patch, data: { ...row.data, ...data }, updatedAt: Date.now() }).where(eq(klingFilmRuns.id, id)).returning().get()!;
  });
}
export function patchKlingFilmShot(id: string, patch: Partial<Omit<KlingFilmShot, "id" | "data">>, data: Partial<KlingFilmShotData> = {}): KlingFilmShot {
  return getDb().transaction((tx) => {
    const row = tx.select().from(klingFilmShots).where(eq(klingFilmShots.id, id)).get();
    if (!row) throw new KlingError("KLING_FILM_SHOT_NOT_FOUND", "整片镜头不存在", 404);
    assertKlingFilmLease(row.runId);
    return tx.update(klingFilmShots).set({ ...patch, data: { ...row.data, ...data }, updatedAt: Date.now() }).where(eq(klingFilmShots.id, id)).returning().get()!;
  });
}
export function listKlingFilms(projectId?: string): KlingFilmRun[] {
  return getDb().select().from(klingFilmRuns).where(projectId ? eq(klingFilmRuns.projectId, projectId) : undefined).orderBy(desc(klingFilmRuns.createdAt)).all();
}
export function isKlingFilmUnresolved(run: KlingFilmRun): boolean { return !["draft", "completed", "cancelled"].includes(run.status); }
export function canDeleteKlingFilm(run: KlingFilmRun): boolean {
  if (!["draft", "completed", "cancelled"].includes(run.status)) return false;
  return !run.leaseOwner || !((run.leaseExpiresAt ?? 0) > Date.now() || processAlive(run.leaseOwner));
}
export function canRetryKlingFilmShot(shot: KlingFilmShot): boolean {
  if (!shot.jobId || shot.status !== "needs_attention") return false;
  try {
    const job = getKlingJob(shot.jobId);
    return job.remoteState === "failed" || job.submissionState === "not_submitted";
  } catch (error) {
    if (error instanceof KlingError && ["KLING_JOB_DELETED", "KLING_JOB_NOT_FOUND"].includes(error.code)) return false;
    throw error;
  }
}
export function klingFilmView(run: KlingFilmRun): KlingFilmView {
  const shots = getKlingFilmShots(run.id);
  const actions: string[] = [];
  if (run.status === "draft") actions.push("start");
  if (["running", "composing"].includes(run.status)) actions.push("pause");
  if (["paused", "needs_attention"].includes(run.status)) actions.push("resume");
  if (["paused", "needs_attention"].includes(run.status) && shots.some(canRetryKlingFilmShot)) actions.push("retry-shot");
  if (["paused", "needs_attention"].includes(run.status) && shots.length && shots.every((shot) => shot.status === "ready")) actions.push("retry-compose");
  if (!["cancelled", "completed"].includes(run.status)) actions.push("cancel");
  if (canDeleteKlingFilm(run)) actions.push("delete");
  return {
    runId: run.id, projectId: run.projectId, scriptId: run.scriptId, profileId: run.profileId,
    planHash: run.data.planHash, expiresAt: new Date(run.data.expiresAt).toISOString(), status: run.status, stage: run.data.stage,
    model: run.data.model, output: run.data.output, promptSettings: run.data.promptSettings,
    shots: shots.map((shot) => ({ id: shot.id, shotId: shot.shotId, status: shot.status, source: shot.data.source,
      prompt: shot.data.prompt, duration: shot.data.shot.duration, generationDuration: shot.data.generationDuration,
      keyframeUrl: shot.data.keyframeUrl, missingKeyframe: shot.data.missingKeyframe, options: shot.data.options,
      jobId: shot.jobId ?? undefined, assetId: shot.assetId ?? undefined, videoUrl: shot.data.videoUrl, error: shot.data.error, attempt: shot.data.attempt,
      allowedActions: canRetryKlingFilmShot(shot) && ["paused", "needs_attention"].includes(run.status) ? ["retry-shot"] : [],
    })),
    totalShots: shots.length, readyShots: shots.filter((shot) => shot.status === "ready").length,
    billableShotCount: shots.filter((shot) => shot.data.source === "generate" && shot.status !== "ready").length,
    missingKeyframes: shots.filter((shot) => shot.data.missingKeyframe).map((shot) => shot.shotId),
    warnings: run.data.warnings, error: run.data.error, compositionId: run.data.compositionId,
    videoUrl: run.data.videoUrl, thumbnailUrl: run.data.thumbnailUrl, allowedActions: actions,
    createdAt: new Date(run.createdAt).toISOString(), updatedAt: new Date(run.updatedAt).toISOString(),
  };
}
export async function withKlingFilmLease<T>(id: string, run: () => Promise<T>): Promise<T> {
  const owner = `${process.pid}:${randomUUID()}`;
  getDb().transaction((tx) => {
    const row = getKlingFilm(id);
    // A live process keeps ownership even if its event loop temporarily misses a heartbeat.
    if (row.leaseOwner && processAlive(row.leaseOwner)) throw new KlingError("KLING_FILM_BUSY", "整片任务正在处理，请稍后刷新", 409);
    tx.update(klingFilmRuns).set({ leaseOwner: owner, leaseExpiresAt: Date.now() + 240_000 }).where(eq(klingFilmRuns.id, id)).run();
  });
  const current = { owner, lost: false };
  const heartbeat = setInterval(() => {
    try { if (getDb().update(klingFilmRuns).set({ leaseExpiresAt: Date.now() + 240_000 }).where(and(eq(klingFilmRuns.id, id), eq(klingFilmRuns.leaseOwner, owner))).run().changes !== 1) current.lost = true; }
    catch { current.lost = true; }
  }, 15_000);
  heartbeat.unref();
  try {
    const context = new Map(leases.getStore() ?? []); context.set(id, current);
    return await leases.run(context, async () => { assertKlingFilmLease(id); const result = await run(); assertKlingFilmLease(id); return result; });
  } finally {
    clearInterval(heartbeat);
    getDb().update(klingFilmRuns).set({ leaseOwner: null, leaseExpiresAt: null }).where(and(eq(klingFilmRuns.id, id), eq(klingFilmRuns.leaseOwner, owner))).run();
  }
}
