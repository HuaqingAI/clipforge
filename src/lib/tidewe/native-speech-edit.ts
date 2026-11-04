import type { EnglishAlignedJob } from "@/lib/english-alignment";
import { TIDEWE_PACING, englishWordCount } from "./pacing";

/** A source-relative edit derived only from acoustic word timings. */
export interface NativeSpeechEdit {
  startSec: number;
  endSec: number;
  speed: number;
  /** Only a visible speaking mouth needs the same retiming as the audio. */
  syncVideo: boolean;
  /** Micro fades are limited to the measured context outside the first/last words. */
  fadeInSec?: number;
  fadeOutSec?: number;
}

export interface NativeSpeechSource {
  shotId: number;
  text: string;
  sourceDuration: number;
  words: EnglishAlignedJob["words"];
  onCamera: boolean;
}

export interface NativeSpeechPlan {
  shotId: number;
  edit: NativeSpeechEdit;
  duration: number;
  words: EnglishAlignedJob["words"];
  sourceSpeechWpm: number;
  correctedSpeechWpm: number;
  correctionLimited: boolean;
}

/** Concat audio and video must advance by identical whole 30fps frames. */
export function nativeSpeechSlotDuration(edit: NativeSpeechEdit): number {
  return Math.ceil(((edit.endSec - edit.startSec) / edit.speed) * 30 - 1e-8) / 30;
}

/** Never infer a trim window from text length or an empty/partial alignment. */
function checkedSource(source: NativeSpeechSource) {
  const tokens = source.text.trim().split(/\s+/);
  const words = source.words;
  if (!Number.isFinite(source.sourceDuration) || source.sourceDuration <= 0 || !tokens.length
    || !words.length || words.length !== tokens.length) throw new Error(`镜头 ${source.shotId} 缺少完整词时间戳，未裁切口播。`);
  words.forEach((word, index) => {
    if (word.text !== tokens[index] || !Number.isFinite(word.startSec) || !Number.isFinite(word.endSec)
      || word.startSec < 0 || word.endSec <= word.startSec || word.endSec > source.sourceDuration + 0.001
      || (index > 0 && word.startSec < words[index - 1].endSec - 0.001)
      || (word.score !== undefined && (!Number.isFinite(word.score) || word.score < 0.1))) {
      throw new Error(`镜头 ${source.shotId} 的词对齐边界或置信度不足，未裁切口播，请核对/重生成该镜头。`);
    }
  });
  const scores = words.flatMap(word => word.score === undefined ? [] : [word.score]);
  if (scores.length && scores.reduce((sum, score) => sum + score, 0) / scores.length < 0.5) {
    throw new Error(`镜头 ${source.shotId} 词对齐置信度不足，未裁切口播，请核对/重生成该镜头。`);
  }
  const first = words[0].startSec;
  const last = words.at(-1)!.endSec;
  if (!englishWordCount(source.text)) throw new Error(`镜头 ${source.shotId} 没有可统计的英文口播，未裁切口播。`);
  return { source, first, last, span: last - first, count: englishWordCount(source.text) };
}

/**
 * Allocate only existing source silence. Never stretch fast CTA speech or add
 * a frozen tail to manufacture the target WPM. Outliers remain reportable.
 */
