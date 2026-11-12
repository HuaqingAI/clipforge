import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { exportConfiguration, importConfiguration } from "@/lib/browser-storage";

const initial = useSettingsStore.getInitialState();
const storageKey = "daihuo-jianshou-settings";
const savedKlingModel = JSON.stringify(["kling-cli", "image_to_video", "saved-video-model"]);
const retiredMotionSettings = ["motionIntensity", "motionRealism", "autoMotion", "setMotionIntensity", "setMotionRealism", "setAutoMotion"];
const legacyMotionSettings = { motionIntensity: "strong", motionRealism: "off", autoMotion: true };

beforeEach(() => {
  useSettingsStore.setState(initial, true);
  useSettingsStore.persist.clearStorage();
});

afterEach(() => {
  useSettingsStore.setState(initial, true);
  useSettingsStore.persist.clearStorage();
});

describe("director-only workspace", () => {
  it("starts in director mode and ignores legacy attempts to enter beginner mode", () => {
    expect(initial.uiMode).toBe("pro");
    for (const key of retiredMotionSettings) expect(initial).not.toHaveProperty(key);
    useSettingsStore.getState().setUiMode("simple");
    expect(useSettingsStore.getState().uiMode).toBe("pro");
  });

  it("migrates saved beginner mode and retains unrelated user settings", async () => {
    localStorage.setItem(storageKey, JSON.stringify({ version: 6, state: {
      uiMode: "simple", locale: "en", defaultVideoModel: savedKlingModel,
      visualLook: "phone_raw", ...legacyMotionSettings, spendCapUsd: 2,
    } }));

    await useSettingsStore.persist.rehydrate();

    const expected = {
      uiMode: "pro", locale: "en", defaultVideoModel: savedKlingModel,
      visualLook: "phone_raw", spendCapUsd: 2,
    };
    expect(useSettingsStore.getState()).toMatchObject(expected);
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({ version: 10, state: expected });
  });

  it.each([8, undefined])("normalizes legacy mode during hydration even with version %s", async (version) => {
    localStorage.setItem(storageKey, JSON.stringify({ version, state: { uiMode: "simple", locale: "en" } }));

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState()).toMatchObject({ uiMode: "pro", locale: "en" });
  });

  it.each([8, 9, 10, undefined])("discards retired motion controls during version %s hydration and subsequent persistence", async (version) => {
    const retained = { defaultVideoModel: savedKlingModel, chainMode: "tail", visualLook: "phone_raw", spendCapUsd: 2 };
    localStorage.setItem(storageKey, JSON.stringify({ version, state: { ...retained, ...legacyMotionSettings,
      setMotionIntensity: "legacy action", setMotionRealism: "legacy action", setAutoMotion: "legacy action",
    } }));

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState()).toMatchObject(retained);
    for (const key of retiredMotionSettings) expect(useSettingsStore.getState()).not.toHaveProperty(key);
    if (version === 8 || version === 9) {
      const migrated = JSON.parse(localStorage.getItem(storageKey)!);
      expect(migrated.version).toBe(10);
      for (const key of retiredMotionSettings) expect(migrated.state).not.toHaveProperty(key);
    }
    useSettingsStore.getState().setVisualLook("daylight_clean");
    const persisted = JSON.parse(localStorage.getItem(storageKey)!);
    expect(persisted).toMatchObject({ version: 10, state: { ...retained, visualLook: "daylight_clean" } });
    for (const key of retiredMotionSettings) expect(persisted.state).not.toHaveProperty(key);
    await useSettingsStore.persist.rehydrate();
    for (const key of retiredMotionSettings) expect(useSettingsStore.getState()).not.toHaveProperty(key);
  });

  it("does not re-export retired controls after importing a legacy configuration", async () => {
    importConfiguration({ format: "clipforge-settings", schemaVersion: 1, entries: {
      [storageKey]: JSON.stringify({ version: 9, state: { ...legacyMotionSettings, chainMode: "off", visualLook: "phone_raw" } }),
    } });

    await useSettingsStore.persist.rehydrate();

    const exported = JSON.parse(exportConfiguration().entries[storageKey]);
    expect(exported).toMatchObject({ version: 10, state: { chainMode: "off", visualLook: "phone_raw" } });
    for (const key of retiredMotionSettings) {
      expect(useSettingsStore.getState()).not.toHaveProperty(key);
      expect(exported.state).not.toHaveProperty(key);
    }
  });
});
