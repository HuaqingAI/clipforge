// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { eq } from "drizzle-orm";
import type Database from "better-sqlite3";
import type { ComposeConfig } from "@/lib/video-composer/composer";
import type { Shot } from "@/lib/db/schema";
import type { KlingFilmRun, KlingFilmShot } from "@/lib/kling/film-schema";

const state = vi.hoisted(() => ({ directory: "", sqlite: null as Database.Database | null,
  compose: vi.fn(), tts: vi.fn(), probe: vi.fn(), poster: vi.fn(), sourceAudio: true,
  output: { duration: 5, width: 720, height: 1280, hasAudio: true }, renders: 0 }));
vi.mock("@/lib/paths", () => ({
  getDataDir: () => state.directory, getUploadsDir: () => path.join(state.directory, "uploads"), getOutputDir: () => path.join(state.directory, "output"),
}));
vi.mock("@/lib/db", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  state.sqlite = new Database(":memory:");
  const db = drizzle(state.sqlite);
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return { getDb: () => db };
});
vi.mock("@/lib/video-composer/composer", async (original) => ({
  ...await original<typeof import("@/lib/video-composer/composer")>(), composeVideo: (...args: unknown[]) => state.compose(...args),
}));
vi.mock("@/lib/media-probe", () => ({ probeMedia: (...args: unknown[]) => state.probe(...args) }));
vi.mock("@/lib/edge-tts", () => ({ generateSpeechFreeDetailed: (...args: unknown[]) => state.tts(...args) }));
vi.mock("@/lib/video-composer/frame-extract", () => ({ extractFirstFrame: (...args: unknown[]) => state.poster(...args) }));

import { getDb } from "@/lib/db";
import { assets, compositions, projects } from "@/lib/db/schema";
import { klingFilmRuns, klingFilmShots } from "@/lib/kling/film-schema";
import { composeKlingFilm } from "@/lib/kling/film-compose";
import { contentHash } from "@/lib/kling/inputs";
import { assetScopeForShot, scriptRevision, shotKey } from "@/lib/asset-context";
import { readCompositionError } from "@/lib/composition-error";
import { KlingError } from "@/lib/kling/errors";
import { ffmpegBin } from "@/lib/ffmpeg-path";
import { createTideweOutdoorProfile } from "@/lib/creative-profiles";
import { productFactsFromDescription } from "@/lib/tidewe/facts";
import { englishWordCount, productFactsHash } from "@/lib/tidewe/validation";

const baseShot: Shot = { shotId: 1, type: "demo", duration: 5, description: "Show the product", camera: "static",
  visualSource: "ai_generate", transition: "direct_concat", voiceover: "This is our product." };
function getRun(): KlingFilmRun { return getDb().select().from(klingFilmRuns).get()!; }
function updateRun(patch: Partial<KlingFilmRun["data"]>): void {
  getDb().update(klingFilmRuns).set({ data: { ...getRun().data, ...patch } }).run();
}
function getShot(): KlingFilmShot { return getDb().select().from(klingFilmShots).orderBy(klingFilmShots.ordinal).get()!; }
function updateShot(patch: Partial<KlingFilmShot>, data: Partial<KlingFilmShot["data"]> = {}): void {
  const shot = getShot();
  getDb().update(klingFilmShots).set({ ...patch, data: { ...shot.data, ...data } }).where(eq(klingFilmShots.id, shot.id)).run();
}
async function addShot(ordinal: number, partial: Partial<Shot> = {}): Promise<void> {
  const shot = { ...baseShot, shotId: ordinal + 1, ...partial };
  const name = `shot-${shot.shotId}.mp4`;
  const local = path.join(state.directory, "uploads", "project-1", name);
  const source = `local-video-${shot.shotId}`;
  await fs.mkdir(path.dirname(local), { recursive: true });
  await fs.writeFile(local, source);
  const assetId = `asset-${shot.shotId}`;
  const videoUrl = `/api/files/project-1/${name}`;
  getDb().insert(assets).values({ id: assetId, projectId: "project-1", shotId: shot.shotId, type: "ai_generated", filePath: videoUrl,
    provider: "kling-cli", selected: true, status: "done", sourceScriptId: "script-1", sourceRevision: "frozen-revision", sourceShotKey: shotKey("script-1", shot) }).run();
  getDb().insert(klingFilmShots).values({ id: `film-shot-${shot.shotId}`, runId: "run-1", shotId: shot.shotId, ordinal, status: "ready", assetId,
    data: { shot, source: "reuse", prompt: "Frozen prompt", options: {}, missingKeyframe: false, inputs: [], baselineAssetId: assetId,
      sourceFilePath: local, videoUrl, sourceFileHash: createHash("sha256").update(source).digest("hex"), attempt: 1 }, updatedAt: Date.now() }).run();
  const run = getRun();
  updateRun({ scriptSnapshot: { shots: [...run.data.scriptSnapshot.shots, shot] } });
}

