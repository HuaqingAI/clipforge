// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as schema from "@/lib/db/schema";
import {
  createCreativeProfileSnapshot,
  createPremiumProductCgProfile,
  createTideweOutdoorProfile,
} from "@/lib/creative-profiles";
import { PREMIUM_CG_IMAGE_NEGATIVE_PROMPT } from "@/lib/premium-cg-prompt";
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
const profile = createPremiumProductCgProfile({ narrationMode: "none" });
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
    name: "Premium image policy",
    creativeProfile: profile,
    creativeConfigRevision: 2,
    productImages: [productImage],
  }).run();
  db.insert(schema.scripts).values({
    id: scriptId,
    projectId,
    selected: true,
    styleType: "premium_product_cg",
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

describe("premium image generation profile context", () => {
  it("uses the persisted CG profile instead of a client-provided sales profile or controlled options", async () => {
    const response = await POST(request({
      creativeProfile: { creationType: "short_video_sales", styleType: "pain_point" },
      prompt: "Add a flashing SALE card and tell viewers to buy now.",
      options: {
        modelId: "forged-model",
        mode: "image-to-image",
        prompt: "forged prompt",
        negativePrompt: "keep-this-negative",
        negative_prompt: "keep-this-negative-alias",
      },
    }));

    expect(response.status).toBe(200);
    const generated = state.generateImage.mock.calls[0][0];
    expect(generated).toMatchObject({
      modelId: "image-model",
      mode: "image-to-image",
      prompt: expect.stringMatching(/do not generate added on-screen text/i),
      negativePrompt: PREMIUM_CG_IMAGE_NEGATIVE_PROMPT,
      referenceImageUrl: productImage,
    });
    expect(generated.prompt).toContain(shot.description);
    expect(generated.prompt).toContain(shot.camera);
    expect(generated.prompt).not.toContain("forged prompt");
    expect(generated.prompt).not.toContain("flashing SALE");
    expect(generated.negativePrompt).not.toContain("keep-this-negative");
  });

  it("uses the approved stored shot when a premium CG browser request omits prompt", async () => {
    const response = await POST(request({ prompt: undefined }));

    expect(response.status).toBe(200);
    const generated = state.generateImage.mock.calls[0][0];
    expect(generated.prompt).toContain(shot.description);
    expect(generated.prompt).toContain(shot.camera);
    expect(generated.negativePrompt).toBe(PREMIUM_CG_IMAGE_NEGATIVE_PROMPT);
  });

  it("drops nested provider extras that could override the compiled premium CG prompt or inputs", async () => {
    const response = await POST(request({
      options: {
        width: 1024,
        extra: {
          prompt: "Add a flashing SALE price and buy-now caption.",
          image: "https://example.test/forged-reference.png",
          reference_images: ["https://example.test/forged-reference.png"],
          mode: "image-to-image",
        },
      },
    }));

    expect(response.status).toBe(200);
    expect(state.generateImage).toHaveBeenCalledTimes(1);
    const options = state.generateImage.mock.calls[0][0];
    expect(options).toMatchObject({ width: 1024, mode: "image-to-image", referenceImageUrl: productImage });
    expect(options.prompt).toMatch(/do not generate added on-screen text/i);
    expect(options.prompt).not.toContain("flashing SALE");
    expect(options.extra).toBeUndefined();
  });

  it("requires a project-owned product reference before premium CG image generation", async () => {
    db.update(schema.projects).set({ productImages: [] }).where(eq(schema.projects.id, projectId)).run();

    const response = await POST(request());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "PREMIUM_CG_PRODUCT_REFERENCE_REQUIRED" });
    expect(state.createProvider).not.toHaveBeenCalled();
    expect(state.generateImage).not.toHaveBeenCalled();
  });

  it("rejects a client reference that is not one of the project's saved product images", async () => {
    const response = await POST(request({ imageUrl: "https://example.test/legacy-sales-frame.png" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "PREMIUM_CG_PRODUCT_REFERENCE_INVALID" });
    expect(state.createProvider).not.toHaveBeenCalled();
    expect(state.generateImage).not.toHaveBeenCalled();
  });

  it("keeps a singular product reference for providers when the caller supplies only imageUrls", async () => {
    const response = await POST(request({ imageUrls: [productImage] }));

    expect(response.status).toBe(200);
    expect(state.generateImage).toHaveBeenCalledWith(expect.objectContaining({
      mode: "image-to-image",
      referenceImageUrl: productImage,
      referenceImageUrls: [productImage],
    }));
  });

  it("rejects a premium CG request when its persisted product reference cannot be prepared", async () => {
    state.toRemoteUsableImage.mockResolvedValue(undefined);

    const response = await POST(request());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "PREMIUM_CG_PRODUCT_REFERENCE_UNAVAILABLE" });
    expect(state.createProvider).not.toHaveBeenCalled();
    expect(state.generateImage).not.toHaveBeenCalled();
  });

  it("rejects a current script whose creative configuration snapshot is stale before billing", async () => {
    db.update(schema.scripts)
      .set({ creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1) })
      .where(eq(schema.scripts.id, scriptId))
      .run();

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "CREATIVE_CONFIG_STALE",
      projectRevision: 2,
      scriptRevision: 1,
    });
    expect(state.generateImage).not.toHaveBeenCalled();
  });

  it("rejects an image request after the selected script has changed", async () => {
    const response = await POST(request({ scriptId: "different-script" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "SCRIPT_CONTEXT_CHANGED" });
    expect(state.generateImage).not.toHaveBeenCalled();
  });

  it("rejects a CG script with a persisted text overlay before image generation", async () => {
    db.update(schema.scripts)
      .set({
        shots: [{
          ...shot,
          textOverlay: { text: "SALE", style: "title" },
        }],
      })
      .where(eq(schema.scripts.id, scriptId))
      .run();

    const response = await POST(request());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "CREATIVE_POLICY_VIOLATION",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "text_overlay", field: "textOverlay" }),
      ]),
    });
    expect(state.generateImage).not.toHaveBeenCalled();
  });
});
