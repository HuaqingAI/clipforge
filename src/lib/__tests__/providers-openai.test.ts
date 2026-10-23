// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
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
    })).rejects.toMatchObject({ code: "BAD_REFERENCE", message: "图生图缺少参考图" });
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
    })).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects DALL·E 3 edits when references arrive through the array", async () => {
    const fetchMock = mockImageResponse();
    await expect(provider().generateImage({
      modelId: "dall-e-3", mode: "text-to-image", prompt: "A sofa", referenceImageUrls: [product],
    })).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
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
