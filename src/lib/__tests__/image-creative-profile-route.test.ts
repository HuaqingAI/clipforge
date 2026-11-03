import { createShortVideoSalesProfile } from "@/lib/creative-profiles";
// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as schema from "@/lib/db/schema";
import {
  createCreativeProfileSnapshot,

  createTideweOutdoorProfile,
} from "@/lib/creative-profiles";
import { englishWordCount, productFactsHash } from "@/lib/tidewe/validation";
import type { ProductFacts, TideweCopyDocument, TidewePresenterSnapshot } from "@/lib/tidewe/types";
import { compileTideweVisualPrompt } from "@/lib/tidewe/visual-policy";
import { tidewePresenterAnchor } from "@/lib/tidewe/presenter";

const state = vi.hoisted(() => ({
  db: null as unknown,
  createProvider: vi.fn(),
  generateImage: vi.fn(),
  toRemoteUsableImage: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/providers", () => ({ createProvider: state.createProvider }));
vi.mock("@/lib/remote-image", () => ({ toRemoteUsableImage: state.toRemoteUsableImage }));

import { POST } from "@/app/api/ai/image/route";

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
const projectId = "image-profile-project";
const scriptId = "image-profile-script";
const productImage = `/api/files/${projectId}/product.png`;
const profile = createShortVideoSalesProfile();
const shot: schema.Shot = {
  shotId: 1,
  type: "product_reveal",
  duration: 5,
  description: "A complete lounge chair in a quiet studio, with the reference upholstery and wood structure preserved.",
  camera: "A restrained slow push-in.",
  voiceover: "",
  visualSource: "product_image",
  transition: "direct_concat",
};

function request(overrides: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/ai/image", {
    method: "POST",
    body: JSON.stringify({
      provider: "fixture",
      model: "image-model",
      apiKey: "fixture-key",
      prompt: shot.description,
      projectId,
      scriptId,
      shotId: shot.shotId,
      ...overrides,
    }),
  });
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  state.db = db;
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  db.insert(schema.projects).values({
    id: projectId,
    name: "Image profile context",
    creativeProfile: profile,
    creativeConfigRevision: 2,
    productImages: [productImage],
  }).run();
  db.insert(schema.scripts).values({
    id: scriptId,
    projectId,
    selected: true,
    styleType: "pain_point",
    shots: [shot],
    creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 2),
  }).run();
  state.generateImage.mockReset().mockResolvedValue({ imageUrls: ["https://example.test/image.png"] });
  state.createProvider.mockReset().mockReturnValue({ generateImage: state.generateImage });
  state.toRemoteUsableImage.mockReset().mockImplementation(async (value: unknown) => value);
});

afterEach(() => {
  sqlite.close();
  state.db = null;
  vi.clearAllMocks();
});

function useTidewe(productVisible: boolean, presenter?: TidewePresenterSnapshot) {
  const profile = createTideweOutdoorProfile({ presenter });
  const text = "The walk into the woods is only the start. Have a look if that sounds familiar.";
  const facts: ProductFacts = { version: 1, brand: "TIDEWE", category: "other", items: [] };
  const copyDocument: TideweCopyDocument = {
    version: 1, language: "en-US", text, translation: "走进林子只是开始。适合的话可以看看。", angle: "scene", hookType: "scene",
    claimedFactIds: [], factsSnapshot: facts, factsHash: productFactsHash(facts), corpusVersion: profile.corpusVersion,
    compilerVersion: profile.promptCompilerVersion, exampleIds: [], wordCount: englishWordCount(text), estimatedDuration: 5,
  };
  const tideweShot: schema.Shot = {
    ...shot, visualSource: productVisible ? "product_image" : "ai_generate", voiceover: text, description: `${presenter ? tidewePresenterAnchor(presenter) : "猎人"}在清晨林缘停步，低头检查装备。`, visualIntent: "建立户外行走场景。", prompt: "清晨户外小径。", camera: "固定中景",
    ...(presenter && { characterId: presenter.id }), tidewe: { ...(presenter && { presenter, personVisible: true }), copySpan: { start: 0, end: text.length }, translation: copyDocument.translation, shotGoal: "展示入林前检查装备", productVisible, factRefs: [], sceneId: "woods" },
  };
  db.update(schema.projects).set({ creativeProfile: profile }).run();
  db.update(schema.scripts).set({ styleType: "tidewe_outdoor", shots: [tideweShot], copyDocument, creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 2) }).run();
  return tideweShot;
}

