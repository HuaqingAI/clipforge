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
  "高端产品三维动态影像。根据所提供的产品信息和参考资料判断真实的产品类别与用途。仅以当前项目提供的产品图片和已批准关键帧为依据，保持轮廓、比例、部件数量、可见结构、表面处理、材质、颜色和已有标识一致。场景、尺度、构图和照明须与该产品及资料已确认的使用环境相符；未指定使用环境时采用中性摄影棚。产品结构始终稳定，镜头只进行一次克制、物理合理的运动，角度严格限制在参考资料支持的范围内。不生成新增的画面文字、标题、字幕、标签、数字、价格、促销图形、产品卡片、二维码、水印、标志或购买引导，不出现主持人表演，不虚构产品部件、机构、材质或功能；仅保留参考资料中已可见的产品标识。";

export const PREMIUM_CG_VIDEO_NEGATIVE_PROMPT =
  "新增文字、标题、字幕、标签、标题卡、价格、数字、促销图形、产品卡片、二维码、水印、虚构标志、购买引导、立即购买、折扣、促销角标、主持人、夸张手势、多余产品部件、虚构机构、几何变形、重复产品、闪烁";

/** Translate only exact shipped defaults; custom product facts and visual direction stay intact. */
const BUILTIN_CG_VIDEO_LOOK_ZH: Readonly<Record<string, string>> = {
  "controlled neutral studio light, minimal backdrop suited to product scale, measured silhouette and edge highlights": "受控的中性摄影棚灯光，与产品尺度相适应的简洁背景，克制呈现轮廓与边缘高光",
  "controlled neutral studio light, calm architectural backdrop, measured silhouette and edge highlights": "受控的中性摄影棚灯光，与产品尺度相适应的简洁背景，克制呈现轮廓与边缘高光",
  "soft raking studio light, faithful material texture, restrained macro detail, clean contact shadows": "柔和的摄影棚掠射光，忠实保留材质纹理，克制呈现微距细节，接触阴影干净自然",
  "calm category-appropriate use setting, soft natural or controlled light, restrained background and faithful product scale": "与产品类别和用途相适应的安静场景，柔和的自然光或受控灯光，背景克制，产品尺度真实",
  "bright quiet contemporary residence, soft natural window light, low-saturation neutral materials and balanced spatial scale": "与产品类别和用途相适应的安静场景，柔和的自然光或受控灯光，背景克制，产品尺度真实",
  "quiet premium product film": "安静克制的高品质产品影像",
  "quiet premium furniture product film": "安静克制的高品质产品影像",
};

export function premiumCgVideoLookZh(look: string): string {
  return BUILTIN_CG_VIDEO_LOOK_ZH[look] ?? look;
}

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
    visual && `镜头画面：${visual}`,
    camera && `镜头运动：${camera}`,
    profileLook && `光线与风格：${premiumCgVideoLookZh(profileLook)}`,
    PREMIUM_CG_VIDEO_POLICY,
  ].filter(Boolean);
  return {
    prompt: promptParts.join("\n"),
    negativePrompt: PREMIUM_CG_VIDEO_NEGATIVE_PROMPT,
  };
}
