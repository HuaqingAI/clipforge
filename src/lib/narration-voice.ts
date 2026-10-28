import { isTideweOutdoorProfile } from "@/lib/creative-profiles";
import { DEFAULT_FREE_VOICE, FREE_TTS_VOICES } from "@/lib/tts-voices";

export const TIDEWE_DEFAULT_VOICE = "en-US-GuyNeural";

/** Client-safe choices shared by TIDEWE controls, previews and composition. */
export const TIDEWE_TTS_VOICES = FREE_TTS_VOICES
  .filter((voice) => voice.lang === "en-US")
  .map((voice) => ({ ...voice, labelZh: voice.labelZh ?? voice.label }));

/** Resolve Edge narration consistently in the UI, pipeline and both composers. */
export function resolveNarrationVoice(profile: unknown, explicitVoice?: string | null): string {
  const voice = explicitVoice?.trim();
  if (!isTideweOutdoorProfile(profile)) return voice || DEFAULT_FREE_VOICE;
  if (!voice) return TIDEWE_DEFAULT_VOICE;
  const language = FREE_TTS_VOICES.find((item) => item.value === voice)?.lang;
  if (!(language?.startsWith("en-") || /^en-[A-Z]{2}-[A-Za-z]+Neural$/.test(voice))) {
    throw new Error("TIDEWE 英文旁白请选择英语音色。");
  }
  return voice;
}
