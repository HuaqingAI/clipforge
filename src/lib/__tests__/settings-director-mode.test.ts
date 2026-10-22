import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "@/lib/stores/settings-store";

const initial = useSettingsStore.getInitialState();
const storageKey = "daihuo-jianshou-settings";

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
    useSettingsStore.getState().setUiMode("simple");
    expect(useSettingsStore.getState().uiMode).toBe("pro");
  });

  it("migrates saved beginner mode and retains unrelated user settings", async () => {
    localStorage.setItem(storageKey, JSON.stringify({ version: 6, state: {
      uiMode: "simple", locale: "en", defaultVideoModel: "saved-video-model",
      visualLook: "phone_raw", motionIntensity: "strong", spendCapUsd: 2,
    } }));

    await useSettingsStore.persist.rehydrate();

    const expected = {
      uiMode: "pro", locale: "en", defaultVideoModel: "saved-video-model",
      visualLook: "phone_raw", motionIntensity: "strong", spendCapUsd: 2,
    };
    expect(useSettingsStore.getState()).toMatchObject(expected);
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({ version: 7, state: expected });
  });

  it.each([7, undefined])("normalizes legacy mode during hydration even with version %s", async (version) => {
    localStorage.setItem(storageKey, JSON.stringify({ version, state: { uiMode: "simple", locale: "en" } }));

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState()).toMatchObject({ uiMode: "pro", locale: "en" });
  });
});
