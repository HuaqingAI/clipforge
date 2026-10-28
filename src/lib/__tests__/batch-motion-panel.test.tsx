import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BatchMotionPanel } from "@/components/batch-motion-panel";
import { prepareBatchMotionKling, silentBatchMotionOptions, type BatchMotionDraft, type BatchMotionShot } from "@/lib/batch-motion";
import { DEFAULT_VIDEO_PROMPT_SETTINGS } from "@/lib/shot-video-prompt";
import type { KlingVideoModelDescriptor } from "@/lib/kling/types";

const api = vi.hoisted(() => ({ request: vi.fn() }));
const runFetch = vi.fn();
const closePanel = vi.fn();
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
  draft.request = { provider: "volcengine", model: "frozen-video", apiKey: "fixture", prompt: draft.prompt, options: draft.options };
  draft.assetPayload = { scriptId: "script", shotId, type: "ai_generate", expectedSelectedAssetId: asset.assetId, thumbnailPath: draft.firstFrameUrl, provider: "volcengine", model: "frozen-video" };
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
  shots = [shot(1), shot(2)]; closePanel.mockClear(); refreshTasks.mockClear(); onSubmitted.mockClear(); onUncertain.mockClear(); onBusyChange.mockClear();
  api.request.mockReset().mockImplementation((url: string, init?: RequestInit) => Promise.resolve(url === "/api/ai/video" ? json({ jobId: `job-${JSON.parse(String(init?.body)).shotId}` }, 202) : json(status())));
  vi.stubGlobal("fetch", runFetch);
  runFetch.mockReset().mockImplementation(async (_url: string, init?: RequestInit) => {
    const input = JSON.parse(String(init?.body));
    return json({ id: "run-1", projectId: input.projectId, kind: input.kind, status: "queued", total: input.items.length, done: 0, failed: 0, items: input.items.map((item: Record<string, unknown>, i: number) => ({ id: `item-${i}`, kind: item.kind, shotId: item.shotId, status: "queued" })) }, 202);
  });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function mount(overrides: Partial<ComponentProps<typeof BatchMotionPanel>> = {}) {
  await act(async () => root.render(<BatchMotionPanel open onOpenChange={closePanel} projectId="project" scriptId="script" provider="kling-cli" profileId="profile" selectionKey={model.selectionKey} modelLabel="My model" shots={shots} valid onRefreshTasks={refreshTasks} onSubmitted={onSubmitted} onUncertain={onUncertain} onBusyChange={onBusyChange} {...overrides} />));
}
function checkbox(label: string) { return container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement; }
function button(text: string) { return Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.includes(text))!; }
function videoRequests() { return api.request.mock.calls.filter(([url]) => url === "/api/ai/video").map(([, init]) => JSON.parse(init.body)); }
async function confirmAndSubmit() { await act(async () => checkbox("确认批量生成费用").click()); await act(async () => button("确认提交").click()); }

function runRequests() { return runFetch.mock.calls.filter(([url]) => url === "/api/generation-runs").map(([, init]) => JSON.parse(String(init.body))); }

