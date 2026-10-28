import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BatchMotionPanel } from "@/components/batch-motion-panel";
import { VideoGenerationFailure } from "@/components/video-generation-dialog";
import { prepareBatchMotionKling, silentBatchMotionOptions, type BatchMotionDraft, type BatchMotionShot } from "@/lib/batch-motion";
import { DEFAULT_VIDEO_PROMPT_SETTINGS } from "@/lib/shot-video-prompt";
import type { KlingVideoModelDescriptor } from "@/lib/kling/types";

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/lib/kling/client", () => ({ klingFetch: api.request, klingErrorMessage: (body: { error?: string | { message?: string } }, fallback = "Kling 操作失败") => typeof body.error === "string" ? body.error : body.error?.message ?? fallback }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? children : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

const model: KlingVideoModelDescriptor = {
  selectionKey: '["kling-cli","image_to_video","model"]', provider: "kling-cli", profileId: "profile", region: "global", tool: "image_to_video", remoteModelId: "model", displayName: "My model", catalogRevision: "revision", available: true,
  parameters: [{ name: "duration", type: "number", required: true, allowedValues: [5, 10], default: 5 }, { name: "enable_audio", type: "string", required: true, allowedValues: ["true", "false"], default: "true" }],
  inputSlots: [{ name: "image", role: "image", required: true }], capabilities: { image: true, tailFrame: false, multiImage: false, audio: true },
};
const readyProfile = { id: "profile", environmentState: "ready", authState: "authenticated", authRevision: 1, principalKey: "account", catalogRevision: "revision", catalogCheckedAt: 1 };
const status = (overrides: Record<string, unknown> = {}) => ({ configured: true, loggedIn: true, profile: readyProfile, models: [model], concurrency: { active: 0, max: 10, blockedByUnknownSubmission: false }, ...overrides });
const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code });
function shot(shotId: number): BatchMotionShot {
  const asset = { assetId: `asset-${shotId}`, shotId, type: "hook" as const, duration: 6, description: `Product ${shotId}`, prompt: "Static image", visualSource: "ai_generate" as const, status: "done" as const, thumbnailUrl: `/frame-${shotId}.png` };
  const draft: BatchMotionDraft = { asset, prompt: "Camera slowly moves forward. Preserve the product.", promptContext: { scriptId: "script", shotId, provider: "kling-cli", model: model.selectionKey, settings: { ...DEFAULT_VIDEO_PROMPT_SETTINGS }, batch: true, generateAudio: false, contextKey: `server-context-${shotId}` }, firstFrameUrl: `/frame-${shotId}.png`, referenceImages: ["/product.png"], frameChoices: [{ label: "另一个分镜的关键帧", url: "/alternate.png" }], options: { duration: 6, resolution: "720p", audioEnabled: false }, klingParameters: { duration: 6, audioEnabled: true, voiceover: "must never submit", tts: true }, generate: vi.fn().mockResolvedValue(undefined) };
  draft.refreshFrames = vi.fn(async (firstFrameUrl, lastFrameUrl) => ({ ...draft, firstFrameUrl, lastFrameUrl, prompt: `Reviewed frames: ${firstFrameUrl} / ${lastFrameUrl ?? "none"}`, promptContext: { ...draft.promptContext!, contextKey: `review-${firstFrameUrl}-${lastFrameUrl ?? "none"}`, controlInputs: { firstFrameUrl, lastFrameUrl } } }));
  return { asset, draft };
}
let root: Root;
let container: HTMLDivElement;
let shots: BatchMotionShot[];
const refreshTasks = vi.fn().mockResolvedValue(undefined);
const onSubmitted = vi.fn();
const onUncertain = vi.fn();
const onBusyChange = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  shots = [shot(1), shot(2)]; refreshTasks.mockClear(); onSubmitted.mockClear(); onUncertain.mockClear(); onBusyChange.mockClear();
  api.request.mockReset().mockImplementation((url: string, init?: RequestInit) => Promise.resolve(url === "/api/ai/video" ? json({ jobId: `job-${JSON.parse(String(init?.body)).shotId}` }, 202) : json(status())));
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function mount(overrides: Partial<ComponentProps<typeof BatchMotionPanel>> = {}) {
  await act(async () => root.render(<BatchMotionPanel open onOpenChange={() => undefined} projectId="project" scriptId="script" provider="kling-cli" profileId="profile" selectionKey={model.selectionKey} modelLabel="My model" shots={shots} valid onRefreshTasks={refreshTasks} onSubmitted={onSubmitted} onUncertain={onUncertain} onBusyChange={onBusyChange} {...overrides} />));
}
function checkbox(label: string) { return container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement; }
function button(text: string) { return Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.includes(text))!; }
function videoRequests() { return api.request.mock.calls.filter(([url]) => url === "/api/ai/video").map(([, init]) => JSON.parse(init.body)); }
async function confirmAndSubmit() { await act(async () => checkbox("确认批量生成费用").click()); await act(async () => button("确认提交").click()); }

