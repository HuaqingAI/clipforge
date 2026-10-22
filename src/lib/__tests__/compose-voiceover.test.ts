// @vitest-environment node
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { ffmpegBin } from "@/lib/ffmpeg-path";
import { buildComposeInvocation, FADE_DURATION, type ComposeConfig } from "@/lib/video-composer/composer";

const state = vi.hoisted(() => ({ db: null as unknown, render: vi.fn(), freeTts: vi.fn(), paidTts: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/video-composer/composer", async (original) => ({
  ...await original<typeof import("@/lib/video-composer/composer")>(), composeVideo: state.render,
}));
vi.mock("@/lib/edge-tts", async (original) => ({
  ...await original<typeof import("@/lib/edge-tts")>(), generateSpeechFreeDetailed: state.freeTts,
}));
vi.mock("@/lib/tts", async (original) => ({
  ...await original<typeof import("@/lib/tts")>(), generateSpeech: state.paidTts,
}));
vi.mock("@/lib/video-composer/frame-extract", () => ({ extractFirstFrame: vi.fn().mockResolvedValue(undefined) }));
import { GET, POST } from "@/app/api/project/[id]/compose/route";

const sqlite = new Database(":memory:");
const db = drizzle(sqlite, { schema });
let directory: string;
let shortNarration: Buffer;
let longNarration: Buffer;
const projectId = "voiceover-project";
const sourceSeconds = 2;
const baseShot: schema.Shot = {
  shotId: 1, type: "demo", duration: 1, description: "Product demonstration", camera: "static",
  visualSource: "ai_generate", transition: "direct_concat", voiceover: "Generated narration",
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "clipforge-compose-voiceover-"));
  vi.stubEnv("APP_DATA_DIR", directory);
  state.db = db;
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  db.insert(schema.projects).values({ id: projectId, name: "Voiceover modes" }).run();
  const uploads = join(directory, "uploads", projectId);
  await mkdir(uploads, { recursive: true });
  const exec = promisify(execFile);
  // Real files exercise the route's audible/silent audio detection and duration probes.
  for (const kind of ["audible", "silent", "no-audio"] as const) {
    await exec(ffmpegBin(), ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=blue:s=32x32:r=10:d=${sourceSeconds}`,
      ...(kind === "no-audio" ? [] : ["-f", "lavfi", "-i", kind === "audible" ? `sine=frequency=440:duration=${sourceSeconds}` : "anullsrc=r=44100:cl=mono"]),
      "-t", String(sourceSeconds), "-c:v", "libx264", "-pix_fmt", "yuv420p", ...(kind === "no-audio" ? [] : ["-c:a", "aac"]), join(uploads, `${kind}.mp4`)], { timeout: 15000 });
  }
  for (const [name, seconds] of [["short", 0.6], ["long", 3]] as const) {
    await exec(ffmpegBin(), ["-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=880:duration=${seconds}`, "-c:a", "libmp3lame", join(directory, `${name}.mp3`)], { timeout: 15000 });
  }
  shortNarration = await readFile(join(directory, "short.mp3"));
  longNarration = await readFile(join(directory, "long.mp3"));
}, 30000);

beforeEach(() => {
  db.delete(schema.compositions).run();
  db.delete(schema.assets).run();
  db.delete(schema.scripts).run();
  db.update(schema.projects).set({ productImages: [] }).where(eq(schema.projects.id, projectId)).run();
  vi.clearAllMocks();
  state.freeTts.mockResolvedValue({ audio: shortNarration, words: [] });
  state.paidTts.mockResolvedValue(shortNarration);
  state.render.mockImplementation(async (config: ComposeConfig) => {
    const output = join(directory, "output", config.projectId, "final.mp4");
    await mkdir(join(directory, "output", config.projectId), { recursive: true });
    await writeFile(output, "mock render");
    return output;
  });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  sqlite.close();
  await rm(directory, { recursive: true, force: true });
});

