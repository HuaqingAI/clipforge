import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AssetsPage from "@/app/project/[id]/assets/page";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { useCharacterStore, type Character } from "@/lib/stores/project-store";
import { snapshotTidewePresenter } from "@/lib/tidewe/presenter";
import type { KlingVideoModelDescriptor } from "@/lib/kling/types";
import type { KlingConcurrencyStatus } from "@/lib/kling/concurrency";
import type { Model } from "@/lib/providers/types";
import type { KlingJobView } from "@/lib/kling/job-types";
import type { VideoPromptPreview, VideoPromptRequest } from "@/lib/video-prompt-request";
import type { BatchMotionPanel } from "@/components/batch-motion-panel";
import type { KeyframeRefinementDialogProps } from "@/components/keyframe-refinement-dialog";
import { createPremiumProductCgProfile, createTideweOutdoorProfile } from "@/lib/creative-profiles";
import type { Shot } from "@/lib/db/schema";

const api = vi.hoisted(() => ({ kling: vi.fn(), models: [] as Model[], jobs: [] as unknown[], concurrency: undefined as KlingConcurrencyStatus | undefined, runs: [] as Array<Record<string, unknown>>, showMaterialLibrary: false }));
const batch = vi.hoisted(() => ({ props: null as ComponentProps<typeof BatchMotionPanel> | null }));
const refinement = vi.hoisted(() => ({ props: null as KeyframeRefinementDialogProps | null }));
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
vi.mock("@/components/keyframe-refinement-dialog", () => ({ KeyframeRefinementDialog: (props: KeyframeRefinementDialogProps) => {
  refinement.props = props;
  return props.open ? <div aria-label="keyframe-refinement-dialog"><button aria-label="close-keyframe-refinement" onClick={() => props.onOpenChange(false)} /><button aria-label="apply-refined-keyframe" onClick={() => props.onApplied()} /></div> : null;
} }));
vi.mock("@/components/model-catalog-status", () => ({ ModelCatalogStatus: () => null }));
vi.mock("@/components/model-capability-preflight", () => ({ ModelCapabilityPreflight: () => null }));
vi.mock("@/app/project/[id]/assets/_components/local-material-library", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/project/[id]/assets/_components/local-material-library")>();
  return { LocalMaterialLibrary: (props: ComponentProps<typeof actual.LocalMaterialLibrary>) => api.showMaterialLibrary ? <actual.LocalMaterialLibrary {...props} /> : null };
});
vi.mock("@/components/storyboard-film-panel", () => ({ StoryboardFilmPanel: ({ open, initialRunId, initialTaskId, onOpenChange }: { open: boolean; initialRunId?: string; initialTaskId?: string; onOpenChange(open: boolean): void }) => open ? <div aria-label="film-panel" data-run-id={initialRunId} data-task-id={initialTaskId}>{initialRunId ?? initialTaskId}<button aria-label="close-film-panel" onClick={() => onOpenChange(false)} /></div> : null }));
vi.mock("@/components/batch-motion-panel", () => ({ BatchMotionPanel: (props: ComponentProps<typeof BatchMotionPanel>) => {
  batch.props = props;
  return props.open ? <div aria-label="batch-motion-panel"><button aria-label="close-batch-motion-panel" onClick={() => props.onOpenChange(false)} />{props.shots.map(({ asset, draft, disabledReason }) => <button key={asset.shotId} aria-label={`batch-submit-${asset.shotId}`} disabled={!draft || !!disabledReason} onClick={async () => { await draft!.generate(); props.onSubmitted(asset.shotId); }}>镜头 {asset.shotId}</button>)}</div> : null;
} }));
vi.mock("@/components/kling-job-detail", () => ({ KlingJobDetail: ({ open, jobId, onOpenChange, onChanged }: { open: boolean; jobId: string | null; onOpenChange(open: boolean): void; onChanged?(): void }) => open ? <div aria-label="job-detail">{jobId}<button aria-label="close-job-detail" onClick={() => onOpenChange(false)} /><button aria-label="refresh-job-detail" onClick={() => onChanged?.()} /></div> : null, klingJobBlocksSubmission: (job: { submissionState: string }) => job.submissionState === "submission_unknown", klingJobStatus: () => "待核对" }));
vi.mock("@/lib/hooks/use-model-catalog", () => ({ useModelCatalog: () => ({ models: api.models, statuses: [], pending: false, retry: vi.fn() }) }));
vi.mock("@/lib/kling/client", () => ({ klingFetch: api.kling, klingErrorMessage: (body: { error?: string | { message: string } }) => typeof body.error === "string" ? body.error : body.error?.message ?? "Kling 操作失败" }));
vi.mock("@/lib/i18n", async () => {
  const { assets } = await import("@/lib/i18n/messages/assets");
  const t = (key: string, vars?: Record<string, string | number>) => {
    const template = key.startsWith("gridResolution") ? assets.zh[key] ?? key : key;
    return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => vars?.[name] != null ? String(vars[name]) : placeholder);
  };
  return { useT: () => t, useLocale: () => "zh" };
});
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, onOpenChange, children }: { open: boolean; onOpenChange(open: boolean): void; children: React.ReactNode }) => open ? <div><button aria-label="close-dialog" onClick={() => onOpenChange(false)}>关闭</button>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const kling: KlingVideoModelDescriptor = { selectionKey: '["kling-cli","image_to_video","chosen"]', provider: "kling-cli", profileId: "profile", region: "global", tool: "image_to_video", remoteModelId: "chosen", displayName: "Chosen Kling", catalogRevision: "rev", available: true, parameters: [{ name: "duration", type: "number", required: true, allowedValues: [5, 10], default: 5 }], inputSlots: [{ name: "image", role: "image", required: true }], capabilities: { image: true, tailFrame: false, multiImage: false, audio: false } };
const ark = "doubao-seedance-2.5";
const initial = useSettingsStore.getInitialState();
const initialCharacters = useCharacterStore.getInitialState();
const fetchMock = vi.fn();
let root: Root, container: HTMLDivElement, isVideo: boolean, pending: Array<Record<string, unknown>>;
function button(part: string) { return [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(part)); }
async function click(part: string) { await act(async () => button(part)!.click()); }
async function mount(defaultModel: string) { useSettingsStore.getState().setDefaultVideoModel(defaultModel); await act(async () => root.render(<AssetsPage />)); }
function changeUrl(url: string) { window.history.replaceState(null, "", url); navigation.listeners.forEach((listener) => listener()); }
async function navigate(url: string) { await act(async () => changeUrl(url)); }
function runRequests() { return fetchMock.mock.calls.filter(([url, init]) => url === "/api/generation-runs" && init?.method === "POST").map(([, init]) => JSON.parse(String(init.body))); }
function backgroundItems(kind: string) { return runRequests().flatMap(run => run.items.filter((item: { kind: string }) => item.kind === kind)); }
function generationRequests(kind: string) { return backgroundItems(kind).map(item => [kind, { body: JSON.stringify(item.request) }] as const); }
function submissions() { return generationRequests("video"); }
function completeRuns() { api.runs = runRequests().map((run, i) => ({ ...run, id: `run-${i + 1}`, status: "completed", total: run.items.length, done: run.items.length, failed: 0, items: run.items.map((item: Record<string, unknown>, j: number) => ({ id: `item-${i}-${j}`, kind: item.kind, scriptId: item.scriptId, shotId: item.shotId, status: "completed", result: {} })) })); }
const videoPromptUrl = "/api/project/project/video-prompt";
const serverAudioPrompt = "Exact audio instruction from the backend.";
function serverPrompt(shotId = 1) { return `Backend approved direction for shot ${shotId}.\nPreserve this exact wording and layout.`; }
function previewRequests(): VideoPromptRequest[] {
  return fetchMock.mock.calls.filter(([url]) => url === videoPromptUrl).map(([, init]) => JSON.parse(init.body));
}
function promptPreview(request: VideoPromptRequest, overrides: Partial<VideoPromptPreview> = {}): VideoPromptPreview {
  const native = Boolean(request.generateAudio && request.controlInputs?.supportsAudio);
  return {
    prompt: serverPrompt(request.shotId), negativePrompt: "backend negative direction",
    scriptId: request.scriptId, shotId: request.shotId, contextKey: `backend-context-${request.shotId}`,
    settings: request.settings,
    controlPlan: {
      version: 1, strategy: "keyframe", mode: "image-to-video", referenceRoles: ["keyframe"],
      referenceCount: 1, audioMode: native ? "native" : "none", voiceoverBound: native,
      warnings: [], referenceInputs: [], promptSuffix: "",
      firstFrameUrl: request.controlInputs?.firstFrameUrl,
      ...(request.controlInputs?.lastFrameUrl && { lastFrameUrl: request.controlInputs.lastFrameUrl }),
      ...(native && { audioPrompt: serverAudioPrompt }),
    },
    ...overrides,
  };
}
function savedKlingJob(overrides: Partial<KlingJobView> = {}): KlingJobView {
  return { jobId: "saved-job", profileId: "profile", projectId: "project", scriptId: "script", shotId: 1, modelId: "chosen", tool: "image_to_video", prompt: "Product rotates", submissionState: "acknowledged", remoteState: "completed", importState: "completed", outputs: [{ outputId: "output", assetId: "asset", videoUrl: "/api/files/clip.mp4", imported: true, selected: true }], allowedActions: ["delete"], autoQueryPaused: false, needsConfirmation: false, inputSummary: [], options: {}, createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z", ...overrides };
}
function deleteVideoButton() { return container.querySelector('[aria-label="删除镜头 1 的任务"]') as HTMLButtonElement; }

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", fetchMock);
  navigation.router.replace.mockReset().mockImplementation((url: string) => changeUrl(url));
  useSettingsStore.setState({ ...initial, uiMode: "simple", locale: "zh", defaultVideoModel: ark, providers: { volcengine: { enabled: true, apiKey: "fixture" }, "kling-cli": { enabled: true, apiKey: "", profileId: "profile" } } });
  useCharacterStore.setState({ ...initialCharacters, characters: [] });
  api.models = [{ id: ark, name: "Ark", provider: "volcengine", mediaType: "video", modes: ["image-to-video"] }, { id: kling.selectionKey, name: "Chosen Kling", provider: "kling-cli", mediaType: "video", modes: ["image-to-video"] }];
  api.jobs = []; api.runs = []; api.concurrency = undefined; api.showMaterialLibrary = false; batch.props = null; refinement.props = null; isVideo = false; pending = [];
  api.kling.mockReset().mockImplementation(async (url: string) => url.includes("/status") ? Response.json({ loggedIn: true, models: [kling], concurrency: api.concurrency }) : url.includes("/jobs?") ? Response.json({ jobs: api.jobs }) : Response.json({ jobId: "new-job" }, { status: 202 }));
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/generation-runs?") ) return Response.json({ runs: api.runs });
    if (url === "/api/generation-runs" && init?.method === "POST") {
      const input = JSON.parse(String(init.body));
      return Response.json({ id: `run-${runRequests().length}`, projectId: input.projectId, kind: input.kind, status: "queued", total: input.items.length, done: 0, failed: 0, items: input.items.map((item: Record<string, unknown>, i: number) => ({ id: `item-${i}`, kind: item.kind, scriptId: item.scriptId, shotId: item.shotId, status: "queued" })) }, { status: 202 });
    }
    if (url === videoPromptUrl) return Response.json(promptPreview(JSON.parse(init!.body as string)));
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
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useSettingsStore.setState(initial); useCharacterStore.setState(initialCharacters); vi.unstubAllGlobals(); });

