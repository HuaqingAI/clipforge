import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, isNull, lt, or, desc, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { assets, scripts } from "@/lib/db/schema";
import { filterAssetsForScript } from "@/lib/asset-context";
import { klingJobs, klingJobOutputs, type KlingJob, type KlingJobData, type KlingJobOutput, type KlingOutputData } from "./job-schema";
import { KlingError } from "./errors";
import type { KlingJobView } from "./job-types";
import { klingJobHasUnresolvedWork } from "./concurrency";
import { cleanupDeletedKlingJob } from "./delete-job";

const leaseContext = new AsyncLocalStorage<Map<string, { owner: string; lost: boolean }>>();
export function withoutKlingJobLease<T>(run: () => T): T { return leaseContext.run(new Map(), run); }
function ownerProcessAlive(owner: string): boolean {
  const pid = Number(owner.split(":")[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
/** Fence writes from a worker whose durable lease was replaced or expired. */
export function assertKlingJobLease(id: string): void {
  const context = leaseContext.getStore()?.get(id);
  const row = getDb().select().from(klingJobs).where(eq(klingJobs.id, id)).get();
  if (row?.data.deletedAt) throw new KlingError("KLING_JOB_DELETED", "此任务已删除，不能恢复。", 410);
  if (!context) return;
  if (context.lost || !row || row.data.deletedAt || row.leaseOwner !== context.owner || !row.leaseExpiresAt || row.leaseExpiresAt <= Date.now()) throw new KlingError("KLING_JOB_LEASE_LOST", "任务执行锁已失效，请刷新原任务后继续。", 409);
}

export function getKlingJob(id: string): KlingJob {
  const row = getDb().select().from(klingJobs).where(eq(klingJobs.id, id)).get();
  if (!row) throw new KlingError("KLING_JOB_NOT_FOUND", "没有找到此 Kling 任务", 404);
  if (row.data.deletedAt) throw new KlingError("KLING_JOB_DELETED", "此任务生成的视频已删除，不能恢复。", 410);
  return row;
}
export function patchKlingJob(id: string, patch: Partial<Omit<KlingJob, "id" | "data">>, data: Partial<KlingJobData> = {}): KlingJob {
  return getDb().transaction((tx) => {
    assertKlingJobLease(id);
    const row = tx.select().from(klingJobs).where(eq(klingJobs.id, id)).get();
    if (!row) throw new KlingError("KLING_JOB_NOT_FOUND", "没有找到此 Kling 任务", 404);
    if (row.data.deletedAt) throw new KlingError("KLING_JOB_DELETED", "此任务生成的视频已删除，不能恢复。", 410);
    const result = tx.update(klingJobs).set({ ...patch, data: { ...row.data, ...data }, revision: row.revision + 1, updatedAt: Date.now() })
      .where(and(eq(klingJobs.id, id), eq(klingJobs.revision, row.revision))).returning().get();
    if (!result) throw new KlingError("KLING_JOB_CONFLICT", "任务状态已更新，请刷新", 409);
    return result;
  });
}
export function getKlingOutputs(jobId: string): KlingJobOutput[] {
  return getDb().select().from(klingJobOutputs).where(eq(klingJobOutputs.jobId, jobId)).all();
}
export function patchKlingOutput(id: string, patch: Partial<Omit<KlingJobOutput, "id" | "data">>, data: Partial<KlingOutputData> = {}): KlingJobOutput {
  return getDb().transaction((tx) => {
    const row = tx.select().from(klingJobOutputs).where(eq(klingJobOutputs.id, id)).get();
    if (!row) throw new KlingError("KLING_OUTPUT_NOT_FOUND", "没有找到视频输出", 404);
    assertKlingJobLease(row.jobId);
    return tx.update(klingJobOutputs).set({ ...patch, data: { ...row.data, ...data }, updatedAt: Date.now() }).where(eq(klingJobOutputs.id, id)).returning().get()!;
  });
}
export function isKlingJobUnresolved(row: KlingJob): boolean {
  return !row.data.deletedAt && klingJobHasUnresolvedWork(row);
}
export function listKlingJobs(projectId?: string): KlingJob[] {
  return getDb().select().from(klingJobs).where(and(projectId ? eq(klingJobs.projectId, projectId) : undefined,
    sql`json_extract(${klingJobs.data}, '$.deletedAt') IS NULL`)).orderBy(desc(klingJobs.createdAt)).all();
}
export function klingJobView(row: KlingJob): KlingJobView {
  const actions = ["view_details"];
  if (row.remoteGenerationId) {
    actions.push("query");
    if (!["failed", "cancelled", "completed"].includes(row.remoteState)) actions.push(row.autoQueryPaused ? "resume-query" : "pause-query");
  }
  if (row.remoteState === "completed") actions.push("import");
  if (row.submissionState === "prepared" && row.needsConfirmation) actions.push("continue");
  if (row.submissionState === "prepared" && !row.data.dispatchStartedAt) actions.push("cancel-prepared");
  if (row.submissionState === "submission_unknown" && !row.remoteGenerationId) actions.push("bind");
  if (isKlingJobUnresolved(row)) actions.push("dismiss");
  if (!row.data.deletedAt) actions.push("delete");
  const scriptRows = getDb().select().from(scripts).where(eq(scripts.projectId, row.projectId)).all();
  const selectedScript = scriptRows.find((script) => script.selected) ?? scriptRows[0];
  const currentAssets = selectedScript ? filterAssetsForScript(getDb().select().from(assets).where(and(eq(assets.projectId, row.projectId), eq(assets.shotId, row.shotId))).all(), selectedScript) : [];
  const outputs = getKlingOutputs(row.id).map((output) => {
    const active = currentAssets.find((asset) => asset.selected && (asset.id === output.assetId || asset.derivedFromAssetId === output.assetId));
    return {
      outputId: output.id,
      assetId: active?.id ?? output.assetId ?? undefined,
      videoUrl: output.importState === "imported" ? output.data.filePath : undefined,
      thumbnailUrl: output.data.thumbnailUrl ?? output.data.sourceKeyframeUrl,
      imported: output.importState === "imported",
      selected: !!active,
      selectionOutcome: output.data.selectionOutcome,
    };
  });
  return {
    jobId: row.id, profileId: row.profileId, accountLabel: row.data.accountLabel,
    projectId: row.projectId, scriptId: row.scriptId, shotId: row.shotId,
    modelId: row.data.model.remoteModelId, tool: row.data.model.tool, prompt: row.data.prompt,
    remoteGenerationId: row.remoteGenerationId ?? undefined,
    submissionState: row.submissionState, remoteState: row.remoteState, importState: row.importState,
    blockedReason: row.data.blockedReason, lastError: row.data.error,
    cliDiagnostics: row.data.cliDiagnostics,
    lastCheckedAt: row.data.lastCheckedAt ? new Date(row.data.lastCheckedAt).toISOString() : undefined,
    createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString(),
    outputs, allowedActions: actions, autoQueryPaused: row.autoQueryPaused, needsConfirmation: row.needsConfirmation,
    inputSummary: row.data.inputs.map((input) => ({ role: input.role, sourceUrl: input.sourceUrl.startsWith("/api/files/") ? input.sourceUrl : undefined, hash: input.hash })),
    options: row.data.options,
  };
}

export async function withKlingJobLease<T>(id: string, run: () => Promise<T>): Promise<T> {
  const owner = `${process.pid}:${randomUUID()}`;
  const now = Date.now();
  const row = getDb().transaction((tx) => {
    const previous = tx.select().from(klingJobs).where(eq(klingJobs.id, id)).get();
    if (previous?.data.deletedAt) throw new KlingError("KLING_JOB_DELETED", "此任务生成的视频已删除，不能恢复。", 410);
    if (previous?.leaseOwner && ownerProcessAlive(previous.leaseOwner)) throw new KlingError("KLING_JOB_BUSY", "此任务的执行进程尚未退出，请稍后刷新。", 409);
    return tx.update(klingJobs).set({ leaseOwner: owner, leaseExpiresAt: now + 240_000 })
      .where(and(eq(klingJobs.id, id), or(isNull(klingJobs.leaseOwner), lt(klingJobs.leaseExpiresAt, now)))).returning().get();
  });
  if (!row) throw new KlingError("KLING_JOB_BUSY", "此任务正在处理，请稍后刷新", 409);
  const current = { owner, lost: false };
  const heartbeat = setInterval(() => {
    try { if (getDb().update(klingJobs).set({ leaseExpiresAt: Date.now() + 240_000 }).where(and(eq(klingJobs.id, id), eq(klingJobs.leaseOwner, owner))).run().changes !== 1) current.lost = true; }
    catch { current.lost = true; }
  }, 15_000);
  heartbeat.unref();
  try {
    const context = new Map(leaseContext.getStore() ?? []); context.set(id, current);
    return await leaseContext.run(context, async () => { assertKlingJobLease(id); const result = await run(); assertKlingJobLease(id); return result; });
  }
  finally {
    clearInterval(heartbeat);
    getDb().update(klingJobs).set({ leaseOwner: null, leaseExpiresAt: null }).where(and(eq(klingJobs.id, id), eq(klingJobs.leaseOwner, owner))).run();
    cleanupDeletedKlingJob(id);
  }
}

export function refreshKlingImportState(jobId: string): void {
  const rows = getKlingOutputs(jobId);
  const imported = rows.filter((row) => row.importState === "imported").length;
  patchKlingJob(jobId, { importState: rows.length && imported === rows.length ? "completed" : imported ? "partial" : rows.some((row) => row.importState === "failed") ? "failed" : "pending" });
}
