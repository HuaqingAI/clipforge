import type { TideweOutdoorProfile } from "@/lib/creative-profiles";
import type { TidewePresenterSnapshot } from "./types";
import { directEnglishVideoDirection, normalizeTideweVideoDirection, type TideweVideoDirection, type TideweVideoShot } from "./video-direction";
import { englishWordCount, TIDEWE_PACING } from "./pacing";

export const TIDEWE_VIDEO_PROMPT_VERSION = "tidewe-video-en-v4";

/** Video owns a short English style block; stills keep their separate capture policy. */
export const TIDEWE_VIDEO_STYLE = "Image character: casual iPhone 8 native-camera footage using only existing natural ambient light. Preserve the first frame's environmental colors, real shadows, everyday exposure and material detail. No auxiliary or fill light, flash, reflectors, rim light, HDR, beauty retouching, sharpening, cinematic grading, artificial noise, global blur or artificial depth of field.";

const BASE_NEGATIVE = "cuts, slow motion, looped replay of a completed demonstration, identity drift, warped anatomy, floating contact, product morphing, invented parts or effects, added text, captions, watermarks, artificial bokeh, cutout edges";

const MOTION_TIMING = {
  continuous: "Maintain the directed continuous activity with natural cyclic movement. Follow the established route, distance and ending without an unplanned stop.",
  bounded: "Complete the specified operation or short sequence at its directed cadence, then maintain the supported end state naturally. Do not prolong the operation to fill spare time.",
  observation: "Maintain the observed state with only the directed natural motion; do not add a demonstration.",
} as const;

function english(value: string): boolean {
  return !/[^\p{Script=Latin}\p{N}\p{P}\p{S}\p{Z}\s]/u.test(value);
}

/** The spoken window follows the words, even when a model rounds its clip up. */
function deliveryTiming(line: string, duration?: number): string {
  const finish = TIDEWE_PACING.headSec + englishWordCount(line) * 60 / TIDEWE_PACING.speechWpm;
  const required = finish + TIDEWE_PACING.tailSec;
  const cadence = `Delivery: brisk, fluent US English at about ${TIDEWE_PACING.speechWpm} words per minute (${TIDEWE_PACING.minSpeechWpm}-${TIDEWE_PACING.maxSpeechWpm}), with natural keyword emphasis and only short breath pauses. Start within ${TIDEWE_PACING.headSec} seconds.`;
  // Historical/manual shots can have a budget too short for their frozen copy.
  // Describe the needed extension instead of requesting an impossible deadline
  // or inviting the model to cut words or rush them to fit.
  const window = typeof duration === "number" && Number.isFinite(duration) && duration > 0 && duration + 0.001 < required
    ? `The planned ${duration} seconds is too short: this exact line needs at least ${required.toFixed(2)} seconds at this cadence. Preserve the complete line; extend its timing budget rather than omit words, truncate the sentence or force a faster delivery.`
    : `Finish the entire line by ${finish.toFixed(2)} seconds from the clip start, retaining about ${TIDEWE_PACING.tailSec} seconds of tail clearance.`;
  return `${cadence} ${window} Do not slow the line or add pauses to fill a longer generated clip. Speech cadence does not speed up the approved physical actions.`;
}