function setShots(sources: Array<{ source: "audible" | "silent" | "no-audio"; voiceover?: string; transition?: schema.Shot["transition"] }>) {
  db.insert(schema.scripts).values({ projectId, styleType: "scene", selected: true,
    shots: sources.map((source, index) => ({ ...baseShot, shotId: index + 1,
      voiceover: source.voiceover ?? baseShot.voiceover, transition: source.transition ?? baseShot.transition })),
  }).run();
  db.insert(schema.assets).values(sources.map((source, index) => ({
    projectId, shotId: index + 1, type: "ai_generated" as const, selected: true, status: "done" as const,
    filePath: `/api/files/${projectId}/${source.source}.mp4`,
  }))).run();
}

async function requestCompose(body: Record<string, unknown> = {}) {
  return POST(new NextRequest(`http://localhost/api/project/${projectId}/compose`, {
    method: "POST", body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: projectId }) });
}

async function compose(body: Record<string, unknown> = {}) {
  const response = await requestCompose(body);
  expect(response.status).toBe(202);
  const { compositionId } = await response.json();
  await vi.waitFor(() => {
    expect(db.select().from(schema.compositions).where(eq(schema.compositions.id, compositionId)).get()?.status).toBe("done");
  }, { timeout: 15000, interval: 30 });
  const config = state.render.mock.calls.at(-1)![0] as ComposeConfig;
  const timeline = JSON.parse(await readFile(join(directory, "output", projectId, "final.mp4.timeline.json"), "utf8")) as {
    boundaries: number[];
    total: number;
    audioTracks: Array<{ role: string; clips: Array<{ source: string; start: number; end: number }> }>;
    warnings?: Array<{ code: string; shotId: number }>;
  };
  return { config, timeline };
}

