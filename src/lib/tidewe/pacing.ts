/** Shared estimates for TIDEWE English copy, storyboard timing and native speech.
 * Final WPM includes every pause; delivery WPM describes a continuous spoken phrase.
 * These are planning targets, never a claim that generated audio has been measured.
 * Keep this module browser-safe: video previews use the same policy as the server.
 */
export const TIDEWE_PACING_VERSION = "tidewe-195-v1" as const;

export const TIDEWE_PACING = {
  version: TIDEWE_PACING_VERSION,
  targetFinalWpm: 195,
  minFinalWpm: 190,
  maxFinalWpm: 200,
  speechWpm: 215,
  minSpeechWpm: 210,
  maxSpeechWpm: 220,
  headSec: 0.15,
  tailSec: 0.15,
  finalTailSec: 0.25,
  minCorrectionSpeed: 1,
  maxCorrectionSpeed: 1.5,
} as const;

/** Contractions, hyphenated terms and written numeric tokens each count once. */
export function englishWordCount(text: string): number {
  return text.match(/[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*/g)?.length ?? 0;
}

function nonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and nonnegative`);
}

/** Includes the whole film's pause budget; callers must not add per-shot padding again. */
export function estimateTideweDuration(wordCount: number): number {
  nonnegative(wordCount, "Word count");
  return Math.round(wordCount * 60 / TIDEWE_PACING.targetFinalWpm * 10) / 10;
}

export function getTideweWordBudget(durationSec: number): { target: number; min: number; max: number } {
  nonnegative(durationSec, "Duration");
  return {
    target: Math.round(durationSec * TIDEWE_PACING.targetFinalWpm / 60),
    min: Math.ceil(durationSec * TIDEWE_PACING.minFinalWpm / 60),
    max: Math.floor(durationSec * TIDEWE_PACING.maxFinalWpm / 60),
  };
}

/** Generation slots can exceed the eventual edit; never squeeze speech into a short slot. */
export function getTideweGenerationDuration(plannedDurationSec: number, wordCount: number): number {
  nonnegative(plannedDurationSec, "Planned duration");
  nonnegative(wordCount, "Word count");
  const speechBudget = wordCount > 0
    ? TIDEWE_PACING.headSec + wordCount * 60 / TIDEWE_PACING.speechWpm + TIDEWE_PACING.tailSec
    : 0;
  return Math.ceil(Math.max(4, plannedDurationSec, speechBudget));
}
