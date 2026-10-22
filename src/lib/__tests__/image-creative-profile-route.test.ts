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
} from "@/lib/creative-profiles";
import { PREMIUM_CG_IMAGE_NEGATIVE_PROMPT } from "@/lib/premium-cg-prompt";

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
      prompt: expect.stringContaining("do not generate added on-screen text"),
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
    expect(options.prompt).toContain("do not generate added on-screen text");
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
