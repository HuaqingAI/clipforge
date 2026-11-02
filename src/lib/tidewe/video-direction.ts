import type { Shot } from "@/lib/db/schema";

export interface TideweVideoDirection {
  start?: string;
  action: string;
  end?: string;
  camera?: string;
  focus?: string;
  motionType?: "continuous" | "bounded" | "observation";
  timing?: string;
  /** Seconds from the beginning of this shot, independent of narration. */
  actionWindow?: [number, number];
}

export type TideweVideoShot = Partial<Pick<Shot, "description" | "visualIntent" | "camera" | "tidewe" | "voiceover" | "duration">>;

export const TIDEWE_VIDEO_DIRECTION_VERSION = "tidewe-video-direction-2";

const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
// Keep camera rendering and audio in the final template. Ordinary light/sky/product descriptions remain valid.
const TEMPLATE_INSTRUCTION = /\b(?:cinematic|filmic|hdr|beauty retouch(?:ing)?|(?:auxiliary|studio|fill|rim) light(?:ing)?|(?:camera|photographic) flash|(?:use|add|no) (?:a )?flash|(?:added|image|digital|extra|excessive|restrained|no) sharpening|sharpen(?:ed)? (?:the )?(?:image|footage|fabric|edges|detail)|sharpening (?:filter|treatment|effect)|(?:global|portrait|artificial|cinematic) blur|bokeh|film grain|colou?r grad(?:e|ing)|music|voice[- ]?over|narrat(?:ion|or|e)|dialogue|spoken|lip[- ]?(?:sync|synchronization)|speaks?|speaking|says?|saying|audio track|sound effects?)\b/i;

/** Every editable visual input participates in the server's content-addressed cache key. */
export function getTideweVideoDirectionSource(shot: TideweVideoShot) {
  const plan = shot.tidewe?.visualPlan;
  return {
    duration: typeof shot.duration === "number" && Number.isFinite(shot.duration) && shot.duration > 0 ? shot.duration : null,
    description: text(shot.description),
    visualIntent: text(shot.visualIntent),
    camera: text(shot.camera),
    shotGoal: text(shot.tidewe?.shotGoal),
    visualPlan: plan ? {
      framing: text(plan.framing),
      visualRole: text(plan.visualRole),
      productFocus: text(plan.productFocus),
      actionStart: text(plan.actionStart),
      action: text(plan.action),
      actionEnd: text(plan.actionEnd),
    } : null,
  };
}

/** Script detection is deliberately conservative: foreign-language prose needs preparation. */
export function isEnglishVideoDirectionText(value: string): boolean {
  if (!value.trim() || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) return false;
  const letters = value.match(/\p{L}/gu);
  return Boolean(letters?.length) && letters!.every((letter) => /\p{Script=Latin}/u.test(letter));
}

export function normalizeTideweVideoDirection(raw: unknown, duration?: number): TideweVideoDirection | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const direction: TideweVideoDirection = { action: text(input.action) };
  for (const key of ["start", "end", "camera", "focus", "timing"] as const) {
    if (input[key] !== undefined && typeof input[key] !== "string") return null;
    const value = text(input[key]);
    if (value) direction[key] = value;
  }
  if (input.motionType !== undefined) {
    if (!["continuous", "bounded", "observation"].includes(input.motionType as string)) return null;
    direction.motionType = input.motionType as TideweVideoDirection["motionType"];
  }
  if (input.actionWindow !== undefined) {
    const window = input.actionWindow;
    if (!Array.isArray(window) || window.length !== 2 || window.some((value) => typeof value !== "number" || !Number.isFinite(value))
      || window[0] < 0 || window[1] <= window[0] || (typeof duration === "number" && Number.isFinite(duration) && duration > 0 && window[1] > duration)) return null;
    direction.actionWindow = [window[0], window[1]];
  }
  const limits = { start: 320, action: 600, end: 320, camera: 320, focus: 240, timing: 360, motionType: 20 };
  if (Object.entries(direction).some(([key, value]) => key !== "actionWindow" && (!isEnglishVideoDirectionText(value as string) || TEMPLATE_INSTRUCTION.test(value as string) || (value as string).length > limits[key as keyof typeof limits]))) return null;
  if (Object.values(direction).join(" ").length > 1_960) return null;
  return direction;
}

const equivalent = (value: string) => value.toLowerCase().replace(/[\s.,;:!?]+/g, " ").trim();
/** Already-English, unambiguous fields need no model call. Do not discard extra manual context. */
export function directEnglishVideoDirection(shot: TideweVideoShot): TideweVideoDirection | null {
  const source = getTideweVideoDirectionSource(shot);
  // A real clip needs a duration-aware cadence/window prepared by the text model.
  // Being written in English alone does not make an action temporally compatible.
  if (source.duration !== null) return null;
  const values = [source.description, source.visualIntent, source.camera, source.shotGoal, ...Object.values(source.visualPlan ?? {})].filter(Boolean);
  if (values.some((value) => !isEnglishVideoDirectionText(value) || TEMPLATE_INSTRUCTION.test(value))) return null;
  const plan = source.visualPlan;
  if (plan?.action) {
    const known = new Set([plan.actionStart, plan.action, plan.actionEnd, plan.productFocus, source.camera].filter(Boolean).map(equivalent));
    if ([source.description, source.visualIntent, source.shotGoal].some((value) => value && !known.has(equivalent(value)))) return null;
    return normalizeTideweVideoDirection({ start: plan.actionStart, action: plan.action, end: plan.actionEnd, camera: source.camera, focus: plan.productFocus });
  }
  const action = source.description || source.visualIntent || source.shotGoal;
  if ([source.description, source.visualIntent, source.shotGoal].some((value) => value && equivalent(value) !== equivalent(action))) return null;
  return normalizeTideweVideoDirection({ action, camera: source.camera });
}
