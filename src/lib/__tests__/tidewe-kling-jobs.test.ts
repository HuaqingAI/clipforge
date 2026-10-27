// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { eq } from "drizzle-orm";
import type Database from "better-sqlite3";
import type { KlingProfile, KlingRunOptions, KlingVideoModelDescriptor } from "@/lib/kling/types";
import type { KlingSubmitRequest } from "@/lib/kling/job-types";

const state = vi.hoisted(() => ({ directory: "", sqlite: null as Database.Database | null, profile: null as KlingProfile | null,
  lease: vi.fn(), cli: vi.fn(), refresh: vi.fn(), prepare: vi.fn() }));
vi.mock("@/lib/paths", () => ({ getDataDir: () => state.directory, getUploadsDir: () => path.join(state.directory, "uploads") }));
vi.mock("@/lib/db", async () => {
  const { default: Sqlite } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  state.sqlite = new Sqlite(":memory:");
  const db = drizzle(state.sqlite); migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return { db, getDb: () => db };
});
vi.mock("@/lib/kling/profiles", () => ({ getProfile: () => structuredClone(state.profile) }));
vi.mock("@/lib/kling/auth", () => ({ refreshProfile: (...args: unknown[]) => state.refresh(...args) }));
vi.mock("@/lib/kling/cli-runner", () => ({ runKling: (...args: unknown[]) => state.cli(...args), withKlingLease: (...args: unknown[]) => state.lease(...args) }));
vi.mock("@/lib/kling/inputs", async (original) => ({ ...await original<typeof import("@/lib/kling/inputs")>(), prepareKlingInputs: (...args: unknown[]) => state.prepare(...args) }));

import { getDb } from "@/lib/db";
import { assets, projects, scripts, type Shot } from "@/lib/db/schema";
import { klingProfiles } from "@/lib/kling/profile-schema";
import { klingJobs } from "@/lib/kling/job-schema";
import { klingFilmRuns } from "@/lib/kling/film-schema";
import { createKlingJob, dispatchKlingJob, stopKlingJobRunner, createKlingFilmShotJob, dispatchKlingFilmShotJob } from "@/lib/kling/jobs";
import { getKlingJob } from "@/lib/kling/repository";
import { createCreativeProfileSnapshot, createTideweOutdoorProfile } from "@/lib/creative-profiles";
import { previewProjectVideoPrompt } from "@/lib/server/video-prompt";
import { DEFAULT_VIDEO_PROMPT_SETTINGS } from "@/lib/shot-video-prompt";
import type { VideoPromptRequest } from "@/lib/video-prompt-request";
import { englishWordCount, productFactsHash } from "@/lib/tidewe/validation";
import { TIDEWE_COMPILER_VERSION, TIDEWE_CORPUS_VERSION, type ProductFacts, type TideweCopyDocument, type TidewePresenterSnapshot } from "@/lib/tidewe/types";
import { tidewePresenterAnchor } from "@/lib/tidewe/presenter";
import { compileTideweVisualPrompt } from "@/lib/tidewe/visual-policy";
import { assetScopeForShot } from "@/lib/asset-context";

const profile = createTideweOutdoorProfile({ speechMode: "voiceover" });
const facts: ProductFacts = { version: 1, brand: "TIDEWE", category: "hunting_chair", items: [] };
const text = "Long waits change what you want from a chair.";
const copy: TideweCopyDocument = { version: 1, language: "en-US", text, translation: "长时间等待会改变你对一把椅子的需求。", angle: "long_wait", hookType: "scene", claimedFactIds: [], factsSnapshot: facts, factsHash: productFactsHash(facts), corpusVersion: TIDEWE_CORPUS_VERSION, compilerVersion: TIDEWE_COMPILER_VERSION, exampleIds: [], wordCount: englishWordCount(text), estimatedDuration: 5 };
const shot: Shot = { shotId: 1, type: "hook", duration: 5, description: "林间人物安静等待。", camera: "固定镜头", prompt: "户外实拍人物安静观察树林。", visualIntent: "呈现户外等待场景。", voiceover: text, visualSource: "ai_generate", transition: "direct_concat", tidewe: { copySpan: { start: 0, end: text.length }, translation: copy.translation, shotGoal: "展现等待体验", productVisible: false, factRefs: [], sceneId: "woods" } };
const model: KlingVideoModelDescriptor = { selectionKey: '["kling-cli","text_to_video","outdoor-model"]', provider: "kling-cli", profileId: "profile-1", region: "global", tool: "text_to_video", remoteModelId: "outdoor-model", displayName: "Outdoor model", catalogRevision: "catalog-1", available: true,
  parameters: [{ name: "generate_audio", type: "boolean", required: false, default: true }, { name: "negative_prompt", type: "string", required: false }], inputSlots: [], capabilities: { image: false, tailFrame: false, multiImage: false, audio: true } };
