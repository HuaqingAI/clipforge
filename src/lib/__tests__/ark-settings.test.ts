import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPage from "@/app/settings/page";
import { HTH_BASE_URL, HTH_DEFAULT_MODEL } from "@/lib/hth-config";
import { HTH_VIDEO_MODEL } from "@/lib/hth-video-config";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { useBrandStore } from "@/lib/stores/brand-store";
import { useModelCatalog } from "@/lib/hooks/use-model-catalog";
import type { Model } from "@/lib/providers/types";

const catalogState = vi.hoisted(() => ({ loading: false, models: [] as Model[] }));
vi.mock("@/components/presenter-manager", () => ({ PresenterManager: () => null }));
vi.mock("@/components/settings/kling-cli-settings", () => ({ KlingCliSettings: () => null }));
vi.mock("@/lib/hooks/use-model-catalog", () => ({
  useModelCatalog: vi.fn((providers: Array<{ name: string }>, mediaType?: "image" | "video") => ({
    loading: catalogState.loading,
    models: catalogState.models.filter((model) => model.mediaType === mediaType && providers.some((provider) => provider.name === model.provider)),
    statuses: catalogState.loading ? [] : providers.map((provider) => ({ provider: provider.name, mediaType, status: "ready", checkedAt: "2026-11-10T00:00:00Z", durationMs: 1, count: 1 })),
    pending: [], retry: vi.fn(),
  })),
}));

let root: Root;
let container: HTMLDivElement;
const fetchMock = vi.fn();
const initialSettings = useSettingsStore.getInitialState();
const initialBrand = useBrandStore.getInitialState();
const klingKey = JSON.stringify(["kling-cli", "image_to_video", "kling-video-v4_0"]);

async function mount() { await act(async () => root.render(createElement(SettingsPage))); }
async function enter(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function hthCard() {
  const heading = [...container.querySelectorAll("h3")].find((item) => item.textContent === "HTH");
  expect(heading).toBeTruthy();
  return heading!.closest('[data-slot="card"]')!;
}
async function choose(trigger: HTMLButtonElement, label: string) {
  await act(async () => trigger.click());
  const option = [...document.querySelectorAll('[role="option"]')].find((item) => item.textContent === label) as HTMLElement;
  expect(option).toBeTruthy();
  await act(async () => option.focus());
  await act(async () => option.click());
}
function videoSelect() { return container.querySelector('section [role="combobox"]') as HTMLButtonElement; }

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockResolvedValue(Response.json({ status: "ok", message: "Gateway available" }));
  vi.mocked(useModelCatalog).mockClear();
  catalogState.loading = false;
  catalogState.models = [
    { id: "gpt-image-2", name: "HTH Image", provider: "openai", mediaType: "image", modes: ["text-to-image"] },
    { id: klingKey, name: "Kling 4.0 image to video", provider: "kling-cli", mediaType: "video", modes: ["image-to-video"] },
    { id: HTH_VIDEO_MODEL, name: "MiniMax-H3 · HTH", provider: "openai", mediaType: "video", modes: ["text-to-video", "image-to-video"], supportsAudio: true },
    { id: "sora-2", name: "Retired video option", provider: "openai", mediaType: "video", modes: ["text-to-video"] },
  ];
  useSettingsStore.setState({
    ...initialSettings,
    locale: "en", localeSource: "user",
    providers: {
      openai: { enabled: true, apiKey: "hth-key", baseUrl: HTH_BASE_URL },
      "kling-cli": { enabled: true, apiKey: "", profileId: "account-profile" },
      volcengine: { enabled: false, apiKey: "preserved-ark-key", baseUrl: "https://old.example/v3" },
      alibaba: { enabled: false, apiKey: "preserved-alibaba-key" },
      siliconflow: { enabled: false, apiKey: "preserved-siliconflow-key" },
    },
    defaultVideoModel: "", customModels: [],
  });
  window.history.replaceState(null, "", "/settings");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useSettingsStore.setState(initialSettings);
  useBrandStore.setState(initialBrand);
  vi.unstubAllGlobals();
});

