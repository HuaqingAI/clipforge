// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ provider: vi.fn(), image: vi.fn(), upload: vi.fn(), generate: vi.fn() }));
vi.mock("@/lib/providers", () => ({ createProvider: mocks.provider }));
vi.mock("@/lib/remote-image", () => ({ toRemoteUsableImage: mocks.image, resolveUploadFilePath: () => "/fixture/reference.mp4" }));
vi.mock("@/lib/ai-tasks", () => ({ recordAiTask: vi.fn(), updateAiTask: vi.fn() }));
vi.mock("@/lib/kling/jobs", () => ({ createKlingJob: vi.fn() }));
vi.mock("@/lib/kling/repository", () => ({ klingJobView: vi.fn() }));

import { POST } from "@/app/api/ai/video/route";

const request = (overrides: Record<string, unknown> = {}) => new NextRequest("http://localhost/api/ai/video", { method: "POST", body: JSON.stringify({ provider: "fixture", model: "video-model", apiKey: "fixture-key", prompt: "商品保持静止。镜头平稳向左横移。", imageUrl: "/api/files/frame.png", referenceVideoUrls: ["/api/files/ref.mp4"], ...overrides }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.provider.mockReturnValue({ generateVideo: mocks.generate, uploadLocalMedia: mocks.upload });
  mocks.image.mockResolvedValue("https://example.test/frame.png");
  mocks.upload.mockResolvedValue("https://example.test/ref.mp4");
  mocks.generate.mockResolvedValue({ videoUrls: ["https://example.test/result.mp4"] });
});

describe("final API video prompt validation", () => {
  it.each([
    ["底部显示“价。", "unclosed_quote"],
    ["固定镜头。镜头向左横移。", "camera_conflict"],
    ["视频全程静音。保留环境音。", "audio_conflict"],
    ["", "empty"],
    ["a".repeat(12_001), "too_long"],
  ])("rejects invalid prompts before provider setup, remote input conversion or uploads", async (prompt, code) => {
    const response = await POST(request({ prompt }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "VIDEO_PROMPT_INVALID", issues: expect.arrayContaining([expect.objectContaining({ code })]) });
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.image).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("does not allow options to replace the reviewed prompt", async () => {
    const response = await POST(request({ options: { prompt: "a different hidden prompt" } }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("不能替换已确认的提示词");
    expect(mocks.provider).not.toHaveBeenCalled();
  });
  it("forwards a valid reviewed prompt exactly and preserves quoted native dialogue", async () => {
    const prompt = "固定镜头。说话人自然说一遍「别忘了保持静音，镜头向左横移」。声音：保持人声清晰。";
    const response = await POST(request({ prompt, options: { audioEnabled: true } }));
    expect(response.status).toBe(200);
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ prompt, audioEnabled: true }));
  });
});
