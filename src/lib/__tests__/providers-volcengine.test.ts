// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { VolcEngineProvider } from "@/lib/providers/volcengine";
import { buildImageOptions } from "@/lib/gen-params";
import type { VideoOptions } from "@/lib/providers/types";
import {
  ARK_AGENT_PLAN_BASE_URL,
  ARK_STANDARD_BASE_URL,
  isArkAgentPlanBase,
  normalizeArkBaseUrl,
} from "@/lib/ark-config";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const planModelIds = [
  "doubao-seedance-2.5",
  "doubao-seedance-2.0",
  "doubao-seedance-2.0-fast",
  "doubao-seedance-2.0-mini",
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

it("normalizes Ark base URLs and recognizes AgentPlan on proxy hosts", () => {
  expect(normalizeArkBaseUrl()).toBe(ARK_STANDARD_BASE_URL);
  expect(normalizeArkBaseUrl("  ")).toBe(ARK_STANDARD_BASE_URL);
  expect(normalizeArkBaseUrl(`  ${ARK_AGENT_PLAN_BASE_URL}///  `)).toBe(ARK_AGENT_PLAN_BASE_URL);
  expect(isArkAgentPlanBase(`${ARK_AGENT_PLAN_BASE_URL}/`)).toBe(true);
  expect(isArkAgentPlanBase("https://proxy.example.com/api/plan/v3/")).toBe(true);
  expect(isArkAgentPlanBase(ARK_STANDARD_BASE_URL)).toBe(false);
  expect(isArkAgentPlanBase("https://proxy.example.com/api/plan/v30")).toBe(false);
  expect(isArkAgentPlanBase("invalid-url")).toBe(false);
});

it("lists the four verified AgentPlan aliases without advertising image access", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const provider = new VolcEngineProvider({ name: "volcengine", apiKey: "plan-test-key", baseUrl: `${ARK_AGENT_PLAN_BASE_URL}/` });
  const models = await provider.listModels();
  expect(models.map((model) => model.id)).toEqual(planModelIds);
  expect(models.every((model) => model.mediaType === "video" && model.provider === "volcengine")).toBe(true);
  expect(await provider.listModels("video")).toEqual(models);
  expect(await provider.listModels("image")).toEqual([]);
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each(planModelIds)("submits %s to the normalized AgentPlan task endpoint with Bearer auth", async (modelId) => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "cgt-plan-task" }));
  vi.stubGlobal("fetch", fetchMock);
  const provider = new VolcEngineProvider({ name: "volcengine", apiKey: "plan-test-key", baseUrl: `  ${ARK_AGENT_PLAN_BASE_URL}/  ` });
  const result = await provider.submitVideoTask({
    modelId,
    mode: "text-to-video",
    prompt: "A red ball on a table",
    duration: 4,
    width: 854,
    height: 480,
    audioEnabled: true,
    seed: 42,
  });

  expect(result).toEqual({ taskId: "cgt-plan-task", modelId });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe(`${ARK_AGENT_PLAN_BASE_URL}/contents/generations/tasks`);
  expect(init.method).toBe("POST");
  expect(init.headers).toMatchObject({ Authorization: "Bearer plan-test-key", "Content-Type": "application/json" });
  expect(JSON.parse(init.body)).toEqual({
    model: modelId,
    content: [{ type: "text", text: "A red ball on a table" }],
    duration: 4,
    resolution: "480p",
    ratio: "16:9",
    generate_audio: true,
    watermark: false,
    return_last_frame: true,
    seed: 42,
  });
});