function tideweRun(speechMode: "on_camera" | "voiceover", transition: Shot["transition"] = "direct_concat"): void {
  const profile = createTideweOutdoorProfile({ speechMode });
  const facts = productFactsFromDescription("", "hunting_chair");
  const text = baseShot.voiceover!;
  const shot: Shot = { ...baseShot, transition, description: "猎人在林边自然展示装备。", camera: "稳定中景",
    prompt: "林边自然光，人物动作真实。", visualIntent: "呈现真实户外使用场景",
    tidewe: { copySpan: { start: 0, end: text.length }, translation: "这是我们的产品。", shotGoal: "真实展示装备",
      productVisible: true, factRefs: [], sceneId: "woods" } };
  const snapshot: KlingFilmRun["data"]["scriptSnapshot"] = { shots: [shot], copyDocument: {
    version: 1, language: "en-US", text, translation: "这是我们的产品。", angle: "practical_choice", hookType: "question",
    claimedFactIds: [], factsSnapshot: facts, factsHash: productFactsHash(facts), corpusVersion: profile.corpusVersion,
    compilerVersion: profile.promptCompilerVersion, exampleIds: [], wordCount: englishWordCount(text), estimatedDuration: 2,
  } };
  updateShot({}, { shot });
  getDb().update(assets).set(assetScopeForShot({ id: "script-1", ...snapshot }, shot)).run();
  updateRun({ creativeProfile: profile, scriptSnapshot: snapshot,
    output: { ...getRun().data.output, voice: "en-US-GuyNeural", audioStrategy: speechMode === "on_camera" ? "native" : "edge-tts" } });
}

beforeEach(async () => {
  if (state.directory) await fs.rm(state.directory, { recursive: true, force: true });
  state.directory = await fs.mkdtemp(path.join(os.tmpdir(), "clipforge-film-compose-"));
  state.sqlite!.exec("DROP TRIGGER IF EXISTS reject_film_done; DELETE FROM kling_film_shots; DELETE FROM kling_film_runs; DELETE FROM compositions; DELETE FROM assets; DELETE FROM projects;");
  vi.clearAllMocks(); state.sourceAudio = true; state.renders = 0;
  state.output = { duration: 5, width: 720, height: 1280, hasAudio: true };
  getDb().insert(projects).values({ id: "project-1", name: "Frozen project" }).run();
  getDb().insert(klingFilmRuns).values({ id: "run-1", projectId: "project-1", scriptId: "script-1", profileId: "profile-1", principalKey: "account-1",
    status: "composing", data: { scriptRevision: "frozen-revision", scriptSnapshot: { shots: [] }, model: {} as KlingFilmRun["data"]["model"],
      output: { resolution: "720p", aspectRatio: "9:16", audioStrategy: "native", voice: "zh-CN-XiaoxiaoNeural", subtitles: true },
      planHash: "frozen-plan", expiresAt: Date.now() + 60000, reuseExistingVideos: true, warnings: [], stage: "composing", authorizationEpoch: 1,
      compositionId: "composition-1" }, createdAt: Date.now(), updatedAt: Date.now() }).run();
  await addShot(0);
  state.probe.mockImplementation(async (file: string) => {
    if (file.includes("voice-")) return { duration: 2, width: 0, height: 0, hasAudio: true, frameRate: 30 };
    return { ...(file.endsWith(".media") ? { duration: 5, width: 1280, height: 720, hasAudio: state.sourceAudio } : state.output), frameRate: 30 };
  });
  state.tts.mockResolvedValue({ audio: Buffer.from("fixture-audio"), words: [{ text: "Product", startSec: 0, endSec: 1.9 }] });
  state.compose.mockImplementation(async (config: ComposeConfig) => {
    const duration = config.clips.reduce((total, clip, index) => total + clip.duration - (index > 0 && clip.transition === "ffmpeg_fade" ? 0.5 : 0), 0);
    state.output.duration = duration;
    const output = path.join(state.directory, "output", config.projectId, `final_test-${++state.renders}.mp4`);
    await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, "rendered-film");
    return output;
  });
  state.poster.mockImplementation(async (file: string) => { const thumbnail = file + ".thumb.jpg"; await fs.writeFile(thumbnail, "poster"); return thumbnail; });
});
afterAll(async () => { state.sqlite?.close(); if (state.directory) await fs.rm(state.directory, { recursive: true, force: true }); });

