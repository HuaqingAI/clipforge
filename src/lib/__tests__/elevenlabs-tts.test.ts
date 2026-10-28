// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TTSConfig } from "@/lib/tts";

const state = vi.hoisted(() => ({
  generate: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  cache: new Map<string, Buffer>(),
}));

vi.mock("@/lib/elevenlabs/client", () => ({ generateElevenLabsSpeech: state.generate }));
vi.mock("@/lib/tts-cache", async (original) => ({
  ...await original<typeof import("@/lib/tts-cache")>(),
  readTtsCache: state.read,
  writeTtsCache: state.write,
}));

const config: TTSConfig = {
  provider: "elevenlabs-cli", baseUrl: "", apiKey: "", voice: "cloned-voice", model: "eleven_multilingual_v2",
};
const audio = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(256)]);

beforeEach(() => {
  vi.resetModules();
  state.cache.clear();
  state.generate.mockReset().mockResolvedValue(audio);
  state.read.mockReset().mockImplementation(async (key: string) => state.cache.get(key) ?? null);
  state.write.mockReset().mockImplementation(async (key: string, value: Buffer) => { state.cache.set(key, value); });
});

describe("ElevenLabs narration through the unified TTS entry point", () => {
  it("uses the OAuth CLI without an API key and reuses identical successful narration", async () => {
    const { generateSpeech } = await import("@/lib/tts");
    expect(await generateSpeech("A [pause] product demonstration.", config)).toEqual(audio);
    expect(await generateSpeech("A product demonstration.", { ...config, speed: 1, emotion: "happy", instruction: "ignored" })).toEqual(audio);
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.generate.mock.calls[0][0]).toBe("A product demonstration.");
    expect(state.generate.mock.calls[0][1]).toMatchObject({ voice: config.voice, model: config.model, apiKey: "" });
  });

  it("joins concurrent identical requests so two renders do not submit twice", async () => {
    let finish!: (value: Buffer) => void;
    state.generate.mockImplementation(() => new Promise<Buffer>((resolve) => { finish = resolve; }));
    const { generateSpeech } = await import("@/lib/tts");
    const first = generateSpeech("Same narration", config);
    const second = generateSpeech("Same narration", { ...config, speed: 1 });
    await vi.waitFor(() => expect(state.generate).toHaveBeenCalledTimes(1));
    finish(audio);
    expect(await Promise.all([first, second])).toEqual([audio, audio]);
    expect(state.write).toHaveBeenCalledTimes(1);
  });

  it("does not automatically repeat a potentially billed failed request or cache its error", async () => {
    state.generate.mockRejectedValueOnce(new Error("ElevenLabs request timed out"));
    const { generateSpeech } = await import("@/lib/tts");
    await expect(generateSpeech("Failure case", config)).rejects.toThrow("timed out");
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.write).not.toHaveBeenCalled();
    // A later explicit attempt can succeed; the failed in-flight entry was released.
    expect(await generateSpeech("Failure case", config)).toEqual(audio);
    expect(state.generate).toHaveBeenCalledTimes(2);
  });

  it("keeps voice, model and speed changes out of the previous audio cache", async () => {
    const { generateSpeech } = await import("@/lib/tts");
    await generateSpeech("Same text", config);
    await generateSpeech("Same text", { ...config, voice: "another-clone" });
    await generateSpeech("Same text", { ...config, model: "eleven_flash_v2_5" });
    await generateSpeech("Same text", { ...config, speed: 1.1 });
    expect(state.generate).toHaveBeenCalledTimes(4);
  });

  it.each([
    { voice: "" }, { model: "" }, { speed: Number.NaN }, { speed: 0.5 },
    { apiKey: "unexpected-secret" }, { baseUrl: "https://another.example" },
  ])("rejects invalid local CLI configuration before looking up cached audio: %j", async (patch) => {
    state.read.mockResolvedValue(audio);
    const { generateSpeech } = await import("@/lib/tts");
    await expect(generateSpeech("Hello", { ...config, ...patch })).rejects.toThrow();
    expect(state.read).not.toHaveBeenCalled();
    expect(state.generate).not.toHaveBeenCalled();
  });
});
