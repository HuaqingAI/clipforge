import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { assets, compositions } from "@/lib/db/schema";
import { assetMatchesScript } from "@/lib/asset-context";
import { getDataDir, getOutputDir, getUploadsDir } from "@/lib/paths";
import { probeMedia, type MediaProbe } from "@/lib/media-probe";
import { generateSpeechFreeDetailed, type TTSWord } from "@/lib/edge-tts";
import { stripPauseMarks } from "@/lib/voice-markup";
import { compositionErrorMessage, saveCompositionError } from "@/lib/composition-error";
import { composeVideo, type ClipInput, type ComposeConfig } from "@/lib/video-composer/composer";
import { buildSubtitleTimeline, padDurationsForFade, segmentBoundaries } from "@/lib/video-composer/timeline";
import { extractFirstFrame } from "@/lib/video-composer/frame-extract";
import { contentHash } from "./inputs";
import { KlingError } from "./errors";
import { klingFilmRuns, klingFilmShots, type KlingFilmRun, type KlingFilmShot } from "./film-schema";
import { assertKlingFilmLease } from "./film-repository";
import { isTideweNativeSpeech, isTideweOutdoorProfile } from "@/lib/creative-profiles";
import { resolveNarrationVoice } from "@/lib/narration-voice";
import { assertTideweScript } from "@/lib/tidewe/validation";
import { assertTideweMediaDuration } from "@/lib/tidewe/visual-policy";

interface FilmQuality { width: number; height: number; duration: number; hasAudio: boolean }
export interface KlingFilmCompositionResult {
  compositionId: string;
  url: string;
  thumbnailUrl?: string;
  quality: FilmQuality;
}
export interface KlingFilmComposeHooks { assertOwned(): void; beforeRender?(): void }

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const SOURCE_HASH = /^[a-f0-9]{64}$/;
const TRANSITIONS = new Set(["ai_start_end", "ai_reference", "direct_concat", "ffmpeg_fade"]);

function failure(code: string, message: string): KlingError { return new KlingError(code, message, 409); }
async function isFile(path: string): Promise<boolean> { return stat(path).then((value) => value.isFile() && value.size > 0).catch(() => false); }
async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function isChild(root: string, path: string): boolean {
  const child = relative(root, path);
  return Boolean(child) && child !== ".." && !child.startsWith(".." + "/") && !child.startsWith(".." + "\\") && !isAbsolute(child);
}
function assertVideo(probe: MediaProbe, message: string): void {
  if (!Number.isFinite(probe.duration) || probe.duration <= 0 || !Number.isFinite(probe.width) || probe.width <= 0 ||
    !Number.isFinite(probe.height) || probe.height <= 0) throw failure("KLING_FILM_MEDIA_INVALID", message);
}

/** Resolve only local media routes, and reject symlinks escaping their storage root. */
async function localVideoPath(url: string, sourcePath: string): Promise<string> {
  let root: string;
  let suffix: string;
  if (url.startsWith("/api/files/")) { root = getUploadsDir(); suffix = url.slice("/api/files/".length); }
  else if (url.startsWith("/api/output/")) { root = getOutputDir(); suffix = url.slice("/api/output/".length); }
  else throw failure("KLING_FILM_LOCAL_VIDEO_REQUIRED", "整片合成只接受已保存到本机的镜头视频，请先恢复素材入库。");
  try {
    const decoded = decodeURIComponent(suffix);
    if (!decoded || decoded.includes("\0") || decoded.includes("?") || decoded.includes("#") || !isAbsolute(sourcePath)) throw new Error("Invalid media path");
    const actualRoot = await realpath(root);
    const candidate = await realpath(resolve(actualRoot, decoded));
    const snapshotPath = await realpath(sourcePath);
    if (!isChild(actualRoot, candidate) || candidate !== snapshotPath || !await isFile(candidate)) throw new Error("Media path changed");
    return candidate;
  } catch {
    throw failure("KLING_FILM_SOURCE_CHANGED", "锁定的镜头视频已移动、丢失或不在本机素材目录中，请恢复原素材后重试合成。");
  }
}

