// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElevenLabsLocalSession } from "@/lib/elevenlabs/local-access";

const state = vi.hoisted(() => ({ synthesize: vi.fn() }));
vi.mock("@/lib/tts", () => ({ generateSpeech: state.synthesize }));
import { POST } from "@/app/api/tts/route";

let directory: string;
let sessionHeaders: Record<string, string>;
const ttsConfig = { provider: "elevenlabs-cli", model: "eleven_multilingual_v2", voice: "fixture_voice" };

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "clipforge-elevenlabs-preview-"));
  vi.stubEnv("APP_DATA_DIR", directory);
  vi.stubEnv("CLIPFORGE_RUNTIME", "");
  vi.stubEnv("CLIPFORGE_ELEVENLABS_DISABLED", "");
  const session = await createElevenLabsLocalSession(new NextRequest("http://localhost/api/integrations/elevenlabs/session", {
    headers: { host: "localhost", "x-clipforge-elevenlabs": "1" },
  }));
  sessionHeaders = { cookie: session.headers.get("set-cookie")!.split(";")[0], "x-clipforge-elevenlabs-csrf": (await session.json()).csrfToken };
});
beforeEach(() => { state.synthesize.mockReset().mockResolvedValue(Buffer.from("mock-mp3")); });
afterAll(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

function request(config: unknown = ttsConfig, headers: Record<string, string> = sessionHeaders, url = "http://localhost") {
  return POST(new NextRequest(`${url}/api/tts`, { method: "POST", headers: { host: new URL(url).host, "content-type": "application/json", ...headers },
    body: JSON.stringify({ text: "Voice preview", ttsConfig: config }),
  }));
}

describe("ElevenLabs voice previews", () => {
  it("returns MP3 using local OAuth with no API key or URL", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("mock-mp3");
    expect(state.synthesize).toHaveBeenCalledWith("Voice preview", { ...ttsConfig, apiKey: "", baseUrl: "" });
  });
  it.each([{ voice: "" }, { model: "" }, { speed: "1" }, { speed: 2 }, { apiKey: "arbitrary-key" }])("rejects invalid CLI config before generation: %j", async (invalid) => {
    const response = await request({ ...ttsConfig, ...invalid });
    expect(response.status).toBe(400);
    expect(state.synthesize).not.toHaveBeenCalled();
  });
  it("requires a local session and rejects cross-origin or remote callers", async () => {
    expect((await request(ttsConfig, {})).status).toBe(401);
    expect((await request(ttsConfig, { ...sessionHeaders, origin: "https://elsewhere.test" })).status).toBe(403);
    expect((await request(ttsConfig, sessionHeaders, "http://192.168.1.2")).status).toBe(403);
    expect(state.synthesize).not.toHaveBeenCalled();
  });
  it("returns synthesis errors without trying another voice provider", async () => {
    state.synthesize.mockRejectedValue(new Error("ElevenLabs credits exhausted"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await request();
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: "ElevenLabs credits exhausted" });
      expect(state.synthesize).toHaveBeenCalledTimes(1);
    } finally { log.mockRestore(); }
  });
  it("preserves API credential requirements for existing paid providers", async () => {
    expect((await request({ provider: "openai", model: "tts-1", voice: "alloy" })).status).toBe(400);
    expect(state.synthesize).not.toHaveBeenCalled();
  });
});