it.each([
  ["doubao-seedance-2-5-260628", "doubao-seedance-2.5"],
  ["doubao-seedance-2-0-260128", "doubao-seedance-2.0"],
  ["doubao-seedance-2-0-fast-260128", "doubao-seedance-2.0-fast"],
  ["doubao-seedance-2-0-mini-260128", "doubao-seedance-2.0-mini"],
  ["ep-custom-model", "ep-custom-model"],
])("maps a persisted selection %s to %s only for AgentPlan", async (modelId, expectedModelId) => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "cgt-plan-task" }));
  vi.stubGlobal("fetch", fetchMock);
  const provider = new VolcEngineProvider({ name: "volcengine", apiKey: "plan-test-key", baseUrl: "https://proxy.example.com/api/plan/v3/" });
  const result = await provider.submitVideoTask({ modelId, mode: "text-to-video", prompt: "test" });
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe(expectedModelId);
  expect(result.modelId).toBe(expectedModelId);
  expect(fetchMock.mock.calls[0][0]).toBe("https://proxy.example.com/api/plan/v3/contents/generations/tasks");
});

it.each([
  [ARK_AGENT_PLAN_BASE_URL, "doubao-seedance-2.0"],
  [ARK_STANDARD_BASE_URL, "doubao-seedance-2-0-260128"],
])("uses reference roles exclusively for mixed frames and product references at %s", async (baseUrl, modelId) => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "cgt-plan-task" }));
  vi.stubGlobal("fetch", fetchMock);
  const provider = new VolcEngineProvider({ name: "volcengine", apiKey: "plan-test-key", baseUrl });
  await provider.submitVideoTask({
    modelId,
    mode: "image-to-video",
    prompt: "Walk forward",
    firstFrameUrl: "https://example.com/first.png",
    lastFrameUrl: "https://example.com/last.png",
    referenceImageUrls: ["https://example.com/reference.png"],
    width: 720,
    height: 1280,
    seed: "" as unknown as number,
    extra: { resolution: "480p", seed: "" },
  });
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body).toMatchObject({ resolution: "480p", ratio: "9:16", content: [
    { type: "text", text: "Walk forward" },
    { type: "image_url", image_url: { url: "https://example.com/first.png" }, role: "reference_image" },
    { type: "image_url", image_url: { url: "https://example.com/last.png" }, role: "reference_image" },
    { type: "image_url", image_url: { url: "https://example.com/reference.png" }, role: "reference_image" },
  ] });
  expect(body).not.toHaveProperty("seed");
  expect(body.return_last_frame).toBe(true);
});

it("keeps native first/last-frame roles when there are no references", async () => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "cgt-frame-task" }));
  vi.stubGlobal("fetch", fetchMock);
  const provider = new VolcEngineProvider({ name: "volcengine", apiKey: "test-key", baseUrl: ARK_AGENT_PLAN_BASE_URL });
  await provider.submitVideoTask({
    modelId: "doubao-seedance-2.5", mode: "image-to-video", prompt: "A smooth transition",
    firstFrameUrl: "https://example.com/first.png", lastFrameUrl: "https://example.com/last.png",
  });
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.content.map((item: { role?: string }) => item.role).filter(Boolean)).toEqual(["first_frame", "last_frame"]);
});

it.each(["video", "audio"])("converts frame images to references when a %s reference is present", async (media) => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "cgt-reference-task" }));
  vi.stubGlobal("fetch", fetchMock);
  const provider = new VolcEngineProvider({ name: "volcengine", apiKey: "test-key", baseUrl: ARK_AGENT_PLAN_BASE_URL });
  await provider.submitVideoTask({
    modelId: "doubao-seedance-2.5", mode: "image-to-video", prompt: "Match the reference",
    firstFrameUrl: "https://example.com/first.png", lastFrameUrl: "https://example.com/last.png",
    ...(media === "video" ? { referenceVideoUrls: ["https://example.com/ref.mp4"] } : { referenceAudioUrls: ["https://example.com/ref.wav"] }),
  });
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.content.slice(1, 3).map((item: { role: string }) => item.role)).toEqual(["reference_image", "reference_image"]);
  expect(body.content[3].role).toBe(`reference_${media}`);
});

