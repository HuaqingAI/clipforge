import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { assets, batchJobItems, compositions, mediaSources, pipelineRuns, projects, scripts, settings, videoClips } from "@/lib/db/schema";
import { klingJobs, klingJobOutputs } from "@/lib/kling/job-schema";
import { klingFilmRuns, klingFilmShots } from "@/lib/kling/film-schema";
import { getDataDir, getOutputDir, getUploadsDir } from "@/lib/paths";
import type { DeleteLocalShotVideoResult, LocalShotVideo } from "@/lib/shot-library-types";

const VIDEO = /\.(mp4|webm|mov|m4v|mkv)$/i;
const CLEANUP_KEY = "shot-library:pending-deletes";
export class ShotLibraryError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}
function conflict(message: string): never { throw new ShotLibraryError("SHOT_IN_USE", message, 409); }
function childOf(root: string, file: string): boolean {
  const part = relative(root, file);
  return !!part && part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part);
}
function pathKey(file: string): string { return process.platform === "win32" ? file.toLowerCase() : file; }

/** Resolve stored references; only the uploads/output trees are owned by this library. */
function storedPath(value: string | null | undefined): string | undefined {
  if (!value || value.includes("\0")) return;
  try {
    let file: string;
    if (value.startsWith("/api/files/")) file = resolve(getUploadsDir(), decodeURIComponent(value.slice(11)));
    else if (value.startsWith("/api/output/")) file = resolve(getOutputDir(), decodeURIComponent(value.slice(12)));
    else if (value.startsWith("/api/") || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return;
    else file = isAbsolute(value) ? resolve(value) : existsSync(value) ? resolve(value) : resolve(getDataDir(), value);
    return [getUploadsDir(), getOutputDir()].some((root) => childOf(resolve(root), file)) ? file : undefined;
  } catch { return; }
}
function localPath(value: string | null | undefined): string | undefined {
  const file = storedPath(value);
  try { return file && existsSync(file) ? realpathSync(file) : file; } catch { return; }
}
function sameFile(value: string | null | undefined, file: string): boolean {
  const local = localPath(value);
  return !!local && pathKey(local) === pathKey(file);
}
/** Refuse symlinks/junctions, including links redirecting to another directory inside uploads. */
function ownedFile(file: string): boolean {
  try {
    const root = [getUploadsDir(), getOutputDir()].map((value) => resolve(value)).find((value) => childOf(value, file));
    if (!root) return false;
    return lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink() &&
      pathKey(realpathSync(file)) === pathKey(resolve(realpathSync(root), relative(root, file)));
  } catch { return false; }
}
function mediaUrl(file: string | null | undefined): string | null {
  const local = storedPath(file);
  if (!local || !ownedFile(local)) return null;
  for (const [root, prefix] of [[getUploadsDir(), "/api/files/"], [getOutputDir(), "/api/output/"]]) {
    if (childOf(resolve(root), local)) return prefix + relative(resolve(root), local).split(/[\\/]/).map(encodeURIComponent).join("/");
  }
  return null;
}
function timestamp(value: Date | number | null | undefined): number {
  const time = value instanceof Date ? value.getTime() : value;
  return time && Number.isFinite(time) ? time : 0;
}
function snapshot() {
  const db = getDb();
  return {
    projects: db.select().from(projects).all(), scripts: db.select().from(scripts).all(),
    assets: db.select().from(assets).all(), clips: db.select().from(videoClips).all(),
    jobs: db.select().from(klingJobs).all(), outputs: db.select().from(klingJobOutputs).all(),
    films: db.select().from(klingFilmRuns).all(), filmShots: db.select().from(klingFilmShots).all(),
  };
}
type Snapshot = ReturnType<typeof snapshot>;
interface Candidate {
  file: string;
  projectId: string;
  scriptId: string | null;
  shotId: number;
  description?: string;
  duration?: number | null;
  createdAt: number;
  thumbnail?: string | null;
  selected: boolean;
  provider?: string | null;
  model?: string | null;
  priority: number;
}
interface LibraryEntry { file: string; video: LocalShotVideo }

function collectLibrary(state: Snapshot): LibraryEntry[] {
  const projectMap = new Map(state.projects.map((row) => [row.id, row]));
  const scriptMap = new Map(state.scripts.map((row) => [row.id, row]));
  const jobMap = new Map(state.jobs.map((row) => [row.id, row]));
  const assetMap = new Map(state.assets.map((row) => [row.id, row]));
  const filmMap = new Map(state.films.map((row) => [row.id, row]));
  const candidates: Candidate[] = [];
  const validFile = (value: string | null | undefined) => {
    const file = storedPath(value);
    return file && VIDEO.test(file) && ownedFile(file) ? realpathSync(file) : undefined;
  };
  const outputFor = (id: string, file?: string) => state.outputs.find((row) => !row.data.deletedAt &&
    (row.assetId === id || (file && (sameFile(row.data.filePath, file) || sameFile(row.data.localPath, file)))));
  function assetScript(asset: Snapshot["assets"][number], seen = new Set<string>()): string | null {
    if (seen.has(asset.id)) return null;
    seen.add(asset.id);
    if (asset.sourceScriptId) return asset.sourceScriptId;
    if (asset.derivedFromAssetId) {
      const parent = assetMap.get(asset.derivedFromAssetId);
      if (parent && parent.projectId === asset.projectId) {
        const scriptId = assetScript(parent, seen);
        if (scriptId) return scriptId;
      }
    }
    const output = outputFor(asset.id, localPath(asset.filePath));
    const job = output && jobMap.get(output.jobId);
    if (job && job.projectId === asset.projectId) return job.scriptId;
    const linked = state.filmShots.filter((row) => row.assetId === asset.id || sameFile(row.data.videoUrl, localPath(asset.filePath) ?? ""))
      .map((row) => filmMap.get(row.runId)).filter((run) => run?.projectId === asset.projectId);
    const ids = new Set(linked.map((run) => run!.scriptId));
    return ids.size === 1 ? [...ids][0] : null;
  }
  for (const asset of state.assets) {
    const file = asset.type === "ai_generated" && asset.status === "done" ? validFile(asset.filePath) : undefined;
    if (!file) continue;
    const scriptId = assetScript(asset);
    candidates.push({ file, projectId: asset.projectId, scriptId, shotId: asset.shotId, createdAt: timestamp(asset.createdAt),
      thumbnail: asset.thumbnailPath ?? asset.sourceKeyframeUrl, selected: asset.selected, provider: asset.provider, model: asset.model, priority: scriptId ? 30 : 10 });
  }
  for (const output of state.outputs) {
    const job = jobMap.get(output.jobId);
    if (!job || job.data.deletedAt || output.data.deletedAt) continue;
    const file = validFile(output.data.filePath) ?? validFile(output.data.localPath);
    // A fully saved file may predate asset registration after an interrupted import.
    if (!file) continue;
    const asset = output.assetId ? assetMap.get(output.assetId) : undefined;
    candidates.push({ file, projectId: job.projectId, scriptId: job.scriptId, shotId: job.shotId,
      description: job.data.videoPromptAudit?.sourceShot.description, createdAt: output.createdAt,
      thumbnail: output.data.thumbnailUrl ?? output.data.sourceKeyframeUrl, duration: output.data.durationMs,
      selected: Boolean(asset?.selected), provider: "kling-cli", model: job.data.model.remoteModelId, priority: 50 });
  }
  for (const clip of state.clips) {
    const file = clip.status === "done" ? validFile(clip.filePath) : undefined;
    if (!file) continue;
    const asset = clip.assetId ? assetMap.get(clip.assetId) : undefined;
    // An explicit uploaded/stock source remains outside the generated-shot library.
    if (asset && asset.type !== "ai_generated" && !clip.provider) continue;
    const output = outputFor(clip.assetId ?? "", file);
    const job = output && jobMap.get(output.jobId);
    const scriptId = asset ? assetScript(asset) : job?.projectId === clip.projectId ? job.scriptId : null;
    candidates.push({ file, projectId: clip.projectId, scriptId, shotId: clip.shotId, createdAt: timestamp(clip.createdAt),
      thumbnail: asset?.thumbnailPath ?? asset?.sourceKeyframeUrl, duration: clip.duration, selected: asset?.selected ?? false,
      provider: clip.provider, model: clip.model, priority: scriptId ? 20 : 5 });
  }
  for (const filmShot of state.filmShots) {
    const run = filmMap.get(filmShot.runId);
    if (!run || filmShot.data.source !== "generate" || filmShot.status !== "ready") continue;
    const file = validFile(filmShot.data.videoUrl) ?? validFile(filmShot.data.sourceFilePath);
    if (!file) continue;
    const asset = filmShot.assetId ? assetMap.get(filmShot.assetId) : undefined;
    candidates.push({ file, projectId: run.projectId, scriptId: run.scriptId, shotId: filmShot.shotId,
      description: filmShot.data.shot.description, createdAt: run.createdAt,
      thumbnail: filmShot.data.keyframeUrl, duration: filmShot.data.generationDuration ? filmShot.data.generationDuration * 1000 : undefined,
      selected: Boolean(asset?.selected), provider: "kling-cli", model: run.data.model?.remoteModelId, priority: 40 });
  }
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    if (!projectMap.has(candidate.projectId)) continue;
    const key = pathKey(candidate.file);
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  return [...groups.values()].map((group): LibraryEntry => {
    group.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
    const source = group[0], project = projectMap.get(source.projectId)!;
    const script = source.scriptId ? scriptMap.get(source.scriptId) : undefined;
    const scopedScript = script?.projectId === project.id ? script : undefined;
    const shot = scopedScript?.shots?.find((row) => row.shotId === source.shotId);
    const duration = group.find((row) => row.duration && row.duration > 0)?.duration ?? null;
    const thumbnailUrl = mediaUrl(source.file + ".thumb.jpg") ?? group.map((row) => mediaUrl(row.thumbnail)).find(Boolean) ?? null;
    return { file: source.file, video: {
      id: createHash("sha256").update(pathKey(source.file)).digest("hex").slice(0, 32),
      projectId: project.id, projectName: project.name, productName: project.productName,
      scriptId: scopedScript?.id ?? null, scriptTitle: scopedScript?.title ?? null,
      scriptVersion: scopedScript?.version ?? null, scriptStyle: scopedScript?.styleType ?? null,
      shotId: source.shotId, shotDescription: source.description ?? shot?.description ?? null,
      url: mediaUrl(source.file)!, thumbnailUrl, duration, createdAt: new Date(source.createdAt || statSync(source.file).mtimeMs).toISOString(),
      sizeBytes: statSync(source.file).size, selected: group.some((row) => row.selected),
      provider: group.find((row) => row.provider)?.provider ?? null, model: group.find((row) => row.model)?.model ?? null,
      fileName: basename(source.file),
    } };
  }).sort((a, b) => b.video.createdAt.localeCompare(a.video.createdAt));
}

function pendingPaths(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** The committed journal survives Windows file locks and an interrupted post-commit cleanup. */
function cleanupPendingShotFiles(): Map<string, number> {
  const deleted = new Map<string, number>();
  try {
    getDb().transaction((tx) => {
      const journal = tx.select().from(settings).where(eq(settings.key, CLEANUP_KEY)).get();
      if (!journal) return;
      const pending: string[] = [];
      for (const file of pendingPaths(journal.value)) {
        // Journal contents never grant authority over originals, unmarked files or another tree.
        if (!isAbsolute(file) || storedPath(file) !== file ||
          !/\.(?:mp4|webm|mov|m4v|mkv)(?:\.(?:thumb|last)\.jpg)?\.shot-delete-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(file)) continue;
        if (!existsSync(file)) continue;
        if (!ownedFile(file)) { pending.push(file); continue; }
        try {
          const size = statSync(file).size;
          unlinkSync(file); deleted.set(file, size);
        } catch { pending.push(file); }
      }
      if (pending.length) tx.update(settings).set({ value: pending, updatedAt: new Date() }).where(eq(settings.key, CLEANUP_KEY)).run();
      else tx.delete(settings).where(eq(settings.key, CLEANUP_KEY)).run();
    }, { behavior: "immediate" });
  } catch { console.warn("镜头临时文件清理暂未完成，将在下次打开镜头库时重试。"); }
  return deleted;
}

export function listLocalShotVideos(): LocalShotVideo[] {
  cleanupPendingShotFiles();
  return collectLibrary(snapshot()).map((entry) => entry.video);
}

function leaseActive(row: { leaseOwner: string | null; leaseExpiresAt: number | null }): boolean {
  if (!row.leaseOwner) return false;
  if ((row.leaseExpiresAt ?? 0) > Date.now()) return true;
  const pid = Number(row.leaseOwner.split(":")[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Remove this physical take's generated bindings; unrelated source/shared files survive. */
export function deleteLocalShotVideo(id: string): DeleteLocalShotVideoResult {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new ShotLibraryError("INVALID_SHOT_ID", "镜头编号无效。", 400);
  const db = getDb();
  const staged: Array<{ original: string; temporary: string; size: number }> = [];
  try {
    db.transaction((tx) => {
      const state = snapshot(), entry = collectLibrary(state).find((item) => item.video.id === id);
      if (!entry) throw new ShotLibraryError("SHOT_NOT_FOUND", "此本地镜头不存在或已删除。", 404);
      const file = entry.file;
      const removedAssets = state.assets.filter((row) => row.type === "ai_generated" && sameFile(row.filePath, file));
      const removedIds = new Set(removedAssets.map((row) => row.id));
      const removedClips = state.clips.filter((row) => sameFile(row.filePath, file));
      const outputs = state.outputs.filter((row) => !row.data.deletedAt &&
        (sameFile(row.data.filePath, file) || sameFile(row.data.localPath, file) || (row.assetId && removedIds.has(row.assetId))));
      const outputIds = new Set(outputs.map((row) => row.id)), jobIds = new Set(outputs.map((row) => row.jobId));
      const affectedProjects = new Set([entry.video.projectId, ...removedAssets.map((row) => row.projectId), ...removedClips.map((row) => row.projectId)]);
      if (removedAssets.some((row) => ["pending", "generating"].includes(row.status)) || removedClips.some((row) => ["pending", "generating"].includes(row.status))) conflict("此镜头仍在生成，请等待任务结束后再删除。");
      if (state.jobs.some((row) => jobIds.has(row.id) && (leaseActive(row) || row.importState === "importing" ||
        ["prepared", "submitting", "submission_unknown"].includes(row.submissionState) || ["pending", "processing"].includes(row.remoteState))) ||
        outputs.some((row) => ["downloading", "validating"].includes(row.importState))) conflict("此镜头的任务仍在处理或保存，请等待任务结束后再删除。");
      const matchesFilmShot = (row: Snapshot["filmShots"][number]) =>
        (row.assetId && removedIds.has(row.assetId)) || (row.data.baselineAssetId && removedIds.has(row.data.baselineAssetId)) ||
        sameFile(row.data.videoUrl, file) || sameFile(row.data.sourceFilePath, file) || (row.jobId && jobIds.has(row.jobId));
      const linkedFilms = new Set(state.filmShots.filter(matchesFilmShot).map((row) => row.runId));
      if (state.films.some((run) => linkedFilms.has(run.id) && (leaseActive(run) ||
        (!["completed", "cancelled"].includes(run.status) && (run.status !== "draft" || run.data.expiresAt > Date.now()))))) conflict("此镜头正在被有效的整片计划或未完成的整片任务使用，请先完成或取消整片任务。");
      if (tx.select().from(compositions).all().some((row) => affectedProjects.has(row.projectId) && ["pending", "composing"].includes(row.status))) conflict("此项目正在合成视频，请等待合成结束后再删除镜头。");
      if (tx.select().from(pipelineRuns).all().some((row) => affectedProjects.has(row.projectId) && row.status === "running") ||
        tx.select().from(batchJobItems).all().some((row) => row.projectId && affectedProjects.has(row.projectId) && ["pending", "generating", "composing"].includes(row.status))) conflict("此项目仍有生产任务正在执行，请等待任务结束后再删除镜头。");

      const kept = new Set<string>();
      const keep = (value: string | null | undefined) => { const path = localPath(value); if (path) kept.add(pathKey(path)); };
      for (const asset of state.assets) {
        if (!removedIds.has(asset.id)) { keep(asset.filePath); keep(asset.thumbnailPath); }
        keep(asset.sourceKeyframeUrl);
      }
      for (const row of state.outputs) {
        if (!outputIds.has(row.id)) { keep(row.data.localPath); keep(row.data.filePath); keep(row.data.thumbnailUrl); }
        keep(row.data.sourceKeyframeUrl);
      }
      for (const row of state.jobs) if (!row.data.deletedAt) for (const input of row.data.inputs) { keep(input.path); keep(input.sourceUrl); }
      const removedClipIds = new Set(removedClips.map((row) => row.id));
      for (const row of state.clips) if (!removedClipIds.has(row.id)) keep(row.filePath);
      for (const row of tx.select().from(mediaSources).all()) keep(row.filePath);
      for (const row of tx.select().from(compositions).all()) { keep(row.outputPath); keep(row.thumbnailPath); keep(row.bgmPath); }
      for (const row of state.films) { keep(row.data.videoUrl); keep(row.data.thumbnailUrl); }
      for (const row of state.filmShots) {
        if (!matchesFilmShot(row)) { keep(row.data.videoUrl); keep(row.data.sourceFilePath); }
        keep(row.data.keyframeUrl);
        for (const input of row.data.inputs) { keep(input.path); keep(input.sourceUrl); }
      }
      // A shared main file keeps its derived frames too. Only exact sidecars belong to this take.
      if (!kept.has(pathKey(file))) for (const candidate of [file, file + ".thumb.jpg", file + ".last.jpg"]) {
        if (!kept.has(pathKey(candidate)) && ownedFile(candidate)) {
          const temporary = candidate + ".shot-delete-" + randomUUID();
          const size = statSync(candidate).size;
          renameSync(candidate, temporary); staged.push({ original: candidate, temporary, size });
        }
      }
      if (removedClips.length) tx.delete(videoClips).where(inArray(videoClips.id, [...removedClipIds])).run();
      if (removedIds.size) {
        tx.update(videoClips).set({ assetId: null }).where(inArray(videoClips.assetId, [...removedIds])).run();
        tx.update(assets).set({ derivedFromAssetId: null }).where(inArray(assets.derivedFromAssetId, [...removedIds])).run();
        tx.delete(assets).where(inArray(assets.id, [...removedIds])).run();
      }
      for (const row of outputs) {
        const data = { ...row.data, deletedAt: Date.now() };
        delete data.localPath; delete data.filePath; delete data.thumbnailUrl; delete data.selectionOutcome;
        tx.update(klingJobOutputs).set({ assetId: null, importState: "imported", data, updatedAt: Date.now() }).where(eq(klingJobOutputs.id, row.id)).run();
      }
      for (const row of state.filmShots.filter(matchesFilmShot)) {
        const data = { ...row.data };
        if (sameFile(data.videoUrl, file)) delete data.videoUrl;
        if (sameFile(data.sourceFilePath, file)) { delete data.sourceFilePath; delete data.sourceFileHash; }
        if (data.baselineAssetId && removedIds.has(data.baselineAssetId)) data.baselineAssetId = null;
        const lostVideo = sameFile(row.data.videoUrl, file) || sameFile(row.data.sourceFilePath, file) || Boolean(row.assetId && removedIds.has(row.assetId));
        if (lostVideo) data.error = "本地镜头已删除";
        tx.update(klingFilmShots).set({ assetId: row.assetId && removedIds.has(row.assetId) ? null : row.assetId,
          data, ...(lostVideo && { status: "needs_attention" as const }), updatedAt: Date.now() }).where(eq(klingFilmShots.id, row.id)).run();
      }
      if (staged.length) {
        const prior = tx.select().from(settings).where(eq(settings.key, CLEANUP_KEY)).get();
        const value = [...new Set([...pendingPaths(prior?.value), ...staged.map((item) => item.temporary)])];
        tx.insert(settings).values({ key: CLEANUP_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } }).run();
      }
    }, { behavior: "immediate" });
  } catch (error) {
    for (const file of staged.reverse()) renameSync(file.temporary, file.original);
    if (error instanceof ShotLibraryError) throw error;
    throw new ShotLibraryError("SHOT_DELETE_FAILED", "删除镜头失败，原记录和文件已保留，请稍后重试。", 500);
  }
  const cleaned = cleanupPendingShotFiles();
  const removed = staged.filter((file) => cleaned.has(file.temporary));
  const deletedFiles = removed.length, freedBytes = removed.reduce((total, file) => total + cleaned.get(file.temporary)!, 0);
  return { success: true, deletedId: id, deletedFiles, freedBytes };
}

export function assertShotDeleteOrigin(req: Request): void {
  const origin = req.headers.get("origin"), site = req.headers.get("sec-fetch-site");
  const target = new URL(req.url), host = req.headers.get("host");
  if (host) target.host = host;
  if (site === "cross-site" || (origin && origin !== target.origin)) {
    throw new ShotLibraryError("SHOT_DELETE_FORBIDDEN", "不允许其他网站删除本地镜头。", 403);
  }
}