/** A single compact shot: approved state, action, restrained camera, continuity, style, audio. */
export function compileTideweVideoPrompt(
  shot: TideweVideoShot,
  speechMode: TideweOutdoorProfile["speechMode"] = "voiceover",
  _presenter?: TidewePresenterSnapshot | null,
  audioMode: "native" | "post" = "native",
  translatedDirection?: TideweVideoDirection,
): { prompt: string; negativePrompt: string } {
  const interactionVisible = shot.tidewe?.personVisible !== false && shot.tidewe?.productVisible !== false && Boolean(shot.tidewe?.visualPlan?.interaction);
  const direction = translatedDirection ? normalizeTideweVideoDirection(interactionVisible ? translatedDirection : { ...translatedDirection, interaction: undefined }, shot.duration) : directEnglishVideoDirection(shot);
  if (!direction || (interactionVisible && shot.tidewe?.visualPlan?.interaction && !direction.interaction)) {
    throw new Error("TIDEWE video direction must be prepared in English before preview or generation.");
  }
  const line = shot.voiceover?.trim() ?? "";
  const narrated = speechMode === "on_camera" && Boolean(line);
  const visibleSpeech = narrated && shot.tidewe?.speechDelivery !== "off_camera";
  if (narrated && !english(line)) {
    throw new Error("TIDEWE spoken copy must be English; keep the approved English line unchanged.");
  }
  const personVisible = visibleSpeech || shot.tidewe?.personVisible !== false;
  const productVisible = shot.tidewe?.productVisible !== false;
  const timing = direction.timing || (direction.motionType ? MOTION_TIMING[direction.motionType] : "Observational shots stay observational.");
  const actionWindow = direction.actionWindow ? `Action window: ${direction.actionWindow[0]}-${direction.actionWindow[1]} seconds within this clip. ` : "";

  let audio: string;
  if (visibleSpeech) {
    audio = audioMode === "native"
      ? "Audio: the visible presenter says the exact US English line below once, with synchronized lips and the same natural voice and accent across shots. Keep the mouth visible within the approved framing. Keep natural location sounds underneath; no music, extra dialogue or other voices."
      : "Audio: no audio track. The visible presenter silently articulates the exact US English line below once, with natural lip timing for later dubbing. Keep the mouth visible within the approved framing. No music. No dialogue. No sound effects.";
  } else if (narrated && audioMode === "native") {
    audio = "Audio: the same presenter delivers the exact US English line below once as off-camera narration, keeping a consistent voice and accent. Any visible person works silently with no speaking or lip synchronization; do not add a face or change the framing. Natural location sounds only underneath; no music or extra dialogue.";
  } else if (speechMode === "on_camera" && audioMode === "native") {
    audio = "Audio: natural location and object sounds only. No invented dialogue, visible speaking or lip synchronization. No music.";
  } else {
    audio = "Audio: silent footage for narration added in post; no audio track, visible speaking or lip synchronization. Preserve the approved framing without adding a face. No music or sound effects.";
  }
  if (visibleSpeech || (narrated && audioMode === "native")) {
    audio += ` ${deliveryTiming(line, shot.duration)}`;
    if (/\bTIDEWE\b/i.test(line)) audio += " Pronounce TIDEWE as Tide-Wee.";
    audio += `\nExact line: ${JSON.stringify(line)}`;
  }

  return {
    prompt: [
      "Continue the approved first frame in one unbroken real-time shot.",
      direction.start?.trim() ? `Start: ${direction.start.trim()}` : "",
      `Action: ${direction.action.trim()}`,
      direction.interaction ? `Interaction purpose: ${direction.interaction.purpose}\nContact and force: ${direction.interaction.contact}\nVisible response: ${direction.interaction.response}\nPlanned continuation: ${direction.interaction.continuation}` : "",
      direction.end?.trim() ? `End: ${direction.end.trim()}` : "",
      `Camera: ${direction.camera?.trim() || "hold the approved framing with subtle natural handheld drift."}`,
      productVisible && direction.focus?.trim() ? `Keep visible: ${direction.focus.trim()}` : "",
      `Timing: ${actionWindow}${timing}`,
      "Use natural real-time movement at the directed cadence; otherwise use an ordinary everyday pace. Physical actions follow their own rhythm independently of narration length. Do not stretch a gesture or footstep to fill the clip. Keep camera movement restrained and purposeful.",
      `Physical response: ${shot.tidewe?.personVisible !== false ? "align approved grips and weight transfer with their actual supports; " : "retain existing support contacts; "}flexible materials respond only to directed force. Rigid parts keep their shape. Follow the approved action and ending; add no task or idle gesture.`,
      `Continuity: preserve ${personVisible ? "the presenter's identity and clothing, " : ""}${productVisible ? "product shape, colors, markings and connected parts, " : ""}the setting, weather and physical contacts. Do not invent components or performance effects.`,
      !personVisible ? "No people, faces or hands." : "",
      !productVisible ? "Keep this shot free of products and brand marks." : "",
      "No added text or graphics; preserve existing product markings.",
      TIDEWE_VIDEO_STYLE,
      audio,
    ].filter(Boolean).join("\n"),
    negativePrompt: `${BASE_NEGATIVE}, ${visibleSpeech ? "closed mouth during speech, lip-sync mismatch, obscured mouth" : "visible speaking, lip synchronization"}, extra dialogue, music`,
  };
}
