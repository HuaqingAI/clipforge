/** The fixed, audio-aligned caption treatment approved in the Komika Axis preview. */
export const ALIGNED_CAPTION_FONT_NAME = "Komika Axis";
export const ALIGNED_CAPTION_FONT_RELATIVE_PATH = "public/fonts/komika-axis/KOMIKAX_.ttf";

export interface AlignedCaptionWord {
  text: string;
  /** Absolute seconds on the composed video timeline, obtained from the audio. */
  startSec: number;
  endSec: number;
}

export interface AlignedCaptionLine {
  startTime: number;
  endTime: number;
  /** When supplied, verifies that alignment has preserved every original word. */
  text?: string;
  words: readonly AlignedCaptionWord[];
}

export interface AlignedCaptionOptions {
  playResX?: number;
  playResY?: number;
  title?: string;
  totalDurationSec?: number;
}

const WHITE = "&HFFFFFF&";
const YELLOW = "&H0DF9FA&";
const PAUSE_SEC = 0.4;

// Komika Axis 2.0 advances at 1000px, divided by its 1635px ascender/descender
// span to match libass font sizing. This keeps layout deterministic without a
// browser canvas or loading fonts in the renderer. Unknown glyphs use a wide M.
const ADVANCES: Record<string, number> = {
  " ": 361, "!": 400, '"': 561, "#": 717, "$": 553, "%": 889, "&": 778,
  "'": 318, "(": 364, ")": 406, "*": 712, "+": 732, ",": 313, "-": 592,
  ".": 331, "/": 531, "0": 685, "1": 387, "2": 619, "3": 649, "4": 711,
  "5": 589, "6": 612, "7": 643, "8": 654, "9": 609, ":": 369, ";": 390,
  "<": 522, "=": 654, ">": 555, "?": 679, "@": 892, A: 718, B: 694,
  C: 642, D: 733, E: 577, F: 570, G: 663, H: 678, I: 312, J: 627,
  K: 664, L: 532, M: 924, N: 702, O: 694, P: 708, Q: 693, R: 727,
  S: 601, T: 664, U: 676, V: 699, W: 961, X: 708, Y: 651, Z: 562,
  "[": 456, "\\": 537, "]": 477, "^": 670, _: 645, "`": 592, "{": 508,
  "|": 537, "}": 565, "~": 742,
};

function widthAtFontSize(text: string, size: number): number {
  const units = Array.from(text.toUpperCase()).reduce((sum, char) => sum + (ADVANCES[char] ?? 961), 0);
  // Allow for glyph overhang, outlines, shadow and rasterisation rounding.
  return (units + 240) / 1635 * size + 12;
}

function fittedSize(text: string, baseSize: number, maximumWidth: number): number {
  const estimate = widthAtFontSize(text, baseSize);
  return Number((estimate <= maximumWidth ? baseSize : baseSize * maximumWidth / estimate).toFixed(2));
}

