import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore, type TTSSetting } from "@/lib/stores/settings-store";
import {
  DEFAULT_TTS_PROVIDER,
  getTTSProviderMeta,
  isPaidTTSReady,
  normalizeTTSSettings,
  resolveTTSConfig,
  TTS_PROVIDERS,
} from "@/lib/tts-presets";
import { DEFAULT_FREE_VOICE } from "@/lib/tts-voices";

const initial = useSettingsStore.getInitialState();
const storageKey = "daihuo-jianshou-settings";
const freeDefaults = {
  enabled: true, provider: "microsoft", baseUrl: "", apiKey: "",
  model: "", voice: DEFAULT_FREE_VOICE, speed: 1,
};
const cliSettings: TTSSetting = {
  enabled: true, provider: "elevenlabs-cli", baseUrl: "", apiKey: "",
  model: "eleven_multilingual_v2", voice: "saved-clone-123", speed: 1.1,
};

beforeEach(() => {
  useSettingsStore.setState(initial, true);
  useSettingsStore.persist.clearStorage();
});

afterEach(() => {
  useSettingsStore.setState(initial, true);
  useSettingsStore.persist.clearStorage();
});

describe("voiceover provider settings", () => {
  it("offers only Microsoft and ElevenLabs and starts with usable free narration", () => {
    expect(TTS_PROVIDERS.map(({ value, label }) => ({ value, label }))).toEqual([
      { value: "microsoft", label: "微软 TTS · 免费" },
      { value: "elevenlabs-cli", label: "ElevenLabs · 克隆声音 / 官方 CLI" },
    ]);
    expect(DEFAULT_TTS_PROVIDER).toBe("microsoft");
    expect(initial.tts).toEqual(freeDefaults);
    expect(getTTSProviderMeta("atlas").value).toBe("microsoft");
  });

  it.each(["openai", "atlas", "minimax", "falai", "unknown", undefined])("retires %s without retaining paid endpoints or credentials", (provider) => {
    const legacy = { enabled: false, provider, baseUrl: "https://paid.example", apiKey: "old-secret", model: "paid-model", voice: "paid-voice", speed: 0.8, groupId: "old-group" };
    expect(normalizeTTSSettings(legacy)).toEqual(freeDefaults);
    expect(resolveTTSConfig(legacy, { "atlas-cloud": { apiKey: "platform-key" } })).toEqual({
      provider: "microsoft", baseUrl: "", apiKey: "", model: "", voice: DEFAULT_FREE_VOICE, speed: 1,
    });
    expect(isPaidTTSReady(legacy)).toBe(false);
  });

  it("preserves selected CLI IDs, enabled state and speed while stripping legacy API settings", () => {
    const dirty = { ...cliSettings, enabled: false, voice: " saved-clone-123 ", model: " eleven_multilingual_v2 ", baseUrl: "https://old.example", apiKey: "old-key", groupId: "old-group" };
    expect(normalizeTTSSettings(dirty)).toEqual({ ...cliSettings, enabled: false });
    useSettingsStore.getState().setTTS(dirty);
    expect(useSettingsStore.getState().tts).toEqual({ ...cliSettings, enabled: false });
    expect(localStorage.getItem(storageKey)).not.toMatch(/old-key|old-group|old\.example/);
  });

  it("preserves Microsoft voice and disabled state but removes incompatible model and credentials", () => {
    expect(normalizeTTSSettings({ enabled: false, provider: "microsoft", voice: "en-US-GuyNeural", model: "old-model", speed: 1.2, apiKey: "old-key" })).toEqual({
      ...freeDefaults, enabled: false, voice: "en-US-GuyNeural", speed: 1.2,
    });
  });

  it("requires deliberate valid CLI voice and model choices before declaring config ready", () => {
    expect(isPaidTTSReady(cliSettings)).toBe(true);
    expect(isPaidTTSReady({ ...cliSettings, enabled: false })).toBe(false);
    expect(isPaidTTSReady({ ...cliSettings, voice: "" })).toBe(false);
    expect(isPaidTTSReady({ ...cliSettings, model: "not a model" })).toBe(false);
    expect(isPaidTTSReady(freeDefaults)).toBe(false);
    expect(resolveTTSConfig(cliSettings, { "atlas-cloud": { apiKey: "unrelated-key" } })).toEqual({
      provider: "elevenlabs-cli", baseUrl: "", apiKey: "", model: cliSettings.model, voice: cliSettings.voice, speed: 1.1,
    });
  });

  it("does not enable a new incomplete ElevenLabs selection and repairs invalid values", () => {
    expect(normalizeTTSSettings({ provider: "elevenlabs-cli", voice: "https://invalid.example", model: "invalid model", speed: NaN })).toEqual({
      enabled: false, provider: "elevenlabs-cli", baseUrl: "", apiKey: "", model: "", voice: "", speed: 1,
    });
    expect(normalizeTTSSettings({ ...cliSettings, speed: 2 }).speed).toBe(1);
    expect(normalizeTTSSettings({ ...freeDefaults, voice: "unknown", speed: -1 })).toEqual(freeDefaults);
  });

  it.each([7, 8, undefined])("normalizes retired TTS during hydration at version %s and preserves unrelated settings", async (version) => {
    localStorage.setItem(storageKey, JSON.stringify({ version, state: {
      tts: { provider: "atlas", enabled: true, apiKey: "old-key", baseUrl: "https://paid.example", voice: "eve", model: "xai/tts-v1" },
      defaultVideoModel: "saved-model", locale: "en",
    } }));
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState()).toMatchObject({ tts: freeDefaults, defaultVideoModel: "saved-model", locale: "en" });
    expect(isPaidTTSReady(useSettingsStore.getState().tts)).toBe(false);
    if (version === 7) expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({ version: 8, state: { tts: freeDefaults } });
  });

  it.each([7, 8, undefined])("preserves OAuth CLI preferences during hydration at version %s", async (version) => {
    localStorage.setItem(storageKey, JSON.stringify({ version, state: { tts: cliSettings } }));
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().tts).toEqual(cliSettings);
  });

  it.each([true, false])("Atlas onboarding preserves the selected CLI configuration and enabled=%s", (enabled) => {
    const tts = { ...cliSettings, enabled };
    useSettingsStore.getState().setTTS(tts);
    useSettingsStore.getState().applyAtlasOneKey("test-atlas-key");
    expect(useSettingsStore.getState().tts).toEqual(tts);
    expect(useSettingsStore.getState().providers["atlas-cloud"]).toMatchObject({ enabled: true, apiKey: "test-atlas-key" });
  });

  it("Atlas onboarding also preserves disabled free narration", () => {
    useSettingsStore.getState().setTTS({ ...initial.tts, enabled: false });
    useSettingsStore.getState().applyAtlasOneKey("test-atlas-key");
    expect(useSettingsStore.getState().tts).toEqual({ ...freeDefaults, enabled: false });
  });
});
