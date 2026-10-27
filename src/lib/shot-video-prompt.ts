import type { Shot } from "@/lib/db/schema";
import { getLookPreset, LOOK_NONE } from "@/lib/look-presets";
import {
  buildMotionPrompt,
  isPremiumCgPromptPolicy,
  type MotionIntensity,
  type MotionPromptOutputPolicy,
  type MotionRealismTier,
} from "@/lib/motion-prompt";
import { compileCreativePrompt, sanitizeCreativeIntent, sanitizeVisualBible } from "@/lib/production-system";
import { joinVideoPromptParts } from "@/lib/video-prompt";
import { isPremiumProductCgProfile, isTideweOutdoorProfile } from "@/lib/creative-profiles";
import { compileTideweVisualPrompt } from "@/lib/tidewe/visual-policy";

/** Browser settings frozen into a video preview; never read browser state on the server. */
export interface VideoPromptSettings {
  visualLook: string;
  motionIntensity: MotionIntensity;
  motionRealism: MotionRealismTier;
}

export const DEFAULT_VIDEO_PROMPT_SETTINGS: Readonly<VideoPromptSettings> = {
  visualLook: LOOK_NONE,
  motionIntensity: "normal",
  motionRealism: "auto",
};

export function normalizeVideoPromptSettings(raw?: unknown): VideoPromptSettings {
  if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error("视频提示词设置必须是对象。");
  }
  const value = (raw ?? {}) as Partial<VideoPromptSettings>;
  const settings = {
    visualLook: value.visualLook === undefined ? DEFAULT_VIDEO_PROMPT_SETTINGS.visualLook : value.visualLook,
    motionIntensity: value.motionIntensity === undefined ? DEFAULT_VIDEO_PROMPT_SETTINGS.motionIntensity : value.motionIntensity,
    motionRealism: value.motionRealism === undefined ? DEFAULT_VIDEO_PROMPT_SETTINGS.motionRealism : value.motionRealism,
  };
  if (typeof settings.visualLook !== "string" || (settings.visualLook !== LOOK_NONE && !getLookPreset(settings.visualLook))
    || !["subtle", "normal", "strong"].includes(settings.motionIntensity)
    || !["auto", "constraints", "off"].includes(settings.motionRealism)) {
    throw new Error("视频的视觉风格、运镜强度或真实感设置无效。");
  }
  return settings;
}

export interface ShotVideoPromptInput {
  shot?: Partial<Pick<Shot, "type" | "camera" | "description" | "visualIntent" | "visualSource" | "characterId" | "voiceover" | "narration" | "tidewe">>;
  ordinal: number;
  settings?: Partial<VideoPromptSettings>;
  category?: string | null;
  creativeIntent?: unknown;
  visualBible?: unknown;
  /** Project-level creative profile, frozen by the caller when available. */
  creativeProfile?: unknown;
  /** On-camera visuals may receive their narration later when the model has no audio. */
  audioMode?: "native" | "post";
  /** Compatibility policy for callers that have not loaded the project profile yet. */
  outputPolicy?: MotionPromptOutputPolicy;
  chainToNext?: boolean;
  locale?: "zh" | "en";
}

const PRODUCT_SHOT_TYPES = new Set(["product_reveal", "demo", "cta"]);

/** Shared visual direction for single-shot and full-film generation. Audio is added by the caller. */
export function buildShotVideoPrompt(input: ShotVideoPromptInput): { prompt: string; negativePrompt: string } {
  const shot = input.shot;
  if (isTideweOutdoorProfile(input.creativeProfile)) return compileTideweVisualPrompt(shot ?? {}, "video", input.creativeProfile.speechMode, input.creativeProfile.presenter, input.audioMode);
  const settings = normalizeVideoPromptSettings(input.settings);
  const look = getLookPreset(settings.visualLook);
  const premiumProfile = isPremiumProductCgProfile(input.creativeProfile)
    ? input.creativeProfile
    : undefined;
  const premiumCg = Boolean(premiumProfile) || isPremiumCgPromptPolicy(input.outputPolicy);
  const premiumLook = premiumProfile?.visualDirection.look.trim();
  const visualDescription = shot?.visualIntent?.trim() || shot?.description;
  const probe = `${shot?.camera ?? ""}\n${visualDescription ?? ""}`.trim();
  const locale = input.locale ?? (!probe || /[一-鿿぀-ヿ가-힯]/.test(probe) ? "zh" : "en");
  const motion = buildMotionPrompt({
    locale,
    shotType: shot?.type,
    camera: shot?.camera,
    description: visualDescription,
    productShot: shot?.visualSource === "product_image" || PRODUCT_SHOT_TYPES.has(shot?.type ?? ""),
    personShot: !!shot?.characterId,
    // Silent footage may still need speaking actions for narration added in the editor.
    talking: !!shot?.characterId && !!(shot?.voiceover?.trim() || shot?.narration?.trim()),
    beatSeed: input.ordinal,
    chainToNext: input.chainToNext,
    intensity: settings.motionIntensity,
    realism: settings.motionRealism,
    // Global Look presets are tuned for the short-video sales workflow. Premium CG is
    // defined by the persisted project profile, including its lighting direction.
    look: premiumCg
      ? premiumLook ? { zh: premiumLook, en: premiumLook } : undefined
      : look?.motion,
    opener: premiumCg ? undefined : look?.opener,
    category: input.category ?? undefined,
    audioMode: "none",
    creativeProfile: input.creativeProfile,
    outputPolicy: input.outputPolicy,
  });
  const intent = sanitizeCreativeIntent(input.creativeIntent);
  const bible = sanitizeVisualBible(input.visualBible);
  const direction = compileCreativePrompt({
    ...intent,
    continuity: [...(intent.continuity ?? []), ...bible.characterAnchors, ...bible.wardrobeAnchors, ...bible.environmentAnchors, ...bible.lightingAnchors],
    productConstraints: [...(intent.productConstraints ?? []), ...bible.productAnchors],
  }, locale);
  return {
    // Sales-oriented free-form project direction can contain legacy hooks, offers, or CTA
    // wording. Premium CG prompts only use the script, locked profile, and product references.
    prompt: joinVideoPromptParts([motion, ...(!premiumCg && direction.prompt ? [`${locale === "zh" ? "项目方向：" : "Project direction: "}${direction.prompt}`] : [])], locale, "\n"),
    negativePrompt: premiumCg
      ? locale === "zh" ? "新增画面文字、字幕、价格、数字、营销图形、行动引导、水印" : "added on-screen text, subtitles, prices, numbers, promotional graphics, CTA, watermark"
      : direction.negativePrompt,
  };
}
