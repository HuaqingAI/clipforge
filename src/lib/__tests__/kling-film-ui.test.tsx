import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KlingFilmPanel } from "@/components/kling-film-panel";
import type { KlingFilmView } from "@/lib/kling/film-types";
import type { KlingVideoModelDescriptor } from "@/lib/kling/types";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { useCharacterStore } from "@/lib/stores/project-store";
import { DEFAULT_VIDEO_PROMPT_SETTINGS } from "@/lib/shot-video-prompt";
import { createTideweOutdoorProfile } from "@/lib/creative-profiles";

const api = vi.hoisted(() => ({ request: vi.fn(), imageTarget: vi.fn() }));
vi.mock("@/lib/kling/client", () => ({ klingFetch: api.request, klingErrorMessage: (body: { error?: string }) => body.error ?? "Kling 操作失败" }));
vi.mock("@/lib/gen-params", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/gen-params")>(), resolveDefaultModelTarget: api.imageTarget, buildImageOptions: (value: unknown) => value, toEditVariant: (value: string) => `${value}-edit` }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? children : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

const model: KlingVideoModelDescriptor = { selectionKey: '["kling-cli","image_to_video","account-model"]', provider: "kling-cli", profileId: "profile", region: "global", tool: "image_to_video", remoteModelId: "account-model", displayName: "Account Model", catalogRevision: "revision", available: true, parameters: [{ name: "duration", type: "number", required: true, allowedValues: [5, 10], default: 5 }, { name: "audio", type: "boolean", required: true, default: true }, { name: "aspect_ratio", type: "string", required: true, default: "16:9" }, { name: "motion", type: "number", required: false, allowedValues: [0.5, 1], default: 0.5 }], inputSlots: [{ name: "image", role: "image", required: true }], capabilities: { image: true, tailFrame: false, multiImage: false, audio: false } };
const plan: KlingFilmView = { runId: "film-1", projectId: "project", scriptId: "script", profileId: "profile", planHash: "frozen-plan", expiresAt: "2099-01-01T00:00:00Z", status: "draft", stage: "preview", model, output: { resolution: "720p", aspectRatio: "9:16", audioStrategy: "edge-tts", voice: "zh-CN-XiaoxiaoNeural", subtitles: true }, shots: [{ id: "shot-1", shotId: 1, status: "ready", source: "reuse", prompt: "Reused product shot", duration: 5, missingKeyframe: false, options: {}, assetId: "existing-video", videoUrl: "/api/files/existing.mp4", attempt: 0 }, { id: "shot-2", shotId: 2, status: "waiting", source: "generate", prompt: "Rotate product", duration: 5, generationDuration: 5, keyframeUrl: "/api/files/keyframe.jpg", missingKeyframe: false, options: { duration: 5 }, attempt: 0 }], totalShots: 2, readyShots: 1, billableShotCount: 1, missingKeyframes: [], warnings: [], allowedActions: [], createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z" };
plan.promptSettings = { ...DEFAULT_VIDEO_PROMPT_SETTINGS };
const initialSettings = useSettingsStore.getInitialState();
const initialCharacters = useCharacterStore.getInitialState();
let root: Root;
let container: HTMLDivElement;
let preview: KlingFilmView;
const fetchMock = vi.fn();
const onAssetsChanged = vi.fn();
const onOpenJob = vi.fn();
const onOpenChange = vi.fn();
const json = (value: unknown, status = 200) => Response.json(value, { status });
function button(part: string): HTMLButtonElement | undefined { return [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(part)); }
function checkbox(label: string) { return container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement; }
function deleteButton(runId: string) { return container.querySelector(`[aria-label="删除整片记录 ${runId}"]`) as HTMLButtonElement; }
function deleteRequests() { return api.request.mock.calls.filter(([, options]) => options?.method === "DELETE"); }
function mockFilmRecords(runs: KlingFilmView[], handleRequest?: (url: string, options?: RequestInit) => Promise<Response> | undefined) {
  const fallback = api.request.getMockImplementation()!;
  api.request.mockImplementation((url: string, options?: RequestInit) => {
    const handled = handleRequest?.(url, options);
    if (handled) return handled;
    if (url.includes("?projectId=")) return Promise.resolve(json({ runs }));
    const run = runs.find((item) => url === `/api/integrations/kling/films/${encodeURIComponent(item.runId)}`);
    return run ? Promise.resolve(json(run)) : fallback(url, options);
  });
}
async function click(part: string) { await act(async () => button(part)!.click()); }
async function select(label: string, value: string) {
  const input = container.querySelector(`[aria-label="${label}"]`) as HTMLSelectElement;
  await act(async () => { input.value = value; input.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function mount(initialRunId?: string, presenterId?: string, defaultModel = model.selectionKey, creativeProfile?: unknown) {
  await act(async () => root.render(<KlingFilmPanel open onOpenChange={onOpenChange} projectId="project" scriptId="script" profileId="profile" defaultModel={defaultModel} initialRunId={initialRunId} presenterId={presenterId} onAssetsChanged={onAssetsChanged} onOpenJob={onOpenJob} creativeProfile={creativeProfile} />));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", fetchMock);
  preview = structuredClone(plan); onAssetsChanged.mockReset(); onOpenJob.mockReset(); onOpenChange.mockReset();
  useSettingsStore.setState(initialSettings); useCharacterStore.setState({ ...initialCharacters, characters: [] });
  api.imageTarget.mockReset().mockResolvedValue({ provider: "images", model: "image-model", apiKey: "image-key" });
  api.request.mockReset().mockImplementation(async (url: string) => {
    if (url.includes("/status")) return json({ loggedIn: true, models: [model] });
    if (url.includes("?projectId=")) return json({ runs: [] });
    if (url.endsWith("/preview") || url.endsWith("/film-1")) return json(preview);
    if (url.endsWith("/films")) return json({ run: { ...preview, status: "running", allowedActions: ["pause", "cancel"] } }, 202);
    return json({ run: preview });
  });
  fetchMock.mockReset().mockImplementation(async (url: string) => url.endsWith("/project") ? json({ productImages: ["/api/files/product.jpg"] }) : json({ url: "/api/files/sheet.jpg" }));
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useSettingsStore.setState(initialSettings); useCharacterStore.setState(initialCharacters); vi.unstubAllGlobals(); });

describe("Kling full-film orchestration UI", () => {
  it("previews and starts the selected Kling model despite disabled capability metadata and omitted catalog-required options", async () => {
    const originalRequest = api.request.getMockImplementation()!;
    api.request.mockImplementation((url: string, options?: RequestInit) => url.includes("/status")
      ? Promise.resolve(json({ loggedIn: true, models: [{ ...model, available: false, disabledReason: "Unsupported capability", parameters: [...model.parameters, { name: "custom", type: "string", required: true }] }] }))
      : originalRequest(url, options));
    await mount();
    expect(button("预览整片计划")!.disabled).toBe(false);
    expect(container.textContent).not.toContain("Unsupported capability");
    await click("预览整片计划");
    await act(async () => checkbox("确认整片视频计费").click());
    expect(button("确认生成整片")!.disabled).toBe(false);
    await click("确认生成整片");
    expect(api.request.mock.calls.filter(([url]) => url.endsWith("/films"))).toHaveLength(1);
  });

  it.each([
    { speechMode: "on_camera", strategy: "native" },
    { speechMode: "voiceover", strategy: "edge-tts" },
  ] as const)("locks TIDEWE $speechMode to the matching audio strategy without changing historical narration", async ({ speechMode, strategy }) => {
    const profile = createTideweOutdoorProfile({ speechMode });
    preview.output = { ...preview.output, audioStrategy: strategy, voice: "en-US-GuyNeural" };
    await mount(undefined, undefined, model.selectionKey, profile);
    const audio = container.querySelector('[aria-label="整片声音策略"]') as HTMLSelectElement;
    expect(audio.value).toBe(strategy);
    expect(audio.disabled).toBe(true);
    expect(container.querySelector('[aria-label="整片配音音色"]') === null).toBe(speechMode === "on_camera");
    await click("预览整片计划");
    const request = api.request.mock.calls.find(([url]) => url.endsWith("/preview"));
    expect(JSON.parse(request![1].body).output).toMatchObject({ audioStrategy: strategy, aspectRatio: "9:16" });
  });
  it("passes the same global visual look, motion intensity and realism settings to the film preview", async () => {
    const promptSettings = { visualLook: "phone_raw", motionIntensity: "strong", motionRealism: "constraints" } as const;
    useSettingsStore.setState(promptSettings);
    preview.promptSettings = { ...promptSettings };
    await mount(); await click("预览整片计划");
    const request = api.request.mock.calls.find(([url]) => url.endsWith("/preview"));
    expect(JSON.parse(request![1].body).promptSettings).toEqual(promptSettings);
    expect(container.querySelector('[aria-label="整片计划"]')).not.toBeNull();
    expect(api.request.mock.calls.some(([url]) => url.endsWith("/films"))).toBe(false);
  });

  it.each([
    { visualLook: "phone_raw" }, { motionIntensity: "strong" }, { motionRealism: "off" },
  ] as const)("revokes the acknowledged draft when prompt settings change: %j", async (settings) => {
    await mount(); await click("预览整片计划");
    await act(async () => checkbox("确认整片视频计费").click());
    expect(button("确认生成整片")!.disabled).toBe(false);
    await act(async () => useSettingsStore.setState(settings));
    expect(button("确认生成整片")).toBeUndefined();
    await act(async () => useSettingsStore.setState(initialSettings));
    expect(button("确认生成整片")).toBeUndefined();
    await click("预览整片计划");
    expect(checkbox("确认整片视频计费").checked).toBe(false);
    expect(button("确认生成整片")!.disabled).toBe(true);
    expect(api.request.mock.calls.some(([url]) => url.endsWith("/films"))).toBe(false);
  });

  it("discards an in-flight preview when the global prompt settings change before it returns", async () => {
    let finishPreview!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finishPreview = resolve; });
    const request = api.request.getMockImplementation()!;
    api.request.mockImplementation((url: string, ...args: unknown[]) => url.endsWith("/preview") ? pending : request(url, ...args));
    await mount(); await click("预览整片计划");
    await act(async () => useSettingsStore.setState({ visualLook: "phone_raw" }));
    await act(async () => finishPreview(json(preview)));
    expect(container.querySelector('[aria-label="整片计划"]')).toBeNull();
    expect(checkbox("确认整片视频计费")).toBeNull();
    expect(api.request.mock.calls.filter(([url]) => url.endsWith("/preview"))).toHaveLength(1);
    expect(api.request.mock.calls.some(([url]) => url.endsWith("/films"))).toBe(false);
  });

  it.each(["legacy", "different"] as const)("requires another preview before a recovered %s-settings draft can start", async (kind) => {
    await mount(); await click("预览整片计划");
    await act(async () => checkbox("确认整片视频计费").click());
    if (kind === "legacy") delete preview.promptSettings;
    else preview.promptSettings = { ...DEFAULT_VIDEO_PROMPT_SETTINGS, visualLook: "phone_raw" };
    await click("查询原整片进度");
    expect(button("确认生成整片")).toBeUndefined();
    expect(container.textContent).toContain("请重新预览整片计划");
    expect(api.request.mock.calls.some(([url]) => url.endsWith("/films"))).toBe(false);
    preview.promptSettings = { ...DEFAULT_VIDEO_PROMPT_SETTINGS };
    await click("预览整片计划");
    expect(checkbox("确认整片视频计费").checked).toBe(false);
    expect(button("确认生成整片")!.disabled).toBe(true);
  });

  it("preserves an active run's frozen prompts and recovery plan after the global prompt settings change", async () => {
    preview = { ...preview, status: "paused", allowedActions: ["resume", "cancel"] };
    await mount("film-1");
    await act(async () => useSettingsStore.setState({ visualLook: "phone_raw", motionIntensity: "strong", motionRealism: "off" }));
    expect(container.querySelector('[aria-label="整片计划"]')?.textContent).toContain("Rotate product");
    expect(button("预览整片计划")).toBeUndefined();
    await act(async () => checkbox("确认整片恢复计费").click());
    await click("确认恢复并继续");
    const request = api.request.mock.calls.find(([url]) => url.endsWith("/resume"));
    expect(JSON.parse(request![1].body)).toMatchObject({ planHash: "frozen-plan", explicitConfirmation: true });
    expect(JSON.parse(request![1].body)).not.toHaveProperty("promptSettings");
    expect(api.request.mock.calls.some(([url]) => url.endsWith("/preview") || url.endsWith("/films"))).toBe(false);
  });

  it.each(["resolution", "video_resolution", "videoResolution", "quality"])("uses the configured 720p for %s even when the model defaults to 1080p, and allows an explicit override", async (parameterName) => {
    const highResolutionModel: KlingVideoModelDescriptor = {
      ...model,
      parameters: [
        ...model.parameters,
        { name: parameterName, type: "string", required: true, allowedValues: ["720p", "1080p"], default: "1080p" },
      ],
    };
    api.request.mockImplementation(async (url: string) => url.includes("/status")
      ? json({ loggedIn: true, models: [highResolutionModel] })
      : url.includes("?projectId=") ? json({ runs: [] }) : json(preview));
    useSettingsStore.getState().setDefaultResolution("720p");
    await mount();
    expect((container.querySelector('[aria-label="整片参数 质量"]') as HTMLSelectElement).value).toBe("720p");
    await click("预览整片计划");
    const firstRequest = api.request.mock.calls.find(([url]) => url.endsWith("/preview"));
    expect(JSON.parse(firstRequest![1].body)).toMatchObject({
      options: { [parameterName]: "720p" }, output: { resolution: "720p" },
    });
    expect(JSON.parse(firstRequest![1].body).options).not.toHaveProperty("duration");

    await select("整片参数 质量", "1080p");
    await click("预览整片计划");
    const requests = api.request.mock.calls.filter(([url]) => url.endsWith("/preview"));
    expect(JSON.parse(requests[1][1].body).options[parameterName]).toBe("1080p");
  });

  it("requires the exact configured default instead of selecting another available account model", async () => {
    await mount(undefined, undefined, '["kling-cli","image_to_video","missing-default"]');
    expect(container.textContent).toContain("默认视频模型不在当前账号目录中");
    expect(button("预览整片计划")!.disabled).toBe(true);
    expect(container.querySelector('[aria-label="整片模型"]')).toBeNull();
    expect(api.request.mock.calls.some(([url]) => url.endsWith("/preview") || url.endsWith("/films"))).toBe(false);
  });

  it("revokes an acknowledged draft when the global default changes and does not revive it on switching back", async () => {
    await mount(); await click("预览整片计划");
    await act(async () => checkbox("确认整片视频计费").click());
    expect(button("确认生成整片")!.disabled).toBe(false);
    await mount(undefined, undefined, '["kling-cli","image_to_video","missing-default"]');
    expect(button("确认生成整片")).toBeUndefined();
    await mount();
    expect(button("确认生成整片")).toBeUndefined();
    expect(api.request.mock.calls.some(([url]) => url.endsWith("/films"))).toBe(false);
  });

  it("previews reuse and generation without billing, then sends one acknowledged immutable plan", async () => {
    await mount();
    expect(api.request.mock.calls.some(([url]) => url.endsWith("/preview"))).toBe(false);
    await click("预览整片计划");
    const previewRequest = api.request.mock.calls.find(([url]) => url.endsWith("/preview"));
    expect(JSON.parse(previewRequest![1].body).options).toEqual({ motion: 0.5 });
    expect(container.querySelector('[aria-label="整片参数 时长（秒）"]')).toBeNull();
    expect(container.querySelector('[aria-label="整片参数 audio"]')).toBeNull();
    expect(container.querySelector('[aria-label="整片参数 画面比例"]')).toBeNull();
    expect(container.textContent).toContain("复用已有视频");
    expect(container.textContent).toContain("提交 1 个新视频任务，同一账号最多同时生成 10 个镜头");
    expect(button("确认生成整片")!.disabled).toBe(true);
    expect(api.request.mock.calls.some(([url]) => url.endsWith("/films"))).toBe(false);
    await act(async () => checkbox("确认整片视频计费").click());
    await act(async () => { button("确认生成整片")!.click(); button("确认生成整片")!.click(); });
    const calls = api.request.mock.calls.filter(([url]) => url.endsWith("/films"));
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0][1].body)).toMatchObject({ planId: "film-1", planHash: "frozen-plan", explicitConfirmation: true, billingAcknowledgement: { policyRevision: "film-credits-v1", acceptedForPlanHash: "frozen-plan" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("invalidates the plan and acknowledgement when video parameters change", async () => {
    await mount(); await click("预览整片计划");
    await act(async () => checkbox("确认整片视频计费").click());
    const duration = container.querySelector('[aria-label="整片参数 motion"]') as HTMLSelectElement;
    await act(async () => { duration.value = "1"; duration.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(button("确认生成整片")).toBeUndefined();
    expect(api.request.mock.calls.some(([url]) => url.endsWith("/films"))).toBe(false);
  });

  it("offers overlay narration with voice selection and sends both settings to the preview", async () => {
    await mount();
    const strategy = container.querySelector('[aria-label="整片声音策略"]') as HTMLSelectElement;
    expect(strategy.value).toBe("edge-tts");
    expect([...strategy.options].map((option) => option.textContent)).toEqual([
      "免费 Edge 配音，替换镜头原声音", "免费 Edge 配音，叠加镜头原声音", "优先保留原声音，无音轨时自动配音",
    ]);
    await select("整片声音策略", "edge-tts-mix");
    await select("整片配音音色", "zh-CN-YunxiNeural");
    preview.output = { ...preview.output, audioStrategy: "edge-tts-mix", voice: "zh-CN-YunxiNeural" };
    await click("预览整片计划");
    const request = api.request.mock.calls.find(([url]) => url.endsWith("/preview"));
    expect(JSON.parse(request![1].body).output).toMatchObject({ audioStrategy: "edge-tts-mix", voice: "zh-CN-YunxiNeural" });
    expect(container.querySelector('[aria-label="整片计划"]')?.textContent).toContain("Edge 配音叠加原声音");
    expect(api.request.mock.calls.some(([url]) => url.endsWith("/films"))).toBe(false);
  });

  it("revokes an acknowledged plan when switching audio strategies and requires a fresh acknowledgement", async () => {
    await mount(); await click("预览整片计划");
    await act(async () => checkbox("确认整片视频计费").click());
    expect(button("确认生成整片")!.disabled).toBe(false);
    await select("整片声音策略", "edge-tts-mix");
    expect(button("确认生成整片")).toBeUndefined();
    await select("整片声音策略", "native");
    expect(container.querySelector('[aria-label="整片配音音色"]')).toBeNull();
    await select("整片声音策略", "edge-tts");
    expect(container.querySelector('[aria-label="整片配音音色"]')).not.toBeNull();
    await click("预览整片计划");
    expect(checkbox("确认整片视频计费").checked).toBe(false);
    expect(button("确认生成整片")!.disabled).toBe(true);
    expect(api.request.mock.calls.some(([url]) => url.endsWith("/films"))).toBe(false);
  });

  it.each([
    ["edge-tts", "Edge 配音替换原声音"],
    ["edge-tts-mix", "Edge 配音叠加原声音"],
    ["native", "优先保留原声音，无音轨时自动配音"],
  ] as const)("shows the saved %s audio strategy in the recovered plan summary", async (audioStrategy, summary) => {
    preview = { ...preview, status: "completed", output: { ...preview.output, audioStrategy } };
    await mount("film-1");
    expect(container.querySelector('[aria-label="整片计划"]')?.textContent).toContain(summary);
    expect(api.request.mock.calls.some(([url]) => url.endsWith("/preview") || url.endsWith("/films"))).toBe(false);
  });

  it("leaves declared native-audio parameters under the film audio strategy", async () => {
    api.request.mockImplementation(async (url: string) => url.includes("/status")
      ? json({ loggedIn: true, models: [{ ...model, parameters: [...model.parameters, { name: "enable_audio", type: "boolean", required: true, default: false }] }] })
      : url.includes("?projectId=") ? json({ runs: [] }) : json(preview));
    await mount();
    expect(container.querySelector('[aria-label="整片参数 生成声音"]')).toBeNull();
    await select("整片声音策略", "edge-tts-mix");
    await click("预览整片计划");
    const request = api.request.mock.calls.find(([url]) => url.endsWith("/preview"));
    expect(JSON.parse(request![1].body).options).toEqual({ motion: 0.5 });
  });

  it("requires separate image charges and preserves existing shots when keyframes are missing", async () => {
    preview.missingKeyframes = [2]; preview.shots[1].missingKeyframe = true;
    await mount(); await click("预览整片计划");
    expect(button("确认生成整片")).toBeUndefined();
    expect(button("确认补齐关键帧")!.disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => checkbox("确认关键帧图片计费").click()); await click("确认补齐关键帧");
    const grid = fetchMock.mock.calls.find(([url]) => url.endsWith("/storyboard-grid"));
    expect(grid).toBeTruthy();
    expect(JSON.parse(grid![1].body)).toMatchObject({ scriptId: "script", preserveExisting: true, reuseExisting: true, productImageUrls: ["/api/files/product.jpg"] });
    expect(button("确认生成整片")).toBeUndefined();
    expect(api.request.mock.calls.some(([url]) => url.endsWith("/films"))).toBe(false);
  });

  it("stops before grid and video generation if the selected presenter cannot be found", async () => {
    preview.missingKeyframes = [2]; preview.shots[1].missingKeyframe = true;
    await mount(undefined, "missing-presenter"); await click("预览整片计划");
    await act(async () => checkbox("确认关键帧图片计费").click()); await click("确认补齐关键帧");
    expect(container.textContent).toContain("所选主播在人物库中不存在");
    expect(fetchMock.mock.calls.some(([url]) => /storyboard-grid|characters\/sheet/.test(url))).toBe(false);
    expect(api.request.mock.calls.some(([url]) => url.endsWith("/films"))).toBe(false);
  });

  it("stops after a failed presenter sheet without starting the grid or videos", async () => {
    preview.missingKeyframes = [2]; preview.shots[1].missingKeyframe = true;
    useCharacterStore.setState({ characters: [{ id: "presenter", name: "Presenter", appearance: "A host", referenceImages: [] }] });
    fetchMock.mockImplementation(async (url: string) => url.endsWith("/characters/sheet") ? json({ error: "Sheet generation failed" }, 502) : json({ productImages: [] }));
    await mount(undefined, "presenter"); await click("预览整片计划");
    await act(async () => checkbox("确认关键帧图片计费").click()); await click("确认补齐关键帧");
    expect(container.textContent).toContain("Sheet generation failed");
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/storyboard-grid"))).toBe(false);
    expect(api.request.mock.calls.some(([url]) => url.endsWith("/films"))).toBe(false);
  });

  it("uses all uploaded portraits for a presenter without an appearance description before preparing keyframes", async () => {
    preview.missingKeyframes = [2]; preview.shots[1].missingKeyframe = true;
    const portraits = ["/api/files/characters/front.png", "/api/files/characters/side.png"];
    useCharacterStore.setState({ characters: [{ id: "presenter", name: "Presenter", appearance: "", referenceImages: [], sourceReferenceImages: portraits }] });
    await mount(undefined, "presenter"); await click("预览整片计划");
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/characters/sheet"))).toBe(false);
    await act(async () => checkbox("确认关键帧图片计费").click()); await click("确认补齐关键帧");
    const sheet = fetchMock.mock.calls.find(([url]) => url.endsWith("/characters/sheet"));
    expect(JSON.parse(sheet![1].body)).toMatchObject({ name: "Presenter", appearance: "", referenceImageUrls: portraits });
    const grid = fetchMock.mock.calls.find(([url]) => url.endsWith("/storyboard-grid"));
    expect(JSON.parse(grid![1].body).characterSheetUrl).toBe("/api/files/sheet.jpg");
    expect(useCharacterStore.getState().characters[0]).toMatchObject({ referenceImages: ["/api/files/sheet.jpg"], sourceReferenceImages: portraits });
    expect(api.request.mock.calls.some(([url]) => url.endsWith("/films"))).toBe(false);
  });

  it("does not submit the next paid grid step if the panel unmounts while a presenter sheet is generating", async () => {
    preview.missingKeyframes = [2]; preview.shots[1].missingKeyframe = true;
    useCharacterStore.setState({ characters: [{ id: "presenter", name: "Presenter", appearance: "A host", referenceImages: [] }] });
    let finishSheet!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finishSheet = resolve; });
    fetchMock.mockImplementation(async (url: string) => url.endsWith("/characters/sheet") ? pending : json({ productImages: [] }));
    await mount(undefined, "presenter"); await click("预览整片计划");
    await act(async () => checkbox("确认关键帧图片计费").click()); await click("确认补齐关键帧");
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/characters/sheet"))).toBe(true);
    await act(async () => root.render(null));
    await act(async () => finishSheet(json({ url: "/api/files/new-sheet.jpg" })));
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/storyboard-grid"))).toBe(false);
    expect(api.request.mock.calls.some(([url]) => url.endsWith("/films"))).toBe(false);
  });

  it("discards a late sheet after the presenter's portraits change and stops keyframe preparation", async () => {
    preview.missingKeyframes = [2]; preview.shots[1].missingKeyframe = true;
    useCharacterStore.setState({ characters: [{ id: "presenter", name: "Presenter", referenceImages: [], sourceReferenceImages: ["/old-photo.png"] }] });
    let finishSheet!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finishSheet = resolve; });
    fetchMock.mockImplementation(async (url: string) => url.endsWith("/characters/sheet") ? pending : json({ productImages: [] }));
    await mount(undefined, "presenter"); await click("预览整片计划");
    await act(async () => checkbox("确认关键帧图片计费").click()); await click("确认补齐关键帧");
    await act(async () => useCharacterStore.getState().updateCharacter("presenter", { sourceReferenceImages: ["/new-photo.png"], referenceImages: [] }));
    await act(async () => finishSheet(json({ url: "/old-face-sheet.png" })));
    expect(useCharacterStore.getState().characters[0].referenceImages).toEqual([]);
    expect(container.textContent).toContain("主播参考图或外貌描述已变化");
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/storyboard-grid"))).toBe(false);
    expect(api.request.mock.calls.some(([url]) => url.endsWith("/films"))).toBe(false);
  });

  it("opens original unknown or import-failed jobs and never offers a billable shot retry", async () => {
    preview = { ...preview, status: "needs_attention", allowedActions: ["resume", "cancel"], shots: [{ ...preview.shots[1], status: "needs_attention", jobId: "original-job", error: "Import failed", allowedActions: [] }] };
    await mount("film-1");
    expect(button("准备重试镜头")).toBeUndefined();
    await click("查看 / 恢复镜头 2 原任务");
    expect(onOpenJob).toHaveBeenCalledWith("original-job");
    expect(button("确认恢复并继续")!.disabled).toBe(true);
    await act(async () => checkbox("确认整片恢复计费").click()); await click("确认恢复并继续");
    const resume = api.request.mock.calls.find(([url]) => url.endsWith("/resume"));
    expect(JSON.parse(resume![1].body)).toMatchObject({ planHash: "frozen-plan", explicitConfirmation: true });
    expect(api.request.mock.calls.some(([url]) => url.endsWith("/preview") || url.endsWith("/retry-shot") || url === "/api/ai/video")).toBe(false);
  });

  it("requires new explicit charges for server-authorized failed-shot regeneration", async () => {
    preview = { ...preview, status: "needs_attention", allowedActions: ["retry-shot"], shots: [{ ...preview.shots[1], status: "needs_attention", jobId: "failed-job", allowedActions: ["retry-shot"] }] };
    await mount("film-1"); await click("准备重试镜头 2");
    expect(button("确认重新生成镜头 2")!.disabled).toBe(true);
    expect(api.request.mock.calls.some(([url]) => url.endsWith("/retry-shot"))).toBe(false);
    await act(async () => checkbox("确认整片恢复计费").click()); await click("确认重新生成镜头 2");
    const retry = api.request.mock.calls.find(([url]) => url.endsWith("/retry-shot"));
    expect(JSON.parse(retry![1].body)).toMatchObject({ shotId: 2, planHash: "frozen-plan", explicitConfirmation: true });
  });

  it("recovers local composition without billing and shows completed playback/download", async () => {
    preview = { ...preview, status: "needs_attention", allowedActions: ["retry-compose"], error: "Encoder failed" };
    api.request.mockImplementation(async (url: string) => url.includes("/status") ? json({ loggedIn: true, models: [model] }) : url.includes("?projectId=") ? json({ runs: [preview] }) : url.endsWith("/retry-compose") ? json({ run: { ...preview, status: "completed", videoUrl: "/api/files/film.mp4", allowedActions: [] } }) : json(preview));
    await mount("film-1"); await click("重试本地合成");
    const retry = api.request.mock.calls.find(([url]) => url.endsWith("/retry-compose"));
    expect(JSON.parse(retry![1].body)).toEqual({});
    expect(container.querySelector("video")?.getAttribute("src")).toBe("/api/files/film.mp4");
    expect(container.querySelector('a[download]')?.getAttribute("href")).toBe("/api/files/film.mp4");
    expect(api.request.mock.calls.some(([url]) => url.endsWith("/films"))).toBe(false);
  });

  it("asks before deleting and allows cancellation without opening or deleting the record", async () => {
    preview.allowedActions = ["delete"];
    mockFilmRecords([preview]);
    await mount();
    const requestsBefore = api.request.mock.calls.length;
    await act(async () => deleteButton("film-1").click());
    expect(container.querySelector('[aria-label="删除整片记录确认"]')?.textContent).toContain("删除后无法恢复此整片计划记录。已生成的镜头素材和成片视频会保留。");
    expect(api.request.mock.calls).toHaveLength(requestsBefore);
    expect(container.querySelector("button button")).toBeNull();
    await click("取消删除");
    expect(container.querySelector('[aria-label="删除整片记录确认"]')).toBeNull();
    expect(deleteButton("film-1")).not.toBeNull();
    expect(container.querySelector('[aria-label="整片计划"]')).toBeNull();
    expect(deleteRequests()).toHaveLength(0);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("deletes the current draft, clears its billing acknowledgement and refreshes the task feed", async () => {
    preview.allowedActions = ["delete"];
    const taskFeedChanged = vi.fn();
    window.addEventListener("clipforge:task-feed-refresh", taskFeedChanged);
    try {
      mockFilmRecords([], (_url, options) => options?.method === "DELETE" ? Promise.resolve(json({ deleted: true })) : undefined);
      await mount(); await click("预览整片计划");
      await act(async () => checkbox("确认整片视频计费").click());
      expect(button("确认生成整片")!.disabled).toBe(false);
      await act(async () => deleteButton("film-1").click());
      await click("确认删除记录");
      expect(deleteRequests()).toHaveLength(1);
      expect(deleteRequests()[0][0]).toBe("/api/integrations/kling/films/film-1");
      expect(deleteButton("film-1")).toBeNull();
      expect(container.querySelector('[aria-label="整片计划"]')).toBeNull();
      expect(checkbox("确认整片视频计费")).toBeNull();
      expect(button("预览整片计划")!.disabled).toBe(false);
      expect(taskFeedChanged).toHaveBeenCalledTimes(1);
      expect(onOpenChange).not.toHaveBeenCalled();
      preview = { ...preview, runId: "film-new" };
      await click("预览整片计划");
      expect(checkbox("确认整片视频计费").checked).toBe(false);
      expect(button("确认生成整片")!.disabled).toBe(true);
    } finally {
      window.removeEventListener("clipforge:task-feed-refresh", taskFeedChanged);
    }
  });

  it("deletes another record with an encoded id while preserving the open plan and playback", async () => {
    const current: KlingFilmView = { ...preview, status: "completed", videoUrl: "/api/files/keep.mp4", allowedActions: ["delete"] };
    const other: KlingFilmView = { ...preview, runId: "film/other", allowedActions: ["delete"] };
    mockFilmRecords([current, other], (_url, options) => options?.method === "DELETE" ? Promise.resolve(json({ deleted: true })) : undefined);
    await mount("film-1");
    const readsBefore = api.request.mock.calls.filter(([url, options]) => url.includes("/films/") && !options?.method).length;
    await act(async () => deleteButton(other.runId).click());
    await click("确认删除记录");
    expect(deleteRequests()).toHaveLength(1);
    expect(deleteRequests()[0][0]).toBe("/api/integrations/kling/films/film%2Fother");
    expect(api.request.mock.calls.filter(([url, options]) => url.includes("/films/") && !options?.method)).toHaveLength(readsBefore);
    expect(deleteButton(other.runId)).toBeNull();
    expect(deleteButton(current.runId)).not.toBeNull();
    expect(container.querySelector("video")?.getAttribute("src")).toBe("/api/files/keep.mp4");
    expect(container.querySelector('[aria-label="整片计划"]')).not.toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it.each(["current", "other"] as const)("preserves the %s record and open plan on deletion failure, then allows retry", async (target) => {
    const current: KlingFilmView = { ...preview, status: "completed", videoUrl: "/api/files/keep.mp4", allowedActions: ["delete"] };
    const other: KlingFilmView = { ...preview, runId: "film-other", allowedActions: ["delete"] };
    let attempts = 0;
    mockFilmRecords([current, other], (_url, options) => options?.method === "DELETE"
      ? Promise.resolve(++attempts === 1 ? json({ error: "删除记录失败，请重试" }, 500) : json({ deleted: true })) : undefined);
    await mount("film-1");
    const targetRunId = target === "current" ? current.runId : other.runId;
    await act(async () => deleteButton(targetRunId).click());
    await click("确认删除记录");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("删除记录失败，请重试");
    expect(deleteButton(targetRunId)).not.toBeNull();
    expect(container.querySelector("video")?.getAttribute("src")).toBe("/api/files/keep.mp4");
    expect(container.querySelector('[aria-label="整片计划"]')).not.toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    if (!button("确认删除记录")) await act(async () => deleteButton(targetRunId).click());
    await click("确认删除记录");
    expect(deleteRequests()).toHaveLength(2);
    expect(deleteButton(targetRunId)).toBeNull();
    expect(Boolean(container.querySelector('[aria-label="整片计划"]'))).toBe(target === "other");
    if (target === "current") expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    else expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("submits one deletion on a double click and disables repeated actions until it finishes", async () => {
    preview.allowedActions = ["delete"];
    let finishDelete!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finishDelete = resolve; });
    mockFilmRecords([preview], (_url, options) => options?.method === "DELETE" ? pending : undefined);
    await mount();
    await act(async () => deleteButton("film-1").click());
    const confirm = button("确认删除记录")!;
    await act(async () => { confirm.click(); confirm.click(); });
    expect(deleteRequests()).toHaveLength(1);
    expect(button("正在删除")!.disabled).toBe(true);
    expect(deleteButton("film-1").disabled).toBe(true);
    expect(button("取消删除")!.disabled).toBe(true);
    await act(async () => finishDelete(json({ deleted: true })));
    expect(deleteButton("film-1")).toBeNull();
  });

  it.each(["running", "paused", "needs_attention", "composing"] as const)("requires stopping a %s plan before deleting its record", async (status) => {
    mockFilmRecords([{ ...preview, status, allowedActions: ["cancel"] }]);
    await mount();
    const remove = deleteButton("film-1");
    expect(remove.disabled).toBe(true);
    expect(remove.title).toContain("停止");
    await act(async () => remove.click());
    expect(container.querySelector('[aria-label="删除整片记录确认"]')).toBeNull();
    expect(deleteRequests()).toHaveLength(0);
  });

  it.each(["detail", "list"] as const)("does not resurrect a deleted plan when an earlier %s request returns", async (source) => {
    preview = { ...preview, status: "completed", allowedActions: ["delete"] };
    let finishRead!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finishRead = resolve; });
    let delayRead = false;
    mockFilmRecords([preview], (url, options) => {
      if (options?.method === "DELETE") return Promise.resolve(json({ deleted: true }));
      const matches = source === "detail" ? url.endsWith("/film-1") : url.includes("?projectId=");
      return delayRead && matches ? pending : undefined;
    });
    await mount("film-1");
    delayRead = true;
    await click(source === "detail" ? "查询原整片进度" : "刷新记录");
    await act(async () => deleteButton("film-1").click());
    await click("确认删除记录");
    expect(deleteButton("film-1")).toBeNull();
    expect(container.querySelector('[aria-label="整片计划"]')).toBeNull();
    await act(async () => finishRead(json(source === "detail" ? preview : { runs: [preview] })));
    expect(deleteButton("film-1")).toBeNull();
    expect(container.querySelector('[aria-label="整片计划"]')).toBeNull();
    expect(button("预览整片计划")!.disabled).toBe(false);
  });
});