describe("batch shot animation", () => {
  it("registers the complete selection atomically and closes without waiting for generation", async () => {
    shots.push({ ...shot(3), disabledReason: "此分镜已有视频" });
    await mount();
    expect(button("确认提交").disabled).toBe(true);
    expect(checkbox("选择分镜 3").disabled).toBe(true);
    await confirmAndSubmit();
    expect(runRequests()).toHaveLength(1);
    expect(runRequests()[0]).toMatchObject({ kind: "video_batch", projectId: "project", items: [{ shotId: 1 }, { shotId: 2 }] });
    expect(videoRequests()).toHaveLength(0);
    expect(closePanel).toHaveBeenCalledWith(false);
    expect(onSubmitted.mock.calls.map(([shotId]) => shotId)).toEqual([1, 2]);
    expect(shots[0].draft!.generate).not.toHaveBeenCalled();
  });

  it("freezes only the chosen frame, prompt, parameters and adoption baseline", async () => {
    await mount();
    await act(async () => checkbox("选择分镜 1").click());
    const tail = container.querySelector('select[aria-label="分镜 2 尾帧"]') as HTMLSelectElement;
    await act(async () => { tail.value = "/alternate.png"; tail.dispatchEvent(new Event("change", { bubbles: true })); });
    await confirmAndSubmit();
    const item = runRequests()[0].items[0];
    expect(runRequests()[0].items).toHaveLength(1);
    expect(item).toMatchObject({ shotId: 2, scriptId: "script", request: { provider: "kling-cli", selectionKey: model.selectionKey, imageUrl: "/frame-2.png", lastImageUrl: "/alternate.png", prompt: "Reviewed frames: /frame-2.png / /alternate.png", options: { enable_audio: "false" } }, asset: { expectedSelectedAssetId: "asset-2", thumbnailPath: "/frame-2.png" } });
    expect(item.request).not.toHaveProperty("referenceImageUrls");
  });

  it("queues more than ten shots while the account is busy", async () => {
    shots = Array.from({ length: 14 }, (_, i) => shot(i + 1));
    api.request.mockImplementation(() => Promise.resolve(json(status({ concurrency: { active: 40, max: null, blockedByUnknownSubmission: true } }))));
    await mount(); await confirmAndSubmit();
    expect(runRequests()).toHaveLength(1);
    expect(runRequests()[0].items).toHaveLength(14);
    expect(container.textContent).not.toContain("还可提交");
  });

  it("validates every source before registering any item", async () => {
    shots[0].draft!.validate = () => true; shots[1].draft!.validate = () => false;
    await mount(); await confirmAndSubmit();
    expect(runRequests()).toHaveLength(0);
    expect(container.textContent).toContain("分镜 2 的素材或生成设置已更改");
    expect(closePanel).not.toHaveBeenCalled();
  });

  it("blocks confirmation while frame review is pending", async () => {
    let finish!: (draft: BatchMotionDraft) => void;
    shots[0].draft!.refreshFrames = () => new Promise(resolve => { finish = resolve; });
    await mount();
    const first = container.querySelector('select[aria-label="分镜 1 首帧"]') as HTMLSelectElement;
    await act(async () => { first.value = "/alternate.png"; first.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(button("确认提交").disabled).toBe(true);
    await act(async () => finish({ ...shots[0].draft!, firstFrameUrl: "/alternate.png" }));
    await confirmAndSubmit();
    expect(runRequests()[0].items[0].request.imageUrl).toBe("/alternate.png");
  });

  it("uses one stable registration ID after a lost acknowledgement and prevents rapid duplicate submission", async () => {
    runFetch.mockRejectedValueOnce(new TypeError("Connection interrupted"));
    await mount(); await confirmAndSubmit();
    expect(closePanel).not.toHaveBeenCalled();
    const original = runRequests()[0];
    expect(checkbox("选择分镜 1").disabled).toBe(true);
    expect((container.querySelector('select[aria-label="分镜 1 首帧"]') as HTMLSelectElement).disabled).toBe(true);
    await act(async () => checkbox("确认批量生成费用").click());
    await act(async () => { button("确认提交").click(); button("确认提交").click(); });
    expect(runRequests()).toHaveLength(2);
    expect(runRequests()[1]).toEqual(original);
    expect(closePanel).toHaveBeenCalledWith(false);
  });

  it("keeps all registered items after the submitting view unmounts", async () => {
    let finish!: (response: Response) => void;
    runFetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await mount(); await confirmAndSubmit();
    expect(runRequests()[0].items).toHaveLength(2);
    await act(async () => root.unmount());
    await act(async () => finish(json({ id: "run-1", status: "queued" }, 202)));
    expect(runRequests()).toHaveLength(1);
    expect(onSubmitted.mock.calls.map(([shotId]) => shotId)).toEqual([1, 2]);
  });

  it("sends API request snapshots and never invokes browser execution closures", async () => {
    await mount({ provider: "volcengine" });
    await act(async () => checkbox("选择分镜 2").click());
    await confirmAndSubmit();
    expect(runRequests()[0].items).toHaveLength(1);
    expect(runRequests()[0].items[0].request).toEqual(shots[0].draft!.request);
    expect(runRequests()[0].items[0].asset).toEqual(shots[0].draft!.assetPayload);
    expect(shots[0].draft!.generate).not.toHaveBeenCalled();
    expect(shots[1].draft!.generate).not.toHaveBeenCalled();
  });

  it("rejects a stale unconfirmed configuration", async () => {
    await mount(); await act(async () => checkbox("确认批量生成费用").click());
    expect(button("确认提交").disabled).toBe(false);
    await mount({ valid: false });
    expect(button("确认提交").disabled).toBe(true);
    expect(runRequests()).toHaveLength(0);
  });

  it("does not cancel a registered batch when current settings change", async () => {
    let finish!: (response: Response) => void;
    runFetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await mount(); await confirmAndSubmit();
    const snapshot = runRequests()[0];
    await mount({ valid: false, selectionKey: "different-model" });
    await act(async () => finish(json({ id: "run-1", status: "queued" }, 202)));
    expect(runRequests()).toHaveLength(1);
    expect(snapshot.items).toHaveLength(2);
    expect(closePanel).toHaveBeenCalledWith(false);
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