describe("image background result reconciliation", () => {
  function enableImages() {
    api.models.push({ id: "fixture-image", name: "Fixture image", provider: "volcengine", mediaType: "image", modes: ["text-to-image", "image-to-image"] });
    useSettingsStore.setState({ defaultImageModel: "fixture-image" });
  }
  it("waits for the exact newly saved keyframe before offering automatic motion", async () => {
    enableImages(); api.jobs = [savedKlingJob()];
    await mount(ark); await click("btnRegenerate");
    await click("查看 / 恢复");
    await act(async () => (container.querySelector('[aria-label="refresh-job-detail"]') as HTMLButtonElement).click());
    expect(container.querySelector('img[src="/api/files/frame.jpg"]')).not.toBeNull();
    let finishAssets!: (response: Response) => void;
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url.endsWith("/assets") && !init?.method ? new Promise((resolve) => { finishAssets = resolve; }) : normal(url, init));
    completeRuns();
    api.runs[0] = { ...api.runs[0], items: [{ id: "saved-image", kind: "image", scriptId: "script", shotId: 1, status: "completed", result: { assetId: "new-frame", selected: true, filePath: "/api/files/new-frame.jpg" } }] };
    await act(async () => window.dispatchEvent(new Event("clipforge:generation-runs-refresh")));
    expect(previewRequests()).toHaveLength(0);
    await act(async () => finishAssets(Response.json([{ id: "new-frame", shotId: 1, status: "done", selected: true, filePath: "/api/files/new-frame.jpg" }])));
    expect(previewRequests()).toHaveLength(1);
    expect(previewRequests()[0].controlInputs?.firstFrameUrl).toBe("/api/files/new-frame.jpg");
    expect(submissions()).toHaveLength(0);
  });

  it("clears the local generating indicator when an accepted image task fails", async () => {
    enableImages(); await mount(ark); await click("btnRegenerate");
    expect(button("btnGenerating")).toBeDefined();
    api.runs = [{ id: "run-1", projectId: "project", kind: "image", status: "failed", total: 1, done: 0, failed: 1, items: [{ id: "failed-image", kind: "image", scriptId: "script", shotId: 1, status: "failed", error: "Provider image failed" }] }];
    await act(async () => window.dispatchEvent(new Event("clipforge:generation-runs-refresh")));
    expect(button("btnGenerating")).toBeUndefined();
    expect(button("retry")?.disabled).toBe(false);
    expect(container.textContent).toContain("Provider image failed");
    expect(previewRequests()).toHaveLength(0);
  });
});

describe("batch image keyframes", () => {
  function configureBatchShots(options: { imageModel?: boolean; allPending?: boolean } = {}) {
    if (options.imageModel !== false) {
      api.models.push({ id: "fixture-image", name: "Fixture image", provider: "volcengine", mediaType: "image", modes: ["text-to-image", "image-to-image"] });
      useSettingsStore.setState({ defaultImageModel: "fixture-image" });
    } else useSettingsStore.setState({ defaultImageModel: "" });
    const shots = Array.from({ length: options.allPending ? 5 : 9 }, (_, index) => {
      const shotId = index + 1;
      const source = options.allPending ? "ai_generate" : shotId === 5 ? "user_upload" : shotId === 6 ? "stock_footage" : shotId === 7 ? "product_image" : shotId === 8 ? undefined : "ai_generate";
      return { shotId, type: "demo", duration: 5, description: `Product detail ${shotId}`, camera: "Slow dolly in", visualSource: source, transition: "direct_concat" };
    });
    let saved = options.allPending ? [] : [
      { id: "failed-2", shotId: 2, status: "failed", selected: true, filePath: "" },
      { id: "frame-3", shotId: 3, status: "done", selected: true, filePath: "/api/files/frame-3.png" },
      { id: "video-4", shotId: 4, status: "done", selected: true, filePath: "/api/files/video-4.mp4" },
      { id: "generating-9", shotId: 9, status: "generating", selected: true, filePath: "" },
    ];
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url.endsWith("/scripts")
      ? Promise.resolve(Response.json([{ id: "script", selected: true, shots }]))
      : url.endsWith("/assets") && !init?.method ? Promise.resolve(Response.json(saved)) : normal(url, init));
    return {
      completeImages() {
        saved = [...saved, ...backgroundItems("image").map((item: { shotId: number }) => ({ id: `new-frame-${item.shotId}`, shotId: item.shotId, status: "done", selected: true, filePath: `/api/files/new-frame-${item.shotId}.png` }))];
        completeRuns();
        api.runs = api.runs.map((run) => ({ ...run, items: (run.items as Array<Record<string, unknown>>).map((item) => ({ ...item, result: { assetId: `new-frame-${item.shotId}`, selected: true, filePath: `/api/files/new-frame-${item.shotId}.png` } })) }));
      },
    };
  }

  it.each([ark, kling.selectionKey])("fills only pending or failed AI keyframes and keeps completed results as stills with %s", async (videoModel) => {
    const fixture = configureBatchShots();
    await mount(videoModel);
    await click("batchKeyframesButton");

    expect(backgroundItems("image").map((item) => item.shotId)).toEqual([1, 2, 8]);
    expect(runRequests().every((run) => run.kind === "image")).toBe(true);
    for (const item of backgroundItems("image")) {
      expect(item).toMatchObject({ scriptId: "script", request: { provider: "volcengine", model: "fixture-image", scriptId: "script", shotId: item.shotId }, asset: { scriptId: "script", shotId: item.shotId, expectedSelectedAssetId: null } });
    }
    expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith("/assets") && init?.method === "POST")).toBe(false);
    expect(previewRequests()).toHaveLength(0);
    expect(submissions()).toHaveLength(0);

    fixture.completeImages();
    await act(async () => window.dispatchEvent(new Event("clipforge:generation-runs-refresh")));
    expect(container.querySelector('img[src="/api/files/new-frame-1.png"]')).not.toBeNull();
    expect(container.querySelector('img[src="/api/files/frame-3.png"]')).not.toBeNull();
    expect(previewRequests()).toHaveLength(0);
    expect(submissions()).toHaveLength(0);
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("skips active background work and cloud tasks awaiting recovery", async () => {
    configureBatchShots({ allPending: true });
    api.runs = [
      { id: "active-image", projectId: "project", kind: "image", status: "waiting", total: 1, done: 0, failed: 0, items: [{ id: "active-item", kind: "image", scriptId: "script", shotId: 2, status: "waiting" }] },
      { id: "import-attention", projectId: "project", kind: "video", status: "needs_attention", total: 1, done: 0, failed: 1, items: [{ id: "import-item", kind: "video", scriptId: "script", shotId: 3, status: "needs_attention" }] },
    ];
    pending = [
      { id: "unresolved", shotId: 4, provider: "volcengine", model: ark, taskId: "paid-video", status: "unknown" },
      { id: "failed", shotId: 5, provider: "volcengine", model: ark, taskId: "failed-video", status: "failed" },
    ];
    await mount(ark);
    await click("batchKeyframesButton");
    expect(backgroundItems("image").map((item) => item.shotId)).toEqual([1, 5]);
    expect(submissions()).toHaveLength(0);
  });

  it("submits each pending shot once when the batch button is clicked twice", async () => {
    configureBatchShots();
    const normal = fetchMock.getMockImplementation()!;
    let finishFirst!: (response: Response) => void;
    let delayed = true;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/generation-runs" && init?.method === "POST" && delayed) {
        delayed = false;
        return new Promise<Response>((resolve) => { finishFirst = resolve; });
      }
      return normal(url, init);
    });
    await mount(ark);
    const generate = button("batchKeyframesButton")!;
    await act(async () => { generate.click(); generate.click(); });
    expect(backgroundItems("image").map((item) => item.shotId)).toEqual([1]);
    expect(button("batchKeyframesSubmitting")?.disabled).toBe(true);
    await act(async () => finishFirst(Response.json({ id: "run-1", projectId: "project", kind: "image", status: "queued", total: 1, done: 0, failed: 0, items: [{ id: "first-item", kind: "image", scriptId: "script", shotId: 1, status: "queued" }] }, { status: 202 })));
    expect(backgroundItems("image").map((item) => item.shotId)).toEqual([1, 2, 8]);
  });

  it("keeps the batch entry disabled without a configured image model", async () => {
    configureBatchShots({ imageModel: false });
    await mount(ark);
    expect(button("batchKeyframesButton")?.disabled).toBe(true);
    await click("batchKeyframesButton");
    expect(runRequests()).toHaveLength(0);
  });

  it("keeps the batch entry visible and disabled after all AI shots have assets", async () => {
    api.models.push({ id: "fixture-image", name: "Fixture image", provider: "volcengine", mediaType: "image", modes: ["text-to-image"] });
    useSettingsStore.setState({ defaultImageModel: "fixture-image" });
    await mount(ark);
    expect(button("batchKeyframesButton")?.disabled).toBe(true);
    expect(button("batchKeyframesButton")?.title).toContain("batchKeyframesNeedShots");
    expect(runRequests()).toHaveLength(0);
  });
});

