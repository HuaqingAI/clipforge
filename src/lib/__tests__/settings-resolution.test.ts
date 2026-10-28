import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VideoGenParams } from "@/lib/gen-params";
import { useSettingsStore } from "@/lib/stores/settings-store";

const initial = useSettingsStore.getInitialState();
const storageKey = "daihuo-jianshou-settings";
const videoParams: VideoGenParams = {
  aspectRatio: "16:9", resolution: "1080p", duration: 8, fps: 24,
  motionStrength: 0.65, seed: 101, negativePrompt: "blur",
};

beforeEach(() => {
  useSettingsStore.setState(initial, true);
  useSettingsStore.persist.clearStorage();
});

afterEach(() => {
  useSettingsStore.setState(initial, true);
  useSettingsStore.persist.clearStorage();
});

describe("video resolution settings", () => {
  it.each(["720p", "1080p"] as const)("applies the visible %s default to generation without discarding other settings", (resolution) => {
    useSettingsStore.setState({ videoParams, defaultAspectRatio: "1:1", spendCapUsd: 2 });
    useSettingsStore.getState().setDefaultResolution(resolution);

    expect(useSettingsStore.getState()).toMatchObject({
      defaultResolution: resolution, videoParams: { ...videoParams, resolution },
      defaultAspectRatio: "1:1", spendCapUsd: 2,
    });
  });

  it.each(["720p", "1080p"] as const)("reflects advanced %s generation settings in the visible default", (resolution) => {
    useSettingsStore.setState({ defaultResolution: resolution === "720p" ? "1080p" : "720p", spendCapUsd: 2 });
    const parameters = { ...videoParams, resolution };
    useSettingsStore.getState().setVideoParams(parameters);

    expect(useSettingsStore.getState()).toMatchObject({ defaultResolution: resolution, videoParams: parameters, spendCapUsd: 2 });
  });

  it("keeps explicit advanced 480p generation without assigning an unsupported composition tier", () => {
    useSettingsStore.setState({ defaultResolution: "1080p" });
    useSettingsStore.getState().setVideoParams({ ...videoParams, resolution: "480p" });
    expect(useSettingsStore.getState()).toMatchObject({ defaultResolution: "1080p", videoParams: { ...videoParams, resolution: "480p" } });

    useSettingsStore.getState().setDefaultResolution("720p");
    expect(useSettingsStore.getState()).toMatchObject({ defaultResolution: "720p", videoParams: { ...videoParams, resolution: "720p" } });
  });

  it.each([
    ["720p", "1080p"], ["1080p", "720p"],
  ] as const)("hydrates version 5 with visible %s winning over hidden %s and saves the corrected version", async (visible, hidden) => {
    localStorage.setItem(storageKey, JSON.stringify({ version: 5, state: {
      defaultResolution: visible, videoParams: { ...videoParams, resolution: hidden },
      defaultVideoModel: "saved-kling-model", spendCapUsd: 2,
    } }));

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState()).toMatchObject({
      defaultResolution: visible, videoParams: { ...videoParams, resolution: visible },
      defaultVideoModel: "saved-kling-model", spendCapUsd: 2,
    });
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({ version: 8, state: {
      defaultResolution: visible, videoParams: { ...videoParams, resolution: visible },
    } });
  });

  it("retains an explicit advanced 480p tier when hydrating version 5", async () => {
    localStorage.setItem(storageKey, JSON.stringify({ version: 5, state: {
      defaultResolution: "720p", videoParams: { ...videoParams, resolution: "480p" },
    } }));

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState()).toMatchObject({ defaultResolution: "720p", videoParams: { ...videoParams, resolution: "480p" } });
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({ version: 8 });
  });
});
