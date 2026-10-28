// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFile, access } from "node:fs/promises";
import { runElevenLabs } from "./cli-runner";
vi.mock("./cli-runner", () => ({ runElevenLabs: vi.fn() }));
vi.mock("./environment", () => ({ discoverElevenLabsInstallation: vi.fn().mockResolvedValue({ executable: "/fixture/elevenlabs", version: "1.8.0" }) }));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  delete (globalThis as { __clipforgeElevenLabs?: unknown }).__clipforgeElevenLabs;
});
afterEach(() => { delete (globalThis as { __clipforgeElevenLabs?: unknown }).__clipforgeElevenLabs; });

describe("ElevenLabs account catalog and speech generation", () => {
  it("only publishes login state without CLI credential sources", async () => {
    vi.mocked(runElevenLabs).mockResolvedValue(JSON.stringify({ backend: "keyring", schemes: [{ logged_in: true, source: "secret-location", access_token: "TOKEN_MUST_NOT_ESCAPE" }] }));
    const { getElevenLabsStatus } = await import("./client");
    const status = await getElevenLabsStatus();
    expect(status).toMatchObject({ installed: true, authenticated: true, version: "1.8.0" });
    expect(JSON.stringify(status)).not.toContain("TOKEN_MUST_NOT_ESCAPE");
    expect(JSON.stringify(status)).not.toContain("secret-location");
  });
  it("paginates cloned voices, deduplicates IDs, and only returns TTS-capable models", async () => {
    vi.mocked(runElevenLabs).mockResolvedValueOnce(JSON.stringify({ voices: [{ voice_id: "clone_1", name: "My clone", category: "cloned", labels: { language: "en", unsafe: 3 }, access_token: "hidden" }], has_more: true, next_page_token: "page-2" }))
      .mockResolvedValueOnce(JSON.stringify({ voices: [{ voice_id: "clone_1", name: "My clone" }, { voice_id: "voice_2", name: "Voice 2" }], has_more: false }))
      .mockResolvedValueOnce(JSON.stringify([{ model_id: "tts_1", name: "Speech", can_do_text_to_speech: true, languages: [{ language_id: "en", name: "English" }] }, { model_id: "sts_1", can_do_text_to_speech: false }]));
    const { getElevenLabsCatalog } = await import("./client");
    const catalog = await getElevenLabsCatalog();
    expect(catalog.voices.map((voice) => voice.id)).toEqual(["clone_1", "voice_2"]);
    expect(catalog.models).toEqual([{ id: "tts_1", name: "Speech", languages: [{ id: "en", name: "English" }] }]);
    expect(vi.mocked(runElevenLabs).mock.calls[1][0]).toContain("page-2");
    expect(await getElevenLabsCatalog()).toBe(catalog);
    expect(runElevenLabs).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(catalog)).not.toContain("hidden");
  });
  it("writes speech through stdin with explicit model/speed, disables CLI retries and removes temporary audio", async () => {
    let output = "";
    vi.mocked(runElevenLabs).mockImplementation(async (args) => {
      output = args[args.indexOf("--output") + 1];
      await writeFile(output, Buffer.from([0x49, 0x44, 0x33, 0, 0]));
      return "";
    });
    const { generateElevenLabsSpeech } = await import("./client");
    const audio = await generateElevenLabsSpeech("Hello & 世界", { voice: "clone_1", model: "eleven_multilingual_v2", speed: 0.9 });
    expect(audio.subarray(0, 3).toString()).toBe("ID3");
    const [args, options] = vi.mocked(runElevenLabs).mock.calls[0];
    expect(args).toContain("--no-retry"); expect(args).not.toContain("Hello & 世界");
    expect(JSON.parse(options!.input!)).toEqual({ text: "Hello & 世界", model_id: "eleven_multilingual_v2", voice_settings: { speed: 0.9 } });
    await expect(access(output)).rejects.toThrow();
    expect(runElevenLabs).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid configuration before dispatching and rejects disguised JSON audio", async () => {
    const { generateElevenLabsSpeech } = await import("./client");
    await expect(generateElevenLabsSpeech("Hello", { voice: "", model: "tts" })).rejects.toMatchObject({ code: "ELEVENLABS_INVALID_CONFIG" });
    await expect(generateElevenLabsSpeech("Hello", { voice: "v", model: "tts", speed: 1.3 })).rejects.toMatchObject({ code: "ELEVENLABS_INVALID_CONFIG" });
    expect(runElevenLabs).not.toHaveBeenCalled();
    vi.mocked(runElevenLabs).mockImplementation(async (args) => { await writeFile(args[args.indexOf("--output") + 1], '{"error":"unexpected"}'); return ""; });
    await expect(generateElevenLabsSpeech("Hello", { voice: "v", model: "tts" })).rejects.toMatchObject({ code: "ELEVENLABS_INVALID_AUDIO" });
  });
});