it("rejects an oversized converted reference pack before creating a paid task", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const provider = new VolcEngineProvider({ name: "volcengine", apiKey: "test-key", baseUrl: ARK_AGENT_PLAN_BASE_URL });
  await expect(provider.submitVideoTask({
    modelId: "doubao-seedance-2.5", mode: "image-to-video", prompt: "Keep the product",
    firstFrameUrl: "https://example.com/first.png", lastFrameUrl: "https://example.com/last.png",
    referenceImageUrls: Array.from({ length: 8 }, (_, i) => `https://example.com/ref-${i}.png`),
  })).rejects.toMatchObject({ code: "TOO_MANY_REFERENCE_IMAGES" });
  expect(fetchMock).not.toHaveBeenCalled();
});

it("does not let extra.content reintroduce incompatible frame/reference roles", async () => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "cgt-reference-task" }));
  vi.stubGlobal("fetch", fetchMock);
  const provider = new VolcEngineProvider({ name: "volcengine", apiKey: "test-key", baseUrl: ARK_AGENT_PLAN_BASE_URL });
  await provider.submitVideoTask({
    modelId: "doubao-seedance-2.5", mode: "image-to-video", prompt: "Keep the product",
    firstFrameUrl: "https://example.com/first.png", referenceImageUrls: ["https://example.com/product.png"],
    extra: { content: [{ type: "image_url", image_url: { url: "https://example.com/last.png" }, role: "last_frame" }] },
  });
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.content).toEqual([
    { type: "text", text: "Keep the product" },
    { type: "image_url", image_url: { url: "https://example.com/first.png" }, role: "reference_image" },
    { type: "image_url", image_url: { url: "https://example.com/product.png" }, role: "reference_image" },
  ]);
});

it("polls an existing AgentPlan task through completion and returns video/audio/last-frame metadata", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ id: "cgt-plan-task", status: "queued" }))
    .mockResolvedValueOnce(jsonResponse({ id: "cgt-plan-task", status: "running" }))
    .mockResolvedValueOnce(jsonResponse({
      id: "cgt-plan-task", model: "doubao-seedance-2.0", status: "succeeded", generate_audio: true,
      content: { video_url: "https://cdn.example.com/video.mp4", last_frame_url: "https://cdn.example.com/last.png" },
    }));
  vi.stubGlobal("fetch", fetchMock);
  const provider = new VolcEngineProvider({ name: "volcengine", apiKey: "plan-test-key", baseUrl: `${ARK_AGENT_PLAN_BASE_URL}/` });
  const result = await provider.waitForTask("cgt-plan-task", { interval: 0, maxAttempts: 3 });
  expect(result).toEqual({
    taskId: "cgt-plan-task", status: "completed", result: {
      taskId: "cgt-plan-task", modelId: "doubao-seedance-2.0", videoUrls: ["https://cdn.example.com/video.mp4"],
      hasAudio: true, lastFrameUrl: "https://cdn.example.com/last.png",
    },
  });
  expect(fetchMock).toHaveBeenCalledTimes(3);
  for (const [url, init] of fetchMock.mock.calls) {
    expect(url).toBe(`${ARK_AGENT_PLAN_BASE_URL}/contents/generations/tasks/cgt-plan-task`);
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer plan-test-key");
    expect(init.body).toBeUndefined();
  }
});

