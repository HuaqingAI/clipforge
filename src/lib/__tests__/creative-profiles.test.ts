import { describe, expect, it } from "vitest";
import {
  PREMIUM_PRODUCT_CG_PROFILE_ID,
  PREMIUM_PRODUCT_CG_STYLE,
  SHORT_VIDEO_SALES_PROFILE_ID,
  createCreativeProfileSnapshot,
  createPremiumProductCgProfile,
  createShortVideoSalesProfile,
  isPremiumProductCgProfile,
  sanitizeCreativeProfile,
  validateCreativeProfileInput,
} from "@/lib/creative-profiles";

describe("creative profile canonicalization", () => {
  it("keeps the premium CG policy canonical even when options try to enable sales layers", () => {
    const profile = createPremiumProductCgProfile({
      targetDuration: 60,
      videoMode: "graphic_montage",
      narrationMode: "none",
      soundMode: "restrained-voice",
      brandEndCard: "approved",
      visualDirection: { setting: "modern_home", look: "quiet oak study" },
    });

    expect(profile).toMatchObject({
      id: PREMIUM_PRODUCT_CG_PROFILE_ID,
      styleType: PREMIUM_PRODUCT_CG_STYLE,
      creationType: "premium_product_cg",
      videoMode: "product_closeup",
      targetDuration: 60,
      narrationMode: "none",
      soundMode: "ambient",
      textPolicy: {
        generatedFrameText: "forbid-added",
        captions: false,
        editorialGraphics: false,
        productCard: false,
        cta: "none",
        brandEndCard: "approved",
      },
      visualDirection: { setting: "modern_home", look: "quiet oak study" },
    });
    expect(isPremiumProductCgProfile(profile)).toBe(true);
  });

  it("accepts legacy premium identifiers and ignores a legacy text policy that would weaken it", () => {
    const profile = sanitizeCreativeProfile({
      creativeProfileId: PREMIUM_PRODUCT_CG_PROFILE_ID,
      targetDuration: 15,
      narrationMode: "restrained",
      textPolicy: "allow captions and CTA",
    });

    expect(profile).toMatchObject({
      creationType: "premium_product_cg",
      id: PREMIUM_PRODUCT_CG_PROFILE_ID,
      targetDuration: 15,
      narrationMode: "restrained",
      soundMode: "restrained-voice",
      textPolicy: {
        captions: false,
        editorialGraphics: false,
        productCard: false,
        cta: "none",
      },
    });
  });

  it("rejects mixed profile identities before canonicalization", () => {
    const result = validateCreativeProfileInput({
      creationType: "premium_product_cg",
      styleType: "scene",
      profileId: PREMIUM_PRODUCT_CG_PROFILE_ID,
    });

    expect(result).toMatchObject({ error: expect.stringContaining("same profile") });
    expect(validateCreativeProfileInput("unknown_profile")).toMatchObject({ error: expect.any(String) });
  });

  it("keeps legacy sales rows resolvable and snapshots a bounded config revision", () => {
    const legacy = createShortVideoSalesProfile({
      styleType: "pain-point",
      videoMode: "scene_demo",
      targetDuration: 45,
    });
    expect(legacy).toMatchObject({
      id: SHORT_VIDEO_SALES_PROFILE_ID,
      creationType: "short_video_sales",
      styleType: "pain_point",
      videoMode: "scene_demo",
      targetDuration: 45,
    });

    const snapshot = createCreativeProfileSnapshot(
      { profileId: PREMIUM_PRODUCT_CG_PROFILE_ID, narrationMode: "none" },
      12.9,
    );
    expect(snapshot.creativeConfigRevision).toBe(12);
    expect(snapshot.profile.creationType).toBe("premium_product_cg");

    const fallback = createCreativeProfileSnapshot(undefined, -3, {
      styleType: "scene",
      videoMode: "product_closeup",
    });
    expect(fallback).toMatchObject({
      creativeConfigRevision: 0,
      profile: { creationType: "short_video_sales", styleType: "scene" },
    });
  });
});
