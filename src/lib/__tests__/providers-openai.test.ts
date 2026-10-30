// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { deflateSync } from "node:zlib";
import { OpenAIProvider } from "@/lib/providers/openai";

const baseUrl = "https://images.example.com/v1";
const presenter = `data:image/png;base64,${Buffer.from("presenter").toString("base64")}`;
const product = `data:image/jpeg;base64,${Buffer.from("product").toString("base64")}`;
const imageModels = ["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function provider(configuredBase = baseUrl) {
  return new OpenAIProvider({ name: "openai", apiKey: "image-test-key", baseUrl: configuredBase });
}

function mockImageResponse() {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    created: 123,
    data: [{ b64_json: "generated-image" }],
  }), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function pngFixture(width = 2, height = 2, alpha = true): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = alpha ? 6 : 2;
  const channels = alpha ? 4 : 3;
  const raw = Buffer.alloc((width * channels + 1) * height, 0);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * channels + 1) + 1 + x * channels;
    raw[offset] = 120; raw[offset + 1] = 140; raw[offset + 2] = 160;
    if (alpha) raw[offset + 3] = x === 0 ? 0 : 255;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const pngUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString("base64")}`;

describe("OpenAI explicit image output controls", () => {
  it.each(["text-to-image", "image-to-image"] as const)("sends explicit Sunburst quality and format in %s without allowing extra to override them", async mode => {
    const fetchMock = mockImageResponse();
    await provider().generateImage({
      modelId: "gpt-image-2.5-sunburst", mode, prompt: "Resolve the existing grass", quality: "xhigh", outputFormat: "png",
      ...(mode === "image-to-image" && { referenceImageUrls: [presenter] }),
      extra: { quality: "low", output_format: "jpeg" },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = fetchMock.mock.calls[0][1].body;
    if (mode === "image-to-image") {
      const form = body as FormData;
      expect(form.getAll("quality")).toEqual(["xhigh"]);
      expect(form.getAll("output_format")).toEqual(["png"]);
      expect(form.has("outputFormat")).toBe(false);
      expect(form.getAll("image[]")).toHaveLength(1);
    } else {
      expect(JSON.parse(body)).toMatchObject({ quality: "xhigh", output_format: "png" });
      expect(JSON.parse(body)).not.toHaveProperty("outputFormat");
    }
  });

  it.each(["text-to-image", "image-to-image"] as const)("keeps both fields absent by default in %s", async mode => {
    const fetchMock = mockImageResponse();
    await provider().generateImage({ modelId: "gpt-image-2.5-sunburst", mode, prompt: "Ground texture", ...(mode === "image-to-image" && { referenceImageUrls: [presenter] }) });
    const body = fetchMock.mock.calls[0][1].body;
    if (mode === "image-to-image") {
      expect((body as FormData).has("quality")).toBe(false);
      expect((body as FormData).has("output_format")).toBe(false);
    } else {
      expect(JSON.parse(body)).not.toHaveProperty("quality");
      expect(JSON.parse(body)).not.toHaveProperty("output_format");
    }
  });

  it.each(["auto", "low", "medium", "high"] as const)("forwards the explicit %s quality on older GPT Image models", async quality => {
    const fetchMock = mockImageResponse();
    await provider().generateImage({ modelId: "gpt-image-1.5", mode: "image-to-image", prompt: "Ground texture", referenceImageUrl: presenter, quality, outputFormat: "webp" });
    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(form.get("quality")).toBe(quality);
    expect(form.get("output_format")).toBe("webp");
  });

  it.each([
    { modelId: "dall-e-2", mode: "image-to-image" as const },
    { modelId: "dall-e-2", mode: "text-to-image" as const },
    { modelId: "dall-e-3", mode: "text-to-image" as const },
  ])("ignores unsupported new controls for legacy $modelId $mode", async ({ modelId, mode }) => {
    const fetchMock = mockImageResponse();
    await provider().generateImage({ modelId, mode, prompt: "Ground texture", quality: "xhigh", outputFormat: "png", ...(mode === "image-to-image" && { referenceImageUrl: presenter }) });
    const body = fetchMock.mock.calls[0][1].body;
    if (mode === "image-to-image") {
      expect((body as FormData).has("quality")).toBe(false);
      expect((body as FormData).has("output_format")).toBe(false);
    } else {
      expect(JSON.parse(body)).not.toHaveProperty("quality");
      expect(JSON.parse(body)).not.toHaveProperty("output_format");
    }
  });

  it("retains the existing DALL·E 3 extra quality contract", async () => {
    const fetchMock = mockImageResponse();
    await provider().generateImage({ modelId: "dall-e-3", mode: "text-to-image", prompt: "Ground texture", extra: { quality: "hd" } });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).quality).toBe("hd");
  });

  it.each(["text-to-image", "image-to-image"] as const)("rejects unsupported xhigh quality before HTTP in %s", async mode => {
    const fetchMock = mockImageResponse();
    await expect(provider().generateImage({ modelId: "gpt-image-1.5", mode, prompt: "Ground texture", quality: "xhigh", ...(mode === "image-to-image" && { referenceImageUrl: "https://reference.example.test/image.png" }) })).rejects.toMatchObject({ code: "IMAGE_QUALITY_UNSUPPORTED", submissionRejected: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["jpeg", "webp"] as const)("uses the reported %s MIME for base64 output", async outputFormat => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ output_format: outputFormat, data: [{ b64_json: "generated-image" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await provider().generateImage({ modelId: "gpt-image-2.5-flare", mode: "text-to-image", prompt: "Ground texture", outputFormat });
    expect(result.imageUrls).toEqual([`data:image/${outputFormat};base64,generated-image`]);
  });
});

describe("OpenAI explicit edit masks", () => {
  const source = pngFixture();
  const mask = pngFixture();
  const edit = { modelId: "gpt-image-2.5-sunburst", mode: "image-to-image" as const, prompt: "Repair the selected foreground", referenceImageUrls: [pngUrl(source), product], maskImageUrl: pngUrl(mask) };

  it.each(["gpt-image-1-mini", "gpt-image-1.5", "gpt-image-2", "gpt-image-2-2026-04-21", "gpt-image-2.5-sunburst", "gpt-image-2.5-sunburst-2026-09-08", "gpt-image-2.5-flare", "gpt-image-2.5-flare-2026-09-08", "chatgpt-image-latest"])("uploads an explicit alpha PNG mask for supported %s edits", async (modelId) => {
    const fetchMock = mockImageResponse();
    await provider().generateImage({ ...edit, modelId, extra: { mask: "untrusted-mask", image: "untrusted-source", prompt: "untrusted-prompt" } });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe(`${baseUrl}/images/edits`);
    const form = request.body as FormData;
    const uploadedMask = form.get("mask") as File;
    expect(uploadedMask.name).toBe("mask.png");
    expect(uploadedMask.type).toBe("image/png");
    expect(Buffer.from(await uploadedMask.arrayBuffer())).toEqual(mask);
    const images = form.getAll("image[]") as Blob[];
    expect(images).toHaveLength(2);
    expect(Buffer.from(await images[0].arrayBuffer())).toEqual(source);
    expect(await images[1].text()).toBe("product");
    expect(form.get("prompt")).toBe(edit.prompt);
    expect(form.get("model")).toBe(modelId);
  });

  it("uses the first source dimensions while retaining differently sized additional references", async () => {
    const fetchMock = mockImageResponse();
    await provider().generateImage({ ...edit, referenceImageUrls: [pngUrl(source), pngUrl(pngFixture(3, 4))] });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[0][1].body as FormData).getAll("image[]")).toHaveLength(2);
  });

  it("fetches the explicit mask URL before submitting its PNG bytes", async () => {
    const maskUrl = "https://reference.example.test/mask.png";
    const fetchMock = vi.fn().mockImplementation(async (url: string) => url === maskUrl
      ? new Response(new Uint8Array(mask), { headers: { "content-type": "image/png" } })
      : Response.json({ data: [{ b64_json: "generated-image" }] }));
    vi.stubGlobal("fetch", fetchMock);
    await provider().generateImage({ ...edit, maskImageUrl: maskUrl });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([maskUrl, `${baseUrl}/images/edits`]);
    expect(Buffer.from(await (fetchMock.mock.calls[1][1].body.get("mask") as Blob).arrayBuffer())).toEqual(mask);
  });

  it.each(["dall-e-2", "dall-e-3", "custom/model", "gpt-image-2-unrecognized", "gpt-image-1"])("rejects unsupported mask model %s before any HTTP request", async (modelId) => {
    const fetchMock = mockImageResponse();
    await expect(provider().generateImage({ ...edit, modelId })).rejects.toMatchObject({ code: "MASK_MODEL_UNSUPPORTED", submissionRejected: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a mask without a source even in text-to-image mode", async () => {
    const fetchMock = mockImageResponse();
    await expect(provider().generateImage({ ...edit, mode: "text-to-image", referenceImageUrls: [] })).rejects.toMatchObject({ code: "MASK_SOURCE_REQUIRED", submissionRejected: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: "empty URL", maskImageUrl: "", code: "BAD_MASK" },
    { name: "non-PNG image", maskImageUrl: product, code: "BAD_MASK" },
    { name: "PNG without alpha", maskImageUrl: pngUrl(pngFixture(2, 2, false)), code: "BAD_MASK" },
    { name: "truncated PNG", maskImageUrl: pngUrl(mask.subarray(0, 33)), code: "BAD_MASK" },
    { name: "mismatching dimensions", maskImageUrl: pngUrl(pngFixture(3, 2)), code: "MASK_DIMENSIONS_MISMATCH" },
    { name: "4 MiB boundary", maskImageUrl: pngUrl(Buffer.concat([mask, Buffer.alloc(4 * 1024 * 1024 - mask.length)])), code: "MASK_TOO_LARGE" },
  ])("rejects $name before the paid HTTP request", async ({ maskImageUrl, code }) => {
    const fetchMock = mockImageResponse();
    await expect(provider().generateImage({ ...edit, maskImageUrl })).rejects.toMatchObject({ code, submissionRejected: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explicitly rejects a non-PNG first source only when a mask is requested", async () => {
    const fetchMock = mockImageResponse();
    await expect(provider().generateImage({ ...edit, referenceImageUrls: [product, pngUrl(source)] })).rejects.toMatchObject({ code: "MASK_SOURCE_UNSUPPORTED", message: expect.stringContaining("PNG 源图"), submissionRejected: true });
    expect(fetchMock).not.toHaveBeenCalled();
    await provider().generateImage({ ...edit, referenceImageUrls: [product], maskImageUrl: undefined });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[0][1].body as FormData).has("mask")).toBe(false);
  });

  it.each(["network", "404", "body"])("rejects a %s mask download failure before the paid POST", async (scenario) => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      if (scenario === "network") throw new TypeError("Mask connection failed");
      if (scenario === "404") return new Response("Missing", { status: 404 });
      return { ok: true, blob: async () => { throw new TypeError("Mask body interrupted"); } };
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(provider().generateImage({ ...edit, maskImageUrl: "https://reference.example.test/mask.png" })).rejects.toMatchObject({ submissionRejected: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]).toEqual(["https://reference.example.test/mask.png"]);
  });

  it.each([400, 429])("never retries an upstream HTTP %i mask rejection", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: { message: "mask rejected" } }, { status }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(provider().generateImage(edit)).rejects.toMatchObject({ code: "API_ERROR", statusCode: status, submissionRejected: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[0][1].body as FormData).has("mask")).toBe(true);
  });
});

describe("OpenAI image reference contract", () => {
  it.each(imageModels.flatMap((modelId) => (["text-to-image", "image-to-image"] as const)
    .map((mode) => ({ modelId, mode }))))("uploads ordered references as image[] for $modelId in $mode mode", async ({ modelId, mode }) => {
    const fetchMock = mockImageResponse();
    const result = await provider().generateImage({
      modelId, mode, prompt: "Keep the presenter and product consistent", width: 1080, height: 1920,
      referenceImageUrls: [presenter, product],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${baseUrl}/images/edits`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: "Bearer image-test-key" });
    const form = init.body as FormData;
    const images = form.getAll("image[]") as Blob[];
    expect(await Promise.all(images.map((image) => image.text()))).toEqual(["presenter", "product"]);
    expect(images.map((image) => image.type)).toEqual(["image/png", "image/jpeg"]);
    expect(form.has("image")).toBe(false);
    expect(form.get("model")).toBe(modelId);
    expect(form.get("size")).toBe("864x1536");
    expect(form.has("response_format")).toBe(false);
    expect(result.modelId).toBe(modelId);
    expect(result.imageUrls).toEqual(["data:image/png;base64,generated-image"]);
  });

  it("prefers the ordered reference array over a legacy single reference", async () => {
    const fetchMock = mockImageResponse();
    await provider().generateImage({
      modelId: "gpt-image-1.5", mode: "image-to-image", prompt: "Use all supplied references",
      referenceImageUrl: presenter, referenceImageUrls: [product, presenter],
    });
    const images = (fetchMock.mock.calls[0][1].body as FormData).getAll("image[]") as Blob[];
    expect(await Promise.all(images.map((image) => image.text()))).toEqual(["product", "presenter"]);
  });

  it.each([undefined, [], ["", "   "]])("falls back to the single reference when the array is %j", async (referenceImageUrls) => {
    const fetchMock = mockImageResponse();
    await provider().generateImage({
      modelId: "gpt-image-2", mode: "text-to-image", prompt: "Retain the product",
      referenceImageUrl: product, referenceImageUrls,
    });
    expect(fetchMock.mock.calls[0][0]).toBe(`${baseUrl}/images/edits`);
    const images = (fetchMock.mock.calls[0][1].body as FormData).getAll("image[]") as Blob[];
    expect(await Promise.all(images.map((image) => image.text()))).toEqual(["product"]);
  });

  it.each(imageModels)("keeps %s text-to-image generation on the JSON endpoint", async (modelId) => {
    const fetchMock = mockImageResponse();
    const result = await provider().generateImage({ modelId, mode: "text-to-image", prompt: "A sofa", width: 1080, height: 1920 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${baseUrl}/images/generations`);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: modelId, prompt: "A sofa", size: "864x1536" });
    expect(body).not.toHaveProperty("response_format");
    expect(result.modelId).toBe(modelId);
  });

  it("reports missing references before sending an image edit", async () => {
    const fetchMock = mockImageResponse();
    await expect(provider().generateImage({
      modelId: "gpt-image-2", mode: "image-to-image", prompt: "A sofa", referenceImageUrls: ["", " "],
    })).rejects.toMatchObject({ code: "BAD_REFERENCE", message: "图生图缺少参考图", submissionRejected: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains the DALL·E 2 single-image multipart contract", async () => {
    const fetchMock = mockImageResponse();
    await provider().generateImage({
      modelId: "dall-e-2", mode: "image-to-image", prompt: "A sofa", referenceImageUrl: product, count: 3,
    });
    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(await (form.get("image") as Blob).text()).toBe("product");
    expect(form.has("image[]")).toBe(false);
    expect(form.get("n")).toBe("1");
    expect(form.get("response_format")).toBe("url");
  });

  it("rejects multiple DALL·E 2 references without silently dropping a product or presenter", async () => {
    const fetchMock = mockImageResponse();
    await expect(provider().generateImage({
      modelId: "dall-e-2", mode: "image-to-image", prompt: "A sofa", referenceImageUrls: [presenter, product],
    })).rejects.toMatchObject({ code: "NOT_SUPPORTED", submissionRejected: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects DALL·E 3 edits when references arrive through the array", async () => {
    const fetchMock = mockImageResponse();
    await expect(provider().generateImage({
      modelId: "dall-e-3", mode: "text-to-image", prompt: "A sofa", referenceImageUrls: [product],
    })).rejects.toMatchObject({ code: "NOT_SUPPORTED", submissionRejected: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("OpenAI image canvas resolution", () => {
  it.each(imageModels.flatMap((modelId) => (["text-to-image", "image-to-image"] as const)
    .map((mode) => ({ modelId, mode }))))("sends a native 4K portrait canvas for $modelId in $mode mode", async ({ modelId, mode }) => {
    const fetchMock = mockImageResponse();
    await provider().generateImage({
      modelId, mode, prompt: "A detailed 3x3 storyboard", width: 2160, height: 3840, imageResolution: "4k",
      ...(mode === "image-to-image" && { referenceImageUrls: [product] }),
    });
    const body = fetchMock.mock.calls[0][1].body;
    if (mode === "image-to-image") {
      expect((body as FormData).get("size")).toBe("2160x3840");
      expect((body as FormData).has("imageResolution")).toBe(false);
    } else {
      expect(JSON.parse(body)).toMatchObject({ size: "2160x3840" });
      expect(JSON.parse(body)).not.toHaveProperty("imageResolution");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps exact 9:16 proportions when opting into the 2K tier", async () => {
    const fetchMock = mockImageResponse();
    await provider().generateImage({
      modelId: "gpt-image-2", mode: "text-to-image", prompt: "A storyboard", width: 1080, height: 1920, imageResolution: "2k",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).size).toBe("1152x2048");
  });

  it("limits a large square canvas by total pixels as well as its longest edge", async () => {
    const fetchMock = mockImageResponse();
    await provider().generateImage({
      modelId: "gpt-image-2", mode: "text-to-image", prompt: "A square storyboard", width: 3840, height: 3840, imageResolution: "4k",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).size).toBe("2880x2880");
  });

  it.each(["text-to-image", "image-to-image"] as const)("retains the existing standard canvas in %s mode", async (mode) => {
    const fetchMock = mockImageResponse();
    await provider().generateImage({
      modelId: "gpt-image-2", mode, prompt: "A storyboard", width: 1080, height: 1920, imageResolution: "standard",
      ...(mode === "image-to-image" && { referenceImageUrls: [product] }),
    });
    const body = fetchMock.mock.calls[0][1].body;
    expect(mode === "image-to-image" ? (body as FormData).get("size") : JSON.parse(body).size).toBe("864x1536");
  });

  it.each([[999, 1234], [17, 17], [9999, 101], [100, 9999], [8000, 5000], [2222, 3701]])(
    "adapts an unusual %i x %i request to the documented image limits", async (width, height) => {
      const fetchMock = mockImageResponse();
      await provider().generateImage({
        modelId: "gpt-image-2", mode: "text-to-image", prompt: "A storyboard", width, height, imageResolution: "4k",
      });
      const [w, h] = JSON.parse(fetchMock.mock.calls[0][1].body).size.split("x").map(Number);
      expect(w % 16).toBe(0);
      expect(h % 16).toBe(0);
      expect(Math.max(w, h)).toBeLessThanOrEqual(3840);
      expect(Math.max(w, h) / Math.min(w, h)).toBeLessThanOrEqual(3);
      expect(w * h).toBeGreaterThanOrEqual(655360);
      expect(w * h).toBeLessThanOrEqual(8294400);
    }
  );

  it("retains older models' supported size presets with the high-resolution option", async () => {
    const fetchMock = mockImageResponse();
    await provider().generateImage({
      modelId: "gpt-image-1.5", mode: "text-to-image", prompt: "A storyboard", width: 2160, height: 3840, imageResolution: "4k",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).size).toBe("1024x1536");
  });

  it.each(([undefined, "standard", "2k", "4k"] as const).flatMap((imageResolution) =>
    (["text-to-image", "image-to-image"] as const).map((mode) => ({ imageResolution, mode }))))(
    "allows additional generation time only for an explicit $imageResolution canvas in $mode mode", async ({ imageResolution, mode }) => {
      const fetchMock = mockImageResponse();
      const timer = vi.spyOn(globalThis, "setTimeout");
      await provider().generateImage({
        modelId: "gpt-image-2", mode, prompt: "A storyboard", width: 2160, height: 3840, imageResolution,
        ...(mode === "image-to-image" && { referenceImageUrls: [product] }),
      });
      const timeout = imageResolution === "2k" || imageResolution === "4k" ? 300000 : 120000;
      expect(timer).toHaveBeenCalledWith(expect.any(Function), timeout);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );
});

describe("OpenAI image API transport", () => {
  const edit = { modelId: "gpt-image-2", mode: "image-to-image" as const, prompt: "A sofa", referenceImageUrls: [presenter, product] };

  it.each([400, 401, 403, 429].flatMap((status) => [
    { status, body: JSON.stringify({ error: { message: "Rejected before processing" } }), contentType: "application/json" },
    { status, body: "<html>Request rejected</html>", contentType: "text/html" },
  ]))("preserves definite HTTP $status rejection with $contentType and never repeats the edit", async ({ status, body, contentType }) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status, headers: { "Content-Type": contentType } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(provider().generateImage(edit)).rejects.toMatchObject({ submissionRejected: true, statusCode: status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
  });

  it.each([
    { status: 500, body: JSON.stringify({ error: { message: "Internal error" } }) },
    { status: 503, body: "<html>Gateway unavailable</html>" },
    { status: 200, body: "Invalid JSON after generation" },
    { status: 200, body: JSON.stringify({ created: 123, data: [] }) },
  ])("keeps HTTP $status malformed or unsuccessful paid responses ambiguous", async ({ status, body }) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status }));
    vi.stubGlobal("fetch", fetchMock);
    const failure = await provider().generateImage(edit).catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.submissionRejected).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([new TypeError("Connection reset after POST"), new DOMException("Timed out", "AbortError")])("does not classify a paid transport interruption as a rejection: %s", async (failure) => {
    const fetchMock = vi.fn().mockRejectedValue(failure); vi.stubGlobal("fetch", fetchMock);
    const error = await provider().generateImage(edit).catch((value) => value);
    expect(error.submissionRejected).not.toBe(true);
    expect(error.code).toBe(failure.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["network", "download", "body"])("marks a reference %s failure as unsubmitted because the paid POST has not started", async (scenario) => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      if (scenario === "network") throw new TypeError("Reference connection failed");
      if (scenario === "download") return new Response("Missing reference", { status: 404 });
      return { ok: true, blob: async () => { throw new TypeError("Reference body interrupted"); } };
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(provider().generateImage({ ...edit, referenceImageUrls: ["https://reference.example.test/image.png"] })).rejects.toMatchObject({ code: "BAD_REFERENCE", submissionRejected: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual(["https://reference.example.test/image.png"]);
  });

  it.each([
    ["  https://images.example.com/v1///  ", "https://images.example.com/v1"],
    ["https://images.example.com/v1/images/edits/", "https://images.example.com/v1"],
    ["https://images.example.com/v1/images/generations", "https://images.example.com/v1"],
    ["https://images.example.com/custom/proxy/v1/images/edits", "https://images.example.com/custom/proxy/v1"],
    ["https://hth.huaqing.run", "https://hth.huaqing.run/v1"],
  ])("normalizes %s and submits a single edit to its API base", async (configuredBase, expectedBase) => {
    const fetchMock = mockImageResponse();
    await provider(configuredBase).generateImage(edit);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${expectedBase}/images/edits`);
    const images = (fetchMock.mock.calls[0][1].body as FormData).getAll("image[]") as Blob[];
    expect(await Promise.all(images.map((image) => image.text()))).toEqual(["presenter", "product"]);
  });

  it.each([200, 404])("classifies HTTP %i HTML as an invalid API response without leaking the page or retrying", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("<!doctype html><html><body>PRIVATE PAGE CONTENT</body></html>", {
      status, headers: { "Content-Type": "text/html; charset=utf-8" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const error = await provider().generateImage(edit).catch((failure) => failure);
    expect(error).toMatchObject({ code: "INVALID_RESPONSE", statusCode: status, provider: "openai" });
    expect(error.message).toContain(`HTTP ${status}`);
    expect(error.message).toContain("text/html");
    expect(error.message).toContain("服务返回 HTML 网页");
    expect(error.message).toContain(`${baseUrl}/images/edits`);
    expect(error.message).toContain("Base URL");
    expect(error.message).toContain("支持 POST /images/edits");
    expect(error.message).not.toContain("PRIVATE PAGE CONTENT");
    expect(error.message).not.toContain("网络请求异常");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["{ broken json", "服务返回的内容不是有效 JSON"],
    ["", "服务返回空响应"],
  ])("classifies malformed or empty successful responses without a network error: %j", async (body, message) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const error = await provider().generateImage(edit).catch((failure) => failure);
    expect(error).toMatchObject({ code: "INVALID_RESPONSE", statusCode: 200 });
    expect(error.message).toContain(message);
    expect(error.message).not.toContain("网络请求异常");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("recognizes an HTML document even when its content type incorrectly says JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("  <!DOCTYPE html><html>secret page</html>", {
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(provider().generateImage(edit)).rejects.toMatchObject({
      code: "INVALID_RESPONSE", message: expect.stringContaining("服务返回 HTML 网页"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["text/plain", "text/html", undefined])("accepts valid image JSON with content type %s", async (contentType) => {
    const response = new Response(JSON.stringify({ created: 123, data: [{ b64_json: "generated-image" }] }));
    if (contentType) response.headers.set("content-type", contentType);
    else response.headers.delete("content-type");
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    await expect(provider().generateImage(edit)).resolves.toMatchObject({ imageUrls: ["data:image/png;base64,generated-image"] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps non-success JSON API error details", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "image model is unavailable" } }), {
      status: 400, headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(provider().generateImage(edit)).rejects.toMatchObject({
      code: "API_ERROR", statusCode: 400, message: expect.stringContaining("image model is unavailable"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("omits URL user credentials and query parameters from invalid-response diagnostics", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("<html>private gateway page</html>", {
      headers: { "Content-Type": "text/html" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const error = await provider("https://gateway-user:gateway-password@images.example.com/v1?api_key=private-query-value")
      .generateImage(edit).catch((failure) => failure);
    expect(error).toMatchObject({ code: "INVALID_RESPONSE" });
    expect(error.message).toContain("https://images.example.com/v1");
    expect(error.message).not.toMatch(/gateway-user|gateway-password|api_key|private-query-value|private gateway page/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
