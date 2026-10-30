// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { assetScopeForShot } from "@/lib/asset-context";
import { createCreativeProfileSnapshot, createPremiumProductCgProfile, createShortVideoSalesProfile, createTideweOutdoorProfile } from "@/lib/creative-profiles";
import { englishWordCount, productFactsHash } from "@/lib/tidewe/validation";
import { tidewePresenterAnchor } from "@/lib/tidewe/presenter";
import { TIDEWE_IMAGE_FOCUS_TARGET, TIDEWE_PHOTOGRAPHIC_POLICY } from "@/lib/tidewe/visual-policy";
import type { ProductFacts, TideweCopyDocument } from "@/lib/tidewe/types";
import { ProviderError } from "@/lib/providers/base";
import { OpenAIProvider } from "@/lib/providers/openai";
import * as mediaProbe from "@/lib/media-probe";
import { executeGenerationItem } from "@/lib/generation-executor";
import { generationCheckpoint, generationContextCheckpoint, generationContextDefersPolling, GenerationTaskPending } from "@/lib/generation-context";
import { captureGenerationInputs } from "@/lib/generation-inputs";
import type { GenerationExecutionItem } from "@/lib/generation-types";
import { generationRuns } from "@/lib/generation-schema";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/keyframe-refinement-prompt", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/keyframe-refinement-prompt")>();
  return { ...original, buildKeyframeRefinementPrompt: vi.fn(original.buildKeyframeRefinementPrompt) };
});
import { GET, POST } from "@/app/api/project/[id]/keyframe-refine/route";
import { PATCH } from "@/app/api/project/[id]/assets/route";
import { buildKeyframeRefinementPrompt } from "@/lib/keyframe-refinement-prompt";
import { buildKeyframeFocusMask } from "@/lib/keyframe-focus-mask";
import * as focusPatch from "@/lib/keyframe-focus-patch";
import type { KeyframeFocusRegion } from "@/lib/keyframe-refinement";

const require = createRequire(import.meta.url);
const sqlite = new Database(":memory:");
const db = drizzle(sqlite, { schema });
const projectId = "keyframe-project", scriptId = "current-script";
const sourcePath = `/api/files/${projectId}/crop.png`;
const productPath = `/api/files/${projectId}/product.png`;
const presenterPath = `/api/files/${projectId}/presenter.png`;
const shot: schema.Shot = { shotId: 1, type: "demo", duration: 5, description: "A seated host demonstrates a hunting chair in a wooden blind.", camera: "static", visualSource: "ai_generate", transition: "direct_concat", voiceover: "" };
const fetchMock = vi.fn<typeof fetch>();
let directory: string, cropBytes: Buffer, productBytes: Buffer, presenterBytes: Buffer, outputBytes: Buffer, oversized720Bytes: Buffer, oversized1080Bytes: Buffer;
const ctx = () => ({ params: Promise.resolve({ id: projectId }) });
const currentScript = () => db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()!;
const allAssets = () => db.select().from(schema.assets).all();
function request(extra: Record<string, unknown> = {}) {
  return new NextRequest(`http://localhost/api/project/${projectId}/keyframe-refine`, { method: "POST", body: JSON.stringify({ scriptId, shotId: 1, sourceAssetId: "original", provider: "openai", model: "gpt-image-2", apiKey: "fixture-secret-key", baseUrl: "https://fixture-image.test/v1", issues: ["hands", "anatomy", "duplicates", "product", "details"], resolution: "720p", ...extra }) });
}
function sourceScope() { db.update(schema.assets).set(assetScopeForShot(currentScript(), currentScript().shots![0])).where(eq(schema.assets.id, "original")).run(); }
async function workerItem(presenterReference?: string): Promise<GenerationExecutionItem> {
  const project = db.select().from(schema.projects).get()!;
  const source = db.select().from(schema.assets).where(eq(schema.assets.id, "original")).get()!;
  const script = currentScript();
  return { id: "refine-worker-item", runId: "refine-run", projectId, scriptId, shotId: 1, kind: "keyframe_refine", checkpoint: null,
    payload: { request: await request().json(), snapshot: { project: structuredClone(project) as unknown as Record<string, unknown>,
      script: structuredClone(script) as unknown as Record<string, unknown>, refinement: { source: structuredClone(source) as unknown as Record<string, unknown>, presenterReference },
      referenceInputs: captureGenerationInputs({ source: source.filePath, products: project.productImages, presenterReference }) } } };
}
function runWorker(input: GenerationExecutionItem) {
  return executeGenerationItem(input, (value) => { input.checkpoint = structuredClone(value); });
}
async function freezeLegacyNativePlan(input: GenerationExecutionItem) {
  input.payload.request.resolution = "4k";
  const region = input.payload.request.focusRegion as KeyframeFocusRegion;
  const mask = buildKeyframeFocusMask(90, 160, region);
  const maskPath = `/api/files/${projectId}/keyframe-focus-legacy-${Math.random().toString(36).slice(2)}.png`;
  await writeFile(join(directory, "uploads", maskPath.replace("/api/files/", "")), mask);
  input.checkpoint = { submissionState: "not_submitted", refinementPlan: { provider: "openai", model: "gpt-image-2", prompt: "Frozen legacy native region prompt", sourceKeyframeUrl: sourcePath,
    scope: assetScopeForShot(currentScript(), currentScript().shots![0], "original"), resolution: "4k", target: { width: 2160, height: 3840 }, focusRegion: region, maskPath, maskHash: createHash("sha256").update(mask).digest("hex") } };
}
function tideweFixture(projectRevision = 1) {
  const presenter = { id: "tom", name: "Tom", appearance: "短发成年户外主播", referenceImages: [presenterPath] };
  const profile = createTideweOutdoorProfile({ speechMode: "on_camera", presenter });
  const text = "This chair fits the blind.";
  const facts: ProductFacts = { version: 1, brand: "TIDEWE", category: "other", items: [] };
  const copy: TideweCopyDocument = { version: 1, language: "en-US", text, translation: "这把椅子适合狩猎棚。", angle: "scene", hookType: "scene", claimedFactIds: [], factsSnapshot: facts, factsHash: productFactsHash(facts), corpusVersion: profile.corpusVersion, compilerVersion: profile.promptCompilerVersion, exampleIds: [], wordCount: englishWordCount(text), estimatedDuration: 5 };
  const selectedShot: schema.Shot = { ...shot, description: `${tidewePresenterAnchor(presenter)}在狩猎棚内自然展示椅子。`, visualIntent: "展示户外椅子", camera: "固定中景", prompt: "真实户外产品口播", characterId: presenter.id, voiceover: text, tidewe: { copySpan: { start: 0, end: text.length }, translation: copy.translation, shotGoal: "展示商品", productVisible: true, personVisible: true, presenter, sceneId: "blind", factRefs: [] } };
  db.update(schema.projects).set({ creativeProfile: profile, productFacts: facts, creativeConfigRevision: projectRevision }).run();
  db.update(schema.scripts).set({ styleType: "tidewe_outdoor", shots: [selectedShot], copyDocument: copy, creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1) }).run();
  sourceScope();
  return { profile, facts, selectedShot };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "clipforge-keyframe-refine-"));
  vi.stubEnv("APP_DATA_DIR", directory);
  vi.stubEnv("FFMPEG_PATH", require("ffmpeg-static") as string);
  vi.stubEnv("FFPROBE_PATH", (require("@ffprobe-installer/ffprobe") as { path: string }).path);
  state.db = db;
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  const uploads = join(directory, "uploads", projectId);
  await mkdir(uploads, { recursive: true });
  for (const [name, color, dimensions] of [["crop", "green", "90x160"], ["product", "blue", "120x90"], ["presenter", "yellow", "90x160"], ["output", "red", "180x320"], ["oversized-720", "red", "1080x1920"], ["oversized-1080", "red", "1440x2560"]]) execFileSync(process.env.FFMPEG_PATH!, ["-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=${dimensions}`, "-frames:v", "1", join(uploads, `${name}.png`)]);
  [cropBytes, productBytes, presenterBytes, outputBytes, oversized720Bytes, oversized1080Bytes] = await Promise.all(["crop", "product", "presenter", "output", "oversized-720", "oversized-1080"].map((name) => readFile(join(uploads, `${name}.png`))));
});

