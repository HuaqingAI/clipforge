import { describe, expect, it } from "vitest";
import {
  isProductionProfileId,
  productionProfilePatch,
  PRODUCTION_PROFILE_IDS,
  PRODUCTION_PROFILES,
} from "@/lib/production-profiles";
import { useSettingsStore } from "@/lib/stores/settings-store";

describe("production profiles", () => {
  it("keeps every profile internally consistent", () => {
    for (const id of PRODUCTION_PROFILE_IDS) {
      const profile = PRODUCTION_PROFILES[id];
      expect(profile.id).toBe(id);
      expect(profile.motionStrength).toBeGreaterThanOrEqual(0);
      expect(profile.motionStrength).toBeLessThanOrEqual(1);
      expect(profile.duration).toBeGreaterThan(0);
    }
  });

  it("applies a profile without discarding user-owned optional parameters", () => {
    const patch = productionProfilePatch("rapid", {
      imageParams: { aspectRatio: "16:9", count: 3, seed: 42, negativePrompt: "blur" },
      videoParams: { aspectRatio: "16:9", resolution: "1080p", seed: 7, fps: 30 },
    });

    expect(patch.defaultResolution).toBe("720p");
    expect(patch.imageParams).toMatchObject({ aspectRatio: "16:9", count: 1, seed: 42, negativePrompt: "blur" });
    expect(patch.videoParams).toMatchObject({ aspectRatio: "16:9", resolution: "720p", duration: 4, seed: 7, fps: 30 });
    expect(patch.chainMode).toBe("off");
  });

  it("rejects stale or unknown persisted ids", () => {
    expect(isProductionProfileId("balanced")).toBe(true);
    expect(isProductionProfileId("ultra")).toBe(false);
    expect(isProductionProfileId(null)).toBe(false);
  });

  it.each(["", "doubao-seedance-2.5", JSON.stringify(["kling-cli", "image_to_video", "kling-video-v4_0"])])("never replaces the explicit video default when applying profiles or onboarding: %s", (defaultVideoModel) => {
    const previous = useSettingsStore.getState();
    try {
      useSettingsStore.setState({ defaultVideoModel });
      for (const profile of PRODUCTION_PROFILE_IDS) {
        useSettingsStore.getState().applyProductionProfile(profile);
        expect(useSettingsStore.getState().defaultVideoModel).toBe(defaultVideoModel);
      }
      useSettingsStore.getState().applyAtlasOneKey("test-onboarding-key");
      expect(useSettingsStore.getState().defaultVideoModel).toBe(defaultVideoModel);
    } finally {
      useSettingsStore.setState(previous);
    }
  });
});