describe("keyframe refinement entry points", () => {
  function configureFrames() {
    api.models.push({ id: "fixture-image", name: "Fixture image", provider: "volcengine", mediaType: "image", modes: ["text-to-image", "image-to-image"] });
    useSettingsStore.setState({ defaultImageModel: "fixture-image" });
    const shots: Shot[] = [1, 2, 3, 4, 5, 6].map((shotId) => ({
      shotId, type: "demo", duration: 5, description: `Frame ${shotId}`, camera: "Slow dolly in", voiceover: "",
      visualSource: shotId === 5 ? "product_image" : "ai_generate", transition: "direct_concat",
    }));
    let savedAssets = [
      { id: "frame-1", shotId: 1, status: "done", selected: true, filePath: "/api/files/crop-1.png", thumbnailPath: null },
      { id: "unadopted-1", shotId: 1, status: "done", selected: false, filePath: "/api/files/candidate-1.png", thumbnailPath: null },
      { id: "video-2", shotId: 2, status: "done", selected: true, filePath: "/api/files/clip-2.mp4", thumbnailPath: "/api/files/poster-2.png" },
      { id: "failed-4", shotId: 4, status: "failed", selected: true, filePath: "", thumbnailPath: null },
      { id: "frame-6", shotId: 6, status: "done", selected: true, filePath: "/api/files/crop-6.png", thumbnailPath: null },
    ];
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/scripts")) return Promise.resolve(Response.json([{ id: "script", selected: true, shots }]));
      if (url.endsWith("/assets")) return Promise.resolve(Response.json(savedAssets));
      return normal(url, init);
    });
    return {
      adopt: () => { savedAssets = savedAssets.map((asset) => asset.id === "frame-6" ? { ...asset, id: "refined-6", filePath: "/api/files/refined-6.png" } : asset); },
    };
  }

  function singleRefineButtons() {
    return [...container.querySelectorAll("button")].filter((item) => item.textContent === "keyframeRefine");
  }

  function expectNoGenerationRequests() {
    expect([...fetchMock.mock.calls, ...api.kling.mock.calls].filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  }

  it.each([ark, kling.selectionKey])("shows batch keyframes alongside individual image and grid actions for %s", async (videoModel) => {
    configureFrames();
    useSettingsStore.setState({ uiMode: "pro" });
    await mount(videoModel);

    expect(button("batchKeyframesButton")?.disabled).toBe(false);
    expect(button("btnGenerate")?.disabled).toBe(false);
    expect(button("gridButton")?.disabled).toBe(false);
    expect(button("keyframeRefineBatch")?.disabled).toBe(false);
    expect(button("batchMotionButton")?.disabled).toBe(false);
    expectNoGenerationRequests();
  });

  it("opens batch refinement for selected saved stills and excludes videos, missing, failed and unadopted assets", async () => {
    configureFrames();
    await mount(ark);
    expect(refinement.props).toBeNull();
    await click("keyframeRefineBatch");
    expect(container.querySelector('[aria-label="keyframe-refinement-dialog"]')).not.toBeNull();
    expect(refinement.props).toMatchObject({
      open: true, projectId: "project", scriptId: "script",
      modelTarget: { provider: "volcengine", model: "fixture-image", apiKey: "fixture" },
      shots: [
        { assetId: "frame-1", shotId: 1, imageUrl: "/api/files/crop-1.png", description: "Frame 1" },
        { assetId: "frame-6", shotId: 6, imageUrl: "/api/files/crop-6.png", description: "Frame 6" },
      ],
    });
    expect(refinement.props!.initialShotId).toBeUndefined();
    expectNoGenerationRequests();
  });

  it("preselects the clicked shot while retaining the other available frames", async () => {
    configureFrames();
    await mount(ark);
    expect(singleRefineButtons()).toHaveLength(2);
    await act(async () => singleRefineButtons()[1].click());
    expect(refinement.props!.initialShotId).toBe(6);
    expect(refinement.props!.shots.map((shot) => shot.shotId)).toEqual([1, 6]);
    expectNoGenerationRequests();
  });

  it("opens refinement from the original image preview with the correct shot and closes the preview", async () => {
    configureFrames();
    await mount(ark);
    const previewTrigger = container.querySelector('img[src="/api/files/crop-6.png"]')!.closest("button")!;
    await act(async () => previewTrigger.click());
    const previewTitle = [...container.querySelectorAll("h2")].find((heading) => heading.textContent === "imagePreviewTitle")!;
    expect(previewTitle).toBeDefined();
    const refineAction = [...previewTitle.parentElement!.querySelectorAll("button")].find((item) => item.textContent === "keyframeRefine")!;
    expect(refineAction).toBeDefined();
    await act(async () => refineAction.click());
    expect(refinement.props!.initialShotId).toBe(6);
    expect([...container.querySelectorAll("h2")].some((heading) => heading.textContent === "imagePreviewTitle")).toBe(false);
    expectNoGenerationRequests();
  });

  it("refreshes the selected image after explicit adoption and keeps the original refinement source snapshot", async () => {
    const frames = configureFrames();
    await mount(ark);
    await click("keyframeRefineBatch");
    const sourceSnapshot = refinement.props!.shots;
    const readsBefore = fetchMock.mock.calls.filter(([url]) => url.endsWith("/assets")).length;
    expect(container.querySelector('img[src="/api/files/refined-6.png"]')).toBeNull();
    frames.adopt();
    await act(async () => (container.querySelector('[aria-label="apply-refined-keyframe"]') as HTMLButtonElement).click());
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/assets"))).toHaveLength(readsBefore + 1);
    expect(container.querySelector('img[src="/api/files/refined-6.png"]')).not.toBeNull();
    expect(refinement.props!.shots).toBe(sourceSnapshot);
    expect(refinement.props!.shots[1]).toMatchObject({ assetId: "frame-6", imageUrl: "/api/files/crop-6.png" });
    expectNoGenerationRequests();
  });
});

const tideweScriptHash = "a".repeat(64);
function configureTideweAssets({ productVisible = true, savedFrame = false, projectOverrides = {} }: { productVisible?: boolean; savedFrame?: boolean; projectOverrides?: Record<string, unknown> } = {}) {
  api.models.push({ id: "fixture-image", name: "Fixture image", provider: "volcengine", mediaType: "image", modes: ["text-to-image", "image-to-image"] });
  useSettingsStore.setState({ defaultImageModel: "fixture-image", uiMode: "pro" });
  const planned: Shot = {
    shotId: 1, type: "demo", duration: 5, description: productVisible ? "猎人在森林边整理迷彩夹克" : "森林清晨，树梢上的薄雾缓慢消散", camera: "Slow dolly in", visualSource: "ai_generate", transition: "direct_concat",
    voiceover: "The woods are quiet before the day begins.",
    tidewe: { copySpan: { start: 0, end: 42 }, translation: "天亮前，树林很安静。", shotGoal: productVisible ? "展示同款夹克的自然使用" : "建立安静的森林清晨环境", productVisible, factRefs: [], sceneId: "morning-woods" },
  };
  const normal = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url === "/api/project/project") return Promise.resolve(Response.json({ name: "TIDEWE jacket", productImages: ["/api/files/product.jpg"], creativeProfile: createTideweOutdoorProfile(), creativeConfigRevision: 7, productionWorkflow: [{ id: "motion", enabled: false }], ...projectOverrides }));
    if (url.endsWith("/scripts")) return Promise.resolve(Response.json([{ id: "script", selected: true, scriptHash: tideweScriptHash, shots: [planned] }]));
    if (url.endsWith("/assets")) return Promise.resolve(Response.json(init?.method === "POST" ? { filePath: "/api/files/tidewe-saved.png" } : savedFrame ? [{ id: "asset", shotId: 1, status: "done", selected: true, type: "ai_generate", filePath: "/api/files/frame.jpg" }] : []));
    if (url === "/api/ai/image") return Promise.resolve(Response.json({ imageUrls: ["https://example.test/tidewe-generated.png"] }));
    return normal(url, init);
  });
  return { planned };
}

