import {
  isPremiumProductCgProfile,
  type ProjectCreativeProfile,
} from "@/lib/creative-profiles";

export type CreativePolicyLintField = "description" | "visualIntent" | "prompt" | "camera" | "textOverlay" | "voiceover" | "narration";

export interface CreativePolicyLintIssue {
  code: "generated_text" | "marketing_visual" | "text_overlay" | "promotional_voiceover";
  field: CreativePolicyLintField;
  shotId?: number;
  message: string;
}

export interface CreativePolicyShot {
  shotId?: unknown;
  description?: unknown;
  visualIntent?: unknown;
  prompt?: unknown;
  camera?: unknown;
  textOverlay?: unknown;
  voiceover?: unknown;
  narration?: unknown;
}

const VISUAL_TEXT_TERMS = /(?:\b(?:text|caption|subtitle|headline|title\s*card|on[- ]screen\s+text|overlay|label|watermark)\b|文字|文案|字幕|标题(?:卡)?|标记|标签|价格(?:牌|卡)?|数字标签|水印)/gi;
const VISUAL_MARKETING_TERMS = /(?:\b(?:cta|call\s+to\s+action|buy\s+now|shop\s+now|add\s+to\s+cart|limited\s+time|sale|discount|promo(?:tion)?)\b|下单|购买|抢购|小黄车|限时|优惠|折扣|促销|扫码)/gi;
const PROMOTIONAL_VOICEOVER_TERMS = /(?:\b(?:buy\s+now|shop\s+now|add\s+to\s+cart|limited\s+time|sale|discount|best\s+ever|must[- ]have|link\s+in\s+bio|click\s+(?:the\s+)?link)\b|下单|购买|抢购|小黄车|限时|最后\s*\d*\s*件|优惠|折扣|特价|全网(?:第[一1]|最好)|闭眼入|冲(?:啊|呀|吧)?|链接(?:在|放|点)|立刻|马上|千万别|家人们|姐妹们)/gi;

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isNegated(text: string, start: number): boolean {
  const before = text.slice(Math.max(0, start - 28), start).toLowerCase();
  return /(?:\bno\s+|\bwithout\s+|\bavoid\s+|\bforbid(?:den)?\s+|\bnever\s+|\bdo\s+not\s+|\bdon't\s+|禁止|不得|不要|无|不加|不出现)/.test(before);
}

function containsPositiveMatch(text: string, pattern: RegExp): boolean {
  const matcher = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text))) {
    if (!isNegated(text, match.index)) return true;
  }
  return false;
}

function shotIdOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Reports CG-only policy violations. It intentionally leaves legacy sales shots untouched so the
 * existing commerce pipeline can retain captions, overlays, and conversion language.
 */
export function lintCreativeProfileShot(
  profile: ProjectCreativeProfile | unknown,
  shot: CreativePolicyShot,
): CreativePolicyLintIssue[] {
  if (!isPremiumProductCgProfile(profile)) return [];

  const shotId = shotIdOf(shot.shotId);
  const issues: CreativePolicyLintIssue[] = [];
  const visualFields: Array<["description" | "visualIntent" | "prompt" | "camera", unknown]> = [
    ["description", shot.description],
    ["visualIntent", shot.visualIntent],
    ["prompt", shot.prompt],
    ["camera", shot.camera],
  ];

  for (const [field, value] of visualFields) {
    const text = stringValue(value);
    if (!text) continue;
    if (containsPositiveMatch(text, VISUAL_TEXT_TERMS)) {
      issues.push({
        code: "generated_text",
        field,
        shotId,
        message: "Premium product CG frames cannot request generated text, captions, labels, prices, or watermarks.",
      });
    }
    if (containsPositiveMatch(text, VISUAL_MARKETING_TERMS)) {
      issues.push({
        code: "marketing_visual",
        field,
        shotId,
        message: "Premium product CG frames cannot request promotional graphics or purchase calls to action.",
      });
    }
  }

  if (shot.textOverlay !== undefined && shot.textOverlay !== null) {
    const overlay = shot.textOverlay;
    const hasOverlay = typeof overlay !== "object"
      || Object.keys(overlay as Record<string, unknown>).length > 0;
    if (hasOverlay) {
      issues.push({
        code: "text_overlay",
        field: "textOverlay",
        shotId,
        message: "Premium product CG does not allow textOverlay; use an approved deterministic end card outside generated footage.",
      });
    }
  }

  const narrationFields: Array<["voiceover" | "narration", unknown]> = [
    ["voiceover", shot.voiceover],
    ["narration", shot.narration],
  ];
  for (const [field, value] of narrationFields) {
    const narration = stringValue(value);
    if (!narration) continue;
    if (profile.narrationMode === "none") {
      issues.push({
        code: "promotional_voiceover",
        field,
        shotId,
        message: "Premium product CG with narrationMode=none cannot contain voiceover or narration.",
      });
      continue;
    }
    if (containsPositiveMatch(narration, PROMOTIONAL_VOICEOVER_TERMS) || containsPositiveMatch(narration, VISUAL_TEXT_TERMS)) {
      issues.push({
        code: "promotional_voiceover",
        field,
        shotId,
        message: "Premium product CG narration must be restrained factual narration, without promotion or directions to render text.",
      });
    }
  }
  return issues;
}

export function lintCreativeProfileShots(
  profile: ProjectCreativeProfile | unknown,
  shots: readonly CreativePolicyShot[],
): CreativePolicyLintIssue[] {
  return shots.flatMap((shot) => lintCreativeProfileShot(profile, shot));
}
