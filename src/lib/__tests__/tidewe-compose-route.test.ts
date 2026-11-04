// @vitest-environment node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { createCreativeProfileSnapshot, createTideweOutdoorProfile } from "@/lib/creative-profiles";
import { assetScopeForShot } from "@/lib/asset-context";
import { englishWordCount, productFactsHash } from "@/lib/tidewe/validation";
import { ffmpegBin } from "@/lib/ffmpeg-path";
import { readCompositionError } from "@/lib/composition-error";
import { buildComposeInvocation, type ComposeConfig } from "@/lib/video-composer/composer";
import type { ProductFacts, TideweCopyDocument } from "@/lib/tidewe/types";

const state = vi.hoisted(() => ({ db: null as unknown, tts: vi.fn(), render: vi.fn(), align: vi.fn(), headline: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/edge-tts", () => ({ generateSpeechFreeDetailed: state.tts }));
vi.mock("@/lib/english-alignment", async original => ({
  ...await original<typeof import("@/lib/english-alignment")>(), alignEnglishAudio: state.align,
}));
vi.mock("@/lib/server/compose-headline", async original => ({
  ...await original<typeof import("@/lib/server/compose-headline")>(), generateComposeHeadline: state.headline,
}));
vi.mock("@/lib/video-composer/frame-extract", () => ({ extractFirstFrame: async () => undefined }));
vi.mock("@/lib/video-composer/composer", async original => ({ ...await original<typeof import("@/lib/video-composer/composer")>(), composeVideo: state.render }));
import { POST } from "@/app/api/project/[id]/compose/route";

const sqlite = new Database(":memory:");
const db = drizzle(sqlite, { schema });
const profile = createTideweOutdoorProfile({ speechMode: "voiceover" });
const text = "The walk into the woods is only the start. Have a look if that sounds familiar.";
const facts: ProductFacts = { version: 1, brand: "TIDEWE", category: "other", items: [] };
const copyDocument: TideweCopyDocument = {
  version: 1, language: "en-US", text, translation: "走进林子只是开始。适合的话可以看看。", angle: "scene", hookType: "scene",
  claimedFactIds: [], factsSnapshot: facts, factsHash: productFactsHash(facts), corpusVersion: profile.corpusVersion,
  compilerVersion: profile.promptCompilerVersion, exampleIds: [], wordCount: englishWordCount(text), estimatedDuration: 5,
};
const shot: schema.Shot = { shotId: 1, type: "hook", duration: 5, description: "清晨林间沿小径行走的背影。", camera: "固定中景",
  prompt: "自然户外小径与背影。", visualIntent: "自然户外行走。", visualSource: "ai_generate", transition: "direct_concat", voiceover: text,
  tidewe: { copySpan: { start: 0, end: text.length }, translation: copyDocument.translation, shotGoal: "建立户外行走场景", productVisible: false, factRefs: [], sceneId: "woods" } };
let directory: string;
let audio: Buffer;
let longAudio: Buffer;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "clipforge-tidewe-compose-"));
  vi.stubEnv("APP_DATA_DIR", directory);
  state.db = db;
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  await mkdir(join(directory, "uploads", "tidewe-project"), { recursive: true });
  const exec = promisify(execFile);
  await exec(ffmpegBin(), ["-y", "-f", "lavfi", "-i", "color=c=green:s=64x64:r=10:d=5", "-f", "lavfi", "-i", "sine=frequency=300:duration=5", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(directory, "uploads", "tidewe-project", "ambient.mp4")]);
  await exec(ffmpegBin(), ["-y", "-i", join(directory, "uploads", "tidewe-project", "ambient.mp4"), "-c:v", "copy", "-an", join(directory, "uploads", "tidewe-project", "silent.mp4")]);
  await exec(ffmpegBin(), ["-y", "-i", join(directory, "uploads", "tidewe-project", "silent.mp4"), "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-c:v", "copy", "-c:a", "aac", "-shortest", join(directory, "uploads", "tidewe-project", "muted.mp4")]);
  for (const [name, duration] of [["short", 2], ["long", 6]] as const) await exec(ffmpegBin(), ["-y", "-f", "lavfi", "-i", `sine=frequency=500:duration=${duration}`, join(directory, `${name}.wav`)]);
  audio = await readFile(join(directory, "short.wav"));
  longAudio = await readFile(join(directory, "long.wav"));
}, 20000);
beforeEach(() => {
  sqlite.exec("DELETE FROM compositions; DELETE FROM assets; DELETE FROM scripts; DELETE FROM projects;");
  db.insert(schema.projects).values({ id: "tidewe-project", name: "TIDEWE", creativeProfile: profile, creativeConfigRevision: 1 }).run();
  const script = db.insert(schema.scripts).values({ id: "tidewe-script", projectId: "tidewe-project", selected: true, styleType: "tidewe_outdoor", copyDocument, shots: [shot], creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1) }).returning().get()!;
  db.insert(schema.assets).values({ id: "tidewe-video", projectId: "tidewe-project", shotId: 1, selected: true, status: "done", type: "ai_generated", filePath: "/api/files/tidewe-project/ambient.mp4", ...assetScopeForShot(script, shot) }).run();
  state.tts.mockReset().mockResolvedValue({ audio, words: [] });
  state.headline.mockReset().mockResolvedValue("Keep Your Hunt Moving");
  state.align.mockReset().mockImplementation(async (jobs: AlignmentJob[]) => ({
    jobs: jobs.map(job => ({ id: job.id, durationSec: job.maxDurationSec, words: alignedWords(job.text) })),
    model: "facebook/wav2vec2-base-960h", device: "cpu", asrUsed: false,
  }));
  state.render.mockReset().mockResolvedValue(join(directory, "final.mp4"));
});
afterAll(async () => { vi.unstubAllEnvs(); sqlite.close(); await rm(directory, { recursive: true, force: true }); });
async function request(body: Record<string, unknown> = {}) {
  return POST(new NextRequest("http://localhost/api/project/tidewe-project/compose", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "tidewe-project" }) });
}
async function completed(id: string) {
  await vi.waitFor(() => expect(db.select().from(schema.compositions).where(eq(schema.compositions.id, id)).get()?.status).not.toBe("composing"), { timeout: 10_000 });
  return db.select().from(schema.compositions).where(eq(schema.compositions.id, id)).get()!;
}
type AlignmentJob = { id: string; text: string; sourcePath: string; maxDurationSec: number };
function alignedWords(narration: string) {
  const words = narration.trim().split(/\s+/);
  return words.map((word, index) => ({ text: word,
    startSec: 0.15 + index * 1.35 / words.length + (index >= Math.floor(words.length / 2) ? 0.14 : 0),
    endSec: 0.15 + index * 1.35 / words.length + (index >= Math.floor(words.length / 2) ? 0.14 : 0) + 0.65 / words.length,
    score: 0.97,
  }));
}
function karaokeEvents(ass: string) {
  return ass.split(/\r?\n/).filter(line => line.startsWith("Dialogue: ")).map(line => {
    const fields = line.slice("Dialogue: ".length).split(",");
    const body = fields.slice(9).join(",");
    return { start: fields[1], end: fields[2], style: fields[3], text: body.replace(/\{[^}]*\}/g, ""),
      highlightedWord: body.match(/\\1c&H0DF9FA&\}([^{}]+)/i)?.[1].trim(), body };
  }).filter(event => event.style !== "Title");
}
function assSeconds(value: string) {
  const [hours, minutes, seconds] = value.split(":").map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}

