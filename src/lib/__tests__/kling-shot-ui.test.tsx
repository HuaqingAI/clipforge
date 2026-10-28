import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KlingShotGenerator } from "@/components/kling-shot-generator";
import { ApiShotGenerator, VideoGenerationFailure } from "@/components/video-generation-dialog";
import { KlingJobDetail, klingJobBlocksSubmission } from "@/components/kling-job-detail";
import type { KlingJobView } from "@/lib/kling/job-types";
import type { KlingVideoModelDescriptor } from "@/lib/kling/types";
import { VIDEO_AUDIO_DIRECTIONS } from "@/lib/video-audio";
import type { VideoPromptContext } from "@/lib/video-prompt-request";
import { DEFAULT_VIDEO_PROMPT_SETTINGS } from "@/lib/shot-video-prompt";
import type { BatchMotionDraft } from "@/lib/batch-motion";

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/lib/kling/client", () => ({ klingFetch: api.request, klingErrorMessage: (body: { error?: string | { message?: string } }) => typeof body.error === "string" ? body.error : body.error?.message ?? "Kling 操作失败" }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? children : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

const model: KlingVideoModelDescriptor = { selectionKey: '["kling-cli","image_to_video","account-model"]', provider: "kling-cli", profileId: "profile", region: "global", tool: "image_to_video", remoteModelId: "account-model", displayName: "Account Model", catalogRevision: "revision", available: true, parameters: [{ name: "duration", type: "number", required: true, allowedValues: [5, 10], default: 5 }], inputSlots: [{ name: "image", role: "image", required: true }], capabilities: { image: true, tailFrame: false, multiImage: false, audio: false } };
const job: KlingJobView = { jobId: "job-1", profileId: "profile", projectId: "project", scriptId: "script", shotId: 1, modelId: "account-model", tool: "image_to_video", prompt: "Original prompt", submissionState: "acknowledged", remoteState: "completed", importState: "failed", outputs: [], allowedActions: ["query", "import"], autoQueryPaused: false, needsConfirmation: false, inputSummary: [], options: { duration: 5 }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
let root: Root;
let container: HTMLDivElement;
const onSubmitted = vi.fn();
const refreshTasks = vi.fn().mockResolvedValue(undefined);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const readyProfile = { id: "profile", label: "My Kling", environmentState: "ready", authState: "authenticated", authRevision: 1, principalKey: "account-principal", catalogRevision: "revision", catalogCheckedAt: 1 };
const readyStatus = (overrides: Record<string, unknown> = {}) => ({ configured: true, loggedIn: true, profile: readyProfile, models: [model], ...overrides });
const busyResponse = () => json({ error: { code: "KLING_PROFILE_BUSY", message: "此 Kling 账号正在执行其他操作，请稍后重试。", retryable: true } }, 409);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onSubmitted.mockReset(); refreshTasks.mockClear();
  api.request.mockReset().mockImplementation((url: string) => Promise.resolve(url.includes("/status") ? json({ loggedIn: true, profile: { label: "My Kling" }, models: [model] }) : url.includes("/jobs/") ? json(job) : json({ jobId: "job-1" }, 202)));
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const originalPrompt = "Slow dolly forward. Preserve product identity.";
const silentAudioDirection = `${VIDEO_AUDIO_DIRECTIONS.silent.en}.`;
function serverPromptContext(generateAudio = false): VideoPromptContext {
  return { scriptId: "script", shotId: 1, provider: "kling-cli", model: model.selectionKey, settings: { ...DEFAULT_VIDEO_PROMPT_SETTINGS }, generateAudio, contextKey: "server-context" };
}
async function mountGenerator(defaultModel = model.selectionKey, defaultParameters?: Record<string, unknown>, overrides: { open?: boolean; preparedPrompt?: string; profileId?: string; promptContext?: VideoPromptContext; negativePrompt?: string; referenceImages?: string[]; lastFrameUrl?: string; frameChoices?: Array<{ label: string; url: string }>; onFramesChange?(firstFrameUrl: string, lastFrameUrl?: string): Promise<BatchMotionDraft> } = {}) {
  const preparedPrompt = overrides.preparedPrompt ?? `${originalPrompt}\n\n${silentAudioDirection}`;
  await act(async () => root.render(<KlingShotGenerator open={overrides.open ?? true} onOpenChange={() => undefined} projectId="project" scriptId="script" profileId={overrides.profileId ?? "profile"} defaultModel={defaultModel} defaultParameters={defaultParameters} preparedPrompt={preparedPrompt} promptContext={overrides.promptContext ?? serverPromptContext()} negativePrompt={overrides.negativePrompt} firstFrameUrl="/api/files/project/input.jpg" asset={{ assetId: "original-asset", shotId: 1, type: "hook", duration: 3, description: "A product", prompt: "Static image composition, not a motion prompt", visualSource: "ai_generate", status: "done", thumbnailUrl: "/api/files/project/input.jpg" }} referenceImages={overrides.referenceImages ?? []} lastFrameUrl={overrides.lastFrameUrl} frameChoices={overrides.frameChoices} onFramesChange={overrides.onFramesChange} onSubmitted={onSubmitted} onRefreshTasks={refreshTasks} />));
}
function confirmCheckbox() { return container.querySelector('input[type="checkbox"]') as HTMLInputElement; }
function submitButton() { return Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("确认生成此镜头"))!; }
function promptTextarea() { return container.querySelector('[aria-label="Kling 视频提示词"]') as HTMLTextAreaElement; }