describe("composition shot take selection", () => {
  it("combines independently chosen takes and pins them even when they are not the global selection", async () => {
    setShots([{ source: "audible" }, { source: "no-audio" }]);
    const script = db.select().from(schema.scripts).get()!;
    const originalAssets = db.select().from(schema.assets).all();
    db.insert(schema.assets).values({ id: "alternate-take", projectId, shotId: 1, type: "ai_generated", selected: false,
      status: "done", filePath: `/api/files/${projectId}/silent.mp4` }).run();
    const { config } = await compose({ scriptId: script.id, shotAssetSelections: [
      { shotId: 1, assetId: "alternate-take" },
      { shotId: 2, assetId: originalAssets.find((asset) => asset.shotId === 2)!.id },
    ] });
    expect(config.clips.map((clip) => clip.filePath)).toEqual([
      join(directory, "uploads", projectId, "silent.mp4"),
      join(directory, "uploads", projectId, "no-audio.mp4"),
    ]);
    expect(db.select().from(schema.assets).where(eq(schema.assets.id, "alternate-take")).get()?.selected).toBe(false);
    expect(db.select().from(schema.assets).where(eq(schema.assets.id, originalAssets[0].id)).get()?.selected).toBe(true);
  });

  it("keeps a product-image fallback pinned even when a generated video becomes the global selection", async () => {
    setShots([{ source: "audible" }]);
    await writeFile(join(directory, "uploads", projectId, "product.png"), "image fixture");
    db.update(schema.projects).set({ productImages: [`/api/files/${projectId}/product.png`] }).where(eq(schema.projects.id, projectId)).run();
    const { config } = await compose({ shotAssetSelections: [{ shotId: 1, assetId: null }] });
    expect(config.clips).toHaveLength(1);
    expect(config.clips[0]).toMatchObject({ type: "image", filePath: join(directory, "uploads", projectId, "product.png") });
  });

  it.each(["missing", "wrong-shot", "wrong-project", "old-revision", "unfinished", "missing-file"])("rejects a %s take before creating a composition", async (kind) => {
    setShots([{ source: "audible" }]);
    if (kind === "wrong-project") db.insert(schema.projects).values({ id: "other-project", name: "Other" }).run();
    if (kind !== "missing") db.insert(schema.assets).values({
      id: "unusable-take", projectId: kind === "wrong-project" ? "other-project" : projectId,
      shotId: kind === "wrong-shot" ? 2 : 1, type: "ai_generated", selected: false,
      status: kind === "unfinished" ? "generating" : "done",
      filePath: `/api/files/${projectId}/${kind === "missing-file" ? "deleted" : "silent"}.mp4`,
      ...(kind === "old-revision" ? { sourceScriptId: "old-script", sourceRevision: "old", sourceShotKey: "old" } : {}),
    }).run();
    const response = await requestCompose({ shotAssetSelections: [{ shotId: 1, assetId: "unusable-take" }] });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("重新选择");
    expect(state.render).not.toHaveBeenCalled();
    expect(db.select().from(schema.compositions).all()).toHaveLength(0);
  });

  it.each([null, {}, [{ shotId: 1, assetId: "../file" }], [{ shotId: 99, assetId: "take" }],
    [{ shotId: 1, assetId: "take" }, { shotId: 1, assetId: "take" }]])("rejects malformed take selections: %j", async (shotAssetSelections) => {
    setShots([{ source: "audible" }]);
    const response = await requestCompose({ shotAssetSelections });
    expect(response.status).toBe(400);
    expect(state.render).not.toHaveBeenCalled();
  });

  it("rejects selections from a page whose current script has changed", async () => {
    setShots([{ source: "audible" }]);
    const response = await requestCompose({ scriptId: "previous-script" });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("脚本已切换");
    expect(state.render).not.toHaveBeenCalled();
  });

  it("fails clearly when a pinned video cannot decode instead of silently omitting that shot", async () => {
    setShots([{ source: "audible" }, { source: "no-audio" }]);
    await writeFile(join(directory, "uploads", projectId, "corrupt.mp4"), "broken download");
    db.insert(schema.assets).values({ id: "broken-take", projectId, shotId: 1, type: "ai_generated", selected: false,
      status: "done", filePath: `/api/files/${projectId}/corrupt.mp4` }).run();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await requestCompose({ shotAssetSelections: [{ shotId: 1, assetId: "broken-take" }] });
      expect(response.status).toBe(202);
      const { compositionId } = await response.json();
      await vi.waitFor(async () => {
        const result = await GET(new NextRequest(`http://localhost/api/project/${projectId}/compose?compositionId=${compositionId}`), { params: Promise.resolve({ id: projectId }) });
        expect((await result.json()).composition).toMatchObject({ status: "failed", error: "镜头 1 选中的视频无法解码，请重新选择视频版本后合成" });
      });
      expect(state.render).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});

describe("composition transition overrides", () => {
  it.each(["native", "generated"])("applies an incoming fade and keeps %s audio, subtitles and the timeline aligned", async (audio) => {
    setShots([{ source: "audible" }, { source: "audible" }]);
    const storedScript = db.select().from(schema.scripts).get()!;
    const { config, timeline } = await compose({
      scriptId: storedScript.id,
      transitionOverrides: [{ shotId: 2, transition: "ffmpeg_fade" }],
      ...(audio === "generated" ? { voiceoverMode: "replace", freeTts: { enabled: true } } : {}),
    });
    const baseDuration = audio === "generated" ? 1.5 : sourceSeconds;
    expect(config.clips.map((clip) => clip.transition)).toEqual(["direct_concat", "ffmpeg_fade"]);
    expect(config.clips.map((clip) => clip.duration)).toEqual([baseDuration + FADE_DURATION, baseDuration]);
    expect(timeline.boundaries).toEqual([baseDuration]);
    expect(timeline.total).toBe(baseDuration * 2);
    expect(timeline.audioTracks).toHaveLength(1);
    expect(timeline.audioTracks[0].role).toBe(audio === "generated" ? "dialogue" : "native");
    expect(timeline.audioTracks[0].clips.map(({ start, end }) => ({ start, end }))).toEqual([
      { start: 0, end: baseDuration + FADE_DURATION }, { start: baseDuration, end: baseDuration * 2 },
    ]);
    const cues = config.subtitle!.texts;
    expect(cues.some((cue) => cue.startTime === baseDuration)).toBe(true);
    expect(cues.filter((cue) => cue.startTime < baseDuration).every((cue) => cue.endTime <= baseDuration)).toBe(true);
    const invocation = buildComposeInvocation(config);
    expect(invocation.filterComplex).toContain("xfade=");
    expect(invocation.filterComplex).toContain("acrossfade=");
    expect(invocation.outputArgs).toContain((baseDuration * 2).toFixed(3));
    expect(db.select().from(schema.scripts).get()!.shots).toEqual(storedScript.shots);
  });

  it("replaces an existing fade with direct concatenation without padding or overlap", async () => {
    setShots([{ source: "audible", transition: "ffmpeg_fade" }, { source: "audible", transition: "ffmpeg_fade" }]);
    const storedScript = db.select().from(schema.scripts).get()!;
    const { config, timeline } = await compose({ transitionOverrides: [{ shotId: 2, transition: "direct_concat" }] });
    expect(config.clips.map((clip) => clip.transition)).toEqual(["ffmpeg_fade", "direct_concat"]);
    expect(config.clips.map((clip) => clip.duration)).toEqual([sourceSeconds, sourceSeconds]);
    expect(timeline.boundaries).toEqual([sourceSeconds]);
    expect(timeline.total).toBe(sourceSeconds * 2);
    expect(timeline.audioTracks[0].clips.map(({ start, end }) => ({ start, end }))).toEqual([
      { start: 0, end: sourceSeconds }, { start: sourceSeconds, end: sourceSeconds * 2 },
    ]);
    const { filterComplex } = buildComposeInvocation(config);
    expect(filterComplex).not.toContain("xfade=");
    expect(filterComplex).not.toContain("acrossfade=");
    expect(db.select().from(schema.scripts).get()!.shots).toEqual(storedScript.shots);
  });

  it("applies mixed per-shot choices while retaining an untouched transition", async () => {
    setShots([
      { source: "audible", transition: "ai_reference" },
      { source: "audible", transition: "direct_concat" },
      { source: "audible", transition: "ffmpeg_fade" },
    ]);
    const { config, timeline } = await compose({ transitionOverrides: [
      { shotId: 3, transition: "direct_concat" }, { shotId: 2, transition: "ffmpeg_fade" },
    ] });
    expect(config.clips.map((clip) => clip.transition)).toEqual(["ai_reference", "ffmpeg_fade", "direct_concat"]);
    expect(config.clips.map((clip) => clip.duration)).toEqual([sourceSeconds + FADE_DURATION, sourceSeconds, sourceSeconds]);
    expect(timeline.boundaries).toEqual([sourceSeconds, sourceSeconds * 2]);
    expect(timeline.total).toBe(sourceSeconds * 3);
    const { filterComplex } = buildComposeInvocation(config);
    expect(filterComplex.match(/\bxfade=/g)).toHaveLength(1);
    expect(filterComplex.match(/\bacrossfade=/g)).toHaveLength(1);
  });

  it.each([undefined, []])("preserves existing AI and fade transitions for omitted or empty overrides: %j", async (transitionOverrides) => {
    setShots([
      { source: "audible", transition: "ai_start_end" },
      { source: "audible", transition: "ai_reference" },
      { source: "audible", transition: "ffmpeg_fade" },
    ]);
    const { config } = await compose(transitionOverrides === undefined ? {} : { transitionOverrides });
    expect(config.clips.map((clip) => clip.transition)).toEqual(["ai_start_end", "ai_reference", "ffmpeg_fade"]);
    expect(config.clips.map((clip) => clip.duration)).toEqual([sourceSeconds, sourceSeconds + FADE_DURATION, sourceSeconds]);
  });

  it.each([
    null, {}, "ffmpeg_fade", [null], [[]], [1], ["fade"], [{}],
    [{ shotId: 1 }], [{ transition: "ffmpeg_fade" }],
    [{ shotId: 1, transition: "ai_start_end" }], [{ shotId: 1, transition: "ai_reference" }],
    [{ shotId: 1, transition: "fade" }], [{ shotId: 1, transition: null }],
    [{ shotId: 1, transition: true }], [{ shotId: 1, transition: {} }],
    [{ shotId: "1", transition: "ffmpeg_fade" }], [{ shotId: 1.5, transition: "ffmpeg_fade" }],
    [{ shotId: -1, transition: "ffmpeg_fade" }], [{ shotId: 0, transition: "ffmpeg_fade" }],
    [{ shotId: 99, transition: "ffmpeg_fade" }], [{ shotId: Number.MAX_SAFE_INTEGER + 1, transition: "ffmpeg_fade" }],
    [{ shotId: 1, transition: "ffmpeg_fade" }, { shotId: 1, transition: "direct_concat" }],
    [{ shotId: 1, transition: "ffmpeg_fade" }, { shotId: 2, transition: "ffmpeg_fade" }, { shotId: 3, transition: "ffmpeg_fade" }],
  ])("rejects invalid overrides before TTS, rendering or composition creation: %j", async (transitionOverrides) => {
    setShots([{ source: "audible" }, { source: "audible" }]);
    const projectBefore = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!;
    const scriptBefore = db.select().from(schema.scripts).get()!;
    const response = await requestCompose({
      transitionOverrides, voiceoverMode: "replace", freeTts: { enabled: true },
      ttsConfig: { baseUrl: "https://tts.example", apiKey: "fixture", model: "fixture", voice: "fixture" },
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("转场");
    expect(state.freeTts).not.toHaveBeenCalled();
    expect(state.paidTts).not.toHaveBeenCalled();
    expect(state.render).not.toHaveBeenCalled();
    expect(db.select().from(schema.compositions).all()).toHaveLength(0);
    expect(db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()).toEqual(projectBefore);
    expect(db.select().from(schema.scripts).get()).toEqual(scriptBefore);
  });

  it("retains the stale-script conflict before validating transition overrides", async () => {
    setShots([{ source: "audible" }]);
    const response = await requestCompose({ scriptId: "previous-script", transitionOverrides: null });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("脚本已切换");
    expect(db.select().from(schema.compositions).all()).toHaveLength(0);
    expect(state.render).not.toHaveBeenCalled();
  });
});

describe("composition explicit background music", () => {
  it.each([undefined, `/api/files/${projectId}/missing-bgm.mp3`])("ignores legacy automatic music settings without a valid upload: %j", async (bgmPath) => {
    setShots([{ source: "audible" }]);
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected music download"));
    try {
      const { config, timeline } = await compose({ freeBgm: true, bgmMood: "upbeat", bgmPath });
      expect(network).not.toHaveBeenCalled();
      expect(config.output.bgmPath).toBeUndefined();
      expect(config.output.bgmVolume).toBeUndefined();
      expect(config.output.bgmDuck).toBeUndefined();
      expect(timeline.audioTracks.map((track) => track.role)).toEqual(["native"]);
      expect(config.clips[0]).toMatchObject({ hasAudio: true, duration: sourceSeconds });
      expect(db.select().from(schema.compositions).get()?.bgmPath).toBeNull();
    } finally {
      network.mockRestore();
    }
  });

  it("continues mixing an explicitly uploaded track with narration and native audio", async () => {
    setShots([{ source: "audible" }]);
    const bgmPath = join(directory, "uploads", projectId, "my-music.mp3");
    await writeFile(bgmPath, shortNarration);
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected music download"));
    try {
      const { config, timeline } = await compose({
        bgmPath: `/api/files/${projectId}/my-music.mp3`, bgmVolume: 0.24, bgmDuck: true,
        freeTts: { enabled: true }, voiceoverMode: "mix",
      });
      expect(network).not.toHaveBeenCalled();
      expect(config.output).toMatchObject({ bgmPath, bgmVolume: 0.24, bgmDuck: true });
      expect(config.clips[0]).toMatchObject({ hasAudio: true, mixNativeAudio: true, audioPath: expect.stringMatching(/\.mp3$/) });
      expect(state.freeTts).toHaveBeenCalledTimes(1);
      expect(timeline.audioTracks.map((track) => track.role)).toEqual(["dialogue", "native", "bgm"]);
      expect(timeline.audioTracks.at(-1)).toMatchObject({ source: "my-music.mp3", volume: 0.24, duck: true });
      expect(db.select().from(schema.compositions).get()?.bgmPath).toBe(bgmPath);
    } finally {
      network.mockRestore();
    }
  });
});

describe("composition subtitles", () => {
  it.each([undefined, true])("keeps subtitles enabled when the option is %j", async (subtitles) => {
    setShots([{ source: "audible" }]);
    const { config, timeline } = await compose(subtitles === undefined ? {} : { subtitles });
    expect(config.subtitle?.texts).toEqual([{
      text: baseShot.voiceover, startTime: 0, endTime: sourceSeconds,
    }]);
    expect(config.clips[0]).toMatchObject({ hasAudio: true, duration: sourceSeconds });
    expect(timeline.audioTracks.map((track) => track.role)).toEqual(["native"]);
    expect(state.freeTts).not.toHaveBeenCalled();
    expect(state.paidTts).not.toHaveBeenCalled();
  });

  it.each([
    { label: "ordinary captions", options: { captionPreset: "standard" } },
    { label: "karaoke preset", options: { captionPreset: "karaoke" } },
    { label: "explicit karaoke", options: { karaoke: true } },
  ])("disables $label while preserving narration, native audio, overlays and timing", async ({ options }) => {
    setShots([{ source: "audible" }, { source: "no-audio", transition: "ffmpeg_fade" }]);
    const storedScript = db.select().from(schema.scripts).get()!;
    db.update(schema.scripts).set({ shots: storedScript.shots!.map((shot, index) => ({
      ...shot, textOverlay: { text: index === 0 ? "Product highlight" : "Price details", style: index === 0 ? "highlight" as const : "price" as const },
    })) }).where(eq(schema.scripts.id, storedScript.id)).run();
    const productPath = join(directory, "uploads", projectId, "product.png");
    await writeFile(productPath, "product image fixture");
    db.update(schema.projects).set({ productImages: [`/api/files/${projectId}/product.png`], productName: "Product" })
      .where(eq(schema.projects.id, projectId)).run();
    const body = { ...options, freeTts: { enabled: true }, voiceoverMode: "mix", ctaText: "Buy now", productCard: true };
    const enabled = await compose(body);
    expect(enabled.config.subtitle).toBeDefined();
    if ("karaoke" in options || options.captionPreset === "karaoke") {
      expect(enabled.config.subtitle?.karaokeAssPath).toMatch(/\.ass$/);
    } else {
      expect(enabled.config.subtitle?.texts.length).toBeGreaterThan(0);
    }
    const assFiles = (await readdir(join(directory, "output", projectId))).filter((file) => file.endsWith(".ass")).sort();
    state.freeTts.mockClear();
    const disabled = await compose({ ...body, subtitles: false });
    expect(disabled.config.subtitle).toBeUndefined();
    expect((await readdir(join(directory, "output", projectId))).filter((file) => file.endsWith(".ass")).sort()).toEqual(assFiles);
    expect(state.freeTts).toHaveBeenCalledTimes(2);
    expect(disabled.config.clips).toEqual(enabled.config.clips);
    expect(disabled.config.clips[0]).toMatchObject({ hasAudio: true, mixNativeAudio: true, audioPath: expect.stringMatching(/\.mp3$/) });
    expect(disabled.config.overlays).toEqual(enabled.config.overlays);
    expect(disabled.config.overlays?.map((overlay) => overlay.text)).toEqual(["Product highlight", "Price details", "Buy now"]);
    expect(disabled.config.productCard).toEqual(enabled.config.productCard);
    expect(disabled.config.productCard?.imagePath).toBe(productPath);
    expect(disabled.timeline).toEqual(enabled.timeline);
    expect(disabled.timeline.audioTracks.map((track) => track.role)).toEqual(["dialogue", "native"]);
    expect(buildComposeInvocation(disabled.config).filterComplex).not.toContain("subtitles=");
  });

  it.each([null, "false", "true", 0, 1, {}, []])("rejects a non-boolean subtitle option before starting work: %j", async (subtitles) => {
    setShots([{ source: "audible" }]);
    const projectBefore = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!;
    const response = await requestCompose({ subtitles, freeTts: { enabled: true }, voiceoverMode: "replace" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("字幕");
    expect(state.freeTts).not.toHaveBeenCalled();
    expect(state.paidTts).not.toHaveBeenCalled();
    expect(state.render).not.toHaveBeenCalled();
    expect(db.select().from(schema.compositions).all()).toHaveLength(0);
    expect(db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()).toEqual(projectBefore);
  });
});

describe("composition voiceover modes", () => {
  it("preserves audible source audio by default but narrates silent tracks and videos without an audio stream", async () => {
    setShots([{ source: "audible" }, { source: "silent" }, { source: "no-audio" }]);
    const { config, timeline } = await compose({ freeTts: { enabled: true } });
    expect(state.freeTts).toHaveBeenCalledTimes(2);
    expect(config.clips[0]).toMatchObject({ hasAudio: true, duration: sourceSeconds });
    expect(config.clips[0].audioPath).toBeUndefined();
    for (const clip of config.clips.slice(1)) {
      expect(clip.hasAudio).toBe(false);
      expect(clip.audioPath).toMatch(/\.mp3$/);
      expect(clip.mixNativeAudio).toBeUndefined();
    }
    expect(timeline.audioTracks.find((track) => track.role === "native")?.clips).toEqual([{ source: "audible.mp4", start: 0, end: 2 }]);
    expect(timeline.audioTracks.find((track) => track.role === "dialogue")?.clips).toHaveLength(2);
  });

  it("replaces source audio with generated narration, including when a paid TTS provider is configured", async () => {
    setShots([{ source: "audible" }]);
    const { config, timeline } = await compose({ voiceoverMode: "replace", ttsConfig: { baseUrl: "https://tts.example", apiKey: "fixture", model: "fixture", voice: "fixture" } });
    expect(state.paidTts).toHaveBeenCalledTimes(1);
    expect(state.freeTts).not.toHaveBeenCalled();
    expect(config.clips[0]).toMatchObject({ hasAudio: false, duration: 1.5, sourceDuration: sourceSeconds });
    expect(config.clips[0].audioPath).toMatch(/\.mp3$/);
    expect(config.clips[0].mixNativeAudio).toBeUndefined();
    expect(timeline.audioTracks.map((track) => track.role)).toEqual(["dialogue"]);
  });

  it.each(["short", "long"])("mixes %s narration with source audio and retains enough time for both", async (length) => {
    setShots([{ source: "audible" }]);
    state.freeTts.mockResolvedValue({ audio: length === "short" ? shortNarration : longNarration, words: [] });
    const { config, timeline } = await compose({ voiceoverMode: "mix", freeTts: { enabled: true } });
    expect(state.freeTts).toHaveBeenCalledTimes(1);
    expect(config.clips[0]).toMatchObject({ hasAudio: true, mixNativeAudio: true, sourceDuration: sourceSeconds });
    expect(config.clips[0].audioPath).toMatch(/\.mp3$/);
    expect(config.clips[0].duration).toBeGreaterThanOrEqual(sourceSeconds);
    if (length === "long") expect(config.clips[0].duration).toBeGreaterThan(3);
    else expect(config.clips[0].duration).toBe(sourceSeconds);
    expect(timeline.audioTracks.map((track) => track.role)).toEqual(["dialogue", "native"]);
    expect(timeline.audioTracks.find((track) => track.role === "native")?.clips[0].source).toBe("audible.mp4");
  });

  it.each(["replace", "mix"])("keeps source audio in %s mode when automatic narration is disabled", async (voiceoverMode) => {
    setShots([{ source: "audible" }]);
    const { config, timeline } = await compose({ voiceoverMode, freeTts: { enabled: false } });
    expect(state.freeTts).not.toHaveBeenCalled();
    expect(state.paidTts).not.toHaveBeenCalled();
    expect(config.clips[0]).toMatchObject({ hasAudio: true, duration: sourceSeconds });
    expect(config.clips[0].audioPath).toBeUndefined();
    expect(timeline.audioTracks.map((track) => track.role)).toEqual(["native"]);
  });

  it.each(["replace", "mix"])("keeps source audio in %s mode when narration has no text or generation fails", async (voiceoverMode) => {
    setShots([{ source: "audible", voiceover: "" }, { source: "audible", voiceover: "Fail this narration" }]);
    state.freeTts.mockRejectedValue(new Error("TTS unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { config, timeline } = await compose({ voiceoverMode, freeTts: { enabled: true } });
      expect(state.freeTts).toHaveBeenCalledTimes(1);
      for (const clip of config.clips) {
        expect(clip).toMatchObject({ hasAudio: true, duration: sourceSeconds });
        expect(clip.audioPath).toBeUndefined();
        expect(clip.mixNativeAudio).toBeUndefined();
      }
      expect(timeline.audioTracks.map((track) => track.role)).toEqual(["native"]);
      expect(timeline.audioTracks[0].clips).toHaveLength(2);
      expect(timeline.warnings).toEqual([{ code: "tts_failed", shotId: 2 }]);
    } finally {
      warning.mockRestore();
    }
  });
});