describe("TIDEWE composition enforces frozen English narration", () => {
  it("adds English narration even when the video already has audible ambient sound", async () => {
    const response = await request();
    expect(response.status).toBe(202);
    const row = await completed((await response.json()).compositionId);
    expect(row.status).toBe("done");
    expect(state.tts).toHaveBeenCalledWith(text, { voice: "en-US-GuyNeural", rate: undefined });
    const config = state.render.mock.calls[0][0] as ComposeConfig;
    expect(config.clips[0]).toMatchObject({ hasAudio: false, strictSourceDuration: true });
    expect(config.clips[0].audioPath).toBeTruthy();
    expect(config.clips[0].duration).toBeGreaterThan(2);
    expect(config.clips[0].duration).toBeLessThan(5);
    expect(config.output).not.toHaveProperty("voiceGround");
    expect(state.align).toHaveBeenCalledOnce();
    expect(state.align.mock.calls[0][0]).toEqual([{ id: expect.any(String), text,
      sourcePath: config.clips[0].audioPath, maxDurationSec: expect.any(Number) }]);
    expect(state.align.mock.calls[0][0][0].sourcePath).not.toBe(config.clips[0].filePath);
  });
  it("fails the specific short video instead of trimming narration or freezing a tail", async () => {
    state.tts.mockResolvedValue({ audio: longAudio, words: [] });
    const response = await request();
    expect(response.status).toBe(202);
    expect((await completed((await response.json()).compositionId)).status).toBe("failed");
    expect(state.render).not.toHaveBeenCalled();
  });
  it("fails when narration generation fails instead of silently retaining ambient audio", async () => {
    state.tts.mockRejectedValue(new Error("mock voice service unavailable"));
    const response = await request();
    expect((await completed((await response.json()).compositionId)).status).toBe("failed");
    expect(state.render).not.toHaveBeenCalled();
  });
  it("rejects temporary and legacy narration overrides and non-English voices before rendering", async () => {
    expect((await request({ voiceoverOverrides: [{ shotId: 1, voiceover: "Buy now" }] })).status).toBe(409);
    expect((await request({ narration: "A different script" })).status).toBe(409);
    expect((await request({ freeTts: { enabled: true, voice: "zh-CN-XiaoxiaoNeural" } })).status).toBe(400);
    expect(state.tts).not.toHaveBeenCalled();
    expect(state.render).not.toHaveBeenCalled();
  });
  it("rejects an incomplete ElevenLabs selection instead of silently using the default Microsoft voice", async () => {
    const response = await request({ ttsConfig: { provider: "elevenlabs-cli", model: "eleven_multilingual_v2", voice: "" } });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("ELEVENLABS_CONFIG_INVALID");
    expect(db.select().from(schema.compositions).all()).toEqual([]);
    expect(state.tts).not.toHaveBeenCalled();
    expect(state.render).not.toHaveBeenCalled();
  });
  it("rejects stored voiceover that no longer equals the canonical copy slice", async () => {
    db.update(schema.scripts).set({ shots: [{ ...shot, voiceover: "A different sentence." }] }).run();
    expect((await request()).status).toBe(409);
    expect(state.render).not.toHaveBeenCalled();
  });
});

