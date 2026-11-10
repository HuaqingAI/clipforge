import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HTH_BASE_URL, HTH_DEFAULT_MODEL } from "@/lib/hth-config";
import { useSettingsStore } from "@/lib/stores/settings-store";

const initial = useSettingsStore.getInitialState();
const storageKey = "daihuo-jianshou-settings";
const klingModel = JSON.stringify(["kling-cli", "image_to_video", "kling-v3"]);

beforeEach(() => {
  useSettingsStore.setState(initial, true);
  useSettingsStore.persist.clearStorage();
});

afterEach(() => {
  useSettingsStore.setState(initial, true);
  useSettingsStore.persist.clearStorage();
});

async function hydrate(state: Record<string, unknown>, version?: number) {
  localStorage.setItem(storageKey, JSON.stringify({ version, state }));
  await useSettingsStore.persist.rehydrate();
  return useSettingsStore.getState();
}

describe("HTH settings defaults and migration", () => {
  it("starts with one shared HTH gateway and text/vision model, without requiring a preset click", () => {
    expect(initial.providers.openai).toEqual({ enabled: false, apiKey: "", baseUrl: HTH_BASE_URL });
    expect(initial.llm).toEqual({ provider: "HTH", baseUrl: HTH_BASE_URL, apiKey: "", model: HTH_DEFAULT_MODEL, visionModel: HTH_DEFAULT_MODEL });
    expect(initial.spendCapUsd).toBe(0);
    expect(initial.defaultVideoModel).toBe("");
  });

  it("upgrades exact old OpenAI defaults, preserving keys and the chosen Kling model", async () => {
    const state = await hydrate({
      providers: { openai: { enabled: true, apiKey: "image-secret", baseUrl: "https://api.openai.com/v1/" } },
      llm: { provider: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "script-secret", model: "gpt-5.4", visionModel: "gpt-5.4" },
      spendCapUsd: 5, defaultVideoModel: klingModel,
    }, 8);
    expect(state.providers.openai).toEqual({ enabled: true, apiKey: "image-secret", baseUrl: HTH_BASE_URL });
    expect(state.llm).toEqual({ provider: "HTH", baseUrl: HTH_BASE_URL, apiKey: "script-secret", model: HTH_DEFAULT_MODEL, visionModel: HTH_DEFAULT_MODEL });
    expect(state.spendCapUsd).toBe(0);
    expect(state.defaultVideoModel).toBe(klingModel);
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({ version: 9, state: { spendCapUsd: 0, defaultVideoModel: klingModel } });
  });

  it("preserves custom gateways, models, credentials and a custom spending ceiling", async () => {
    const providers = { openai: { enabled: true, apiKey: "image-secret", baseUrl: "https://custom.example/v1/" } };
    const llm = { provider: "Private gateway", baseUrl: "https://custom.example/chat/v1", apiKey: "script-secret", model: "gpt-5.4", visionModel: "vision-custom" };
    const state = await hydrate({ providers, llm, spendCapUsd: 2.5 }, 8);
    expect(state.providers.openai).toEqual(providers.openai);
    expect(state.llm).toEqual(llm);
    expect(state.spendCapUsd).toBe(2.5);
  });

  it("preserves a custom model when upgrading the old default gateway", async () => {
    const state = await hydrate({ llm: { provider: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "key", model: "my-script-model", visionModel: "my-vision-model" } }, 8);
    expect(state.llm).toEqual({ provider: "HTH", baseUrl: HTH_BASE_URL, apiKey: "key", model: "my-script-model", visionModel: "my-vision-model" });
  });

  it("does not inject HTH vision defaults into another script provider", async () => {
    const llm = { provider: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKey: "key", model: "deepseek-v4-flash" };
    expect((await hydrate({ llm }, 8)).llm).toEqual(llm);
  });

  it.each([8, 9, undefined])("fills blank HTH values at stored version %s and retains existing keys", async (version) => {
    const state = await hydrate({
      providers: { openai: { enabled: true, apiKey: "image-secret", baseUrl: " " } },
      llm: { provider: "", baseUrl: " ", apiKey: "script-secret", model: " ", visionModel: "" },
    }, version);
    expect(state.providers.openai).toEqual({ enabled: true, apiKey: "image-secret", baseUrl: HTH_BASE_URL });
    expect(state.llm).toEqual({ provider: "HTH", baseUrl: HTH_BASE_URL, apiKey: "script-secret", model: HTH_DEFAULT_MODEL, visionModel: HTH_DEFAULT_MODEL });
  });

  it("does not replace a deliberate version-9 official endpoint, model or spending ceiling", async () => {
    const llm = { provider: "Official account", baseUrl: "https://api.openai.com/v1", apiKey: "key", model: "gpt-5.4", visionModel: "vision-custom" };
    const state = await hydrate({ llm, providers: { openai: { enabled: true, apiKey: "key", baseUrl: llm.baseUrl } }, spendCapUsd: 5 }, 9);
    expect(state.llm).toEqual(llm);
    expect(state.providers.openai.baseUrl).toBe(llm.baseUrl);
    expect(state.spendCapUsd).toBe(5);
  });

  it.each([8, 9, undefined])("disables retired platforms without destroying stored credentials at version %s", async (version) => {
    const legacy = { enabled: true, apiKey: "saved-key", baseUrl: "https://saved.example/v1" };
    const state = await hydrate({ providers: {
      volcengine: legacy, alibaba: legacy, siliconflow: legacy,
      "atlas-cloud": legacy, "fal-ai": legacy, replicate: legacy,
    } }, version);
    for (const name of ["volcengine", "alibaba", "siliconflow"]) {
      expect(state.providers[name]).toEqual({ ...legacy, enabled: false });
      state.setProvider(name, legacy);
      expect(useSettingsStore.getState().providers[name]).toEqual({ ...legacy, enabled: false });
    }
    for (const name of ["atlas-cloud", "fal-ai", "replicate"]) expect(state.providers[name]).toEqual(legacy);
    expect(state.providers.openai.baseUrl).toBe(HTH_BASE_URL);
  });

  it.each(["doubao-seedance-2.0", "sora-2", "kling-v3", '["kling-cli","film","model"]'])
    ("clears the unsupported default %s without choosing a paid replacement", async (defaultVideoModel) => {
      expect((await hydrate({ defaultVideoModel })).defaultVideoModel).toBe("");
    });

  it("retains explicit text-to-video and image-to-video CLI selection keys", async () => {
    for (const tool of ["text_to_video", "image_to_video"]) {
      const defaultVideoModel = JSON.stringify(["kling-cli", tool, "user-selected-model"]);
      expect((await hydrate({ defaultVideoModel })).defaultVideoModel).toBe(defaultVideoModel);
    }
  });
});