describe("durable keyframe refinement execution", () => {
  it("honors cancellation during async source preparation before any paid provider submission", async () => {
    const input = await workerItem();
    db.insert(generationRuns).values({ id: input.runId, projectId, clientRequestId: "cancel-during-preparation", requestHash: "test", kind: "keyframe_refine", createdAt: Date.now(), updatedAt: Date.now() }).run();
    const originalProbe = mediaProbe.probeMedia;
    const probe = vi.spyOn(mediaProbe, "probeMedia").mockImplementationOnce(async (path) => {
      const result = await originalProbe(path);
      db.update(generationRuns).set({ cancelRequested: true }).where(eq(generationRuns.id, input.runId)).run();
      return result;
    });
    try {
      await expect(runWorker(input)).rejects.toMatchObject({ code: "GENERATION_CANCELLED", retryable: false });
      expect(input.checkpoint).toMatchObject({ submissionState: "not_submitted", cancelledBeforeSubmission: true, stage: "cancelled", refinementPlan: { sourceKeyframeUrl: sourcePath } });
      expect(fetchMock).not.toHaveBeenCalled(); expect(allAssets()).toHaveLength(1);
    } finally { probe.mockRestore(); }
  });

  it("checkpoints the frozen plan before payment, saves an alternative, and replays completion without paying again", async () => {
    const input = await workerItem();
    fetchMock.mockImplementation(async () => {
      expect(generationContextCheckpoint()).toMatchObject({ submissionState: "submitting", refinementPlan: { sourceKeyframeUrl: sourcePath, model: "gpt-image-2" } });
      return Response.json({ data: [{ b64_json: outputBytes.toString("base64") }] });
    });
    const result = await runWorker(input);
    expect(result).toMatchObject({ asset: { selected: false, derivedFromAssetId: "original" }, assetIds: [result.assetId], imageUrls: [((result.asset as { filePath: string }).filePath)] });
    expect(await runWorker(input)).toEqual(result);
    expect(fetchMock).toHaveBeenCalledOnce(); expect(allAssets()).toHaveLength(2);
    expect(allAssets().filter((asset) => asset.selected).map((asset) => asset.id)).toEqual(["original"]);
  });

  it("releases async work and recovers its known task after the original source and shot were removed", async () => {
    const input = await workerItem();
    const generate = vi.spyOn(OpenAIProvider.prototype, "generateImage").mockImplementationOnce(async () => {
      expect(generationContextDefersPolling()).toBe(true);
      generationCheckpoint({ taskId: "paid-refinement", submissionState: "acknowledged" });
      throw new GenerationTaskPending("paid-refinement");
    });
    const query = vi.spyOn(OpenAIProvider.prototype, "getTaskStatus").mockResolvedValueOnce({ taskId: "paid-refinement", status: "processing" })
      .mockResolvedValueOnce({ taskId: "paid-refinement", status: "completed", result: { taskId: "paid-refinement", modelId: "gpt-image-2", imageUrls: [`data:image/png;base64,${outputBytes.toString("base64")}`] } });
    try {
      expect(await runWorker(input)).toMatchObject({ pending: true });
      db.update(schema.scripts).set({ shots: [] }).run();
      db.update(schema.projects).set({ creativeProfile: createPremiumProductCgProfile(), productImages: [] }).run();
      db.delete(schema.assets).run();
      expect(await runWorker(input)).toMatchObject({ pending: true });
      const result = await runWorker(input);
      expect(result).toMatchObject({ asset: { selected: false, sourceKeyframeUrl: sourcePath, derivedFromAssetId: "original" } });
      expect(allAssets()).toMatchObject([{ sourceScriptId: scriptId, derivedFromAssetId: "original", selected: false }]);
      expect(generate).toHaveBeenCalledOnce(); expect(query).toHaveBeenCalledTimes(2); expect(fetchMock).not.toHaveBeenCalled();
    } finally { generate.mockRestore(); query.mockRestore(); }
  });

  it("retries an interrupted download from the saved paid URL without regenerating", async () => {
    const input = await workerItem();
    const generate = vi.spyOn(OpenAIProvider.prototype, "generateImage").mockResolvedValueOnce({ taskId: "paid-download", modelId: "gpt-image-2", imageUrls: ["https://fixture-image.test/paid.png"] });
    fetchMock.mockResolvedValueOnce(new Response("temporarily unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(new Uint8Array(outputBytes), { headers: { "content-type": "image/png" } }));
    try {
      await expect(runWorker(input)).rejects.toMatchObject({ code: "GENERATION_IMPORT_FAILED", retryable: true });
      db.update(schema.scripts).set({ shots: [{ ...shot, description: "Edited after payment" }] }).run();
      const result = await runWorker(input);
      expect(result.assetId).toBeTruthy(); expect(generate).toHaveBeenCalledOnce(); expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(allAssets()).toHaveLength(2); expect(allAssets().filter((asset) => asset.selected)).toMatchObject([{ id: "original" }]);
      expect(allAssets().find((asset) => asset.id === result.assetId)?.sourceRevision).toBe((input.payload.snapshot!.refinement!.source).sourceRevision);
    } finally { generate.mockRestore(); }
  });

  it("reuses a saved alternative after the completion checkpoint is interrupted", async () => {
    const input = await workerItem();
    await expect(executeGenerationItem(input, (value) => {
      if (value.completedResult) throw new Error("worker stopped after asset insert");
      input.checkpoint = structuredClone(value);
    })).rejects.toThrow("worker stopped after asset insert");
    const savedId = allAssets().find((asset) => asset.id !== "original")!.id;
    expect(await runWorker(input)).toMatchObject({ assetId: savedId });
    expect(fetchMock).toHaveBeenCalledOnce(); expect(allAssets()).toHaveLength(2);
  });

  it("caps an oversized paid worker output and reuses the fitted file after an interrupted import", async () => {
    const input = await workerItem();
    fetchMock.mockResolvedValueOnce(Response.json({ data: [{ b64_json: oversized720Bytes.toString("base64") }] }));
    sqlite.exec("CREATE TRIGGER refinement_save_failure BEFORE INSERT ON assets WHEN NEW.id != 'original' BEGIN SELECT RAISE(FAIL, 'refinement asset write interrupted'); END");
    try {
      await expect(runWorker(input)).rejects.toMatchObject({ code: "GENERATION_IMPORT_FAILED", retryable: true });
    } finally { sqlite.exec("DROP TRIGGER refinement_save_failure"); }
    const savedPath = (input.checkpoint!.localPaths as Record<string, string>)["0"];
    const fittedPath = join(directory, "uploads", savedPath.replace("/api/files/", ""));
    const fittedBytes = await readFile(fittedPath);
    expect(await mediaProbe.probeMedia(fittedPath)).toMatchObject({ width: 720, height: 1280 });
    const result = await runWorker(input);
    expect(result).toMatchObject({ imageUrls: [savedPath], resolution: { requested: "720p", width: 720, height: 1280, limited: false } });
    expect(await runWorker(input)).toEqual(result);
    expect(await readFile(fittedPath)).toEqual(fittedBytes);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(allAssets()).toHaveLength(2);
    expect(allAssets().filter((asset) => asset.selected)).toMatchObject([{ id: "original" }]);
  });

  it("retains every paid output and retries a failed asset save without downloading or billing again", async () => {
    const input = await workerItem();
    fetchMock.mockResolvedValueOnce(Response.json({ data: [{ b64_json: outputBytes.toString("base64") }, { b64_json: presenterBytes.toString("base64") }] }));
    sqlite.exec("CREATE TRIGGER refinement_save_failure BEFORE INSERT ON assets WHEN NEW.id != 'original' BEGIN SELECT RAISE(FAIL, 'refinement asset write interrupted'); END");
    try {
      await expect(runWorker(input)).rejects.toMatchObject({ code: "GENERATION_IMPORT_FAILED", retryable: true });
    } finally { sqlite.exec("DROP TRIGGER refinement_save_failure"); }
    const firstPath = (input.checkpoint!.localPaths as Record<string, string>)["0"];
    db.update(schema.scripts).set({ selected: false }).run();
    db.insert(schema.scripts).values({ id: "new-script", projectId, selected: true, styleType: "scene", shots: [{ ...shot, description: "New alternative" }] }).run();
    const result = await runWorker(input);
    expect(result.assetIds).toHaveLength(2);
    expect((result.imageUrls as string[])[0]).toBe(firstPath);
    expect(allAssets()).toHaveLength(3); expect(fetchMock).toHaveBeenCalledOnce();
    expect(allAssets().filter((asset) => asset.id !== "original")).toMatchObject([
      { selected: false, sourceScriptId: scriptId, derivedFromAssetId: "original" },
      { selected: false, sourceScriptId: scriptId, derivedFromAssetId: "original" },
    ]);
  });

  it("requires attention after an unknown paid submission and never resubmits it automatically", async () => {
    const input = await workerItem();
    const generate = vi.spyOn(OpenAIProvider.prototype, "generateImage").mockRejectedValueOnce(new ProviderError("connection lost after sending image edit", "NETWORK_ERROR", "openai"));
    try {
      await expect(runWorker(input)).rejects.toMatchObject({ code: "GENERATION_NEEDS_ATTENTION", retryable: false });
      await expect(runWorker(input)).rejects.toMatchObject({ code: "GENERATION_NEEDS_ATTENTION" });
      expect(generate).toHaveBeenCalledOnce(); expect(allAssets()).toHaveLength(1);
    } finally { generate.mockRestore(); }
  });

  it("backs off a definitely rejected429 and keeps the confirmed repair request", async () => {
    const input = await workerItem();
    const error = new ProviderError("rate limited before acceptance", "RATE_LIMIT", "openai", 429); error.submissionRejected = true;
    const generate = vi.spyOn(OpenAIProvider.prototype, "generateImage").mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ taskId: "paid-after-backoff", modelId: "gpt-image-2", imageUrls: [`data:image/png;base64,${outputBytes.toString("base64")}`] });
    try {
      expect(await runWorker(input)).toMatchObject({ pending: true, stage: "provider_rate_limited", retryAfterMs: 30000 });
      expect(input.checkpoint?.submissionState).toBe("not_submitted");
      expect(await runWorker(input)).toHaveProperty("assetId");
      expect(generate).toHaveBeenCalledTimes(2); expect(generate.mock.calls[0]).toEqual(generate.mock.calls[1]);
    } finally { generate.mockRestore(); }
  });

  it("reuses a saved unsubmitted plan across a prompt-builder deployment", async () => {
    const input = await workerItem();
    const error = new ProviderError("rate limited before acceptance", "RATE_LIMIT", "openai", 429); error.submissionRejected = true;
    const generate = vi.spyOn(OpenAIProvider.prototype, "generateImage").mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ taskId: "paid-frozen-plan", modelId: "gpt-image-2", imageUrls: [`data:image/png;base64,${outputBytes.toString("base64")}`] });
    try {
      expect(await runWorker(input)).toMatchObject({ pending: true, stage: "provider_rate_limited" });
      const originalPlan = structuredClone(input.checkpoint?.refinementPlan);
      vi.mocked(buildKeyframeRefinementPrompt).mockImplementationOnce(() => "new prompt after deployment");
      vi.mocked(buildKeyframeRefinementPrompt).mockClear();
      expect(await runWorker(input)).toHaveProperty("assetId");
      expect(buildKeyframeRefinementPrompt).not.toHaveBeenCalled();
      expect(input.checkpoint?.refinementPlan).toEqual(originalPlan);
      expect(generate.mock.calls[0]).toEqual(generate.mock.calls[1]);
    } finally {
      generate.mockRestore();
      vi.mocked(buildKeyframeRefinementPrompt).mockReset();
      const original = await vi.importActual<typeof import("@/lib/keyframe-refinement-prompt")>("@/lib/keyframe-refinement-prompt");
      vi.mocked(buildKeyframeRefinementPrompt).mockImplementation(original.buildKeyframeRefinementPrompt);
    }
  });

  it("freezes the native mask and imports paid region output once after the mask file disappears", async () => {
    const input = await workerItem();
    Object.assign(input.payload.request, { issues: ["integration"], focusRegion: { x: 0, y: 0.75, width: 1, height: 0.25 } });
    await freezeLegacyNativePlan(input);
    const generate = vi.spyOn(OpenAIProvider.prototype, "generateImage").mockImplementationOnce(async (options) => {
      expect(options).toHaveProperty("maskImageUrl", expect.stringMatching(/^data:image\/png;base64,/));
      expect(options.referenceImageUrls).toHaveLength(2);
      generationCheckpoint({ taskId: "paid-masked-edit", submissionState: "acknowledged" });
      throw new GenerationTaskPending("paid-masked-edit");
    });
    const query = vi.spyOn(OpenAIProvider.prototype, "getTaskStatus").mockResolvedValueOnce({ taskId: "paid-masked-edit", status: "completed", result: { taskId: "paid-masked-edit", modelId: "gpt-image-2", imageUrls: [`data:image/png;base64,${oversized1080Bytes.toString("base64")}`] } });
    try {
      expect(await runWorker(input)).toMatchObject({ pending: true });
      const plan = input.checkpoint!.refinementPlan as { maskPath: string; focusRegion: unknown };
      expect(plan.focusRegion).toEqual(input.payload.request.focusRegion);
      expect(plan.maskPath).toMatch(/^\/api\/files\/keyframe-project\/keyframe-focus-.*\.png$/);
      await rm(join(directory, "uploads", plan.maskPath.replace("/api/files/", "")));
      const result = await runWorker(input);
      expect(result).toMatchObject({ resolution: { requested: "4k", width: 1440, height: 2560 } });
      const savedPath = (result.asset as { filePath: string }).filePath;
      expect(await mediaProbe.probeMedia(join(directory, "uploads", savedPath.replace("/api/files/", "")))).toMatchObject({ width: 1440, height: 2560 });
      expect(await runWorker(input)).toEqual(result);
      expect(generate).toHaveBeenCalledOnce();
      expect(query).toHaveBeenCalledOnce();
      expect(allAssets()).toHaveLength(2);
    } finally { generate.mockRestore(); query.mockRestore(); }
  });

  it("reuses the exact saved mask and prompt after an explicitly rejected submission", async () => {
    const input = await workerItem();
    Object.assign(input.payload.request, { issues: ["integration"], focusRegion: { x: 0.1, y: 0.75, width: 0.8, height: 0.25 } });
    await freezeLegacyNativePlan(input);
    const rejected = new ProviderError("rate limited before acceptance", "RATE_LIMIT", "openai", 429); rejected.submissionRejected = true;
    const generate = vi.spyOn(OpenAIProvider.prototype, "generateImage").mockRejectedValueOnce(rejected)
      .mockResolvedValueOnce({ taskId: "accepted-region", modelId: "gpt-image-2", imageUrls: [`data:image/png;base64,${outputBytes.toString("base64")}`] });
    try {
      expect(await runWorker(input)).toMatchObject({ pending: true, stage: "provider_rate_limited" });
      const plan = structuredClone(input.checkpoint!.refinementPlan);
      vi.mocked(buildKeyframeRefinementPrompt).mockClear();
      expect(await runWorker(input)).toHaveProperty("assetId");
      expect(input.checkpoint!.refinementPlan).toEqual(plan);
      expect(generate.mock.calls[0]).toEqual(generate.mock.calls[1]);
      expect(buildKeyframeRefinementPrompt).not.toHaveBeenCalled();
      expect(await runWorker(input)).toHaveProperty("assetId");
      expect(generate).toHaveBeenCalledTimes(2); // One rejected attempt, one accepted image.
    } finally { generate.mockRestore(); }
  });

  it("stops before a second submission if the frozen mask was replaced", async () => {
    const input = await workerItem();
    Object.assign(input.payload.request, { issues: ["integration"], focusRegion: { x: 0, y: 0.75, width: 1, height: 0.25 } });
    await freezeLegacyNativePlan(input);
    const rejected = new ProviderError("rate limited before acceptance", "RATE_LIMIT", "openai", 429); rejected.submissionRejected = true;
    const generate = vi.spyOn(OpenAIProvider.prototype, "generateImage").mockRejectedValueOnce(rejected);
    try {
      expect(await runWorker(input)).toMatchObject({ pending: true });
      const plan = input.checkpoint!.refinementPlan as { maskPath: string };
      await writeFile(join(directory, "uploads", plan.maskPath.replace("/api/files/", "")), cropBytes);
      await expect(runWorker(input)).rejects.toMatchObject({ code: "FOCUS_MASK_UNAVAILABLE" });
      expect(generate).toHaveBeenCalledOnce();
      expect(allAssets()).toHaveLength(1);
    } finally { generate.mockRestore(); }
  });

  it("checkpoints a paid raw crop before composition and retries local composition without provider or source reads", async () => {
    const input = await workerItem();
    Object.assign(input.payload.request, { issues: ["integration"], focusRegion: { x: 0, y: 0.75, width: 1, height: 0.25 } });
    const compose = vi.spyOn(focusPatch, "composeKeyframeFocusPatch").mockRejectedValueOnce(new Error("temporary local composition failure"));
    try {
      await expect(runWorker(input)).rejects.toMatchObject({ code: "GENERATION_IMPORT_FAILED", retryable: true });
      expect(input.checkpoint).toMatchObject({ submissionState: "acknowledged", refinementPlan: { strategy: "crop_composite_v1", target: { width: 90, height: 160 }, focusPatch: { version: 1, sourceHash: expect.any(String), cropHash: expect.any(String) } }, patchPaths: { "0": { filePath: expect.any(String), hash: expect.any(String), width: 180, height: 320 } } });
      expect(fetchMock).toHaveBeenCalledOnce();
      db.delete(schema.assets).run();
      db.delete(schema.scripts).run();
      const result = await runWorker(input);
      expect(result).toMatchObject({ resolution: { width: 90, height: 160, processingMode: "crop_composite_v1", actualPatchWidth: 180, actualPatchHeight: 320 } });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(compose).toHaveBeenCalledTimes(2);
      expect(await runWorker(input)).toEqual(result);
      expect(allAssets()).toHaveLength(1);
    } finally { compose.mockRestore(); }
  });

  it("reuses frozen crop bytes, geometry and prompt after rejection and blocks changed crop bytes before another payment", async () => {
    const input = await workerItem();
    Object.assign(input.payload.request, { issues: ["integration"], focusRegion: { x: 0, y: 0.75, width: 1, height: 0.25 } });
    const rejected = new ProviderError("rate limited before acceptance", "RATE_LIMIT", "openai", 429); rejected.submissionRejected = true;
    const generate = vi.spyOn(OpenAIProvider.prototype, "generateImage").mockRejectedValueOnce(rejected).mockRejectedValueOnce(rejected);
    try {
      expect(await runWorker(input)).toMatchObject({ pending: true });
      const frozen = structuredClone(input.checkpoint!.refinementPlan) as { focusPatch: focusPatch.PreparedKeyframeFocusPatch };
      vi.mocked(buildKeyframeRefinementPrompt).mockClear();
      expect(await runWorker(input)).toMatchObject({ pending: true });
      expect(generate.mock.calls[0]).toEqual(generate.mock.calls[1]);
      expect(buildKeyframeRefinementPrompt).not.toHaveBeenCalled();
      expect(input.checkpoint!.refinementPlan).toEqual(frozen);
      await writeFile(frozen.focusPatch.cropPath, outputBytes);
      await expect(runWorker(input)).rejects.toMatchObject({ code: "FOCUS_PATCH_UNAVAILABLE" });
      expect(generate).toHaveBeenCalledTimes(2);
    } finally { generate.mockRestore(); }
  });

  it("refuses a replaced paid raw patch during local recovery without another provider request", async () => {
    const input = await workerItem();
    Object.assign(input.payload.request, { issues: ["integration"], focusRegion: { x: 0, y: 0.75, width: 1, height: 0.25 } });
    const compose = vi.spyOn(focusPatch, "composeKeyframeFocusPatch").mockRejectedValueOnce(new Error("temporary local composition failure"));
    try {
      await expect(runWorker(input)).rejects.toMatchObject({ code: "GENERATION_IMPORT_FAILED" });
      const raw = (input.checkpoint!.patchPaths as Record<string, { filePath: string }>)["0"];
      await writeFile(join(directory, "uploads", raw.filePath.replace("/api/files/", "")), cropBytes);
      await expect(runWorker(input)).rejects.toMatchObject({ code: "GENERATION_IMPORT_FAILED" });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(compose).toHaveBeenCalledOnce();
      expect(allAssets()).toHaveLength(1);
    } finally { compose.mockRestore(); }
  });

  it("rejects a malformed saved unsubmitted plan instead of silently replacing its prompt", async () => {
    const input = await workerItem();
    input.checkpoint = { refinementPlan: { prompt: "" }, submissionState: "not_submitted" };
    await expect(runWorker(input)).rejects.toMatchObject({ code: "REFINEMENT_PLAN_INVALID" });
    expect(buildKeyframeRefinementPrompt).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["source", "script"])("blocks the first payment if the confirmed %s changed while queued", async (changed) => {
    const input = await workerItem();
    if (changed === "source") db.update(schema.assets).set({ filePath: `/api/files/${projectId}/output.png` }).run();
    else db.update(schema.scripts).set({ shots: [{ ...shot, description: "Changed while queued" }] }).run();
    await expect(runWorker(input)).rejects.toMatchObject({ code: "GENERATION_SOURCE_CHANGED" });
    expect(fetchMock).not.toHaveBeenCalled(); expect(allAssets()).toHaveLength(1);
  });

  it("uses the confirmed presenter image after the character library was edited", async () => {
    db.insert(schema.characters).values({ id: "saved-host", name: "Host", referenceImages: [presenterPath] }).run();
    db.update(schema.projects).set({ characterId: "saved-host" }).run();
    const input = await workerItem(presenterPath);
    db.update(schema.characters).set({ referenceImages: [`/api/files/${projectId}/output.png`] }).run();
    expect(await runWorker(input)).toHaveProperty("assetId");
    expect((await uploads()).bytes).toEqual([cropBytes, presenterBytes, productBytes]);
  });
});

