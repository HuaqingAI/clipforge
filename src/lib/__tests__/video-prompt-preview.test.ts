// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as schema from "@/lib/db/schema";
import { createCreativeProfileSnapshot, createPremiumProductCgProfile, createShortVideoSalesProfile, createTideweOutdoorProfile } from "@/lib/creative-profiles";
import { compilePremiumCgVideoPrompt } from "@/lib/premium-cg-prompt";
import { DEFAULT_VIDEO_PROMPT_SETTINGS } from "@/lib/shot-video-prompt";
import type { VideoPromptContext, VideoPromptPreview, VideoPromptRequest } from "@/lib/video-prompt-request";
import { englishWordCount, productFactsHash } from "@/lib/tidewe/validation";
import { TIDEWE_VISUAL_NEGATIVE_PROMPT } from "@/lib/tidewe/visual-policy";
import { tidewePresenterAnchor } from "@/lib/tidewe/presenter";
import { shotKey, scriptRevision } from "@/lib/asset-context";
import { sanitizeVideoControlSummary } from "@/lib/video-control-plan";
import type { ProductFacts, TideweCopyDocument, TidewePresenterSnapshot } from "@/lib/tidewe/types";

const state = vi.hoisted(() => ({ db: null as unknown, generate: vi.fn(), provider: vi.fn(), recordTask: vi.fn(), updateTask: vi.fn(), remoteImage: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/providers", () => ({ createProvider: state.provider }));
vi.mock("@/lib/remote-image", () => ({ toRemoteUsableImage: state.remoteImage, resolveUploadFilePath: () => undefined }));
vi.mock("@/lib/ai-tasks", () => ({ recordAiTask: state.recordTask, updateAiTask: state.updateTask }));
vi.mock("@/lib/kling/jobs", () => ({ createKlingJob: vi.fn() }));
vi.mock("@/lib/kling/repository", () => ({ klingJobView: vi.fn() }));

import { POST as preview } from "@/app/api/project/[id]/video-prompt/route";
import { POST as generate } from "@/app/api/ai/video/route";

const projectId = "prompt-preview-project", scriptId = "prompt-preview-script";
const shot: schema.Shot = {
  shotId: 1, type: "demo", duration: 5, description: "商品放在桌面上。", visualIntent: "商品包装纹理和按键清晰可见。",
  camera: "镜头沿观察轴缓慢前移。", voiceover: "轻按一下，轻松开启。", visualSource: "product_image", transition: "direct_concat",
};
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  state.db = db;
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  const profile = createShortVideoSalesProfile();
  db.insert(schema.projects).values({ id: projectId, name: "Preview", productImages: ["/api/files/product.png"], creativeProfile: profile, creativeConfigRevision: 1 }).run();
  db.insert(schema.scripts).values({ id: scriptId, projectId, selected: true, styleType: "scene", shots: [shot], creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1) }).run();
  state.generate.mockReset().mockResolvedValue({ videoUrls: ["https://example.test/clip.mp4"] });
  state.provider.mockReset().mockReturnValue({ generateVideo: state.generate });
  state.recordTask.mockReset().mockResolvedValue("task-row");
  state.updateTask.mockReset();
  state.remoteImage.mockReset().mockImplementation(async (value: unknown) => value);
});
afterEach(() => { sqlite.close(); state.db = null; });