const oldPhase = process.env.NEXT_PHASE;
function request(overrides: Partial<KlingSubmitRequest> = {}): KlingSubmitRequest {
  return { provider: "kling-cli", executionScope: "single-shot", profileId: "profile-1", clientRequestId: "request-1", projectId: "project-1", scriptId: "script-1", shotId: 1, selectionKey: model.selectionKey, mode: "text-to-video", prompt: "展示林间户外环境。", expectedSelectedAssetId: null, billingAcknowledgement: { policyRevision: "credits-v1", acceptedForRequestId: "request-1" }, ...overrides };
}
function reviewedRequest(overrides: Partial<KlingSubmitRequest> = {}, controls?: VideoPromptRequest["controlInputs"], generateAudio = false): KlingSubmitRequest {
  const raw = request(overrides);
  const context: VideoPromptRequest = { scriptId: raw.scriptId, shotId: raw.shotId, provider: "kling-cli", model: raw.selectionKey, settings: { ...DEFAULT_VIDEO_PROMPT_SETTINGS }, generateAudio, ...(controls && { controlInputs: controls }) };
  const reviewed = previewProjectVideoPrompt(raw.projectId, context);
  return { ...raw, prompt: reviewed.prompt, promptContext: { ...context, contextKey: reviewed.contextKey } };
}
function productContext() {
  const productShot = { ...shot, tidewe: { ...shot.tidewe!, productVisible: true } };
  getDb().update(scripts).set({ shots: [productShot] }).where(eq(scripts.id, "script-1")).run();
  getDb().update(projects).set({ productImages: ["/api/files/project-1/product.png"] }).where(eq(projects.id, "project-1")).run();
  const imageModel: KlingVideoModelDescriptor = { ...model, selectionKey: '["kling-cli","image_to_video","product-model"]', tool: "image_to_video", remoteModelId: "product-model", inputSlots: [{ name: "image", role: "image", required: true }], capabilities: { ...model.capabilities, image: true } };
  state.profile!.catalogSnapshot.push(imageModel);
  return imageModel;
}

beforeAll(async () => { state.directory = await fs.mkdtemp(path.join(os.tmpdir(), "clipforge-tidewe-kling-")); });
beforeEach(() => {
  vi.stubEnv("CLIPFORGE_RUNTIME", ""); vi.stubEnv("CLIPFORGE_KLING_DISABLED", ""); process.env.NEXT_PHASE = "phase-production-build"; stopKlingJobRunner();
  state.sqlite!.exec("DELETE FROM kling_film_shots; DELETE FROM kling_film_runs; DELETE FROM kling_job_outputs; DELETE FROM kling_jobs; DELETE FROM ai_tasks; DELETE FROM assets; DELETE FROM scripts; DELETE FROM projects; DELETE FROM kling_profiles;");
  vi.clearAllMocks(); const now = Date.now();
  state.profile = { id: "profile-1", label: "test", region: "global", cliPackage: "@klingai/cli-global", cliVersion: "0.2.0", adapterVersion: "1", nodePath: process.execPath, packagePath: "/fixture", cliEntry: "/fixture/dist/cli.js", homePath: path.join(state.directory, "home"), endpoint: "https://kling.ai/mcp", environmentState: "ready", authState: "authenticated", authRevision: 1, principalKey: '["global","user-1"]', accountSummary: { id: "user-1" }, catalogSnapshot: [structuredClone(model)], catalogRevision: "catalog-1", catalogCheckedAt: now, createdAt: now, updatedAt: now };
  getDb().insert(klingProfiles).values({ id: state.profile.id, data: state.profile }).run();
  getDb().insert(projects).values({ id: "project-1", name: "TIDEWE", creativeProfile: profile, creativeConfigRevision: 1, productFacts: facts }).run();
  getDb().insert(scripts).values({ id: "script-1", projectId: "project-1", version: 1, styleType: "tidewe_outdoor", shots: [shot], copyDocument: copy, totalDuration: 5, selected: true, creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1) }).run();
  state.refresh.mockImplementation(async () => structuredClone(state.profile));
  state.lease.mockImplementation(async (account: KlingProfile, fn: (lease: unknown) => unknown) => fn({ profileId: account.id, owner: "test", token: 1, assertOwned() {} }));
  state.prepare.mockResolvedValue([]);
  state.cli.mockImplementation(async (_account: KlingProfile, _args: string[], options: KlingRunOptions) => {
    options.onGenerationId?.("remote-tidewe-1");
    return { exitCode: 0, signal: null, json: { ok: true, body: { generationId: "remote-tidewe-1" } }, generationId: "remote-tidewe-1", stdout: "", stderr: "", timedOut: false, aborted: false };
  });
});
afterEach(async () => { stopKlingJobRunner(); await new Promise<void>((resolve) => setImmediate(resolve)); vi.unstubAllEnvs(); });
afterAll(async () => { stopKlingJobRunner(); state.sqlite?.close(); await fs.rm(state.directory, { recursive: true, force: true }); if (oldPhase === undefined) delete process.env.NEXT_PHASE; else process.env.NEXT_PHASE = oldPhase; });