beforeEach(() => {
  db.delete(generationRuns).run();
  db.delete(schema.assets).run(); db.delete(schema.scripts).run(); db.delete(schema.projects).run(); db.delete(schema.characters).run();
  const profile = createShortVideoSalesProfile({ styleType: "scene" });
  db.insert(schema.projects).values({ id: projectId, name: "Keyframe repair", productImages: [productPath], creativeProfile: profile, creativeConfigRevision: 1 }).run();
  db.insert(schema.scripts).values({ id: scriptId, projectId, selected: true, styleType: "scene", shots: [shot], creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1) }).run();
  db.insert(schema.assets).values({ id: "original", projectId, shotId: 1, type: "ai_generated", filePath: sourcePath, selected: true, status: "done", prompt: "[storyboard-grid-v2 第1格] seated host", ...assetScopeForShot(currentScript(), shot) }).run();
  fetchMock.mockReset().mockImplementation(async () => Response.json({ data: [{ b64_json: outputBytes.toString("base64") }] }));
  vi.mocked(buildKeyframeRefinementPrompt).mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterAll(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); sqlite.close(); await rm(directory, { recursive: true, force: true }); });

async function uploads() {
  expect(fetchMock.mock.calls[0][0]).toBe("https://fixture-image.test/v1/images/edits");
  const form = fetchMock.mock.calls[0][1]!.body as FormData;
  const images = form.getAll("image[]") as File[];
  return { form, bytes: await Promise.all(images.map(async (file) => Buffer.from(await file.arrayBuffer()))) };
}