function input(extra: Partial<VideoPromptRequest> = {}): VideoPromptRequest {
  return { scriptId, shotId: 1, provider: "atlas-cloud", model: "bytedance/seedance-2.5/image-to-video", settings: { ...DEFAULT_VIDEO_PROMPT_SETTINGS }, generateAudio: false, locale: "zh", controlInputs: { firstFrameUrl: "/api/files/product.png", supportsAudio: true }, ...extra };
}
async function getPreview(request = input()) {
  const response = await preview(new NextRequest(`http://localhost/api/project/${projectId}/video-prompt`, { method: "POST", body: JSON.stringify(request) }), { params: Promise.resolve({ id: projectId }) });
  return { response, value: await response.json() as VideoPromptPreview };
}
function submit(value: VideoPromptPreview, request: VideoPromptRequest, extra: Record<string, unknown> = {}) {
  return generate(new NextRequest("http://localhost/api/ai/video", { method: "POST", body: JSON.stringify({
    projectId, scriptId, shotId: 1, provider: request.provider, model: request.model, apiKey: "fixture-key", prompt: value.prompt,
    promptContext: { ...request, contextKey: value.contextKey } satisfies VideoPromptContext,
    imageUrl: "/api/files/product.png", ...extra,
  }) }));
}

function useTidewe(speechMode: "on_camera" | "voiceover" = "voiceover", presenter?: TidewePresenterSnapshot) {
  const profile = createTideweOutdoorProfile({ speechMode, presenter });
  const text = "The walk into the woods is only the start. Have a look if that sounds familiar.";
  const facts: ProductFacts = { version: 1, brand: "TIDEWE", category: "other", items: [] };
  const copyDocument: TideweCopyDocument = {
    version: 1, language: "en-US", text, translation: "走进林子只是开始。适合的话可以看看。", angle: "scene", hookType: "scene",
    claimedFactIds: [], factsSnapshot: facts, factsHash: productFactsHash(facts), corpusVersion: profile.corpusVersion,
    compilerVersion: profile.promptCompilerVersion, exampleIds: [], wordCount: englishWordCount(text), estimatedDuration: 5,
  };
  const tideweShot: schema.Shot = {
    ...shot, voiceover: text, description: `${presenter ? tidewePresenterAnchor(presenter) : "猎人"}在清晨林缘停步，低头检查装备。`, visualIntent: "建立户外行走场景。", prompt: "清晨户外小径。",
    ...(presenter && { characterId: presenter.id }), tidewe: { ...(presenter && { presenter, personVisible: true }), copySpan: { start: 0, end: text.length }, translation: copyDocument.translation, shotGoal: "展示入林前检查装备", productVisible: true, factRefs: [], sceneId: "woods" },
  };
  db.update(schema.projects).set({ creativeProfile: profile, creativeIntent: { subject: "卧室主播卖货" }, visualBible: { characterAnchors: [], productAnchors: [], wardrobeAnchors: [], environmentAnchors: ["室内"], lightingAnchors: [], forbiddenChanges: ["户外"] } }).run();
  db.update(schema.scripts).set({ styleType: "tidewe_outdoor", shots: [tideweShot], copyDocument, creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1) }).run();
  return { shot: tideweShot, copyDocument };
}