export function planNativeSpeechEdits(sources: readonly NativeSpeechSource[]): NativeSpeechPlan[] {
  if (!sources.length) return [];
  const checked = sources.map(checkedSource);
  const targetDuration = checked.reduce((sum, item) => sum + item.count, 0) * 60 / TIDEWE_PACING.targetFinalWpm;
  const candidate = (speechWpm: number) => checked.map((item, index) => {
    const sourceSpeechWpm = item.count * 60 / item.span;
    const speed = item.count <= 4 || item.span <= 1.2 ? 1
      : Math.max(TIDEWE_PACING.minCorrectionSpeed, Math.min(TIDEWE_PACING.maxCorrectionSpeed, speechWpm / sourceSpeechWpm));
    const head = Math.min(TIDEWE_PACING.headSec, item.first / speed);
    const tail = Math.min(index === checked.length - 1 ? TIDEWE_PACING.finalTailSec : TIDEWE_PACING.tailSec,
      (item.source.sourceDuration - item.last) / speed);
    // Preserve a little acoustic context even when an outlier cannot meet the budget.
    const minHead = Math.min(head, 0.04 / speed);
    const minTail = Math.min(tail, 0.06 / speed);
    return { ...item, sourceSpeechWpm, speed, head, tail, minHead, minTail, speechDuration: item.span / speed };
  });
  const bounds = (items: ReturnType<typeof candidate>) => ({
    minimum: items.reduce((sum, item) => sum + item.speechDuration + item.minHead + item.minTail, 0),
    maximum: items.reduce((sum, item) => sum + item.speechDuration + item.head + item.tail, 0),
  });
  let items = candidate(TIDEWE_PACING.speechWpm);
  let range = bounds(items);
  if (targetDuration > range.maximum || targetDuration < range.minimum) {
    // Adjust the intended speaking rate only inside the agreed natural range.
    let low: number = TIDEWE_PACING.minSpeechWpm;
    let high: number = TIDEWE_PACING.maxSpeechWpm;
    for (let attempt = 0; attempt < 20; attempt++) {
      const next = candidate((low + high) / 2);
      const nextRange = bounds(next);
      items = next; range = nextRange;
      if (targetDuration < range.minimum) low = (low + high) / 2;
      else if (targetDuration > range.maximum) high = (low + high) / 2;
      else break;
    }
  }
  const paddingFraction = range.maximum > range.minimum
    ? Math.min(1, Math.max(0, (targetDuration - range.minimum) / (range.maximum - range.minimum))) : 0;
  return items.map(item => {
    const head = item.minHead + (item.head - item.minHead) * paddingFraction;
    const tail = item.minTail + (item.tail - item.minTail) * paddingFraction;
    const edit = { startSec: Math.max(0, item.first - head * item.speed),
      endSec: Math.min(item.source.sourceDuration, item.last + tail * item.speed),
      speed: item.speed, syncVideo: item.source.onCamera,
      fadeInSec: Math.min(0.005, head / 2), fadeOutSec: Math.min(0.005, tail / 2) };
    // At most one frame of decoder tail is padded; speech and mapped words are untouched.
    const duration = nativeSpeechSlotDuration(edit);
    return { shotId: item.source.shotId, edit, duration,
      words: item.source.words.map(word => ({ ...word, startSec: (word.startSec - edit.startSec) / edit.speed,
        endSec: (word.endSec - edit.startSec) / edit.speed })),
      sourceSpeechWpm: item.sourceSpeechWpm, correctedSpeechWpm: item.sourceSpeechWpm * item.speed,
      correctionLimited: item.sourceSpeechWpm * item.speed < TIDEWE_PACING.minSpeechWpm && item.count > 4 && item.span > 1.2 };
  });
}

export function nativeSpeechPacingReport(plans: readonly NativeSpeechPlan[], wordCount: number, actualDurationSec: number) {
  if (!Number.isFinite(actualDurationSec) || actualDurationSec <= 0) throw new Error("无法测得成片时长，未生成语速验收报告。");
  const averageWpm = wordCount * 60 / actualDurationSec;
  return { version: TIDEWE_PACING.version, targetFinalWpm: TIDEWE_PACING.targetFinalWpm,
    acceptableFinalWpm: [TIDEWE_PACING.minFinalWpm, TIDEWE_PACING.maxFinalWpm],
    wordCount, actualDurationSec, averageWpm,
    status: averageWpm >= TIDEWE_PACING.minFinalWpm && averageWpm <= TIDEWE_PACING.maxFinalWpm ? "within_target" : "outside_target",
    timingMethod: "source-forced-alignment-remapped",
    contentVerification: "not_performed",
    note: "词级强制对齐用于定位和保留提供的台词边界，不证明原音频实际说全、说对了文案。",
    shots: plans.map(plan => ({ shotId: plan.shotId, ...plan.edit, outputDurationSec: plan.duration,
      sourceSpeechWpm: plan.sourceSpeechWpm, correctedSpeechWpm: plan.correctedSpeechWpm, correctionLimited: plan.correctionLimited })) };
}
