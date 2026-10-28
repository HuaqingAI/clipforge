import { describe, expect, it } from "vitest";
import { validateElevenLabsConfig } from "@/lib/elevenlabs/config";

describe("ElevenLabs speech configuration", () => {
  const valid = { provider: "elevenlabs-cli", voice: "ClonedVoice123", model: "eleven_multilingual_v2" };
  it("canonicalizes IDs and permits local OAuth without a key or endpoint", () => {
    expect(validateElevenLabsConfig({ ...valid, voice: " ClonedVoice123 ", model: " eleven_multilingual_v2 ", speed: 0.7 })).toEqual({
      ok: true, config: { ...valid, baseUrl: "", apiKey: "", speed: 0.7 },
    });
    expect(validateElevenLabsConfig({ ...valid, speed: 1.2 }).ok).toBe(true);
  });
  it.each([null, [], {}, { ...valid, voice: "--help" }, { ...valid, model: "../model" }, { ...valid, voice: "v".repeat(129) },
    { ...valid, model: [] }, { ...valid, voice: {} }, { ...valid, speed: NaN }, { ...valid, speed: Infinity },
    { ...valid, speed: null }, { ...valid, speed: "1" }, { ...valid, speed: 0.69 }, { ...valid, speed: 1.21 },
    { ...valid, baseUrl: "https://elsewhere.test" }, { ...valid, apiKey: "key" }, { ...valid, provider: "openai" },
  ])("rejects invalid configuration %j", (input) => {
    expect(validateElevenLabsConfig(input)).toMatchObject({ ok: false, error: expect.any(String) });
  });
});