describe("single-frame refinement edit contract", () => {
  it("defaults an omitted resolution to 720p", async () => {
    const response = await POST(request({ resolution: undefined }), ctx());
    expect(response.status).toBe(200);
    expect((await uploads()).form.get("size")).toBe("720x1280");
    expect(await response.json()).toMatchObject({ resolution: { requested: "720p", width: 180, height: 320, limited: true } });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["2k", "4k", null])("rejects a fresh unsupported resolution before payment: %s", async (resolution) => {
    const response = await POST(request({ resolution }), ctx());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_RESOLUTION", possiblyCharged: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(allAssets()).toMatchObject([{ id: "original", selected: true }]);
  });

  it.each([
    { resolution: "720p", width: 720, height: 1280, providerWidth: 1080, providerHeight: 1920 },
    { resolution: "1080p", width: 1080, height: 1920, providerWidth: 1440, providerHeight: 2560 },
  ])("saves an oversized provider image within the selected $resolution canvas", async ({ resolution, width, height, providerWidth, providerHeight }) => {
    const providerBytes = resolution === "720p" ? oversized720Bytes : oversized1080Bytes;
    fetchMock.mockResolvedValueOnce(Response.json({ data: [{ b64_json: providerBytes.toString("base64") }] }));
    const response = await POST(request({ resolution }), ctx());
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ resolution: { requested: resolution, width, height, limited: false } });
    const savedPath = join(directory, "uploads", result.asset.filePath.replace("/api/files/", ""));
    const savedBytes = await readFile(savedPath);
    expect(await mediaProbe.probeMedia(savedPath)).toMatchObject({ width, height });
    expect([savedBytes.readUInt32BE(16), savedBytes.readUInt32BE(20)]).toEqual([width, height]);
    expect(providerBytes.readUInt32BE(16)).toBe(providerWidth);
    expect(providerBytes.readUInt32BE(20)).toBe(providerHeight);
    expect(await readFile(join(directory, "uploads", projectId, "crop.png"))).toEqual(cropBytes);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(allAssets().filter((asset) => asset.selected)).toMatchObject([{ id: "original" }]);
  });

  it("composites a high-resolution source before fitting the complete region-repaired frame without cropping", async () => {
    const highSourcePath = join(directory, "uploads", projectId, "region-source-hd.png");
    const highSourceUrl = `/api/files/${projectId}/region-source-hd.png`;
    execFileSync(process.env.FFMPEG_PATH!, ["-v", "error", "-f", "lavfi", "-i", "color=c=green:s=1440x2560,drawbox=x=0:y=0:w=72:h=2560:color=blue:t=fill,drawbox=x=1368:y=0:w=72:h=2560:color=yellow:t=fill", "-frames:v", "1", highSourcePath]);
    const highSourceBytes = await readFile(highSourcePath);
    db.update(schema.assets).set({ filePath: highSourceUrl }).where(eq(schema.assets.id, "original")).run();
    const response = await POST(request({ issues: ["integration"], focusRegion: { x: 0, y: 0.75, width: 1, height: 0.25 } }), ctx());
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ asset: { selected: false, sourceKeyframeUrl: highSourceUrl }, resolution: { requested: "720p", width: 720, height: 1280, limited: false, processingMode: "crop_composite_v1", preservesSourceDimensions: false } });
    const savedPath = join(directory, "uploads", result.asset.filePath.replace("/api/files/", ""));
    expect(await mediaProbe.probeMedia(savedPath)).toMatchObject({ width: 720, height: 1280 });
    const pixels = execFileSync(process.env.FFMPEG_PATH!, ["-v", "error", "-i", savedPath, "-frames:v", "1", "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1"], { maxBuffer: 8 * 1024 * 1024 });
    const pixel = (x: number, y: number) => [...pixels.subarray((y * 720 + x) * 4, (y * 720 + x) * 4 + 3)];
    // Both edge markers, the untouched center and the repaired bottom survive the proportional fit.
    expect(pixel(10, 10)).toEqual([0, 0, 254]);
    expect(pixel(710, 10)).toEqual([253, 253, 0]);
    expect(pixel(360, 10)).toEqual([0, 127, 0]);
    expect(pixel(360, 1270)).toEqual([253, 0, 0]);
    expect(await readFile(highSourcePath)).toEqual(highSourceBytes);
    expect(await readFile(join(directory, "uploads", projectId, "crop.png"))).toEqual(cropBytes);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("sends only the immutable context crop and composites an unselected candidate at original dimensions", async () => {
    tideweFixture();
    const focusRegion = { x: 0, y: 0.75, width: 1, height: 0.25 };
    const response = await POST(request({ issues: ["integration"], focusRegion }), ctx());
    expect(response.status).toBe(200);
    const { form, bytes } = await uploads();
    expect(bytes).toHaveLength(1);
    expect(bytes[0]).not.toEqual(cropBytes);
    expect(form.has("mask")).toBe(false);
    expect(bytes[0].readUInt32BE(16)).toBe(90);
    expect(bytes[0].readUInt32BE(20)).toBeLessThan(160);
    expect(buildKeyframeRefinementPrompt).toHaveBeenCalledWith(expect.objectContaining({ focusRegion, focusPatch: expect.any(Object), hasPresenterReference: false, productReferenceCount: 0 }));
    expect(form.get("prompt")).toContain("CROPPED FOREGROUND FOCUS REPAIR");
    expect(form.get("prompt")).not.toContain(TIDEWE_PHOTOGRAPHIC_POLICY);
    expect(form.get("prompt")).not.toContain(TIDEWE_IMAGE_FOCUS_TARGET);
    expect(form.get("n")).toBe("1");
    expect(form.get("quality")).toBe("high");
    expect(form.get("output_format")).toBe("png");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(allAssets()).toHaveLength(2);
    const result = await response.json();
    expect(result).toMatchObject({ asset: { selected: false, derivedFromAssetId: "original" }, resolution: { width: 90, height: 160, limited: false, processingMode: "crop_composite_v1", preservesSourceDimensions: true } });
    const composited = await readFile(join(directory, "uploads", result.asset.filePath.replace("/api/files/", "")));
    const decode = (bytes: Buffer) => execFileSync(process.env.FFMPEG_PATH!, ["-v", "error", "-i", "pipe:0", "-frames:v", "1", "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1"], { input: bytes });
    const originalPixels = decode(cropBytes), outputPixels = decode(composited);
    expect(outputPixels.subarray(0, 120 * 90 * 4)).toEqual(originalPixels.subarray(0, 120 * 90 * 4));
    expect(outputPixels.subarray(159 * 90 * 4)).not.toEqual(originalPixels.subarray(159 * 90 * 4));
  });

  it("never falls back to a full-image edit if the provider rejects the crop edit", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: { message: "mask parameter unsupported", code: "unsupported_parameter", param: "mask" } }, { status: 400 }));
    const response = await POST(request({ issues: ["integration"], focusRegion: { x: 0, y: 0.75, width: 1, height: 0.25 } }), ctx());
    expect(response.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((await uploads()).form.has("mask")).toBe(false);
    expect(allAssets()).toHaveLength(1);
  });

  it.each([
    { focusRegion: null, code: "INVALID_FOCUS_REGION" },
    { focusRegion: { x: 0, y: 0.7, width: 1, height: 0.3, feather: 0.1 }, code: "INVALID_FOCUS_REGION" },
    { focusRegion: { x: 0.9, y: 0.7, width: 1, height: 0.3 }, code: "INVALID_FOCUS_REGION" },
    { focusRegion: { x: 0, y: 0.7, width: 1, height: 0.3 }, issues: ["integration", "hands"], code: "FOCUS_REGION_REQUIRES_INTEGRATION" },
    { focusRegion: { x: 0, y: 0.7, width: 1, height: 0.3 }, issues: ["integration", "integration"], code: "FOCUS_REGION_REQUIRES_INTEGRATION" },
    { focusRegion: { x: 0, y: 0.7, width: 1, height: 0.3 }, provider: "fal-ai", code: "FOCUS_MASK_UNSUPPORTED" },
    { focusRegion: { x: 0, y: 0.7, width: 1, height: 0.3 }, model: "gpt-image-1.5", code: "FOCUS_MASK_UNSUPPORTED" },
  ])("rejects unusable region edits before payment ($code)", async ({ code, ...fields }) => {
    const response = await POST(request({ issues: ["integration"], ...fields }), ctx());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code, possiblyCharged: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(allAssets()).toHaveLength(1);
  });

  it("rejects a non-PNG source for native masking before any provider request", async () => {
    const jpeg = join(directory, "uploads", projectId, "source-jpeg.jpg");
    execFileSync(process.env.FFMPEG_PATH!, ["-v", "error", "-y", "-i", join(directory, "uploads", projectId, "crop.png"), "-frames:v", "1", jpeg]);
    db.update(schema.assets).set({ filePath: `/api/files/${projectId}/source-jpeg.jpg` }).where(eq(schema.assets.id, "original")).run();
    const response = await POST(request({ issues: ["integration"], focusRegion: { x: 0, y: 0.75, width: 1, height: 0.25 } }), ctx());
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "FOCUS_MASK_PNG_REQUIRED", possiblyCharged: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uploads the crop first, requests its true ratio, and saves a durable unselected candidate", async () => {
    const response = await POST(request(), ctx());
    expect(response.status).toBe(200);
    const result = await response.json();
    const { form, bytes } = await uploads();
    expect(bytes).toEqual([cropBytes, productBytes]);
    expect(form.get("size")).toBe("720x1280");
    expect(form.get("n")).toBe("1");
    expect(form.has("mask")).toBe(false);
    expect(form.get("prompt")).toContain("primary scene and composition anchor");
    expect(form.get("prompt")).toContain("retain natural occlusion");
    expect(result).toMatchObject({ asset: { shotId: 1, selected: false, sourceKeyframeUrl: sourcePath, derivedFromAssetId: "original", model: "gpt-image-2" }, resolution: { requested: "720p", width: 180, height: 320, limited: true } });
    expect(result.asset.filePath).toMatch(/^\/api\/files\/keyframe-project\/keyframe-refine-1-\d+-[a-z0-9]{8}\.png$/);
    const rows = allAssets();
    expect(rows.find((row) => row.id === "original")).toMatchObject({ selected: true, filePath: sourcePath });
    expect(rows.find((row) => row.id === result.asset.id)).toMatchObject({ selected: false, sourceScriptId: scriptId, derivedFromAssetId: "original" });
    const candidates = await GET(new NextRequest(`http://localhost/api/project/${projectId}/keyframe-refine?scriptId=${scriptId}&shotId=1`), ctx());
    expect((await candidates.json()).candidates).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([1, 6])("uses the frozen TIDEWE presenter and permits adoption at compatible project revision %s", async (projectRevision) => {
    tideweFixture(projectRevision);
    const before = currentScript();
    const response = await POST(request(), ctx());
    const result = await response.json();
    expect(response.status).toBe(200);
    const { form, bytes } = await uploads();
    expect(bytes).toEqual([cropBytes, presenterBytes, productBytes]);
    expect(form.get("prompt")).toContain("Frozen presenter: 所选主播 Tom");
    expect(form.get("prompt")).not.toContain("Their lips, jaw and mouth must move");
    expect(allAssets().find((asset) => asset.id === "original")?.selected).toBe(true);
    const list = await GET(new NextRequest(`http://localhost/api/project/${projectId}/keyframe-refine?scriptId=${scriptId}&shotId=1`), ctx());
    expect(list.status).toBe(200);
    expect((await list.json()).candidates).toHaveLength(2);
    for (const assetId of [result.asset.id, "original"]) {
      const adopt = await PATCH(new NextRequest(`http://localhost/api/project/${projectId}/assets`, { method: "PATCH", body: JSON.stringify({ assetId }) }), ctx());
      expect(adopt.status).toBe(200);
      expect(allAssets().filter((asset) => asset.selected).map((asset) => asset.id)).toEqual([assetId]);
    }
    expect(currentScript()).toEqual(before);
    expect(db.select().from(schema.projects).get()?.creativeConfigRevision).toBe(projectRevision);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends the TIDEWE integration repair through one OpenAI edit while preserving source, script and reference order", async () => {
    tideweFixture();
    const beforeScript = currentScript();
    const beforeSource = allAssets().find((asset) => asset.id === "original")!;
    const response = await POST(request({ issues: ["integration"] }), ctx());
    expect(response.status).toBe(200);
    const result = await response.json();
    const { form, bytes } = await uploads();
    expect(bytes).toEqual([cropBytes, presenterBytes, productBytes]);
    expect(form.get("n")).toBe("1");
    const prompt = String(form.get("prompt"));
    expect(prompt).toContain("SINGLE FOCUS TASK: re-render the entire existing photograph");
    expect(prompt.split(TIDEWE_IMAGE_FOCUS_TARGET)).toHaveLength(2);
    expect(prompt).toContain("Keep existing positions, poses, gestures, object counts, contact, occlusion, scene geometry and background content");
    expect(prompt).toContain("Preserve camera position, perspective, framing, crop, light direction, time of day and color palette");
    expect(prompt).toContain("source blur, cutout edges, sharpening halos and excessive subject microcontrast are defects to correct, not protected pixel attributes");
    expect(prompt).toContain("source similarity must not preserve those optical defects");
    expect(prompt).toContain("Keep intentional empty backgrounds empty");
    expect(prompt).not.toContain(TIDEWE_PHOTOGRAPHIC_POLICY);
    expect(prompt).not.toContain("SPATIAL INTEGRATION AND FOCUS REPAIR");
    expect(prompt).not.toContain("LOCAL ANATOMY REPAIR PRIORITY");
    expect(prompt).toContain("Frozen presenter: 所选主播 Tom");
    expect(prompt).toContain("Reference image 2 is the frozen presenter identity reference only");
    expect(prompt).toContain("The last 1 reference image(s) are saved product views");
    expect(prompt).toContain("Image 1 is the cropped approved single-shot scene");
    expect(result.asset).toMatchObject({ selected: false, sourceKeyframeUrl: sourcePath, derivedFromAssetId: "original" });
    expect(allAssets()).toHaveLength(2);
    expect(allAssets().find((asset) => asset.id === result.asset.id)).toMatchObject({ selected: false, sourceScriptId: scriptId, derivedFromAssetId: "original" });
    expect(allAssets().find((asset) => asset.id === "original")).toEqual(beforeSource);
    expect(allAssets().filter((asset) => asset.selected).map((asset) => asset.id)).toEqual(["original"]);
    expect(currentScript()).toEqual(beforeScript);
    expect(await readFile(join(directory, "uploads", projectId, "crop.png"))).toEqual(cropBytes);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    { category: "accessories" as const, name: "狩猎椅", canonical: "accessories", evidence: "不默认可折叠、旋转或调节" },
    { category: "hunting_apparel" as const, name: "户外夹克", canonical: "apparel", evidence: "不默认迷彩、加热、防水" },
    { category: "boots" as const, name: "狩猎靴", canonical: "boots", evidence: "靴子主类不等于防水靴或防蛇靴" },
  ])("uses the frozen $category category in the actual edit even when the current project changed", async ({ category, name, canonical, evidence }) => {
    tideweFixture();
    const saved = currentScript();
    const facts: ProductFacts = { ...saved.copyDocument!.factsSnapshot, category };
    const copy: TideweCopyDocument = { ...saved.copyDocument!, factsSnapshot: facts, factsHash: productFactsHash(facts), productName: name };
    db.update(schema.scripts).set({ copyDocument: copy }).run();
    db.update(schema.projects).set({ productFacts: { ...facts, category: "waders" }, productName: "新涉水服" }).run();
    sourceScope();
    const beforeScript = currentScript();
    const response = await POST(request({ issues: ["integration"] }), ctx());
    expect(response.status).toBe(200);
    const { form, bytes } = await uploads();
    const context = JSON.parse(String(form.get("prompt")).split("CATEGORY_REPAIR_CONTEXT: ")[1].split("\n")[0]);
    expect(context).toMatchObject({ category: canonical, evidenceLimits: expect.stringContaining(evidence) });
    expect(context).not.toHaveProperty("contactAndFocus");
    expect(bytes).toEqual([cropBytes, presenterBytes, productBytes]);
    expect(currentScript()).toEqual(beforeScript);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["facts", "presenter", "speech", "type"])("uses the frozen TIDEWE option after %s edits while keeping the type boundary", async (changed) => {
    const { profile, facts } = tideweFixture(6);
    if (changed === "facts") db.update(schema.projects).set({ productFacts: { ...facts, category: "hunting_chair" } }).run();
    if (changed === "presenter") db.update(schema.projects).set({ creativeProfile: { ...profile, presenter: { ...profile.presenter!, id: "different-presenter" } } }).run();
    if (changed === "speech") db.update(schema.projects).set({ creativeProfile: { ...profile, speechMode: "voiceover" } }).run();
    if (changed === "type") db.update(schema.projects).set({ creativeProfile: createPremiumProductCgProfile() }).run();
    const list = await GET(new NextRequest(`http://localhost/api/project/${projectId}/keyframe-refine?scriptId=${scriptId}&shotId=1`), ctx());
    const response = await POST(request(), ctx());
    if (changed === "type") {
      expect(list.status).toBe(409);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ possiblyCharged: false });
      expect(fetchMock).not.toHaveBeenCalled();
    } else {
      expect(list.status).toBe(200);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ asset: { selected: false, derivedFromAssetId: "original" } });
      expect((await uploads()).form.get("prompt")).toContain("Frozen presenter: 所选主播 Tom");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
    expect(allAssets().filter((asset) => asset.selected)).toMatchObject([{ id: "original" }]);
  });

  it.each(["project", "shot", "cast-id-fallback"])("uses the saved ordinary %s presenter after the source frame", async (selection) => {
    db.insert(schema.characters).values([{ id: "project-host", name: "Project host", referenceImages: [presenterPath] },
      { id: "shot-host", name: "Shot host", referenceImages: [`/api/files/${projectId}/output.png`] }]).run();
    db.update(schema.projects).set({ characterId: "project-host" }).run();
    if (selection !== "project") db.update(schema.scripts).set({ shots: [{ ...shot, characterId: selection === "shot" ? "shot-host" : "dialogue-cast-name" }] }).run();
    sourceScope();
    const response = await POST(request(), ctx());
    expect(response.status).toBe(200);
    const { form, bytes } = await uploads();
    expect(bytes).toEqual([cropBytes, selection === "shot" ? outputBytes : presenterBytes, productBytes]);
    expect(form.get("prompt")).toContain("saved presenter identity reference");
    expect(form.get("prompt")).not.toContain("frozen presenter identity reference");
  });

  it("rejects unsupported edit models before any external call", async () => {
    const response = await POST(request({ provider: "replicate", model: "text-only-model" }), ctx());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "KEYFRAME_EDIT_MODEL_UNSUPPORTED", possiblyCharged: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(allAssets()).toMatchObject([{ id: "original", selected: true }]);
  });

  it("lets premium CG list, adopt, refine again, and roll back its trusted repair candidates", async () => {
    const profile = createPremiumProductCgProfile({ narrationMode: "none" });
    const productShot: schema.Shot = { ...shot, description: "A complete hunting chair in a quiet wood-paneled room.", visualIntent: "Observe the supplied chair geometry and upholstery.", camera: "A static three-quarter product view.", voiceover: "" };
    db.insert(schema.characters).values({ id: "legacy-host", name: "Legacy host", referenceImages: [presenterPath] }).run();
    db.update(schema.projects).set({ creativeProfile: profile, characterId: "legacy-host", creativeConfigRevision: 6 }).run();
    db.update(schema.scripts).set({ styleType: "premium_product_cg", shots: [productShot], creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1) }).run();
    const trustedOriginal = `/api/files/${projectId}/asset-1-123-grid.png`;
    await copyFile(join(directory, "uploads", projectId, "crop.png"), join(directory, "uploads", projectId, "asset-1-123-grid.png"));
    db.update(schema.assets).set({ filePath: trustedOriginal }).run();
    sourceScope();
    const firstResponse = await POST(request({ issues: ["product", "duplicates"] }), ctx());
    const firstResult = await firstResponse.json();
    expect(firstResponse.status).toBe(200);
    expect(firstResult.asset).toMatchObject({ selected: false, derivedFromAssetId: "original", sourceKeyframeUrl: trustedOriginal });
    const { form, bytes } = await uploads();
    expect(bytes).toEqual([cropBytes, productBytes]);
    expect(form.get("prompt")).toContain("Premium product CG.");
    expect(allAssets().find((row) => row.id === "original")?.selected).toBe(true);
    const listRequest = () => new NextRequest(`http://localhost/api/project/${projectId}/keyframe-refine?scriptId=${scriptId}&shotId=1`);
    expect((await (await GET(listRequest(), ctx())).json()).candidates).toHaveLength(2);
    const adopt = (assetId: string) => PATCH(new NextRequest(`http://localhost/api/project/${projectId}/assets`, { method: "PATCH", body: JSON.stringify({ assetId }) }), ctx());
    expect((await adopt(firstResult.asset.id)).status).toBe(200);
    expect(allAssets().find((row) => row.id === firstResult.asset.id)?.selected).toBe(true);
    const nextResponse = await POST(request({ sourceAssetId: firstResult.asset.id, issues: ["details"], resolution: "1080p" }), ctx());
    const nextResult = await nextResponse.json();
    expect(nextResponse.status).toBe(200);
    expect(nextResult.asset).toMatchObject({ selected: false, derivedFromAssetId: firstResult.asset.id, sourceKeyframeUrl: firstResult.asset.filePath });
    expect(allAssets().find((row) => row.id === firstResult.asset.id)?.selected).toBe(true);
    expect((await (await GET(listRequest(), ctx())).json()).candidates).toHaveLength(3);
    expect((await adopt(nextResult.asset.id)).status).toBe(200);
    expect((await adopt("original")).status).toBe(200);
    expect(allAssets().filter((row) => row.selected)).toMatchObject([{ id: "original", filePath: trustedOriginal }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["other-shot", "other-script", "missing-file", "video"])("rejects %s sources and preserves the selection", async (invalid) => {
    if (invalid === "other-shot") db.update(schema.assets).set({ shotId: 2 }).run();
    if (invalid === "other-script") db.update(schema.assets).set({ sourceScriptId: "another-script" }).run();
    if (invalid === "missing-file") db.update(schema.assets).set({ filePath: `/api/files/${projectId}/missing.png` }).run();
    if (invalid === "video") db.update(schema.assets).set({ filePath: `/api/files/${projectId}/video.mp4` }).run();
    const response = await POST(request(), ctx());
    expect([409, 422]).toContain(response.status);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(allAssets()).toMatchObject([{ id: "original", selected: true }]);
  });

  it("rejects an already deselected script before generation", async () => {
    db.update(schema.scripts).set({ selected: false }).run();
    const response = await POST(request(), ctx());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "SCRIPT_CONTEXT_CHANGED", possiblyCharged: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves ownership when generation changes script content or switches options (switch: %s)", async (switchOption) => {
    fetchMock.mockImplementation(async () => {
      if (switchOption) {
        db.update(schema.scripts).set({ selected: false }).run();
        db.insert(schema.scripts).values({ ...currentScript(), id: "other-option", selected: true }).run();
      } else db.update(schema.scripts).set({ shots: [{ ...shot, description: "A changed scene" }] }).run();
      return Response.json({ data: [{ b64_json: outputBytes.toString("base64") }] });
    });
    const response = await POST(request(), ctx());
    if (switchOption) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "SCRIPT_CONTEXT_CHANGED", possiblyCharged: true });
      expect(allAssets()).toHaveLength(1);
    } else {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ asset: { sourceKeyframeUrl: sourcePath, selected: false } });
      expect(allAssets()).toHaveLength(2);
    }
    expect(allAssets().filter((asset) => asset.selected)).toMatchObject([{ id: "original" }]);
  });

  it("continues after the same project's revision changes while preparing references", async () => {
    db.update(schema.projects).set({ creativeConfigRevision: 6 }).run();
    const originalProbe = mediaProbe.probeMedia;
    const probe = vi.spyOn(mediaProbe, "probeMedia").mockImplementationOnce(async (path) => {
      const result = await originalProbe(path);
      db.update(schema.projects).set({ creativeConfigRevision: 7 }).run();
      return result;
    });
    try {
      const response = await POST(request(), ctx());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ asset: { selected: false, derivedFromAssetId: "original" } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(allAssets().filter((asset) => asset.selected)).toMatchObject([{ id: "original" }]);
    } finally { probe.mockRestore(); }
  });

  it("saves the same option's result after the live revision changes during generation", async () => {
    db.update(schema.projects).set({ creativeConfigRevision: 6 }).run();
    fetchMock.mockImplementation(async () => {
      db.update(schema.projects).set({ creativeConfigRevision: 7 }).run();
      return Response.json({ data: [{ b64_json: outputBytes.toString("base64") }] });
    });
    const response = await POST(request(), ctx());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ asset: { selected: false, derivedFromAssetId: "original" } });
    expect(allAssets().filter((asset) => asset.selected)).toMatchObject([{ id: "original" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns the provider failure without changing selection or retrying paid generation", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: { message: "fixture-secret-key invalid image" } }, { status: 422 }));
    const response = await POST(request(), ctx());
    expect(response.status).toBe(502);
    const result = await response.json();
    expect(result.error).toContain("invalid image");
    expect(result.error).not.toContain("fixture-secret-key");
    expect(result.possiblyCharged).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(allAssets()).toMatchObject([{ id: "original", selected: true }]);
  });

  it("returns the paid provider task id when generation fails after submission", async () => {
    const error = new ProviderError("Polling failed after task creation", "POLLING_FAILED", "openai");
    error.taskId = "paid-fixture-task";
    const generation = vi.spyOn(OpenAIProvider.prototype, "generateImage").mockRejectedValueOnce(error);
    try {
      const response = await POST(request(), ctx());
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ possiblyCharged: true, taskId: "paid-fixture-task", code: "POLLING_FAILED" });
      expect(generation).toHaveBeenCalledTimes(1);
      expect(allAssets()).toMatchObject([{ id: "original", selected: true }]);
    } finally { generation.mockRestore(); }
  });

  it("blocks concurrent generation for the same source and releases the lock after completion", async () => {
    let release!: (response: Response) => void;
    let reached!: () => void;
    const pending = new Promise<void>((resolve) => { reached = resolve; });
    fetchMock.mockImplementationOnce(() => { reached(); return new Promise<Response>((resolve) => { release = resolve; }); });
    const first = POST(request(), ctx());
    await pending;
    try {
      const duplicate = await POST(request(), ctx());
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toMatchObject({ code: "KEYFRAME_REFINEMENT_IN_PROGRESS" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { release(Response.json({ data: [{ b64_json: outputBytes.toString("base64") }] })); }
    expect((await first).status).toBe(200);
    expect((await POST(request({ issues: ["hands"], resolution: "720p" }), ctx())).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(db.select().from(schema.assets).where(and(eq(schema.assets.id, "original"), eq(schema.assets.selected, true))).all()).toHaveLength(1);
  });
});
