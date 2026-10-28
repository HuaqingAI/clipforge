/**
 * Free Edge TTS voice catalogue — CLIENT-SAFE module (no fs/network imports), so UI code and the
 * variation planner can list voices without dragging the server-only TTS pipeline (edge-tts →
 * tts-cache → fs/promises) into the browser bundle. edge-tts re-exports these for server callers.
 *
 * English additions are checked against Edge's public voice catalog. The synthesis service
 * already accepts any Edge voice name; this list makes supported choices discoverable.
 */
export interface FreeTtsVoice {
  value: string;
  label: string;
  labelZh?: string;
  gender: "female" | "male";
  lang: string;
}

export const FREE_TTS_VOICES: FreeTtsVoice[] = [
  // Chinese (default market)
  { value: "zh-CN-XiaoxiaoNeural", label: "晓晓 · 温柔女声", gender: "female", lang: "zh-CN" },
  { value: "zh-CN-XiaoyiNeural", label: "晓伊 · 活泼女声", gender: "female", lang: "zh-CN" },
  { value: "zh-CN-YunxiNeural", label: "云希 · 阳光男声", gender: "male", lang: "zh-CN" },
  { value: "zh-CN-YunyangNeural", label: "云扬 · 专业播报男声", gender: "male", lang: "zh-CN" },
  { value: "zh-CN-YunjianNeural", label: "云健 · 沉稳解说男声", gender: "male", lang: "zh-CN" },
  // English (primary overseas market)
  { value: "en-US-AriaNeural", label: "Aria · US English (female)", labelZh: "Aria · 美式英语女声", gender: "female", lang: "en-US" },
  { value: "en-US-GuyNeural", label: "Guy · US English (male)", labelZh: "Guy · 美式英语男声", gender: "male", lang: "en-US" },
  { value: "en-US-JennyNeural", label: "Jenny · US English (female)", labelZh: "Jenny · 美式英语女声", gender: "female", lang: "en-US" },
  { value: "en-US-ChristopherNeural", label: "Christopher · US English (male)", labelZh: "Christopher · 美式英语男声", gender: "male", lang: "en-US" },
  { value: "en-US-EricNeural", label: "Eric · US English (male)", labelZh: "Eric · 美式英语男声", gender: "male", lang: "en-US" },
  { value: "en-US-MichelleNeural", label: "Michelle · US English (female)", labelZh: "Michelle · 美式英语女声", gender: "female", lang: "en-US" },
  { value: "en-US-RogerNeural", label: "Roger · US English (male)", labelZh: "Roger · 美式英语男声", gender: "male", lang: "en-US" },
  { value: "en-US-SteffanNeural", label: "Steffan · US English (male)", labelZh: "Steffan · 美式英语男声", gender: "male", lang: "en-US" },
  { value: "en-GB-SoniaNeural", label: "Sonia · UK English (female)", gender: "female", lang: "en-GB" },
  // Japanese / Korean markets (bundled Noto CJK subtitle font public/fonts/subtitle.otf covers kana + hangul, so subtitles render correctly)
  { value: "ja-JP-NanamiNeural", label: "Nanami · 日本語 (female)", gender: "female", lang: "ja-JP" },
  { value: "ko-KR-SunHiNeural", label: "SunHi · 한국어 (female)", gender: "female", lang: "ko-KR" },
  // Spanish market (Latin glyphs are covered by the CJK font)
  { value: "es-ES-ElviraNeural", label: "Elvira · Español (female)", gender: "female", lang: "es-ES" },
];

export const DEFAULT_FREE_VOICE = "zh-CN-XiaoxiaoNeural";

/** Match SSML language to the chosen voice, including valid names outside the curated list. */
export function ttsVoiceLocale(voice: string): string {
  return FREE_TTS_VOICES.find((item) => item.value === voice)?.lang
    ?? /^([A-Za-z]{2,3}-[A-Z]{2})-/.exec(voice)?.[1]
    ?? "zh-CN";
}

const FREE_TTS_PREVIEW_TEXT: Record<string, string> = {
  zh: "你好！欢迎了解这款产品，让每一天更轻松、更精彩。",
  en: "Hello! Discover a product that makes every day easier and more enjoyable.",
  ja: "こんにちは！毎日の暮らしをもっと便利に、もっと楽しくする商品をご紹介します。",
  ko: "안녕하세요! 매일의 생활을 더 편리하고 즐겁게 만드는 제품을 소개합니다.",
  es: "¡Hola! Descubre un producto que hace tu día a día más fácil y agradable.",
};

/** Monolingual Edge voices need a sample in their own language, independently of UI locale. */
export function ttsVoicePreviewText(voice: string): string {
  return FREE_TTS_PREVIEW_TEXT[ttsVoiceLocale(voice).split("-")[0].toLowerCase()]
    ?? FREE_TTS_PREVIEW_TEXT.en;
}
