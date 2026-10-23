import { describe, expect, it } from "vitest";
import {
  PREMIUM_PRODUCT_CG_PROFILE_ID,
  PREMIUM_PRODUCT_CG_PROMPT_COMPILER_VERSION,
  PREMIUM_PRODUCT_CG_STYLE,
  SHORT_VIDEO_SALES_PROFILE_ID,
  createCreativeProfileSnapshot,
  creativeProfileDraftsInputError,
  createPremiumProductCgProfile,
  createShortVideoSalesProfile,
  isPremiumProductCgProfile,
  sanitizeCreativeProfile,
  validateCreativeProfileInput,
} from "@/lib/creative-profiles";
import { createPremiumCgRecipeSnapshot } from "@/lib/premium-cg-recipes";

describe("creative profile canonicalization", () => {
  it("validates nested draft sources and creation types before applying legacy defaults", () => {
    expect(creativeProfileDraftsInputError(undefined)).toBeUndefined();
    expect(creativeProfileDraftsInputError({})).toBeUndefined();
    expect(creativeProfileDraftsInputError({
      short_video_sales: createShortVideoSalesProfile(),
      premium_product_cg: createPremiumProductCgProfile({ visualSource: "ai_generate" }),
    })).toBeUndefined();
    expect(creativeProfileDraftsInputError({
      sales: { creationType: "short_video_sales" },
      cg: { creationType: "premium_product_cg", visualSource: "ai_generate" },
    })).toBeUndefined();
    for (const value of [null, [], "drafts"]) {
      expect(creativeProfileDraftsInputError(value)).toContain("JSON object");
    }
    for (const key of ["short_video_sales", "sales", "premium_product_cg", "cg"]) {
      const creationType = key === "sales" || key === "short_video_sales" ? "short_video_sales" : "premium_product_cg";
      expect(creativeProfileDraftsInputError({ [key]: { creationType, visualSource: "user_upload" } })).toContain("visualSource");
      expect(creativeProfileDraftsInputError({ [key]: undefined })).toContain(key);
    }
    expect(creativeProfileDraftsInputError({ sales: createPremiumProductCgProfile() })).toContain("short_video_sales");
    expect(creativeProfileDraftsInputError({ cg: createShortVideoSalesProfile() })).toContain("premium_product_cg");
  });

  it.each([createShortVideoSalesProfile, createPremiumProductCgProfile])("defaults new and legacy profiles to product photos while preserving a selected AI source", (create) => {
    expect(create().visualSource).toBe("product_image");
    expect(sanitizeCreativeProfile(create())?.visualSource).toBe("product_image");
    const ai = create({ visualSource: "ai_generate" });
    expect(ai.visualSource).toBe("ai_generate");
    expect(sanitizeCreativeProfile(JSON.parse(JSON.stringify(ai)))).toEqual(ai);
    const legacy = { ...ai } as Record<string, unknown>;
    delete legacy.visualSource;
    expect(sanitizeCreativeProfile(legacy)?.visualSource).toBe("product_image");
  });

  it.each(["short_video_sales", "premium_product_cg"] as const)("rejects invalid explicitly supplied sources for %s", (creationType) => {
    for (const visualSource of ["user_upload", "auto", "", null, 1]) {
      expect(validateCreativeProfileInput({ creationType, visualSource })).toMatchObject({
        error: expect.stringContaining("visualSource"),
      });
    }
    expect(validateCreativeProfileInput({ creationType })).toMatchObject({ profile: { visualSource: "product_image" } });
    expect(validateCreativeProfileInput({ creationType, visualSource: "ai_generate" })).toMatchObject({ profile: { visualSource: "ai_generate" } });
  });

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

  it.each([
    ["form_portrait", "studio", "controlled neutral studio light, calm architectural backdrop, measured silhouette and edge highlights"],
    ["living_scale", "modern_home", "bright quiet contemporary residence, soft natural window light, low-saturation neutral materials and balanced spatial scale"],
  ] as const)("upgrades the legacy %s look without changing its saved selection", (recipeId, setting, look) => {
    const profile = sanitizeCreativeProfile({
      id: PREMIUM_PRODUCT_CG_PROFILE_ID,
      promptCompilerVersion: "premium-furniture-cg-1",
      recipeSnapshot: { recipeId },
      visualDirection: { setting, look },
      narrationMode: "restrained",
      targetDuration: 60,
    });

    expect(profile).toMatchObject({
      id: PREMIUM_PRODUCT_CG_PROFILE_ID,
      promptCompilerVersion: PREMIUM_PRODUCT_CG_PROMPT_COMPILER_VERSION,
      recipeSnapshot: { recipeId },
      visualDirection: { setting, look: createPremiumCgRecipeSnapshot(recipeId).visualLook },
      narrationMode: "restrained",
      targetDuration: 60,
      textPolicy: { generatedFrameText: "forbid-added", captions: false, cta: "none" },
    });
    expect(sanitizeCreativeProfile(profile)).toEqual(profile);
  });

  it("preserves a custom product setting while upgrading the compiler", () => {
    const profile = sanitizeCreativeProfile({
      id: PREMIUM_PRODUCT_CG_PROFILE_ID,
      promptCompilerVersion: "premium-furniture-cg-1",
      visualDirection: { setting: "modern_home", look: "quiet watchmaker workbench with soft side light" },
    });

    expect(profile).toMatchObject({
      promptCompilerVersion: PREMIUM_PRODUCT_CG_PROMPT_COMPILER_VERSION,
      visualDirection: { setting: "modern_home", look: "quiet watchmaker workbench with soft side light" },
    });
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