it("does not resubmit an AgentPlan paid task on server failure", async () => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { message: "Request id: ark-plan-50" } }, 500));
  vi.stubGlobal("fetch", fetchMock);
  const provider = new VolcEngineProvider({ name: "volcengine", apiKey: "plan-test-key", baseUrl: ARK_AGENT_PLAN_BASE_URL });
  await expect(provider.submitVideoTask({ modelId: "doubao-seedance-2.0", prompt: "test", mode: "text-to-video" }))
    .rejects.toMatchObject({ statusCode: 500, message: expect.stringContaining("ark-plan-50") });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each([ARK_AGENT_PLAN_BASE_URL, ARK_STANDARD_BASE_URL])("locates a rejected real-person reference on %s without resubmitting", async (baseUrl) => {
  const code = "InputImageSensitiveContentDetected.PrivacyInformation";
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: {
    code, message: "The input image content[1] may contain a real person. Request id: ark-privacy-001",
    param: "content[1]", type: "BadRequest",
  } }, 400));
  vi.stubGlobal("fetch", fetchMock);
  const provider = new VolcEngineProvider({ name: "volcengine", apiKey: "plan-test-key", baseUrl });
  const error = await provider.submitVideoTask({
    modelId: "doubao-seedance-2.5", mode: "video-to-video", prompt: "A product demonstration",
    referenceImageUrls: ["https://cdn.example.com/presenter.png", "https://cdn.example.com/shot-1.png"],
  }).catch((failure) => failure);
  expect(error).toMatchObject({
    code, provider: "volcengine", statusCode: 400, requestId: "ark-privacy-001",
    param: "content[1]", contentIndex: 1, referenceImageNumber: 1, inputRole: "reference_image",
  });
  expect(error.message).toContain("第 1 张输入图片（content[1]，参考图）");
  expect(error.message).toContain("可能包含真人肖像");
  expect(error.message).toContain(code);
  expect(error.message).toContain("ark-privacy-001");
  expect(error.message).not.toContain("https://cdn.example.com");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe(`${baseUrl}/contents/generations/tasks`);
});

it.each([
  [{ firstFrameUrl: "https://cdn.example.com/first.png" }, 1, 1, "first_frame", "首帧图"],
  [{ firstFrameUrl: "https://cdn.example.com/first.png", lastFrameUrl: "https://cdn.example.com/last.png" }, 2, 2, "last_frame", "尾帧图"],
  [{ referenceImageUrls: ["https://cdn.example.com/one.png", "https://cdn.example.com/two.png"] }, 2, 2, "reference_image", "参考图"],
  [{ firstFrameUrl: "https://cdn.example.com/first.png", lastFrameUrl: "https://cdn.example.com/last.png", referenceImageUrls: ["https://cdn.example.com/product.png"] }, 3, 3, "reference_image", "参考图"],
] as const)("maps content index to the actual image and protocol role: %j", async (inputs, index, imageNumber, role, label) => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ request_id: "ark-image-order", error: {
    code: "InputImageSensitiveContentDetected.PrivacyInformation",
    message: "The input image may contain a real person.", param: `content[${index}].image_url`,
  } }, 400));
  vi.stubGlobal("fetch", fetchMock);
  const provider = new VolcEngineProvider({ name: "volcengine", apiKey: "test-key", baseUrl: ARK_AGENT_PLAN_BASE_URL });
  const error = await provider.submitVideoTask({
    modelId: "doubao-seedance-2.5", mode: "image-to-video", prompt: "Product view", ...inputs,
  } as VideoOptions).catch((failure) => failure);
  expect(error).toMatchObject({
    contentIndex: index, referenceImageNumber: imageNumber, inputRole: role,
    requestId: "ark-image-order", param: `content[${index}].image_url`,
  });
  expect(error.message).toContain(`第 ${imageNumber} 张输入图片（content[${index}]，${label}）`);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).content[index].role).toBe(role);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("preserves the platform rejection when its content index cannot be matched to an input", async () => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: {
    code: "InputImageSensitiveContentDetected.PrivacyInformation", message: "Private information in content[99].",
    requestId: "ark-unmatched-index",
  } }, 400));
  vi.stubGlobal("fetch", fetchMock);
  const provider = new VolcEngineProvider({ name: "volcengine", apiKey: "test-key", baseUrl: ARK_AGENT_PLAN_BASE_URL });
  const error = await provider.submitVideoTask({
    modelId: "doubao-seedance-2.5", mode: "image-to-video", prompt: "Product view", firstFrameUrl: "https://cdn.example.com/first.png",
  }).catch((failure) => failure);
  expect(error).toMatchObject({ requestId: "ark-unmatched-index", contentIndex: 99 });
  expect(error.referenceImageNumber).toBeUndefined();
  expect(error.inputRole).toBeUndefined();
  expect(error.message).toContain("输入图片（content[99]）");
  expect(error.message).toContain("可能包含隐私内容");
  expect(error.message).not.toContain("真人肖像");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each([
  { error: { code: "InvalidParameter", message: "Unsupported resolution", param: "resolution" } },
  "not-json",
])("keeps unrelated and malformed HTTP errors unchanged: %j", async (response) => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(response, 400));
  vi.stubGlobal("fetch", fetchMock);
  const provider = new VolcEngineProvider({ name: "volcengine", apiKey: "test-key", baseUrl: ARK_AGENT_PLAN_BASE_URL });
  const error = await provider.submitVideoTask({ modelId: "doubao-seedance-2.5", mode: "text-to-video", prompt: "Product view" })
    .catch((failure) => failure);
  expect(error).toMatchObject({ code: "API_ERROR", statusCode: 400 });
  expect(error.contentIndex).toBeUndefined();
  expect(error.message).toContain(JSON.stringify(response));
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("keeps standard Ark model IDs, task routing and image catalog", async () => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "cgt-standard-task" }));
  vi.stubGlobal("fetch", fetchMock);
  const provider = new VolcEngineProvider({ name: "volcengine", apiKey: "standard-test-key", baseUrl: "" });
  const modelId = "doubao-seedance-2-0-260128";
  const result = await provider.submitVideoTask({ modelId, prompt: "test", mode: "text-to-video", width: 1080, height: 1920 });
  expect(result.modelId).toBe(modelId);
  expect(fetchMock.mock.calls[0][0]).toBe(`${ARK_STANDARD_BASE_URL}/contents/generations/tasks`);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ model: modelId, resolution: "1080p", ratio: "9:16" });
  expect((await provider.listModels("image")).map((model) => model.id)).toContain("doubao-seedream-4-0-250828");
  expect((await provider.listModels("video")).map((model) => model.id)).toContain(modelId);
});