describe("TIDEWE image generation uses saved shot semantics", () => {
  const presenter: TidewePresenterSnapshot = { id: "selected-host", name: "Selected host", appearance: "棕色短发，灰色胡须", referenceImages: ["/api/files/selected-host.png"] };
  it.each([false, true])("keeps off-camera detail framing and frozen references with personVisible=%s", async (personVisible) => {
    const shot = useTidewe(true, presenter);
    db.update(schema.scripts).set({ shots: [{
      ...shot, visualSource: "ai_generate", camera: "固定产品细节特写，不出现脸部。",
      description: personVisible ? `${tidewePresenterAnchor(presenter)}仅双手入画，轻按商品面料。` : "林缘地面上静置商品的细节特写，无人入画。",
      tidewe: { ...shot.tidewe!, personVisible, speechDelivery: "off_camera" },
    }] }).run();
    const response = await POST(request({ provider: "openai", imageUrl: "https://example.test/other-person.png", imageUrls: ["https://example.test/other-person.png"] }));
    expect(response.status).toBe(200);
    const generated = state.generateImage.mock.calls[0][0];
    expect(generated.referenceImageUrls).toEqual([...(personVisible ? [presenter.referenceImages[0]] : []), productImage]);
    expect(generated.prompt).not.toContain("嘴部清晰可见");
    expect(generated.prompt).toContain("固定产品细节特写");
    expect(state.toRemoteUsableImage.mock.calls.some(([url]) => url === presenter.referenceImages[0])).toBe(personVisible);
  });
  it.each([true, false])("uses the frozen presenter's actual image with productVisible=%s instead of browser identity", async (productVisible) => {
    useTidewe(productVisible, presenter);
    const response = await POST(request({ provider: "openai", imageUrl: "https://example.test/other-person.png", imageUrls: ["https://example.test/other-person.png"] }));
    expect(response.status).toBe(200);
    const generated = state.generateImage.mock.calls[0][0];
    expect(generated.mode).toBe("image-to-image");
    expect(generated.referenceImageUrl).toBe(presenter.referenceImages[0]);
    expect(generated.referenceImageUrls).toEqual([presenter.referenceImages[0], ...(productVisible ? [productImage] : [])]);
    expect(generated.prompt).toContain(presenter.name);
    expect(generated.prompt).toContain(presenter.appearance);
  });
  it("uses an uploaded portrait without creating a replacement sheet, and rejects a missing required presenter image", async () => {
    const portrait = { ...presenter, referenceImages: [], sourceReferenceImages: ["/api/files/portrait.png"] };
    useTidewe(true, portrait);
    expect((await POST(request({ provider: "openai" }))).status).toBe(200);
    expect(state.generateImage.mock.calls[0][0].referenceImageUrls).toEqual([portrait.sourceReferenceImages[0], productImage]);
    state.generateImage.mockClear();
    state.toRemoteUsableImage.mockImplementation(async (value: unknown) => value === portrait.sourceReferenceImages[0] ? undefined : value);
    const response = await POST(request({ provider: "openai" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "TIDEWE_REFERENCE_UNAVAILABLE" });
    expect(state.generateImage).not.toHaveBeenCalled();
  });
  it("rejects a single-reference adapter when the shot needs both presenter and product", async () => {
    useTidewe(true, presenter);
    const response = await POST(request({ provider: "replicate" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "TIDEWE_PRESENTER_REFERENCE_UNSUPPORTED" });
    expect(state.generateImage).not.toHaveBeenCalled();
  });
  it.each([true, false])("binds references according to productVisible=%s and ignores browser prompt controls", async (productVisible) => {
    const shot = useTidewe(productVisible);
    const response = await POST(request({ prompt: "A Chinese host speaking in a bedroom.", imageUrl: "https://example.test/forged.png", imageUrls: ["https://example.test/forged.png"], options: { extra: { prompt: "forged" }, negativePrompt: "forged" } }));
    expect(response.status).toBe(200);
    const generated = state.generateImage.mock.calls[0][0];
    expect(generated.prompt).toContain(`本镜画面：${shot.description}`);
    expect(generated.prompt).toContain(shot.visualIntent);
    expect(generated.prompt).not.toContain("Chinese host");
    expect(generated.prompt).not.toContain(shot.voiceover);
    expect(generated.negativePrompt).toBe(compileTideweVisualPrompt(shot, "image", "on_camera").negativePrompt);
    expect(generated.prompt).toContain("嘴部清晰可见");
    expect(generated.extra).toBeUndefined();
    expect(generated.mode).toBe(productVisible ? "image-to-image" : "text-to-image");
    expect(generated.referenceImageUrl).toBe(productVisible ? productImage : undefined);
    expect(generated.referenceImageUrls).toEqual(productVisible ? [productImage] : undefined);
  });
  it("rejects missing product references and canonical copy drift before calling the image provider", async () => {
    const shot = useTidewe(true);
    db.update(schema.projects).set({ productImages: [] }).run();
    expect((await POST(request())).status).toBe(400);
    db.update(schema.projects).set({ productImages: [productImage] }).run();
    db.update(schema.scripts).set({ shots: [{ ...shot, voiceover: "A different sentence." }] }).run();
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "TIDEWE_SCRIPT_INVALID" });
    expect(state.generateImage).not.toHaveBeenCalled();
  });
  it("does not silently fall back to unreferenced product generation when saved images cannot be prepared", async () => {
    useTidewe(true);
    state.toRemoteUsableImage.mockResolvedValue(undefined);
    const response = await POST(request());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "TIDEWE_PRODUCT_REFERENCE_UNAVAILABLE" });
    expect(state.createProvider).not.toHaveBeenCalled();
  });
});
