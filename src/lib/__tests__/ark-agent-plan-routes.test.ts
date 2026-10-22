// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ARK_AGENT_PLAN_BASE_URL } from "@/lib/ark-config";
import { buildVideoOptions } from "@/lib/gen-params";
import { buildVideoControlPlan } from "@/lib/video-control-plan";

const tasks = vi.hoisted(() => ({
  recordAiTask: vi.fn(),
  updateAiTask: vi.fn(),
  updateAiTaskByProviderTaskId: vi.fn(),
}));
vi.mock("@/lib/ai-tasks", () => tasks);
vi.mock("@/lib/remote-image", () => ({
  toRemoteUsableImage: async (url?: string) => url,
  resolveUploadFilePath: () => null,
}));

import { POST as catalog } from "@/app/api/ai/models/route";
import { POST as generate } from "@/app/api/ai/video/route";
import { POST as resume } from "@/app/api/ai/video/task/route";

function request(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/ai", { method: "POST", body: JSON.stringify(body) });
}

function json(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  tasks.recordAiTask.mockResolvedValue("local-task");
});
afterEach(() => vi.unstubAllGlobals());

it("serves the AgentPlan video catalog using the configured base URL", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const response = await catalog(request({ providers: [{ name: "volcengine", apiKey: "test-plan-key", baseUrl: `${ARK_AGENT_PLAN_BASE_URL}/` }] }));
  const body = await response.json();
  expect(body.models.map((model: { id: string }) => model.id)).toEqual([
    "doubao-seedance-2.5", "doubao-seedance-2.0", "doubao-seedance-2.0-fast", "doubao-seedance-2.0-mini",
  ]);
  expect(body.providers).toEqual(expect.arrayContaining([
    expect.objectContaining({ mediaType: "video", status: "ready", count: 4 }),
    expect.objectContaining({ mediaType: "image", status: "empty", count: 0 }),
  ]));
  expect(fetchMock).not.toHaveBeenCalled();
});

it("submits image-to-video through AgentPlan, saves the task before polling, and returns its video", async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") return json({ id: "cgt-plan-video" });
    expect(tasks.recordAiTask).toHaveBeenCalledWith(expect.objectContaining({
      provider: "volcengine", taskId: "cgt-plan-video", model: "doubao-seedance-2.0", mode: "image-to-video",
    }));
    return json({ id: "cgt-plan-video", model: "doubao-seedance-2.0", status: "succeeded", content: { video_url: "https://cdn.example.com/video.mp4" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const response = await generate(request({
    provider: "volcengine", apiKey: "test-plan-key", baseUrl: `${ARK_AGENT_PLAN_BASE_URL}/`,
    model: "doubao-seedance-2-0-260128", prompt: "A red ball rolls across a table.", imageUrl: "https://cdn.example.com/first.png",
    options: buildVideoOptions({ aspectRatio: "16:9", resolution: "480p", duration: 4 }),
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ taskId: "cgt-plan-video", modelId: "doubao-seedance-2.0", videoUrls: ["https://cdn.example.com/video.mp4"] });
  expect(fetchMock.mock.calls).toHaveLength(2);
  expect(fetchMock.mock.calls[0][0]).toBe(`${ARK_AGENT_PLAN_BASE_URL}/contents/generations/tasks`);
  expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer test-plan-key" });
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
    model: "doubao-seedance-2.0", duration: 4, ratio: "16:9", resolution: "480p",
    content: [
      { type: "text", text: "A red ball rolls across a table." },
      { type: "image_url", image_url: { url: "https://cdn.example.com/first.png" }, role: "first_frame" },
    ],
  });
  expect(fetchMock.mock.calls[1][0]).toBe(`${ARK_AGENT_PLAN_BASE_URL}/contents/generations/tasks/cgt-plan-video`);
  expect(tasks.updateAiTask).toHaveBeenCalledWith("local-task", expect.objectContaining({ status: "completed" }));
});

it("resumes a paid AgentPlan task through the plan endpoint without submitting again", async () => {
  const fetchMock = vi.fn().mockResolvedValue(json({ id: "existing-plan-task", model: "doubao-seedance-2.5", status: "succeeded", content: { video_url: "https://cdn.example.com/existing.mp4" } }));
  vi.stubGlobal("fetch", fetchMock);
  const response = await resume(request({ provider: "volcengine", apiKey: "test-plan-key", baseUrl: `${ARK_AGENT_PLAN_BASE_URL}/`, taskId: "existing-plan-task" }));
  expect(await response.json()).toMatchObject({ taskId: "existing-plan-task", status: "completed", videoUrls: ["https://cdn.example.com/existing.mp4"] });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe(`${ARK_AGENT_PLAN_BASE_URL}/contents/generations/tasks/existing-plan-task`);
  expect(fetchMock.mock.calls[0][1].method).toBe("GET");
  expect(tasks.recordAiTask).not.toHaveBeenCalled();
  expect(tasks.updateAiTaskByProviderTaskId).toHaveBeenCalledWith("volcengine", "existing-plan-task", expect.objectContaining({ status: "completed" }));
});

it.each(["current", "legacy"])("submits %s product-fidelity and pin-frame input without mixing Ark content modes", async (client) => {
  const plan = buildVideoControlPlan({
    provider: "volcengine", modelId: "doubao-seedance-2.5", locale: "en",
    firstFrameUrl: "https://cdn.example.com/first.png", lastFrameUrl: "https://cdn.example.com/last.png",
    productReferenceUrl: "https://cdn.example.com/product.png",
  });
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const content = JSON.parse(String(init.body)).content as Array<{ role?: string; image_url?: { url: string } }>;
      // Reproduce the upstream compatibility rule: the regression is a failing
      // submission, so validate the actual request emitted by the real provider.
      expect(content.some((item) => item.role === "first_frame" || item.role === "last_frame")).toBe(false);
      expect(content.filter((item) => item.role === "reference_image").map((item) => item.image_url?.url)).toEqual([
        "https://cdn.example.com/first.png", "https://cdn.example.com/last.png", "https://cdn.example.com/product.png",
      ]);
      return json({ id: "cgt-compatible-input" });
    }
    return json({ id: "cgt-compatible-input", model: "doubao-seedance-2.5", status: "succeeded", content: { video_url: "https://cdn.example.com/video.mp4" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const response = await generate(request({
    provider: "volcengine", apiKey: "test-plan-key", baseUrl: ARK_AGENT_PLAN_BASE_URL, model: "doubao-seedance-2.5",
    prompt: `Preserve the product. ${plan.promptSuffix}`,
    ...(client === "legacy" ? {
      mode: "image-to-video", imageUrl: "https://cdn.example.com/first.png", lastImageUrl: "https://cdn.example.com/last.png",
      referenceImageUrls: ["https://cdn.example.com/product.png"],
    } : {
      mode: plan.mode, imageUrl: plan.firstFrameUrl, lastImageUrl: plan.lastFrameUrl,
      referenceImageUrls: plan.referenceInputs.filter((item) => item.mediaType === "image").map((item) => item.url),
    }),
    options: buildVideoOptions({ aspectRatio: "16:9", resolution: "480p", duration: 4 }),
  }));
  expect(response.status).toBe(200);
  expect((await response.json()).videoUrls).toEqual(["https://cdn.example.com/video.mp4"]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(plan.warnings).toContain("last-frame-as-reference");
});
