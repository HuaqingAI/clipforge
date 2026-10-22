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
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", fetchMock);
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
  it.each([cliModel, atlasModel])("opens the shared film panel in place with default %s before any paid request", async (selectedModel) => {
    useSettingsStore.getState().setDefaultVideoModel(selectedModel);
    await mount(createElement(ScriptPage));
    expect(button("整片自动编排").disabled).toBe(false);
    expect(container.querySelector('[aria-label="shared-film-panel"]')).toBeNull();
    await act(async () => button("整片自动编排").click());
    expect(container.querySelector('[aria-label="shared-film-panel"]')).toBeTruthy();
    expect(navigation.push).not.toHaveBeenCalled();
    const saved = fetchMock.mock.calls.find(([url, init]) => url.endsWith("/scripts") && init?.method === "PATCH");
    expect(JSON.parse(saved![1].body)).toEqual({ selectedScriptId: "script-1" });
    expect(fetchMock.mock.calls.some(([url]) => /script-judge|storyboard-film|storyboard-grid/.test(url))).toBe(false);
  });

  it("does not open a film plan when the current script could not be saved", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => url.endsWith("/scripts") && init?.method === "PATCH" ? Response.json({ error: "Save failed" }, { status: 500 }) : normalFetch(url, init));
    await mount(createElement(ScriptPage));
    await act(async () => button("整片自动编排").click());
    expect(container.querySelector('[aria-label="shared-film-panel"]')).toBeNull();
    expect(navigation.push).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => /characters\/sheet|storyboard-grid|\/ai\/video/.test(url))).toBe(false);
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