describe("authoritative TIDEWE video preview and dispatch", () => {
  const presenter: TidewePresenterSnapshot = { id: "selected-host", name: "Selected host", appearance: "棕色短发", referenceImages: ["/api/files/selected-host.png"] };
  it("binds the frozen presenter in preview and sends the actual portrait to reference-capable video generation", async () => {
    useTidewe("voiceover", presenter);
    const request = input();
    const { response, value } = await getPreview(request);
    expect(response.status).toBe(200);
    expect(value.controlPlan.referenceInputs).toContainEqual(expect.objectContaining({ role: "character", url: presenter.referenceImages[0] }));
    expect(value.prompt).toContain(presenter.name);
    const result = await submit(value, request);
    expect(result.status).toBe(200);
    expect(state.generate).toHaveBeenCalledWith(expect.objectContaining({ mode: "video-to-video", referenceImageUrls: [presenter.referenceImages[0], "/api/files/product.png"] }));
    expect(state.generate.mock.calls[0][0].firstFrameUrl).toBeUndefined();
  });
  it("rejects changing the frozen presenter or silently dropping an unreadable portrait", async () => {
    useTidewe("voiceover", presenter);
    const wrong = await getPreview(input({ controlInputs: { characterReferenceUrl: "https://example.test/other-person.png" } }));
    expect(wrong.response.status).toBe(400);
    expect(wrong.value).toMatchObject({ code: "TIDEWE_PRESENTER_REFERENCE_INVALID" });
    const request = input();
    const { value } = await getPreview(request);
    state.remoteImage.mockImplementation(async (url: unknown) => url === presenter.referenceImages[0] ? undefined : url);
    const result = await submit(value, request);
    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({ code: "TIDEWE_REFERENCE_UNAVAILABLE" });
    expect(state.generate).not.toHaveBeenCalled();
  });
  it.each([false, true])("rejects an unreadable extra product reference with appearance-only presenter=%s", async (hasPresenter) => {
    useTidewe("voiceover", hasPresenter ? { ...presenter, referenceImages: [] } : undefined);
    const missingProduct = "/api/files/missing-product-side.png";
    db.update(schema.projects).set({ productImages: ["/api/files/product.png", missingProduct] }).run();
    const request = input();
    const { response, value } = await getPreview(request);
    expect(response.status).toBe(200);
    state.remoteImage.mockImplementation(async (url: unknown) => url === missingProduct ? undefined : url);
    const result = await submit(value, request, { referenceImageUrls: ["/api/files/product.png", missingProduct] });
    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({ code: "TIDEWE_REFERENCE_UNAVAILABLE" });
    expect(state.generate).not.toHaveBeenCalled();
  });
  it("binds native English speech in a reviewed batch and enables the exact model's audio before dispatch", async () => {
    const { shot } = useTidewe("on_camera");
    db.update(schema.scripts).set({ shots: [{ ...shot, duration: 5.4 }] }).run();
    const request = input({ batch: true, generateAudio: true, controlInputs: { firstFrameUrl: "/api/files/product.png", supportsAudio: false } });
    const { response, value } = await getPreview(request);
    expect(response.status).toBe(200);
    expect(value.prompt).toContain(shot.voiceover);
    expect(value.prompt.split(shot.voiceover)).toHaveLength(2);
    expect(value.prompt).not.toContain("仅生成静音视觉素材");
    expect(value.controlPlan).toMatchObject({ audioMode: "native", voiceoverBound: true });
    const listModels = vi.fn().mockResolvedValue([{ id: request.model, mediaType: "video", supportsAudio: true }]);
    state.provider.mockReturnValue({ generateVideo: state.generate, listModels });
    const result = await submit(value, request, { options: { duration: 5, minimumDuration: 1, audioEnabled: false, voiceover: "Unapproved replacement", extra: { generate_audio: false } } });
    expect(result.status).toBe(200);
    expect(listModels).toHaveBeenCalledWith("video");
    expect(state.generate).toHaveBeenCalledWith(expect.objectContaining({ prompt: value.prompt, audioEnabled: true, duration: 6, minimumDuration: 5.4 }));
    const generated = state.generate.mock.calls[0][0];
    expect(generated.voiceover).toBeUndefined();
    expect(generated.extra).toBeUndefined();
  });
  it("rejects native mute requests and a forged audio capability before any paid generation", async () => {
    useTidewe("on_camera");
    const muted = await getPreview(input());
    expect(muted.response.status).toBe(400);
    expect(muted.value).toMatchObject({ code: "TIDEWE_NATIVE_AUDIO_REQUIRED" });
    const request = input({ generateAudio: true });
    const { value } = await getPreview(request);
    state.provider.mockReturnValue({ generateVideo: state.generate, listModels: vi.fn().mockResolvedValue([{ id: request.model, mediaType: "video", supportsAudio: false }]) });
    const response = await submit(value, request, { options: { audioEnabled: true } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "TIDEWE_NATIVE_AUDIO_UNSUPPORTED" });
    state.provider.mockReturnValue({ generateVideo: state.generate, listModels: vi.fn().mockResolvedValue([]) });
    const unknown = await submit(value, request);
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ code: "TIDEWE_NATIVE_AUDIO_UNSUPPORTED" });
    expect(state.generate).not.toHaveBeenCalled();
  });
  it("keeps saved outdoor descriptions and reference labels while ignoring legacy sales controls", async () => {
    const { shot } = useTidewe();
    const request = input({ retake: "background_dead", negativePrompt: "avoid outdoor scenes", controlInputs: { firstFrameUrl: "/api/files/product.png", productReferenceUrl: "/api/files/product.png", supportsAudio: true, audioReferenceUrl: "https://example.test/voice.mp3" } });
    const { response, value } = await getPreview(request);
    expect(response.status).toBe(200);
    expect(value.prompt).toContain(`本镜画面：${shot.description}`);
    expect(value.prompt).toContain(shot.visualIntent);
    expect(value.prompt).toContain("参考映射：");
    expect(value.prompt).toContain("静音视觉素材");
    expect(value.prompt).not.toContain(shot.voiceover);
    expect(value.prompt).not.toContain("卧室主播卖货");
    expect(value.prompt).not.toContain("窗帘轻晃");
    expect(value.controlPlan.audioMode).toBe("none");
    expect(value.controlPlan.referenceInputs.every((item) => item.mediaType === "image")).toBe(true);
    expect(value.negativePrompt).toBe(TIDEWE_VISUAL_NEGATIVE_PROMPT);
    const result = await submit(value, request, { options: { audioEnabled: true, voiceover: "Different narration", audioPrompt: "Speak now", extra: { generate_audio: true, arbitrary_audio_flag: true } }, referenceAudioUrls: ["https://example.test/voice.mp3"], referenceVideoUrls: ["https://example.test/motion.mp4"] });
    expect(result.status).toBe(200);
    const generated = state.generate.mock.calls[0][0];
    expect(generated).toMatchObject({ prompt: value.prompt, audioEnabled: false, negativePrompt: TIDEWE_VISUAL_NEGATIVE_PROMPT });
    for (const key of ["voiceover", "audioPrompt", "extra", "referenceAudioUrls", "referenceVideoUrls"]) expect(generated[key]).toBeUndefined();
  });
  it("rejects native narration and unreviewed dispatch before creating a provider", async () => {
    useTidewe();
    const native = await getPreview(input({ generateAudio: true }));
    expect(native.response.status).toBe(400);
    expect(native.value).toMatchObject({ code: "TIDEWE_VISUAL_AUDIO_FORBIDDEN" });
    const request = input();
    const { value } = await getPreview(request);
    const response = await submit(value, request, { promptContext: undefined });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "TIDEWE_PROJECT_CONTEXT_REQUIRED" });
    expect(state.provider).not.toHaveBeenCalled();
  });
  it("rejects canonical narration drift and an unrelated product reference before dispatch", async () => {
    const { shot } = useTidewe();
    const request = input();
    const { value } = await getPreview(request);
    const unrelated = await submit(value, request, { imageUrl: "https://example.test/unrelated-product.png" });
    expect(unrelated.status).toBe(400);
    expect(await unrelated.json()).toMatchObject({ code: "TIDEWE_PRODUCT_REFERENCE_INVALID" });
    const unanchored = await submit(value, request, { imageUrl: undefined, mode: "text-to-video" });
    expect(unanchored.status).toBe(400);
    expect(await unanchored.json()).toMatchObject({ code: "TIDEWE_PRODUCT_REFERENCE_REQUIRED" });
    db.update(schema.scripts).set({ shots: [{ ...shot, voiceover: "An edited sentence outside the copy document." }] }).run();
    const stale = await submit(value, request);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "TIDEWE_SCRIPT_INVALID" });
    expect(state.provider).not.toHaveBeenCalled();
  });
  it("persists server-frozen task provenance and returns it when paid polling is interrupted", async () => {
    const { shot } = useTidewe();
    const savedScript = db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()!;
    const sourceContext = { version: 1, sourceScriptId: scriptId, sourceShotKey: shotKey(scriptId, shot), sourceRevision: scriptRevision(savedScript) };
    state.provider.mockReturnValue({ submitVideoTask: vi.fn().mockResolvedValue({ taskId: "paid-task", modelId: "actual-model" }), waitForTask: vi.fn().mockRejectedValue(new Error("poll connection lost")) });
    const request = input();
    const { value } = await getPreview(request);
    const response = await submit(value, request, { controlPlan: { ...value.controlPlan, sourceContext: { version: 1, sourceScriptId: "forged-script", sourceShotKey: "a".repeat(64), sourceRevision: "b".repeat(64) } } });
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ taskId: "paid-task", recoverable: true, sourceContext });
    expect(state.recordTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: "paid-task", controlPlan: expect.objectContaining({ sourceContext }) }));
    const restored = sanitizeVideoControlSummary(JSON.parse(JSON.stringify(state.recordTask.mock.calls[0][0].controlPlan)));
    expect(restored?.sourceContext).toEqual(sourceContext);
    expect(state.updateTask).toHaveBeenCalledWith("task-row", expect.objectContaining({ status: "unknown" }));
  });
});