describe("Kling single-shot UI", () => {
  it("shows only first and tail frames and defaults to no tail without submitting hidden references", async () => {
    const extraSlotsModel = { ...model, inputSlots: [...model.inputSlots, { name: "tail", role: "tailImage" as const, required: false }, { name: "image3", role: "image" as const, required: false }, { name: "image4", role: "image" as const, required: false }] };
    api.request.mockImplementation((url: string) => Promise.resolve(url.includes("/status") ? json({ loggedIn: true, models: [extraSlotsModel] }) : json({ jobId: "job-1" }, 202)));
    await mountGenerator(model.selectionKey, undefined, { referenceImages: ["/api/files/person.jpg", "/api/files/product.jpg"], lastFrameUrl: "/api/files/end.jpg" });
    expect(container.querySelectorAll('select[aria-label^="Kling "]:not([aria-label^="Kling 参数"])')).toHaveLength(2);
    expect((container.querySelector('[aria-label="Kling 首帧"]') as HTMLSelectElement).value).toBe("/api/files/project/input.jpg");
    expect((container.querySelector('[aria-label="Kling 尾帧"]') as HTMLSelectElement).value).toBe("");
    expect(container.textContent).not.toMatch(/输入图片[1-4]/);
    await act(async () => confirmCheckbox().click());
    expect(submitButton().disabled).toBe(false);
    await act(async () => submitButton().click());
    const request = JSON.parse(api.request.mock.calls.find(([url]) => url === "/api/ai/video")![1].body);
    expect(request.imageUrl).toBe("/api/files/project/input.jpg");
    expect(request).not.toHaveProperty("referenceImageUrls");
    expect(request).not.toHaveProperty("lastImageUrl");
    expect(container.textContent).not.toContain("不支持");
  });

  it("submits an explicitly selected tail despite false capability metadata", async () => {
    await mountGenerator(model.selectionKey, undefined, { lastFrameUrl: "/api/files/end.jpg" });
    await act(async () => confirmCheckbox().click());
    const tail = container.querySelector('[aria-label="Kling 尾帧"]') as HTMLSelectElement;
    await act(async () => { tail.value = "/api/files/end.jpg"; tail.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(confirmCheckbox().checked).toBe(false);
    expect(submitButton().disabled).toBe(true);
    await act(async () => confirmCheckbox().click());
    await act(async () => submitButton().click());
    const request = JSON.parse(api.request.mock.calls.find(([url]) => url === "/api/ai/video")![1].body);
    expect(request).toMatchObject({ imageUrl: "/api/files/project/input.jpg", lastImageUrl: "/api/files/end.jpg" });
    expect(request).not.toHaveProperty("referenceImageUrls");
  });

  it("requires a fresh confirmation after server previewing changed frames and submits that reviewed context", async () => {
    let resolveReview!: (draft: BatchMotionDraft) => void;
    const onFramesChange = vi.fn(() => new Promise<BatchMotionDraft>((resolve) => { resolveReview = resolve; }));
    await mountGenerator(model.selectionKey, undefined, { frameChoices: [{ label: "另一关键帧", url: "/api/files/alternate.jpg" }], onFramesChange });
    await act(async () => confirmCheckbox().click());
    const first = container.querySelector('[aria-label="Kling 首帧"]') as HTMLSelectElement;
    await act(async () => { first.value = "/api/files/alternate.jpg"; first.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(onFramesChange).toHaveBeenCalledWith("/api/files/alternate.jpg", undefined);
    expect(confirmCheckbox().checked).toBe(false);
    expect(confirmCheckbox().disabled).toBe(true);
    expect(submitButton().disabled).toBe(true);
    await act(async () => { confirmCheckbox().click(); submitButton().click(); });
    expect(api.request.mock.calls.some(([url]) => url === "/api/ai/video")).toBe(false);
    const promptContext = { ...serverPromptContext(), contextKey: "reviewed-frames" };
    await act(async () => resolveReview({
      asset: { shotId: 1, type: "hook", duration: 3, description: "A product", prompt: "Product keyframe", visualSource: "ai_generate", status: "done" },
      prompt: "Server reviewed motion for the alternate frame.", promptContext, firstFrameUrl: "/api/files/alternate.jpg",
      referenceImages: [], options: {}, klingParameters: {}, generate: async () => undefined,
    }));
    expect(promptTextarea().value).toBe("Server reviewed motion for the alternate frame.");
    expect(confirmCheckbox().checked).toBe(false);
    expect(submitButton().disabled).toBe(true);
    await act(async () => confirmCheckbox().click());
    await act(async () => submitButton().click());
    const request = JSON.parse(api.request.mock.calls.find(([url]) => url === "/api/ai/video")![1].body);
    expect(request).toMatchObject({ imageUrl: "/api/files/alternate.jpg", prompt: "Server reviewed motion for the alternate frame.", promptContext });
    expect(request).not.toHaveProperty("lastImageUrl");
    expect(request).not.toHaveProperty("referenceImageUrls");
  });

  it("does not block generation on catalog-required extra images, tails, or scalar options", async () => {
    const staleModel = { ...model, parameters: [...model.parameters, { name: "motion", type: "number" as const, required: true }], inputSlots: [...model.inputSlots, { name: "extra", role: "image" as const, required: true }, { name: "tail", role: "tailImage" as const, required: true }] };
    api.request.mockImplementation((url: string) => Promise.resolve(url.includes("/status") ? json({ loggedIn: true, models: [staleModel] }) : json({ jobId: "job-1" }, 202)));
    await mountGenerator();
    await act(async () => confirmCheckbox().click());
    expect(submitButton().disabled).toBe(false);
    await act(async () => submitButton().click());
    expect(onSubmitted).toHaveBeenCalledWith("job-1");
  });

  it("shows and submits the backend's multiline prompt verbatim without allowing browser edits", async () => {
    const preparedPrompt = ["Approved shot direction: 商品完整居中。", "运镜：固定镜头。", "光线：natural studio light.", "", "后端原文结尾。  "].join("\n");
    await mountGenerator(model.selectionKey, undefined, { preparedPrompt });
    expect(promptTextarea().value).toBe(preparedPrompt);
    expect(promptTextarea().readOnly).toBe(true);
    await act(async () => { promptTextarea().dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    expect(promptTextarea().value).toBe(preparedPrompt);
    await act(async () => confirmCheckbox().click());
    await act(async () => submitButton().click());
    const request = JSON.parse(api.request.mock.calls.find(([url]) => url === "/api/ai/video")![1].body);
    expect(request.prompt).toBe(preparedPrompt);
    expect(request.promptContext).toEqual(serverPromptContext());
    expect(onSubmitted).toHaveBeenCalledWith("job-1");
  });

  it.each([
    { workflow: "CG", prompt: "Approved shot direction: 完整产品。\nPremium product CG motion.  " },
    { workflow: "short-video sales", prompt: "运镜：平稳前移。\n场景：带货商品展示。\n后端视频提示词。" },
  ])("omits sound controls and preserves the $workflow backend prompt and native audio setting", async ({ prompt }) => {
    const audioModel = { ...model, parameters: [...model.parameters, { name: "sound", type: "boolean" as const, required: true, default: true }], capabilities: { ...model.capabilities, audio: true } };
    api.request.mockImplementation((url: string) => Promise.resolve(url.includes("/status") ? json({ loggedIn: true, models: [audioModel] }) : json({ jobId: "job-1" }, 202)));
    await mountGenerator(model.selectionKey, { audioEnabled: true }, { preparedPrompt: prompt });
    expect(container.textContent).not.toContain("是否生成声音");
    expect(container.querySelector('[aria-label="Kling 生成声音"]')).toBeNull();
    expect(container.querySelector("#kling-audio-hint")).toBeNull();
    expect(container.querySelector('[aria-label="Kling 参数 sound"]')).toBeNull();
    expect(promptTextarea().value).toBe(prompt);
    await act(async () => confirmCheckbox().click()); await act(async () => submitButton().click());
    const request = JSON.parse(api.request.mock.calls.find(([url]) => url === "/api/ai/video")![1].body);
    expect(request.prompt).toBe(prompt);
    expect(request.promptContext).toEqual(serverPromptContext());
    expect(request.options).toEqual({ duration: 5, sound: false });
  });

  it("uses the backend native audio setting without adding controls or rewriting the prompt", async () => {
    const audioModel = { ...model, parameters: [...model.parameters, { name: "sound", type: "boolean" as const, required: true, default: false }], capabilities: { ...model.capabilities, audio: true } };
    api.request.mockImplementation((url: string) => Promise.resolve(url.includes("/status") ? json({ loggedIn: true, models: [audioModel] }) : json({ jobId: "job-1" }, 202)));
    const preparedPrompt = "Use the server's audio direction exactly.\nAmbient product sound.  ";
    const promptContext = serverPromptContext(true);
    await mountGenerator(model.selectionKey, undefined, { preparedPrompt, promptContext });
    expect(container.querySelector('[aria-label="Kling 生成声音"]')).toBeNull();
    expect(promptTextarea().value).toBe(preparedPrompt);
    await act(async () => confirmCheckbox().click()); await act(async () => submitButton().click());
    const request = JSON.parse(api.request.mock.calls.find(([url]) => url === "/api/ai/video")![1].body);
    expect(request.prompt).toBe(preparedPrompt);
    expect(request.promptContext).toEqual(promptContext);
    expect(request.options).toEqual({ duration: 5, sound: true });
  });

  it("preserves Kling 4.0 native speech without requiring an audio toggle or trusting stale audio:false metadata", async () => {
    const kling4 = { ...model, remoteModelId: "kling-video-v4_0", selectionKey: '["kling-cli","image_to_video","kling-video-v4_0"]', displayName: "Kling 4.0" };
    api.request.mockImplementation((url: string) => Promise.resolve(url.includes("/status") ? json({ loggedIn: true, models: [kling4] }) : json({ jobId: "job-1" }, 202)));
    const promptContext = { ...serverPromptContext(true), model: kling4.selectionKey, controlInputs: { supportsAudio: true } };
    const preparedPrompt = 'The presenter says "Try it on." with matching native English audio.';
    await mountGenerator(kling4.selectionKey, { audioEnabled: true }, { promptContext, preparedPrompt });
    expect(container.textContent).not.toContain("本次采用后期配音方案");
    expect(container.textContent).not.toContain("不支持原生音频");
    await act(async () => confirmCheckbox().click());
    expect(submitButton().disabled).toBe(false);
    await act(async () => submitButton().click());
    const request = JSON.parse(api.request.mock.calls.find(([url]) => url === "/api/ai/video")![1].body);
    expect(request.prompt).toBe(preparedPrompt);
    expect(request.promptContext).toEqual(promptContext);
    expect(request.options).toEqual({ duration: 5 });
  });

  it.each([false, true])("allows requested native audio without capability notices for audio metadata %s", async (audio) => {
    const silentModel = { ...model, capabilities: { ...model.capabilities, audio } };
    api.request.mockImplementation((url: string) => Promise.resolve(url.includes("/status") ? json({ loggedIn: true, models: [silentModel] }) : json({ jobId: "job-1" }, 202)));
    const promptContext = serverPromptContext(true);
    await mountGenerator(model.selectionKey, { audioEnabled: true }, { promptContext });
    expect(container.textContent).not.toContain("未确认");
    expect(container.textContent).not.toContain("不支持");
    expect(container.textContent).not.toContain("后期配音");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => confirmCheckbox().click());
    expect(submitButton().disabled).toBe(false);
    await act(async () => submitButton().click());
    const request = JSON.parse(api.request.mock.calls.find(([url]) => url === "/api/ai/video")![1].body);
    expect(request.promptContext).toEqual(promptContext);
    expect(request.options).toEqual({ duration: 5 });
    expect(onSubmitted).toHaveBeenCalledWith("job-1");
  });

  it("enables a declared audio flag despite stale false audio capability", async () => {
    const silentModel = { ...model, parameters: [...model.parameters, { name: "sound", type: "boolean" as const, required: false, default: true }] };
    api.request.mockImplementation((url: string) => Promise.resolve(url.includes("/status") ? json({ loggedIn: true, models: [silentModel] }) : json({ jobId: "job-1" }, 202)));
    await mountGenerator(model.selectionKey, undefined, { promptContext: serverPromptContext(true) });
    await act(async () => confirmCheckbox().click());
    await act(async () => submitButton().click());
    const request = JSON.parse(api.request.mock.calls.find(([url]) => url === "/api/ai/video")![1].body);
    expect(request.options.sound).toBe(true);
  });
  it("does not block a silent model on an unusable required audio switch", async () => {
    const silentModel = { ...model, parameters: [...model.parameters, { name: "sound", type: "string" as const, required: true, allowedValues: ["auto"], default: "auto" }] };
    api.request.mockImplementation((url: string) => Promise.resolve(url.includes("/status") ? json({ loggedIn: true, models: [silentModel] }) : json({ jobId: "job-1" }, 202)));
    await mountGenerator(model.selectionKey, undefined, { promptContext: serverPromptContext(true) });
    await act(async () => confirmCheckbox().click());
    expect(submitButton().disabled).toBe(false);
    await act(async () => submitButton().click());
    const request = JSON.parse(api.request.mock.calls.find(([url]) => url === "/api/ai/video")![1].body);
    expect(request.options).not.toHaveProperty("sound");
  });

  it.each([
    ["固定镜头。镜头平稳向左横移。", "同时要求固定镜头和移动镜头"],
    ["底部小字显示“价格。", "引号未闭合"],
  ])("shows invalid backend prompts without modifying or submitting them: %s", async (preparedPrompt, expected) => {
    await mountGenerator(model.selectionKey, undefined, { preparedPrompt });
    expect(promptTextarea().value).toBe(preparedPrompt);
    expect(promptTextarea().readOnly).toBe(true);
    expect(container.textContent).toContain(expected);
    expect(container.textContent).toContain("请修改分镜内容或生成设置后再提交");
    await act(async () => confirmCheckbox().click());
    expect(submitButton().disabled).toBe(true);
    await act(async () => submitButton().click());
    expect(api.request.mock.calls.filter(([url]) => url === "/api/ai/video")).toHaveLength(0);
  });

  it("refreshes a persisted catalog before confirmation before using native audio options", async () => {
    const audioModel = { ...model, parameters: [...model.parameters, { name: "enable_audio", type: "string" as const, required: false, allowedValues: ["true", "false"], default: "true" }], capabilities: { ...model.capabilities, audio: true } };
    let finishRefresh!: (response: Response) => void;
    api.request.mockImplementation(async (url: string) => {
      if (url.includes("/status")) return json({ loggedIn: true, profile: { id: "profile" }, models: [model] });
      if (url.includes("/refresh")) return new Promise<Response>((resolve) => { finishRefresh = resolve; });
      return json({ jobId: "job-1" }, 202);
    });
    await mountGenerator();
    expect(submitButton().disabled).toBe(true);
    expect(api.request.mock.calls.find(([url]) => url.endsWith("/refresh"))?.[1]).toMatchObject({ method: "POST", body: JSON.stringify({ profileId: "profile", credits: false }) });
    await act(async () => finishRefresh(json({ loggedIn: true, profile: { id: "profile" }, models: [audioModel] })));
    await act(async () => confirmCheckbox().click()); await act(async () => submitButton().click());
    const request = JSON.parse(api.request.mock.calls.find(([url]) => url === "/api/ai/video")![1].body);
    expect(request.options.enable_audio).toBe("false");
  });

  it("keeps generation unavailable when refreshing the persisted model catalog fails", async () => {
    api.request.mockImplementation(async (url: string) => url.includes("/status")
      ? json({ loggedIn: true, profile: { id: "profile" }, models: [model] })
      : json({ error: "刷新模型目录失败" }, 503));
    await mountGenerator();
    expect(container.textContent).toContain("刷新模型目录失败");
    expect(submitButton().disabled).toBe(true);
    expect(api.request.mock.calls.filter(([url]) => url === "/api/ai/video")).toHaveLength(0);
  });

  it("uses the authenticated cached catalog during temporary CLI contention and submits only after explicit confirmation", async () => {
    api.request.mockImplementation(async (url: string) => url.includes("/status")
      ? json(readyStatus({ concurrency: { active: 9, max: 10, blockedByUnknownSubmission: false } }))
      : url.includes("/refresh") ? busyResponse() : json({ jobId: "tenth-job" }, 202));
    await mountGenerator();
    expect(container.textContent).toContain("当前账号生成名额：9 / 10");
    expect(Array.from(container.querySelectorAll('[role="status"]')).some((element) => /重试|刷新/.test(element.textContent ?? ""))).toBe(true);
    expect(confirmCheckbox().checked).toBe(false);
    expect(submitButton().disabled).toBe(true);
    expect(api.request.mock.calls.filter(([url]) => url === "/api/ai/video")).toHaveLength(0);
    await act(async () => confirmCheckbox().click());
    expect(submitButton().disabled).toBe(false);
    await act(async () => submitButton().click());
    expect(onSubmitted).toHaveBeenCalledWith("tenth-job");
    expect(api.request.mock.calls.filter(([url]) => url === "/api/ai/video")).toHaveLength(1);
  });

  it.each([
    { label: "an unconfigured integration", overrides: { configured: false } },
    { label: "an unavailable CLI environment", overrides: { profile: { ...readyProfile, environmentState: "not_found" } } },
    { label: "an account awaiting reauthentication", overrides: { profile: { ...readyProfile, authState: "reauth_required" } } },
    { label: "a cache without verified account identity", overrides: { profile: { ...readyProfile, principalKey: undefined } } },
    { label: "a cache without a catalog revision", overrides: { profile: { ...readyProfile, catalogRevision: undefined } } },
    { label: "a model from a different catalog revision", overrides: { models: [{ ...model, catalogRevision: "different-revision" }] } },
    { label: "a cache without a catalog check timestamp", overrides: { profile: { ...readyProfile, catalogCheckedAt: undefined } } },
    { label: "a model belonging to another profile", overrides: { models: [{ ...model, profileId: "other-profile" }] } },
  ])("does not allow a busy fallback to bypass $label", async ({ overrides }) => {
    api.request.mockImplementation(async (url: string) => url.includes("/status") ? json(readyStatus(overrides)) : busyResponse());
    await mountGenerator();
    if (confirmCheckbox()) await act(async () => confirmCheckbox().click());
    expect(submitButton().disabled).toBe(true);
    expect(api.request.mock.calls.filter(([url]) => url === "/api/ai/video")).toHaveLength(0);
  });

  it("automatically retries a busy catalog refresh without resetting edits or billing acknowledgement when the catalog is unchanged", async () => {
    vi.useFakeTimers();
    let refreshCount = 0;
    api.request.mockImplementation(async (url: string) => url.includes("/status")
      ? json(readyStatus())
      : url.includes("/refresh") ? ++refreshCount < 3 ? busyResponse() : json(readyStatus()) : json({ jobId: "job-1" }, 202));
    await mountGenerator();
    await act(async () => {
      const select = container.querySelector('[aria-label="Kling 参数 时长（秒）"]') as HTMLSelectElement;
      select.value = "10"; select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => confirmCheckbox().click());
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(refreshCount).toBe(2);
    expect(confirmCheckbox().checked).toBe(true);
    expect(submitButton().disabled).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(refreshCount).toBe(3);
    expect((container.querySelector('[aria-label="Kling 参数 时长（秒）"]') as HTMLSelectElement).value).toBe("10");
    expect(promptTextarea().value).toBe(`${originalPrompt}\n\n${silentAudioDirection}`);
    expect(confirmCheckbox().checked).toBe(true);
    expect(submitButton().disabled).toBe(false);
    expect(api.request.mock.calls.filter(([url]) => url === "/api/ai/video")).toHaveLength(0);
    await act(async () => submitButton().click());
    const request = JSON.parse(api.request.mock.calls.find(([url]) => url === "/api/ai/video")![1].body);
    expect(request.options.duration).toBe(10);
    expect(request.prompt).toBe(`${originalPrompt}\n\n${silentAudioDirection}`);
  });

  it("recovers automatically after a non-busy catalog refresh failure without generating a video", async () => {
    vi.useFakeTimers();
    let failed = true;
    api.request.mockImplementation(async (url: string) => url.includes("/status") ? json(readyStatus())
      : failed ? json({ error: { code: "KLING_CLI_FAILED", message: "刷新模型目录失败" } }, 502) : json(readyStatus()));
    await mountGenerator();
    expect(container.textContent).toContain("刷新模型目录失败");
    expect(submitButton().disabled).toBe(true);
    failed = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(container.textContent).not.toContain("刷新模型目录失败");
    expect(confirmCheckbox().checked).toBe(false);
    await act(async () => confirmCheckbox().click());
    expect(submitButton().disabled).toBe(false);
    expect(api.request.mock.calls.filter(([url]) => url === "/api/ai/video")).toHaveLength(0);
  });

  it("does not restore stale cached eligibility after authentication failure followed by a busy retry", async () => {
    vi.useFakeTimers();
    let refreshCount = 0;
    api.request.mockImplementation(async (url: string) => {
      if (url.includes("/status")) return json(readyStatus());
      if (++refreshCount === 1) return json({ error: { code: "KLING_AUTH_REQUIRED", message: "Kling 登录已失效" } }, 401);
      return refreshCount === 2 ? busyResponse() : json(readyStatus());
    });
    await mountGenerator();
    expect(container.textContent).toContain("Kling 登录已失效");
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(refreshCount).toBe(2);
    expect(submitButton().disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(confirmCheckbox().checked).toBe(false);
    await act(async () => confirmCheckbox().click());
    expect(submitButton().disabled).toBe(false);
    expect(api.request.mock.calls.filter(([url]) => url === "/api/ai/video")).toHaveLength(0);
  });

  it("waits for an in-flight catalog retry before starting another background check", async () => {
    vi.useFakeTimers();
    let refreshCount = 0;
    let finishRefresh!: (response: Response) => void;
    api.request.mockImplementation(async (url: string) => {
      if (url.includes("/status")) return json(readyStatus());
      if (++refreshCount === 1) return busyResponse();
      return new Promise<Response>((resolve) => { finishRefresh = resolve; });
    });
    await mountGenerator();
    await act(async () => confirmCheckbox().click());
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(refreshCount).toBe(2);
    const requestsWhilePending = api.request.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(api.request).toHaveBeenCalledTimes(requestsWhilePending);
    expect(confirmCheckbox().checked).toBe(true);
    expect(submitButton().disabled).toBe(false);
    await act(async () => finishRefresh(json(readyStatus())));
    expect(api.request.mock.calls.filter(([url]) => url === "/api/ai/video")).toHaveLength(0);
  });

  it.each(["http", "network"])("recovers from an initial %s status failure through polling", async (failure) => {
    vi.useFakeTimers();
    let statusReads = 0;
    api.request.mockImplementation(async (url: string) => {
      if (url.includes("/status") && ++statusReads === 1) {
        if (failure === "network") throw new TypeError("Status unavailable");
        return json({ error: { code: "KLING_INTERNAL", message: "Status unavailable" } }, 503);
      }
      return json(readyStatus());
    });
    await mountGenerator();
    expect(submitButton().disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(statusReads).toBeGreaterThan(1);
    expect(confirmCheckbox().checked).toBe(false);
    await act(async () => confirmCheckbox().click());
    expect(submitButton().disabled).toBe(false);
    expect(api.request.mock.calls.filter(([url]) => url === "/api/ai/video")).toHaveLength(0);
  });

  it.each([
    { active: 10, blockedByUnknownSubmission: false },
    { active: 1, blockedByUnknownSubmission: true },
  ])("retains account submission safeguards during busy fallback with $active active jobs and unknown=$blockedByUnknownSubmission", async (concurrency) => {
    api.request.mockImplementation(async (url: string) => url.includes("/status")
      ? json(readyStatus({ concurrency: { ...concurrency, max: 10 } })) : busyResponse());
    await mountGenerator();
    await act(async () => confirmCheckbox().click());
    expect(submitButton().disabled).toBe(true);
    expect(api.request.mock.calls.filter(([url]) => url === "/api/ai/video")).toHaveLength(0);
  });

  it("invalidates billing acknowledgement when a busy refresh discovers changed model capabilities", async () => {
    vi.useFakeTimers();
    const updatedModel = { ...model, catalogRevision: "updated", parameters: [...model.parameters, { name: "enable_audio", type: "string" as const, required: false, allowedValues: ["true", "false"], default: "true" }], capabilities: { ...model.capabilities, audio: true } };
    let refreshCount = 0;
    api.request.mockImplementation(async (url: string) => url.includes("/status") ? json(readyStatus())
      : ++refreshCount === 1 ? busyResponse() : json(readyStatus({ models: [updatedModel] })));
    await mountGenerator();
    await act(async () => confirmCheckbox().click());
    expect(submitButton().disabled).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(confirmCheckbox().checked).toBe(false);
    expect(submitButton().disabled).toBe(true);
    expect(api.request.mock.calls.filter(([url]) => url === "/api/ai/video")).toHaveLength(0);
  });

  it("blocks a cached busy fallback immediately when polling discovers the account is logged out", async () => {
    vi.useFakeTimers();
    let loggedIn = true;
    api.request.mockImplementation(async (url: string) => url.includes("/status")
      ? json(readyStatus({ loggedIn, profile: { ...readyProfile, authState: loggedIn ? "authenticated" : "logged_out", authRevision: loggedIn ? 1 : 2 } })) : busyResponse());
    await mountGenerator();
    await act(async () => confirmCheckbox().click());
    expect(submitButton().disabled).toBe(false);
    loggedIn = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(submitButton().disabled).toBe(true);
    expect(container.textContent).toContain("完成 Kling 环境检测和登录");
    expect(confirmCheckbox()?.checked ?? false).toBe(false);
    expect(api.request.mock.calls.filter(([url]) => url === "/api/ai/video")).toHaveLength(0);
  });

  it("invalidates confirmation after an account authentication revision changes even when the model catalog is identical", async () => {
    vi.useFakeTimers();
    let authRevision = 1;
    api.request.mockImplementation(async () => json(readyStatus({ profile: { ...readyProfile, authRevision } })));
    await mountGenerator();
    await act(async () => confirmCheckbox().click());
    expect(submitButton().disabled).toBe(false);
    authRevision = 2;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(confirmCheckbox().checked).toBe(false);
    expect(submitButton().disabled).toBe(true);
    expect(api.request.mock.calls.filter(([url]) => url.endsWith("/refresh"))).toHaveLength(1);
    expect(api.request.mock.calls.filter(([url]) => url === "/api/ai/video")).toHaveLength(0);
  });

  it("cancels pending catalog reads and retries after closing confirmation", async () => {
    vi.useFakeTimers();
    let finishRefresh!: (response: Response) => void;
    let refreshSignal: AbortSignal | undefined;
    api.request.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/status")) return json(readyStatus());
      refreshSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => { finishRefresh = resolve; });
    });
    await mountGenerator();
    await mountGenerator(model.selectionKey, undefined, { open: false });
    expect(refreshSignal?.aborted).toBe(true);
    const requestCount = api.request.mock.calls.length;
    await act(async () => finishRefresh(json(readyStatus())));
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(container.textContent).toBe("");
    expect(api.request).toHaveBeenCalledTimes(requestCount);
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it("ignores a previous account's late catalog refresh after switching the confirmation profile", async () => {
    let finishOldRefresh!: (response: Response) => void;
    let oldSignal: AbortSignal | undefined;
    const switchedModel = { ...model, profileId: "other-profile", displayName: "Other Account Model" };
    api.request.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/status")) return json(url.includes("other-profile")
        ? readyStatus({ profile: { ...readyProfile, id: "other-profile", label: "Other Kling" }, models: [switchedModel] }) : readyStatus());
      if (url.includes("/refresh") && JSON.parse(String(init?.body)).profileId === "profile") {
        oldSignal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => { finishOldRefresh = resolve; });
      }
      return json(readyStatus({ profile: { ...readyProfile, id: "other-profile", label: "Other Kling" }, models: [switchedModel] }));
    });
    await mountGenerator();
    await mountGenerator(model.selectionKey, undefined, { profileId: "other-profile" });
    expect(oldSignal?.aborted).toBe(true);
    expect(container.textContent).toContain("Other Kling");
    await act(async () => confirmCheckbox().click());
    await act(async () => finishOldRefresh(json(readyStatus({ models: [] }))));
    expect(container.textContent).toContain("Other Account Model");
    expect(container.textContent).not.toContain("默认视频模型不在当前账号目录中");
    expect(confirmCheckbox().checked).toBe(true);
    expect(submitButton().disabled).toBe(false);
    expect(api.request.mock.calls.filter(([url]) => url === "/api/ai/video")).toHaveLength(0);
  });

  it("allows a tenth shot while nine cloud jobs are running", async () => {
    api.request.mockImplementation(async (url: string) => url.includes("/status") ? json({ loggedIn: true, models: [model], concurrency: { active: 9, max: 10, blockedByUnknownSubmission: false } }) : json({ jobId: "tenth-job" }, 202));
    await mountGenerator();
    expect(container.textContent).toContain("当前账号生成名额：9 / 10");
    expect(container.textContent).toContain("同一 Kling 账号最多同时生成 10 个镜头");
    await act(async () => confirmCheckbox().click()); await act(async () => submitButton().click());
    expect(onSubmitted).toHaveBeenCalledWith("tenth-job");
    expect(api.request.mock.calls.filter(([url]) => url === "/api/ai/video")).toHaveLength(1);
  });

  it("blocks an eleventh shot and enables submission when polling finds a free slot without resetting edited options", async () => {
    vi.useFakeTimers();
    let active = 10;
    api.request.mockImplementation(async (url: string) => url.includes("/status") ? json({ loggedIn: true, models: [model], concurrency: { active, max: 10, blockedByUnknownSubmission: false } }) : json({ jobId: "next-job" }, 202));
    await mountGenerator();
    await act(async () => {
      const select = container.querySelector('[aria-label="Kling 参数 时长（秒）"]') as HTMLSelectElement;
      select.value = "10"; select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => confirmCheckbox().click());
    expect(submitButton().disabled).toBe(true);
    expect(container.textContent).toContain("已占用全部 10 个生成名额");
    expect(api.request.mock.calls.filter(([url]) => url === "/api/ai/video")).toHaveLength(0);
    active = 9;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(submitButton().disabled).toBe(false);
    expect((container.querySelector('[aria-label="Kling 参数 时长（秒）"]') as HTMLSelectElement).value).toBe("10");
    await act(async () => submitButton().click());
    const request = JSON.parse(api.request.mock.calls.find(([url]) => url === "/api/ai/video")![1].body);
    expect(request.options.duration).toBe(10);
  });

  it("blocks new paid submission while any account task has unknown submission even with free slots", async () => {
    api.request.mockImplementation(async () => json({ loggedIn: true, models: [model], concurrency: { active: 1, max: 10, blockedByUnknownSubmission: true } }));
    await mountGenerator(); await act(async () => confirmCheckbox().click());
    expect(submitButton().disabled).toBe(true);
    expect(container.textContent).toContain("先核对原任务再继续");
    expect(api.request.mock.calls.filter(([url]) => url === "/api/ai/video")).toHaveLength(0);
  });

  it("requires billing acknowledgement, submits the discovered model/options only, and blocks same-tick double clicks", async () => {
    await mountGenerator();
    expect(submitButton().disabled).toBe(true);
    await act(async () => confirmCheckbox().click());
    await act(async () => { submitButton().click(); submitButton().click(); });
    const submissions = api.request.mock.calls.filter(([url]) => url === "/api/ai/video");
    expect(submissions).toHaveLength(1);
    const request = JSON.parse(submissions[0][1].body);
    expect(request).toMatchObject({ provider: "kling-cli", profileId: "profile", executionScope: "single-shot", selectionKey: model.selectionKey, mode: "image-to-video", imageUrl: "/api/files/project/input.jpg", expectedSelectedAssetId: "original-asset", options: { duration: 5 } });
    expect(request.billingAcknowledgement.acceptedForRequestId).toBe(request.clientRequestId);
    expect(request).not.toHaveProperty("apiKey");
    expect(request.prompt).toContain(originalPrompt);
    expect(request.prompt.endsWith(silentAudioDirection)).toBe(true);
    expect(container.querySelector('select[aria-label="Kling 生成模型"]')).toBeNull();
    expect(container.querySelector('[aria-label="默认视频模型"]')?.textContent).toContain("account-model");
    expect(onSubmitted).toHaveBeenCalledWith("job-1");
  });

  it("defaults to silent generation and shows the exact submitted prompt without inventing an unsupported audio flag", async () => {
    await mountGenerator(model.selectionKey, { audioEnabled: true });
    expect(promptTextarea().value).toContain(originalPrompt);
    expect(promptTextarea().value.endsWith(silentAudioDirection)).toBe(true);
    const displayedPrompt = promptTextarea().value;
    await act(async () => confirmCheckbox().click()); await act(async () => submitButton().click());
    const request = JSON.parse(api.request.mock.calls.find(([url]) => url === "/api/ai/video")![1].body);
    expect(request.options).toEqual({ duration: 5 });
    expect(request.prompt).toBe(displayedPrompt);
  });

  it.each([
    { parameter: { name: "sound", type: "boolean" as const, required: true, default: true }, off: false, on: true },
    { parameter: { name: "sound", type: "string" as const, required: true, allowedValues: ["on", "off"], default: "on" }, off: "off", on: "on" },
    { parameter: { name: "enable_audio", type: "string" as const, required: false, allowedValues: ["true", "false"], default: "true" }, off: "false", on: "true" },
  ])("overrides an enabled $parameter.type native sound default using the backend silent context", async ({ parameter, off }) => {
    const audioModel = { ...model, parameters: [...model.parameters, parameter], capabilities: { ...model.capabilities, audio: true } };
    api.request.mockImplementation((url: string) => Promise.resolve(url.includes("/status") ? json({ loggedIn: true, models: [audioModel] }) : json({ jobId: "job-1" }, 202)));
    await mountGenerator(model.selectionKey, { audioEnabled: true });
    expect(container.querySelector(`[aria-label="Kling 参数 ${parameter.name}"]`)).toBeNull();
    await act(async () => confirmCheckbox().click()); await act(async () => submitButton().click());
    const request = JSON.parse(api.request.mock.calls.find(([url]) => url === "/api/ai/video")![1].body);
    expect(request.options).toEqual({ duration: 5, [parameter.name]: off });
    expect(request.prompt.endsWith(silentAudioDirection)).toBe(true);
  });

  it("invalidates the billing acknowledgement after actual parameter changes", async () => {
    await mountGenerator();
    await act(async () => confirmCheckbox().click());
    const select = container.querySelector('[aria-label="Kling 参数 时长（秒）"]') as HTMLSelectElement;
    await act(async () => { select.value = "10"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(confirmCheckbox().checked).toBe(false);
    expect(submitButton().disabled).toBe(true);
    expect(api.request.mock.calls.filter(([url]) => url === "/api/ai/video")).toHaveLength(0);
  });

  it("does not fall back to another available model when the exact default is missing", async () => {
    await mountGenerator('["kling-cli","image_to_video","missing-model"]');
    expect(container.textContent).toContain("默认视频模型不在当前账号目录中");
    expect(submitButton().disabled).toBe(true);
    expect(api.request.mock.calls.filter(([url]) => url === "/api/ai/video")).toHaveLength(0);
  });

  it("maps requested global parameters to CLI fields without capability-based duration adaptation", async () => {
    api.request.mockImplementation((url: string) => Promise.resolve(url.includes("/status") ? json({ loggedIn: true, models: [{ ...model, parameters: [...model.parameters, { name: "aspect_ratio", type: "string", required: true, allowedValues: ["9:16", "16:9"], default: "16:9" }, { name: "resolution", type: "string", required: true, allowedValues: ["720p", "1080p"], default: "720p" }] }] }) : json({ jobId: "job-1" }, 202)));
    await mountGenerator(model.selectionKey, { duration: 7, aspectRatio: "9:16", resolution: "1080p", unknownFlag: "ignored" });
    expect(container.textContent).not.toContain("按模型支持的值");
    await act(async () => confirmCheckbox().click()); await act(async () => submitButton().click());
    const request = JSON.parse(api.request.mock.calls.find(([url]) => url === "/api/ai/video")![1].body);
    expect(request.options).toEqual({ duration: 7, aspect_ratio: "9:16", resolution: "1080p" });
    expect(request.selectionKey).toBe(model.selectionKey);
  });

  it("allows a catalog-disabled default and a text-to-video default without switching tools", async () => {
    api.request.mockImplementation(() => Promise.resolve(json({ loggedIn: true, models: [{ ...model, available: false, disabledReason: "Unsupported capability" }] })));
    await mountGenerator();
    expect(container.textContent).not.toContain("默认视频模型不可用");
    await act(async () => confirmCheckbox().click());
    expect(submitButton().disabled).toBe(false);
    const textModel = { ...model, selectionKey: '["kling-cli","text_to_video","text-model"]', tool: "text_to_video", inputSlots: [], capabilities: { ...model.capabilities, image: false } };
    api.request.mockImplementation(() => Promise.resolve(json({ loggedIn: true, models: [model, textModel] })));
    await mountGenerator(textModel.selectionKey);
    await act(async () => confirmCheckbox().click());
    expect(container.textContent).not.toContain("转动态需要图生视频模型");
    expect(submitButton().disabled).toBe(false);
    api.request.mockImplementation((url: string) => Promise.resolve(url.includes("/status") ? json({ loggedIn: true, models: [model, textModel] }) : json({ jobId: "job-1" }, 202)));
    await act(async () => submitButton().click());
    const request = JSON.parse(api.request.mock.calls.find(([url]) => url === "/api/ai/video")![1].body);
    expect(request.mode).toBe("text-to-video");
    expect(request.imageUrl).toBe("/api/files/project/input.jpg");
  });

  it("invalidates an acknowledged default when settings change while open", async () => {
    await mountGenerator(); await act(async () => confirmCheckbox().click());
    expect(submitButton().disabled).toBe(false);
    await mountGenerator('["kling-cli","image_to_video","new-model"]');
    expect(submitButton().disabled).toBe(true);
    expect(api.request.mock.calls.filter(([url]) => url === "/api/ai/video")).toHaveLength(0);
  });

  it("keeps ambiguous submission visible and prevents an ordinary retry", async () => {
    api.request.mockImplementation((url: string) => url.includes("/status") ? Promise.resolve(json({ loggedIn: true, models: [model] })) : Promise.reject(new TypeError("Network interrupted")));
    await mountGenerator(); await act(async () => confirmCheckbox().click()); await act(async () => submitButton().click());
    expect(container.textContent).toContain("本机提交结果待核对");
    expect(submitButton()).toBeUndefined();
    expect(refreshTasks).toHaveBeenCalledOnce();
    expect(api.request.mock.calls.filter(([url]) => url === "/api/ai/video")).toHaveLength(1);
  });

  it("treats an unreadable response after dispatch as ambiguous instead of offering retry", async () => {
    api.request.mockImplementation((url: string) => Promise.resolve(url.includes("/status") ? json({ loggedIn: true, models: [model] }) : new Response("<html>unavailable</html>", { status: 502 })));
    await mountGenerator(); await act(async () => confirmCheckbox().click()); await act(async () => submitButton().click());
    expect(container.textContent).toContain("本机提交结果待核对");
    expect(submitButton()).toBeUndefined();
  });

  it("restores imports through the original job and never invokes generation", async () => {
    await act(async () => root.render(<KlingJobDetail jobId="job-1" open onOpenChange={() => undefined} />));
    const button = Array.from(container.querySelectorAll("button")).find((element) => element.textContent === "重试保存原视频")!;
    await act(async () => button.click());
    expect(api.request.mock.calls.some(([url, init]) => url === "/api/integrations/kling/jobs/job-1/import" && init.method === "POST")).toBe(true);
    expect(api.request.mock.calls.some(([url]) => url === "/api/ai/video")).toBe(false);
  });

  it("offers a non-billable cancellation only when the server marks an unsubmitted job cancellable", async () => {
    api.request.mockImplementation(() => Promise.resolve(json({ ...job, submissionState: "prepared", remoteState: "not_started", importState: "not_ready", allowedActions: ["cancel-prepared"] })));
    await act(async () => root.render(<KlingJobDetail jobId="job-1" open onOpenChange={() => undefined} />));
    const cancel = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "取消未提交作业（不计费）")!;
    expect(cancel).toBeDefined();
    await act(async () => cancel.click());
    expect(api.request.mock.calls.some(([url, init]) => url === "/api/integrations/kling/jobs/job-1/cancel-prepared" && init.method === "POST")).toBe(true);
    expect(api.request.mock.calls.some(([url]) => url === "/api/ai/video")).toBe(false);
  });
});

describe("CLI task diagnostics", () => {
  it("shows persisted output, errors and exit information and copies the same diagnostic", async () => {
    const diagnosticJob: KlingJobView = { ...job, submissionState: "not_submitted", remoteState: "not_started", allowedActions: ["view_details"],
      cliDiagnostics: { recordedAt: new Date().toISOString(), durationMs: 8200, exitCode: 1, signal: null, timedOut: false, aborted: false,
        spawnFailed: false, truncated: false, stdout: '{"ok":false,"body":{"error":"invalid duration"}}', stderr: "Unknown parameter --resolution",
        error: "KlingError: invalid generation parameters", submission: { phase: "validation", outcome: "not_submitted", source: "cli",
          reason: "模型参数校验失败，未提交视频生成。", timedOut: false, aborted: false } } };
    api.request.mockResolvedValue(json(diagnosticJob));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await act(async () => root.render(<KlingJobDetail jobId="job-1" open onOpenChange={() => undefined} />));
    expect(container.textContent).toContain("CLI 返回与错误");
    expect(container.textContent).toContain("退出码：1");
    expect(container.textContent).toContain("8.2 秒");
    expect(container.textContent).toContain("invalid duration");
    expect(container.textContent).toContain("Unknown parameter --resolution");
    expect(container.textContent).toContain("模型与输入校验");
    const copy = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "复制诊断信息")!;
    await act(async () => copy.click());
    expect(JSON.parse(writeText.mock.calls[0][0])).toMatchObject({ jobId: "job-1", exitCode: 1, stderr: "Unknown parameter --resolution" });
    expect(container.textContent).toContain("已复制诊断信息");
    expect(api.request).toHaveBeenCalledTimes(1);
  });

  it("explains missing historical diagnostics without inventing CLI output", async () => {
    await act(async () => root.render(<KlingJobDetail jobId="job-1" open onOpenChange={() => undefined} />));
    expect(container.textContent).toContain("此历史任务未保存 CLI 返回与错误");
    expect(container.textContent).not.toContain("标准输出 stdout");
  });
});

describe("ordinary API single-shot confirmation", () => {
  async function mountApi(generate: () => Promise<void>, prompt = "Camera tracks the product") {
    await act(async () => root.render(<ApiShotGenerator shotId={3} modelLabel="volcengine · configured-default" prompt={prompt} images={[{ label: "首帧", url: "/api/files/project/frame.jpg" }]} options={{ duration: 5, resolution: "720p" }} onOpenChange={() => undefined} onGenerate={generate} onRefreshTasks={refreshTasks} />));
  }
  it.each([
    ["底部显示“价。", "引号未闭合"],
    ["固定镜头。镜头向左横移。", "同时要求固定镜头和移动镜头"],
    ["视频全程静音。保留环境音。", "同时要求静音和生成声音"],
  ])("shows invalid final API prompt without modifying or submitting it: %s", async (prompt, expected) => {
    const generate = vi.fn().mockResolvedValue(undefined);
    await mountApi(generate, prompt);
    expect((container.querySelector('[aria-label="视频提示词"]') as HTMLTextAreaElement).value).toBe(prompt);
    expect(container.textContent).toContain(expected);
    await act(async () => confirmCheckbox().click());
    expect(submitButton().disabled).toBe(true);
    await act(async () => submitButton().click());
    expect(generate).not.toHaveBeenCalled();
  });
  it("uses the same confirmation surface and sends nothing before acknowledgement", async () => {
    const generate = vi.fn().mockResolvedValue(undefined);
    await mountApi(generate);
    expect(container.querySelector("h2")?.textContent).toContain("确认镜头 3 视频生成");
    expect(container.querySelector('[aria-label="默认视频模型"]')?.textContent).toBe("volcengine · configured-default");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/files/project/frame.jpg");
    expect(submitButton().disabled).toBe(true); expect(generate).not.toHaveBeenCalled();
    await act(async () => confirmCheckbox().click());
    await act(async () => { submitButton().click(); submitButton().click(); });
    expect(generate).toHaveBeenCalledOnce();
  });
  it("keeps a returned task ID visible and stops direct resubmission", async () => {
    const generate = vi.fn().mockRejectedValue(new VideoGenerationFailure("Query existing task", true, "remote-task"));
    await mountApi(generate); await act(async () => confirmCheckbox().click()); await act(async () => submitButton().click());
    expect(container.textContent).toContain("任务 ID：remote-task");
    expect(submitButton()).toBeUndefined();
    expect(refreshTasks).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledOnce();
  });
});

describe("durable submission guards", () => {
  it.each(["prepared", "submitting", "submission_unknown"] as const)("blocks %s independently of transient page memory", (submissionState) => expect(klingJobBlocksSubmission({ ...job, submissionState })).toBe(true));
  it("keeps a completed cloud job blocked until its local import succeeds", () => {
    expect(klingJobBlocksSubmission(job)).toBe(true);
    expect(klingJobBlocksSubmission({ ...job, importState: "completed" })).toBe(false);
    expect(klingJobBlocksSubmission({ ...job, remoteState: "failed" })).toBe(false);
  });
});
