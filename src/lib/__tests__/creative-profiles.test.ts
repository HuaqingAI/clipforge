import { describe, expect, it } from "vitest";
import {
  SHORT_VIDEO_SALES_PROFILE_ID,
  checkCreativeProfileContext,
  createCreativeProfileSnapshot,
  createShortVideoSalesProfile,
  createTideweOutdoorProfile,
  sanitizeCreativeProfile,
  sanitizeCreativeProfileDrafts,
  validateCreativeProfileInput,
} from "@/lib/creative-profiles";

describe("creative profile canonicalization", () => {
  it.each([
    "premium_product_cg",
    "premium_product_cg_v1",
    { creationType: "premium_product_cg" },
    { styleType: "premium_product_cg", videoMode: "scene_demo" },
    { id: "premium_product_cg_v1" },
    { profileId: "premium_product_cg_v1", videoMode: "product_closeup" },
  ])("rejects removed creation profiles: %j", value => {
    expect(validateCreativeProfileInput(value)).toMatchObject({ error: expect.any(String) });
    expect(sanitizeCreativeProfile(value)).toBeUndefined();
  });

  it("rejects conflicting identities between the supported types", () => {
    expect(validateCreativeProfileInput({ creationType: "tidewe_outdoor", styleType: "scene" }))
      .toMatchObject({ error: expect.stringContaining("same profile") });
    expect(validateCreativeProfileInput("unknown_profile")).toMatchObject({ error: expect.any(String) });
  });

  it("preserves sales settings, aliases and legacy profile resolution", () => {
    const legacy = createShortVideoSalesProfile({
      styleType: "pain-point", videoMode: "scene_demo", targetDuration: 45,
      composeSnapshot: { subtitles: true, ttsEnabled: true, ctaEnabled: true, productCard: true },
      creativeSettings: { look: "warm", soundMode: "music" }, recipeSnapshot: { templateId: "sales-template" },
    });
    expect(legacy).toMatchObject({
      id: SHORT_VIDEO_SALES_PROFILE_ID, creationType: "short_video_sales", styleType: "pain_point",
      videoMode: "scene_demo", targetDuration: 45,
      composeSnapshot: { subtitles: true, ttsEnabled: true, ctaEnabled: true, productCard: true },
      creativeSettings: { look: "warm", soundMode: "music" }, recipeSnapshot: { templateId: "sales-template" },
    });
    expect(sanitizeCreativeProfile(legacy)).toEqual(legacy);
    expect(sanitizeCreativeProfile({ styleType: "scene", videoMode: "live_presenter" }))
      .toMatchObject({ creationType: "short_video_sales", styleType: "scene", videoMode: "live_presenter" });
  });

  it.each(["on_camera", "voiceover"] as const)("preserves TIDEWE %s profiles and frozen script context", speechMode => {
    const profile = createTideweOutdoorProfile({ targetDuration: 60, speechMode, narrativeAngle: "use_demo" });
    expect(validateCreativeProfileInput(profile)).toEqual({ profile });
    const snapshot = createCreativeProfileSnapshot(profile, 12.9);
    expect(snapshot).toMatchObject({ creativeConfigRevision: 12, profile: {
      creationType: "tidewe_outdoor", speechMode, targetDuration: 60, language: "en-US", narrativeAngle: "use_demo",
      composeSnapshot: { aspectRatio: "9:16", ttsEnabled: speechMode === "voiceover", nativeAudio: speechMode === "on_camera" },
    } });
    expect(checkCreativeProfileContext({ creativeProfile: profile, creativeConfigRevision: 13 }, {
      styleType: "tidewe_outdoor", creativeProfileSnapshot: snapshot,
    })).toMatchObject({ ok: true, scriptProfile: profile, scriptRevision: 12 });
    expect(checkCreativeProfileContext({ creativeProfile: createShortVideoSalesProfile() }, {
      styleType: "tidewe_outdoor", creativeProfileSnapshot: snapshot,
    })).toMatchObject({ ok: false, code: "CREATIVE_PROFILE_MISMATCH" });
  });

  it("keeps only supported drafts without leaking one type's settings into the other", () => {
    const sales = createShortVideoSalesProfile({ styleType: "comparison" });
    const tidewe = createTideweOutdoorProfile({ speechMode: "voiceover" });
    expect(sanitizeCreativeProfileDrafts({
      short_video_sales: sales, tidewe_outdoor: tidewe, premium_product_cg: { creationType: "premium_product_cg" },
    })).toEqual({ short_video_sales: sales, tidewe_outdoor: tidewe });
  });

  it("snapshots a bounded config revision with the legacy sales fallback", () => {
    expect(createCreativeProfileSnapshot(undefined, -3, { styleType: "scene", videoMode: "product_closeup" }))
      .toMatchObject({ creativeConfigRevision: 0, profile: { creationType: "short_video_sales", styleType: "scene" } });
  });
});
