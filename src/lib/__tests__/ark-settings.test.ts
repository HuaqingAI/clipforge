import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPage from "@/app/settings/page";
import { ARK_AGENT_PLAN_BASE_URL, ARK_STANDARD_BASE_URL, isArkAgentPlanBase } from "@/lib/ark-config";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { useModelCatalog } from "@/lib/hooks/use-model-catalog";

const catalogState = vi.hoisted(() => ({ loading: false, extraModels: [] as Array<{ id: string; name: string; provider: string; mediaType: "video"; modes: string[]; extra?: Record<string, unknown> }> }));
vi.mock("@/components/generation-settings", () => ({ GenerationSettings: () => null }));
vi.mock("@/components/presenter-manager", () => ({ PresenterManager: () => null }));
vi.mock("@/lib/hooks/use-model-catalog", () => ({
  useModelCatalog: vi.fn((providers: Array<{ name: string; baseUrl?: string }>) => {
    const ark = providers.find((provider) => provider.name === "volcengine");
    const ids = !ark ? [] : isArkAgentPlanBase(ark.baseUrl)
      ? ["doubao-seedance-2.5", "doubao-seedance-2.0", "doubao-seedance-2.0-fast", "doubao-seedance-2.0-mini"]
      : ["doubao-seedance-1-0-pro-250528"];
    return {
      loading: catalogState.loading,
      models: [...ids.map((id) => ({ id, name: id, provider: "volcengine", mediaType: "video", modes: ["text-to-video"] })), ...catalogState.extraModels],
      statuses: ark && !catalogState.loading ? [{ provider: "volcengine", mediaType: "video", status: "ready" }] : [],
      pending: [], retry: vi.fn(),
    };
  }),
}));

let root: Root;
let container: HTMLDivElement;
const fetchMock = vi.fn();
const initialSettings = useSettingsStore.getInitialState();

async function mount() {
  await act(async () => root.render(createElement(SettingsPage)));
}

async function chooseMode(label: string) {
  await act(async () => (container.querySelector("#ark-api-mode") as HTMLButtonElement).click());
  const option = Array.from(document.querySelectorAll('[role="option"]')).find((element) => element.textContent === label);
  expect(option).toBeTruthy();
  await act(async () => (option as HTMLElement).focus());
  await act(async () => (option as HTMLElement).click());
}

function arkCard() {
  return container.querySelector("#ark-api-mode")!.closest('[data-slot="card"]')!;
}

async function testConnection() {
  const button = Array.from(arkCard().querySelectorAll("button")).find((element) => element.textContent === "Test connection")!;
  await act(async () => button.click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({ status: "ok", message: "Tested standard endpoint" })));
  catalogState.loading = false;
  catalogState.extraModels = [];
  useSettingsStore.setState({
    ...initialSettings,
    locale: "en",
    providers: { volcengine: { enabled: true, apiKey: "test-subscription-key", baseUrl: ARK_STANDARD_BASE_URL } },
    defaultVideoModel: "doubao-seedance-1-0-pro-250528",
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
  vi.unstubAllGlobals();
});

