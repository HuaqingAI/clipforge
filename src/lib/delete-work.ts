import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { and, eq, ne } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { assets, batchJobItems, compositions, mediaEdits, mediaSources, pipelineRuns, videoClips } from "@/lib/db/schema";
import { getDataDir, getOutputDir, getUploadsDir } from "@/lib/paths";
import { klingFilmRuns, klingFilmShots } from "@/lib/kling/film-schema";
import { klingJobs, klingJobOutputs } from "@/lib/kling/job-schema";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export class WorkDeleteError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}
function conflict(message: string): never { throw new WorkDeleteError("WORK_IN_USE", message, 409); }

/** Normalize stored absolute paths, legacy data-relative paths, and local media URLs. */
function storedPath(value: string | null | undefined): string | undefined {
  if (!value || value.includes("\0")) return;
  try {
    let file: string;
    if (value.startsWith("/api/output/")) file = resolve(getOutputDir(), decodeURIComponent(value.slice(12)));
    else if (value.startsWith("/api/files/")) file = resolve(getUploadsDir(), decodeURIComponent(value.slice(11)));
    else if (value.startsWith("/api/") || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return;
    else file = isAbsolute(value) ? resolve(value) : existsSync(value) ? resolve(value) : resolve(getDataDir(), value);
    return file;
  } catch { return; }
}
function localFile(value: string | null | undefined): string | undefined {
  const file = storedPath(value);
  try { return file && existsSync(file) ? realpathSync(file) : file; } catch { return; }
}

/** A composition may only delete ordinary files directly inside its own output directory. */
function ownedFile(file: string | undefined, directory: string, projectDirectory = directory): file is string {
  if (!file || dirname(file) !== directory || !existsSync(file)) return false;
  try {
    const info = lstatSync(file);
    return info.isFile() && !info.isSymbolicLink() && realpathSync(file) === file &&
      realpathSync(directory) === directory && realpathSync(projectDirectory) === projectDirectory && realpathSync(getOutputDir()) === dirname(projectDirectory);
  } catch { return false; }
}

/** Delete just one completed work; input assets, project folders and shared bytes remain. */
export function deleteWork(id: string): { deleted: true; workId: string } {
  if (!SAFE_ID.test(id)) throw new WorkDeleteError("INVALID_WORK_ID", "作品编号无效。", 400);
  const db = getDb();
  const staged: Array<{ original: string; temporary: string }> = [];
  try {
    db.transaction((tx) => {
      const work = tx.select().from(compositions).where(eq(compositions.id, id)).get();
      if (!work) throw new WorkDeleteError("WORK_NOT_FOUND", "作品不存在或已删除。", 404);
      if (work.status !== "done") conflict("只能删除已完成的作品，请等待视频合成结束。");
      if (!SAFE_ID.test(work.projectId)) throw new WorkDeleteError("INVALID_PROJECT_ID", "作品所属项目编号无效。", 400);
      if (tx.select().from(compositions).where(and(eq(compositions.projectId, work.projectId), ne(compositions.id, id))).all()
        .some((row) => row.status === "pending" || row.status === "composing")) conflict("此项目正在合成或精修视频，请等待任务结束后再删除作品。");
      const edits = tx.select().from(mediaEdits).where(eq(mediaEdits.compositionId, id)).all();
      if (edits.some((edit) => ["queued", "rendering"].includes(edit.status))) conflict("此作品仍有剪辑任务正在执行，请等待任务结束后再删除。");
      const pipelines = tx.select().from(pipelineRuns).where(eq(pipelineRuns.compositionId, id)).all();
      if (pipelines.some((run) => run.status === "running")) conflict("此作品仍被生产任务使用，请等待任务结束后再删除。");
      const batchItems = tx.select().from(batchJobItems).where(eq(batchJobItems.compositionId, id)).all();
      if (batchItems.some((item) => ["pending", "generating", "composing"].includes(item.status))) conflict("此作品仍被批量任务使用，请等待任务结束后再删除。");

      const directory = resolve(getOutputDir(), work.projectId);
      const output = storedPath(work.outputPath);
      const normalizedOutput = localFile(work.outputPath);
      const films = tx.select().from(klingFilmRuns).all();
      const shots = tx.select().from(klingFilmShots).all();
      const linkedFilms = films.filter((run) => run.data.compositionId === id);
      if (linkedFilms.some((run) => !["completed", "cancelled"].includes(run.status) ||
        (run.leaseOwner && run.leaseExpiresAt && run.leaseExpiresAt > Date.now()))) conflict("此作品的整片任务尚未结束，请先完成或取消整片任务。");
      const activeFilms = new Set(films.filter((run) => !["completed", "cancelled"].includes(run.status) &&
        (run.status !== "draft" || run.data.expiresAt > Date.now())).map((run) => run.id));
      if (normalizedOutput && shots.some((shot) => activeFilms.has(shot.runId) &&
        [shot.data.videoUrl, shot.data.sourceFilePath].some((value) => localFile(value) === normalizedOutput))) conflict("此视频正在被有效整片计划使用，请先完成或取消该整片任务。");

      const kept = new Set<string>();
      const keep = (value: string | null | undefined) => { const file = localFile(value); if (file) kept.add(file); };
      for (const other of tx.select().from(compositions).all()) if (other.id !== id) { keep(other.outputPath); keep(other.thumbnailPath); keep(other.bgmPath); }
      for (const asset of tx.select().from(assets).all()) { keep(asset.filePath); keep(asset.thumbnailPath); keep(asset.sourceKeyframeUrl); }
      for (const source of tx.select().from(mediaSources).all()) keep(source.filePath);
      for (const clip of tx.select().from(videoClips).all()) keep(clip.filePath);
      for (const row of tx.select().from(klingJobOutputs).all()) { keep(row.data.localPath); keep(row.data.filePath); keep(row.data.thumbnailUrl); keep(row.data.sourceKeyframeUrl); }
      for (const row of tx.select().from(klingJobs).all()) for (const input of row.data.inputs) { keep(input.path); keep(input.sourceUrl); }
      for (const run of films) if (run.data.compositionId !== id) { keep(run.data.videoUrl); keep(run.data.thumbnailUrl); }
      for (const shot of shots) { keep(shot.data.videoUrl); keep(shot.data.sourceFilePath); keep(shot.data.keyframeUrl); for (const input of shot.data.inputs) { keep(input.path); keep(input.sourceUrl); } }
      keep(work.bgmPath);

      const candidates = new Set<string>();
      if (output && dirname(output) === directory && /\.(mp4|webm|mov|mkv)$/i.test(output) && !kept.has(normalizedOutput ?? output) &&
        (!existsSync(output) || ownedFile(output, directory))) {
        candidates.add(output);
        for (const suffix of [".thumb.jpg", ".last.jpg", ".timeline.json", ".timeline.json.part", ".mastering.json"]) candidates.add(output + suffix);
        const thumbnail = storedPath(work.thumbnailPath);
        if (thumbnail && /\.(jpg|jpeg|png|webp)$/i.test(thumbnail)) candidates.add(thumbnail);
        for (const name of ["voice.wav", "bgm.wav"]) candidates.add(join(directory, `stems_${id}`, name));
      }
      // Diagnostics are keyed to the composition, unlike shared music and source files.
      candidates.add(join(directory, `.composition-${id}.error.json`));
      for (const file of candidates) if (!kept.has(file) &&
        ((dirname(file) === directory && ownedFile(file, directory)) ||
          (dirname(file) === join(directory, `stems_${id}`) && ownedFile(file, dirname(file), directory)))) {
        const temporary = file + ".delete-" + randomUUID();
        renameSync(file, temporary); staged.push({ original: file, temporary });
      }
      for (const run of linkedFilms) {
        const { compositionId: _compositionId, videoUrl: _videoUrl, thumbnailUrl: _thumbnailUrl, quality: _quality, ...data } = run.data;
        void _compositionId; void _videoUrl; void _thumbnailUrl; void _quality;
        tx.update(klingFilmRuns).set({ data: { ...data, stage: "成片已删除" }, updatedAt: Date.now() }).where(eq(klingFilmRuns.id, run.id)).run();
      }
      tx.update(mediaEdits).set({ compositionId: null }).where(eq(mediaEdits.compositionId, id)).run();
      tx.update(pipelineRuns).set({ compositionId: null }).where(eq(pipelineRuns.compositionId, id)).run();
      tx.update(batchJobItems).set({ compositionId: null }).where(eq(batchJobItems.compositionId, id)).run();
      tx.delete(compositions).where(eq(compositions.id, id)).run();
    }, { behavior: "immediate" });
  } catch (error) {
    for (const file of staged.reverse()) renameSync(file.temporary, file.original);
    if (error instanceof WorkDeleteError) throw error;
    throw new WorkDeleteError("WORK_DELETE_FAILED", "删除作品失败，作品与文件已保留，请稍后重试。", 500);
  }
  for (const file of staged) {
    try { unlinkSync(file.temporary); }
    catch { console.warn("作品已删除，临时文件清理失败:", file.temporary); }
  }
  return { deleted: true, workId: id };
}

/** Match normal project APIs while denying browser requests from another origin. */
export function assertWorkDeleteOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  const site = req.headers.get("sec-fetch-site");
  const target = new URL(req.url);
  const host = req.headers.get("host");
  if (host) target.host = host;
  if (site === "cross-site" || (origin && origin !== target.origin)) {
    throw new WorkDeleteError("WORK_DELETE_FORBIDDEN", "不允许其他网站删除本地作品。", 403);
  }
}