describe("TIDEWE assets preserve the frozen script context", () => {
  const selectedPresenter: Character = { id: "bound-presenter", name: "Frozen outdoor creator", appearance: "An adult outdoors in a green cap", referenceImages: ["/api/files/frozen-presenter.png"], sourceReferenceImages: ["/api/files/frozen-portrait.png"] };
  it("shows the frozen project presenter, ignores query and library replacements, and automatically binds it to grid and single images", async () => {
    const presenter = snapshotTidewePresenter(selectedPresenter)!;
    const { planned } = configureTideweAssets({ projectOverrides: { creativeProfile: createTideweOutdoorProfile({ presenter }) } });
    planned.tidewe = { ...planned.tidewe!, personVisible: true, presenter };
    useCharacterStore.setState({ characters: [{ ...selectedPresenter, name: "Changed library identity", referenceImages: ["/api/files/changed-presenter.png"] }, { id: "query-presenter", name: "Query identity", appearance: "A different adult", referenceImages: ["/api/files/query-presenter.png"] }] });
    window.history.replaceState(null, "", "/project/project/assets?presenter=query-presenter");
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url.endsWith("/storyboard-grid")
      ? Promise.resolve(Response.json({ count: 2 }))
      : url.endsWith("/scripts")
        ? Promise.resolve(Response.json([{ id: "script", selected: true, scriptHash: tideweScriptHash, shots: [planned, { ...planned, shotId: 2 }] }]))
        : normal(url, init));
    await mount(ark);
    const identity = container.querySelector('[aria-label="presenterLabel"]');
    expect(identity?.textContent).toContain(selectedPresenter.name);
    expect(container.querySelector(`select option[value="${presenter.id}"]`)).toBeNull();
    expect(container.querySelector('select option[value="query-presenter"]')).toBeNull();
    expect(container.querySelector('a[href="/project/project/script"]')).not.toBeNull();
    await act(async () => useCharacterStore.setState({ characters: [] }));
    await navigate("/project/project/assets?presenter=another-presenter");
    expect(identity?.textContent).toContain(selectedPresenter.name);
    await click("gridButton");
    const gridRequest = generationRequests("storyboard_grid")[0];
    expect(JSON.parse(gridRequest[1].body)).toMatchObject({ scriptId: "script", characterSheetUrl: "/api/files/frozen-presenter.png" });
    await click("btnGenerate");
    const imageRequest = JSON.parse(generationRequests("image")[0][1].body);
    expect(imageRequest).toMatchObject({ imageUrl: "/api/files/frozen-presenter.png", referenceImageUrls: ["/api/files/frozen-presenter.png", "/api/files/product.jpg"] });
    expect(JSON.stringify(imageRequest)).not.toContain("changed-presenter");
    expect(JSON.stringify(imageRequest)).not.toContain("query-presenter");
  });
  it("automatically sends the frozen presenter identity to the reviewed video controls", async () => {
    const presenter = snapshotTidewePresenter(selectedPresenter)!;
    const { planned } = configureTideweAssets({ savedFrame: true, projectOverrides: { creativeProfile: createTideweOutdoorProfile({ presenter }) } });
    planned.tidewe = { ...planned.tidewe!, personVisible: true, presenter };
    api.models = api.models.map((model) => model.id === ark ? { ...model, supportsAudio: true } : model);
    useCharacterStore.setState({ characters: [{ ...selectedPresenter, referenceImages: ["/api/files/changed-presenter.png"] }] });
    await mount(ark); await click("btnConvertMotion");
    expect(previewRequests()[0]).toMatchObject({ generateAudio: true, controlInputs: { characterReferenceUrl: "/api/files/frozen-presenter.png", productReferenceUrl: "/api/files/product.jpg" } });
  });
  it("keeps the selected presenter out of silent person-free B-roll image and video reference packs", async () => {
    const presenter = snapshotTidewePresenter(selectedPresenter)!;
    const { planned } = configureTideweAssets({ productVisible: false, projectOverrides: { creativeProfile: createTideweOutdoorProfile({ presenter }) } });
    planned.voiceover = "";
    planned.tidewe = { ...planned.tidewe!, personVisible: false, presenter };
    api.models = api.models.map((model) => model.id === ark ? { ...model, supportsAudio: true } : model);
    await mount(ark); await click("btnGenerate");
    const imageRequest = JSON.parse(generationRequests("image")[0][1].body);
    expect(imageRequest.mode).toBe("text-to-image");
    expect(imageRequest).not.toHaveProperty("imageUrl");
    expect(imageRequest).not.toHaveProperty("referenceImageUrls");
    expect(imageRequest.prompt).not.toContain(selectedPresenter.name);
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url.endsWith("/assets") && !init?.method ? Promise.resolve(Response.json([{ id: "asset", shotId: 1, status: "done", selected: true, filePath: "/api/files/frame.jpg" }])) : normal(url, init));
    completeRuns();
    await click("刷新任务");
    await click("btnConvertMotion");
    expect(previewRequests()[0].controlInputs).not.toHaveProperty("characterReferenceUrl");
    expect(previewRequests()[0].controlInputs).not.toHaveProperty("productReferenceUrl");
  });
  it.each([false, true])("keeps exact native spoken text and audio enabled for TIDEWE batch=%s even when global audio is off", async (batchMode) => {
    const { planned } = configureTideweAssets({ savedFrame: true });
    planned.duration = 5.4;
    api.models = api.models.map((model) => model.id === ark ? { ...model, supportsAudio: true } : model);
    useSettingsStore.setState({ videoParams: { ...useSettingsStore.getState().videoParams, audioEnabled: false } });
    await mount(ark);
    if (batchMode) {
      await click("batchMotionButton");
      await act(async () => (container.querySelector('[aria-label="batch-submit-1"]') as HTMLButtonElement).click());
    } else {
      await click("btnConvertMotion");
      await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
      await click("确认生成此镜头");
    }
    expect(previewRequests()[0]).toMatchObject({ batch: batchMode, generateAudio: true, controlInputs: { supportsAudio: true } });
    expect(submissions()).toHaveLength(1);
    expect(JSON.parse(submissions()[0][1].body)).toMatchObject({ options: { duration: 6, audioEnabled: true, voiceover: planned.voiceover, audioPrompt: serverAudioPrompt } });
  });
  it.each([false, true])("generates TIDEWE visuals with post narration for a silent model, batch=%s", async (batchMode) => {
    configureTideweAssets({ savedFrame: true });
    api.models = api.models.map((model) => model.id === ark ? { ...model, supportsAudio: false } : model);
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === videoPromptUrl) {
        const request = JSON.parse(init!.body as string) as VideoPromptRequest;
        const preview = promptPreview(request);
        return Promise.resolve(Response.json({ ...preview, controlPlan: { ...preview.controlPlan, audioMode: "post", voiceoverBound: false } }));
      }
      return normal(url, init);
    });
    await mount(ark);
    if (batchMode) {
      await click("batchMotionButton");
      await act(async () => (container.querySelector('[aria-label="batch-submit-1"]') as HTMLButtonElement).click());
    } else {
      await click("btnConvertMotion");
      await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
      await click("确认生成此镜头");
    }
    expect(submissions()).toHaveLength(1);
    const generated = JSON.parse(submissions()[0][1].body);
    expect(generated).toMatchObject({ prompt: serverPrompt(), controlPlan: { audioMode: "post" }, options: { audioEnabled: false } });
    expect(generated.options.voiceover).toBeUndefined();
    expect(generated.options.audioPrompt).toBeUndefined();
    expect(backgroundItems("video")[0].asset).toMatchObject({ generationPlan: { audioMode: "post" } });
  });
  it("registers image generation together with its source script hash and import snapshot", async () => {
    configureTideweAssets();
    await mount(ark); await click("btnGenerate");
    expect(backgroundItems("image")).toHaveLength(1);
    expect(backgroundItems("image")[0]).toMatchObject({ request: { scriptId: "script", shotId: 1, mode: "image-to-image", imageUrl: "/api/files/product.jpg" }, asset: { scriptId: "script", expectedScriptHash: tideweScriptHash, shotId: 1, expectedSelectedAssetId: null } });
    expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith("/assets") && init?.method === "POST")).toBe(false);
    expect(container.querySelector('img[src="https://example.test/tidewe-generated.png"]')).toBeNull();
  });

  it("keeps a rejected image registration visibly failed without adopting a remote image", async () => {
    configureTideweAssets();
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === "/api/generation-runs" && init?.method === "POST"
      ? Promise.resolve(Response.json({ error: "The script revision changed. Refresh before adopting this image." }, { status: 409 })) : normal(url, init));
    await mount(ark); await click("btnGenerate");
    expect(container.textContent).toContain("The script revision changed. Refresh before adopting this image.");
    expect(button("retry")).toBeDefined();
    expect(button("btnConvertMotion")).toBeUndefined();
  });

  it("generates environment shots without product references or obsolete sales visual rules", async () => {
    configureTideweAssets({ productVisible: false, projectOverrides: {
      creativeIntent: { subject: "OLD SALES HOST", continuity: ["黑棚产品促销"] },
      visualBible: { productAnchors: ["OLD SALES PACKAGING"], forbiddenChanges: ["森林清晨"] },
    } });
    await mount(ark);
    await click("btnGenerate");
    const imageCalls = generationRequests("image");
    expect(imageCalls).toHaveLength(1);
    const request = JSON.parse(imageCalls[0][1].body);
    expect(request.mode).toBe("text-to-image");
    for (const field of ["imageUrl", "imageUrls", "referenceImageUrls"]) expect(request).not.toHaveProperty(field);
    expect(request.prompt).toContain("产品不出镜");
    expect(request.prompt).toContain("森林清晨");
    expect(request.prompt).not.toContain("OLD SALES HOST");
    expect(request.prompt).not.toContain("OLD SALES PACKAGING");
    expect(container.textContent).not.toContain("visualBibleBlocked");
  });

  it("sends the source hash and creative revision when editing a camera move", async () => {
    configureTideweAssets({ savedFrame: true });
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url.endsWith("/scripts") && init?.method === "PATCH"
      ? Promise.resolve(Response.json({ success: true })) : normal(url, init));
    await mount(ark);
    await act(async () => (container.querySelector('button[title="cameraEditTip"]') as HTMLButtonElement).click());
    const input = container.querySelector('input[maxlength="200"]') as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Slow pan across the jacket"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    const patch = fetchMock.mock.calls.find(([url, init]) => url.endsWith("/scripts") && init?.method === "PATCH")!;
    expect(JSON.parse(patch[1].body)).toEqual({ scriptId: "script", expectedScriptHash: tideweScriptHash, expectedCreativeConfigRevision: 7, shotTexts: [{ shotId: 1, camera: "Slow pan across the jacket" }] });
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/scripts")).length).toBeGreaterThan(2);
    expect(submissions()).toHaveLength(0);
  });

  it("keeps a recovered legacy task result available without adopting it into a newer TIDEWE script", async () => {
    configureTideweAssets({ savedFrame: true });
    pending = [{ id: "legacy-task", shotId: 1, provider: "volcengine", model: ark, taskId: "legacy-video", status: "unknown" }];
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === "/api/ai/video/task"
      ? Promise.resolve(Response.json({ status: "completed", videoUrls: ["https://example.test/recovered.mp4"] })) : normal(url, init));
    await mount(ark);
    await click("btnResumeTask");
    expect(container.textContent).toContain("该历史任务没有原始文案版本");
    expect(container.textContent).toContain("https://example.test/recovered.mp4");
    expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/project/project/assets" && init?.method === "POST")).toHaveLength(0);
    expect(container.querySelector('img[src="/api/files/frame.jpg"]')).not.toBeNull();
    expect(button("btnRedoMotion")).toBeUndefined();
    expect(submissions()).toHaveLength(0);
  });

  it.each(["pin", "tail"] as const)("keeps TIDEWE's own first frame while allowing matching-scene pin chaining with %s", async (chainMode) => {
    const { planned } = configureTideweAssets();
    useSettingsStore.setState({ chainMode });
    const shots = [1, 2, 3].map((shotId): Shot => ({ ...planned, shotId, type: "hook", tidewe: { ...planned.tidewe!, sceneId: "same-woods", productVisible: true } }));
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url.endsWith("/scripts")
      ? Promise.resolve(Response.json([{ id: "script", selected: true, scriptHash: tideweScriptHash, shots }]))
      : url.endsWith("/assets") && !init?.method ? Promise.resolve(Response.json([
        { shotId: 1, status: "done", selected: true, filePath: "/api/files/previous.mp4", sourceKeyframeUrl: "/api/files/frame-1.jpg", lastFrameUrl: "/api/files/previous-tail.jpg" },
        { shotId: 2, status: "done", selected: true, filePath: "/api/files/frame-2.jpg" },
        { shotId: 3, status: "done", selected: true, filePath: "/api/files/frame-3.jpg" },
      ])) : normal(url, init));
    await mount(ark);
    await click("btnConvertMotion"); // shot 1 is already video; the first still is shot 2.
    expect(previewRequests()).toHaveLength(1);
    const request = previewRequests()[0];
    expect(request.shotId).toBe(2);
    expect(request.controlInputs?.firstFrameUrl).toBe("/api/files/frame-2.jpg");
    expect(request.controlInputs?.lastFrameUrl).toBe(chainMode === "pin" ? "/api/files/frame-3.jpg" : undefined);
    expect(request.controlInputs?.continuityReferenceUrl).toBeUndefined();
    expect(request.chainToNext).toBe(chainMode === "pin");
    expect(submissions()).toHaveLength(0);
  });

  it.each([
    { batchMode: false, chainMode: "pin" as const }, { batchMode: true, chainMode: "pin" as const },
    { batchMode: false, chainMode: "tail" as const }, { batchMode: true, chainMode: "tail" as const },
  ])("defaults Kling to its own first frame and no tail with chain=$chainMode, batch=$batchMode", async ({ batchMode, chainMode }) => {
    const presenter = snapshotTidewePresenter(selectedPresenter)!;
    const { planned } = configureTideweAssets({ projectOverrides: { creativeProfile: createTideweOutdoorProfile({ presenter }) } });
    useSettingsStore.setState({ chainMode });
    const shots = [1, 2, 3].map((shotId): Shot => ({
      ...planned, shotId, characterId: presenter.id,
      tidewe: { ...planned.tidewe!, sceneId: "same-woods", personVisible: true, presenter },
    }));
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/scripts")) return Promise.resolve(Response.json([{ id: "script", selected: true, scriptHash: tideweScriptHash, shots }]));
      if (url.endsWith("/assets") && !init?.method) return Promise.resolve(Response.json([
        { id: "video-1", shotId: 1, status: "done", selected: true, provider: "kling-cli", filePath: "/api/files/previous.mp4", sourceKeyframeUrl: "/api/files/frame-1.jpg", lastFrameUrl: "/api/files/previous.mp4.last.jpg" },
        ...[2, 3].map((shotId) => ({ id: `keyframe-${shotId}`, shotId, status: "done", selected: true, type: "ai_generated", filePath: `/api/files/presenter-frame-${shotId}.jpg` })),
      ]));
      if (url === videoPromptUrl) {
        const request = JSON.parse(init!.body as string) as VideoPromptRequest;
        if (request.controlInputs?.firstFrameUrl !== `/api/files/presenter-frame-${request.shotId}.jpg`) {
          return Promise.resolve(Response.json({ code: "TIDEWE_PRESENTER_KEYFRAME_REQUIRED", error: "The selected presenter's current keyframe is required." }, { status: 400 }));
        }
      }
      return normal(url, init);
    });
    await mount(kling.selectionKey);
    await click(batchMode ? "batchMotionButton" : "btnConvertMotion");
    const requests = previewRequests();
    expect(requests.map((request) => request.shotId)).toEqual(batchMode ? [2, 3] : [2]);
    for (const request of requests) {
      expect(request).toMatchObject({
        provider: "kling-cli", model: kling.selectionKey,
        controlInputs: { firstFrameUrl: `/api/files/presenter-frame-${request.shotId}.jpg` },
      });
      expect(request.controlInputs?.characterReferenceUrl).toBeUndefined();
      expect(request.controlInputs?.productReferenceUrl).toBeUndefined();
      expect(request.controlInputs?.lastFrameUrl).toBeUndefined();
      expect(request.chainToNext).toBe(false);
      expect(request.controlInputs?.continuityReferenceUrl).toBeUndefined();
      expect(JSON.stringify(request)).not.toContain("previous.mp4.last.jpg");
    }
    if (batchMode) {
      expect(container.querySelector('[aria-label="batch-motion-panel"]')).not.toBeNull();
      for (const shotId of [2, 3]) {
        expect(batch.props!.shots.find(({ asset }) => asset.shotId === shotId)).toMatchObject({
          draft: { firstFrameUrl: `/api/files/presenter-frame-${shotId}.jpg` },
        });
      }
    } else {
      expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe(serverPrompt(2));
    }
    expect(submissions()).toHaveLength(0);
  });

  it.each([
    { change: "scene", chainMode: "pin" as const }, { change: "scene", chainMode: "tail" as const },
    { change: "product visibility", chainMode: "pin" as const }, { change: "product visibility", chainMode: "tail" as const },
  ])("does not automatically reuse $chainMode or continuity frames across a TIDEWE $change change", async ({ change, chainMode }) => {
    const { planned } = configureTideweAssets();
    useSettingsStore.setState({ chainMode });
    const shots = [1, 2, 3].map((shotId): Shot => ({ ...planned, shotId, type: "hook", tidewe: {
      ...planned.tidewe!, sceneId: shotId !== 2 && change === "scene" ? "other-clearing" : "same-woods",
      productVisible: !(shotId !== 2 && change === "product visibility"),
    } }));
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url.endsWith("/scripts")
      ? Promise.resolve(Response.json([{ id: "script", selected: true, scriptHash: tideweScriptHash, shots }]))
      : url.endsWith("/assets") && !init?.method ? Promise.resolve(Response.json([
        { shotId: 1, status: "done", selected: true, filePath: "/api/files/previous.mp4", sourceKeyframeUrl: "/api/files/frame-1.jpg", lastFrameUrl: "/api/files/previous-tail.jpg" },
        { shotId: 2, status: "done", selected: true, filePath: "/api/files/frame-2.jpg" },
        { shotId: 3, status: "done", selected: true, filePath: "/api/files/frame-3.jpg" },
      ])) : normal(url, init));
    await mount(ark);
    await click("btnConvertMotion");
    expect(previewRequests()).toHaveLength(1);
    expect(previewRequests()[0]).toMatchObject({ shotId: 2, chainToNext: false, controlInputs: { firstFrameUrl: "/api/files/frame-2.jpg" } });
    expect(previewRequests()[0].controlInputs?.lastFrameUrl).toBeUndefined();
    expect(previewRequests()[0].controlInputs?.continuityReferenceUrl).toBeUndefined();
    expect(submissions()).toHaveLength(0);
  });

  it("recovers a task into its original script without changing the current preview or tail-frame cache", async () => {
    const { planned } = configureTideweAssets({ savedFrame: true });
    useSettingsStore.setState({ chainMode: "tail" });
    const sourceContext = { version: 1, sourceScriptId: "original-script", sourceShotKey: "b".repeat(64), sourceRevision: "c".repeat(64) };
    pending = [{ id: "original-task", shotId: 1, provider: "volcengine", model: ark, taskId: "original-video", status: "unknown", controlPlan: {
      version: 1, strategy: "keyframe", mode: "image-to-video", referenceRoles: ["keyframe"], referenceCount: 1, audioMode: "none", voiceoverBound: false, warnings: [], sourceContext,
    } }];
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/scripts")) return Promise.resolve(Response.json([{ id: "script", selected: true, scriptHash: tideweScriptHash, shots: [planned, { ...planned, shotId: 2 }] }]));
      if (url.endsWith("/assets")) return Promise.resolve(Response.json(init?.method === "POST"
        ? { filePath: "/api/files/original-recovered.mp4", lastFrameUrl: "/api/files/original-tail.jpg" }
        : [1, 2].map((shotId) => ({ shotId, status: "done", selected: true, filePath: `/api/files/current-frame-${shotId}.jpg` }))));
      if (url === "/api/ai/video/task") return Promise.resolve(Response.json({ status: "completed", videoUrls: ["https://example.test/original-recovered.mp4"] }));
      return normal(url, init);
    });
    await mount(ark);
    await click("btnResumeTask");
    const save = fetchMock.mock.calls.find(([url, init]) => url === "/api/project/project/assets" && init?.method === "POST")!;
    expect(JSON.parse(save[1].body)).toMatchObject({ scriptId: sourceContext.sourceScriptId, expectedScriptHash: sourceContext.sourceRevision, sourceUrl: "https://example.test/original-recovered.mp4", generationPlan: { sourceContext } });
    expect(container.querySelector('img[src="/api/files/current-frame-1.jpg"]')).not.toBeNull();
    expect(container.querySelector('a[href="/api/files/original-recovered.mp4"]')).toBeNull();
    expect(button("btnRedoMotion")).toBeUndefined();
    const nextMotion = [...container.querySelectorAll("button")].filter((item) => item.textContent?.includes("btnConvertMotion"))[1];
    await act(async () => nextMotion.click());
    expect(previewRequests()).toHaveLength(1);
    expect(previewRequests()[0]).toMatchObject({ shotId: 2, controlInputs: { firstFrameUrl: "/api/files/current-frame-2.jpg" } });
    expect(previewRequests()[0].controlInputs?.continuityReferenceUrl).toBeUndefined();
    expect(submissions()).toHaveLength(0);
  });
});

