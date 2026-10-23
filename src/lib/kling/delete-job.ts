import { resolveCurrentScript } from "@/lib/current-script";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { aiTasks, assets, compositions, mediaSources, scripts, videoClips } from "@/lib/db/schema";
import { assetMatchesScript } from "@/lib/asset-context";
import { getOutputDir, getUploadsDir } from "@/lib/paths";
import { klingJobs, klingJobOutputs, type KlingJob } from "./job-schema";
import { klingFilmRuns, klingFilmShots } from "./film-schema";
import { KlingError } from "./errors";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
function childOf(root: string, file: string): boolean {
  const part = relative(root, file);
  return !!part && part !== ".." && !part.startsWith("../") && !part.startsWith("..\\") && !isAbsolute(part);
}
function localPath(value: string | null | undefined): string | undefined {
  if (!value) return;
  try {
    let file: string;
    if (value.startsWith("/api/files/")) file = resolve(getUploadsDir(), decodeURIComponent(value.slice(11)));
    else if (value.startsWith("/api/output/")) file = resolve(getOutputDir(), decodeURIComponent(value.slice(12)));
    else if (isAbsolute(value) && !value.startsWith("/api/")) file = resolve(value);
    else return;
    return existsSync(file) ? realpathSync(file) : file;
  } catch { return; }
}
function busy(message: string): never { throw new KlingError("KLING_JOB_DELETE_CONFLICT", message, 409); }
function workerStillRunning(job: KlingJob): boolean {
  if (!job.leaseOwner) return false;
  if (job.leaseExpiresAt && job.leaseExpiresAt > Date.now()) return true;
  const pid = Number(job.leaseOwner.split(":")[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Only the exact output files written by output-import are owned here; keyframes stay intact. */
function jobDirectory(job: KlingJob): string | undefined {
  if (![job.id, job.projectId].every((id) => SAFE_ID.test(id))) return;
  const uploads = resolve(getUploadsDir());
  const directory = join(uploads, job.projectId, "kling", job.id);
  if (!existsSync(directory)) return directory;
  const root = realpathSync(uploads), actual = realpathSync(directory);
  // Reject redirected job directories, including junctions inside the uploads tree.
  if (!childOf(root, actual) || actual !== join(root, job.projectId, "kling", job.id)) return;
  return actual;
}
function ownedFile(directory: string | undefined, file: string): boolean {
  if (!directory || dirname(file) !== directory || !existsSync(file)) return false;
  const info = lstatSync(file);
  return info.isFile() && !info.isSymbolicLink() && realpathSync(file) === file;
}

/** Deletion is local only: it never invokes the CLI or cancels a paid cloud task. */
export function deleteKlingJob(id: string): { deleted: true; jobId: string } {
  if (!SAFE_ID.test(id)) throw new KlingError("KLING_INPUT_INVALID", "任务编号无效。", 400);
  const db = getDb();
  const moved: Array<{ original: string; staged: string }> = [];
  let job: KlingJob;
  try {
    job = db.transaction((tx) => {
      const row = tx.select().from(klingJobs).where(eq(klingJobs.id, id)).get();
      if (!row) throw new KlingError("KLING_JOB_NOT_FOUND", "没有找到此 Kling 任务", 404);
      if (row.data.deletedAt) return row;
      const outputs = tx.select().from(klingJobOutputs).where(eq(klingJobOutputs.jobId, id)).all();
      const allAssets = tx.select().from(assets).all();
      const roots = allAssets.filter((asset) => outputs.some((output) => output.assetId === asset.id &&
        asset.projectId === row.projectId && asset.provider === "kling-cli" && asset.type === "ai_generated" && asset.filePath === output.data.filePath));
      const removed = new Set(roots.map((asset) => asset.id));
      // Adopting an old take makes another binding to the same video; edited/copied videos survive.
      for (let changed = true; changed;) {
        changed = false;
        for (const asset of allAssets) if (!removed.has(asset.id) && asset.derivedFromAssetId && removed.has(asset.derivedFromAssetId) &&
          asset.provider === "kling-cli" && roots.some((root) => root.filePath === asset.filePath)) { removed.add(asset.id); changed = true; }
      }
      const outputFiles = new Set(outputs.flatMap((output) => [localPath(output.data.filePath), localPath(output.data.localPath)]).filter((value): value is string => !!value));
      const filmRuns = tx.select().from(klingFilmRuns).all();
      const filmShots = tx.select().from(klingFilmShots).all();
      const protectedRuns = new Set(filmRuns.filter((run) => !["completed", "cancelled"].includes(run.status) &&
        (run.status !== "draft" || run.data.expiresAt > Date.now())).map((run) => run.id));
      const refersToVideo = (value: string | null | undefined) => !!value && outputFiles.has(localPath(value) ?? "");
      if ((row.data.filmRunId && protectedRuns.has(row.data.filmRunId)) || filmShots.some((shot) => protectedRuns.has(shot.runId) &&
        (shot.jobId === id || (shot.assetId && removed.has(shot.assetId)) || (shot.data.baselineAssetId && removed.has(shot.data.baselineAssetId)) ||
          refersToVideo(shot.data.videoUrl) || refersToVideo(shot.data.sourceFilePath)))) busy("此视频正在被有效的整片计划或未完成的整片任务使用，请先完成或取消该整片任务。");
      if (tx.select().from(compositions).all().some((item) => item.projectId === row.projectId && ["pending", "composing"].includes(item.status))) busy("此项目正在合成视频，请等待合成结束后再删除镜头素材。");

      // A reference from another asset/source/clip always keeps the shared bytes alive.
      const references = new Set<string>();
      const keep = (value: string | null | undefined) => { const file = localPath(value); if (file) references.add(file); };
      for (const asset of allAssets) if (!removed.has(asset.id)) { keep(asset.filePath); keep(asset.thumbnailPath); keep(asset.sourceKeyframeUrl); }
      for (const output of tx.select().from(klingJobOutputs).all()) if (output.jobId !== id) {
        keep(output.data.localPath); keep(output.data.filePath); keep(output.data.thumbnailUrl); keep(output.data.sourceKeyframeUrl);
      }
      for (const other of tx.select().from(klingJobs).all()) if (other.id !== id && !other.data.deletedAt) for (const input of other.data.inputs) { keep(input.path); keep(input.sourceUrl); }
      for (const source of tx.select().from(mediaSources).all()) keep(source.filePath);
      const clips = tx.select().from(videoClips).all();
      for (const clip of clips) keep(clip.filePath);
      for (const composition of tx.select().from(compositions).all()) { keep(composition.outputPath); keep(composition.thumbnailPath); }
      for (const shot of filmShots) { keep(shot.data.keyframeUrl); for (const input of shot.data.inputs) { keep(input.path); keep(input.sourceUrl); } }

      const directory = jobDirectory(row);
      const candidates = new Set<string>();
      if (directory) for (const output of outputs) if (SAFE_ID.test(output.id)) {
        // Include partial downloads and frame sidecars even if a crash preceded metadata registration.
        for (const suffix of [".mp4", ".webm", ".part"]) {
          const file = join(directory, output.id + suffix);
          candidates.add(file);
          if (suffix !== ".part") { candidates.add(file + ".thumb.jpg"); candidates.add(file + ".last.jpg"); }
        }
      }
      for (const file of candidates) if (!workerStillRunning(row) && !references.has(file) && ownedFile(directory, file)) {
        const staged = file + ".delete-" + randomUUID();
        renameSync(file, staged);
        moved.push({ original: file, staged });
      }
      const removedIds = [...removed];
      if (removedIds.length) {
        tx.update(videoClips).set({ assetId: null }).where(inArray(videoClips.assetId, removedIds)).run();
        tx.update(assets).set({ derivedFromAssetId: null }).where(inArray(assets.derivedFromAssetId, removedIds)).run();
        tx.delete(assets).where(inArray(assets.id, removedIds)).run();
        // Restore the pre-generation take if the deleted output was still the selected take.
        if (allAssets.some((asset) => removed.has(asset.id) && asset.selected) && row.data.expectedSelectedAssetId &&
          !allAssets.some((asset) => !removed.has(asset.id) && asset.projectId === row.projectId && asset.shotId === row.shotId && asset.selected)) {
          const baseline = allAssets.find((asset) => asset.id === row.data.expectedSelectedAssetId && !removed.has(asset.id) &&
            asset.projectId === row.projectId && asset.shotId === row.shotId && asset.status === "done");
          const scriptRows = tx.select().from(scripts).where(eq(scripts.projectId, row.projectId)).all();
          const currentScript = resolveCurrentScript(scriptRows);
          if (baseline && currentScript && assetMatchesScript(baseline, currentScript)) tx.update(assets).set({ selected: true }).where(eq(assets.id, baseline.id)).run();
        }
      }
      tx.delete(klingJobOutputs).where(eq(klingJobOutputs.jobId, id)).run();
      if (row.data.aiTaskId) tx.delete(aiTasks).where(and(eq(aiTasks.id, row.data.aiTaskId), eq(aiTasks.provider, "kling-cli"),
        row.remoteGenerationId ? eq(aiTasks.taskId, row.remoteGenerationId) : undefined)).run();
      const now = Date.now();
      return tx.update(klingJobs).set({ dismissedAt: now, autoQueryPaused: true, needsConfirmation: false, nextQueryAt: null,
        revision: row.revision + 1, updatedAt: now,
        data: { ...row.data, deletedAt: now, deletePendingFiles: moved.map((item) => item.staged),
          deletePendingOutputIds: outputs.map((output) => output.id), authorizedUntil: 0 },
      }).where(eq(klingJobs.id, id)).returning().get()!;
    }, { behavior: "immediate" });
  } catch (error) {
    // Restore staged media when the database transaction cannot commit.
    for (const item of moved.reverse()) renameSync(item.staged, item.original);
    if (error instanceof KlingError) throw error;
    throw new KlingError("KLING_VIDEO_DELETE_FAILED", "删除视频失败，原记录和文件已保留，请稍后重试。", 500);
  }
  const directory = jobDirectory(job);
  try {
    for (const staged of job.data.deletePendingFiles ?? []) {
      if (!existsSync(staged)) continue;
      if (!/^[A-Za-z0-9_-]+\.(?:mp4|webm|part)(?:\.(?:thumb|last)\.jpg)?\.delete-[a-f0-9-]{36}$/.test(basename(staged)) || !ownedFile(directory, staged)) throw new Error("Invalid staged file");
      unlinkSync(staged);
    }
    if (job.data.deletePendingFiles?.length) db.update(klingJobs).set({ data: { ...job.data, deletePendingFiles: [] } }).where(eq(klingJobs.id, id)).run();
  } catch { throw new KlingError("KLING_VIDEO_DELETE_FAILED", "任务已移除，部分本地文件尚未清理，请重试删除。", 500); }
  cleanupDeletedKlingJob(id);
  return { deleted: true, jobId: id };
}

/** A deleted worker may finish a download/frame extraction after the HTTP delete has returned. */
export function cleanupDeletedKlingJob(id: string): void {
  try {
    const db = getDb();
    db.transaction((tx) => {
    const job = tx.select().from(klingJobs).where(eq(klingJobs.id, id)).get();
    if (!job?.data.deletedAt || !job.data.deletePendingOutputIds?.length || workerStillRunning(job)) return;
    const directory = jobDirectory(job);
    if (!directory) return;
    const references = new Set<string>();
    const keep = (value: string | null | undefined) => { const file = localPath(value); if (file) references.add(file); };
    for (const asset of tx.select().from(assets).all()) { keep(asset.filePath); keep(asset.thumbnailPath); keep(asset.sourceKeyframeUrl); }
    for (const output of tx.select().from(klingJobOutputs).all()) { keep(output.data.localPath); keep(output.data.filePath); keep(output.data.thumbnailUrl); keep(output.data.sourceKeyframeUrl); }
    for (const other of tx.select().from(klingJobs).all()) if (!other.data.deletedAt) for (const input of other.data.inputs) { keep(input.path); keep(input.sourceUrl); }
    for (const source of tx.select().from(mediaSources).all()) keep(source.filePath);
    for (const clip of tx.select().from(videoClips).all()) keep(clip.filePath);
    for (const composition of tx.select().from(compositions).all()) { keep(composition.outputPath); keep(composition.thumbnailPath); }
    for (const shot of tx.select().from(klingFilmShots).all()) { keep(shot.data.keyframeUrl); for (const input of shot.data.inputs) { keep(input.path); keep(input.sourceUrl); } }
    let retry = false;
    for (const outputId of job.data.deletePendingOutputIds) if (SAFE_ID.test(outputId)) {
      for (const suffix of [".part", ".mp4", ".webm", ".mp4.thumb.jpg", ".webm.thumb.jpg", ".mp4.last.jpg", ".webm.last.jpg"]) {
        const file = join(directory, outputId + suffix);
        if (references.has(file) || !ownedFile(directory, file)) continue;
        try { unlinkSync(file); } catch { retry = true; }
      }
    }
    if (!retry) tx.update(klingJobs).set({ leaseOwner: null, leaseExpiresAt: null,
      data: { ...job.data, deletePendingOutputIds: [] } }).where(eq(klingJobs.id, id)).run();
    }, { behavior: "immediate" });
  } catch { console.warn("已删除 Kling 任务的本地文件清理暂未完成，将稍后重试。"); }
}

export function cleanupDeletedKlingJobs(): void {
  const rows = getDb().select().from(klingJobs).where(sql`json_extract(${klingJobs.data}, '$.deletedAt') IS NOT NULL`).all();
  for (const job of rows) if (job.data.deletePendingOutputIds?.length) cleanupDeletedKlingJob(job.id);
}
