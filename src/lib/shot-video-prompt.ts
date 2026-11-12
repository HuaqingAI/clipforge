import type { Shot } from "@/lib/db/schema";
import { getLookPreset, LOOK_NONE } from "@/lib/look-presets";
import { buildMotionPrompt } from "@/lib/motion-prompt";
import { compileCreativePrompt, sanitizeCreativeIntent, sanitizeVisualBible } from "@/lib/production-system";
import { joinVideoPromptParts } from "@/lib/video-prompt";
import { isTideweOutdoorProfile } from "@/lib/creative-profiles";
import { compileTideweVisualPrompt } from "@/lib/tidewe/visual-policy";
import type { TideweVideoDirection } from "@/lib/tidewe/video-direction";

/** Browser settings frozen into a video preview; never read browser state on the server. */
export interface VideoPromptSettings {
  visualLook: string;
}

export const DEFAULT_VIDEO_PROMPT_SETTINGS: Readonly<VideoPromptSettings> = {
  visualLook: LOOK_NONE,
};

export function normalizeVideoPromptSettings(raw?: unknown): VideoPromptSettings {
  if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error("视频提示词设置必须是对象。");
  }
  const value = (raw ?? {}) as Partial<VideoPromptSettings>;
  const settings = {
    visualLook: value.visualLook === undefined ? DEFAULT_VIDEO_PROMPT_SETTINGS.visualLook : value.visualLook,
  };
  if (typeof settings.visualLook !== "string" || (settings.visualLook !== LOOK_NONE && !getLookPreset(settings.visualLook))) {
    throw new Error("视频的视觉风格设置无效。");
  }
  return settings;
}

export interface ShotVideoPromptInput {
  shot?: Partial<Pick<Shot, "type" | "camera" | "description" | "visualIntent" | "visualSource" | "characterId" | "voiceover" | "narration" | "tidewe" | "duration">>;
  ordinal: number;
  settings?: Partial<VideoPromptSettings>;
  creativeIntent?: unknown;
  visualBible?: unknown;
  /** Project-level creative profile, frozen by the caller when available. */
  creativeProfile?: unknown;
  /** On-camera visuals may receive their narration later when the model has no audio. */
  audioMode?: "native" | "post";
  /** Prepared English shot direction; source-language script stays unchanged. */
  tideweVideoDirection?: TideweVideoDirection;
  chainToNext?: boolean;
  locale?: "zh" | "en";
}

const PRODUCT_SHOT_TYPES = new Set(["product_reveal", "demo", "cta"]);

/** Shared visual direction for single-shot and full-film generation. Audio is added by the caller. */
export function buildShotVideoPrompt(input: ShotVideoPromptInput): { prompt: string; negativePrompt: string } {
  const shot = input.shot;
  if (isTideweOutdoorProfile(input.creativeProfile)) return compileTideweVisualPrompt(shot ?? {}, "video", input.creativeProfile.speechMode, input.creativeProfile.presenter, input.audioMode, { direction: input.tideweVideoDirection });
  const settings = normalizeVideoPromptSettings(input.settings);
  const look = getLookPreset(settings.visualLook);
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
    look: look?.motion,
    opener: look?.opener,
    audioMode: "none",
  });
  const intent = sanitizeCreativeIntent(input.creativeIntent);
  const bible = sanitizeVisualBible(input.visualBible);
  const direction = compileCreativePrompt({
    ...intent,
    continuity: [...(intent.continuity ?? []), ...bible.characterAnchors, ...bible.wardrobeAnchors, ...bible.environmentAnchors, ...bible.lightingAnchors],
    productConstraints: [...(intent.productConstraints ?? []), ...bible.productAnchors],
  }, locale);
  return {
    prompt: joinVideoPromptParts([motion, ...(direction.prompt ? [`${locale === "zh" ? "项目方向：" : "Project direction: "}${direction.prompt}`] : [])], locale, "\n"),
    negativePrompt: direction.negativePrompt,
  };
}
