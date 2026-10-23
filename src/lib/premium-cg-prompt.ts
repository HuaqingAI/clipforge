import { isPremiumProductCgProfile, sanitizeCreativeProfile, type ProjectCreativeProfile } from "@/lib/creative-profiles";

/**
 * The image providers do not share a reliable negative-prompt contract. Keep the
 * positive policy in the main prompt as well as in the optional negative field so
 * every provider receives the same visual intent.
 */
export const PREMIUM_CG_IMAGE_POLICY =
  "Premium product CG. Determine the actual product category and intended use from the supplied product information and references. Use supplied product references as the source of truth for silhouette, proportions, component count, visible construction, surface finishes, materials, color, and existing markings. Show one calm product observation with scale, framing, lighting, and setting suited to that product and its documented use context; use a neutral studio when the context is unspecified. Do not generate added on-screen text, captions, subtitles, labels, numbers, prices, promotional graphics, product cards, QR codes, watermarks, logos, or calls to action; preserve only markings already visible in the supplied product reference. Do not invent unseen construction, mechanisms, materials, functions, or extra product parts.";

export const PREMIUM_CG_IMAGE_NEGATIVE_PROMPT =
  "added text, captions, subtitles, labels, title cards, price, numbers, promotional graphic, product card, QR code, watermark, invented logo, CTA, buy now, discount, sale badge, extra product parts, invented mechanism, distorted geometry, duplicate product";

/**
 * Motion requests are compiled separately from keyframe prompts so a direct
 * video endpoint cannot inherit a client-side sales prompt.
 */
export const PREMIUM_CG_VIDEO_POLICY =
  "Premium product CG motion. Determine the actual product category and intended use from the supplied product information and references. Use only the supplied project-owned product and approved keyframe references as the source of truth for silhouette, proportions, component count, visible construction, surface finishes, materials, color, and existing markings. Match scale, framing, lighting, and setting to that product and its documented use context; use a neutral studio when the context is unspecified. Keep the product structurally stable while the camera makes one restrained, physically plausible movement limited to reference-supported angles. Do not generate added on-screen text, captions, subtitles, labels, numbers, prices, promotional graphics, product cards, QR codes, watermarks, logos, calls to action, presenter performance, or invented product parts, mechanisms, materials, or functions; preserve only markings already visible in the supplied references.";

export const PREMIUM_CG_VIDEO_NEGATIVE_PROMPT =
  "added text, captions, subtitles, labels, title cards, price, numbers, promotional graphic, product card, QR code, watermark, invented logo, CTA, buy now, discount, sale badge, presenter, exaggerated gesture, extra product parts, invented mechanism, distorted geometry, duplicate product, flicker";

const POSITIVE_TEXT_DIRECTIVE = /(?:\b(?:add|show|display|render|include|place|write|overlay|insert)\b[^.\n]{0,100}\b(?:text|caption|subtitle|label|price|number|logo|watermark|card|cta|qr)\b|\b(?:text|caption|subtitle|label|price|number|logo|watermark|card|cta|qr)\b[^.\n]{0,100}\b(?:appears?|displayed|shown|fades?|animat|overlay|on[- ]screen)\b)/i;
const POSITIVE_MARKETING_DIRECTIVE = /\b(?:buy\s+now|shop\s+now|add\s+to\s+cart|limited\s+time|discount|sale\s+badge|call\s+to\s+action|promotional\s+graphic)\b/i;

function isNegatedClause(clause: string): boolean {
  return /\b(?:no|never|without|avoid|forbid|forbidden|do not|don't)\b/i.test(clause)
    || /(?:禁止|不得|不要|不生成|不添加|无新增|避免)/.test(clause);
}

/** Remove positive copy instructions inherited from legacy sales descriptions. */
export function stripPremiumCgCopyDirectives(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .split(/(?<=[.!?。！？])|\r?\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .filter((part) => !(POSITIVE_TEXT_DIRECTIVE.test(part) && !isNegatedClause(part)))
    .filter((part) => !(POSITIVE_MARKETING_DIRECTIVE.test(part) && !isNegatedClause(part)))
    .join(" ")
    .slice(0, 12000);
}

export function isPremiumCgPolicy(value: unknown): boolean {
  return isPremiumProductCgProfile(value);
}

export interface PremiumCgPromptResult {
  prompt: string;
  negativePrompt: string;
}

/** Compile a provider-neutral premium-CG image prompt on the trusted side. */
export function compilePremiumCgImagePrompt(
  shot: PremiumCgVideoShotPromptInput,
  profile?: ProjectCreativeProfile | unknown,
): PremiumCgPromptResult {
  const visual = stripPremiumCgCopyDirectives(
    [shot.visualIntent, shot.description, shot.camera]
      .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      .join("\n"),
  );
  const normalizedProfile = sanitizeCreativeProfile(profile);
  const profileLook = normalizedProfile?.creationType === "premium_product_cg" ? normalizedProfile.visualDirection.look : "";
  const promptParts = [visual, profileLook, PREMIUM_CG_IMAGE_POLICY].filter(Boolean);
  return {
    prompt: promptParts.join("\n"),
    negativePrompt: PREMIUM_CG_IMAGE_NEGATIVE_PROMPT,
  };
}

export interface PremiumCgVideoShotPromptInput {
  description?: unknown;
  visualIntent?: unknown;
  camera?: unknown;
}

/** Compile video motion direction from the approved script shot and persisted profile only. */
export function compilePremiumCgVideoPrompt(
  shot: PremiumCgVideoShotPromptInput,
  profile?: ProjectCreativeProfile | unknown,
): PremiumCgPromptResult {
  const visual = stripPremiumCgCopyDirectives(
    [shot.visualIntent, shot.description]
      .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      .join("\n"),
  );
  const camera = stripPremiumCgCopyDirectives(shot.camera);
  const normalizedProfile = sanitizeCreativeProfile(profile);
  const profileLook = normalizedProfile?.creationType === "premium_product_cg" ? normalizedProfile.visualDirection.look : "";
  const promptParts = [
    visual && `Approved shot direction: ${visual}`,
    camera && `Approved camera direction: ${camera}`,
    profileLook,
    PREMIUM_CG_VIDEO_POLICY,
  ].filter(Boolean);
  return {
    prompt: promptParts.join("\n"),
    negativePrompt: PREMIUM_CG_VIDEO_NEGATIVE_PROMPT,
  };
}
