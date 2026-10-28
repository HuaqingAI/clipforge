// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createTideweOutdoorProfile } from "@/lib/creative-profiles";
import { resolveNarrationVoice, TIDEWE_DEFAULT_VOICE, TIDEWE_TTS_VOICES } from "@/lib/narration-voice";
import { DEFAULT_FREE_VOICE, FREE_TTS_VOICES, ttsVoiceLocale } from "@/lib/tts-voices";

describe("shared TIDEWE English narration choices", () => {
  it("offers distinct adult male and female US voices from the shared Edge catalog", () => {
    const values = TIDEWE_TTS_VOICES.map((voice) => voice.value);
    expect(values).toEqual(expect.arrayContaining([
      "en-US-GuyNeural", "en-US-AriaNeural", "en-US-JennyNeural",
      "en-US-ChristopherNeural", "en-US-MichelleNeural", "en-US-RogerNeural",
    ]));
    expect(new Set(values).size).toBe(values.length);
    expect(new Set(TIDEWE_TTS_VOICES.map((voice) => voice.gender))).toEqual(new Set(["male", "female"]));
    expect(values).toContain(TIDEWE_DEFAULT_VOICE);
    for (const voice of TIDEWE_TTS_VOICES) {
      expect(voice.lang).toBe("en-US");
      expect(voice.label).toContain("US English");
      expect(voice.labelZh).toContain("美式英语");
      expect(FREE_TTS_VOICES.find((candidate) => candidate.value === voice.value)).toMatchObject({ gender: voice.gender, lang: voice.lang });
      // The preview route accepts these names, and SSML uses the same language.
      expect(voice.value).toMatch(/^[A-Za-z0-9-]{1,40}$/);
      expect(ttsVoiceLocale(voice.value)).toBe("en-US");
    }
  });

  it.each(["on_camera", "voiceover"] as const)("resolves every selectable voice for %s composition", (speechMode) => {
    const profile = createTideweOutdoorProfile({ speechMode });
    expect(resolveNarrationVoice(profile)).toBe(TIDEWE_DEFAULT_VOICE);
    expect(resolveNarrationVoice(profile, " ")).toBe(TIDEWE_DEFAULT_VOICE);
    for (const voice of TIDEWE_TTS_VOICES) expect(resolveNarrationVoice(profile, voice.value)).toBe(voice.value);
    expect(() => resolveNarrationVoice(profile, "zh-CN-XiaoxiaoNeural")).toThrow("英语音色");
    expect(() => resolveNarrationVoice(profile, "ja-JP-NanamiNeural")).toThrow("英语音色");
  });

  it("keeps other projects' existing default and explicit language choices", () => {
    expect(resolveNarrationVoice(undefined)).toBe(DEFAULT_FREE_VOICE);
    expect(resolveNarrationVoice(undefined, "zh-CN-YunxiNeural")).toBe("zh-CN-YunxiNeural");
    expect(resolveNarrationVoice(undefined, "ja-JP-NanamiNeural")).toBe("ja-JP-NanamiNeural");
    expect(ttsVoiceLocale(DEFAULT_FREE_VOICE)).toBe("zh-CN");
    expect(ttsVoiceLocale("en-GB-RyanNeural")).toBe("en-GB");
  });
});
