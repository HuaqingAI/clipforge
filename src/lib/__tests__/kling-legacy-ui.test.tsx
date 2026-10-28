import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ScriptPage from "@/app/project/[id]/script/page";
import ClonePage from "@/app/project/clone/page";
import { VideoRepairPanel } from "@/components/video-repair-panel";
import { useSettingsStore } from "@/lib/stores/settings-store";
import type { Model } from "@/lib/providers/types";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "project-1" }), useRouter: () => ({ push: navigation.push }) }));
vi.mock("@/components/project-header", () => ({ ProjectHeader: () => null }));
vi.mock("@/components/generation-runs-panel", () => ({ GenerationRunsPanel: () => null }));
vi.mock("@/lib/hooks/use-generation-runs", async (original) => ({ ...await original<typeof import("@/lib/hooks/use-generation-runs")>(), useGenerationRuns: () => ({ runs: [], loading: false, error: null }) }));
vi.mock("@/components/storyboard-film-panel", () => ({ StoryboardFilmPanel: ({ open }: { open: boolean }) => open ? <section aria-label="shared-film-panel">整片自动编排</section> : null }));
vi.mock("@/lib/i18n", () => { const t = (key: string) => key; return { useT: () => t, useLocale: () => "zh" }; });
vi.mock("@/lib/model-capabilities", () => ({ getVideoModelCapabilities: () => ({ referenceVideo: true }) }));

const cliModel = JSON.stringify(["kling-cli", "image_to_video", "official"]);
const atlasModel = "bytedance/seedance-2.0/reference-to-video";
const atlas: Model = { id: atlasModel, name: "Atlas Seedance", provider: "atlas-cloud", mediaType: "video", modes: ["video-to-video"] };
const initial = useSettingsStore.getInitialState();
const fetchMock = vi.fn();
let root: Root;
let container: HTMLDivElement;

function button(part: string): HTMLButtonElement { return [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(part))!; }
async function mount(component: Parameters<typeof root.render>[0]) { await act(async () => root.render(component)); }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const response = await fetchMock(url, init);
    if (url !== "/api/generation-runs" || !response.ok) return response;
    const result = await response.json();
    return Response.json({ id: "run-script", projectId: "project-1", kind: "script", status: "completed", total: 1, done: 1, failed: 0,
      items: [{ id: "item-script", kind: "script", status: "completed", result }] });
  });
  navigation.push.mockReset();
  useSettingsStore.setState({ ...initial, locale: "zh", uiMode: "simple", providers: { "atlas-cloud": { enabled: true, apiKey: "test-atlas" }, "kling-cli": { enabled: true, apiKey: "", profileId: "profile" } }, defaultVideoModel: atlasModel });
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/ai/models") return Response.json({ models: [atlas] });
    if (url === "/api/replicate/analyze") return Response.json({ duration: 5, path: "/api/files/reference.mp4", shots: [{ index: 1, start: 0, duration: 5 }], modelTierEligible: true, width: 720, height: 1280 });
    if (url.endsWith("/scripts")) return Response.json(init?.method === "PATCH" ? {} : [{ id: "script-1", title: "Test", styleType: "scene", totalDuration: 5, selected: true, shots: [{ shotId: 1, type: "demo", duration: 5, description: "Product", voiceover: "Product details", visualSource: "ai_generate", transition: "direct_concat" }] }]);
    if (url === "/api/project/project-1") return Response.json({ name: "Product", productName: "Product", productImages: [], videoMode: "product_closeup" });
    if (url.endsWith("/storyboard-film")) return Response.json({ prompt: "Preview", shotCount: 1, seconds: 5, model: atlasModel, scriptSeconds: 5, modelMaxSeconds: 15, durationOverflow: false, referenceImages: 1, dialogueWarnings: [] });
    throw new Error("Unexpected request: " + url);
  });
  window.history.replaceState(null, "", "/project/project-1/script");
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useSettingsStore.setState(initial); vi.unstubAllGlobals(); });

