import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AssetsPage from "@/app/project/[id]/assets/page";
import { useSettingsStore } from "@/lib/stores/settings-store";
import type { KlingVideoModelDescriptor } from "@/lib/kling/types";
import type { KlingConcurrencyStatus } from "@/lib/kling/concurrency";
import type { Model } from "@/lib/providers/types";
import type { KlingJobView } from "@/lib/kling/job-types";
import { validateVideoPrompt } from "@/lib/video-prompt";
import { buildShotVideoPrompt } from "@/lib/shot-video-prompt";
import { withVideoAudioMode } from "@/lib/video-audio";

const api = vi.hoisted(() => ({ kling: vi.fn(), models: [] as Model[], jobs: [] as unknown[], concurrency: undefined as KlingConcurrencyStatus | undefined, showMaterialLibrary: false }));
const navigation = vi.hoisted(() => ({ router: { replace: vi.fn() }, listeners: new Set<() => void>() }));
vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useParams: () => ({ id: "project" }),
    useRouter: () => navigation.router,
    useSearchParams: () => new URLSearchParams(useSyncExternalStore(
      (listener) => { navigation.listeners.add(listener); return () => { navigation.listeners.delete(listener); }; },
      () => window.location.search,
    )),
  };
});
vi.mock("@/components/project-header", () => ({ ProjectHeader: () => null }));
vi.mock("@/components/model-catalog-status", () => ({ ModelCatalogStatus: () => null }));
vi.mock("@/components/model-capability-preflight", () => ({ ModelCapabilityPreflight: () => null }));
vi.mock("@/app/project/[id]/assets/_components/local-material-library", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/project/[id]/assets/_components/local-material-library")>();
  return { LocalMaterialLibrary: (props: ComponentProps<typeof actual.LocalMaterialLibrary>) => api.showMaterialLibrary ? <actual.LocalMaterialLibrary {...props} /> : null };
});
vi.mock("@/components/storyboard-film-panel", () => ({ StoryboardFilmPanel: ({ open, initialRunId, initialTaskId, onOpenChange }: { open: boolean; initialRunId?: string; initialTaskId?: string; onOpenChange(open: boolean): void }) => open ? <div aria-label="film-panel" data-run-id={initialRunId} data-task-id={initialTaskId}>{initialRunId ?? initialTaskId}<button aria-label="close-film-panel" onClick={() => onOpenChange(false)} /></div> : null }));
vi.mock("@/components/kling-job-detail", () => ({ KlingJobDetail: ({ open, jobId, onOpenChange }: { open: boolean; jobId: string | null; onOpenChange(open: boolean): void }) => open ? <div aria-label="job-detail">{jobId}<button aria-label="close-job-detail" onClick={() => onOpenChange(false)} /></div> : null, klingJobBlocksSubmission: (job: { submissionState: string }) => job.submissionState === "submission_unknown", klingJobStatus: () => "待核对" }));
vi.mock("@/lib/hooks/use-model-catalog", () => ({ useModelCatalog: () => ({ models: api.models, statuses: [], pending: false, retry: vi.fn() }) }));
vi.mock("@/lib/kling/client", () => ({ klingFetch: api.kling, klingErrorMessage: (body: { error?: string | { message: string } }) => typeof body.error === "string" ? body.error : body.error?.message ?? "Kling 操作失败" }));
vi.mock("@/lib/i18n", () => { const t = (key: string) => key; return { useT: () => t, useLocale: () => "zh" }; });
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, onOpenChange, children }: { open: boolean; onOpenChange(open: boolean): void; children: React.ReactNode }) => open ? <div><button aria-label="close-dialog" onClick={() => onOpenChange(false)}>关闭</button>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