function loadPlan(runId: string): { run: KlingFilmRun; shots: KlingFilmShot[]; compositionId: string; fingerprint: string } {
  const db = getDb();
  const run = db.select().from(klingFilmRuns).where(eq(klingFilmRuns.id, runId)).get();
  if (!run) throw failure("KLING_FILM_NOT_FOUND", "没有找到此整片任务。");
  const compositionId = run.data.compositionId;
  if (!compositionId || ![run.id, run.projectId, compositionId].every((id) => SAFE_ID.test(id))) throw failure("KLING_FILM_COMPOSITION_NOT_PREPARED", "整片合成记录尚未准备完成，请刷新任务后恢复。");
  const settings = run.data.output;
  if (isTideweOutdoorProfile(run.data.creativeProfile)) {
    const nativeSpeech = isTideweNativeSpeech(run.data.creativeProfile);
    try {
      assertTideweScript(run.data.scriptSnapshot);
      if (!nativeSpeech) resolveNarrationVoice(run.data.creativeProfile, settings.voice);
    } catch (error) { throw failure("TIDEWE_SCRIPT_INVALID", error instanceof Error ? error.message : "TIDEWE 口播快照无效"); }
    if (settings.audioStrategy !== (nativeSpeech ? "native" : "edge-tts") || settings.narrationMode !== undefined) {
      throw failure("TIDEWE_OUTPUT_POLICY", nativeSpeech
        ? "TIDEWE 真人口播必须保留视频原生英语声音，不能重复添加 TTS，请重新预览计划。"
        : "TIDEWE 画外音整片必须添加已确认英文旁白并替换源人声，请重新预览计划。");
    }
    if (run.data.scriptSnapshot.shots.some((shot) => Boolean(shot.narration?.trim()))) throw failure("TIDEWE_COPY_DOCUMENT_REQUIRED", "TIDEWE 不能使用 legacy narration 覆盖规范原文。");
  }
  if (!["720p", "1080p"].includes(settings.resolution) || !["9:16", "16:9", "1:1"].includes(settings.aspectRatio) ||
    !["edge-tts", "edge-tts-mix", "native"].includes(settings.audioStrategy) || typeof settings.subtitles !== "boolean" ||
    typeof settings.voice !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(settings.voice) ||
    (settings.narrationMode !== undefined && !["none", "restrained"].includes(settings.narrationMode))) throw failure("KLING_FILM_OUTPUT_INVALID", "整片输出配置无效，请重新预览整片计划。");
  const shots = db.select().from(klingFilmShots).where(eq(klingFilmShots.runId, runId)).orderBy(asc(klingFilmShots.ordinal)).all();
  const snapshot = run.data.scriptSnapshot.shots;
  if (!snapshot.length || shots.length !== snapshot.length || shots.some((item, ordinal) => {
    const shot = snapshot[ordinal];
    return item.ordinal !== ordinal || item.shotId !== shot.shotId || contentHash(item.data.shot) !== contentHash(shot) ||
      !Number.isFinite(shot.duration) || shot.duration <= 0 || !TRANSITIONS.has(shot.transition) ||
      item.status !== "ready" || !item.assetId || !item.data.sourceFilePath || !item.data.videoUrl || !SOURCE_HASH.test(item.data.sourceFileHash ?? "");
  })) throw failure("KLING_FILM_SHOTS_NOT_READY", "仍有镜头没有完成本机入库，或镜头快照不一致；请恢复对应镜头后再合成。");
  const fingerprint = contentHash({ runId, compositionId, planHash: run.data.planHash, output: settings, script: run.data.scriptSnapshot,
    shots: shots.map((item) => ({ assetId: item.assetId, filePath: item.data.videoUrl, hash: item.data.sourceFileHash })) });
  return { run, shots, compositionId, fingerprint };
}