function nativeProject(partial: Partial<schema.Shot> = {}) {
  const nativeProfile = createTideweOutdoorProfile({ speechMode: "on_camera" });
  const nativeShot = { ...shot, ...partial };
  db.update(schema.projects).set({ creativeProfile: nativeProfile }).run();
  const updated = db.update(schema.scripts).set({ shots: [nativeShot], creativeProfileSnapshot: createCreativeProfileSnapshot(nativeProfile, 1) }).returning().get()!;
  db.update(schema.assets).set(assetScopeForShot(updated, nativeShot)).run();
}

const postNarrationPlan = {
  version: 1, strategy: "keyframe", mode: "image-to-video", referenceRoles: ["keyframe"], referenceCount: 1,
  audioMode: "post", voiceoverBound: false, warnings: [],
} as const;

describe("TIDEWE native on-camera speech composition", () => {
  it.each([{}, { captionPreset: "karaoke" }, { captionPreset: "standard", subtitlePosition: "top" }, { karaoke: true }])("adds audio-aligned English word highlights while preserving the full native recording: %j", async options => {
    nativeProject({ duration: 2 });
    const response = await request(options);
    expect(response.status).toBe(202);
    const row = await completed((await response.json()).compositionId);
    expect(row).toMatchObject({ status: "done", ttsEnabled: false });
    expect(state.tts).not.toHaveBeenCalled();
    const config = state.render.mock.calls[0][0] as ComposeConfig;
    expect(config.clips[0]).toMatchObject({ hasAudio: true, strictSourceDuration: true, preserveNativeSpeech: true,
      duration: 5, sourceDuration: 5, transition: "direct_concat" });
    expect(config.clips[0].audioPath).toBeUndefined();
    expect(config.output).not.toHaveProperty("voiceGround");
    expect(config.subtitle?.texts).toEqual([]);
    expect(config.subtitle?.karaokeAssPath).toBe(join(directory, "output", "tidewe-project", `karaoke_${row.id}.ass`));
    expect(config.subtitle?.fontFile).toMatch(/KOMIKAX_\.ttf$/i);
    const ass = await readFile(config.subtitle!.karaokeAssPath!, "utf8");
    const events = karaokeEvents(ass);
    expect(events).toHaveLength(text.split(/\s+/).length);
    expect(events[0]).toMatchObject({ start: "0:00:00.15", highlightedWord: "THE" });
    expect(events.map(event => event.highlightedWord)).toEqual(text.toUpperCase().split(/\s+/));
    expect(ass).toContain("Komika Axis");
    expect(ass).toContain("\\pos(540,1365)");
    expect(ass).not.toMatch(/\\k(?:f|o)?\d/);
    expect(state.align).toHaveBeenCalledOnce();
    expect(state.align.mock.calls[0][0]).toEqual([{ id: expect.any(String), text,
      sourcePath: config.clips[0].filePath, maxDurationSec: 5 }]);
    events.forEach((event, index) => expect(Math.abs(assSeconds(event.start) - alignedWords(text)[index].startSec)).toBeLessThanOrEqual(0.00500001));
    const invocation = buildComposeInvocation(config);
    expect(invocation.filterComplex).toContain("subtitles='");
    expect(invocation.filterComplex).toContain(`karaoke_${row.id}.ass`);
    expect(invocation.filterComplex).not.toContain("drawtext=");
    const timeline = JSON.parse(await readFile(join(directory, "final.mp4.timeline.json"), "utf8"));
    expect(timeline).toMatchObject({ speechMode: "on_camera", captionTiming: "audio-aligned", captionStyle: "komika-axis-current-word",
      alignmentModel: "facebook/wav2vec2-base-960h", total: 5,
      audioTracks: [{ id: "A2", role: "native" }] });
  });

  it("maps real word onsets through the following native shot's fade offset", async () => {
    const nativeProfile = createTideweOutdoorProfile({ speechMode: "on_camera" });
    const split = text.indexOf("Have");
    const shots: schema.Shot[] = [
      { ...shot, voiceover: text.slice(0, split).trim(), tidewe: { ...shot.tidewe!, copySpan: { start: 0, end: split } } },
      { ...shot, shotId: 2, voiceover: text.slice(split).trim(), tidewe: { ...shot.tidewe!, copySpan: { start: split, end: text.length } } },
    ];
    db.update(schema.projects).set({ creativeProfile: nativeProfile }).run();
    const updated = db.update(schema.scripts).set({ shots, creativeProfileSnapshot: createCreativeProfileSnapshot(nativeProfile, 1) }).returning().get()!;
    db.update(schema.assets).set(assetScopeForShot(updated, shots[0])).run();
    db.insert(schema.assets).values({ id: "second-native-take", projectId: "tidewe-project", shotId: 2, selected: true,
      status: "done", type: "ai_generated", filePath: "/api/files/tidewe-project/ambient.mp4", ...assetScopeForShot(updated, shots[1]) }).run();
    const response = await request({ captionPreset: "karaoke", transitionOverrides: [{ shotId: 2, transition: "ffmpeg_fade" }] });
    expect(response.status).toBe(202);
    expect(await completed((await response.json()).compositionId)).toMatchObject({ status: "done", ttsEnabled: false });
    expect(state.tts).not.toHaveBeenCalled();
    const config = state.render.mock.calls[0][0] as ComposeConfig;
    expect(config.clips.map(clip => clip.duration)).toEqual([5, 5]);
    const events = karaokeEvents(await readFile(config.subtitle!.karaokeAssPath!, "utf8"));
    expect(events).toHaveLength(text.split(/\s+/).length);
    const splitWord = shots[0].voiceover!.split(/\s+/).length;
    expect(events[0]).toMatchObject({ start: "0:00:00.15", highlightedWord: "THE" });
    expect(events[splitWord]).toMatchObject({ start: "0:00:04.65", highlightedWord: "HAVE" });
    expect(events.slice(0, splitWord).every(event => assSeconds(event.end) <= 4.65)).toBe(true);
    expect(events.slice(splitWord).every(event => assSeconds(event.start) >= 4.65)).toBe(true);
    expect(state.headline).not.toHaveBeenCalled();
    expect(buildComposeInvocation(config).filterComplex).toContain("xfade=");
  });

  it("omits karaoke captions when subtitles are disabled", async () => {
    nativeProject();
    const response = await request({ subtitles: false, karaoke: true, captionPreset: "karaoke" });
    expect(response.status).toBe(202);
    const row = await completed((await response.json()).compositionId);
    expect(row).toMatchObject({ status: "done", ttsEnabled: false });
    expect(state.tts).not.toHaveBeenCalled();
    expect(state.align).not.toHaveBeenCalled();
    expect(state.headline).not.toHaveBeenCalled();
    const config = state.render.mock.calls[0][0] as ComposeConfig;
    expect(config.subtitle).toBeUndefined();
    expect(buildComposeInvocation(config).filterComplex).not.toContain("subtitles=");
    await expect(readFile(join(directory, "output", "tidewe-project", `karaoke_${row.id}.ass`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails alignment visibly instead of composing estimated captions", async () => {
    nativeProject();
    state.align.mockRejectedValue(new Error("WhisperX audio alignment unavailable"));
    const response = await request();
    expect(response.status).toBe(202);
    const row = await completed((await response.json()).compositionId);
    expect(row.status).toBe("failed");
    expect(await readCompositionError("tidewe-project", row.id)).toContain("WhisperX audio alignment unavailable");
    expect(state.align).toHaveBeenCalledOnce();
    expect(state.render).not.toHaveBeenCalled();
    await expect(readFile(join(directory, "output", "tidewe-project", `karaoke_${row.id}.ass`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails captions for silent footage without narration instead of inventing timings", async () => {
    nativeProject();
    db.update(schema.assets).set({ filePath: "/api/files/tidewe-project/silent.mp4" }).run();
    const response = await request({ ttsEnabled: false });
    expect(response.status).toBe(202);
    const row = await completed((await response.json()).compositionId);
    expect(row.status).toBe("failed");
    expect(await readCompositionError("tidewe-project", row.id)).toMatch(/音轨|音频|配音|声音/);
    expect(state.align).not.toHaveBeenCalled();
    expect(state.tts).not.toHaveBeenCalled();
    expect(state.render).not.toHaveBeenCalled();
  });

  it("does not estimate a word missing from the alignment output", async () => {
    nativeProject();
    state.align.mockImplementationOnce(async (jobs: AlignmentJob[]) => ({
      jobs: jobs.map(job => ({ id: job.id, durationSec: job.maxDurationSec, words: alignedWords(job.text).slice(1) })),
      model: "facebook/wav2vec2-base-960h", device: "cpu", asrUsed: false,
    }));
    const response = await request();
    const row = await completed((await response.json()).compositionId);
    expect(row.status).toBe("failed");
    expect(state.render).not.toHaveBeenCalled();
    expect(await readCompositionError("tidewe-project", row.id)).toBeTruthy();
  });

  it.each(["replace", "mix"] as const)("aligns the generated narration rather than original video in %s mode", async voiceoverMode => {
    nativeProject();
    const response = await request({ ttsEnabled: true, voiceoverMode });
    expect(response.status).toBe(202);
    const row = await completed((await response.json()).compositionId);
    expect(row.status).toBe("done");
    const clip = (state.render.mock.calls[0][0] as ComposeConfig).clips[0];
    expect(state.align).toHaveBeenCalledOnce();
    expect(state.align.mock.calls[0][0][0].sourcePath).toBe(clip.audioPath);
    expect(state.align.mock.calls[0][0][0].sourcePath).not.toBe(clip.filePath);
    expect(clip.hasAudio).toBe(voiceoverMode === "mix");
  });

  it("applies only the explicitly supplied title without calling a text model", async () => {
    nativeProject();
    const savedTitle = "Don't Let A Creek End Your Hunt";
    db.update(schema.scripts).set({ title: savedTitle }).run();
    const response = await request({ headlineEnabled: true, headlineText: "  Wet Crossings  ",
      llmConfig: { model: "ignored-model" } });
    const row = await completed((await response.json()).compositionId);
    expect(row.status).toBe("done");
    const config = state.render.mock.calls[0][0] as ComposeConfig;
    const ass = await readFile(config.subtitle!.karaokeAssPath!, "utf8");
    const titleEvents = ass.split(/\r?\n/).filter(line => line.startsWith("Dialogue:") && line.includes(",Title,"));
    expect(titleEvents).toHaveLength(1);
    expect(titleEvents[0]).toContain("\\pos(540,178)");
    expect(titleEvents[0]).toContain("Wet Crossings");
    expect(titleEvents[0]).not.toContain(savedTitle);
    expect(state.headline).not.toHaveBeenCalled();
    expect(config.overlays?.filter(overlay => overlay.style === "title") ?? []).toHaveLength(0);
  });

  it.each([{}, { headlineEnabled: false }, { headlineText: "Ignored saved input" }])("keeps the top title disabled by default: %j", async body => {
    nativeProject();
    db.update(schema.scripts).set({ title: "从浅溪走向湿林地" }).run();
    state.headline.mockRejectedValue(new Error("Headline provider unavailable"));
    const response = await request(body);
    const row = await completed((await response.json()).compositionId);
    expect(row.status).toBe("done");
    const config = state.render.mock.calls[0][0] as ComposeConfig;
    const ass = await readFile(config.subtitle!.karaokeAssPath!, "utf8");
    expect(ass.split(/\r?\n/).filter(line => line.startsWith("Dialogue:") && line.includes(",Title,"))).toHaveLength(0);
    expect(state.headline).not.toHaveBeenCalled();
  });

  it("renders a supplied top title with body subtitles disabled and skips audio alignment", async () => {
    nativeProject();
    const response = await request({ subtitles: false, headlineEnabled: true, headlineText: "Keep Moving" });
    expect(response.status).toBe(202);
    expect((await completed((await response.json()).compositionId)).status).toBe("done");
    const config = state.render.mock.calls[0][0] as ComposeConfig;
    const ass = await readFile(config.subtitle!.karaokeAssPath!, "utf8");
    const events = ass.split(/\r?\n/).filter(line => line.startsWith("Dialogue:"));
    expect(events).toHaveLength(1);
    expect(events[0]).toContain(",Title,");
    expect(events[0]).toContain("Keep Moving");
    expect(ass).toContain("Komika Axis");
    expect(state.align).not.toHaveBeenCalled();
    expect(state.headline).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "   ", "a".repeat(121), "One\nTwo", 42])("rejects enabled invalid title text before starting composition: %j", async headlineText => {
    const response = await request({ headlineEnabled: true, headlineText });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("顶部标题");
    expect(db.select().from(schema.compositions).all()).toHaveLength(0);
    expect(state.render).not.toHaveBeenCalled();
    expect(state.headline).not.toHaveBeenCalled();
  });

  it.each(["silent.mp4", "muted.mp4"])("automatically narrates %s when the enable switch is omitted", async fileName => {
    nativeProject();
    db.update(schema.assets).set({ filePath: `/api/files/tidewe-project/${fileName}` }).run();
    const response = await request({ nativeAudio: true, freeTts: { enabled: false } });
    expect(response.status).toBe(202);
    const row = await completed((await response.json()).compositionId);
    expect(row).toMatchObject({ status: "done", ttsEnabled: true });
    expect(state.tts).toHaveBeenCalledExactlyOnceWith(text, { voice: "en-US-GuyNeural", rate: undefined });
    const config = state.render.mock.calls[0][0] as ComposeConfig;
    expect(config.clips[0]).toMatchObject({ hasAudio: false, strictSourceDuration: true, sourceDuration: 5, transition: "direct_concat" });
    expect(config.clips[0].audioPath).toBeTruthy();
    expect(config.clips[0].preserveNativeSpeech).toBeUndefined();
    expect(config.clips[0].duration).toBeGreaterThan(2);
    expect(config.clips[0].duration).toBeLessThan(5);
  });

  it("keeps duration validation for silent footage with narration longer than the source", async () => {
    nativeProject();
    db.update(schema.assets).set({ filePath: "/api/files/tidewe-project/silent.mp4" }).run();
    state.tts.mockResolvedValue({ audio: longAudio, words: [] });
    const response = await request();
    const row = await completed((await response.json()).compositionId);
    expect(row.status).toBe("failed");
    expect(await readCompositionError("tidewe-project", row.id)).toContain("视频可用时长");
    expect(state.tts).toHaveBeenCalledOnce();
    expect(state.render).not.toHaveBeenCalled();
  });

  it("adds English narration when a post-narration model returns audible ambience", async () => {
    nativeProject();
    db.update(schema.assets).set({ generationPlan: { ...postNarrationPlan, referenceRoles: ["keyframe"], warnings: [] } }).run();
    const response = await request();
    expect(response.status).toBe(202);
    expect(await completed((await response.json()).compositionId)).toMatchObject({ status: "done", ttsEnabled: true });
    expect(state.tts).toHaveBeenCalledExactlyOnceWith(text, { voice: "en-US-GuyNeural", rate: undefined });
    const clip = (state.render.mock.calls[0][0] as ComposeConfig).clips[0];
    expect(clip).toMatchObject({ hasAudio: false, sourceDuration: 5 });
    expect(clip.audioPath).toBeTruthy();
    expect(clip.preserveNativeSpeech).toBeUndefined();
  });

  it.each([true, false])("uses the pinned take's narration plan rather than the selected take's: post selected=%s", async selectedPost => {
    nativeProject();
    const plan = { ...postNarrationPlan, referenceRoles: ["keyframe" as const], warnings: [] };
    db.update(schema.assets).set({ generationPlan: selectedPost ? plan : null }).run();
    const selected = db.select().from(schema.scripts).get()!;
    db.insert(schema.assets).values({ id: "pinned-take", projectId: "tidewe-project", shotId: 1, selected: false,
      status: "done", type: "ai_generated", filePath: "/api/files/tidewe-project/ambient.mp4",
      generationPlan: selectedPost ? null : plan, ...assetScopeForShot(selected, shot) }).run();
    const response = await request({ shotAssetSelections: [{ shotId: 1, assetId: "pinned-take" }] });
    expect(response.status).toBe(202);
    expect((await completed((await response.json()).compositionId)).status).toBe("done");
    const clip = (state.render.mock.calls[0][0] as ComposeConfig).clips[0];
    if (selectedPost) {
      expect(state.tts).not.toHaveBeenCalled();
      expect(clip).toMatchObject({ hasAudio: true, preserveNativeSpeech: true, duration: 5 });
      expect(clip.audioPath).toBeUndefined();
    } else {
      expect(state.tts).toHaveBeenCalledOnce();
      expect(clip.hasAudio).toBe(false);
      expect(clip.audioPath).toBeTruthy();
      expect(clip.preserveNativeSpeech).toBeUndefined();
    }
  });

  it.each([
    { ttsEnabled: true }, { freeTts: { enabled: true } }, { ttsConfig: { voice: "en-US-GuyNeural" } },
    { voiceoverMode: "auto" },
  ])("accepts narration fallback settings while preserving audible native speech: %j", async body => {
    nativeProject();
    const response = await request(body);
    expect(response.status).toBe(202);
    expect((await completed((await response.json()).compositionId)).status).toBe("done");
    expect(state.tts).not.toHaveBeenCalled();
    const config = state.render.mock.calls[0][0] as ComposeConfig;
    expect(config.clips[0]).toMatchObject({ hasAudio: true, preserveNativeSpeech: true, duration: 5 });
    expect(config.clips[0].audioPath).toBeUndefined();
  });

  it("adds narration only to silent shots in a mixed native and silent sequence", async () => {
    const nativeProfile = createTideweOutdoorProfile({ speechMode: "on_camera" });
    const split = text.indexOf(" Have") + 1;
    const shots: schema.Shot[] = [
      { ...shot, voiceover: text.slice(0, split).trim(), tidewe: { ...shot.tidewe!, copySpan: { start: 0, end: split } } },
      { ...shot, shotId: 2, voiceover: text.slice(split).trim(), tidewe: { ...shot.tidewe!, copySpan: { start: split, end: text.length } } },
    ];
    db.update(schema.projects).set({ creativeProfile: nativeProfile }).run();
    const updated = db.update(schema.scripts).set({ shots, creativeProfileSnapshot: createCreativeProfileSnapshot(nativeProfile, 1) }).returning().get()!;
    db.update(schema.assets).set(assetScopeForShot(updated, shots[0])).run();
    db.insert(schema.assets).values({ id: "silent-take", projectId: "tidewe-project", shotId: 2, selected: true, status: "done", type: "ai_generated", filePath: "/api/files/tidewe-project/silent.mp4", ...assetScopeForShot(updated, shots[1]) }).run();
    const response = await request({ nativeAudio: true });
    expect(response.status).toBe(202);
    const row = await completed((await response.json()).compositionId);
    expect(row).toMatchObject({ status: "done", ttsEnabled: true });
    expect(state.tts).toHaveBeenCalledExactlyOnceWith(shots[1].voiceover, { voice: "en-US-GuyNeural", rate: undefined });
    const config = state.render.mock.calls[0][0] as ComposeConfig;
    expect(config.clips).toHaveLength(2);
    expect(config.clips[0]).toMatchObject({ hasAudio: true, preserveNativeSpeech: true, duration: 5, sourceDuration: 5 });
    expect(config.clips[0].audioPath).toBeUndefined();
    expect(config.clips[1]).toMatchObject({ hasAudio: false, sourceDuration: 5 });
    expect(config.clips[1].audioPath).toBeTruthy();
    expect(config.clips[1].preserveNativeSpeech).toBeUndefined();
  });
});

describe.each(["on_camera", "voiceover"] as const)("TIDEWE %s transition selections", speechMode => {
  it.each(["auto", "replace", "mix"] as const)("honors mixed fade and direct selections with %s audio", async mode => {
    const selectedProfile = createTideweOutdoorProfile({ speechMode });
    const offsets = [0, text.indexOf("is only"), text.indexOf("Have"), text.length];
    const shots: schema.Shot[] = offsets.slice(0, -1).map((start, index) => ({
      ...shot,
      shotId: index + 1,
      transition: index === 2 ? "ffmpeg_fade" : "direct_concat",
      voiceover: text.slice(start, offsets[index + 1]).trim(),
      tidewe: { ...shot.tidewe!, copySpan: { start, end: offsets[index + 1] } },
    }));
    db.update(schema.projects).set({ creativeProfile: selectedProfile }).run();
    const script = db.update(schema.scripts).set({ shots, creativeProfileSnapshot: createCreativeProfileSnapshot(selectedProfile, 1) }).returning().get()!;
    db.delete(schema.assets).run();
    for (const item of shots) {
      db.insert(schema.assets).values({ id: `transition-take-${item.shotId}`, projectId: "tidewe-project", shotId: item.shotId,
        selected: true, status: "done", type: "ai_generated", filePath: "/api/files/tidewe-project/ambient.mp4",
        ...assetScopeForShot(script, item) }).run();
    }

    const transitions = ["direct_concat", "ffmpeg_fade", "direct_concat"] as const;
    const response = await request({ ttsEnabled: true, voiceoverMode: mode,
      transitionOverrides: shots.map((item, index) => ({ shotId: item.shotId, transition: transitions[index] })) });
    expect(response.status).toBe(202);
    const row = await completed((await response.json()).compositionId);
    expect(row.status).toBe("done");
    const config = state.render.mock.calls[0][0] as ComposeConfig;
    expect(config.clips.map(item => item.transition)).toEqual(transitions);
    for (const item of config.clips) {
      expect(item.duration).toBeLessThanOrEqual(item.sourceDuration!);
      expect(item.hasAudio).toBe(mode !== "replace");
      if (mode === "auto" && speechMode === "on_camera") expect(item.preserveNativeSpeech).toBe(true);
    }
    if (mode === "replace") {
      expect(config.clips[0].duration).toBeCloseTo(2.95, 2);
      expect(config.clips[1].duration).toBeCloseTo(2.45, 2);
    } else {
      expect(config.clips.map(item => item.duration)).toEqual([5, 5, 5]);
    }

    // Exercise the real renderer guards, not only the mocked render entry point.
    const invocation = buildComposeInvocation(config);
    expect(invocation.filterComplex.match(/\bxfade=/g)).toHaveLength(1);
    expect(invocation.filterComplex.match(/\bacrossfade=/g)).toHaveLength(1);
    expect(invocation.filterComplex).toContain("[xfade1][v2]concat=n=2:v=1:a=0");
    const timeline = JSON.parse(await readFile(join(directory, "final.mp4.timeline.json"), "utf8"));
    expect(timeline.boundaries).toHaveLength(2);
    expect(timeline.boundaries[0]).toBeCloseTo(mode === "replace" ? 2.45 : 4.5, 2);
    expect(timeline.boundaries[1]).toBeCloseTo(mode === "replace" ? 4.9 : 9.5, 2);
    expect(timeline.total).toBeCloseTo(mode === "replace" ? 7.35 : 14.5, 2);
    const durationIndex = invocation.outputArgs.indexOf("-t");
    expect(Number(invocation.outputArgs[durationIndex + 1])).toBeCloseTo(timeline.total, 3);
    // Per-render choices must not rewrite the saved script's defaults.
    expect(db.select().from(schema.scripts).get()!.shots?.map(item => item.transition))
      .toEqual(["direct_concat", "direct_concat", "ffmpeg_fade"]);
  });
});

describe.each(["on_camera", "voiceover"] as const)("TIDEWE %s narration controls", speechMode => {
  beforeEach(() => { if (speechMode === "on_camera") nativeProject(); });

  it.each(["auto", "replace", "mix"] as const)("honors the explicitly selected %s mode with audible footage", async mode => {
    const response = await request({ ttsEnabled: true, voiceoverMode: mode });
    expect(response.status).toBe(202);
    const row = await completed((await response.json()).compositionId);
    expect(row.status).toBe("done");
    const config = state.render.mock.calls[0][0] as ComposeConfig;
    const clip = config.clips[0];
    expect(clip).toMatchObject({ strictSourceDuration: true, sourceDuration: 5 });
    if (mode === "auto") {
      expect(row.ttsEnabled).toBe(false);
      expect(state.tts).not.toHaveBeenCalled();
      expect(clip).toMatchObject({ hasAudio: true, duration: 5 });
      expect(clip.audioPath).toBeUndefined();
    } else {
      expect(row.ttsEnabled).toBe(true);
      expect(state.tts).toHaveBeenCalledExactlyOnceWith(text, { voice: "en-US-GuyNeural", rate: undefined });
      expect(clip.audioPath).toBeTruthy();
      expect(clip.hasAudio).toBe(mode === "mix");
      expect(clip.mixNativeAudio).toBe(mode === "mix" ? true : undefined);
      expect(clip.preserveNativeSpeech).toBeUndefined();
      if (mode === "mix") expect(clip.duration).toBe(5);
      else expect(clip.duration).toBeCloseTo(2.45, 1);
    }
  });

  it.each(["ambient.mp4", "silent.mp4"])("honors disabled TTS with %s despite enabled provider options", async fileName => {
    db.update(schema.assets).set({ filePath: `/api/files/tidewe-project/${fileName}`, generationPlan: { ...postNarrationPlan, referenceRoles: ["keyframe"], warnings: [] } }).run();
    const response = await request({ subtitles: false, ttsEnabled: false, voiceoverMode: "replace", freeTts: { enabled: true, voice: "en-US-AriaNeural" },
      ttsConfig: { baseUrl: "https://example.invalid", apiKey: "fixture", model: "tts-1", voice: "alloy" }, voiceGround: true });
    expect(response.status).toBe(202);
    expect(await completed((await response.json()).compositionId)).toMatchObject({ status: "done", ttsEnabled: false });
    expect(state.tts).not.toHaveBeenCalled();
    const config = state.render.mock.calls[0][0] as ComposeConfig;
    expect(config.clips[0]).toMatchObject({ hasAudio: fileName === "ambient.mp4", sourceDuration: 5, duration: 5 });
    expect(config.clips[0].audioPath).toBeUndefined();
    expect(config.output).not.toHaveProperty("voiceGround");
  });

  it("generates the frozen English copy with the selected English voice", async () => {
    db.update(schema.assets).set({ filePath: "/api/files/tidewe-project/silent.mp4" }).run();
    const response = await request({ ttsEnabled: true, voiceoverMode: "auto", freeTts: { enabled: true, voice: "en-US-AriaNeural" } });
    expect(response.status).toBe(202);
    expect(await completed((await response.json()).compositionId)).toMatchObject({ status: "done", ttsEnabled: true });
    expect(state.tts).toHaveBeenCalledExactlyOnceWith(text, { voice: "en-US-AriaNeural", rate: undefined });
  });

  it.each([false, true])("ignores removed voice grounding=%s when TTS is mixed with native audio", async voiceGround => {
    const response = await request({ ttsEnabled: true, voiceoverMode: "mix", voiceGround });
    expect(response.status).toBe(202);
    expect((await completed((await response.json()).compositionId)).status).toBe("done");
    const config = state.render.mock.calls[0][0] as ComposeConfig;
    expect(config.output).not.toHaveProperty("voiceGround");
    expect(config.clips[0]).toMatchObject({ hasAudio: true, mixNativeAudio: true, duration: 5, sourceDuration: 5 });
    expect(config.clips[0].audioPath).toBeTruthy();
    expect(config.clips[0].preserveNativeSpeech).toBeUndefined();
  });

  it("rejects a mixed voice track longer than its footage without truncating speech", async () => {
    state.tts.mockResolvedValue({ audio: longAudio, words: [] });
    const response = await request({ ttsEnabled: true, voiceoverMode: "mix" });
    expect(response.status).toBe(202);
    const row = await completed((await response.json()).compositionId);
    expect(row.status).toBe("failed");
    expect(await readCompositionError("tidewe-project", row.id)).toContain("视频可用时长");
    expect(state.render).not.toHaveBeenCalled();
  });
});
