// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIProvider } from "@/lib/providers/openai";
import { registerProviderGenerationHooks } from "@/lib/provider-generation-hooks";
import type { VideoOptions } from "@/lib/providers/types";

const input: VideoOptions = { modelId: "MiniMax-H3", mode: "image-to-video", prompt: "Steam rises from the soup.", firstFrameUrl: "data:image/png;base64,c291cA==", duration: 4, width: 720, height: 1280 };
const provider = (baseUrl = "https://gateway.example/v1") => new OpenAIProvider({ name: "openai", apiKey: "test-hth-key", baseUrl });
const completed = { task: { id: "task-paid", status: "succeeded", model: "MiniMax-H3", duration: 4, content: { url: "https://cdn.example/soup.mp4" } } };

afterEach(() => {
  registerProviderGenerationHooks({ checkpoint: () => {}, defersPolling: () => false });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("HTH MiniMax-H3 native video contract", () => {
  it.each([
    ["", "https://hth.huaqing.run"],
    ["https://hth.huaqing.run/", "https://hth.huaqing.run"],
    ["https://gateway.example/v1///", "https://gateway.example"],
    ["https://gateway.example/proxy/v1/", "https://gateway.example/proxy"],
    ["https://gateway.example/proxy/", "https://gateway.example/proxy"],
    ["https://gateway.example/proxy/v2/", "https://gateway.example/proxy"],
  ])("submits to the native route from %s while retaining any gateway prefix", async (baseUrl, root) => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ task_id: "task-paid" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(provider(baseUrl).submitVideoTask(input)).resolves.toEqual({ taskId: "task-paid", modelId: "MiniMax-H3" });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${root}/v2/video_generation`, expect.objectContaining({ method: "POST", headers: expect.objectContaining({ Authorization: "Bearer test-hth-key" }) }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      model: "MiniMax-H3", content: [{ type: "text", text: input.prompt }, { type: "image_url", image_url: { url: input.firstFrameUrl }, role: "first_frame" }],
      duration: 4, resolution: "768P", ratio: "adaptive",
    });
  });

  it("sends a real last frame and 2K without transmitting unsupported audio/seed fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ task_id: "task-paid" }));
    vi.stubGlobal("fetch", fetchMock);
    await provider().submitVideoTask({ ...input, lastFrameUrl: "https://images.example/last.png", width: 1440, height: 2560, audioEnabled: false, seed: 42, negativePrompt: "No text", extra: { aigc_watermark: false } });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ resolution: "2K", aigc_watermark: false, content: [expect.anything(), expect.anything(), { type: "image_url", image_url: { url: "https://images.example/last.png" }, role: "last_frame" }] });
    for (const key of ["audio", "generate_audio", "audio_enabled", "seed", "negative_prompt"]) expect(body).not.toHaveProperty(key);
  });

  it("uses the standard 768P tier for an old 1080p preference", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ task_id: "task-paid" }));
    vi.stubGlobal("fetch", fetchMock);
    await provider().submitVideoTask({ ...input, width: 1080, height: 1920 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).resolution).toBe("768P");
  });

  it("maps fractional durations without violating a speech minimum", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ task_id: "task-paid" }));
    vi.stubGlobal("fetch", fetchMock);
    await provider().submitVideoTask({ ...input, duration: 4.4, minimumDuration: 4.4 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).duration).toBe(5);
  });

  it("derives portrait framing for text-to-video", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ task_id: "task-paid" }));
    vi.stubGlobal("fetch", fetchMock);
    await provider().submitVideoTask({ ...input, mode: "text-to-video", firstFrameUrl: undefined });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ ratio: "9:16", content: [{ type: "text", text: input.prompt }] });
  });

  it.each([
    [{ modelId: "sora-2" }, "NOT_SUPPORTED"],
    [{ mode: "image-to-video", firstFrameUrl: undefined }, "BAD_REFERENCE"],
    [{ mode: "text-to-video" }, "MODE_MISMATCH"],
    [{ firstFrameUrl: "/api/files/source.png" }, "BAD_REFERENCE"],
    [{ referenceImageUrls: ["https://example/extra.png"] }, "REFERENCE_MODE_UNSUPPORTED"],
    [{ referenceVideoUrls: ["https://example/ref.mp4"] }, "REFERENCE_MODE_UNSUPPORTED"],
    [{ referenceAudioUrls: ["https://example/ref.mp3"] }, "REFERENCE_MODE_UNSUPPORTED"],
    [{ minimumDuration: 16 }, "MINIMUM_DURATION_UNSUPPORTED"],
    [{ duration: Number.NaN }, "BAD_DURATION"],
    [{ extra: { resolution: "1080P" } }, "BAD_RESOLUTION"],
    [{ extra: { content: "replace the confirmed prompt" } }, "UNSUPPORTED_PARAMETER"],
  ])("rejects invalid or unsupported inputs before creating paid work: %j", async (changes, code) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(provider().submitVideoTask({ ...input, ...changes } as VideoOptions)).rejects.toMatchObject({ code, submissionRejected: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([["queued", "pending"], ["running", "processing"], ["failed", "failed"], ["cancelled", "cancelled"]])("maps native %s tasks to %s", async (native, status) => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ task: { id: "task-paid", status: native, error: { message: "Native error detail" } } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await provider().getTaskStatus("task-paid");
    expect(result).toMatchObject({ taskId: "task-paid", status });
    expect(fetchMock.mock.calls[0][0]).toBe("https://gateway.example/v2/query/video_generation/task-paid");
    if (status === "failed" || status === "cancelled") expect(result.error).toBe("Native error detail");
  });

  it("preserves the completed CDN URL and always-on native audio", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(completed)));
    await expect(provider().getTaskStatus("task-paid")).resolves.toMatchObject({ taskId: "task-paid", status: "completed", result: { taskId: "task-paid", modelId: "MiniMax-H3", duration: 4, videoUrls: ["https://cdn.example/soup.mp4"], hasAudio: true } });
  });

  it("keeps a completed task recoverable when the URL is not ready", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ task: { status: "succeeded", content: {} } })));
    await expect(provider().getTaskStatus("task-paid")).resolves.toEqual({ taskId: "task-paid", status: "completed" });
  });

  it("does not silently accept unknown native statuses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ task: { status: "mystery" } })));
    await expect(provider().getTaskStatus("task-paid")).rejects.toMatchObject({ code: "INVALID_RESPONSE", taskId: "task-paid" });
  });

  it("checkpoints the receipt and defers polling without issuing a second POST", async () => {
    const checkpoint = vi.fn();
    registerProviderGenerationHooks({ checkpoint, defersPolling: () => true });
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ task_id: "task-paid" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(provider().generateVideo(input)).rejects.toMatchObject({ code: "GENERATION_TASK_PENDING", taskId: "task-paid" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-paid", provider: "openai", submissionState: "acknowledged" }));
  });

  it("preserves an acknowledged paid receipt even when submission also contains an error", async () => {
    const checkpoint = vi.fn();
    registerProviderGenerationHooks({ checkpoint, defersPolling: () => false });
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ task_id: "task-paid", error: { type: "server_error", message: "response interrupted" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(provider().submitVideoTask(input)).resolves.toEqual({ taskId: "task-paid", modelId: "MiniMax-H3" });
    expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-paid", submissionState: "acknowledged" }));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("exposes cancelled tasks as terminal when resuming the two-phase API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ task: { status: "cancelled", error: { message: "cancelled by platform" } } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(provider().waitForTask("task-paid")).rejects.toMatchObject({ taskId: "task-paid", code: "TASK_FAILED", message: "cancelled by platform" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("polls a completed generation using only its original receipt", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ task_id: "task-paid" })).mockResolvedValueOnce(Response.json(completed));
    vi.stubGlobal("fetch", fetchMock);
    await expect(provider().generateVideo(input)).resolves.toMatchObject({ taskId: "task-paid", videoUrls: ["https://cdn.example/soup.mp4"], hasAudio: true });
    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(["POST", "GET"]);
  });

  it.each(["network", "500", "missing receipt"])("never retries an ambiguous %s submission", async (failure) => {
    const fetchMock = vi.fn();
    if (failure === "network") fetchMock.mockRejectedValue(new TypeError("connection closed"));
    else fetchMock.mockResolvedValue(failure === "500" ? Response.json({ error: { message: "upstream interrupted" } }, { status: 500 }) : Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    const error = await provider().submitVideoTask(input).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.submissionRejected).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("recognizes an explicit native balance rejection", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: { message: "insufficient balance" } }, { status: 402 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(provider().submitVideoTask(input)).rejects.toMatchObject({ statusCode: 402, submissionRejected: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retains the paid receipt when generation fails after acceptance", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ task_id: "task-paid" })).mockResolvedValueOnce(Response.json({ task: { status: "failed", error: { message: "safety filter" } } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(provider().generateVideo(input)).rejects.toMatchObject({ taskId: "task-paid", code: "TASK_FAILED" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("exposes H3 alongside image models only in the appropriate catalog", async () => {
    expect(await provider().listModels("video")).toEqual([expect.objectContaining({ id: "MiniMax-H3", provider: "openai", modes: ["text-to-video", "image-to-video"], supportsAudio: true })]);
    expect((await provider().listModels("image")).every(model => model.mediaType === "image")).toBe(true);
    expect((await provider().listModels()).some(model => model.id === "MiniMax-H3")).toBe(true);
  });
});
