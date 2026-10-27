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
import type { ComposeConfig } from "@/lib/video-composer/composer";
import type { ProductFacts, TideweCopyDocument } from "@/lib/tidewe/types";

const state = vi.hoisted(() => ({ db: null as unknown, tts: vi.fn(), render: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/edge-tts", () => ({ generateSpeechFreeDetailed: state.tts }));
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
  it("preserves the full source recording and lips without generating a second voice", async () => {
    nativeProject({ duration: 2, transition: "ffmpeg_fade" });
    const response = await request({ karaoke: true, captionPreset: "karaoke" });
    expect(response.status).toBe(202);
    const row = await completed((await response.json()).compositionId);
    expect(row).toMatchObject({ status: "done", ttsEnabled: false });
    expect(state.tts).not.toHaveBeenCalled();
    const config = state.render.mock.calls[0][0] as ComposeConfig;
    expect(config.clips[0]).toMatchObject({ hasAudio: true, strictSourceDuration: true, preserveNativeSpeech: true,
      duration: 5, sourceDuration: 5, transition: "direct_concat" });
    expect(config.clips[0].audioPath).toBeUndefined();
    expect(config.output.voiceGround).toBe(false);
    expect(config.subtitle?.texts.length).toBeGreaterThan(0);
    expect(config.subtitle?.karaokeAssPath).toBeUndefined();
    const timeline = JSON.parse(await readFile(join(directory, "final.mp4.timeline.json"), "utf8"));
    expect(timeline).toMatchObject({ speechMode: "on_camera", captionTiming: "segment-estimate", total: 5,
      audioTracks: [{ id: "A2", role: "native" }] });
  });

  it.each(["silent.mp4", "muted.mp4"])("automatically narrates %s despite legacy native-only compose flags", async fileName => {
    nativeProject();
    db.update(schema.assets).set({ filePath: `/api/files/tidewe-project/${fileName}` }).run();
    const response = await request({ nativeAudio: true, ttsEnabled: false, freeTts: { enabled: false } });
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
    { voiceoverMode: "replace" }, { voiceoverMode: "mix" },
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
    const response = await request({ ttsEnabled: false, nativeAudio: true });
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
