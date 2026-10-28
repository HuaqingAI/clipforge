import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoryboardFilmPanel } from "@/components/storyboard-film-panel";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { useCharacterStore } from "@/lib/stores/project-store";
import type { KlingFilmView } from "@/lib/kling/film-types";
import type { KlingVideoModelDescriptor } from "@/lib/kling/types";

const api = vi.hoisted(() => ({ kling: vi.fn(), resolve: vi.fn() }));
vi.mock("@/lib/kling/client", () => ({ klingFetch: api.kling, klingErrorMessage: (body: { error?: string }) => body.error ?? "Kling 操作失败" }));
vi.mock("@/lib/gen-params", async (original) => ({ ...await original<typeof import("@/lib/gen-params")>(), resolveDefaultModelTarget: api.resolve }));
vi.mock("@/components/kling-job-detail", () => ({ KlingJobDetail: () => null }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? children : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

const arkModel = "doubao-seedance-2.5";
const model: KlingVideoModelDescriptor = { selectionKey: '["kling-cli","image_to_video","chosen-model"]', provider: "kling-cli", profileId: "profile", region: "global", tool: "image_to_video", remoteModelId: "chosen-model", displayName: "Chosen Kling Model", catalogRevision: "revision", available: true, parameters: [{ name: "duration", type: "number", required: true, allowedValues: [5], default: 5 }], inputSlots: [{ name: "image", role: "image", required: true }], capabilities: { image: true, tailFrame: false, multiImage: false, audio: false } };
const originalRun: KlingFilmView = { runId: "original-film", projectId: "project", scriptId: "script", profileId: "profile", planHash: "original-plan-hash", expiresAt: "2099-01-01T00:00:00Z", status: "paused", stage: "paused", model, output: { resolution: "720p", aspectRatio: "9:16", audioStrategy: "edge-tts", voice: "zh-CN-XiaoxiaoNeural", subtitles: true }, shots: [{ id: "shot-1", shotId: 1, status: "waiting", source: "generate", prompt: "Original prompt", duration: 5, generationDuration: 5, missingKeyframe: false, options: { duration: 5 }, attempt: 0 }], totalShots: 1, readyShots: 0, billableShotCount: 1, missingKeyframes: [], warnings: [], allowedActions: ["resume", "cancel"], createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z" };
const filmPreview = { prompt: "Prepared visual prompt", model: arkModel, shotCount: 1, seconds: 5, scriptSeconds: 5, durationOverflow: false, modelMaxSeconds: 30, referenceImages: 1, referenceQuota: { ok: true, count: 1, limit: 9 }, dialogueWarnings: [], estimate: { unitUsd: 0.1, seconds: 5, minUsd: 0.5, maxUsd: 1, tierMultiplier: 2 } };
const initialSettings = useSettingsStore.getInitialState();
const initialCharacters = useCharacterStore.getInitialState();
const fetchMock = vi.fn();
const assetsChanged = vi.fn();
let root: Root, container: HTMLDivElement;
let filmResponse: Response;
let savedTasks: Array<Record<string, unknown>>;
const json = (value: unknown, status = 200) => Response.json(value, { status });
function button(text: string): HTMLButtonElement | undefined { return [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(text)); }
function checkbox(name: string) { return container.querySelector(`[aria-label="${name}"]`) as HTMLInputElement; }
async function click(text: string) { await act(async () => button(text)!.click()); }
async function mount(open = true, initialRunId?: string, initialTaskId?: string) { await act(async () => root.render(<StoryboardFilmPanel open={open} onOpenChange={() => undefined} projectId="project" scriptId="script" initialRunId={initialRunId} initialTaskId={initialTaskId} onAssetsChanged={assetsChanged} />)); }
function generationCalls() { return fetchMock.mock.calls.filter(([url, init]) => /storyboard-grid|characters\/sheet/.test(url) || (url.endsWith("/storyboard-film") && !JSON.parse(init.body).dryRun && JSON.parse(init.body).action !== "recover")); }
async function confirmAndGenerate() { await act(async () => checkbox("确认整片视频计费").click()); await click("确认生成整片"); }

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", fetchMock);
  useSettingsStore.setState({ ...initialSettings, defaultVideoModel: arkModel, defaultImageModel: "image-model", providers: { "volcengine": { enabled: true, apiKey: "ark-key" }, "kling-cli": { enabled: true, profileId: "profile", apiKey: "" } } });
  useCharacterStore.setState({ ...initialCharacters, characters: [] });
  assetsChanged.mockReset(); savedTasks = []; filmResponse = json({ url: "/api/files/film.mp4" });
  api.resolve.mockReset().mockImplementation(async (_providers: unknown, selected: string, _custom: unknown, mediaType: string) => selected === "unavailable" ? null : { provider: mediaType === "image" ? "images" : "volcengine", model: selected, apiKey: "fixture-key" });
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/project/project") return json({ productImages: ["/api/files/product-1.png", "/api/files/product-2.png"] });
    if (url.startsWith("/api/ai/tasks?")) return json(savedTasks);
    if (url.endsWith("/storyboard-grid")) return json({ reused: true });
    if (url.endsWith("/storyboard-film")) return JSON.parse(String(init?.body)).dryRun ? json(filmPreview) : filmResponse.clone();
    throw new Error("Unexpected request: " + url);
  });
  api.kling.mockReset().mockImplementation(async (url: string) => {
    if (url.includes("/status")) return json({ loggedIn: true, models: [model] });
    if (url.includes("?projectId=")) return json({ runs: [originalRun] });
    if (url.endsWith("/resume")) return json({ run: { ...originalRun, status: "running", allowedActions: ["pause", "cancel"] } });
    if (url.endsWith("/original-film")) return json(originalRun);
    throw new Error("Unexpected Kling request: " + url);
  });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useSettingsStore.setState(initialSettings); useCharacterStore.setState(initialCharacters); vi.unstubAllGlobals(); });

