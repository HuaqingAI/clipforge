import { describe, expect, it } from "vitest";
import { FREE_TTS_VOICES, ttsVoicePreviewText } from "@/lib/tts-voices";

describe("Microsoft preview text", () => {
  const languagePatterns: Record<string, RegExp> = {
    zh: /你好/,
    en: /Hello! Discover/,
    ja: /こんにちは/,
    ko: /안녕하세요/,
    es: /¡Hola! Descubre/,
  };

  it.each(FREE_TTS_VOICES)("uses the native language of $value", ({ value, lang }) => {
    expect(ttsVoicePreviewText(value)).toMatch(languagePatterns[lang.split("-")[0]]);
  });

  it("recognizes an English locale outside the curated voice list", () => {
    expect(ttsVoicePreviewText("en-AU-WilliamNeural")).toMatch(languagePatterns.en);
  });
});