describe("Ark access mode settings", () => {
  it("hides the Atlas Cloud, fal.ai, and Replicate setup cards", async () => {
    await mount();
    const headings = [...container.querySelectorAll("h3")].map((heading) => heading.textContent?.trim());
    expect(headings).not.toContain("Atlas Cloud");
    expect(headings).not.toContain("fal.ai");
    expect(headings).not.toContain("Replicate");
    expect(headings).toContain("OpenAI");
    expect(headings.indexOf("OpenAI")).toBeLessThan(headings.indexOf("Volcengine"));
  });

  it("switches endpoint, refreshes video models and clears previous connection results while keeping the key and enabled state", async () => {
    await mount();
    await testConnection();
    expect(arkCard().textContent).toContain("Tested standard endpoint");
    await chooseMode("AgentPlan subscription");
    expect(useSettingsStore.getState().providers.volcengine).toEqual({
      enabled: true, apiKey: "test-subscription-key", baseUrl: ARK_AGENT_PLAN_BASE_URL,
    });
    expect(arkCard().textContent).not.toContain("Tested standard endpoint");
    expect(arkCard().textContent).toContain("subscription API key");
    expect(arkCard().textContent).toContain("doubao-seedance-2.0-mini");
    expect(useSettingsStore.getState().defaultVideoModel).toBe("doubao-seedance-1-0-pro-250528");
    expect(useModelCatalog).toHaveBeenLastCalledWith([{ name: "volcengine", apiKey: "test-subscription-key", baseUrl: ARK_AGENT_PLAN_BASE_URL }]);

    await chooseMode("Standard API (pay as you go)");
    expect(useSettingsStore.getState().providers.volcengine.baseUrl).toBe(ARK_STANDARD_BASE_URL);
    expect(useSettingsStore.getState().defaultVideoModel).toBe("doubao-seedance-1-0-pro-250528");
  });

  it("recognizes a manually entered AgentPlan proxy URL and preserves an available default model", async () => {
    await mount();
    const input = arkCard().querySelector('details input') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "https://ark-proxy.example/api/plan/v3/");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector("#ark-api-mode")!.textContent).toContain("AgentPlan subscription");
    expect(useSettingsStore.getState().providers.volcengine.baseUrl).toBe("https://ark-proxy.example/api/plan/v3/");
    await act(async () => useSettingsStore.getState().setDefaultVideoModel("doubao-seedance-2.0-fast"));
    await chooseMode("AgentPlan subscription");
    expect(useSettingsStore.getState().defaultVideoModel).toBe("doubao-seedance-2.0-fast");
  });

  it("ignores connection replies from the previous mode and does not enable a disabled provider", async () => {
    useSettingsStore.setState({ providers: { volcengine: { enabled: false, apiKey: "test-subscription-key" } } });
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await mount();
    await testConnection();
    await chooseMode("AgentPlan subscription");
    await act(async () => finish(new Response(JSON.stringify({ status: "ok", message: "Stale connection result" }))));
    expect(arkCard().textContent).not.toContain("Stale connection result");
    expect(useSettingsStore.getState().providers.volcengine.enabled).toBe(false);
  });

  it("preserves a configured non-Ark default when its provider's catalog is temporarily unavailable", async () => {
    useSettingsStore.setState({
      providers: {
        ...useSettingsStore.getState().providers,
        "fal-ai": { enabled: true, apiKey: "test-fal-key" },
      },
      defaultVideoModel: "fal-ai/kling-video/v3/pro/text-to-video",
      defaultImageModel: "fal-ai/flux-pro",
    });
    await mount();
    await chooseMode("AgentPlan subscription");
    expect(useSettingsStore.getState().defaultVideoModel).toBe("fal-ai/kling-video/v3/pro/text-to-video");
    expect(useSettingsStore.getState().defaultImageModel).toBe("fal-ai/flux-pro");
  });

  it("requires an explicit video model choice when none is configured", async () => {
    useSettingsStore.setState({ defaultVideoModel: "" });
    window.history.replaceState(null, "", "/settings?tab=video");
    await mount();
    expect(container.textContent).toContain("Animate, regenerate and full-film orchestration all use this model");
    expect(useSettingsStore.getState().defaultVideoModel).toBe("");
  });

  it("shows an unavailable saved model without replacing it after a catalog change", async () => {
    useSettingsStore.setState({ defaultVideoModel: "missing-video-model" });
    window.history.replaceState(null, "", "/settings?tab=video");
    await mount();
    expect(container.textContent).toContain("missing-video-model (unavailable)");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("will not automatically switch models");
    expect(useSettingsStore.getState().defaultVideoModel).toBe("missing-video-model");
  });

  it("switches between Ark and Kling only through the shared default video model control", async () => {
    const key = JSON.stringify(["kling-cli", "image_to_video", "kling-video-v4_0"]);
    catalogState.extraModels = [{ id: key, name: "Kling 4.0 · Image to video", provider: "kling-cli", mediaType: "video", modes: ["image-to-video"], extra: { available: true } }];
    window.history.replaceState(null, "", "/settings?tab=video");
    await mount();
    async function choose(label: string) {
      await act(async () => (container.querySelector('[role="combobox"]') as HTMLButtonElement).click());
      const option = [...document.querySelectorAll('[role="option"]')].find((item) => item.textContent === label) as HTMLElement;
      expect(option).toBeTruthy();
      await act(async () => option.focus());
      await act(async () => option.click());
    }
    await choose("Kling 4.0 · Image to video");
    expect(useSettingsStore.getState().defaultVideoModel).toBe(key);
    await choose("doubao-seedance-1-0-pro-250528");
    expect(useSettingsStore.getState().defaultVideoModel).toBe("doubao-seedance-1-0-pro-250528");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/video"))).toBe(false);
  });
});
