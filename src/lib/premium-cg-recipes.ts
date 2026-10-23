/**
 * Curated visual recipes for the premium product CG profile.
 *
 * These are deliberately separate from commerce AdTemplate recipes. A premium
 * recipe may steer shot order, setting, and light, but it never carries copy,
 * captions, a product card, or a call to action.
 */

export const PREMIUM_CG_RECIPE_IDS = [
  "form_portrait",
  "material_craft",
  "living_scale",
] as const;

export type PremiumCgRecipeId = (typeof PREMIUM_CG_RECIPE_IDS)[number];
// Keep modern_home as the persisted identifier for category-adaptive use contexts.
export type PremiumCgRecipeSetting = "studio" | "modern_home";
export type PremiumCgRecipeVideoMode = "product_closeup" | "scene_demo";

export interface PremiumCgRecipe {
  id: PremiumCgRecipeId;
  version: 1;
  name: { zh: string; en: string };
  description: { zh: string; en: string };
  setting: PremiumCgRecipeSetting;
  videoMode: PremiumCgRecipeVideoMode;
  visualLook: string;
  shotBeats: readonly string[];
  promptDirective: string;
}

/**
 * The persisted shape is intentionally an immutable recipe snapshot rather
 * than arbitrary prompt text. On read, it is rebuilt from this library using
 * recipeId, so client supplied fields cannot weaken the product-film policy.
 */
export interface PremiumCgRecipeSnapshot {
  kind: "premium-product-cg-recipe";
  recipeId: PremiumCgRecipeId;
  recipeVersion: 1;
  setting: PremiumCgRecipeSetting;
  videoMode: PremiumCgRecipeVideoMode;
  visualLook: string;
  shotBeats: string[];
}

export const PREMIUM_CG_RECIPES: readonly PremiumCgRecipe[] = [
  {
    id: "form_portrait",
    version: 1,
    name: { zh: "形体肖像", en: "Form Portrait" },
    description: {
      zh: "从全貌、比例到轮廓与边缘光，适合新品主视觉。",
      en: "A measured study of silhouette, proportion, and edge light for a hero product film.",
    },
    setting: "studio",
    videoMode: "product_closeup",
    visualLook: "controlled neutral studio light, minimal backdrop suited to product scale, measured silhouette and edge highlights",
    shotBeats: ["establish", "form", "proportion", "material", "hero"],
    promptDirective: "Use the Form Portrait recipe. Build a calm sequence from a full silhouette to proportion, contour, and a final hero composition. Keep the setting neutral and the product isolated at its actual scale; use light to describe reference-supported edges and volume. Preserve the supplied product's shape, finish, and visible markings without inventing unseen angles.",
  },
  {
    id: "material_craft",
    version: 1,
    name: { zh: "材质工艺", en: "Material & Craft" },
    description: {
      zh: "以参考资料可见的表面质感、材质与工艺细节呈现产品品质。",
      en: "A detail-led study of the product's documented surface, materials, and craftsmanship.",
    },
    setting: "studio",
    videoMode: "product_closeup",
    visualLook: "soft raking studio light, faithful material texture, restrained macro detail, clean contact shadows",
    shotBeats: ["establish", "material", "craft", "detail", "hero"],
    promptDirective: "Use the Material & Craft recipe. Start with one clear whole-product view, then select close details appropriate to the product category and visible in the supplied reference. Observe surface texture, finish, edges, or documented craftsmanship only where supported. When material or construction is unknown, describe visible appearance without naming a material or manufacturing process. Return to the complete product for the final frame; do not infer hidden construction or add category-specific parts.",
  },
  {
    id: "living_scale",
    version: 1,
    name: { zh: "场景尺度", en: "Context & Scale" },
    description: {
      zh: "按产品用途选择适配场景，呈现真实尺度与资料支持的使用关系。",
      en: "A setting matched to the product's use, with faithful scale and supported usage context.",
    },
    setting: "modern_home",
    videoMode: "scene_demo",
    visualLook: "calm category-appropriate use setting, soft natural or controlled light, restrained background and faithful product scale",
    shotBeats: ["establish", "lifestyle", "scale", "function", "hero"],
    promptDirective: "Use the Context & Scale recipe. Choose a restrained setting appropriate to the supplied product category and documented use. Let the actual product use determine the setting and show its scale and relationship to its surroundings. Include at most one simple interaction with a cropped hand or unfaced person only when the supplied facts support that use; otherwise keep the product still and use framing to convey scale. The product remains the subject and camera movement stays slow and physically plausible.",
  },
] as const;

export const DEFAULT_PREMIUM_CG_RECIPE_ID: PremiumCgRecipeId = "form_portrait";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getPremiumCgRecipe(id: unknown): PremiumCgRecipe | undefined {
  return typeof id === "string"
    ? PREMIUM_CG_RECIPES.find((recipe) => recipe.id === id)
    : undefined;
}

export function createPremiumCgRecipeSnapshot(
  id: PremiumCgRecipeId = DEFAULT_PREMIUM_CG_RECIPE_ID,
): PremiumCgRecipeSnapshot {
  const recipe = getPremiumCgRecipe(id) ?? PREMIUM_CG_RECIPES[0];
  return {
    kind: "premium-product-cg-recipe",
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    setting: recipe.setting,
    videoMode: recipe.videoMode,
    visualLook: recipe.visualLook,
    shotBeats: [...recipe.shotBeats],
  };
}

/** Returns a canonical snapshot for a known recipe, or undefined for a foreign payload. */
export function normalizePremiumCgRecipeSnapshot(value: unknown): PremiumCgRecipeSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const recipe = getPremiumCgRecipe(value.recipeId ?? value.id);
  return recipe ? createPremiumCgRecipeSnapshot(recipe.id) : undefined;
}

/** Converts a stored snapshot back to trusted recipe data for prompt construction. */
export function getPremiumCgRecipeFromSnapshot(value: unknown): PremiumCgRecipe | undefined {
  const snapshot = normalizePremiumCgRecipeSnapshot(value);
  return snapshot ? getPremiumCgRecipe(snapshot.recipeId) : undefined;
}
