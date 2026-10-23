import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchVideoPrompt } from "@/lib/video-prompt-client";
import type { VideoPromptRequest } from "@/lib/video-prompt-request";

const request: VideoPromptRequest = {
  scriptId: "script-1", shotId: 1, provider: "kling-cli", model: "account-model",
  settings: { visualLook: "none", motionIntensity: "normal", motionRealism: "auto" },
  generateAudio: false,
};
const prompt = "Approved shot direction: 产品完整入画。\n\nPreserve markings; no added text.\n";
const response = {
  prompt, negativePrompt: "added text", contextKey: "server-context", scriptId: "script-1", shotId: 1,
  settings: request.settings,
  controlPlan: { version: 1, strategy: "keyframe", mode: "image-to-video", referenceRoles: [], referenceCount: 0, audioMode: "none", voiceoverBound: false, warnings: [], referenceInputs: [], promptSuffix: "" },
};

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("backend video prompt transport", () => {
  it("preserves the backend text exactly, including mixed languages, blank lines and trailing newline", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(response));
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchVideoPrompt("project-1", request);
    expect(result.prompt).toBe(prompt);
    expect(result.promptContext).toEqual({ ...request, contextKey: "server-context" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/project/project-1/video-prompt");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(request);
  });

  it("surfaces backend errors and refuses an incomplete preview", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "当前脚本已改变" }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ ...response, contextKey: undefined }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchVideoPrompt("project-1", request)).rejects.toThrow("当前脚本已改变");
    await expect(fetchVideoPrompt("project-1", request)).rejects.toThrow("后端未返回有效的视频提示词");
  });

  it.each(["fetch", "body"])("releases a stalled %s even when the transport ignores abort", async (stage) => {
    vi.useFakeTimers();
    const stalled = new Promise<Response>(() => {});
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => new Promise(() => {}) });
    if (stage === "fetch") fetchMock.mockReturnValue(stalled);
    vi.stubGlobal("fetch", fetchMock);
    const pending = fetchVideoPrompt("project-1", request);
    const assertion = expect(pending).rejects.toThrow("读取视频提示词超时");
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