describe("shared model-driven full-film interaction", () => {
  it("opens the same film surface using the global default and does not generate before review", async () => {
    await mount();
    expect(container.querySelector("h2")?.textContent).toBe("整片自动编排");
    expect(container.textContent).toContain("一次生成整片");
    expect(api.kling).not.toHaveBeenCalled();
    expect(generationCalls()).toHaveLength(0);
    await click("预览整片计划");
    expect(button("确认生成整片")!.disabled).toBe(true);
    expect(generationCalls()).toHaveLength(0);
    expect(container.textContent).toContain("已关联 2 张商品图");
    expect(container.querySelector('[aria-label="整片模型"]')).toBeNull();
    const request = fetchMock.mock.calls.find(([url]) => url.endsWith("/storyboard-film"))!;
    expect(JSON.parse(request[1].body)).toMatchObject({ model: arkModel, dryRun: true });
  });

  it("revokes confirmation when the default changes, including switching back to the old default", async () => {
    await mount(); await click("预览整片计划");
    await act(async () => checkbox("确认整片视频计费").click());
    expect(button("确认生成整片")!.disabled).toBe(false);
    await act(async () => useSettingsStore.getState().setDefaultVideoModel(model.selectionKey));
    expect(button("确认生成整片")!.disabled).toBe(true);
    expect(checkbox("确认整片视频计费").checked).toBe(false);
    expect(container.textContent).toContain("一次生成整片");
    await act(async () => useSettingsStore.getState().setDefaultVideoModel(arkModel));
    expect(button("确认生成整片")!.disabled).toBe(true);
    expect(generationCalls()).toHaveLength(0);
    await mount(false); await act(async () => useSettingsStore.getState().setDefaultVideoModel(model.selectionKey)); await mount();
    expect(container.textContent).toBe("");
    expect(button("预览整片计划")).toBeUndefined();
    expect(api.kling).not.toHaveBeenCalled();
  });

  it("does not replace an unavailable default with another configured model", async () => {
    useSettingsStore.getState().setDefaultVideoModel("unavailable");
    await mount(); await click("预览整片计划");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("默认视频模型不可用");
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/storyboard-film"))).toBe(false);
    expect(generationCalls()).toHaveLength(0);
  });

  it("rechecks the reviewed plan and reuses the grid only after explicit billing confirmation", async () => {
    await mount(); await click("预览整片计划"); await confirmAndGenerate();
    const relevant = fetchMock.mock.calls.filter(([url]) => /storyboard-film|storyboard-grid/.test(url));
    expect(relevant.map(([url, init]) => [url.split("/").at(-1), !!JSON.parse(init.body).dryRun])).toEqual([["storyboard-film", true], ["storyboard-film", true], ["storyboard-grid", false], ["storyboard-film", false]]);
    expect(JSON.parse(relevant[2][1].body)).toMatchObject({ reuseExisting: true, productImageUrls: ["/api/files/product-1.png", "/api/files/product-2.png"] });
    const submitted = JSON.parse(relevant[3][1].body);
    expect(submitted).toMatchObject({ model: arkModel, expectedPrompt: filmPreview.prompt });
    expect(Object.keys(submitted).sort()).toEqual(["acknowledgeOverCap", "apiKey", "expectedPrompt", "model", "options", "provider", "scriptId", "spendCapUsd"]);
    expect(container.querySelector("video")?.getAttribute("src")).toBe("/api/files/film.mp4");
    expect(assetsChanged).toHaveBeenCalledTimes(2);
  });

  it("generates a presenter sheet from every uploaded portrait even without an appearance description", async () => {
    const portraits = ["/api/files/characters/front.png", "/api/files/characters/side.png"];
    useCharacterStore.setState({ characters: [{ id: "presenter", name: "Presenter", appearance: "", referenceImages: [], sourceReferenceImages: portraits }] });
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/project/project") return json({ characterId: "presenter", productImages: [] });
      if (url.endsWith("/characters/sheet")) return json({ url: "/api/files/characters/sheet.png" });
      return normalFetch(url, init);
    });
    await mount(); await click("预览整片计划");
    expect(generationCalls()).toHaveLength(0);
    await confirmAndGenerate();
    const sheet = fetchMock.mock.calls.find(([url]) => url.endsWith("/characters/sheet"));
    expect(JSON.parse(sheet![1].body)).toMatchObject({ name: "Presenter", appearance: "", referenceImageUrls: portraits });
    const grid = fetchMock.mock.calls.find(([url]) => url.endsWith("/storyboard-grid"));
    expect(JSON.parse(grid![1].body).characterSheetUrl).toBe("/api/files/characters/sheet.png");
    expect(useCharacterStore.getState().characters[0]).toMatchObject({ referenceImages: ["/api/files/characters/sheet.png"], sourceReferenceImages: portraits });
    expect(container.querySelector("video")?.getAttribute("src")).toBe("/api/files/film.mp4");
  });

  it("does not restore a stale face or continue generating when the presenter photos change during sheet generation", async () => {
    useCharacterStore.setState({ characters: [{ id: "presenter", name: "Presenter", referenceImages: [], sourceReferenceImages: ["/old-photo.png"] }] });
    let finishSheet!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finishSheet = resolve; });
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/project/project") return json({ characterId: "presenter", productImages: [] });
      if (url.endsWith("/characters/sheet")) return pending;
      return normalFetch(url, init);
    });
    await mount(); await click("预览整片计划"); await confirmAndGenerate();
    await act(async () => useCharacterStore.getState().updateCharacter("presenter", { sourceReferenceImages: ["/new-photo.png"], referenceImages: [] }));
    await act(async () => finishSheet(json({ url: "/old-face-sheet.png" })));
    expect(useCharacterStore.getState().characters[0].referenceImages).toEqual([]);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("主播参考图或外貌描述已变化");
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/storyboard-grid"))).toBe(false);
    expect(generationCalls()).toHaveLength(1);
  });

  it("keeps moderation rejection visible and requires the charged redraw entry instead of repeating normal submit", async () => {
    filmResponse = json({ error: "镜头 1 的关键帧被审核拒绝", errorCode: "InputImageSensitiveContentDetected", rejectedReference: { kind: "keyframe", shotId: 1, url: "/api/files/rejected.png" } }, 400);
    await mount(); await click("预览整片计划"); await confirmAndGenerate();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("镜头 1");
    expect(container.querySelector('img[src="/api/files/rejected.png"]')).toBeTruthy();
    await act(async () => checkbox("确认整片视频计费").click());
    expect(button("确认生成整片")!.disabled).toBe(true);
    expect(button("重新绘制分镜并生成视频")!.disabled).toBe(false);
    await click("重新绘制分镜并生成视频");
    const grids = fetchMock.mock.calls.filter(([url]) => url.endsWith("/storyboard-grid"));
    expect(grids.map(([, init]) => JSON.parse(init.body).reuseExisting)).toEqual([true, false]);
  });

  it("blocks ordinary resubmission of an uncertain original task after closing and reopening", async () => {
    filmResponse = json({ error: "任务仍在处理中", taskId: "remote-original", recoverable: true }, 502);
    await mount(); await click("预览整片计划"); await confirmAndGenerate();
    expect(container.textContent).toContain("remote-original");
    expect(button("确认生成整片")).toBeUndefined();
    savedTasks = [{ id: "saved-original", taskId: "remote-original", provider: "volcengine", model: arkModel, mode: "video-to-video", shotId: null }];
    await mount(false); await mount();
    expect(container.textContent).toContain("remote-original");
    const previewButton = button("预览整片计划");
    expect(!previewButton || previewButton.disabled).toBe(true);
    expect(generationCalls().filter(([url]) => url.endsWith("/storyboard-film"))).toHaveLength(1);
  });

  it("keeps an explicitly opened Kling run as history when the global model changes", async () => {
    await mount(true, "original-film");
    expect(container.querySelector("h2")?.textContent).toBe("Kling 历史整片记录");
    expect(container.textContent).toContain("Chosen Kling Model");
    expect(container.textContent).toContain("chosen-model");
    expect(button("确认恢复并继续")).toBeUndefined();
    expect(button("预览整片计划")).toBeUndefined();
    await act(async () => useSettingsStore.getState().setDefaultVideoModel(model.selectionKey));
    await act(async () => useSettingsStore.getState().setDefaultVideoModel(arkModel));
    expect(container.querySelector("h2")?.textContent).toBe("Kling 历史整片记录");
    expect(api.kling.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
    expect(api.kling.mock.calls.some(([url]) => url.includes("/status"))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([model.selectionKey, '["kling-cli","image_to_video","missing-model"]'])("opens no new full-film surface and never falls back to Ark for Kling default %s", async (selection) => {
    useSettingsStore.getState().setDefaultVideoModel(selection);
    await mount();
    expect(container.textContent).toBe("");
    expect(button("预览整片计划")).toBeUndefined();
    expect(api.kling).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.resolve).not.toHaveBeenCalled();
    await act(async () => useSettingsStore.getState().setDefaultVideoModel(arkModel));
    expect(container.textContent).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([arkModel, model.selectionKey])("recovers an explicitly opened Ark task using its original model when the current default is %s", async (defaultModel) => {
    const originalModel = "doubao-seedance-2.0";
    useSettingsStore.getState().setDefaultVideoModel(defaultModel);
    savedTasks = [{ id: "saved-original", taskId: "remote-original", provider: "volcengine", model: originalModel, mode: "video-to-video", shotId: null }];
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/storyboard-film") && JSON.parse(String(init?.body)).action === "recover") { savedTasks = []; return json({ url: "/api/files/recovered-film.mp4", model: originalModel }); }
      return normalFetch(url, init);
    });
    await mount(true, undefined, "remote-original"); await click("查看 / 恢复原任务");
    const recovery = fetchMock.mock.calls.find(([url]) => url.endsWith("/storyboard-film"))!;
    expect(JSON.parse(recovery[1].body)).toMatchObject({ action: "recover", taskId: "remote-original", provider: "volcengine", apiKey: "ark-key" });
    expect(JSON.parse(recovery[1].body).model).toBeUndefined();
    expect(api.resolve).not.toHaveBeenCalled();
    expect(api.kling).not.toHaveBeenCalled();
    expect(generationCalls()).toHaveLength(0);
    expect(container.textContent).toContain(originalModel);
    expect(container.querySelector("video")?.getAttribute("src")).toBe("/api/files/recovered-film.mp4");
  });

  it("waits for persisted task checks before allowing a new preview", async () => {
    let finishTasks!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finishTasks = resolve; });
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => url.startsWith("/api/ai/tasks?") ? pending : normalFetch(url, init));
    await mount();
    expect(button("预览整片计划")!.disabled).toBe(true);
    expect(api.resolve).not.toHaveBeenCalled();
    await act(async () => finishTasks(json([])));
    expect(button("预览整片计划")!.disabled).toBe(false);
  });

  it("requires renewed review when the server plan changes before paid keyframe generation", async () => {
    let previews = 0;
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/storyboard-film") && JSON.parse(String(init?.body)).dryRun) { previews++; return json({ ...filmPreview, ...(previews > 1 && { prompt: "Changed script prompt" }) }); }
      return normalFetch(url, init);
    });
    await mount(); await click("预览整片计划"); await confirmAndGenerate();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("重新确认");
    expect(container.textContent).toContain("Changed script prompt");
    expect(checkbox("确认整片视频计费").checked).toBe(false);
    expect(button("确认生成整片")!.disabled).toBe(true);
    expect(generationCalls()).toHaveLength(0);
  });

  it("blocks new preview after a failed task-record refresh until records are successfully loaded again", async () => {
    await mount();
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => url.startsWith("/api/ai/tasks?") ? json({ error: "Task records unavailable" }, 502) : normalFetch(url, init));
    await click("刷新记录");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Task records unavailable");
    expect(button("预览整片计划")!.disabled).toBe(true);
    expect(generationCalls()).toHaveLength(0);
    fetchMock.mockImplementation(normalFetch);
    await click("刷新记录");
    expect(button("预览整片计划")!.disabled).toBe(false);
  });

  it("stops the remaining paid chain if the film panel unmounts while keyframes are being prepared", async () => {
    let finishGrid!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finishGrid = resolve; });
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => url.endsWith("/storyboard-grid") ? pending : normalFetch(url, init));
    await mount(); await click("预览整片计划"); await confirmAndGenerate();
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/storyboard-grid"))).toHaveLength(1);
    await mount(false);
    await act(async () => finishGrid(json({ reused: true })));
    expect(generationCalls().filter(([url]) => url.endsWith("/storyboard-film"))).toHaveLength(0);
  });
});