describe("assets uses the configured provider through one motion entry", () => {
  it("queues the selected grid resolution and lets the user leave before rendering completes", async () => {
    api.models.push({ id: "fixture-image", name: "Fixture image", provider: "volcengine", mediaType: "image", modes: ["text-to-image"] });
    useSettingsStore.setState({ uiMode: "pro", defaultImageModel: "fixture-image", imageParams: { aspectRatio: "1:1", count: 4, seed: 23 } });
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url.endsWith("/scripts") ? Promise.resolve(Response.json([{ id: "script", selected: true, shots: [1, 2].map(shotId => ({ shotId, type: "demo", duration: 5, description: "Product rotates", visualSource: "ai_generate" })) }])) : normal(url, init));
    await mount(ark);
    const select = container.querySelector<HTMLSelectElement>("#storyboard-grid-resolution")!;
    expect(select.value).toBe("4k");
    await act(async () => { select.value = "2k"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await click("gridButton");
    expect(backgroundItems("storyboard_grid")[0].request).toMatchObject({ gridResolution: "2k", options: { width: 1080, height: 1920, count: 1, seed: 23 } });
    expect(container.textContent).toContain("九宫格已进入后台任务");
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/storyboard-grid"))).toBe(false);
  });

  it("only shows local video tasks belonging to the selected script, including after refresh", async () => {
    const current = savedKlingJob({ modelId: "current-script-video" });
    const other = savedKlingJob({ jobId: "other-job", scriptId: "other-script", modelId: "other-script-video" });
    api.jobs = [other, current];
    await mount(kling.selectionKey);
    const tasks = () => container.querySelector('[aria-label="Kling 视频任务"]')!;
    expect(tasks().textContent).toContain("current-script-video");
    expect(tasks().textContent).not.toContain("other-script-video");
    await click("刷新本地记录");
    expect(tasks().textContent).toContain("current-script-video");
    expect(tasks().textContent).not.toContain("other-script-video");
    expect(submissions()).toHaveLength(0);
  });

  it("hides the local video task list when only other scripts have tasks", async () => {
    api.jobs = [savedKlingJob({ scriptId: "other-script" })];
    await mount(kling.selectionKey);
    expect(container.querySelector('[aria-label="Kling 视频任务"]')).toBeNull();
    expect(button("查看 / 恢复")).toBeUndefined();
    expect(deleteVideoButton()).toBeNull();
  });

  it("keeps tasks hidden until the selected script has loaded", async () => {
    api.jobs = [savedKlingJob()];
    const normalFetch = fetchMock.getMockImplementation()!;
    let finishScripts!: (response: Response) => void;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url.endsWith("/scripts")
      ? new Promise<Response>((resolve) => { finishScripts = resolve; })
      : normalFetch(url, init));
    await mount(kling.selectionKey);
    expect(container.querySelector('[aria-label="Kling 视频任务"]')).toBeNull();
    await act(async () => finishScripts(Response.json([{ id: "script", selected: true, shots: [{ shotId: 1, type: "demo", duration: 5, visualSource: "product_image" }] }])));
    expect(container.querySelector('[aria-label="Kling 视频任务"]')).not.toBeNull();
  });

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
    api.jobs = [savedKlingJob()]; api.concurrency = { active: 1, max: null, blockedByUnknownSubmission: false };
    api.showMaterialLibrary = true; isVideo = true;
    const originalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url.endsWith("/materials") ? Promise.resolve(Response.json({ materials: [] })) : originalFetch(url, init));
    const originalKling = api.kling.getMockImplementation()!;
    api.kling.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") { api.jobs = []; isVideo = false; api.concurrency = { active: 0, max: null, blockedByUnknownSubmission: false }; return Promise.resolve(Response.json({ deleted: true, jobId: "saved-job" })); }
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
    expect(container.textContent).not.toContain("最多同时生成 10");
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
    api.jobs = [oldJob]; api.concurrency = { active: 1, max: null, blockedByUnknownSubmission: true };
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
        api.jobs = []; api.concurrency = { active: 0, max: null, blockedByUnknownSubmission: false };
        return Promise.resolve(Response.json({ deleted: true, jobId: oldJob.jobId }));
      }
      return originalKling(url, init);
    });
    await click("刷新本地记录");
    expect(finishOldPoll).toBeTypeOf("function");
    await act(async () => deleteVideoButton().click());
    await click("确认删除");
    expect(container.querySelector('[aria-label="Kling 视频任务"]')).toBeNull();
    expect(container.textContent).not.toContain("最多同时生成 10");
    await act(async () => finishOldPoll(Response.json(status === 200 ? { jobs: [oldJob] } : { error: "旧轮询失败" }, { status })));
    expect(container.querySelector('[aria-label="Kling 视频任务"]')).toBeNull();
    expect(container.textContent).not.toContain("最多同时生成 10");
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

  it("waits for the initial material context before exposing task deletion", async () => {
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
    expect(deleteVideoButton()).toBeNull();
    await act(async () => finishInitialAssets(Response.json([{ id: "asset", shotId: 1, status: "done", selected: true, type: "ai_generate", provider: "kling-cli", filePath: "/api/files/clip.mp4", thumbnailPath: "/api/files/frame.jpg" }])));
    expect(deleteVideoButton()).not.toBeNull();
    await act(async () => deleteVideoButton().click());
    await click("确认删除");
    expect(container.querySelector('[aria-label="Kling 视频任务"]')).toBeNull();
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
    expect([...container.querySelectorAll("h2")].some((heading) => heading.textContent === "删除任务？")).toBe(true);
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

  it("opens the clicked source or thumbnail image independently of video playback", async () => {
    const poster = "/api/files/project/generated.mp4.thumb.jpg";
    const source = "/api/files/project/kling/job/source-keyframe.png";
    const video = "/api/files/project/generated.mp4";
    const originalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url.endsWith("/assets")
      ? Promise.resolve(Response.json([{ id: "generated", shotId: 1, status: "done", selected: true, type: "ai_generated", provider: "kling-cli", filePath: video, thumbnailPath: poster, sourceKeyframeUrl: source }]))
      : originalFetch(url, init));
    await mount(kling.selectionKey);
    for (const imageUrl of [source, poster]) {
      const thumbnail = [...container.querySelectorAll("img")].find((image) => image.src === new URL(imageUrl, window.location.href).href)!;
      await act(async () => thumbnail.closest("button")!.click());
      const title = [...container.querySelectorAll("h2")].find((heading) => heading.textContent === "imagePreviewTitle");
      expect(title).toBeDefined();
      expect(title!.parentElement!.parentElement!.querySelector("img")?.src).toBe(new URL(imageUrl, window.location.href).href);
      await act(async () => (container.querySelector('[aria-label="closeImagePreview"]') as HTMLButtonElement).click());
      expect([...container.querySelectorAll("h2")].some((heading) => heading.textContent === "imagePreviewTitle")).toBe(false);
    }
    expect(container.querySelector('a[aria-label="playShotVideo"]')?.getAttribute("href")).toBe(video);
    expect(submissions()).toHaveLength(0);
  });

  it.each([9, 40])("permits confirming a background Kling shot with %i existing account jobs", async (active) => {
    api.concurrency = { active, max: null, blockedByUnknownSubmission: false };
    await mount(kling.selectionKey);
    expect(button("btnConvertMotion")!.disabled).toBe(false);
    expect(container.textContent).not.toContain("最多同时生成 10");
    await click("btnConvertMotion");
    expect(container.querySelector("h2")?.textContent).toContain("确认镜头 1 视频生成");
    expect(submissions()).toHaveLength(0);
  });

  it("keeps original task recovery available while account capacity is full", async () => {
    api.concurrency = { active: 10, max: null, blockedByUnknownSubmission: true };
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
    expect(prompt.value).toBe(serverPrompt());
    expect(prompt.readOnly).toBe(true);
    expect(previewRequests()).toHaveLength(1);
    expect(previewRequests()[0]).toMatchObject({ scriptId: "script", shotId: 1, provider: defaultModel === ark ? "volcengine" : "kling-cli", model: defaultModel });
    expect(submissions()).toHaveLength(0);
  });

  it("requests the chosen visual settings and displays the backend response verbatim", async () => {
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
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe(serverPrompt());
    expect(previewRequests()[0]).toMatchObject({ scriptId: "script", shotId: 1, settings });
    expect(previewRequests()[0]).not.toHaveProperty("prompt");
    expect(previewRequests()[0]).not.toHaveProperty("creativeIntent");
    expect(submissions()).toHaveLength(0);
  });

  it.each([ark, kling.selectionKey])("sends the saved negative prompt to the server and forwards its final negative unchanged with %s", async (defaultModel) => {
    const savedNegative = "Avoid distorted controls and duplicated product parts.";
    const finalNegative = "Backend exclusions in approved order.\nPreserve the exact final text.";
    useSettingsStore.setState({ videoParams: { ...useSettingsStore.getState().videoParams, negativePrompt: savedNegative } });
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === videoPromptUrl
      ? Promise.resolve(Response.json(promptPreview(JSON.parse(init!.body as string), { negativePrompt: finalNegative })))
      : normalFetch(url, init));
    const normalKling = api.kling.getMockImplementation()!;
    api.kling.mockImplementation((url: string, init?: RequestInit) => url.includes("/status")
      ? Promise.resolve(Response.json({ loggedIn: true, models: [{ ...kling, parameters: [...kling.parameters, { name: "negative_prompt", type: "string", required: false }] }] }))
      : normalKling(url, init));

    await mount(defaultModel);
    await click("btnConvertMotion");
    expect(previewRequests()[0]).toMatchObject({ negativePrompt: savedNegative });
    await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await click("确认生成此镜头");

    expect(submissions()).toHaveLength(1);
    const request = JSON.parse(submissions()[0][1].body);
    expect(request.promptContext).toMatchObject({ negativePrompt: savedNegative, contextKey: "backend-context-1" });
    expect(request.options[defaultModel === ark ? "negativePrompt" : "negative_prompt"]).toBe(finalNegative);
  });

  it.each([
    { creationType: "sales", defaultModel: ark },
    { creationType: "CG", defaultModel: ark },
    { creationType: "sales", defaultModel: kling.selectionKey },
    { creationType: "CG", defaultModel: kling.selectionKey },
  ])("uses the same backend text for initial and redo $creationType generation with $defaultModel", async ({ creationType, defaultModel }) => {
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => creationType === "CG" && url === "/api/project/project"
      ? Promise.resolve(Response.json({ name: "Product", productImages: ["/api/files/product.jpg"], creativeProfile: createPremiumProductCgProfile() }))
      : normalFetch(url, init));
    await mount(defaultModel);
    await click("btnConvertMotion");
    const firstPrompt = (container.querySelector("textarea") as HTMLTextAreaElement).value;
    expect(firstPrompt).toBe(serverPrompt());
    await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await click("确认生成此镜头");
    expect(JSON.parse(submissions()[0][1].body).prompt).toBe(firstPrompt);

    isVideo = true; completeRuns();
    await click("刷新任务");
    await click("btnRedoMotion");
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe(firstPrompt);
    expect(previewRequests()).toHaveLength(2);
    expect(previewRequests()[1].controlInputs?.firstFrameUrl).toBe("/api/files/frame.jpg");
    await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await click("确认生成此镜头");
    expect(submissions()).toHaveLength(2);
    for (const [, init] of submissions()) {
      expect(JSON.parse(init.body)).toMatchObject({ prompt: firstPrompt, promptContext: { contextKey: "backend-context-1" } });
    }
  });

  it("allows retry after a backend preview failure without submitting video generation", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    let attempts = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === videoPromptUrl && ++attempts === 1
      ? Promise.resolve(Response.json({ error: "Backend preview unavailable" }, { status: 503 }))
      : normalFetch(url, init));
    await mount(ark);
    await click("btnConvertMotion");
    expect(container.textContent).toContain("Backend preview unavailable");
    expect(container.querySelector("textarea")).toBeNull();
    expect(button("btnConvertMotion")?.disabled).toBe(false);
    expect(submissions()).toHaveLength(0);
    await click("btnConvertMotion");
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe(serverPrompt());
    expect(previewRequests()).toHaveLength(2);
    expect(submissions()).toHaveLength(0);
  });

  it("ignores a late backend preview after video settings change and allows a fresh preview", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    let resolvePreview!: (response: Response) => void;
    let delayed = true;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === videoPromptUrl && delayed) {
        delayed = false;
        return new Promise<Response>((resolve) => { resolvePreview = resolve; });
      }
      return normalFetch(url, init);
    });
    await mount(ark);
    await click("btnConvertMotion");
    const previousRequest = previewRequests()[0];
    await act(async () => useSettingsStore.setState({ motionIntensity: "strong" }));
    await act(async () => resolvePreview(Response.json(promptPreview(previousRequest, { prompt: "Stale backend result." }))));
    expect(container.querySelector("textarea")).toBeNull();
    expect(submissions()).toHaveLength(0);
    await click("btnConvertMotion");
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe(serverPrompt());
    expect(previewRequests()[1].settings.motionIntensity).toBe("strong");
  });

  it("prepares only one backend preview when the motion button is clicked twice", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    let resolvePreview!: (response: Response) => void;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === videoPromptUrl
      ? new Promise<Response>((resolve) => { resolvePreview = resolve; })
      : normalFetch(url, init));
    await mount(ark);
    const convert = button("btnConvertMotion")!;
    await act(async () => { convert.click(); convert.click(); });
    expect(previewRequests()).toHaveLength(1);
    expect(submissions()).toHaveLength(0);
    await act(async () => resolvePreview(Response.json(promptPreview(previewRequests()[0]))));
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe(serverPrompt());
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

  it("submits the server prompt and native audio plan without adding local instructions", async () => {
    useSettingsStore.setState({ videoParams: { ...useSettingsStore.getState().videoParams, audioEnabled: true } });
    api.models = api.models.map((model) => model.id === ark ? { ...model, supportsAudio: true } : model);
    const originalFetch = fetchMock.getMockImplementation()!;
    const voiceover = "只自然说一遍这句台词";
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url.endsWith("/scripts")
      ? Promise.resolve(Response.json([{ id: "script", selected: true, shots: [{ shotId: 1, type: "demo", duration: 5, description: "商品保持静止，底部显示“价格以商品页为准”", camera: "固定镜头。", voiceover, visualSource: "ai_generate", transition: "direct_concat" }] }]))
      : originalFetch(url, init));
    await mount(ark);
    await click("btnConvertMotion");
    const reviewedPrompt = (container.querySelector('[aria-label="视频提示词"]') as HTMLTextAreaElement).value;
    expect(reviewedPrompt).toBe(serverPrompt());
    expect(previewRequests()[0]).toMatchObject({ generateAudio: true, controlInputs: { supportsAudio: true } });
    await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await click("确认生成此镜头");
    expect(submissions()).toHaveLength(1);
    expect(JSON.parse(submissions()[0][1].body)).toMatchObject({ prompt: reviewedPrompt, promptContext: { contextKey: "backend-context-1", generateAudio: true }, options: { audioEnabled: true, voiceover, audioPrompt: serverAudioPrompt } });
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
    expect(prompt).toBe(serverPrompt());
    expect(previewRequests()[0]).toMatchObject({ generateAudio: false, controlInputs: { supportsAudio: false } });
    await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await click("确认生成此镜头");
    const request = JSON.parse(submissions()[0][1].body);
    expect(request.options.audioEnabled).toBe(false);
    expect(request.options.audioPrompt).toBeUndefined();
    expect(request.options.voiceover).toBeUndefined();
  });

  it.each([
    { locked: false, batchMode: false }, { locked: true, batchMode: false },
    { locked: false, batchMode: true }, { locked: true, batchMode: true },
  ])("uses only first and optional tail with Kling product lock=$locked and batch=$batchMode", async ({ locked, batchMode }) => {
    useSettingsStore.setState({ uiMode: "pro" });
    const characterUrl = "/api/files/host.png";
    const productUrls = ["/api/files/product.jpg", "/api/files/product-side.jpg"];
    useCharacterStore.setState({ characters: [{ id: "host", name: "Host", appearance: "Adult presenter", referenceImages: [characterUrl] }] });
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/project/project") return Promise.resolve(Response.json({ name: "Product", productImages: productUrls }));
      if (url.endsWith("/scripts")) return Promise.resolve(Response.json([{ id: "script", selected: true, shots: [{ shotId: 1, type: "demo", characterId: "host", duration: 5, description: "Product rotates.", camera: "Slow dolly in", visualSource: "ai_generate", transition: "direct_concat" }] }]));
      if (url === videoPromptUrl) {
        const request = JSON.parse(init!.body as string) as VideoPromptRequest;
        const referenceInputs = [
          ...(request.controlInputs?.characterReferenceUrl ? [{ url: request.controlInputs.characterReferenceUrl, role: "character" as const, mediaType: "image" as const, required: true }] : []),
          ...(request.controlInputs?.productReferenceUrl ? productUrls.map((url) => ({ url, role: "product" as const, mediaType: "image" as const, required: true })) : []),
        ];
        const value = promptPreview(request);
        value.controlPlan.referenceInputs = referenceInputs;
        value.controlPlan.referenceCount = 1 + referenceInputs.length;
        return Promise.resolve(Response.json(value));
      }
      return normalFetch(url, init);
    });
    await mount(kling.selectionKey);
    if (!locked) await click("productSafe");
    await click(batchMode ? "batchMotionButton" : "btnConvertMotion");
    expect(previewRequests()[0].controlInputs?.productReferenceUrl).toBeUndefined();
    expect(previewRequests()[0].controlInputs?.characterReferenceUrl).toBeUndefined();
    expect(previewRequests()[0].controlInputs?.lastFrameUrl).toBeUndefined();
    if (batchMode) {
      const draft = batch.props!.shots[0].draft!;
      expect(draft.referenceImages).toEqual([]);
      expect(draft.frameChoices).toContainEqual({ label: "人物图片", url: characterUrl });
      if (locked) expect(draft.frameChoices).toContainEqual({ label: "产品图片", url: productUrls[0] });
      const refreshed = await draft.refreshFrames!(draft.firstFrameUrl, productUrls[0]);
      expect(refreshed.lastFrameUrl).toBe(productUrls[0]);
      expect(previewRequests().at(-1)).toMatchObject({ chainToNext: true, controlInputs: { firstFrameUrl: draft.firstFrameUrl, lastFrameUrl: productUrls[0] } });
      expect(previewRequests().at(-1)?.controlInputs?.productReferenceUrl).toBeUndefined();
    } else {
      await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
      await click("确认生成此镜头");
      expect(JSON.parse(submissions()[0][1].body)).not.toHaveProperty("referenceImageUrls");
    }
  });

  it("requests native Kling audio from the backend despite false catalog capability", async () => {
    const originalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url.endsWith("/scripts")
      ? Promise.resolve(Response.json([{ id: "script", selected: true, shots: [{ shotId: 1, type: "demo", duration: 5, description: "商品保持静止", camera: "固定镜头", voiceover: "不应自动注入的Kling台词", visualSource: "ai_generate", transition: "direct_concat" }] }]))
      : originalFetch(url, init));
    api.models = api.models.map((model) => model.provider === "kling-cli" ? { ...model, supportsAudio: false } : model);
    await mount(kling.selectionKey);
    await click("btnConvertMotion");
    const prompt = (container.querySelector('[aria-label="Kling 视频提示词"]') as HTMLTextAreaElement).value;
    expect(prompt).toBe(serverPrompt());
    expect(previewRequests()[0]).toMatchObject({ provider: "kling-cli", generateAudio: true, controlInputs: { supportsAudio: true } });
    expect(submissions()).toHaveLength(0);
  });

  it.each([false, true])("requests audioEnabled=%s from the backend before the API confirmation", async (audioEnabled) => {
    const modelId = "fixture/image-to-video";
    api.models.push({ id: modelId, name: "Fixture", provider: "volcengine", mediaType: "video", modes: ["image-to-video"], supportsAudio: false });
    useSettingsStore.setState({ videoParams: { ...useSettingsStore.getState().videoParams, audioEnabled } });
    await mount(modelId);
    await click("btnConvertMotion");
    const prompt = (container.querySelector('[aria-label="视频提示词"]') as HTMLTextAreaElement).value;
    expect(prompt).toBe(serverPrompt());
    expect(previewRequests()[0]).toMatchObject({ generateAudio: audioEnabled, controlInputs: { supportsAudio: false } });
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
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === "/api/generation-runs" && init?.method === "POST" ? Promise.reject(new TypeError("Network interrupted")) : normal(url, init));
    await mount(ark); await click("btnConvertMotion");
    await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await click("确认生成此镜头");
    await act(async () => (container.querySelector('[aria-label="close-dialog"]') as HTMLButtonElement).click());
    await click("btnConvertMotion");
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("此镜头已有待恢复视频任务");
    expect(submissions()).toHaveLength(1);
  });

  it("prepares batch motion without submitting and generates only the chosen shots from their own silent keyframes", async () => {
    const voiceover = "SCRIPTED VOICEOVER MUST NOT ENTER BATCH MOTION";
    const shots = [1, 2, 3, 4].map((shotId) => ({ shotId, type: "demo", duration: 5, description: `Product detail ${shotId}`, camera: "Slow dolly in", voiceover, visualSource: "ai_generate", transition: "direct_concat" }));
    const saved = shots.map(({ shotId }) => ({ id: `asset-${shotId}`, shotId, status: "done", selected: true, type: "ai_generate", provider: "volcengine", filePath: `/api/files/frame-${shotId}.jpg`, ...(shotId === 1 && { filePath: "/api/files/previous-video.mp4", sourceKeyframeUrl: "/api/files/frame-1.jpg", lastFrameUrl: "/api/files/previous-tail.jpg" }) }));
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url.endsWith("/scripts")
      ? Promise.resolve(Response.json([{ id: "script", selected: true, shots }]))
      : url.endsWith("/assets") && !init?.method ? Promise.resolve(Response.json(saved)) : normal(url, init));
    api.models = api.models.map((model) => model.id === ark ? { ...model, supportsAudio: true } : model);
    useSettingsStore.setState({ chainMode: "tail", videoParams: { ...useSettingsStore.getState().videoParams, audioEnabled: true } });
    await mount(ark);

    expect(button("整片自动编排")).toBeUndefined();
    await click("batchMotionButton");
    expect(container.querySelector('[aria-label="batch-motion-panel"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="film-panel"]')).toBeNull();
    expect(batch.props).toMatchObject({ projectId: "project", scriptId: "script", provider: "volcengine", selectionKey: ark, valid: true });
    expect(submissions()).toHaveLength(0);
    const chosen = batch.props!.shots.filter(({ asset }) => asset.shotId === 2 || asset.shotId === 4);
    expect(chosen).toHaveLength(2);
    for (const { asset, draft } of chosen) {
      expect(draft?.firstFrameUrl).toBe(`/api/files/frame-${asset.shotId}.jpg`);
      expect(draft?.lastFrameUrl).toBeUndefined();
      expect(draft?.prompt).toBe(serverPrompt(asset.shotId));
    }

    await act(async () => (container.querySelector('[aria-label="batch-submit-2"]') as HTMLButtonElement).click());
    await act(async () => (container.querySelector('[aria-label="batch-submit-4"]') as HTMLButtonElement).click());
    const requests = submissions().map(([, init]) => JSON.parse(init.body));
    expect(requests.map(({ shotId }) => shotId)).toEqual([2, 4]);
    for (const request of requests) {
      expect(request.imageUrl ?? request.referenceImageUrls?.[0]).toBe(`/api/files/frame-${request.shotId}.jpg`);
      expect(request.lastImageUrl).toBeUndefined();
      expect(request.options.audioEnabled).toBe(false);
      expect(request.prompt).toBe(serverPrompt(request.shotId));
      expect(request.promptContext).toMatchObject({ contextKey: `backend-context-${request.shotId}`, batch: true, generateAudio: false });
      for (const field of ["voiceover", "audioPrompt", "audioUrl", "audioReferenceUrl", "tts", "ttsEnabled", "subtitles"]) expect(request.options[field]).toBeUndefined();
      expect(request.referenceAudioUrls).toBeUndefined();
      expect(JSON.stringify(request)).not.toContain("previous-tail.jpg");
      expect(JSON.stringify(request)).not.toContain(voiceover);
    }
    expect([...fetchMock.mock.calls, ...api.kling.mock.calls].some(([url]) => /\/film(?:\/|$)/.test(url))).toBe(false);
  });

  it("excludes existing videos, missing or generating frames and unresolved tasks from batch submission", async () => {
    const shots = [1, 2, 3, 4, 5, 6].map((shotId) => ({ shotId, type: "demo", duration: 5, description: `Product detail ${shotId}`, camera: "Slow dolly in", visualSource: "ai_generate", transition: "direct_concat" }));
    const saved = [1, 2, 4, 5, 6].map((shotId) => ({ id: `asset-${shotId}`, shotId, status: shotId === 4 ? "generating" : "done", selected: true, type: "ai_generate", provider: "volcengine", filePath: shotId === 2 ? "/api/files/video-2.mp4" : `/api/files/frame-${shotId}.jpg` }));
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url.endsWith("/scripts")
      ? Promise.resolve(Response.json([{ id: "script", selected: true, shots }]))
      : url.endsWith("/assets") && !init?.method ? Promise.resolve(Response.json(saved)) : normal(url, init));
    pending = [{ id: "pending-row", shotId: 5, provider: "volcengine", model: ark, taskId: "pending-video", status: "processing" }];
    api.jobs = [savedKlingJob({ shotId: 6, submissionState: "submission_unknown", remoteState: "unknown", importState: "not_ready", outputs: [] })];
    await mount(ark);
    await click("batchMotionButton");
    expect(batch.props?.shots).toHaveLength(6);
    expect(batch.props?.shots.find(({ asset }) => asset.shotId === 1)?.draft).toBeDefined();
    for (const shotId of [2, 3, 4, 5, 6]) {
      const row = batch.props!.shots.find(({ asset }) => asset.shotId === shotId)!;
      expect(row.disabledReason).toBeTruthy();
      expect(row.draft).toBeUndefined();
      expect((container.querySelector(`[aria-label="batch-submit-${shotId}"]`) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(submissions()).toHaveLength(0);
  });

  it("invalidates prepared batch submissions after video settings change", async () => {
    await mount(ark);
    await click("batchMotionButton");
    const draft = batch.props!.shots[0].draft!;
    expect(batch.props?.valid).toBe(true);
    await act(async () => useSettingsStore.setState({ motionIntensity: "strong" }));
    expect(batch.props?.valid).toBe(false);
    await act(async () => { await expect(draft.generate()).rejects.toThrow("设置已更改"); });
    expect(submissions()).toHaveLength(0);
  });

  it("rejects a prepared batch draft when a refreshed shot has a different source image", async () => {
    let source = "/api/files/original-frame.jpg";
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url.endsWith("/assets") && !init?.method
      ? Promise.resolve(Response.json([{ id: "asset", shotId: 1, status: "done", selected: true, type: "ai_generate", provider: "volcengine", filePath: source }]))
      : normal(url, init));
    api.jobs = [savedKlingJob()];
    await mount(ark);
    await click("batchMotionButton");
    const draft = batch.props!.shots[0].draft!;
    expect(draft.firstFrameUrl).toBe(source);
    source = "/api/files/replacement-frame.jpg";
    await click("查看 / 恢复");
    await act(async () => (container.querySelector('[aria-label="refresh-job-detail"]') as HTMLButtonElement).click());
    expect(container.querySelector(`img[src="${source}"]`)).not.toBeNull();
    await act(async () => { await expect(draft.generate()).rejects.toThrow(/分镜图片.*已更改/); });
    expect(submissions()).toHaveLength(0);
  });

  it("freezes batch video import metadata alongside the provider request", async () => {
    await mount(ark); await click("batchMotionButton");
    const draft = batch.props!.shots[0].draft!;
    await act(async () => { await draft.generate(); });
    expect(backgroundItems("video")[0].asset).toMatchObject({ scriptId: "script", shotId: 1, provider: "volcengine", model: ark, thumbnailPath: "/api/files/frame.jpg", expectedSelectedAssetId: "asset" });
    expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith("/assets") && init?.method === "POST")).toBe(false);
  });

  it("restores a background import failure and keeps its snapshot out of a new batch", async () => {
    api.runs = [{ id: "old-run", projectId: "project", kind: "video", status: "needs_attention", total: 1, done: 0, failed: 1, items: [{ id: "old-item", kind: "video", scriptId: "script", shotId: 1, status: "needs_attention", error: "Import unavailable" }] }];
    await mount(ark);
    expect(container.textContent).toContain("Import unavailable");
    await click("batchMotionButton");
    expect(batch.props!.shots[0].disabledReason).toBe("batchMotionExistingTask");
    expect(submissions()).toHaveLength(0);
  });

  it("blocks unsupported premium CG batch imports before starting a paid generation", async () => {
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === "/api/project/project"
      ? Promise.resolve(Response.json({ name: "Product", productImages: ["/api/files/product.jpg"], creativeProfile: createPremiumProductCgProfile() })) : normal(url, init));
    await mount(ark);
    await click("batchMotionButton");
    expect(batch.props!.shots[0]).toMatchObject({ disabledReason: "batchMotionControlledModelRequired" });
    expect(batch.props!.shots[0].draft).toBeUndefined();
    expect((container.querySelector('[aria-label="batch-submit-1"]') as HTMLButtonElement).disabled).toBe(true);
    expect(submissions()).toHaveLength(0);
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

  it.each([ark, kling.selectionKey])("ignores the retired Kling film creation link with default model %s", async (videoModel) => {
    await navigate("/project/project/assets?klingFilm=1");
    await mount(videoModel);
    expect(container.querySelector('[aria-label="film-panel"]')).toBeNull();

    await navigate("/project/project/assets?klingFilm=existing-film");
    expect(container.querySelector('[aria-label="film-panel"]')?.getAttribute("data-run-id")).toBe("existing-film");
    await navigate("/project/project/assets?klingFilm=1");
    expect(container.querySelector('[aria-label="film-panel"]')).toBeNull();
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

  it.each(["klingFilm=film-a", "klingJob=job-a"])("closes a task on history navigation away from %s and opens only batch motion from the header", async (query) => {
    await mount(kling.selectionKey);
    await navigate(`/project/project/assets?${query}`);
    expect(container.querySelector('[aria-label="film-panel"], [aria-label="job-detail"]')).not.toBeNull();

    await navigate("/project/project/assets");
    expect(container.querySelector('[aria-label="film-panel"], [aria-label="job-detail"]')).toBeNull();
    expect(button("整片自动编排")).toBeUndefined();
    await click("batchMotionButton");
    expect(container.querySelector('[aria-label="film-panel"]')).toBeNull();
    expect(container.querySelector('[aria-label="batch-motion-panel"]')).not.toBeNull();
    await navigate("/project/project/assets?view=shots#shot-1");
    expect(container.querySelector('[aria-label="batch-motion-panel"]')).not.toBeNull();
    expect(submissions()).toHaveLength(0);
  });
});