function assText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}").replace(/\r?\n/g, " ");
}

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function timestamp(cs: number): string {
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs % 360000 / 6000)).padStart(2, "0")}:${String(Math.floor(cs % 6000 / 100)).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

interface DisplayWord extends AlignedCaptionWord {
  startCs: number;
}

interface Phrase {
  words: DisplayWord[];
  lineEndSec: number;
  finalInLine: boolean;
}

/** Partition a speech run into readable two/three-word phrases, avoiding orphan words. */
function partition(words: DisplayWord[]): DisplayWord[][] {
  const best = new Map<number, { cost: number; groups: DisplayWord[][] }>();
  best.set(words.length, { cost: 0, groups: [] });
  for (let start = words.length - 1; start >= 0; start--) {
    for (const count of [3, 2, 1]) {
      const rest = best.get(start + count);
      if (!rest) continue;
      const group = words.slice(start, start + count);
      const chars = group.map(word => word.text).join(" ").length;
      const orphanCost = count === 1 && words.length > 1 ? 40 : 0;
      const cost = rest.cost + Math.abs(chars - 14) + orphanCost + (chars > 24 ? (chars - 24) * 2 : 0);
      if (!best.has(start) || cost < best.get(start)!.cost) best.set(start, { cost, groups: [group, ...rest.groups] });
    }
  }
  return best.get(0)?.groups ?? [];
}

function phrasesForLine(words: DisplayWord[], lineEndSec: number): Phrase[] {
  const runs: DisplayWord[][] = [];
  let run: DisplayWord[] = [];
  words.forEach((word, index) => {
    run.push(word);
    const next = words[index + 1];
    if (!next || /[.!?,;:]$/.test(word.text) || next.startSec - word.endSec > PAUSE_SEC) {
      runs.push(run);
      run = [];
    }
  });
  const groups = runs.flatMap(partition);
  return groups.map((group, index) => ({ words: group, lineEndSec, finalInLine: index === groups.length - 1 }));
}

/**
 * Builds one ASS event per acoustically aligned word. The whole phrase stays
 * visible, and only the current word is yellow; earlier words return to white.
 * Missing timings are an error: this path never estimates or emits cumulative \k.
 */
export function buildAlignedCaptionsAss(
  lines: readonly AlignedCaptionLine[],
  options: AlignedCaptionOptions = {},
): string {
  const width = options.playResX ?? 1080;
  const height = options.playResY ?? 1920;
  if (![width, height].every(value => Number.isFinite(value) && value > 0)) throw new Error("Caption dimensions must be positive");
  const scale = Math.min(width / 1080, height / 1920);
  const bodySize = Number((90 * scale).toFixed(2));
  const titleSize = Number((72 * scale).toFixed(2));
  const margin = Math.round(60 * scale);
  const maximumWidth = width - margin * 2;
  const x = Number((width / 2).toFixed(2));
  const bodyY = Number((height * 1365 / 1920).toFixed(2));
  const titleY = Number((height * 178 / 1920).toFixed(2));
  const phrases: Phrase[] = [];
  let previousStart = -1;
  let previousStartCs = -1;
  for (const line of lines) {
    if (!Number.isFinite(line.startTime) || !Number.isFinite(line.endTime) || line.startTime < 0 || line.endTime <= line.startTime) {
      throw new Error("Aligned caption lines require a valid video timeline window");
    }
    if (!Array.isArray(line.words) || (!line.words.length && line.text?.trim())) {
      throw new Error("Real audio word timestamps are required for aligned captions");
    }
    if (line.text !== undefined && normalise(line.words.map(word => word.text).join(" ")) !== normalise(line.text)) {
      throw new Error("Aligned caption words do not preserve the original narration");
    }
    const words: DisplayWord[] = line.words.map(word => {
      if (!word.text?.trim() || !Number.isFinite(word.startSec) || !Number.isFinite(word.endSec)
        || word.startSec < 0 || word.endSec <= word.startSec || word.startSec < previousStart
        || word.startSec < line.startTime - 0.01 || word.startSec >= line.endTime) {
        throw new Error(`Invalid real audio timestamp for caption word: ${word.text}`);
      }
      // ASS has 10ms precision. Keep very short neighbouring words visible while
      // limiting any rounding/collision adjustment to one 30fps output frame.
      const startCs = Math.max(Math.round(word.startSec * 100), previousStartCs + 1);
      if (startCs / 100 - word.startSec > 1 / 30) throw new Error("Audio word timestamps are too dense for ASS caption precision");
      previousStart = word.startSec;
      previousStartCs = startCs;
      return { ...word, text: word.text.trim(), startCs };
    });
    phrases.push(...phrasesForLine(words, line.endTime));
  }
  const totalDuration = options.totalDurationSec ?? Math.max(0, ...lines.map(line => line.endTime));
  if (!Number.isFinite(totalDuration) || totalDuration < 0) throw new Error("Caption duration must be finite and nonnegative");
  const events: string[] = [];
  phrases.forEach((phrase, index) => {
    const next = phrases[index + 1];
    const nextStart = next?.words[0].startSec ?? totalDuration;
    const last = phrase.words[phrase.words.length - 1];
    const gap = nextStart - last.endSec;
    const release = phrase.finalInLine ? last.endSec + 0.14 : gap > PAUSE_SEC ? last.endSec + 0.12 : nextStart;
    const endCs = Math.min(Math.round(Math.min(release, phrase.lineEndSec, totalDuration) * 100), next?.words[0].startCs ?? Infinity);
    const text = phrase.words.map(word => word.text.toUpperCase()).join(" ");
    const size = fittedSize(text, bodySize, maximumWidth);
    const sizeOverride = size < bodySize ? `\\fs${size}` : "";
    phrase.words.forEach((word, wordIndex) => {
      const wordEndCs = phrase.words[wordIndex + 1]?.startCs ?? endCs;
      if (wordEndCs <= word.startCs) throw new Error(`Caption window ends before word can be displayed: ${word.text}`);
      const body = phrase.words.map((item, currentIndex) => `{\\1c${currentIndex === wordIndex ? YELLOW : WHITE}}${assText(item.text.toUpperCase())}`).join(" ");
      events.push(`Dialogue: 1,${timestamp(word.startCs)},${timestamp(wordEndCs)},Body,,0,0,0,,{\\an5\\pos(${x},${bodyY})${sizeOverride}}${body}`);
    });
  });
  const title = options.title?.replace(/\s+/g, " ").trim();
  if (title && totalDuration > 0) {
    const size = fittedSize(title, titleSize, maximumWidth);
    const sizeOverride = size < titleSize ? `\\fs${size}` : "";
    events.unshift(`Dialogue: 2,0:00:00.00,${timestamp(Math.round(totalDuration * 100))},Title,,0,0,0,,{\\an5\\pos(${x},${titleY})${sizeOverride}}${assText(title)}`);
  }
  return [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${width}`, `PlayResY: ${height}`,
    "WrapStyle: 2", "ScaledBorderAndShadow: yes", "", "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Body,${ALIGNED_CAPTION_FONT_NAME},${bodySize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,${4.5 * scale},${2 * scale},5,${margin},${margin},0,1`,
    `Style: Title,${ALIGNED_CAPTION_FONT_NAME},${titleSize},&H000DF9FA,&H000DF9FA,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,${4 * scale},${1.5 * scale},5,${margin},${margin},0,1`,
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events, "",
  ].join("\n");
}