async function immutableSource(run: KlingFilmRun, shot: KlingFilmShot, workDir: string): Promise<{ path: string; probe: MediaProbe }> {
  const asset = getDb().select().from(assets).where(eq(assets.id, shot.assetId!)).get();
  if (!asset || asset.projectId !== run.projectId || asset.shotId !== shot.shotId || asset.status !== "done" ||
    asset.filePath !== shot.data.videoUrl ||
    !assetMatchesScript(asset, { id: run.scriptId, shots: run.data.scriptSnapshot.shots })) {
    throw failure("KLING_FILM_ASSET_CHANGED", `镜头 ${shot.shotId} 锁定的素材归属或文件地址已改变，请恢复原素材后重试合成。`);
  }
  const source = await localVideoPath(shot.data.videoUrl!, shot.data.sourceFilePath!);
  // Render from a verified private copy. Changes to the original during FFmpeg cannot replace a frozen take.
  const destination = join(workDir, `source-${shot.ordinal}-${shot.data.sourceFileHash}.media`);
  if (!await isFile(destination) || await hashFile(destination) !== shot.data.sourceFileHash) {
    if (await hashFile(source) !== shot.data.sourceFileHash) throw failure("KLING_FILM_SOURCE_CHANGED", `镜头 ${shot.shotId} 的本机视频内容已改变，无法继续使用已确认的整片计划。`);
    const part = destination + ".part";
    await copyFile(source, part);
    if (await hashFile(part) !== shot.data.sourceFileHash) {
      await rm(part, { force: true });
      throw failure("KLING_FILM_SOURCE_CHANGED", `镜头 ${shot.shotId} 的本机视频在读取期间发生改变，请恢复原素材后重试。`);
    }
    await rename(part, destination);
  }
  const probe = await probeMedia(destination);
  assertVideo(probe, `镜头 ${shot.shotId} 的本机文件不能解析为有效视频。`);
  return { path: destination, probe };
}

interface Narration { path: string; duration: number; words: TTSWord[] }
async function narration(shot: KlingFilmShot, voice: string, workDir: string): Promise<Narration | undefined> {
  const text = shot.data.shot.voiceover?.trim();
  if (!text || !stripPauseMarks(text).trim()) return undefined;
  const key = contentHash({ text, voice, rate: "+0%", version: 1 });
  const path = join(workDir, `voice-${shot.ordinal}-${key}.mp3`);
  const metadataPath = path + ".json";
  try {
    const metadata: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
    if (metadata && typeof metadata === "object" && "key" in metadata && metadata.key === key && "words" in metadata && Array.isArray(metadata.words) && await isFile(path)) {
      const probe = await probeMedia(path);
      if (probe.hasAudio && probe.duration > 0 && Number.isFinite(probe.duration)) return { path, duration: probe.duration, words: metadata.words as TTSWord[] };
    }
  } catch { /* An incomplete cache is regenerated; it never licenses a silent fallback. */ }
  try {
    const speech = await generateSpeechFreeDetailed(text, { voice, rate: "+0%" });
    if (!speech.audio.length) throw new Error("免费配音服务返回空音频");
    const part = path + ".part";
    await writeFile(part, speech.audio);
    const probe = await probeMedia(part);
    if (!probe.hasAudio || !Number.isFinite(probe.duration) || probe.duration <= 0) throw new Error("免费配音音频无法解析或没有有效时长");
    await rename(part, path);
    await writeFile(metadataPath + ".part", JSON.stringify({ key, words: speech.words }), "utf8");
    await rename(metadataPath + ".part", metadataPath);
    return { path, duration: probe.duration, words: speech.words };
  } catch (error) {
    throw failure("KLING_FILM_NARRATION_FAILED", `镜头 ${shot.shotId} 免费配音失败：${compositionErrorMessage(error)}。修复后可恢复合成，已入库视频会继续复用。`);
  }
}

function outputQuality(probe: MediaProbe, run: KlingFilmRun, expectedDuration: number, audioRequired: boolean): FilmQuality {
  assertVideo(probe, "FFmpeg 输出不是有效视频，请恢复合成。");
  const short = run.data.output.resolution === "720p" ? 720 : 1080;
  const [width, height] = run.data.output.aspectRatio === "9:16" ? [short, short / 9 * 16] :
    run.data.output.aspectRatio === "16:9" ? [short / 9 * 16, short] : [short, short];
  if (probe.width !== width || probe.height !== height || Math.abs(probe.duration - expectedDuration) > Math.max(0.5, expectedDuration * 0.02) || (audioRequired && !probe.hasAudio)) {
    throw failure("KLING_FILM_OUTPUT_INVALID", "成片的尺寸、时长或音轨未通过检查，请恢复合成；已入库镜头无需重新生成。");
  }
  return { width: probe.width, height: probe.height, duration: probe.duration, hasAudio: probe.hasAudio };
}

/**
 * Local-only composition adapter. The film orchestrator owns its parent lease and status.
 * This module never selects current assets, queries a provider, or submits a generation.
 */
