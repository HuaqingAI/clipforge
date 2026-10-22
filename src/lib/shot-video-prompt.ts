import type { Shot } from "@/lib/db/schema";
import { getLookPreset, LOOK_NONE } from "@/lib/look-presets";
import { buildMotionPrompt, type MotionIntensity, type MotionRealismTier } from "@/lib/motion-prompt";
import { compileCreativePrompt, sanitizeCreativeIntent, sanitizeVisualBible } from "@/lib/production-system";
import { joinVideoPromptParts } from "@/lib/video-prompt";

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
  shot?: Partial<Pick<Shot, "type" | "camera" | "description" | "visualSource" | "characterId" | "voiceover">>;
  ordinal: number;
  settings?: Partial<VideoPromptSettings>;
  category?: string | null;
  creativeIntent?: unknown;
  visualBible?: unknown;
  chainToNext?: boolean;
  locale?: "zh" | "en";
}

const PRODUCT_SHOT_TYPES = new Set(["product_reveal", "demo", "cta"]);

/** Shared visual direction for single-shot and full-film generation. Audio is added by the caller. */
export function buildShotVideoPrompt(input: ShotVideoPromptInput): { prompt: string; negativePrompt: string } {
  const shot = input.shot;
  const settings = normalizeVideoPromptSettings(input.settings);
  const look = getLookPreset(settings.visualLook);
  const motion = buildMotionPrompt({
    shotType: shot?.type,
    camera: shot?.camera,
    description: shot?.description,
    productShot: shot?.visualSource === "product_image" || PRODUCT_SHOT_TYPES.has(shot?.type ?? ""),
    personShot: !!shot?.characterId,
    // Silent footage may still need speaking actions for narration added in the editor.
    talking: !!shot?.characterId && !!shot?.voiceover?.trim(),
    beatSeed: input.ordinal,
    chainToNext: input.chainToNext,
    intensity: settings.motionIntensity,
    realism: settings.motionRealism,
    look: look?.motion,
    opener: look?.opener,
    category: input.category ?? undefined,
    audioMode: "none",
  });
  const intent = sanitizeCreativeIntent(input.creativeIntent);
  const bible = sanitizeVisualBible(input.visualBible);
  const direction = compileCreativePrompt({
    ...intent,
    continuity: [...(intent.continuity ?? []), ...bible.characterAnchors, ...bible.wardrobeAnchors, ...bible.environmentAnchors, ...bible.lightingAnchors],
    productConstraints: [...(intent.productConstraints ?? []), ...bible.productAnchors],
  });
  const probe = `${shot?.camera ?? ""}\n${shot?.description ?? ""}`.trim();
  const locale = input.locale ?? (!probe || /[一-鿿぀-ヿ가-힯]/.test(probe) ? "zh" : "en");
  return {
    prompt: joinVideoPromptParts([motion, ...(direction.prompt ? [`Project direction: ${direction.prompt}`] : [])], locale, "\n"),
    negativePrompt: direction.negativePrompt,
  };
}
