// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import type Database from "better-sqlite3";
import type { KlingProfile, KlingVideoModelDescriptor } from "@/lib/kling/types";

const state = vi.hoisted(() => ({ directory: "", sqlite: null as Database.Database | null, profile: null as KlingProfile | null, probe: vi.fn(), download: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/db", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  state.sqlite = new Database(":memory:");
  const db = drizzle(state.sqlite);
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return { db, getDb: () => db };
});
vi.mock("@/lib/paths", () => ({ getDataDir: () => state.directory, getUploadsDir: () => path.join(state.directory, "uploads"), getOutputDir: () => path.join(state.directory, "output") }));
vi.mock("@/lib/kling/profiles", () => ({ getProfile: () => structuredClone(state.profile) }));
vi.mock("@/lib/kling/auth", () => ({ refreshProfile: (...args: unknown[]) => state.refresh(...args) }));
vi.mock("@/lib/media-probe", () => ({ probeMedia: (...args: unknown[]) => state.probe(...args) }));
vi.mock("@/lib/kling/download", () => ({ downloadPublicFile: (...args: unknown[]) => state.download(...args) }));

import { getDb } from "@/lib/db";
import { projects, scripts, assets, type Shot } from "@/lib/db/schema";
import { assetScopeForShot } from "@/lib/asset-context";
import { contentHash } from "@/lib/kling/inputs";
import { klingFilmRuns } from "@/lib/kling/film-schema";
import { klingJobs } from "@/lib/kling/job-schema";
import { getKlingFilm, getKlingFilmShots, patchKlingFilmShot } from "@/lib/kling/film-repository";
import { previewKlingFilm, assertKlingFilmContext, verifyKlingFilmFiles, buildFilmShotJobRequest } from "@/lib/kling/film-plan";
import { LEGACY_SILENT_PROMPT_SUFFIX, VIDEO_AUDIO_DIRECTIONS, withVideoAudioMode } from "@/lib/video-audio";
import { buildShotVideoPrompt as compileShotVideoPrompt } from "@/lib/shot-video-prompt";
import { klingAudioPrompt } from "@/lib/kling/audio-prompt";
import type { CreativeIntent, VisualBible } from "@/lib/production-system";
import { createCreativeProfileSnapshot, createPremiumProductCgProfile } from "@/lib/creative-profiles";
import { compilePremiumCgVideoPrompt } from "@/lib/premium-cg-prompt";

const shot: Shot = { shotId: 8, type: "demo", duration: 5, description: "Product on table", camera: "static", visualSource: "ai_generate", transition: "direct_concat", voiceover: "商品清洁更轻松。" };
const model: KlingVideoModelDescriptor = { selectionKey: '["kling-cli","text_to_video","model-1"]', provider: "kling-cli", profileId: "profile-1", region: "global", tool: "text_to_video", remoteModelId: "model-1", displayName: "Model 1", catalogRevision: "catalog-1", available: true,
  parameters: [{ name: "duration", type: "number", required: true, allowedValues: [5, 10], default: 5 }], inputSlots: [], capabilities: { image: false, tailFrame: false, multiImage: false, audio: false } };
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("fixture-image")]);
const buildShotVideoPrompt = (input: Parameters<typeof compileShotVideoPrompt>[0]) => compileShotVideoPrompt({ ...input, locale: "zh" });
function request(extra: Record<string, unknown> = {}) { return { projectId: "project-1", scriptId: "script-1", profileId: "profile-1", selectionKey: state.profile!.catalogSnapshot[0].selectionKey, ...extra }; }
function currentScript() { return getDb().select().from(scripts).where(eq(scripts.id, "script-1")).get()!; }
function setShots(shots: Shot[]) { getDb().update(scripts).set({ shots }).where(eq(scripts.id, "script-1")).run(); }
function useImageModel() {
  const descriptor = state.profile!.catalogSnapshot[0]; descriptor.tool = "image_to_video"; descriptor.inputSlots = [{ name: "image", role: "image", required: true }]; descriptor.capabilities.image = true;
}
async function asset(file = "frame.png", overrides: Partial<typeof assets.$inferInsert> = {}) {
  const filePath = path.join(state.directory, "uploads", file); await fs.writeFile(filePath, file.endsWith("png") ? png : "fixture-video");
  const row: typeof assets.$inferInsert = { id: "asset-1", projectId: "project-1", shotId: shot.shotId, type: "ai_generated", filePath: "/api/files/" + file, status: "done", selected: true, ...assetScopeForShot(currentScript(), shot), ...overrides };
  getDb().insert(assets).values(row).run(); return filePath;
}