const kling: KlingVideoModelDescriptor = { selectionKey: '["kling-cli","image_to_video","chosen"]', provider: "kling-cli", profileId: "profile", region: "global", tool: "image_to_video", remoteModelId: "chosen", displayName: "Chosen Kling", catalogRevision: "rev", available: true, parameters: [{ name: "duration", type: "number", required: true, allowedValues: [5, 10], default: 5 }], inputSlots: [{ name: "image", role: "image", required: true }], capabilities: { image: true, tailFrame: false, multiImage: false, audio: false } };
const ark = "doubao-seedance-2.5";
const initial = useSettingsStore.getInitialState();
const fetchMock = vi.fn();
let root: Root, container: HTMLDivElement, isVideo: boolean, pending: Array<Record<string, unknown>>;
function button(part: string) { return [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(part)); }
async function click(part: string) { await act(async () => button(part)!.click()); }
async function mount(defaultModel: string) { useSettingsStore.getState().setDefaultVideoModel(defaultModel); await act(async () => root.render(<AssetsPage />)); }
function changeUrl(url: string) { window.history.replaceState(null, "", url); navigation.listeners.forEach((listener) => listener()); }
async function navigate(url: string) { await act(async () => changeUrl(url)); }
function submissions() { return [...fetchMock.mock.calls, ...api.kling.mock.calls].filter(([url]) => url === "/api/ai/video"); }
function savedKlingJob(overrides: Partial<KlingJobView> = {}): KlingJobView {
  return { jobId: "saved-job", profileId: "profile", projectId: "project", scriptId: "script", shotId: 1, modelId: "chosen", tool: "image_to_video", prompt: "Product rotates", submissionState: "acknowledged", remoteState: "completed", importState: "completed", outputs: [{ outputId: "output", assetId: "asset", videoUrl: "/api/files/clip.mp4", imported: true, selected: true }], allowedActions: ["delete"], autoQueryPaused: false, needsConfirmation: false, inputSummary: [], options: {}, createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z", ...overrides };
}
function deleteVideoButton() { return container.querySelector('[aria-label="删除镜头 1 的任务"]') as HTMLButtonElement; }

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", fetchMock);
  navigation.router.replace.mockReset().mockImplementation((url: string) => changeUrl(url));
  useSettingsStore.setState({ ...initial, uiMode: "simple", locale: "zh", defaultVideoModel: ark, providers: { volcengine: { enabled: true, apiKey: "fixture" }, "kling-cli": { enabled: true, apiKey: "", profileId: "profile" } } });
  api.models = [{ id: ark, name: "Ark", provider: "volcengine", mediaType: "video", modes: ["image-to-video"] }, { id: kling.selectionKey, name: "Chosen Kling", provider: "kling-cli", mediaType: "video", modes: ["image-to-video"] }];
  api.jobs = []; api.concurrency = undefined; api.showMaterialLibrary = false; isVideo = false; pending = [];
  api.kling.mockReset().mockImplementation(async (url: string) => url.includes("/status") ? Response.json({ loggedIn: true, models: [kling], concurrency: api.concurrency }) : url.includes("/jobs?") ? Response.json({ jobs: api.jobs }) : Response.json({ jobId: "new-job" }, { status: 202 }));
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/project/project") return Response.json({ name: "Product", productImages: ["/api/files/product.jpg"] });
    if (url.endsWith("/scripts")) return Response.json([{ id: "script", selected: true, shots: [{ shotId: 1, type: "demo", duration: 5, description: "Product rotates. 底部小字：仅供展示", camera: "Slow dolly in", prompt: "STATIC IMAGE PROMPT", visualSource: "ai_generate", transition: "direct_concat" }] }]);
    if (url.endsWith("/assets")) return Response.json(init?.method === "POST" ? { filePath: "/api/files/saved.mp4" } : [{ id: "asset", shotId: 1, status: "done", selected: true, type: "ai_generate", provider: "volcengine", filePath: isVideo ? "/api/files/clip.mp4" : "/api/files/frame.jpg", thumbnailPath: isVideo ? "/api/files/frame.jpg" : null }]);
    if (url.startsWith("/api/ai/tasks?")) return Response.json(pending);
    if (url === "/api/ai/video") return Response.json({ videoUrls: ["/api/files/result.mp4"] });
    throw new Error("Unexpected request " + url);
  });
  window.history.replaceState(null, "", "/project/project/assets");
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useSettingsStore.setState(initial); vi.unstubAllGlobals(); });

