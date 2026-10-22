/**
 * Curated visual recipes for the premium furniture CG profile.
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
    visualLook: "controlled neutral studio light, calm architectural backdrop, measured silhouette and edge highlights",
    shotBeats: ["establish", "form", "proportion", "material", "hero"],
    promptDirective: "Use the Form Portrait recipe. Build a calm sequence from a full silhouette to proportion, contour, and a final hero composition. Keep the setting neutral and the product isolated; use light to describe edges and volume rather than spectacle.",
  },
  {
    id: "material_craft",
    version: 1,
    name: { zh: "材质工艺", en: "Material & Craft" },
    description: {
      zh: "围绕面料、接缝、五金和结构细节，适合高质量细节素材。",
      en: "A detail-led study of material, seams, hardware, and construction evidence.",
    },
    setting: "studio",
    videoMode: "product_closeup",
    visualLook: "soft raking studio light, faithful material texture, restrained macro detail, clean contact shadows",
    shotBeats: ["establish", "material", "craft", "hardware", "hero"],
    promptDirective: "Use the Material & Craft recipe. Start with one clear whole-product view, then observe only visible upholstery, seams, joins, feet, or hardware in controlled close detail. Return to the complete product for the final frame; do not infer hidden construction.",
  },
  {
    id: "living_scale",
    version: 1,
    name: { zh: "融入生活", en: "Living Scale" },
    description: {
      zh: "以安静的现代居住空间呈现尺度与一次真实使用动作。",
      en: "A quiet contemporary interior that shows scale and one supported use moment.",
    },
    setting: "modern_home",
    videoMode: "scene_demo",
    visualLook: "bright quiet contemporary residence, soft natural window light, low-saturation neutral materials and balanced spatial scale",
    shotBeats: ["establish", "lifestyle", "scale", "function", "hero"],
    promptDirective: "Use the Living Scale recipe. Establish a quiet contemporary home, show how the furniture sits in the room, and include at most one supported unfaced interaction to establish scale or comfort. The furniture remains the subject and the camera movement stays slow and physically plausible.",
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