beforeAll(async () => { state.directory = await fs.mkdtemp(path.join(os.tmpdir(), "clipforge-kling-film-plan-")); });
beforeEach(async () => {
  vi.stubEnv("CLIPFORGE_KLING_DISABLED", ""); vi.stubEnv("CLIPFORGE_RUNTIME", "");
  state.sqlite!.exec("DELETE FROM kling_film_shots; DELETE FROM kling_film_runs; DELETE FROM kling_job_outputs; DELETE FROM kling_jobs; DELETE FROM assets; DELETE FROM scripts; DELETE FROM projects;");
  vi.clearAllMocks();
  await fs.mkdir(path.join(state.directory, "uploads"), { recursive: true }); await fs.mkdir(path.join(state.directory, "output"), { recursive: true });
  const now = Date.now();
  state.profile = { id: "profile-1", label: "test", region: "global", cliPackage: "@klingai/cli-global", cliVersion: "0.2.0", adapterVersion: "1", nodePath: process.execPath, packagePath: "/fixture", cliEntry: "/fixture/dist/cli.js", homePath: path.join(state.directory, "home"), endpoint: "https://kling.ai/mcp", environmentState: "ready", authState: "authenticated", authRevision: 1, principalKey: '["global","user-1"]', accountSummary: { id: "user-1" }, catalogSnapshot: [structuredClone(model)], catalogRevision: "catalog-1", catalogCheckedAt: now, createdAt: now, updatedAt: now };
  getDb().insert(projects).values({ id: "project-1", name: "Fixture project" }).run();
  getDb().insert(scripts).values({ id: "script-1", projectId: "project-1", styleType: "scene", shots: [shot], selected: true }).run();
  state.refresh.mockImplementation(async () => structuredClone(state.profile));
  state.probe.mockResolvedValue({ duration: 5, width: 1280, height: 720, hasAudio: true, frameRate: 24, formatName: "mov,mp4", videoCodec: "h264" });
  state.download.mockImplementation(async (_url: string, target: string) => { await fs.writeFile(target, png); });
});
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => { state.sqlite?.close(); await fs.rm(state.directory, { recursive: true, force: true }); });