describe("TIDEWE Kling policy before paid dispatch", () => {
  const presenter: TidewePresenterSnapshot = { id: "saved-host", name: "Sam", appearance: "短发户外主播", referenceImages: ["/api/files/project-1/presenter.png"] };
  function selectedPresenterContext(multiImage = false) {
    const imageModel = productContext();
    if (multiImage) { imageModel.capabilities.multiImage = true; imageModel.inputSlots.push({ name: "image2", role: "image", required: false }); }
    const presenterProfile = createTideweOutdoorProfile({ speechMode: "voiceover", presenter });
    const presenterShot: Shot = { ...shot, characterId: presenter.id, description: `${tidewePresenterAnchor(presenter)}在林间展示装备。`, tidewe: { ...shot.tidewe!, presenter, personVisible: true, productVisible: true } };
    getDb().update(projects).set({ creativeProfile: presenterProfile }).run();
    getDb().update(scripts).set({ shots: [presenterShot], creativeProfileSnapshot: createCreativeProfileSnapshot(presenterProfile, 1) }).run();
    return { imageModel, shot: presenterShot };
  }
  function presenterKeyframe(presenterShot: Shot) {
    const imageUrl = "/api/files/project-1/presenter-frame.png";
    const script = getDb().select().from(scripts).where(eq(scripts.id, "script-1")).get()!;
    getDb().insert(assets).values({ id: "presenter-keyframe", projectId: "project-1", shotId: 1, type: "ai_generated", status: "done", selected: true, filePath: imageUrl, ...assetScopeForShot(script, presenterShot) }).run();
    return imageUrl;
  }
  it("requires a current combined keyframe for a selected presenter on single-image Kling", async () => {
    const { imageModel, shot: presenterShot } = selectedPresenterContext();
    expect(() => reviewedRequest({ selectionKey: imageModel.selectionKey, mode: "image-to-video", imageUrl: "/api/files/project-1/product.png" }, { firstFrameUrl: "/api/files/project-1/product.png" })).toThrow(expect.objectContaining({ code: "TIDEWE_PRESENTER_KEYFRAME_REQUIRED" }));
    const imageUrl = presenterKeyframe(presenterShot);
    const job = await createKlingJob(reviewedRequest({ selectionKey: imageModel.selectionKey, mode: "image-to-video", imageUrl, expectedSelectedAssetId: "presenter-keyframe" }, { firstFrameUrl: imageUrl }));
    expect(job.data.prompt).toContain(presenter.name);
    expect(state.prepare).toHaveBeenCalledWith(expect.any(String), expect.any(Object), [{ role: "image", sourceUrl: imageUrl }]);
    expect(state.cli).not.toHaveBeenCalled();
  });
  it("binds the actual frozen portrait to a multi-image Kling request", async () => {
    const { imageModel, shot: presenterShot } = selectedPresenterContext(true);
    const imageUrl = presenterKeyframe(presenterShot);
    await createKlingJob(reviewedRequest({ selectionKey: imageModel.selectionKey, mode: "image-to-video", imageUrl, expectedSelectedAssetId: "presenter-keyframe" }, { firstFrameUrl: imageUrl }));
    expect(state.prepare).toHaveBeenCalledWith(expect.any(String), expect.any(Object), [{ role: "image", sourceUrl: imageUrl }, { role: "image", sourceUrl: presenter.referenceImages[0] }]);
    expect(state.cli).not.toHaveBeenCalled();
  });
  function useNativeSpeech() {
    const native = createTideweOutdoorProfile();
    getDb().update(projects).set({ creativeProfile: native }).where(eq(projects.id, "project-1")).run();
    getDb().update(scripts).set({ creativeProfileSnapshot: createCreativeProfileSnapshot(native, 1) }).where(eq(scripts.id, "script-1")).run();
    state.profile!.catalogSnapshot[0].parameters.push({ name: "duration", type: "number", required: false, allowedValues: [5, 10], default: 5 });
  }
  it("raises a rounded-down duration to a declared tier covering the native spoken plan", async () => {
    useNativeSpeech();
    getDb().update(scripts).set({ shots: [{ ...shot, duration: 5.4 }] }).where(eq(scripts.id, "script-1")).run();
    const job = await createKlingJob(reviewedRequest({ options: { duration: 5 } }, undefined, true));
    expect(job.data.options.duration).toBe(10);
    expect(job.data.args[job.data.args.indexOf("--duration") + 1]).toBe("10");
    expect(state.cli).not.toHaveBeenCalled();
  });
  it("rejects a spoken plan beyond the longest declared tier before preparing a paid job", async () => {
    useNativeSpeech();
    getDb().update(scripts).set({ shots: [{ ...shot, duration: 10.1 }] }).where(eq(scripts.id, "script-1")).run();
    await expect(createKlingJob(reviewedRequest({}, undefined, true))).rejects.toMatchObject({ code: "TIDEWE_NATIVE_DURATION_UNSUPPORTED" });
    expect(state.prepare).not.toHaveBeenCalled(); expect(state.cli).not.toHaveBeenCalled();
  });
  it("forces declared native audio on and preserves exactly reviewed English speech", async () => {
    useNativeSpeech();
    const raw = reviewedRequest({ options: { generate_audio: false, negative_prompt: "no speaking" } }, undefined, true);
    const job = await createKlingJob(raw);
    expect(job.data.options.generate_audio).toBe(true);
    expect(job.data.args[job.data.args.indexOf("--generate_audio") + 1]).toBe("true");
    expect(job.data.prompt).toContain(text);
    expect(job.data.prompt).not.toContain("仅生成静音视觉素材");
    expect(String(job.data.options.negative_prompt)).not.toContain("说话口型");
    expect(state.cli).not.toHaveBeenCalled();
  });
  it("rejects native speech for silent models and models without a reliable audio switch", async () => {
    useNativeSpeech();
    state.profile!.catalogSnapshot[0].capabilities.audio = false;
    await expect(createKlingJob(reviewedRequest({}, undefined, true))).rejects.toMatchObject({ code: "TIDEWE_NATIVE_AUDIO_UNSUPPORTED", status: 422 });
    state.profile!.catalogSnapshot[0].capabilities.audio = true;
    state.profile!.catalogSnapshot[0].parameters = [];
    await expect(createKlingJob(reviewedRequest({}, undefined, true))).rejects.toMatchObject({ code: "TIDEWE_NATIVE_AUDIO_UNSUPPORTED", status: 422 });
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.cli).not.toHaveBeenCalled();
  });
  it("does not dispatch native speech after recovered parameters mute its audio", async () => {
    useNativeSpeech();
    const job = await createKlingJob(reviewedRequest({}, undefined, true));
    getDb().update(klingJobs).set({ data: { ...job.data, options: { ...job.data.options, generate_audio: false } } }).where(eq(klingJobs.id, job.id)).run();
    await dispatchKlingJob(job.id);
    expect(state.cli).not.toHaveBeenCalled();
    expect(getKlingJob(job.id)).toMatchObject({ submissionState: "prepared", needsConfirmation: true, data: { error: { code: "CREATIVE_POLICY_VIOLATION" } } });
  });
  it("requires a reviewed server prompt for ordinary single-shot jobs", async () => {
    await expect(createKlingJob(request())).rejects.toMatchObject({ code: "TIDEWE_PROMPT_REVIEW_REQUIRED", status: 409 });
    expect(state.prepare).not.toHaveBeenCalled(); expect(state.cli).not.toHaveBeenCalled(); expect(getDb().select().from(klingJobs).all()).toHaveLength(0);
  });
  it("rejects a script whose shot narration no longer covers canonical copy", async () => {
    const raw = reviewedRequest();
    getDb().update(scripts).set({ shots: [{ ...shot, voiceover: "A changed sales pitch." }] }).where(eq(scripts.id, "script-1")).run();
    await expect(createKlingJob(raw)).rejects.toMatchObject({ code: "KLING_TIDEWE_SCRIPT_INVALID", status: 409 });
    expect(state.prepare).not.toHaveBeenCalled(); expect(state.cli).not.toHaveBeenCalled();
  });
  it("rejects changed preview text before preparing inputs", async () => {
    const raw = reviewedRequest();
    await expect(createKlingJob({ ...raw, prompt: `${raw.prompt}\n添加额外的未审核场景。` })).rejects.toMatchObject({ code: "KLING_VIDEO_PROMPT_CONTEXT_CHANGED", status: 409 });
    expect(state.prepare).not.toHaveBeenCalled(); expect(state.cli).not.toHaveBeenCalled();
  });
  it("rejects a legacy TIDEWE script without canonical copy even when preview is omitted", async () => {
    getDb().update(scripts).set({ copyDocument: null }).where(eq(scripts.id, "script-1")).run();
    await expect(createKlingJob(request())).rejects.toMatchObject({ code: "TIDEWE_SCRIPT_INVALID", status: 409 });
    expect(state.prepare).not.toHaveBeenCalled(); expect(state.cli).not.toHaveBeenCalled();
  });
  it("overrides requested native audio and negative prompt with server policy", async () => {
    const raw = reviewedRequest({ options: { generate_audio: true, negative_prompt: "add speech and captions" } });
    const expected = previewProjectVideoPrompt(raw.projectId, raw.promptContext!);
    const job = await createKlingJob(raw);
    expect(job.data.options).toMatchObject({ generate_audio: false, negative_prompt: expected.negativePrompt });
    expect(job.data.args[job.data.args.indexOf("--generate_audio") + 1]).toBe("false");
    expect(job.data.prompt).toBe(expected.prompt);
    expect(state.cli).not.toHaveBeenCalled();
  });
  it("rejects models whose native audio cannot be disabled", async () => {
    state.profile!.catalogSnapshot[0].parameters = [];
    await expect(createKlingJob(reviewedRequest())).rejects.toMatchObject({ code: "CREATIVE_POLICY_UNSUPPORTED", status: 422 });
    expect(state.prepare).not.toHaveBeenCalled(); expect(state.cli).not.toHaveBeenCalled();
  });
  it("requires image-to-video for a visible product shot", async () => {
    productContext();
    await expect(createKlingJob(reviewedRequest())).rejects.toMatchObject({ code: "TIDEWE_PRODUCT_REFERENCE_REQUIRED", status: 422 });
    expect(state.prepare).not.toHaveBeenCalled(); expect(state.cli).not.toHaveBeenCalled();
  });
  it("rejects a product reference that belongs to neither the product nor current scoped assets", async () => {
    const imageModel = productContext();
    await expect(createKlingJob(reviewedRequest({ selectionKey: imageModel.selectionKey, mode: "image-to-video", imageUrl: "https://unrelated.invalid/other-product.png" }))).rejects.toMatchObject({ code: "TIDEWE_PRODUCT_REFERENCE_INVALID", status: 422 });
    expect(state.prepare).not.toHaveBeenCalled(); expect(state.cli).not.toHaveBeenCalled();
  });
  it("accepts a current scoped keyframe as a visible product reference", async () => {
    const imageModel = productContext();
    const script = getDb().select().from(scripts).where(eq(scripts.id, "script-1")).get()!;
    const imageUrl = "/api/files/project-1/keyframe.png";
    getDb().insert(assets).values({ id: "current-keyframe", projectId: "project-1", shotId: 1, type: "ai_generated", status: "done", selected: true, filePath: imageUrl, ...assetScopeForShot(script, script.shots![0]) }).run();
    const job = await createKlingJob(reviewedRequest({ selectionKey: imageModel.selectionKey, mode: "image-to-video", imageUrl, expectedSelectedAssetId: "current-keyframe" }, { firstFrameUrl: imageUrl }));
    expect(job.submissionState).toBe("prepared");
    expect(state.prepare).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ tool: "image_to_video" }), [{ role: "image", sourceUrl: imageUrl }]);
    expect(state.cli).not.toHaveBeenCalled();
  });
  it("rejects a same-number keyframe from an older shot revision", async () => {
    const imageModel = productContext();
    const script = getDb().select().from(scripts).where(eq(scripts.id, "script-1")).get()!;
    const imageUrl = "/api/files/project-1/stale-keyframe.png";
    getDb().insert(assets).values({ id: "stale-keyframe", projectId: "project-1", shotId: 1, type: "ai_generated", status: "done", selected: true, filePath: imageUrl, ...assetScopeForShot(script, { ...script.shots![0], camera: "先前的中文运镜" }) }).run();
    await expect(createKlingJob(reviewedRequest({ selectionKey: imageModel.selectionKey, mode: "image-to-video", imageUrl }))).rejects.toMatchObject({ code: "TIDEWE_PRODUCT_REFERENCE_INVALID", status: 422 });
    expect(state.prepare).not.toHaveBeenCalled(); expect(state.cli).not.toHaveBeenCalled();
  });
  it("rechecks canonical copy after creation before the paid CLI call", async () => {
    const job = await createKlingJob(reviewedRequest());
    getDb().update(scripts).set({ copyDocument: null }).where(eq(scripts.id, "script-1")).run();
    await dispatchKlingJob(job.id);
    expect(state.cli).not.toHaveBeenCalled();
    expect(getKlingJob(job.id)).toMatchObject({ submissionState: "prepared", needsConfirmation: true });
  });
  it("does not dispatch a recovered job whose stored options enable native audio", async () => {
    const job = await createKlingJob(reviewedRequest());
    getDb().update(klingJobs).set({ data: { ...job.data, options: { ...job.data.options, generate_audio: true } } }).where(eq(klingJobs.id, job.id)).run();
    await dispatchKlingJob(job.id);
    expect(state.cli).not.toHaveBeenCalled();
    expect(getKlingJob(job.id)).toMatchObject({ submissionState: "prepared", needsConfirmation: true, data: { error: { code: "CREATIVE_POLICY_VIOLATION" } } });
  });
  it.each(["voiceover", "on_camera"] as const)("allows a controlled %s film child with canonical prompt and a fresh parent dispatch grant", async (speechMode) => {
    if (speechMode === "on_camera") useNativeSpeech();
    const context = { filmRunId: "film-run-1", filmShotId: "film-shot-1", authorizationEpoch: 1, expectedInputHashes: [] };
    const now = Date.now();
    getDb().insert(klingFilmRuns).values({ id: context.filmRunId, projectId: "project-1", scriptId: "script-1", profileId: "profile-1", principalKey: state.profile!.principalKey!, status: "running", createdAt: now, updatedAt: now,
      data: { scriptRevision: "fixture", scriptSnapshot: { shots: [shot] }, model, output: { resolution: "720p", aspectRatio: "9:16", audioStrategy: speechMode === "on_camera" ? "native" : "edge-tts", voice: "en-US-GuyNeural", subtitles: false }, planHash: "fixture-plan", expiresAt: now + 120000, reuseExistingVideos: true, warnings: [], stage: "running", authorizationEpoch: 1 } }).run();
    const job = await createKlingFilmShotJob(request({ prompt: compileTideweVisualPrompt(shot, "video", speechMode).prompt }), context);
    await expect(dispatchKlingJob(job.id)).rejects.toMatchObject({ code: "KLING_FILM_MANAGED_JOB" });
    const guard = vi.fn();
    await dispatchKlingFilmShotJob(job.id, { ...context, assertDispatchAllowed: guard });
    expect(guard).toHaveBeenCalledTimes(2); expect(state.cli).toHaveBeenCalledOnce();
    expect(getKlingJob(job.id)).toMatchObject({ submissionState: "acknowledged", data: { options: { generate_audio: speechMode === "on_camera" } } });
  });
});