describe("Kling defaults never become another paid provider", () => {
  it.each([
    ["simple", cliModel], ["pro", cliModel], ["simple", atlasModel], ["pro", atlasModel],
  ] as const)("keeps full-film orchestration off the %s script page with default %s", async (uiMode, selectedModel) => {
    useSettingsStore.setState({ uiMode });
    useSettingsStore.getState().setDefaultVideoModel(selectedModel);
    await mount(createElement(ScriptPage));
    expect(button("整片自动编排")).toBeUndefined();
    expect(container.querySelector('[aria-label="shared-film-panel"]')).toBeNull();
    expect(container.querySelector('a[href="/project/project-1/assets"]')).not.toBeNull();
    expect(navigation.push).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => /script-judge|storyboard-film|storyboard-grid/.test(url))).toBe(false);
  });

  it("hides the model-tier replication entry while keeping reference analysis", async () => {
    await mount(createElement(ClonePage));
    await act(async () => button("creationTypeSalesLabel").click());
    const fileInput = container.querySelector('input[accept^="video/mp4"]') as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { configurable: true, value: [new File(["reference"], "ref.mp4", { type: "video/mp4" })] });
    await act(async () => fileInput.dispatchEvent(new Event("change", { bubbles: true })));
    await act(async () => button("analyze").click());
    expect(container.textContent).not.toContain("modelTierTitle");
    expect(container.textContent).not.toContain("modelTierBtn");
    expect(container.textContent).toContain("realStructureTitle");
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/replicate/analyze")).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/ai/models")).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/ai/video")).toBe(false);
  });

  it("requires an explicit repair provider choice when the default is Kling", async () => {
    const props = { projectId: "project-1", assetId: "asset-1", reviewId: "review-1", currentModel: atlasModel, defaultVideoModel: atlasModel, models: [atlas], providers: { "atlas-cloud": { enabled: true, apiKey: "test" } }, anchors: [], onComplete: vi.fn() };
    await mount(createElement(VideoRepairPanel, props));
    expect((container.querySelector("select") as HTMLSelectElement).value).toContain(atlasModel);
    await mount(createElement(VideoRepairPanel, { ...props, defaultVideoModel: cliModel }));
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(button("repairCreatePreview").disabled).toBe(true);
    expect(container.textContent).toContain("Kling CLI 首版暂不支持视频修复");
    await act(async () => { select.value = `atlas-cloud::${atlasModel}`; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(button("repairCreatePreview").disabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("script regeneration progress", () => {
  beforeEach(() => {
    useSettingsStore.setState({ llm: { provider: "fixture", baseUrl: "https://example.test", apiKey: "fixture-key", model: "fixture-model" } });
  });

  it.each(["simple", "pro"] as const)("keeps the %s regenerate button busy through generation and script refresh", async (uiMode) => {
    useSettingsStore.setState({ uiMode });
    const normalFetch = fetchMock.getMockImplementation()!;
    let finishGeneration!: (response: Response) => void;
    let finishRefresh!: (response: Response) => void;
    let generated = false;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/generation-runs") return new Promise<Response>((resolve) => { finishGeneration = resolve; });
      if (url.endsWith("/scripts") && generated) return new Promise<Response>((resolve) => { finishRefresh = resolve; });
      return normalFetch(url, init);
    });
    await mount(createElement(ScriptPage));
    await act(async () => button("regenerate").click());
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/generation-runs")).toBe(false);
    const confirm = button("regenConfirmOk");
    await act(async () => { confirm.click(); confirm.click(); });
    const busy = button("regenerating");
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.querySelector(".animate-spin")).not.toBeNull();
    await act(async () => busy.click());
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/generation-runs")).toHaveLength(1);

    await act(async () => { generated = true; finishGeneration(Response.json({ success: true })); });
    expect(button("regenerating")).toBe(busy);
    expect(busy.disabled).toBe(true);
    await act(async () => finishRefresh(Response.json([{ id: "script-new", title: "Regenerated result", styleType: "scene", totalDuration: 5, selected: true, shots: [{ shotId: 1, type: "demo", duration: 5, description: "Updated product", voiceover: "Updated details", visualSource: "ai_generate", transition: "direct_concat" }] }])));
    expect(button("regenerate").disabled).toBe(false);
    expect(button("regenerate").getAttribute("aria-busy")).toBe("false");
    expect(container.textContent).toContain("Regenerated result");
    expect(container.textContent).not.toContain("regenerating");
  });

  it.each(["simple", "pro"] as const)("restores the %s regenerate button and shows the error after a failed request", async (uiMode) => {
    useSettingsStore.setState({ uiMode });
    const normalFetch = fetchMock.getMockImplementation()!;
    let finishGeneration!: (response: Response) => void;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === "/api/generation-runs"
      ? new Promise<Response>((resolve) => { finishGeneration = resolve; })
      : normalFetch(url, init));
    await mount(createElement(ScriptPage));
    await act(async () => button("regenerate").click());
    await act(async () => button("regenConfirmOk").click());
    expect(button("regenerating").disabled).toBe(true);
    await act(async () => finishGeneration(Response.json({ error: "fixture generation failed" }, { status: 500 })));
    expect(button("regenerate").disabled).toBe(false);
    expect(button("regenerate").getAttribute("aria-busy")).toBe("false");
    expect(container.textContent).toContain("fixture generation failed");
    expect(container.textContent).toContain("Test");
    expect(container.textContent).not.toContain("regenerating");
  });

  it("keeps the current editor and restores the button when the regenerated scripts cannot be refreshed", async () => {
    useSettingsStore.setState({ uiMode: "pro" });
    const normalFetch = fetchMock.getMockImplementation()!;
    let generated = false;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/generation-runs") { generated = true; return Promise.resolve(Response.json({ success: true })); }
      if (url.endsWith("/scripts") && generated) return Promise.resolve(Response.json({}, { status: 503 }));
      return normalFetch(url, init);
    });
    await mount(createElement(ScriptPage));
    await act(async () => button("regenerate").click());
    await act(async () => button("regenConfirmOk").click());
    expect(button("regenerate").disabled).toBe(false);
    expect(container.textContent).toContain("errorReloadScripts");
    expect(container.textContent).toContain("Test");
    expect(container.textContent).not.toContain("emptyTitle");
  });
});