describe("Kling frozen film planning", () => {
  it("shows the exact paid backend CG template in the full-film plan", async () => {
    useImageModel();
    const profile = createPremiumProductCgProfile({ narrationMode: "none" });
    const cgShot: Shot = { ...shot, type: "product_reveal", visualSource: "product_image", voiceover: "", visualIntent: "Observe the approved product silhouette.", camera: "One restrained forward camera move." };
    getDb().update(projects).set({ productImages: ["/api/files/frame.png"], creativeProfile: profile, creativeConfigRevision: 1 }).run();
    getDb().update(scripts).set({ styleType: "premium_product_cg", shots: [cgShot], creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1) }).run();
    await fs.writeFile(path.join(state.directory, "uploads", "frame.png"), png);
    const plan = await previewKlingFilm(request());
    const planned = getKlingFilmShots(plan.runId)[0];
    expect(planned.data.prompt).toBe(compilePremiumCgVideoPrompt(cgShot, profile).prompt);
    expect(buildFilmShotJobRequest(getKlingFilm(plan.runId), planned).prompt).toBe(planned.data.prompt);
    expect(planned.data.prompt).not.toContain("声音要求");
  });

  it("uses the same configured image-to-video prompt as the single-shot path, including project direction", async () => {
    useImageModel();
    const configuredShot: Shot = { ...shot, description: "手指转动金属机身，透明杯身和圆形按键清晰可见。", camera: "镜头平稳向左横移。" };
    const promptSettings = { visualLook: "phone_raw", motionIntensity: "strong", motionRealism: "constraints" } as const;
    const creativeIntent: CreativeIntent = { subject: "保留透明杯身和圆形按键", environment: "浅蓝背景", continuity: ["same product label"] };
    const visualBible: VisualBible = { characterAnchors: [], productAnchors: ["杯身刻度保持完整"], wardrobeAnchors: [], environmentAnchors: ["背景保持浅蓝"], lightingAnchors: [], forbiddenChanges: [] };
    setShots([configuredShot]);
    getDb().update(projects).set({ productCategory: "tech", creativeIntent, visualBible }).where(eq(projects.id, "project-1")).run();

    const view = await previewKlingFilm(request({ promptSettings }));
    const prompt = getKlingFilmShots(view.runId)[0].data.prompt;
    const expected = buildShotVideoPrompt({ shot: configuredShot, ordinal: 0, settings: promptSettings, category: "tech", creativeIntent, visualBible });

    expect(prompt).toBe(klingAudioPrompt(expected.prompt, false));
    expect(prompt).toBe(withVideoAudioMode(expected.prompt, "silent"));
    expect(prompt).toContain("内容创作者手机手持实拍");
    expect(prompt).toContain("运镜幅度大胆明显");
    expect(prompt).toContain("全程保持未调色的自然色彩与混合色温");
    expect(prompt).toContain("same product label");
    expect(prompt).toContain("杯身刻度保持完整");
    expect(view.promptSettings).toEqual(promptSettings);
    expect(getKlingFilm(view.runId).data.promptSettings).toEqual(promptSettings);
  });
  it("keeps legacy requests compatible and fills omitted prompt settings before freezing", async () => {
    useImageModel();
    const legacy = await previewKlingFilm(request());
    const explicit = await previewKlingFilm(request({ promptSettings: { visualLook: "none", motionIntensity: "normal", motionRealism: "auto" } }));
    const partial = await previewKlingFilm(request({ promptSettings: { visualLook: "daylight_clean" } }));

    expect(legacy.promptSettings).toEqual({ visualLook: "none", motionIntensity: "normal", motionRealism: "auto" });
    expect(getKlingFilm(legacy.runId).data.promptSettings).toEqual(legacy.promptSettings);
    expect(getKlingFilmShots(legacy.runId)[0].data.prompt).toBe(klingAudioPrompt(buildShotVideoPrompt({ shot, ordinal: 0 }).prompt, false));
    expect(explicit.planHash).toBe(legacy.planHash);
    expect(partial.promptSettings).toEqual({ visualLook: "daylight_clean", motionIntensity: "normal", motionRealism: "auto" });
    expect(getKlingFilmShots(partial.runId)[0].data.prompt).toContain("全程保持明亮清透的自然日光");
  });
  it("includes each prompt setting in the frozen plan hash and retains its original value", async () => {
    useImageModel();
    const movingShot: Shot = { ...shot, description: "Rotate the metal device on the table.", camera: "camera tracks left" };
    setShots([movingShot]);
    getDb().update(projects).set({ productCategory: "tech" }).where(eq(projects.id, "project-1")).run();
    const baseline = await previewKlingFilm(request());
    const look = await previewKlingFilm(request({ promptSettings: { visualLook: "warm_life" } }));
    const intensity = await previewKlingFilm(request({ promptSettings: { motionIntensity: "subtle" } }));
    const realism = await previewKlingFilm(request({ promptSettings: { motionRealism: "off" } }));
    expect(new Set([baseline.planHash, look.planHash, intensity.planHash, realism.planHash]).size).toBe(4);
    expect(getKlingFilmShots(look.runId)[0].data.prompt).toContain("全程保持温暖的橙黄午后光调");
    expect(getKlingFilmShots(intensity.runId)[0].data.prompt).toContain("运镜幅度轻微克制");
    expect(getKlingFilmShots(baseline.runId)[0].data.prompt).toContain("转动机身，金属边框上一道高光缓缓扫过");
    expect(getKlingFilmShots(realism.runId)[0].data.prompt).not.toContain("转动机身，金属边框上一道高光缓缓扫过");

    const promptSettings = { visualLook: "phone_raw", motionIntensity: "strong", motionRealism: "constraints" };
    const frozen = await previewKlingFilm(request({ promptSettings }));
    const frozenPrompt = getKlingFilmShots(frozen.runId)[0].data.prompt;
    promptSettings.visualLook = "daylight_clean";
    promptSettings.motionIntensity = "subtle";
    promptSettings.motionRealism = "off";
    expect(getKlingFilm(frozen.runId).data.promptSettings).toEqual({ visualLook: "phone_raw", motionIntensity: "strong", motionRealism: "constraints" });
    expect(getKlingFilmShots(frozen.runId)[0].data.prompt).toBe(frozenPrompt);
    assertKlingFilmContext(frozen.runId);
  });
  it.each([
    { visualLook: "unknown-look" },
    { motionIntensity: "huge" },
    { motionRealism: "imaginary" },
    { visualLook: null },
    null,
    [],
    "phone_raw",
  ])("rejects invalid prompt settings without saving a plan: %j", async (promptSettings) => {
    await expect(previewKlingFilm(request({ promptSettings }))).rejects.toMatchObject({ code: "KLING_FILM_PROMPT_SETTINGS_INVALID" });
    expect(getDb().select().from(klingFilmRuns).all()).toHaveLength(0);
    expect(state.download).not.toHaveBeenCalled();
  });
  it("preserves product fidelity for a generated CTA and avoids conflicting handheld or strong motion", async () => {
    useImageModel();
    const cta: Shot = { ...shot, type: "cta", visualSource: "ai_generate", description: "商品与购买引导保持静止，浅蓝色纯净背景。下方显示“点击下方小黄车”。", camera: "固定镜头。", voiceover: "" };
    setShots([cta]);
    const promptSettings = { visualLook: "phone_raw", motionIntensity: "strong", motionRealism: "auto" } as const;
    const view = await previewKlingFilm(request({ promptSettings }));
    const prompt = getKlingFilmShots(view.runId)[0].data.prompt;
    expect(prompt).toBe(withVideoAudioMode(buildShotVideoPrompt({ shot: cta, ordinal: 0, settings: promptSettings }).prompt, "silent"));
    expect(prompt).toContain("商品的外观、包装、颜色、标志与文字必须保持完全不变");
    expect(prompt).toContain("主体保持静止");
    expect(prompt).not.toContain("内容创作者手机手持实拍");
    expect(prompt).not.toContain("运镜幅度大胆明显");
  });
  it("keeps talking-character behavior when the selected sound strategy is post-production narration", async () => {
    useImageModel();
    const presenter: Shot = { ...shot, type: "hook", characterId: "presenter-1", description: "人物面向镜头展示商品。", camera: "镜头平稳向左横移。" };
    setShots([presenter]);
    const view = await previewKlingFilm(request());
    const prompt = getKlingFilmShots(view.runId)[0].data.prompt;
    expect(prompt).toBe(withVideoAudioMode(buildShotVideoPrompt({ shot: presenter, ordinal: 0 }).prompt, "silent"));
    expect(prompt).toContain("人物对着镜头自然说话：口型自然开合");
    expect(prompt).toContain(VIDEO_AUDIO_DIRECTIONS.silent.zh);
    expect(prompt).not.toContain("原生音频必须逐字说出");
  });
  it.each([
    ["category", { productCategory: "tech" }],
    ["creative direction", { creativeIntent: { subject: "Keep the blue package visible" } }],
    ["visual anchors", { visualBible: { characterAnchors: [], productAnchors: ["blue package"], wardrobeAnchors: [], environmentAnchors: [], lightingAnchors: [], forbiddenChanges: [] } }],
  ] as Array<[string, Partial<typeof projects.$inferInsert>]>)("invalidates a frozen plan when project %s changes", async (_label, update) => {
    const original = await previewKlingFilm(request());
    expect(getKlingFilm(original.runId).data.projectPromptRevision).toEqual(expect.any(String));
    assertKlingFilmContext(original.runId);
    getDb().update(projects).set(update).where(eq(projects.id, "project-1")).run();

    expect(() => assertKlingFilmContext(original.runId)).toThrow(expect.objectContaining({ code: "KLING_CONTEXT_CHANGED" }));
    const revised = await previewKlingFilm(request());
    expect(revised.planHash).not.toBe(original.planHash);
    assertKlingFilmContext(revised.runId);
  });
  it("keeps older saved plans without a project prompt revision readable", async () => {
    const view = await previewKlingFilm(request());
    const run = getKlingFilm(view.runId);
    delete run.data.projectPromptRevision;
    getDb().update(klingFilmRuns).set({ data: run.data }).where(eq(klingFilmRuns.id, run.id)).run();
    getDb().update(projects).set({ creativeIntent: { subject: "New project direction" } }).where(eq(projects.id, "project-1")).run();
    expect(() => assertKlingFilmContext(view.runId)).not.toThrow();
  });
  it.each(["negative_prompt", "negativePrompt"])("maps project negative direction into the model-declared %s option", async (name) => {
    useImageModel();
    await asset();
    state.profile!.catalogSnapshot[0].parameters.push({ name, type: "string", required: false });
    getDb().update(projects).set({ creativeIntent: { subject: "Product on table", negative: ["warped logo", "extra buttons"] } }).where(eq(projects.id, "project-1")).run();

    const view = await previewKlingFilm(request());
    const run = getKlingFilm(view.runId);
    const planned = getKlingFilmShots(view.runId)[0];
    expect(planned.data.options).toEqual({ duration: 5, [name]: "warped logo，extra buttons" });
    expect(buildFilmShotJobRequest(run, planned).options?.[name]).toBe("warped logo，extra buttons");
    expect(planned.data.prompt).toBe(klingAudioPrompt(buildShotVideoPrompt({ shot, ordinal: 0, creativeIntent: { subject: "Product on table", negative: ["warped logo", "extra buttons"] } }).prompt, false));
  });
  it.each(["negative_prompt", "negativePrompt"])("merges raw negative direction into the declared %s alias", async (name) => {
    state.profile!.catalogSnapshot[0].parameters.push({ name, type: "string", required: false });
    const rawAlias = name === "negative_prompt" ? "negativePrompt" : "negative_prompt";
    getDb().update(projects).set({ creativeIntent: { subject: "Product on table", negative: ["warped logo"] } }).where(eq(projects.id, "project-1")).run();

    const view = await previewKlingFilm(request({ options: { [rawAlias]: "overexposure" } }));
    expect(getKlingFilmShots(view.runId)[0].data.options).toEqual({ duration: 5, [name]: "overexposure, warped logo" });
  });
  it("does not invent a negative-prompt option when the selected model declares neither alias", async () => {
    getDb().update(projects).set({ creativeIntent: { subject: "Product on table", negative: ["warped logo"] } }).where(eq(projects.id, "project-1")).run();
    const view = await previewKlingFilm(request());
    const planned = getKlingFilmShots(view.runId)[0];
    expect(planned.data.options).toEqual({ duration: 5 });
    expect(buildFilmShotJobRequest(getKlingFilm(view.runId), planned).options).toEqual({ duration: 5 });
  });
  it("rejects a final prompt with incomplete display text before storing a plan", async () => {
    useImageModel();
    setShots([{ ...shot, description: "商品居中，下方小字显示“价格。" }]);
    await expect(previewKlingFilm(request())).rejects.toMatchObject({ code: "KLING_FILM_PROMPT_INVALID", message: expect.stringContaining("引号未闭合") });
    expect(getDb().select().from(klingFilmRuns).all()).toHaveLength(0);
    expect(getDb().select().from(klingJobs).all()).toHaveLength(0);
  });
  it("rejects a final prompt that requests a forbidden project change before storing a plan", async () => {
    useImageModel();
    const visualBible: VisualBible = { characterAnchors: [], productAnchors: [], wardrobeAnchors: [], environmentAnchors: [], lightingAnchors: [], forbiddenChanges: ["replacement packaging"] };
    getDb().update(projects).set({ visualBible }).where(eq(projects.id, "project-1")).run();
    setShots([{ ...shot, description: "Show replacement packaging on the table." }]);
    await expect(previewKlingFilm(request())).rejects.toMatchObject({ code: "KLING_FILM_PROMPT_INVALID", message: expect.stringContaining("replacement packaging") });
    expect(getDb().select().from(klingFilmRuns).all()).toHaveLength(0);
    expect(getDb().select().from(klingJobs).all()).toHaveLength(0);
  });
  it("creates a zero-based frozen draft without creating any generation job", async () => {
    setShots([shot, { ...shot, shotId: 21, duration: 7 }]);
    const view = await previewKlingFilm(request()); const run = getKlingFilm(view.runId), planned = getKlingFilmShots(run.id);
    expect(view).toMatchObject({ status: "draft", totalShots: 2, readyShots: 0, billableShotCount: 2, missingKeyframes: [] });
    expect(planned.map((item) => [item.ordinal, item.shotId, item.data.generationDuration])).toEqual([[0, 8, 5], [1, 21, 10]]);
    expect(run.data.scriptSnapshot.shots).toEqual([shot, { ...shot, shotId: 21, duration: 7 }]);
    expect(planned[0].data.prompt).toContain(VIDEO_AUDIO_DIRECTIONS.silent.zh);
    expect(planned[0].data.prompt).not.toContain(VIDEO_AUDIO_DIRECTIONS.ambient.zh);
    expect(getDb().select().from(klingJobs).all()).toHaveLength(0); expect(state.download).not.toHaveBeenCalled();
    assertKlingFilmContext(run.id);
  });
  it("keeps missing image keyframes visible in a successful draft", async () => {
    useImageModel(); const view = await previewKlingFilm(request());
    expect(view.missingKeyframes).toEqual([shot.shotId]); expect(view.billableShotCount).toBe(1);
    expect(getKlingFilmShots(view.runId)[0].data.inputs).toEqual([]);
    expect(() => buildFilmShotJobRequest(getKlingFilm(view.runId), getKlingFilmShots(view.runId)[0])).toThrow();
  });
  it("rejects unknown duration bounds and an explicitly too short duration", async () => {
    setShots([{ ...shot, duration: 7 }]);
    await expect(previewKlingFilm(request({ options: { duration: 5 } }))).rejects.toMatchObject({ code: "KLING_FILM_DURATION_UNSUPPORTED" });
    state.profile!.catalogSnapshot[0].parameters = [{ name: "duration", type: "number", required: true }];
    await expect(previewKlingFilm(request())).rejects.toMatchObject({ code: "KLING_FILM_DURATION_UNSUPPORTED" });
    expect(getDb().select().from(klingFilmRuns).all()).toHaveLength(0);
  });
  it("accepts only a declared duration alias and detects contradictory aliases", async () => {
    state.profile!.catalogSnapshot[0].parameters[0].name = "duration_seconds";
    const view = await previewKlingFilm(request({ options: { duration: 10 } }));
    expect(getKlingFilmShots(view.runId)[0].data.options).toEqual({ duration_seconds: 10 });
    await expect(previewKlingFilm(request({ options: { duration: 5, duration_seconds: 10 } }))).rejects.toMatchObject({ code: "KLING_FILM_DURATION_UNSUPPORTED" });
  });
  it("rejects unsupported native audio and enables a declared audio flag with exact dialogue", async () => {
    await expect(previewKlingFilm(request({ output: { audioStrategy: "native" } }))).rejects.toMatchObject({ code: "KLING_FILM_AUDIO_UNSUPPORTED" });
    const descriptor = state.profile!.catalogSnapshot[0]; descriptor.capabilities.audio = true;
    await expect(previewKlingFilm(request({ output: { audioStrategy: "native" } }))).rejects.toMatchObject({ code: "KLING_FILM_AUDIO_UNSUPPORTED" });
    descriptor.parameters.push({ name: "sound", type: "string", required: false, allowedValues: ["on", "off"], default: "off" });
    const view = await previewKlingFilm(request({ output: { audioStrategy: "native" } })); const planned = getKlingFilmShots(view.runId)[0];
    expect(planned.data.options.sound).toBe("on"); expect(planned.data.prompt).toContain(JSON.stringify(shot.voiceover));
    const muted = await previewKlingFilm(request()); expect(getKlingFilmShots(muted.runId)[0].data.options.sound).toBe("off");
  });
  it.each(["enable_audio", "audio"])("freezes mix mode and controls the declared %s flag through the sound strategy", async (name) => {
    const descriptor = state.profile!.catalogSnapshot[0];
    descriptor.capabilities.audio = true;
    const on = name === "enable_audio" ? "true" : true;
    const off = name === "enable_audio" ? "false" : false;
    descriptor.parameters.push({ name, type: name === "enable_audio" ? "string" : "boolean", required: false, allowedValues: [on, off], default: off });
    const replacement = await previewKlingFilm(request({ options: { [name]: on } }));
    const mixed = await previewKlingFilm(request({ options: { [name]: off }, output: { audioStrategy: "edge-tts-mix" } }));
    const native = await previewKlingFilm(request({ output: { audioStrategy: "native" } }));
    const planned = getKlingFilmShots(mixed.runId)[0];
    expect(mixed.output.audioStrategy).toBe("edge-tts-mix");
    expect(getKlingFilmShots(replacement.runId)[0].data.options[name]).toBe(off);
    expect(planned.data.options[name]).toBe(on);
    expect(getKlingFilmShots(native.runId)[0].data.options[name]).toBe(on);
    expect(planned.data.prompt).toContain(VIDEO_AUDIO_DIRECTIONS.ambient.zh);
    expect(planned.data.prompt).not.toContain(VIDEO_AUDIO_DIRECTIONS.silent.zh);
    expect(planned.data.prompt).not.toContain("原生音频必须逐字说出");
    expect(buildFilmShotJobRequest(getKlingFilm(mixed.runId), planned).options?.[name]).toBe(on);
    expect(new Set([replacement.planHash, mixed.planHash, native.planHash]).size).toBe(3);
  });
  it("allows mix mode without inventing an audio flag when the model does not declare one", async () => {
    const view = await previewKlingFilm(request({ output: { audioStrategy: "edge-tts-mix" } }));
    expect(view.output.audioStrategy).toBe("edge-tts-mix");
    expect(getKlingFilmShots(view.runId)[0].data.options).toEqual({ duration: 5 });
  });
  it("keeps approved visual facts and omits saved English image templates before freezing", async () => {
    setShots([{ ...shot, description: "商品与购买引导保持静止。底部显示“价格、使用及清洗要求以商品页和说明书为准”。", prompt: `English image template. ${VIDEO_AUDIO_DIRECTIONS.ambient.zh}。\n${LEGACY_SILENT_PROMPT_SUFFIX}` }]);
    const view = await previewKlingFilm(request());
    const prompt = getKlingFilmShots(view.runId)[0].data.prompt;
    expect(prompt).toContain("底部显示“价格、使用及清洗要求以商品页和说明书为准”。");
    expect(prompt).not.toContain(VIDEO_AUDIO_DIRECTIONS.ambient.zh);
    expect(prompt).not.toContain("覆盖前文");
    expect(prompt).not.toContain("English image template");
    expect(prompt.split(VIDEO_AUDIO_DIRECTIONS.silent.zh)).toHaveLength(2);
    expect(prompt).not.toContain(VIDEO_AUDIO_DIRECTIONS.silent.en);
  });
  it("does not carry ambient-only speech bans into native dialogue", async () => {
    const descriptor = state.profile!.catalogSnapshot[0]; descriptor.capabilities.audio = true;
    descriptor.parameters.push({ name: "audio", type: "boolean", required: false, allowedValues: [true, false], default: false });
    setShots([{ ...shot, prompt: `商品展示。${VIDEO_AUDIO_DIRECTIONS.ambient.zh}。\n${LEGACY_SILENT_PROMPT_SUFFIX}` }]);
    const view = await previewKlingFilm(request({ output: { audioStrategy: "native" } }));
    const prompt = getKlingFilmShots(view.runId)[0].data.prompt;
    expect(prompt).toContain(`原生音频必须逐字说出以下台词，不改写、不增添：${JSON.stringify(shot.voiceover)}`);
    expect(prompt).toContain(VIDEO_AUDIO_DIRECTIONS.native.zh);
    expect(prompt).not.toMatch(/无人声说话|no speech|全程静音|entire video silent/i);
  });
  it.each([true, false])("reuses existing videos in mix mode with hasAudio=%s and preserves their full duration", async (hasAudio) => {
    await asset("video.mp4", { type: "ai_generated" });
    state.probe.mockResolvedValue({ duration: 7, width: 1280, height: 720, hasAudio });
    const view = await previewKlingFilm(request({ output: { audioStrategy: "edge-tts-mix" } }));
    expect(view).toMatchObject({ readyShots: 1, billableShotCount: 0, output: { audioStrategy: "edge-tts-mix" } });
    expect(getKlingFilmShots(view.runId)[0].data.source).toBe("reuse");
    expect(view.warnings).toContainEqual(expect.stringContaining("叠加配音策略将保留完整视频和音轨"));
    expect(getDb().select().from(klingJobs).all()).toHaveLength(0);
  });
  it("freezes actual keyframe bytes and builds a stable ordinary child request", async () => {
    useImageModel(); await asset(); const view = await previewKlingFilm(request()); const run = getKlingFilm(view.runId), planned = getKlingFilmShots(run.id)[0];
    expect(planned.data.inputs[0]).toMatchObject({ sourceUrl: "/api/files/frame.png", hash: contentHash(png), role: "image" });
    expect(planned.data.inputs[0].path).toContain("film-" + run.id + "-0"); await verifyKlingFilmFiles(run.id);
    const child = buildFilmShotJobRequest(run, planned);
    expect(child).toMatchObject({ executionScope: "single-shot", imageUrl: "/api/files/frame.png", expectedSelectedAssetId: "asset-1", shotId: shot.shotId, clientRequestId: `film-${run.id}-${planned.id}-0` });
    expect(buildFilmShotJobRequest(run, planned)).toEqual(child);
  });
  it("detects changed originals even if their private snapshots remain intact", async () => {
    useImageModel(); const original = await asset(); const view = await previewKlingFilm(request());
    await fs.writeFile(original, Buffer.concat([png, Buffer.from("changed")]));
    await expect(verifyKlingFilmFiles(view.runId)).rejects.toMatchObject({ code: "KLING_INPUT_CHANGED" });
  });
  it("detects changed snapshots even when originals remain intact", async () => {
    useImageModel(); await asset(); const view = await previewKlingFilm(request()); const planned = getKlingFilmShots(view.runId)[0];
    await fs.writeFile(planned.data.inputs[0].path, "tampered");
    await expect(verifyKlingFilmFiles(view.runId)).rejects.toMatchObject({ code: "KLING_INPUT_CHANGED" });
  });
  it("checks remote keyframe content through the bounded downloader", async () => {
    useImageModel(); await asset("frame.png", { filePath: "https://example.com/frame.png" }); const view = await previewKlingFilm(request());
    await verifyKlingFilmFiles(view.runId); expect(state.download).toHaveBeenCalledTimes(2);
    expect(state.download.mock.calls[1][2]).toBe(20 * 1024 * 1024);
    state.download.mockImplementationOnce(async (_url: string, target: string) => { await fs.writeFile(target, "different"); });
    await expect(verifyKlingFilmFiles(view.runId)).rejects.toMatchObject({ code: "KLING_INPUT_CHANGED" });
  });
  it("reuses a valid local video and freezes its content rather than generating", async () => {
    const original = await asset("video.mp4", { type: "ai_generated", provider: "kling-cli" }); const view = await previewKlingFilm(request());
    expect(view).toMatchObject({ readyShots: 1, billableShotCount: 0 });
    expect(getKlingFilmShots(view.runId)[0].data).toMatchObject({ source: "reuse", videoUrl: "/api/files/video.mp4", sourceFilePath: original, sourceFileHash: contentHash("fixture-video") });
    await verifyKlingFilmFiles(view.runId); await fs.writeFile(original, "replaced");
    await expect(verifyKlingFilmFiles(view.runId)).rejects.toMatchObject({ code: "KLING_FILM_SOURCE_CHANGED" });
  });
  it("uses completed video's new frozen file even after the old keyframe disappears", async () => {
    useImageModel(); const original = await asset(); const view = await previewKlingFilm(request()); const planned = getKlingFilmShots(view.runId)[0];
    const video = path.join(state.directory, "output", "generated.mp4"); await fs.writeFile(video, "generated-video");
    patchKlingFilmShot(planned.id, { status: "ready", assetId: "generated-asset" }, { sourceFilePath: video, sourceFileHash: contentHash("generated-video"), videoUrl: "/api/output/generated.mp4" });
    await fs.unlink(original); await fs.unlink(planned.data.inputs[0].path); await verifyKlingFilmFiles(view.runId);
    await fs.writeFile(video, "changed-video"); await expect(verifyKlingFilmFiles(view.runId)).rejects.toMatchObject({ code: "KLING_FILM_SOURCE_CHANGED" });
  });
  it("regenerates invalid, too-short or explicitly nonreusable videos", async () => {
    await asset("video.mp4", { type: "ai_generated" }); state.probe.mockResolvedValueOnce({ duration: 1, width: 1280, height: 720, hasAudio: true });
    const short = await previewKlingFilm(request()); expect(short.billableShotCount).toBe(1); expect(short.warnings).toHaveLength(1);
    const forced = await previewKlingFilm(request({ reuseExistingVideos: false })); expect(forced.billableShotCount).toBe(1); expect(state.probe).toHaveBeenCalledTimes(1);
  });
  it("does not reuse a silent video for native spoken dialogue", async () => {
    await asset("video.mp4", { type: "ai_generated" }); const descriptor = state.profile!.catalogSnapshot[0]; descriptor.capabilities.audio = true;
    state.probe.mockResolvedValueOnce({ duration: 5, width: 1280, height: 720, hasAudio: false });
    await expect(previewKlingFilm(request({ output: { audioStrategy: "native" } }))).rejects.toMatchObject({ code: "KLING_FILM_AUDIO_UNSUPPORTED" });
  });
  it("never treats a Kling output thumbnail as an original keyframe", async () => {
    useImageModel(); await asset("video.mp4", { type: "ai_generated", provider: "kling-cli", thumbnailPath: "/api/files/frame.png" });
    const view = await previewKlingFilm(request({ reuseExistingVideos: false })); expect(view.missingKeyframes).toEqual([shot.shotId]);
    getDb().update(assets).set({ sourceKeyframeUrl: "data:image/png;base64," + png.toString("base64") }).where(eq(assets.id, "asset-1")).run();
    const source = await previewKlingFilm(request({ reuseExistingVideos: false })); expect(source.missingKeyframes).toEqual([]); await verifyKlingFilmFiles(source.runId);
  });
  it("ignores stale-script assets with reused numeric shot IDs", async () => {
    useImageModel(); await asset("video.mp4", { type: "ai_generated", sourceScriptId: "old-script" });
    const view = await previewKlingFilm(request()); expect(view.missingKeyframes).toEqual([shot.shotId]); expect(view.billableShotCount).toBe(1);
    expect(getKlingFilmShots(view.runId)[0].data.baselineAssetId).toBeNull();
  });
  it("detects selected script, order and selected-asset changes synchronously", async () => {
    const view = await previewKlingFilm(request()); setShots([{ ...shot, description: "changed" }]);
    expect(() => assertKlingFilmContext(view.runId)).toThrow();
    setShots([shot]); const baseline = await previewKlingFilm(request()); await asset();
    expect(() => assertKlingFilmContext(baseline.runId)).toThrow();
    getDb().update(assets).set({ selected: false }).run(); assertKlingFilmContext(baseline.runId);
  });
  it("rejects a deleted project even if its script remains in a legacy database", async () => {
    const view = await previewKlingFilm(request());
    getDb().delete(projects).where(eq(projects.id, "project-1")).run();
    expect(() => assertKlingFilmContext(view.runId)).toThrow(/项目已不存在/);
  });
  it("includes model, output, script and selected input bytes in the plan hash", async () => {
    useImageModel(); const original = await asset(); const first = await previewKlingFilm(request()); const identical = await previewKlingFilm(request());
    expect(identical.planHash).toBe(first.planHash);
    const output = await previewKlingFilm(request({ output: { resolution: "1080p" } })); expect(output.planHash).not.toBe(first.planHash);
    await fs.writeFile(original, Buffer.concat([png, Buffer.from("new")]));
    const image = await previewKlingFilm(request()); expect(image.planHash).not.toBe(first.planHash);
  });
  it("enforces both script totals and rounded paid generation totals", async () => {
    setShots(Array.from({ length: 51 }, (_, i) => ({ ...shot, shotId: i, duration: 1 })));
    await expect(previewKlingFilm(request())).rejects.toMatchObject({ code: "KLING_FILM_LIMIT_EXCEEDED" });
    setShots([{ ...shot, duration: 601 }]); await expect(previewKlingFilm(request())).rejects.toMatchObject({ code: "KLING_FILM_LIMIT_EXCEEDED" });
    state.profile!.catalogSnapshot[0].parameters[0].allowedValues = [20];
    setShots(Array.from({ length: 31 }, (_, i) => ({ ...shot, shotId: i, duration: 10 })));
    await expect(previewKlingFilm(request())).rejects.toMatchObject({ code: "KLING_FILM_LIMIT_EXCEEDED" });
    expect(getDb().select().from(klingFilmRuns).all()).toHaveLength(0);
  });
  it("rechecks the selected script after asynchronous input copying", async () => {
    useImageModel(); await asset("frame.png", { filePath: "https://example.com/frame.png" });
    state.download.mockImplementationOnce(async (_url: string, target: string) => { await fs.writeFile(target, png); setShots([{ ...shot, description: "changed during copy" }]); });
    await expect(previewKlingFilm(request())).rejects.toMatchObject({ code: "KLING_CONTEXT_CHANGED" });
    expect(getDb().select().from(klingFilmRuns).all()).toHaveLength(0);
  });
  it("rejects expired authentication refreshed into a logged-out profile", async () => {
    state.profile!.catalogCheckedAt = Date.now() - 400000; state.refresh.mockResolvedValueOnce({ ...state.profile, authState: "unauthenticated", principalKey: undefined });
    await expect(previewKlingFilm(request())).rejects.toMatchObject({ code: "KLING_LOGIN_REQUIRED" });
  });
  it("previews a production web film with an explicit migration directory", async () => {
    vi.stubEnv("APP_MIGRATIONS_DIR", "standalone-migrations");
    await expect(previewKlingFilm(request())).resolves.toMatchObject({ status: "draft", billableShotCount: 1 });
  });
  it.each([["CLIPFORGE_KLING_DISABLED", "1"], ["CLIPFORGE_RUNTIME", "desktop"]])("does not enable the service in a disabled runtime: %s", async (name, value) => {
    vi.stubEnv(name, value);
    await expect(previewKlingFilm(request())).rejects.toMatchObject({ code: "KLING_SCOPE_UNSUPPORTED" });
  });
});
