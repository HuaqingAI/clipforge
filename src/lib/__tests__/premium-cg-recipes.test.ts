import { describe, expect, it } from "vitest";
import {
  createPremiumCgRecipeSnapshot,
  normalizePremiumCgRecipeSnapshot,
  PREMIUM_CG_RECIPES,
} from "@/lib/premium-cg-recipes";
import {
  createPremiumProductCgProfile,
  createShortVideoSalesProfile,
  sanitizeCreativeProfileDrafts,
} from "@/lib/creative-profiles";
import { buildPremiumProductCgUserPrompt } from "@/lib/script-engine/prompts";

describe("premium furniture CG recipes", () => {
  it("keeps sales template selections in the sales draft snapshot", () => {
    const sales = createShortVideoSalesProfile({
      styleType: "scene",
      videoMode: "scene_demo",
      recipeSnapshot: {
        kind: "sales-template-selection",
        scriptTemplateId: "home-lifestyle",
        adTemplateId: "lifestyle_seed",
      },
    });
    const drafts = sanitizeCreativeProfileDrafts({ short_video_sales: sales });

    expect(drafts?.short_video_sales?.recipeSnapshot).toEqual({
      kind: "sales-template-selection",
      scriptTemplateId: "home-lifestyle",
      adTemplateId: "lifestyle_seed",
    });
  });

  it("ships the three curated recipes with immutable snapshots", () => {
    expect(PREMIUM_CG_RECIPES.map((recipe) => recipe.id)).toEqual([
      "form_portrait",
      "material_craft",
      "living_scale",
    ]);

    const snapshot = normalizePremiumCgRecipeSnapshot({
      recipeId: "living_scale",
      visualLook: "client-provided copy must not be trusted",
      shotBeats: ["cta"],
    });

    expect(snapshot).toEqual(createPremiumCgRecipeSnapshot("living_scale"));
  });

  it("derives CG defaults from the selected recipe while preserving the text policy", () => {
    const profile = createPremiumProductCgProfile({
      recipeSnapshot: { recipeId: "living_scale" },
      narrationMode: "none",
    });

    expect(profile).toMatchObject({
      videoMode: "scene_demo",
      visualDirection: { setting: "modern_home" },
      recipeSnapshot: createPremiumCgRecipeSnapshot("living_scale"),
      textPolicy: {
        generatedFrameText: "forbid-added",
        captions: false,
        editorialGraphics: false,
        productCard: false,
        cta: "none",
      },
    });
  });

  it("uses the selected recipe as visual direction without restoring commerce instructions", () => {
    const profile = createPremiumProductCgProfile({
      recipeSnapshot: createPremiumCgRecipeSnapshot("material_craft"),
      narrationMode: "none",
    });
    const prompt = buildPremiumProductCgUserPrompt({
      productName: "Lounge chair",
      category: "home",
      styleType: "premium_product_cg",
      creativeProfile: profile,
    });

    expect(prompt).toContain("Material & Craft");
    expect(prompt).toContain("visible upholstery, seams, joins, feet, or hardware");
    expect(prompt).toContain("no added text");
    expect(prompt).not.toContain("buy now");
    expect(prompt).not.toContain("add to cart");
  });
});