it("按方舟图片协议发送多张参考图，并丢弃历史设置里的空 seed", async () => {
  let requestBody: Record<string, unknown> | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ data: [{ url: "https://cdn.example.com/grid.png" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );

  const provider = new VolcEngineProvider({ name: "volcengine", apiKey: "test-key", baseUrl: "http://ark.test/v3" });
  const result = await provider.generateImage({
    modelId: "doubao-seedream-4-0-250828",
    mode: "image-to-image",
    prompt: "3x3 storyboard",
    width: 1080,
    height: 1920,
    referenceImageUrls: ["data:image/png;base64,one", "data:image/png;base64,two"],
    seed: "" as unknown as number,
    extra: { seed: "" },
  });

  expect(result.imageUrls).toEqual(["https://cdn.example.com/grid.png"]);
  expect(requestBody).toMatchObject({
    model: "doubao-seedream-4-0-250828",
    size: "2K",
    image: ["data:image/png;base64,one", "data:image/png;base64,two"],
  });
  expect(requestBody).not.toHaveProperty("seed");
});

it("构造图片参数时清洗旧版本持久化的空数字", () => {
  const options = buildImageOptions({
    aspectRatio: "9:16",
    count: "" as unknown as number,
    steps: "" as unknown as number,
    guidanceScale: Number.NaN,
    seed: "" as unknown as number,
  });

  expect(options).toMatchObject({ width: 1080, height: 1920, count: 1 });
  expect(options).not.toHaveProperty("steps");
  expect(options).not.toHaveProperty("guidanceScale");
  expect(options).not.toHaveProperty("seed");
});
