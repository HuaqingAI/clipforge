// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CHARACTER_REFERENCE_IMAGES } from "@/lib/character-reference";

const provider = vi.hoisted(() => ({ generateImage: vi.fn(), create: vi.fn() }));
vi.mock("@/lib/providers", () => ({ createProvider: provider.create }));

import { POST } from "@/app/api/characters/sheet/route";

// Real PNG fixtures exercise /api/files -> disk -> Base64 conversion; only the
// external generation call is mocked so no paid image requests are submitted.
const frontPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlAAAAABJRU5ErkJggg==", "base64");
const sidePng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const frontUrl = "/api/files/characters/front.png";
const sideUrl = "/api/files/characters/side.png";
const dataUri = (image: Buffer) => `data:image/png;base64,${image.toString("base64")}`;
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "clipforge-character-sheet-"));
  vi.stubEnv("APP_DATA_DIR", directory);
  await mkdir(join(directory, "uploads", "characters"), { recursive: true });
  await writeFile(join(directory, "uploads", "characters", "front.png"), frontPng);
  await writeFile(join(directory, "uploads", "characters", "side.png"), sidePng);
});

beforeEach(() => {
  provider.generateImage.mockReset().mockResolvedValue({ imageUrls: [dataUri(frontPng)] });
  provider.create.mockReset().mockReturnValue({ generateImage: provider.generateImage });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function request(extra: Record<string, unknown> = {}) {
  return POST(new NextRequest("http://localhost/api/characters/sheet", {
    method: "POST",
    body: JSON.stringify({
      appearance: "woman wearing a blue shirt", name: "Mei", provider: "atlas-cloud",
      model: "openai/gpt-image-2", apiKey: "test-key", ...extra,
    }),
  }));
}

describe("character sheet image inputs", () => {
  it.each([undefined, []].map((referenceImageUrls) => ({ referenceImageUrls })))("keeps text generation when reference images are $referenceImageUrls", async ({ referenceImageUrls }) => {
    const response = await request({ referenceImageUrls, options: { referenceImageUrl: sideUrl, referenceImageUrls: [sideUrl] } });
    expect(response.status).toBe(200);
    expect(provider.generateImage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      modelId: "openai/gpt-image-2", mode: "text-to-image",
      referenceImageUrl: undefined, referenceImageUrls: undefined,
    }));
    const result = await response.json();
    expect(await readFile(join(directory, "uploads", result.url.replace("/api/files/", "")))).toEqual(frontPng);
  });

  it("requires either an appearance or reference images before creating the provider", async () => {
    const response = await request({ appearance: " ", referenceImageUrls: [] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("参考图") });
    expect(provider.create).not.toHaveBeenCalled();
  });

  it("uses one uploaded photo for an edit even without a text appearance", async () => {
    const response = await request({ appearance: undefined, referenceImageUrls: [frontUrl] });
    expect(response.status).toBe(200);
    expect(provider.generateImage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      modelId: "openai/gpt-image-2/edit", mode: "image-to-image",
      referenceImageUrl: dataUri(frontPng), referenceImageUrls: [dataUri(frontPng)],
      prompt: expect.stringContaining("All 1 input reference images show the SAME person"),
    }));
  });

  it("reads and forwards every uploaded photo in its original order", async () => {
    const response = await request({ referenceImageUrls: [sideUrl, frontUrl], options: { referenceImageUrl: "https://wrong.example/wrong.png" } });
    expect(response.status).toBe(200);
    expect(provider.generateImage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      modelId: "openai/gpt-image-2/edit", mode: "image-to-image",
      referenceImageUrl: dataUri(sidePng), referenceImageUrls: [dataUri(sidePng), dataUri(frontPng)],
      prompt: expect.stringContaining("All 2 input reference images show the SAME person"),
    }));
  });

  it("accepts the maximum reference count without dropping any image", async () => {
    const references = Array.from({ length: MAX_CHARACTER_REFERENCE_IMAGES }, (_, index) => index % 2 ? sideUrl : frontUrl);
    const response = await request({ referenceImageUrls: references });
    expect(response.status).toBe(200);
    expect(provider.generateImage.mock.calls[0][0].referenceImageUrls).toEqual(references.map((_, index) => dataUri(index % 2 ? sidePng : frontPng)));
  });

  it("passes through public and data images without changing reference order", async () => {
    const references = ["https://images.example/person.png", dataUri(sidePng)];
    const response = await request({ referenceImageUrls: references });
    expect(response.status).toBe(200);
    expect(provider.generateImage.mock.calls[0][0].referenceImageUrls).toEqual(references);
  });

  it.each([
    ["openai", "gpt-image-2.5-flare", "gpt-image-2.5-flare"],
    ["openai", "gpt-image-2.5-sunburst", "gpt-image-2.5-sunburst"],
    ["fal-ai", "openai/gpt-image-2", "openai/gpt-image-2/image-to-image"],
    ["fal-ai", "fal-ai/gpt-image-1.5", "fal-ai/gpt-image-1.5/edit"],
    ["fal-ai", "fal-ai/bytedance/seedream/v5/lite/edit", "fal-ai/bytedance/seedream/v5/lite/edit"],
    ["atlas-cloud", "openai/gpt-image-2/text-to-image", "openai/gpt-image-2/edit"],
    ["volcengine", "doubao-seedream-5-0-260128", "doubao-seedream-5-0-260128"],
  ])("selects the reference endpoint for %s / %s and retains all portraits", async (providerName, model, expectedModel) => {
    const response = await request({ provider: providerName, model, referenceImageUrls: [frontUrl, sideUrl] });
    expect(response.status).toBe(200);
    expect(provider.generateImage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      modelId: expectedModel, mode: "image-to-image",
      referenceImageUrls: [dataUri(frontPng), dataUri(sidePng)], referenceImageUrl: dataUri(frontPng),
    }));
  });

  it.each([
    ["openai", "dall-e-3"],
    ["openai", "dall-e-2"],
    ["fal-ai", "fal-ai/flux/dev"],
    ["atlas-cloud", "bytedance/seedream-v5.0-lite"],
    ["replicate", "black-forest-labs/flux-kontext-pro"],
    ["alibaba", "wanx2.1-t2i-turbo"],
    ["siliconflow", "black-forest-labs/FLUX.1-schnell"],
  ])("rejects %s / %s before generation when it cannot retain every reference", async (providerName, model) => {
    const response = await request({ provider: providerName, model, referenceImageUrls: [frontUrl, sideUrl] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("更换支持") });
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.generateImage).not.toHaveBeenCalled();
  });

  it("allows DALL·E 2 with exactly one uploaded portrait", async () => {
    const response = await request({ provider: "openai", model: "dall-e-2", referenceImageUrls: [frontUrl] });
    expect(response.status).toBe(200);
    expect(provider.generateImage.mock.calls[0][0]).toMatchObject({
      modelId: "dall-e-2", mode: "image-to-image", referenceImageUrls: [dataUri(frontPng)],
    });
  });

  it("prevents advanced options from replacing the verified model, prompt or portraits", async () => {
    const response = await request({ referenceImageUrls: [frontUrl, sideUrl], options: {
      mode: "text-to-image", modelId: "wrong", prompt: "Generate a new face",
      extra: { model: "wrong", prompt: "wrong", images: ["wrong"], image_urls: ["wrong"], image: "wrong", ref_img: "wrong", quality: "high" },
    } });
    expect(response.status).toBe(200);
    expect(provider.generateImage.mock.calls[0][0]).toMatchObject({
      modelId: "openai/gpt-image-2/edit", mode: "image-to-image",
      referenceImageUrls: [dataUri(frontPng), dataUri(sidePng)],
      prompt: expect.stringContaining("All 2 input reference images"), extra: { quality: "high" },
    });
    expect(provider.generateImage.mock.calls[0][0].extra).toEqual({ quality: "high" });
  });

  it.each([
    null,
    frontUrl,
    [null],
    [false],
    [123],
    [""],
    ["   "],
    Array.from({ length: MAX_CHARACTER_REFERENCE_IMAGES + 1 }, () => frontUrl),
  ].map((referenceImageUrls) => ({ referenceImageUrls })))("rejects malformed reference input $referenceImageUrls without generating", async ({ referenceImageUrls }) => {
    const response = await request({ referenceImageUrls });
    expect(response.status).toBe(400);
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.generateImage).not.toHaveBeenCalled();
  });

  it.each([
    ["/api/files/characters/missing.png"],
    [frontUrl, "/api/files/characters/missing.png"],
    ["/api/files/characters"], // directory exists, but cannot be read as an image
    ["/api/files/../../outside.png"],
    ["file:///C:/person.png"],
    ["data:image/png;base64,"],
    ["data:text/plain;base64,aGVsbG8="],
  ].map((referenceImageUrls) => ({ referenceImageUrls })))("rejects unavailable images $referenceImageUrls instead of dropping them or generating a new face", async ({ referenceImageUrls }) => {
    const response = await request({ referenceImageUrls });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("参考图不可用") });
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.generateImage).not.toHaveBeenCalled();
  });
});