export async function composeKlingFilm(runId: string, hooks?: KlingFilmComposeHooks): Promise<KlingFilmCompositionResult> {
  const assertOwned = () => { assertKlingFilmLease(runId); hooks?.assertOwned(); };
  const beforeRender = () => { assertOwned(); hooks?.beforeRender?.(); };
  assertOwned();
  const { run, shots, compositionId, fingerprint } = loadPlan(runId);
  const tidewe = isTideweOutdoorProfile(run.data.creativeProfile);
  const tideweNative = isTideweNativeSpeech(run.data.creativeProfile);
  const db = getDb();
  const outputPath = join(getOutputDir(), run.projectId, `kling-film-${compositionId}.mp4`);
  const timelinePath = outputPath + ".timeline.json";
  const workDir = join(getDataDir(), "integrations", "kling", "films", run.id, "composition");
  const url = `/api/output/${run.projectId}/${basename(outputPath)}`;
  db.transaction((tx) => {
    assertOwned();
    const current = tx.select().from(compositions).where(eq(compositions.id, compositionId)).get();
    if (current && (current.projectId !== run.projectId || current.resolution !== run.data.output.resolution || current.aspectRatio !== run.data.output.aspectRatio || (current.outputPath && current.outputPath !== outputPath))) {
      throw failure("KLING_FILM_COMPOSITION_CONFLICT", "整片合成编号已关联其他输出，请刷新任务后恢复。");
    }
    if (!current) tx.insert(compositions).values({ id: compositionId, projectId: run.projectId, resolution: run.data.output.resolution,
      aspectRatio: run.data.output.aspectRatio, ttsEnabled: run.data.output.audioStrategy !== "native" && run.data.output.narrationMode !== "none", status: "pending", label: "Kling 自动整片" }).run();
  });
  try {
    await mkdir(dirname(outputPath), { recursive: true });
    assertOwned();
    await mkdir(workDir, { recursive: true });
    assertOwned();
    let quality: FilmQuality | undefined;
    if (await isFile(outputPath)) {
      const saved: unknown = JSON.parse(await readFile(timelinePath, "utf8").catch(() => "null"));
      assertOwned();
      if (!saved || typeof saved !== "object" || !("fingerprint" in saved) || saved.fingerprint !== fingerprint || !("total" in saved) || typeof saved.total !== "number" || !("audioRequired" in saved) || typeof saved.audioRequired !== "boolean") {
        throw failure("KLING_FILM_COMPOSITION_CONFLICT", "已存在的成片不匹配本次整片快照，请检查本机输出文件后恢复。");
      }
      try { quality = outputQuality(await probeMedia(outputPath), run, saved.total, saved.audioRequired); assertOwned(); }
      catch {
        assertOwned();
        // A damaged final file is recoverable with a free local render, under the same composition ID.
        await rm(outputPath, { force: true });
        assertOwned();
      }
    }
    if (!quality) {
      assertOwned();
      db.update(compositions).set({ status: "composing" }).where(eq(compositions.id, compositionId)).run();
      const rendered: Array<{ shot: KlingFilmShot; clip: ClipInput; voiceSec?: number; words?: TTSWord[] }> = [];
      for (const shot of shots) {
        assertOwned();
        const source = await immutableSource(run, shot, workDir);
        assertOwned();
        const native = run.data.output.audioStrategy === "native";
        const mix = run.data.output.audioStrategy === "edge-tts-mix";
        const narrationDisabled = run.data.output.narrationMode === "none";
        const preserveNativeAudio = native && source.probe.hasAudio;
        // Catalog metadata does not decide a model's abilities. Keep the returned audio;
        // when the returned clip has no track, add the approved copy during composition.
        const speech = preserveNativeAudio || narrationDisabled ? undefined : await narration(shot, resolveNarrationVoice(run.data.creativeProfile, run.data.output.voice), workDir);
        assertOwned();
        const duration = preserveNativeAudio ? source.probe.duration : Math.max(native ? source.probe.duration : shot.data.shot.duration, mix ? source.probe.duration : 0, speech ? speech.duration + 0.45 : 0);
        if (tidewe) assertTideweMediaDuration(shot.shotId, duration, source.probe.duration);
        rendered.push({ shot, clip: { type: "video", filePath: source.path, sourceDuration: source.probe.duration, duration,
          transition: tideweNative ? "direct_concat" : shot.data.shot.transition, hasAudio: (native || mix) && source.probe.hasAudio,
          ...(tidewe ? { strictSourceDuration: true } : {}),
          ...(tideweNative && preserveNativeAudio && stripPauseMarks(shot.data.shot.voiceover ?? "").trim() ? { preserveNativeSpeech: true } : {}),
          ...(speech ? { audioPath: speech.path, ...(mix && source.probe.hasAudio ? { mixNativeAudio: true } : {}) } : {}) },
          voiceSec: speech?.duration, words: speech?.words });
      }
      const durations = padDurationsForFade(rendered.map((item) => ({ duration: item.clip.duration, transition: item.clip.transition, hasVoice: Boolean(item.clip.hasAudio || item.clip.audioPath) })));
      rendered.forEach((item, index) => {
        item.clip.duration = durations[index];
        if (tidewe) assertTideweMediaDuration(item.shot.shotId, item.clip.duration, item.clip.sourceDuration ?? 0);
      });
      const timeline = buildSubtitleTimeline(rendered.map((item) => {
        const premiumCg = run.data.output.narrationMode !== undefined;
        const overlay = premiumCg || tidewe ? undefined : item.shot.data.shot.textOverlay;
        return { duration: item.clip.duration, transition: item.clip.transition,
          voiceover: !premiumCg && run.data.output.subtitles ? stripPauseMarks(item.shot.data.shot.voiceover ?? "") : undefined,
          voiceSec: item.voiceSec, words: item.words,
          ...(overlay && overlay.style !== "subtitle" ? { overlay: { text: overlay.text, style: overlay.style } } : {}) };
      }));
      const config: ComposeConfig = { projectId: run.projectId, clips: rendered.map((item) => item.clip),
        output: { resolution: run.data.output.resolution, aspectRatio: run.data.output.aspectRatio, videoPreset: "medium", crf: 20, voiceGround: false },
        ...(timeline.cues.length ? { subtitle: { texts: timeline.cues, position: "bottom" } } : {}),
        ...(timeline.overlays.length ? { overlays: timeline.overlays } : {}) };
      const audioRequired = rendered.some((item) => Boolean(item.clip.hasAudio || item.clip.audioPath));
      beforeRender();
      db.update(compositions).set({ ttsEnabled: rendered.some((item) => Boolean(item.clip.audioPath)) }).where(eq(compositions.id, compositionId)).run();
      const temporary = await composeVideo(config);
      assertOwned();
      quality = outputQuality(await probeMedia(temporary), run, timeline.total, audioRequired);
      assertOwned();
      // Sidecar first, final rename second: a crash after publication can always be recovered without re-rendering.
      await writeFile(timelinePath + ".part", JSON.stringify({ version: 1, runId, compositionId, fingerprint, planHash: run.data.planHash,
        audioStrategy: run.data.output.audioStrategy, audioRequired, total: timeline.total, boundaries: segmentBoundaries(config.clips),
        ...(tideweNative ? { speechMode: "on_camera", captionTiming: "segment-estimate" } : {}),
        shots: rendered.map((item) => ({ shotId: item.shot.shotId, assetId: item.shot.assetId, sourceHash: item.shot.data.sourceFileHash,
          duration: item.clip.duration, transition: item.clip.transition })), cues: timeline.cues }), "utf8");
      assertOwned();
      await rename(timelinePath + ".part", timelinePath);
      beforeRender();
      await rename(temporary, outputPath);
      assertOwned();
    }
    const thumbnailPath = await extractFirstFrame(outputPath);
    assertOwned();
    db.transaction((tx) => {
      beforeRender();
      tx.update(compositions).set({ outputPath, duration: Math.round(quality.duration * 1000), status: "done", ...(thumbnailPath ? { thumbnailPath } : {}) })
        .where(eq(compositions.id, compositionId)).run();
    });
    return { compositionId, url, ...(thumbnailPath ? { thumbnailUrl: url + ".thumb.jpg" } : {}), quality };
  } catch (error) {
    // An expired worker may not overwrite the replacement worker's composition status or diagnostics.
    assertOwned();
    await saveCompositionError(run.projectId, compositionId, error).catch(() => {});
    db.update(compositions).set({ status: "failed" }).where(eq(compositions.id, compositionId)).run();
    if (error instanceof KlingError) throw error;
    throw failure("KLING_FILM_COMPOSITION_FAILED", `本机整片合成失败：${compositionErrorMessage(error)}。修复后可恢复合成，已入库镜头无需重新生成。`);
  }
}