describe("batch shot animation", () => {
  it("selects individual current frames and submits only selected shots after one acknowledgement", async () => {
    shots.push({ ...shot(3), disabledReason: "此分镜已有视频" });
    await mount();
    expect(checkbox("选择分镜 1").checked).toBe(true);
    expect(checkbox("选择分镜 3").disabled).toBe(true);
    expect(button("确认提交").disabled).toBe(true);
    expect(container.querySelectorAll('select[aria-label^="分镜 1 "]')).toHaveLength(2);
    expect((container.querySelector('select[aria-label="分镜 1 首帧"]') as HTMLSelectElement).value).toBe("/frame-1.png");
    expect((container.querySelector('select[aria-label="分镜 1 尾帧"]') as HTMLSelectElement).selectedOptions[0].textContent).toBe("不使用图片");
    expect(container.textContent).not.toMatch(/输入图片[ 1234]/);
    expect(container.textContent).not.toContain("配音设置"); expect(container.textContent).not.toContain("字幕设置");
    await act(async () => checkbox("选择分镜 1").click());
    expect(videoRequests()).toHaveLength(0);
    await confirmAndSubmit();
    expect(videoRequests()).toHaveLength(1);
    expect(videoRequests()[0]).toMatchObject({ shotId: 2, imageUrl: "/frame-2.png", expectedSelectedAssetId: "asset-2", executionScope: "single-shot", selectionKey: model.selectionKey, options: { duration: 6, enable_audio: "false" } });
    expect(videoRequests()[0]).not.toHaveProperty("referenceImageUrls");
    expect(videoRequests()[0]).not.toHaveProperty("lastImageUrl");
    expect(videoRequests()[0].options).not.toHaveProperty("voiceover");
    expect(videoRequests()[0].prompt).toBe(shots[1].draft!.prompt);
    expect(videoRequests()[0].promptContext).toEqual(shots[1].draft!.promptContext);
    expect(onSubmitted).toHaveBeenCalledWith(2, "job-2");
    expect(refreshTasks).toHaveBeenCalledOnce();
  });

  it.each([
    "Approved shot direction: 完整产品。\nApproved camera direction: restrained move.\n\nBackend CG instructions.  ",
    "  运镜：平稳前移。\n场景：短视频带货商品展示。\nBackend sales instructions.\n",
  ])("shows and submits the backend prompt unchanged: %s", async (prompt) => {
    shots = [shot(1)]; shots[0].draft!.prompt = prompt;
    await mount();
    expect(container.querySelector("details p")?.textContent).toBe(prompt);
    await confirmAndSubmit();
    expect(videoRequests()[0].prompt).toBe(prompt);
    expect(videoRequests()[0].promptContext).toEqual(shots[0].draft!.promptContext);
  });

  it("supports select/deselect all and ignores a rapid duplicate submit", async () => {
    await mount(); await act(async () => button("取消全选").click());
    expect(button("确认提交").disabled).toBe(true);
    await act(async () => button("全选").click()); await act(async () => checkbox("确认批量生成费用").click());
    await act(async () => { const submit = button("确认提交"); submit.click(); submit.click(); });
    const requests = videoRequests(); expect(requests).toHaveLength(2);
    expect(new Set(requests.map((request) => request.clientRequestId)).size).toBe(2);
    for (const request of requests) expect(request.billingAcknowledgement).toEqual({ policyRevision: "credits-v1", acceptedForRequestId: request.clientRequestId });
    expect(container.textContent).toContain("已提交或完成 2 个");
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
    await act(async () => button("全选").click()); expect(button("确认提交").disabled).toBe(true);
  });

  it("refreshes the reviewed prompt when first or tail is selected and sends no hidden references", async () => {
    shots = [shot(1)];
    await mount();
    await act(async () => checkbox("确认批量生成费用").click());
    const first = container.querySelector('select[aria-label="分镜 1 首帧"]') as HTMLSelectElement;
    await act(async () => { first.value = "/alternate.png"; first.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(shots[0].draft!.refreshFrames).toHaveBeenCalledWith("/alternate.png", undefined);
    expect(checkbox("确认批量生成费用").checked).toBe(false);
    const tail = container.querySelector('select[aria-label="分镜 1 尾帧"]') as HTMLSelectElement;
    await act(async () => { tail.value = "/frame-1.png"; tail.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.querySelector("details p")?.textContent).toBe("Reviewed frames: /alternate.png / /frame-1.png");
    await confirmAndSubmit();
    expect(videoRequests()[0]).toMatchObject({ imageUrl: "/alternate.png", lastImageUrl: "/frame-1.png", prompt: "Reviewed frames: /alternate.png / /frame-1.png", promptContext: { contextKey: "review-/alternate.png-/frame-1.png", controlInputs: { firstFrameUrl: "/alternate.png", lastFrameUrl: "/frame-1.png" } } });
    expect(videoRequests()[0]).not.toHaveProperty("referenceImageUrls");
  });

  it("blocks paid submission until frame review finishes and supports removing a selected tail", async () => {
    shots = [shot(1)];
    let finishReview!: (draft: BatchMotionDraft) => void;
    const original = shots[0].draft!.refreshFrames!;
    shots[0].draft!.refreshFrames = vi.fn(() => new Promise<BatchMotionDraft>((resolve) => { finishReview = resolve; }));
    await mount();
    await act(async () => checkbox("确认批量生成费用").click());
    const tail = container.querySelector('select[aria-label="分镜 1 尾帧"]') as HTMLSelectElement;
    await act(async () => { tail.value = "/alternate.png"; tail.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(button("确认提交").disabled).toBe(true);
    expect(checkbox("确认批量生成费用").disabled).toBe(true);
    await act(async () => finishReview(await original("/frame-1.png", "/alternate.png")));
    await act(async () => { tail.value = ""; tail.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => finishReview(await original("/frame-1.png", undefined)));
    await confirmAndSubmit();
    expect(videoRequests()[0]).not.toHaveProperty("lastImageUrl");
  });

  it("continues after a definite rejection and retries only the failed shot", async () => {
    let attempts = 0;
    api.request.mockImplementation((url: string, init?: RequestInit) => {
      if (url !== "/api/ai/video") return Promise.resolve(json(status()));
      const shotId = JSON.parse(String(init?.body)).shotId;
      return Promise.resolve(shotId === 1 && attempts++ === 0 ? json({ error: "Invalid parameter" }, 400) : json({ jobId: `job-${shotId}` }, 202));
    });
    await mount(); await confirmAndSubmit();
    expect(videoRequests().map((request) => request.shotId)).toEqual([1, 2]);
    expect(container.textContent).toContain("提交失败");
    await confirmAndSubmit();
    expect(videoRequests().map((request) => request.shotId)).toEqual([1, 2, 1]);
    expect(onSubmitted.mock.calls).toEqual([[2, "job-2"], [1, "job-1"]]);
  });

  it.each(["network", "server", "missing-id", "unreadable"])("stops the batch and blocks retries after an ambiguous %s response", async (failure) => {
    api.request.mockImplementation((url: string) => url !== "/api/ai/video" ? Promise.resolve(json(status()))
      : failure === "network" ? Promise.reject(new TypeError("Connection lost"))
        : Promise.resolve(failure === "unreadable" ? new Response("<html>bad gateway</html>", { status: 502 }) : failure === "server" ? json({ error: "Gateway timeout" }, 504) : json({}, 202)));
    await mount(); await confirmAndSubmit();
    expect(videoRequests()).toHaveLength(1);
    expect(container.textContent).toContain("提交结果待核对");
    expect(button("确认提交")).toBeUndefined();
    expect(button("核对任务列表")).toBeDefined();
    expect(refreshTasks).toHaveBeenCalledOnce();
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(onUncertain).toHaveBeenCalledWith(1, undefined);
  });

  it("stops when a rejected request cites an unresolved job that may belong to another shot", async () => {
    api.request.mockImplementation((url: string) => Promise.resolve(url === "/api/ai/video" ? json({ error: { message: "Already queued", jobId: "existing-job" } }, 409) : json(status())));
    await mount(); await confirmAndSubmit();
    expect(videoRequests()).toHaveLength(1);
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(onUncertain).toHaveBeenCalledWith(1, "existing-job");
    expect(container.textContent).toContain("已提交或完成 0 个");
    expect(container.textContent).toContain("任务 ID：existing-job");
    expect(button("确认提交")).toBeUndefined();
  });

  it("blocks a batch exceeding remaining capacity and permits a smaller selection from verified busy cache", async () => {
    api.request.mockImplementation((url: string) => Promise.resolve(url.includes("/refresh") ? json({ error: { code: "KLING_PROFILE_BUSY" } }, 409) : url === "/api/ai/video" ? json({ jobId: "last-slot" }, 202) : json(status({ concurrency: { active: 9, max: 10, blockedByUnknownSubmission: false } }))));
    await mount(); await act(async () => checkbox("确认批量生成费用").click());
    expect(button("确认提交").disabled).toBe(true);
    expect(container.textContent).toContain("当前还可提交 1 个");
    await act(async () => checkbox("选择分镜 2").click()); await confirmAndSubmit();
    expect(videoRequests()).toHaveLength(1);
  });

  it.each([
    { concurrency: { active: 0, max: 10, blockedByUnknownSubmission: true } },
    { concurrency: undefined },
    { profile: { ...readyProfile, authState: "logged_out" } },
    { models: [{ ...model, profileId: "other-account" }] },
  ])("blocks unavailable capacity, unauthenticated accounts and a different account's models: %j", async (overrides) => {
    api.request.mockResolvedValue(json(status(overrides))); await mount();
    await act(async () => checkbox("确认批量生成费用").click());
    expect(button("确认提交").disabled).toBe(true); expect(videoRequests()).toHaveLength(0);
  });

  it("submits only selected first and tail frames to any Kling tool despite unsupported metadata", async () => {
    api.request.mockImplementation((url: string, init?: RequestInit) => Promise.resolve(url === "/api/ai/video" ? json({ jobId: `job-${JSON.parse(String(init?.body)).shotId}` }, 202) : json(status({ models: [{ ...model, available: false, tool: "text_to_video", inputSlots: [], capabilities: { image: false, tailFrame: false, multiImage: false, audio: false } }] }))));
    await mount();
    await confirmAndSubmit();
    expect(videoRequests()).toHaveLength(2);
    expect(videoRequests()[0]).toMatchObject({ mode: "text-to-video", imageUrl: "/frame-1.png" });
    expect(videoRequests()[0]).not.toHaveProperty("referenceImageUrls");
    expect(container.textContent).not.toContain("图生视频模型");
  });

  it("never uses the cached model following a failed catalog refresh", async () => {
    api.request.mockImplementation((url: string) => Promise.resolve(url.includes("/refresh") ? json({ error: "Authentication failed" }, 401) : json(status())));
    await mount(); await act(async () => checkbox("确认批量生成费用").click());
    expect(button("确认提交").disabled).toBe(true); expect(container.textContent).toContain("Authentication failed");
  });

  it("uses only each selected API draft and keeps completed rows out of retries", async () => {
    await mount({ provider: "volcengine" });
    await act(async () => checkbox("选择分镜 2").click()); await confirmAndSubmit();
    expect(shots[0].draft!.generate).toHaveBeenCalledOnce(); expect(shots[1].draft!.generate).not.toHaveBeenCalled();
    expect(onSubmitted).toHaveBeenCalledWith(1); expect(videoRequests()).toHaveLength(0);
    await act(async () => button("全选").click()); await confirmAndSubmit();
    expect(shots[0].draft!.generate).toHaveBeenCalledOnce(); expect(shots[1].draft!.generate).toHaveBeenCalledOnce();
  });

  it("stops API batches with a returned task ID and exposes task recovery", async () => {
    vi.mocked(shots[0].draft!.generate).mockRejectedValue(new VideoGenerationFailure("Please query task", true, "remote-1"));
    await mount({ provider: "volcengine" }); await confirmAndSubmit();
    expect(container.textContent).toContain("任务 ID：remote-1"); expect(button("确认提交")).toBeUndefined();
    expect(shots[1].draft!.generate).not.toHaveBeenCalled();
    expect(onUncertain).toHaveBeenCalledWith(1, "remote-1");
  });

  it("invalidates confirmation when the current generation settings change", async () => {
    await mount(); await act(async () => checkbox("确认批量生成费用").click()); expect(button("确认提交").disabled).toBe(false);
    await mount({ valid: false }); expect(button("确认提交").disabled).toBe(true);
    expect(videoRequests()).toHaveLength(0);
  });

  it("validates each snapshot immediately before dispatch and stops when the next source changed", async () => {
    shots[0].draft!.validate = () => true;
    shots[1].draft!.validate = () => false;
    await mount(); await confirmAndSubmit();
    expect(videoRequests().map((request) => request.shotId)).toEqual([1]);
    expect(container.textContent).toContain("分镜 2 的素材或生成设置已更改");
    expect(onSubmitted).toHaveBeenCalledWith(1, "job-1");
  });

  it("finishes reconciling the dispatched request but stops remaining shots after unmount", async () => {
    let finishFirst!: (response: Response) => void;
    api.request.mockImplementation((url: string) => url === "/api/ai/video" ? new Promise<Response>((resolve) => { finishFirst = resolve; }) : Promise.resolve(json(status())));
    await mount(); await act(async () => checkbox("确认批量生成费用").click());
    await act(async () => button("确认提交").click());
    expect(videoRequests()).toHaveLength(1);
    await act(async () => root.unmount());
    await act(async () => finishFirst(json({ jobId: "first-job" }, 202)));
    expect(videoRequests()).toHaveLength(1);
    expect(onSubmitted).toHaveBeenCalledWith(1, "first-job");
    expect(refreshTasks).toHaveBeenCalledOnce();
  });

  it("stops undispatched shots when a status refresh changes the Kling account revision", async () => {
    vi.useFakeTimers();
    let finishFirst!: (response: Response) => void;
    let authRevision = 1;
    api.request.mockImplementation((url: string) => url === "/api/ai/video" ? new Promise<Response>((resolve) => { finishFirst = resolve; }) : Promise.resolve(json(status({ profile: { ...readyProfile, authRevision } }))));
    await mount(); await act(async () => checkbox("确认批量生成费用").click());
    await act(async () => button("确认提交").click());
    authRevision = 2;
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    await act(async () => finishFirst(json({ jobId: "first-job" }, 202)));
    expect(videoRequests()).toHaveLength(1);
    expect(onSubmitted).toHaveBeenCalledWith(1, "first-job");
    expect(container.textContent).toContain("Kling 账号或模型目录已更改");
  });
});

describe("batch request preparation", () => {
  it("drops sound and composition fields and disables declared native audio", () => {
    expect(silentBatchMotionOptions({ duration: 6, audioEnabled: true, voiceover: "hi", audioPrompt: "hello", audioUrl: "/voice", tts: true, subtitles: true, captions: true, music: "song" })).toEqual({ duration: 6, audioEnabled: false });
    const prepared = prepareBatchMotionKling(shots[0].draft!, model);
    expect(prepared.options).toEqual({ duration: 6, enable_audio: "false" });
    expect(prepared.images).toEqual(["/frame-1.png"]);
  });

  it("omits extra reference images while passing the selected first and tail frames", () => {
    const multi = { ...model, inputSlots: [{ name: "image", required: true, role: "image" as const }, { name: "reference", required: true, role: "image" as const }, { name: "tail", required: true, role: "tailImage" as const }] };
    const draft = { ...shots[0].draft!, lastFrameUrl: "/tail.png", referenceImages: ["/product.png", "/unused.png"] };
    expect(prepareBatchMotionKling(draft, multi)).toMatchObject({ images: ["/frame-1.png"], lastImageUrl: "/tail.png", error: "" });
    expect(prepareBatchMotionKling({ ...draft, lastFrameUrl: undefined }, multi).error).toBe("");
    expect(prepareBatchMotionKling(draft, { ...multi, inputSlots: [], parameters: [], capabilities: { image: false, tailFrame: false, multiImage: false, audio: false } })).toMatchObject({ images: ["/frame-1.png"], lastImageUrl: "/tail.png", error: "" });
  });

  it("keeps reviewed native speech enabled in batch requests and preserves the exact prompt", () => {
    const draft = shots[0].draft!;
    draft.promptContext!.generateAudio = true;
    draft.prompt = "Approved exact English spoken text with synchronized native audio.";
    const prepared = prepareBatchMotionKling(draft, model);
    expect(prepared.prompt).toBe(draft.prompt);
    expect(prepared.options).toMatchObject({ enable_audio: "true" });
    expect(prepareBatchMotionKling(draft, { ...model, parameters: [] })).toMatchObject({ prompt: draft.prompt, options: {}, error: "" });
  });
});