describe("HTH and Kling settings UI", () => {
  it("shows HTH and keeps retired or previously hidden platform cards out of setup without changing stored credentials", async () => {
    const providers = useSettingsStore.getState().providers;
    await mount();
    const headings = [...container.querySelectorAll("h3")].map((heading) => heading.textContent?.trim());
    expect(headings).toContain("HTH");
    for (const name of ["OpenAI", "Atlas Cloud", "fal.ai", "Replicate", "Volcengine", "Alibaba Bailian", "SiliconFlow"]) expect(headings).not.toContain(name);
    expect(container.querySelector("#ark-api-mode")).toBeNull();
    expect(useSettingsStore.getState().providers).toEqual(providers);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the shared HTH endpoint fallback and saves a custom endpoint under the existing openai key", async () => {
    useSettingsStore.setState({ providers: { ...useSettingsStore.getState().providers, openai: { enabled: true, apiKey: "hth-key" } } });
    await mount();
    const input = hthCard().querySelector('details input') as HTMLInputElement;
    expect(input.value).toBe(HTH_BASE_URL);
    expect(input.placeholder).toBe(HTH_BASE_URL);
    await enter(input, "https://private.example/v1");
    expect(useSettingsStore.getState().providers.openai).toEqual({ enabled: true, apiKey: "hth-key", baseUrl: "https://private.example/v1" });
    expect(useSettingsStore.getState().providers.hth).toBeUndefined();
    await enter(input, "");
    expect(useSettingsStore.getState().providers.openai.baseUrl).toBe(HTH_BASE_URL);
  });

  it("ignores an outdated connection probe after changing the gateway", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await mount();
    const button = [...hthCard().querySelectorAll("button")].find((item) => item.textContent === "Test connection")!;
    await act(async () => button.click());
    await enter(hthCard().querySelector('details input') as HTMLInputElement, "https://new.example/v1");
    await act(async () => finish(Response.json({ status: "ok", message: "Outdated gateway response" })));
    expect(hthCard().textContent).not.toContain("Outdated gateway response");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ name: "openai", apiKey: "hth-key", baseUrl: HTH_BASE_URL });
  });

  it("uses shared HTH and gpt-6.1-sol placeholders for script and vision without automatic requests", async () => {
    window.history.replaceState(null, "", "/settings?tab=llm");
    await mount();
    expect(container.querySelector(`input[placeholder="${HTH_BASE_URL}"]`)).not.toBeNull();
    expect(container.querySelectorAll(`input[placeholder="${HTH_DEFAULT_MODEL}"]`)).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back from the retired branding tab and preserves saved brand data", async () => {
    useBrandStore.getState().updateBrand({ name: "Saved shop", primaryColor: "#123456", outroText: "Saved outro" });
    const brand = useBrandStore.getState().brand;
    window.history.replaceState(null, "", "/settings?tab=brand");
    await mount();
    expect([...container.querySelectorAll("nav button")].map((item) => item.textContent)).not.toContain("Branding");
    expect(container.textContent).not.toContain("Saved shop");
    expect(container.querySelector('input[type="color"]')).toBeNull();
    expect(useBrandStore.getState().brand).toEqual(brand);
    expect(hthCard()).toBeTruthy();
  });

  it("offers Kling and HTH MiniMax-H3 without reviving unsupported custom videos", async () => {
    useSettingsStore.setState({ customModels: [{ id: "old-custom", provider: "openai", modelId: "custom-video", name: "Legacy custom video", mediaType: "video" }] });
    window.history.replaceState(null, "", "/settings?tab=video");
    await mount();
    expect(useModelCatalog).toHaveBeenCalledWith([{ name: "openai", apiKey: "hth-key", baseUrl: HTH_BASE_URL }, { name: "kling-cli", profileId: "account-profile" }], "video");
    expect(useModelCatalog).toHaveBeenCalledWith([{ name: "openai", apiKey: "hth-key", baseUrl: HTH_BASE_URL }], "image");
    const section = container.querySelector("section")!;
    expect(section.textContent).toContain("kling-cli");
    expect(section.textContent).toContain("hth");
    await act(async () => videoSelect().click());
    const options = [...document.querySelectorAll('[role="option"]')].map((item) => item.textContent);
    expect(options).toEqual(["Kling 4.0 image to video", "MiniMax-H3 · HTH"]);
  });

  it("requires an explicit video model choice and never submits generation while selecting it", async () => {
    window.history.replaceState(null, "", "/settings?tab=video");
    await mount();
    expect(useSettingsStore.getState().defaultVideoModel).toBe("");
    expect(container.textContent).toContain("Single-shot generation, batch motion and regeneration use this default video model");
    await choose(videoSelect(), "Kling 4.0 image to video");
    expect(useSettingsStore.getState().defaultVideoModel).toBe(klingKey);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("selects HTH without Kling and keeps its generation resolution separate from composition", async () => {
    useSettingsStore.setState({
      providers: { openai: { enabled: true, apiKey: "hth-key", baseUrl: HTH_BASE_URL } },
      defaultResolution: "1080p", videoParams: { ...initialSettings.videoParams, resolution: "1080p" },
    });
    window.history.replaceState(null, "", "/settings?tab=video");
    await mount();
    expect(useSettingsStore.getState().defaultVideoModel).toBe("");
    await choose(videoSelect(), "MiniMax-H3 · HTH");
    expect(useSettingsStore.getState()).toMatchObject({ defaultVideoModel: HTH_VIDEO_MODEL, defaultResolution: "1080p", videoParams: { resolution: "768p" } });
    const resolution = container.querySelectorAll('section [role="combobox"]')[1] as HTMLButtonElement;
    expect(resolution.textContent).toContain("768P");
    await choose(resolution, "2K");
    expect(useSettingsStore.getState()).toMatchObject({ defaultResolution: "1080p", videoParams: { resolution: "2k" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([{ enabled: false, apiKey: "hth-key" }, { enabled: true, apiKey: "" }, { enabled: true, apiKey: "  " }])
    ("keeps an HTH default unavailable without silently choosing Kling when configuration is %o", async (openai) => {
      useSettingsStore.setState({ providers: { openai }, defaultVideoModel: HTH_VIDEO_MODEL });
      window.history.replaceState(null, "", "/settings?tab=video");
      await mount();
      expect(videoSelect().disabled).toBe(true);
      expect(container.querySelector('section [role="alert"]')).not.toBeNull();
      expect(useSettingsStore.getState().defaultVideoModel).toBe(HTH_VIDEO_MODEL);
      expect(fetchMock).not.toHaveBeenCalled();
    });

  it("restores the existing Kling output tier when switching back from HTH", async () => {
    useSettingsStore.setState({ defaultVideoModel: HTH_VIDEO_MODEL, defaultResolution: "1080p", videoParams: { ...initialSettings.videoParams, resolution: "2k" } });
    window.history.replaceState(null, "", "/settings?tab=video");
    await mount();
    await choose(videoSelect(), "Kling 4.0 image to video");
    expect(useSettingsStore.getState()).toMatchObject({ defaultVideoModel: klingKey, defaultResolution: "1080p", videoParams: { resolution: "1080p" } });
  });

  it("shows a missing saved Kling descriptor without selecting a different billed model", async () => {
    const missing = JSON.stringify(["kling-cli", "image_to_video", "missing-model"]);
    useSettingsStore.setState({ defaultVideoModel: missing });
    window.history.replaceState(null, "", "/settings?tab=video");
    await mount();
    expect(container.querySelector('section [role="alert"]')?.textContent).toContain("will not automatically switch models");
    expect(useSettingsStore.getState().defaultVideoModel).toBe(missing);
  });

  it("keeps live Kling future models selectable without a local capability veto", async () => {
    const key = JSON.stringify(["kling-cli", "text_to_video", "future-kling-model"]);
    catalogState.models = [{ id: key, name: "Future Kling model", provider: "kling-cli", mediaType: "video", modes: ["text-to-video"], extra: { available: false, disabledReason: "Capability not confirmed" } }];
    useSettingsStore.setState({ defaultVideoModel: key });
    window.history.replaceState(null, "", "/settings?tab=video");
    await mount();
    expect(container.querySelector('section [role="alert"]')).toBeNull();
    await choose(videoSelect(), "Future Kling model");
    expect(useSettingsStore.getState().defaultVideoModel).toBe(key);
  });

  it("only adds image models and removes retired providers from the advanced selector", async () => {
    await mount();
    const advanced = [...container.querySelectorAll("details")].find((item) => item.textContent?.includes("Custom image model endpoints"))!;
    const providerSelect = advanced.querySelector('[role="combobox"]') as HTMLButtonElement;
    expect(providerSelect.textContent).toContain("HTH");
    await act(async () => providerSelect.click());
    const options = [...document.querySelectorAll('[role="option"]')].map((item) => item.textContent);
    expect(options).toEqual(["Atlas Cloud", "fal.ai", "Replicate", "HTH"]);
    const hth = [...document.querySelectorAll('[role="option"]')].find((item) => item.textContent === "HTH") as HTMLElement;
    await act(async () => hth.focus());
    await act(async () => hth.click());
    await enter(advanced.querySelector('input[placeholder="e.g. gpt-image-2"]') as HTMLInputElement, "my-image-model");
    const add = [...advanced.querySelectorAll("button")].find((item) => item.textContent?.includes("Add model"))!;
    await act(async () => add.click());
    expect(useSettingsStore.getState().customModels).toEqual([expect.objectContaining({ provider: "openai", modelId: "my-image-model", mediaType: "image" })]);
    expect(advanced.textContent).not.toContain("This video model has native audio");
  });
});
