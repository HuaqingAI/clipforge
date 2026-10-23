// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as schema from "@/lib/db/schema";
import { createCreativeProfileSnapshot, createPremiumProductCgProfile, createShortVideoSalesProfile } from "@/lib/creative-profiles";
import { compilePremiumCgVideoPrompt } from "@/lib/premium-cg-prompt";
import { DEFAULT_VIDEO_PROMPT_SETTINGS } from "@/lib/shot-video-prompt";
import type { VideoPromptContext, VideoPromptPreview, VideoPromptRequest } from "@/lib/video-prompt-request";

const state = vi.hoisted(() => ({ db: null as unknown, generate: vi.fn(), provider: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/providers", () => ({ createProvider: state.provider }));
vi.mock("@/lib/remote-image", () => ({ toRemoteUsableImage: async (value: unknown) => value, resolveUploadFilePath: () => undefined }));
vi.mock("@/lib/ai-tasks", () => ({ recordAiTask: vi.fn(), updateAiTask: vi.fn() }));
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

describe("authoritative dynamic prompt preview", () => {
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