describe("assets uses the configured provider through one motion entry", () => {
  it("keeps task recovery separate from deletion and does not request deletion when cancelled", async () => {
    api.jobs = [savedKlingJob()];
    await mount(kling.selectionKey);
    expect(container.querySelector("button button")).toBeNull();
    await click("查看 / 恢复");
    expect(container.querySelector('[aria-label="job-detail"]')?.textContent).toBe("saved-job");
    await act(async () => deleteVideoButton().click());
    expect(container.textContent).toContain("删除任务？");
    expect(container.textContent).toContain("本地任务记录，停止自动查询，并清理该任务已生成的本地视频");
    expect(container.textContent).not.toContain("云端任务可能继续运行");
    await click("取消");
    expect(button("确认删除")).toBeUndefined();
    expect(api.kling.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    expect(deleteVideoButton()).not.toBeNull();
  });

  it("sends one protected DELETE request and retains the video when deletion fails", async () => {
    api.jobs = [savedKlingJob()];
    await mount(kling.selectionKey);
    const original = api.kling.getMockImplementation()!;
    let finish!: (response: Response) => void;
    api.kling.mockImplementation((url: string, init?: RequestInit) => init?.method === "DELETE" ? new Promise<Response>((resolve) => { finish = resolve; }) : original(url, init));
    await act(async () => deleteVideoButton().click());
    const initialAssetsReads = fetchMock.mock.calls.filter(([url]) => url.endsWith("/assets")).length;
    await act(async () => { button("确认删除")!.click(); button("确认删除")?.click(); });
    expect(api.kling.mock.calls.filter(([, init]) => init?.method === "DELETE")).toEqual([["/api/integrations/kling/jobs/saved-job", { method: "DELETE" }]]);
    expect(button("正在删除")!.disabled).toBe(true);
    expect(deleteVideoButton().disabled).toBe(true);
    await act(async () => finish(Response.json({ error: { message: "该视频正在被整片计划使用，暂不能删除。" } }, { status: 409 })));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("该视频正在被整片计划使用，暂不能删除。");
    expect(deleteVideoButton()).not.toBeNull();
    expect(button("确认删除")!.disabled).toBe(false);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/assets"))).toHaveLength(initialAssetsReads);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("refreshes the task list, material library, shot preview and account capacity after deletion", async () => {
    api.jobs = [savedKlingJob()]; api.concurrency = { active: 1, max: 10, blockedByUnknownSubmission: false };
    api.showMaterialLibrary = true; isVideo = true;
    const originalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url.endsWith("/materials") ? Promise.resolve(Response.json({ materials: [] })) : originalFetch(url, init));
    const originalKling = api.kling.getMockImplementation()!;
    api.kling.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") { api.jobs = []; isVideo = false; api.concurrency = { active: 0, max: 10, blockedByUnknownSubmission: false }; return Promise.resolve(Response.json({ deleted: true, jobId: "saved-job" })); }
      return originalKling(url, init);
    });
    await mount(kling.selectionKey);
    expect(container.querySelector('a[href="/api/files/clip.mp4"]')).not.toBeNull();
    await click("查看 / 恢复");
    const assetsReads = fetchMock.mock.calls.filter(([url]) => url.endsWith("/assets")).length;
    const materialReads = fetchMock.mock.calls.filter(([url]) => url.endsWith("/materials")).length;
    const statusReads = api.kling.mock.calls.filter(([url]) => url.includes("/status")).length;
    await act(async () => deleteVideoButton().click());
    await click("确认删除");
    expect(container.querySelector('[aria-label="Kling 视频任务"]')).toBeNull();
    expect(container.querySelector('[aria-label="job-detail"]')).toBeNull();
    expect(container.querySelector('a[href="/api/files/clip.mp4"]')).toBeNull();
    expect(container.querySelector('img[src="/api/files/frame.jpg"]')).not.toBeNull();
    expect(container.textContent).toContain("当前账号生成名额：0 / 10");
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/assets")).length).toBeGreaterThan(assetsReads);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/materials")).length).toBeGreaterThan(materialReads);
    expect(api.kling.mock.calls.filter(([url]) => url.includes("/status")).length).toBeGreaterThan(statusReads);
    expect(button("确认删除")).toBeUndefined();
  });

  it("disables confirmation when a refreshed task is no longer deletable", async () => {
    api.jobs = [savedKlingJob()];
    await mount(kling.selectionKey);
    await act(async () => deleteVideoButton().click());
    expect(button("确认删除")!.disabled).toBe(false);
    api.jobs = [savedKlingJob({ allowedActions: [] })];
    await click("刷新本地记录");
    expect(button("确认删除")!.disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("暂不能删除");
    await click("确认删除");
    expect(api.kling.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it.each([200, 500])("ignores a pre-deletion task poll that returns late with status %i", async (status) => {
    const oldJob = savedKlingJob({ submissionState: "submission_unknown", remoteState: "unknown", importState: "not_ready", outputs: [] });
    api.jobs = [oldJob]; api.concurrency = { active: 1, max: 10, blockedByUnknownSubmission: true };
    await mount(kling.selectionKey);
    const originalKling = api.kling.getMockImplementation()!;
    let delayPoll = true;
    let finishOldPoll!: (response: Response) => void;
    api.kling.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/jobs?") && delayPoll) {
        delayPoll = false;
        return new Promise<Response>((resolve) => { finishOldPoll = resolve; });
      }
      if (init?.method === "DELETE") {
        api.jobs = []; api.concurrency = { active: 0, max: 10, blockedByUnknownSubmission: false };
        return Promise.resolve(Response.json({ deleted: true, jobId: oldJob.jobId }));
      }
      return originalKling(url, init);
    });
    await click("刷新本地记录");
    expect(finishOldPoll).toBeTypeOf("function");
    await act(async () => deleteVideoButton().click());
    await click("确认删除");
    expect(container.querySelector('[aria-label="Kling 视频任务"]')).toBeNull();
    expect(container.textContent).toContain("当前账号生成名额：0 / 10");
    await act(async () => finishOldPoll(Response.json(status === 200 ? { jobs: [oldJob] } : { error: "旧轮询失败" }, { status })));
    expect(container.querySelector('[aria-label="Kling 视频任务"]')).toBeNull();
    expect(container.textContent).toContain("当前账号生成名额：0 / 10");
    expect(container.textContent).not.toContain("旧轮询失败");
    expect(container.textContent).not.toContain("请先恢复任务列表");
  });

  it("ignores a pre-deletion material refresh that returns after the current shot was restored", async () => {
    api.jobs = [savedKlingJob()]; isVideo = true;
    await mount(kling.selectionKey);
    const originalFetch = fetchMock.getMockImplementation()!;
    let delayAssets = true;
    let finishOldAssets!: (response: Response) => void;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/assets") && delayAssets) {
        delayAssets = false;
        return new Promise<Response>((resolve) => { finishOldAssets = resolve; });
      }
      return originalFetch(url, init);
    });
    api.jobs = [savedKlingJob({ outputs: [{ outputId: "new-output", assetId: "new-asset", imported: true, selected: true }] })];
    await click("刷新本地记录");
    expect(finishOldAssets).toBeTypeOf("function");
    const originalKling = api.kling.getMockImplementation()!;
    api.kling.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") { api.jobs = []; isVideo = false; return Promise.resolve(Response.json({ deleted: true, jobId: "saved-job" })); }
      return originalKling(url, init);
    });
    await act(async () => deleteVideoButton().click());
    await click("确认删除");
    expect(container.querySelector('a[href="/api/files/clip.mp4"]')).toBeNull();
    await act(async () => finishOldAssets(Response.json([{ id: "asset", shotId: 1, status: "done", selected: true, type: "ai_generate", provider: "kling-cli", filePath: "/api/files/clip.mp4", thumbnailPath: "/api/files/frame.jpg" }])));
    expect(container.querySelector('a[href="/api/files/clip.mp4"]')).toBeNull();
    expect(container.querySelector('img[src="/api/files/frame.jpg"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Kling 视频任务"]')).toBeNull();
  });

  it("keeps the restored shot when the initial material load finishes after deletion", async () => {
    api.jobs = [savedKlingJob()]; isVideo = true;
    const originalFetch = fetchMock.getMockImplementation()!;
    let delayInitialAssets = true;
    let finishInitialAssets!: (response: Response) => void;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/assets") && delayInitialAssets) {
        delayInitialAssets = false;
        return new Promise<Response>((resolve) => { finishInitialAssets = resolve; });
      }
      return originalFetch(url, init);
    });
    const originalKling = api.kling.getMockImplementation()!;
    api.kling.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") { api.jobs = []; isVideo = false; return Promise.resolve(Response.json({ deleted: true, jobId: "saved-job" })); }
      return originalKling(url, init);
    });
    await mount(kling.selectionKey);
    expect(finishInitialAssets).toBeTypeOf("function");
    expect(container.querySelector('[data-testid="shot-material-preview"]')).toBeNull();
    await act(async () => deleteVideoButton().click());
    await click("确认删除");
    expect(container.querySelector('[aria-label="Kling 视频任务"]')).toBeNull();
    await act(async () => finishInitialAssets(Response.json([{ id: "asset", shotId: 1, status: "done", selected: true, type: "ai_generate", provider: "kling-cli", filePath: "/api/files/clip.mp4", thumbnailPath: "/api/files/frame.jpg" }])));
    expect(container.querySelector('a[href="/api/files/clip.mp4"]')).toBeNull();
    expect(container.querySelector('img[src="/api/files/frame.jpg"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="shot-material-preview"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Kling 视频任务"]')).toBeNull();
  });

  it.each([
    { submissionState: "submission_unknown", remoteState: "not_started" },
    { submissionState: "acknowledged", remoteState: "processing" },
    { submissionState: "acknowledged", remoteState: "pending" },
  ] satisfies Partial<KlingJobView>[])("lets a user confirm deletion of an unfinished local task: %j", async (state) => {
    api.jobs = [savedKlingJob({ ...state, importState: "not_ready", outputs: [] })];
    const originalKling = api.kling.getMockImplementation()!;
    api.kling.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") { api.jobs = []; return Promise.resolve(Response.json({ deleted: true, jobId: "saved-job" })); }
      return originalKling(url, init);
    });
    await mount(kling.selectionKey);
    expect(deleteVideoButton().disabled).toBe(false);
    await click("查看 / 恢复");
    await act(async () => deleteVideoButton().click());
    expect(container.querySelector("h2")?.textContent).toBe("删除任务？");
    expect(container.textContent).toContain("本地任务记录，停止自动查询");
    expect(container.textContent).toContain("云端任务可能继续运行，删除不等于取消云端生成。");
    expect(button("确认删除")!.disabled).toBe(false);
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    await click("确认删除");
    expect(api.kling.mock.calls.filter(([, init]) => init?.method === "DELETE")).toEqual([["/api/integrations/kling/jobs/saved-job", { method: "DELETE" }]]);
    expect(container.querySelector('[aria-label="Kling 视频任务"]')).toBeNull();
    expect(container.querySelector('[aria-label="job-detail"]')).toBeNull();
    expect(button("确认删除")).toBeUndefined();
  });

  it.each([
    { submissionState: "prepared" }, { submissionState: "submitting" }, { submissionState: "submission_unknown" },
    { remoteState: "pending" }, { remoteState: "processing" }, { remoteState: "unknown" },
    { importState: "importing" },
  ] satisfies Partial<KlingJobView>[])("uses server capabilities to protect a task that cannot currently be deleted: %j", async (state) => {
    api.jobs = [savedKlingJob({ ...state, allowedActions: [] })];
    await mount(kling.selectionKey);
    expect(deleteVideoButton().disabled).toBe(true);
    await act(async () => deleteVideoButton().click());
    expect(button("确认删除")).toBeUndefined();
    expect(api.kling.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    expect(button("查看 / 恢复")!.disabled).toBe(false);
  });

  it.each(["image", "video"] as const)("lets an uploaded %s replace an existing product-image shot without generating a video", async (mediaType) => {
    api.showMaterialLibrary = true;
    const material = { name: `material.${mediaType === "image" ? "webp" : "mp4"}`, originalName: "Product detail", mediaType, tags: ["product"], sizeBytes: 1024, updatedAt: 1, width: 800, height: 800,
      url: `/api/files/project/material.${mediaType === "image" ? "webp" : "mp4"}` };
    const productShots = Array.from({ length: 8 }, (_, index) => ({ shotId: index + 1, type: "demo", duration: 5, description: `Product detail ${index + 1}`, visualSource: "product_image", transition: "direct_concat" }));
    const originalFetch = fetchMock.getMockImplementation()!;
    let adopted = false;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/scripts")) return Promise.resolve(Response.json([{ id: "script", selected: true, shots: productShots }]));
      if (url.endsWith("/materials")) return Promise.resolve(Response.json({ materials: [material] }));
      if (url.endsWith("/assets")) {
        if (init?.method === "POST") adopted = true;
        return Promise.resolve(Response.json(adopted ? [{ id: "local-asset", shotId: 2, status: "done", selected: true, type: "user_upload", provider: "local", filePath: material.url }] : []));
      }
      return originalFetch(url, init);
    });
    await mount(kling.selectionKey);
    const library = container.querySelector('[data-testid="local-material-library"]')!;
    const originalPreviews = [...container.querySelectorAll('[data-testid="shot-material-preview"]')];
    expect(originalPreviews).toHaveLength(8);
    expect(originalPreviews.every((preview) => preview.querySelector("img")?.src === new URL("/api/files/product.jpg", window.location.href).href)).toBe(true);
    const target = library.querySelector("label select") as HTMLSelectElement;
    expect(target).not.toBeNull();
    expect(Array.from(target.options).slice(1).map((option) => option.value)).toEqual(productShots.map((shot) => String(shot.shotId)));
    expect(library.textContent).not.toContain("noShots");
    const use = [...library.querySelectorAll("button")].find((item) => item.textContent === "use")!;
    expect(use.disabled).toBe(true);
    expect([...library.querySelectorAll("button")].find((item) => item.textContent === "fill")!.disabled).toBe(true);
    await act(async () => { target.value = "2"; target.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(use.disabled).toBe(false);
    await act(async () => use.click());
    const request = fetchMock.mock.calls.find(([url, init]) => url.endsWith("/assets") && init?.method === "POST")!;
    expect(JSON.parse(request[1].body)).toMatchObject({ shotId: 2, sourceUrl: material.url, type: "user_upload", provider: "local" });
    expect(library.querySelector('[role="status"]')?.textContent).toBe("used");
    const appliedPreview = container.querySelector('[data-testid="shot-material-preview"][data-shot-id="2"]')!;
    if (mediaType === "video") {
      expect(appliedPreview.querySelector("video")?.getAttribute("src")).toBe(material.url);
      expect(appliedPreview.textContent).not.toContain("sourceImageMissing");
    } else {
      expect(appliedPreview.querySelector("img")?.src).toBe(new URL(material.url, window.location.href).href);
      expect(appliedPreview.querySelector("a")).toBeNull();
      expect(appliedPreview.textContent).toContain("currentImageLabel");
    }
    expect(appliedPreview.querySelector('img[src="/api/files/product.jpg"]')).toBeNull();
    expect(submissions()).toHaveLength(0);
  });

  it.each([true, false])("shows a generated video's recorded input independently of its poster (recorded: %s)", async (recorded) => {
    const poster = "/api/files/project/generated.mp4.thumb.jpg";
    const source = "/api/files/project/kling/job/source-keyframe.png";
    const video = "/api/files/project/generated.mp4";
    const originalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/assets")) return Promise.resolve(Response.json([{ id: "generated", shotId: 1, status: "done", selected: true, type: "ai_generated", provider: "kling-cli", filePath: video, thumbnailPath: poster, ...(recorded && { sourceKeyframeUrl: source }) }]));
      return originalFetch(url, init);
    });
    await mount(kling.selectionKey);
    const preview = container.querySelector('[data-testid="shot-material-preview"][data-shot-id="1"]')!;
    expect(preview).not.toBeNull();
    if (recorded) {
      expect(preview.textContent).toContain("sourceImageLabel");
      expect(preview.querySelector("img")?.src).toBe(new URL(source, window.location.href).href);
      expect(preview.querySelector("a")).toBeNull();
      expect(preview.querySelector("video")).toBeNull();
    } else {
      expect(preview.textContent).toContain("sourceImageMissing");
      expect(preview.querySelector("img")).toBeNull();
      expect(preview.querySelector("video")?.getAttribute("src")).toBe(video);
    }
    expect(preview.querySelector('img[src="/api/files/product.jpg"]')).toBeNull();
    expect(preview.querySelector(`img[src="${poster}"]`)).toBeNull();
    expect(container.querySelector(`img[src="${poster}"]`)).not.toBeNull();
    expect(submissions()).toHaveLength(0);
  });

  it.each([9, 10])("shows account capacity %i/10 and only blocks new shots when all slots are reserved", async (active) => {
    api.concurrency = { active, max: 10, blockedByUnknownSubmission: false };
    await mount(kling.selectionKey);
    expect(container.textContent).toContain(`当前账号生成名额：${active} / 10`);
    expect(container.textContent).toContain("同一账号最多同时生成 10 个镜头");
    expect(button("btnConvertMotion")!.disabled).toBe(active === 10);
    if (active === 9) {
      await click("btnConvertMotion");
      expect(container.querySelector("h2")?.textContent).toContain("确认镜头 1 视频生成");
    }
    expect(submissions()).toHaveLength(0);
  });

  it("keeps original task recovery available while account capacity is full", async () => {
    api.concurrency = { active: 10, max: 10, blockedByUnknownSubmission: true };
    api.jobs = [{ jobId: "original", shotId: 1, scriptId: "script", submissionState: "submission_unknown", outputs: [] }];
    await mount(kling.selectionKey);
    const recovery = button("查看视频任务")!;
    expect(recovery.disabled).toBe(false);
    await act(async () => recovery.click());
    expect(container.querySelector('[aria-label="job-detail"]')?.textContent).toBe("original");
    expect(submissions()).toHaveLength(0);
  });

  it.each([ark, kling.selectionKey])("opens confirmation from the same motion button with default %s and a prepared motion prompt", async (defaultModel) => {
    await mount(defaultModel);
    expect(button("Kling 生成视频")).toBeUndefined();
    await click("btnConvertMotion");
    expect(container.querySelector("h2")?.textContent).toContain("确认镜头 1 视频生成");
    expect(container.querySelector('[aria-label="默认视频模型"]')?.textContent).toContain(defaultModel === ark ? ark : "chosen");
    const prompt = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(prompt.value).not.toContain("STATIC IMAGE PROMPT");
    expect(prompt.value).toContain("仅供展示");
    expect(prompt.value).toContain("Slow dolly in");
    expect(prompt.value).not.toContain("。.");
    expect(validateVideoPrompt(prompt.value)).toEqual([]);
    expect(submissions()).toHaveLength(0);
  });

  it("shows the shared film prompt with the same visual settings and project anchors", async () => {
    const settings = { visualLook: "phone_raw", motionIntensity: "strong", motionRealism: "constraints" } as const;
    const shot = { shotId: 1, type: "cta", duration: 5, camera: "镜头平稳向左横移", description: "透明杯身和圆形按键近景，底部显示“价格以商品页为准”", visualSource: "ai_generate", transition: "direct_concat" } as const;
    const creativeIntent = { subject: "透明杯身与圆形按键", continuity: ["浅蓝背景"] };
    const visualBible = { productAnchors: ["原有圆形按键"], environmentAnchors: ["干净桌面"] };
    const originalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === "/api/project/project"
      ? Promise.resolve(Response.json({ name: "Product", productCategory: "tech", creativeIntent, visualBible }))
      : url.endsWith("/scripts") ? Promise.resolve(Response.json([{ id: "script", selected: true, shots: [shot] }]))
      : originalFetch(url, init));
    useSettingsStore.setState(settings);
    await mount(kling.selectionKey);
    await click("btnConvertMotion");
    const expected = withVideoAudioMode(buildShotVideoPrompt({ shot, ordinal: 0, settings, category: "tech", creativeIntent, visualBible }).prompt, "silent");
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe(expected);
    expect(expected).toContain("运镜幅度大胆明显");
    expect(expected).toContain("原有圆形按键");
    expect(submissions()).toHaveLength(0);
  });

  it.each([
    { visualLook: "phone_raw" },
    { motionIntensity: "strong" as const },
    { motionRealism: "off" as const },
  ])("invalidates the single-shot confirmation when visual settings change: %j", async (patch) => {
    await mount(kling.selectionKey);
    await click("btnConvertMotion");
    expect(container.querySelector("textarea")).not.toBeNull();
    await act(async () => useSettingsStore.setState(patch));
    expect(container.querySelector("textarea")).toBeNull();
    expect(submissions()).toHaveLength(0);
  });

  it("uses one native audio direction, preserves exact dialogue, and submits the reviewed prompt unchanged", async () => {
    useSettingsStore.setState({ videoParams: { ...useSettingsStore.getState().videoParams, audioEnabled: true } });
    const originalFetch = fetchMock.getMockImplementation()!;
    const voiceover = "只自然说一遍这句台词";
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url.endsWith("/scripts")
      ? Promise.resolve(Response.json([{ id: "script", selected: true, shots: [{ shotId: 1, type: "demo", duration: 5, description: "商品保持静止，底部显示“价格以商品页为准”", camera: "固定镜头。", voiceover, visualSource: "ai_generate", transition: "direct_concat" }] }]))
      : originalFetch(url, init));
    await mount(ark);
    await click("btnConvertMotion");
    const reviewedPrompt = (container.querySelector('[aria-label="视频提示词"]') as HTMLTextAreaElement).value;
    expect(reviewedPrompt).toContain(`「${voiceover}」`);
    expect(reviewedPrompt).toContain("有台词时保持人声清晰");
    expect(reviewedPrompt).not.toContain("无人声说话");
    expect(reviewedPrompt).not.toContain("全程静音");
    expect(reviewedPrompt).not.toContain("。.");
    expect(validateVideoPrompt(reviewedPrompt)).toEqual([]);
    await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await click("确认生成此镜头");
    expect(submissions()).toHaveLength(1);
    expect(JSON.parse(submissions()[0][1].body)).toMatchObject({ prompt: reviewedPrompt, options: { audioEnabled: true, voiceover, audioPrompt: expect.stringContaining(voiceover) } });
  });

  it("keeps an explicit silent API setting ahead of native audio capability and scripted dialogue", async () => {
    useSettingsStore.setState({ videoParams: { ...useSettingsStore.getState().videoParams, audioEnabled: false } });
    const originalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url.endsWith("/scripts")
      ? Promise.resolve(Response.json([{ id: "script", selected: true, shots: [{ shotId: 1, type: "demo", duration: 5, description: "商品保持静止", camera: "固定镜头", voiceover: "这段台词不能进入静音生成", visualSource: "ai_generate", transition: "direct_concat" }] }]))
      : originalFetch(url, init));
    await mount(ark);
    await click("btnConvertMotion");
    const prompt = (container.querySelector('[aria-label="视频提示词"]') as HTMLTextAreaElement).value;
    expect(prompt).toContain("全程静音");
    expect(prompt).not.toContain("音频方向");
    expect(prompt).not.toContain("这段台词不能进入静音生成");
    expect(validateVideoPrompt(prompt)).toEqual([]);
    await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await click("确认生成此镜头");
    const request = JSON.parse(submissions()[0][1].body);
    expect(request.options.audioEnabled).toBe(false);
    expect(request.options.audioPrompt).toBeUndefined();
    expect(request.options.voiceover).toBeUndefined();
  });

  it("leaves native Kling audio directions to its own sound selector instead of leaking the scripted voiceover", async () => {
    const originalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url.endsWith("/scripts")
      ? Promise.resolve(Response.json([{ id: "script", selected: true, shots: [{ shotId: 1, type: "demo", duration: 5, description: "商品保持静止", camera: "固定镜头", voiceover: "不应自动注入的Kling台词", visualSource: "ai_generate", transition: "direct_concat" }] }]))
      : originalFetch(url, init));
    api.models = api.models.map((model) => model.provider === "kling-cli" ? { ...model, supportsAudio: true } : model);
    await mount(kling.selectionKey);
    await click("btnConvertMotion");
    const prompt = (container.querySelector('[aria-label="Kling 视频提示词"]') as HTMLTextAreaElement).value;
    expect(prompt).toContain("全程静音");
    expect(prompt).not.toContain("音频方向");
    expect(prompt).not.toContain("不应自动注入的Kling台词");
    expect(validateVideoPrompt(prompt)).toEqual([]);
    expect(submissions()).toHaveLength(0);
  });

  it.each([false, true])("chooses a consistent %s ambient audio setting before the API confirmation", async (audioEnabled) => {
    const modelId = "fixture/image-to-video";
    api.models.push({ id: modelId, name: "Fixture", provider: "volcengine", mediaType: "video", modes: ["image-to-video"], supportsAudio: false });
    useSettingsStore.setState({ videoParams: { ...useSettingsStore.getState().videoParams, audioEnabled } });
    await mount(modelId);
    await click("btnConvertMotion");
    const prompt = (container.querySelector('[aria-label="视频提示词"]') as HTMLTextAreaElement).value;
    expect(prompt.includes("全程静音")).toBe(!audioEnabled);
    expect(prompt.includes("音效：自然环境音与动作音效贴合画面")).toBe(audioEnabled);
    expect(validateVideoPrompt(prompt)).toEqual([]);
    expect(submissions()).toHaveLength(0);
  });

  it("submits the configured 720p resolution after replacing a stale 1080p video default", async () => {
    useSettingsStore.setState({ defaultResolution: "720p", videoParams: { ...useSettingsStore.getState().videoParams, resolution: "1080p" } });
    useSettingsStore.getState().setDefaultResolution("720p");
    const originalKling = api.kling.getMockImplementation()!;
    api.kling.mockImplementation((url: string, init?: RequestInit) => url.includes("/status")
      ? Promise.resolve(Response.json({ loggedIn: true, models: [{ ...kling, parameters: [...kling.parameters, { name: "resolution", type: "string", required: true, allowedValues: ["720p", "1080p"], default: "1080p" }] }] }))
      : originalKling(url, init));

    await mount(kling.selectionKey);
    await click("btnConvertMotion");
    expect((container.querySelector('[aria-label="Kling 参数 质量"]') as HTMLSelectElement).value).toBe("720p");
    expect(submissions()).toHaveLength(0);
    await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await click("确认生成此镜头");

    expect(submissions()).toHaveLength(1);
    const request = JSON.parse(submissions()[0][1].body);
    expect(request.options.resolution).toBe("720p");
    expect(request.selectionKey).toBe(kling.selectionKey);
  });

  it("uses the same redo button for a CLI default and invalidates confirmation after a default switch", async () => {
    isVideo = true; await mount(kling.selectionKey); await click("btnRedoMotion");
    expect(container.querySelector("h2")?.textContent).toContain("确认镜头 1 视频生成");
    await act(async () => useSettingsStore.getState().setDefaultVideoModel(ark));
    expect(container.querySelector("textarea")).toBeNull();
    expect(submissions()).toHaveLength(0);
  });

  it("opens an existing CLI task even when the current default is now Ark", async () => {
    api.jobs = [{ jobId: "original", shotId: 1, scriptId: "script", submissionState: "submission_unknown", outputs: [] }];
    await mount(ark); await click("btnConvertMotion");
    expect(container.querySelector('[aria-label="job-detail"]')?.textContent).toBe("original");
    expect(container.querySelector("textarea")).toBeNull();
    expect(submissions()).toHaveLength(0);
  });

  it("keeps an API submission with uncertain status blocked after closing the confirmation", async () => {
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === "/api/ai/video" ? Promise.reject(new TypeError("Network interrupted")) : normal(url, init));
    await mount(ark); await click("btnConvertMotion");
    await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await click("确认生成此镜头");
    await act(async () => (container.querySelector('[aria-label="close-dialog"]') as HTMLButtonElement).click());
    await click("btnConvertMotion");
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("此镜头已有待恢复视频任务");
    expect(submissions()).toHaveLength(1);
  });

  it("opens a full-film task in the shared recovery panel without an old query or generation", async () => {
    pending = [{ id: "film-row", shotId: null, provider: "volcengine", model: ark, mode: "video-to-video", taskId: "original-film-task", status: "unknown" }];
    await mount(kling.selectionKey); await click("btnResumeTask");
    expect(container.querySelector('[aria-label="film-panel"]')?.textContent).toBe("original-film-task");
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/ai/video/task")).toBe(false);
    expect(submissions()).toHaveLength(0);
  });

  it("opens and switches task-center film links on the mounted assets page", async () => {
    await mount(kling.selectionKey);
    const scriptReads = fetchMock.mock.calls.filter(([url]) => url.endsWith("/scripts")).length;
    expect(container.querySelector('[aria-label="film-panel"]')).toBeNull();

    await navigate("/project/project/assets?klingFilm=film-a");
    expect(container.querySelector('[aria-label="film-panel"]')?.getAttribute("data-run-id")).toBe("film-a");
    await navigate("/project/project/assets?klingFilm=film-b");
    expect(container.querySelector('[aria-label="film-panel"]')?.getAttribute("data-run-id")).toBe("film-b");
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/scripts"))).toHaveLength(scriptReads);
    expect([...fetchMock.mock.calls, ...api.kling.mock.calls].some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("clears film links when closing and can reopen the same task without refreshing", async () => {
    await mount(kling.selectionKey);
    await navigate("/project/project/assets?presenter=host&klingFilm=film-a&film=old-link#shot-5");
    await act(async () => (container.querySelector('[aria-label="close-film-panel"]') as HTMLButtonElement).click());

    expect(container.querySelector('[aria-label="film-panel"]')).toBeNull();
    expect(navigation.router.replace).toHaveBeenLastCalledWith("/project/project/assets?presenter=host#shot-5", { scroll: false });
    expect(window.location.search).toBe("?presenter=host");
    expect(window.location.hash).toBe("#shot-5");
    await navigate("/project/project/assets?presenter=host&klingFilm=film-a#shot-5");
    expect(container.querySelector('[aria-label="film-panel"]')?.getAttribute("data-run-id")).toBe("film-a");
    expect(submissions()).toHaveLength(0);
  });

  it("opens a direct film link after the selected script finishes loading", async () => {
    const normal = fetchMock.getMockImplementation()!;
    const scripts = await normal("/api/project/project/scripts");
    let finishScripts!: (response: Response) => void;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url.endsWith("/scripts")
      ? new Promise<Response>((resolve) => { finishScripts = resolve; })
      : normal(url, init));
    await navigate("/project/project/assets?klingFilm=direct-film");
    await mount(kling.selectionKey);
    expect(container.querySelector('[aria-label="film-panel"]')).toBeNull();

    await act(async () => finishScripts(scripts));
    expect(container.querySelector('[aria-label="film-panel"]')?.getAttribute("data-run-id")).toBe("direct-film");
    expect([...fetchMock.mock.calls, ...api.kling.mock.calls].some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it.each(["legacy-film", "1"])("supports the legacy film query %s without submitting generation", async (film) => {
    await navigate(`/project/project/assets?film=${film}`);
    await mount(kling.selectionKey);
    const panel = container.querySelector('[aria-label="film-panel"]');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute("data-run-id")).toBe(film === "1" ? null : film);
    expect(panel?.hasAttribute("data-task-id")).toBe(false);
    expect([...fetchMock.mock.calls, ...api.kling.mock.calls].some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("switches between film and shot task links and clears the shot link on close", async () => {
    await mount(kling.selectionKey);
    await navigate("/project/project/assets?klingFilm=film-a");
    expect(container.querySelector('[aria-label="film-panel"]')).not.toBeNull();
    await navigate("/project/project/assets?klingJob=job-a&view=shots#shot-1");
    expect(container.querySelector('[aria-label="film-panel"]')).toBeNull();
    expect(container.querySelector('[aria-label="job-detail"]')?.textContent).toBe("job-a");
    await navigate("/project/project/assets?klingJob=job-b&view=shots#shot-2");
    expect(container.querySelector('[aria-label="job-detail"]')?.textContent).toBe("job-b");
    await act(async () => (container.querySelector('[aria-label="close-job-detail"]') as HTMLButtonElement).click());
    expect(container.querySelector('[aria-label="job-detail"]')).toBeNull();
    expect(navigation.router.replace).toHaveBeenLastCalledWith("/project/project/assets?view=shots#shot-2", { scroll: false });

    await navigate("/project/project/assets?klingJob=job-b");
    expect(container.querySelector('[aria-label="job-detail"]')?.textContent).toBe("job-b");
    await navigate("/project/project/assets?klingFilm=film-b");
    expect(container.querySelector('[aria-label="job-detail"]')).toBeNull();
    expect(container.querySelector('[aria-label="film-panel"]')?.getAttribute("data-run-id")).toBe("film-b");
    expect(submissions()).toHaveLength(0);
  });

  it.each(["klingFilm=film-a", "klingJob=job-a"])("closes a task on history navigation away from %s and keeps manual film opening available", async (query) => {
    await mount(kling.selectionKey);
    await navigate(`/project/project/assets?${query}`);
    expect(container.querySelector('[aria-label="film-panel"], [aria-label="job-detail"]')).not.toBeNull();

    await navigate("/project/project/assets");
    expect(container.querySelector('[aria-label="film-panel"], [aria-label="job-detail"]')).toBeNull();
    await click("整片自动编排");
    expect(container.querySelector('[aria-label="film-panel"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="film-panel"]')?.hasAttribute("data-run-id")).toBe(false);
    await navigate("/project/project/assets?view=shots#shot-1");
    expect(container.querySelector('[aria-label="film-panel"]')).not.toBeNull();
    expect(submissions()).toHaveLength(0);
  });
});