describe("authoritative dynamic prompt preview", () => {
  it("preserves ordinary sales reference filtering when an optional reference is unavailable", async () => {
    const request = input();
    const { response, value } = await getPreview(request);
    expect(response.status).toBe(200);
    const missingReference = "/api/files/missing-optional.png";
    state.remoteImage.mockImplementation(async (url: unknown) => url === missingReference ? undefined : url);
    const result = await submit(value, request, { referenceImageUrls: ["/api/files/product.png", missingReference] });
    expect(result.status).toBe(200);
    expect(state.generate).toHaveBeenCalledWith(expect.objectContaining({ referenceImageUrls: ["/api/files/product.png"] }));
  });
  it("returns the exact existing CG backend template for first generation, retake and batch", async () => {
    const profile = createPremiumProductCgProfile({ narrationMode: "none" });
    const cgShot = { ...shot, voiceover: "", type: "product_reveal" as const };
    db.update(schema.projects).set({ creativeProfile: profile }).run();
    db.update(schema.scripts).set({ styleType: "premium_product_cg", shots: [cgShot], creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1) }).run();
    const ordinary = await getPreview();
    const retake = await getPreview(input({ retake: "blurry", batch: true, generateAudio: true }));
    const expected = compilePremiumCgVideoPrompt(cgShot, profile);
    expect(ordinary.response.status).toBe(200);
    expect(ordinary.value).toMatchObject(expected);
    expect(retake.value).toMatchObject(expected);
    expect(ordinary.value.prompt).toContain(cgShot.visualIntent);
    expect(ordinary.value.prompt).not.toContain("声音要求");
    expect(state.provider).not.toHaveBeenCalled();
  });

  it("compiles sales narration and references on the server and submits exactly the reviewed text", async () => {
    const request = input({ generateAudio: true, controlInputs: { firstFrameUrl: "/api/files/product.png", characterReferenceUrl: "/api/files/person.png", supportsAudio: true } });
    const { response, value } = await getPreview(request);
    expect(response.status).toBe(200);
    expect(value.prompt).toContain(shot.visualIntent);
    expect(value.prompt).toContain(shot.voiceover);
    expect(value.prompt).toContain("第1张图片");
    expect(value.controlPlan.audioMode).toBe("native");
    const result = await submit(value, request, { options: { audioEnabled: true, voiceover: shot.voiceover, audioPrompt: value.controlPlan.audioPrompt, negativePrompt: "client negative" } });
    expect(result.status).toBe(200);
    expect(state.generate.mock.calls[0][0]).toMatchObject({ prompt: value.prompt, negativePrompt: value.negativePrompt, audioEnabled: true });
    expect(state.generate.mock.calls[0][0].voiceover).toBeUndefined();
    expect(state.generate.mock.calls[0][0].audioPrompt).toBeUndefined();
  });

  it("keeps server dynamic template, reference labels and native audio Chinese for an English UI", async () => {
    const request = input({ locale: "en", generateAudio: true, controlInputs: { firstFrameUrl: "/api/files/product.png", characterReferenceUrl: "/api/files/person.png", supportsAudio: true } });
    const { response, value } = await getPreview(request);
    expect(response.status).toBe(200);
    expect(value.prompt).toContain("运镜：");
    expect(value.prompt).toContain("参考映射：");
    expect(value.prompt).toContain("音频方向：");
    expect(value.prompt).not.toMatch(/Reference map|Audio direction|Camera:|Project direction/);
    const result = await submit(value, request, { options: { audioEnabled: true, voiceover: shot.voiceover, audioPrompt: value.controlPlan.audioPrompt } });
    expect(result.status).toBe(200);
    expect(state.generate.mock.calls[0][0].prompt).toBe(value.prompt);
  });

  it("includes approved native CG narration in the reviewed prompt and preserves it through submission", async () => {
    const profile = createPremiumProductCgProfile({ narrationMode: "restrained" });
    const approvedNarration = "柔和光线，呈现细腻的表面质感。";
    const cgShot: schema.Shot = { ...shot, type: "product_reveal", voiceover: "", narration: approvedNarration };
    db.update(schema.projects).set({ creativeProfile: profile }).run();
    db.update(schema.scripts).set({ styleType: "premium_product_cg", shots: [cgShot], creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1) }).run();
    const request = input({ generateAudio: true });
    const { response, value } = await getPreview(request);
    expect(response.status).toBe(200);
    expect(value.prompt).toContain(compilePremiumCgVideoPrompt(cgShot, profile).prompt);
    expect(value.prompt).toContain(`「${approvedNarration}」`);
    expect(value.controlPlan).toMatchObject({ audioMode: "native", voiceoverBound: true });
    const result = await submit(value, request, { options: { audioEnabled: true, voiceover: approvedNarration, audioPrompt: value.controlPlan.audioPrompt } });
    expect(result.status).toBe(200);
    const providerOptions = state.generate.mock.calls[0][0];
    expect(providerOptions).toMatchObject({ prompt: value.prompt, audioEnabled: true });
    expect(providerOptions.prompt.split(approvedNarration)).toHaveLength(2);
    expect(providerOptions.voiceover).toBeUndefined();
    expect(providerOptions.audioPrompt).toBeUndefined();
    const silent = await getPreview(input({ generateAudio: false }));
    const kling = await getPreview(input({ provider: "kling-cli", model: '["kling-cli","image_to_video","fixture"]', generateAudio: true }));
    expect(silent.value.prompt).toBe(compilePremiumCgVideoPrompt(cgShot, profile).prompt);
    expect(kling.value.prompt).toBe(silent.value.prompt);
  });

  it("preserves saved sales exclusions before backend negative policy in preview and submission", async () => {
    db.update(schema.projects).set({ creativeIntent: { subject: "Approved product", negative: ["warped logo", "extra buttons"] } }).run();
    const request = input({ negativePrompt: "visible seams, oversaturated colors" });
    const { response, value } = await getPreview(request);
    expect(response.status).toBe(200);
    expect(value.negativePrompt).toBe("visible seams, oversaturated colors, warped logo，extra buttons");
    const result = await submit(value, request, { options: { negativePrompt: "unreviewed client replacement" } });
    expect(result.status).toBe(200);
    expect(state.generate.mock.calls[0][0].negativePrompt).toBe(value.negativePrompt);
    const withoutSaved = await getPreview(input());
    expect(withoutSaved.value.contextKey).not.toBe(value.contextKey);
  });

  it("keeps CG negative policy authoritative when saved sales exclusions are supplied", async () => {
    const profile = createPremiumProductCgProfile({ narrationMode: "none" });
    const cgShot = { ...shot, type: "product_reveal" as const, voiceover: "" };
    db.update(schema.projects).set({ creativeProfile: profile }).run();
    db.update(schema.scripts).set({ styleType: "premium_product_cg", shots: [cgShot], creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1) }).run();
    const { response, value } = await getPreview(input({ negativePrompt: "custom exclusions from sales settings" }));
    expect(response.status).toBe(200);
    expect(value.negativePrompt).toBe(compilePremiumCgVideoPrompt(cgShot, profile).negativePrompt);
  });

  it("rejects an oversized saved negative prompt before preview compilation", async () => {
    const { response } = await getPreview(input({ negativePrompt: "a".repeat(12001) }));
    expect(response.status).toBe(400);
    expect(state.provider).not.toHaveBeenCalled();
  });

  it.each(["configuration", "sibling-shot"])("keeps the reviewed shot usable after a %s revision edit", async (change) => {
    const request = input();
    const { value } = await getPreview(request);
    if (change === "configuration") db.update(schema.projects).set({ creativeConfigRevision: 9 }).run();
    else db.update(schema.scripts).set({ version: 9, shots: [shot, { ...shot, shotId: 2, camera: "另一个分镜的运镜" }] }).run();
    const refreshed = await getPreview(request);
    expect(refreshed.response.status).toBe(200);
    expect(refreshed.value.contextKey).toBe(value.contextKey);
    const result = await submit(value, request);
    expect(result.status).toBe(200);
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.generate.mock.calls[0][0].prompt).toBe(value.prompt);
  });

  it("rejects a changed persisted shot before any provider or paid task is created", async () => {
    const request = input();
    const { value } = await getPreview(request);
    db.update(schema.scripts).set({ shots: [{ ...shot, camera: "镜头缓慢向后拉远。" }] }).run();
    const response = await submit(value, request);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "VIDEO_PROMPT_CONTEXT_CHANGED" });
    expect(state.provider).not.toHaveBeenCalled();
  });

  it("rejects changed project direction even when the saved shot did not change", async () => {
    const request = input();
    const { value } = await getPreview(request);
    db.update(schema.projects).set({ productCategory: "beauty" }).where(eq(schema.projects.id, projectId)).run();
    const response = await submit(value, request);
    expect(response.status).toBe(409);
    expect(state.provider).not.toHaveBeenCalled();
  });

  it("rejects a replaced keyframe while letting unrelated batch shots complete", async () => {
    db.insert(schema.assets).values({ id: "frame-1", projectId, shotId: 1, type: "product_image", status: "done", filePath: "/api/files/product.png" }).run();
    const request = input({ batch: true });
    const { value } = await getPreview(request);
    db.insert(schema.assets).values({ id: "frame-2", projectId, shotId: 2, type: "ai_generated", status: "done", filePath: "/api/files/other.mp4" }).run();
    const unaffected = await getPreview(request);
    expect(unaffected.value.contextKey).toBe(value.contextKey);
    db.update(schema.assets).set({ filePath: "/api/files/replaced.png" }).where(eq(schema.assets.id, "frame-1")).run();
    const response = await submit(value, request);
    expect(response.status).toBe(409);
    expect(state.provider).not.toHaveBeenCalled();
  });

  it("rejects client-rewritten text and model changes instead of silently replacing a review", async () => {
    const request = input();
    const { value } = await getPreview(request);
    const rewritten = await submit(value, request, { prompt: `${value.prompt}\n另加一段未确认的内容。` });
    const differentModel = await submit(value, request, { model: "another-model" });
    expect(rewritten.status).toBe(409);
    expect(differentModel.status).toBe(409);
    expect(state.provider).not.toHaveBeenCalled();
  });

  it("rejects stale script selection during preview without invoking a model", async () => {
    const { response } = await getPreview(input({ scriptId: "old-script" }));
    expect(response.status).toBe(409);
    expect(state.provider).not.toHaveBeenCalled();
  });
});