describe("Kling frozen local film composition", () => {
  it("preserves native TIDEWE speech at full source length with hard cuts and no second voice", async () => {
    tideweRun("on_camera", "ffmpeg_fade");
    await composeKlingFilm("run-1");
    const config = state.compose.mock.calls[0][0] as ComposeConfig;
    expect(config.clips[0]).toMatchObject({ hasAudio: true, duration: 5, sourceDuration: 5,
      strictSourceDuration: true, preserveNativeSpeech: true, transition: "direct_concat" });
    expect(config.clips[0].audioPath).toBeUndefined();
    expect(config.clips[0].mixNativeAudio).toBeUndefined();
    expect(state.tts).not.toHaveBeenCalled();
    expect(getDb().select().from(compositions).get()).toMatchObject({ ttsEnabled: false, status: "done" });
    const timeline = JSON.parse(await fs.readFile(path.join(state.directory, "output/project-1/kling-film-composition-1.mp4.timeline.json"), "utf8"));
    expect(timeline).toMatchObject({ speechMode: "on_camera", captionTiming: "segment-estimate", audioStrategy: "native" });
  });

  it("keeps historical TIDEWE voiceover plans on the English post-production voice path", async () => {
    tideweRun("voiceover");
    await composeKlingFilm("run-1");
    const config = state.compose.mock.calls[0][0] as ComposeConfig;
    expect(state.tts).toHaveBeenCalledWith(baseShot.voiceover, { voice: "en-US-GuyNeural", rate: "+0%" });
    expect(config.clips[0]).toMatchObject({ hasAudio: false, strictSourceDuration: true });
    expect(config.clips[0].audioPath).toMatch(/\.mp3$/);
    expect(config.clips[0].preserveNativeSpeech).toBeUndefined();
  });

  it("fails native TIDEWE dialogue without a source audio track", async () => {
    tideweRun("on_camera");
    state.sourceAudio = false;
    await expect(composeKlingFilm("run-1")).rejects.toMatchObject({ code: "KLING_FILM_NATIVE_AUDIO_MISSING" });
    expect(state.tts).not.toHaveBeenCalled();
    expect(state.compose).not.toHaveBeenCalled();
    expect(await readCompositionError("project-1", "composition-1")).toContain("不能用 TTS 代替真人口播");
  });

  it.each(["edge-tts", "edge-tts-mix"] as const)("rejects a native TIDEWE plan changed to %s", async audioStrategy => {
    tideweRun("on_camera");
    updateRun({ output: { ...getRun().data.output, audioStrategy } });
    await expect(composeKlingFilm("run-1")).rejects.toMatchObject({ code: "TIDEWE_OUTPUT_POLICY" });
    expect(state.tts).not.toHaveBeenCalled();
    expect(state.compose).not.toHaveBeenCalled();
  });

  it("uses the frozen asset even after selection changes, and keeps the snapshot in a private verified copy", async () => {
    getDb().update(assets).set({ selected: false }).run();
    getDb().insert(assets).values({ id: "new-selected", projectId: "project-1", shotId: 1, type: "ai_generated", filePath: "/api/files/project-1/other.mp4", selected: true, status: "done" }).run();
    const result = await composeKlingFilm("run-1");
    expect(result).toMatchObject({ compositionId: "composition-1", url: "/api/output/project-1/kling-film-composition-1.mp4", quality: { duration: 5, width: 720, height: 1280, hasAudio: true } });
    const config = state.compose.mock.calls[0][0] as ComposeConfig;
    expect(await fs.readFile(config.clips[0].filePath, "utf8")).toBe("local-video-1");
    expect(config.clips[0].filePath).toContain(path.join("integrations", "kling", "films", "run-1", "composition"));
    expect(config.clips[0].hasAudio).toBe(true); expect(state.tts).not.toHaveBeenCalled();
    expect(getDb().select().from(compositions).all()).toHaveLength(1);
    expect(getDb().select().from(compositions).get()).toMatchObject({ id: "composition-1", status: "done", duration: 5000 });
  });

  it("is idempotent after completion and recovers publication when the final DB write failed", async () => {
    state.sqlite!.exec("CREATE TRIGGER reject_film_done BEFORE UPDATE ON compositions WHEN NEW.status = 'done' BEGIN SELECT RAISE(ABORT, 'fixture final write failed'); END");
    await expect(composeKlingFilm("run-1")).rejects.toMatchObject({ code: "KLING_FILM_COMPOSITION_FAILED" });
    state.sqlite!.exec("DROP TRIGGER reject_film_done");
    const first = await composeKlingFilm("run-1");
    const duplicate = await composeKlingFilm("run-1");
    expect(duplicate.url).toBe(first.url); expect(state.compose).toHaveBeenCalledTimes(1);
    expect(getDb().select().from(compositions).all()).toHaveLength(1);
  });

  it("refuses changed source bytes without selecting or generating an alternative", async () => {
    await fs.writeFile(getShot().data.sourceFilePath!, "changed source");
    await expect(composeKlingFilm("run-1")).rejects.toMatchObject({ code: "KLING_FILM_SOURCE_CHANGED" });
    expect(state.compose).not.toHaveBeenCalled(); expect(state.tts).not.toHaveBeenCalled();
    expect(getDb().select().from(compositions).get()?.status).toBe("failed");
  });

  it("reuses an unchanged shot generated before a sibling camera edit", async () => {
    const originalSibling = { ...baseShot, shotId: 2 };
    const originalScript = { id: "script-1", shots: [baseShot, originalSibling] };
    await addShot(1, { camera: "Slow push in" });
    const currentScript = { id: "script-1", shots: getRun().data.scriptSnapshot.shots };
    getDb().update(assets).set(assetScopeForShot(originalScript, baseShot)).where(eq(assets.id, "asset-1")).run();
    getDb().update(assets).set(assetScopeForShot(currentScript, currentScript.shots[1])).where(eq(assets.id, "asset-2")).run();
    updateRun({ scriptRevision: scriptRevision(currentScript) });

    await composeKlingFilm("run-1");
    const config = state.compose.mock.calls[0][0] as ComposeConfig;
    expect(await fs.readFile(config.clips[0].filePath, "utf8")).toBe("local-video-1");
    expect(config.clips).toHaveLength(2);
    expect(getDb().select().from(compositions).get()?.status).toBe("done");
  });

  it("retains compatibility for frozen legacy assets with no scope", async () => {
    getDb().update(assets).set({ sourceScriptId: null, sourceRevision: null, sourceShotKey: null }).run();
    await composeKlingFilm("run-1");
    expect(state.compose).toHaveBeenCalledTimes(1);
  });

  it.each(["project", "shot", "script", "file-path"])("refuses a frozen asset whose %s binding changed", async (field) => {
    const patch = field === "project" ? { projectId: "other-project" } : field === "shot" ? { shotId: 99 } : field === "script" ? { sourceScriptId: "other-script" } :
      { filePath: "/api/files/project-1/other.mp4" };
    if (field === "project") getDb().insert(projects).values({ id: "other-project", name: "Other" }).run();
    getDb().update(assets).set(patch).where(eq(assets.id, "asset-1")).run();
    await expect(composeKlingFilm("run-1")).rejects.toMatchObject({ code: "KLING_FILM_ASSET_CHANGED" });
    expect(state.compose).not.toHaveBeenCalled();
  });

  it("refuses a partially scoped frozen asset without its script owner", async () => {
    getDb().update(assets).set({ sourceScriptId: null }).where(eq(assets.id, "asset-1")).run();
    await expect(composeKlingFilm("run-1")).rejects.toMatchObject({ code: "KLING_FILM_ASSET_CHANGED" });
    expect(state.compose).not.toHaveBeenCalled();
  });

  it.each(["sourceRevision", "sourceShotKey"] as const)("composes a same-script asset without optional %s metadata", async (field) => {
    getDb().update(assets).set({ [field]: null }).where(eq(assets.id, "asset-1")).run();
    await composeKlingFilm("run-1");
    expect(state.compose).toHaveBeenCalledOnce();
  });

  it("composes a same-script asset with historical shot hash metadata", async () => {
    getDb().update(assets).set({ sourceShotKey: "old-shot-key" }).where(eq(assets.id, "asset-1")).run();
    await composeKlingFilm("run-1");
    expect(state.compose).toHaveBeenCalledOnce();
  });

  it.each(["https://cdn.example/video.mp4", "/api/files/../../private.mp4"])("refuses non-local or escaped frozen video paths: %s", async (videoUrl) => {
    getDb().update(assets).set({ filePath: videoUrl }).run(); updateShot({}, { videoUrl });
    await expect(composeKlingFilm("run-1")).rejects.toMatchObject({ code: videoUrl.startsWith("https:") ? "KLING_FILM_LOCAL_VIDEO_REQUIRED" : "KLING_FILM_SOURCE_CHANGED" });
    expect(state.compose).not.toHaveBeenCalled();
  });

  it("waits for every frozen shot and rejects a changed snapshot", async () => {
    await addShot(1); updateShot({ status: "waiting" });
    await expect(composeKlingFilm("run-1")).rejects.toMatchObject({ code: "KLING_FILM_SHOTS_NOT_READY" });
    updateShot({ status: "ready" }, { shot: { ...baseShot, voiceover: "Changed after planning" } });
    await expect(composeKlingFilm("run-1")).rejects.toMatchObject({ code: "KLING_FILM_SHOTS_NOT_READY" });
    expect(state.compose).not.toHaveBeenCalled();
  });

  it("does not silently compose missing native dialogue audio", async () => {
    state.sourceAudio = false;
    await expect(composeKlingFilm("run-1")).rejects.toMatchObject({ code: "KLING_FILM_NATIVE_AUDIO_MISSING" });
    expect(state.compose).not.toHaveBeenCalled(); expect(state.tts).not.toHaveBeenCalled();
  });

  it("generates explicit free narration and word-timed captions while disabling source audio", async () => {
    updateRun({ output: { ...getRun().data.output, audioStrategy: "edge-tts" } });
    await composeKlingFilm("run-1");
    const config = state.compose.mock.calls[0][0] as ComposeConfig;
    expect(state.tts).toHaveBeenCalledWith(baseShot.voiceover, { voice: "zh-CN-XiaoxiaoNeural", rate: "+0%" });
    expect(config.clips[0]).toMatchObject({ hasAudio: false, duration: 5 });
    expect(config.clips[0].mixNativeAudio).toBeUndefined();
    expect(config.clips[0].audioPath).toMatch(/\.mp3$/); expect(config.subtitle?.texts.length).toBeGreaterThan(0);
  });

  it.each([
    { sourceDuration: 8, speechDuration: 2, expected: 8 },
    { sourceDuration: 3, speechDuration: 2, expected: 5 },
    { sourceDuration: 8, speechDuration: 10, expected: 10.45 },
  ])("mixes narration with source audio without truncating either track: %j", async ({ sourceDuration, speechDuration, expected }) => {
    updateRun({ output: { ...getRun().data.output, audioStrategy: "edge-tts-mix" } });
    const probe = state.probe.getMockImplementation()!;
    state.probe.mockImplementation(async (file: string) => {
      const result = await probe(file);
      return { ...result, ...(file.endsWith(".media") ? { duration: sourceDuration } : file.includes("voice-") ? { duration: speechDuration } : {}) };
    });
    const result = await composeKlingFilm("run-1");
    const config = state.compose.mock.calls[0][0] as ComposeConfig;
    expect(state.tts).toHaveBeenCalledWith(baseShot.voiceover, { voice: "zh-CN-XiaoxiaoNeural", rate: "+0%" });
    expect(config.clips[0]).toMatchObject({ hasAudio: true, mixNativeAudio: true, sourceDuration, duration: expected });
    expect(config.clips[0].audioPath).toMatch(/\.mp3$/);
    expect(config.subtitle?.texts.length).toBeGreaterThan(0);
    expect(result.quality.duration).toBeCloseTo(expected, 5);
    expect(getDb().select().from(compositions).get()).toMatchObject({ ttsEnabled: true, status: "done", duration: Math.round(expected * 1000) });
    const timeline = JSON.parse(await fs.readFile(path.join(state.directory, "output/project-1/kling-film-composition-1.mp4.timeline.json"), "utf8"));
    expect(timeline).toMatchObject({ audioStrategy: "edge-tts-mix", audioRequired: true, total: expected });
  });

  it("uses narration alone for silent video under the mix strategy", async () => {
    updateRun({ output: { ...getRun().data.output, audioStrategy: "edge-tts-mix" } });
    state.sourceAudio = false;
    await composeKlingFilm("run-1");
    const config = state.compose.mock.calls[0][0] as ComposeConfig;
    expect(config.clips[0]).toMatchObject({ hasAudio: false, sourceDuration: 5, duration: 5 });
    expect(config.clips[0].audioPath).toMatch(/\.mp3$/);
    expect(config.clips[0].mixNativeAudio).toBeUndefined();
    expect(state.tts).toHaveBeenCalledTimes(1);
  });

  it("preserves native audio for shots without narration and protects the fade boundary in mix mode", async () => {
    updateRun({ output: { ...getRun().data.output, audioStrategy: "edge-tts-mix" } });
    await addShot(1, { voiceover: undefined, duration: 3, transition: "ffmpeg_fade" });
    const result = await composeKlingFilm("run-1");
    const config = state.compose.mock.calls[0][0] as ComposeConfig;
    expect(config.clips[0]).toMatchObject({ hasAudio: true, mixNativeAudio: true, duration: 5.5 });
    expect(config.clips[1]).toMatchObject({ hasAudio: true, duration: 5 });
    expect(config.clips[1].audioPath).toBeUndefined();
    expect(config.clips[1].mixNativeAudio).toBeUndefined();
    expect(state.tts).toHaveBeenCalledTimes(1);
    expect(result.quality.duration).toBe(10);
  });

  it.each(["edge-tts", "edge-tts-mix"] as const)("stops on %s failure and resumes the same composition without dropping narration", async (audioStrategy) => {
    updateRun({ output: { ...getRun().data.output, audioStrategy } });
    state.tts.mockRejectedValueOnce(new Error("voice service unavailable"));
    await expect(composeKlingFilm("run-1")).rejects.toMatchObject({ code: "KLING_FILM_NARRATION_FAILED" });
    expect(state.compose).not.toHaveBeenCalled(); expect(await readCompositionError("project-1", "composition-1")).toContain("voice service unavailable");
    await composeKlingFilm("run-1");
    expect(state.compose).toHaveBeenCalledTimes(1); expect(getDb().select().from(compositions).all()).toHaveLength(1);
  });

  it.each(["edge-tts", "edge-tts-mix"] as const)("retains cached %s narration across an FFmpeg failure and a later retry", async (audioStrategy) => {
    updateRun({ output: { ...getRun().data.output, audioStrategy } });
    state.compose.mockRejectedValueOnce(new Error("encoder unavailable"));
    await expect(composeKlingFilm("run-1")).rejects.toMatchObject({ code: "KLING_FILM_COMPOSITION_FAILED" });
    await composeKlingFilm("run-1");
    expect(state.tts).toHaveBeenCalledTimes(1); expect(state.compose).toHaveBeenCalledTimes(2);
  });

  it("checks final dimensions and audio, and leaves a recoverable failed composition", async () => {
    state.output.hasAudio = false;
    await expect(composeKlingFilm("run-1")).rejects.toMatchObject({ code: "KLING_FILM_OUTPUT_INVALID" });
    expect(getDb().select().from(compositions).get()?.status).toBe("failed");
    state.output.hasAudio = true;
    await composeKlingFilm("run-1");
    expect(getDb().select().from(compositions).all()).toHaveLength(1);
  });

  it("matches fade boundaries and preserves complete native audio duration", async () => {
    await addShot(1, { transition: "ffmpeg_fade" });
    const result = await composeKlingFilm("run-1");
    const config = state.compose.mock.calls[0][0] as ComposeConfig;
    expect(config.clips.map((item) => item.duration)).toEqual([5.5, 5]);
    expect(result.quality.duration).toBe(10);
    const timeline = JSON.parse(await fs.readFile(path.join(state.directory, "output/project-1/kling-film-composition-1.mp4.timeline.json"), "utf8"));
    expect(timeline.boundaries).toEqual([5]); expect(timeline.shots.map((item: { assetId: string }) => item.assetId)).toEqual(["asset-1", "asset-2"]);
    expect(timeline.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("never adopts a final file belonging to a different frozen plan", async () => {
    await composeKlingFilm("run-1"); updateRun({ planHash: contentHash("another-plan") });
    await expect(composeKlingFilm("run-1")).rejects.toMatchObject({ code: "KLING_FILM_COMPOSITION_CONFLICT" });
    expect(state.compose).toHaveBeenCalledTimes(1);
  });

  it("refuses to reuse a published film after its audio strategy changes", async () => {
    updateRun({ output: { ...getRun().data.output, audioStrategy: "edge-tts" } });
    await composeKlingFilm("run-1");
    updateRun({ output: { ...getRun().data.output, audioStrategy: "edge-tts-mix" } });
    await expect(composeKlingFilm("run-1")).rejects.toMatchObject({ code: "KLING_FILM_COMPOSITION_CONFLICT" });
    expect(state.compose).toHaveBeenCalledTimes(1);
    expect(state.tts).toHaveBeenCalledTimes(1);
  });

  it("does not begin FFmpeg when the parent revokes rendering authorization", async () => {
    await expect(composeKlingFilm("run-1", { assertOwned() {}, beforeRender() { throw new KlingError("KLING_FILM_AUTHORIZATION_REVOKED", "Paused", 409); } }))
      .rejects.toMatchObject({ code: "KLING_FILM_AUTHORIZATION_REVOKED" });
    expect(state.compose).not.toHaveBeenCalled();
    expect(getDb().select().from(compositions).get()?.status).not.toBe("done");
  });

  it("checks parent authorization again before publishing a render completed during a pause", async () => {
    let paused = false;
    const render = state.compose.getMockImplementation()!;
    state.compose.mockImplementationOnce(async (config: ComposeConfig) => { const output = await render(config); paused = true; return output; });
    await expect(composeKlingFilm("run-1", { assertOwned() {}, beforeRender() { if (paused) throw new KlingError("KLING_FILM_AUTHORIZATION_REVOKED", "Paused", 409); } }))
      .rejects.toMatchObject({ code: "KLING_FILM_AUTHORIZATION_REVOKED" });
    await expect(fs.stat(path.join(state.directory, "output/project-1/kling-film-composition-1.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(getDb().select().from(compositions).get()?.status).not.toBe("done");
  });

  it("fences a worker that loses its parent lease while rendering", async () => {
    let lost = false;
    const render = state.compose.getMockImplementation()!;
    state.compose.mockImplementationOnce(async (config: ComposeConfig) => { const output = await render(config); lost = true; return output; });
    await expect(composeKlingFilm("run-1", { assertOwned() { if (lost) throw new KlingError("KLING_FILM_LEASE_LOST", "Lease lost", 409); } }))
      .rejects.toMatchObject({ code: "KLING_FILM_LEASE_LOST" });
    expect(getDb().select().from(compositions).get()?.status).toBe("composing");
    expect(await readCompositionError("project-1", "composition-1")).toBeNull();
  });

  it.each([false, true])("renders frozen local media, captions and native audio through real FFmpeg (TIDEWE native: %s)", async tideweNative => {
    if (tideweNative) tideweRun("on_camera");
    const { composeVideo } = await vi.importActual<typeof import("@/lib/video-composer/composer")>("@/lib/video-composer/composer");
    const { probeMedia } = await vi.importActual<typeof import("@/lib/media-probe")>("@/lib/media-probe");
    const shot = getShot();
    await promisify(execFile)(ffmpegBin(), ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=90x162:r=30:d=0.8",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=0.8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", shot.data.sourceFilePath!], { timeout: 15000 });
    updateShot({}, { sourceFileHash: createHash("sha256").update(await fs.readFile(shot.data.sourceFilePath!)).digest("hex") });
    state.compose.mockImplementation(composeVideo); state.probe.mockImplementation(probeMedia);
    const result = await composeKlingFilm("run-1");
    expect(result.quality).toMatchObject({ width: 720, height: 1280, hasAudio: true });
    expect(result.quality.duration).toBeCloseTo(0.8, 1);
    expect(state.tts).not.toHaveBeenCalled();
    if (tideweNative) expect((state.compose.mock.calls[0][0] as ComposeConfig).clips[0]).toMatchObject({ preserveNativeSpeech: true, hasAudio: true });
    expect(getDb().select().from(compositions).get()?.status).toBe("done");
  }, 30000);
});
