// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/tts/free/route";
import { ttsVoicePreviewText } from "@/lib/tts-voices";

const state = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("@/lib/edge-tts", async () => ({
  ...await import("@/lib/tts-voices"),
  generateSpeechFree: state.generate,
}));

function request(body: object) {
  return POST(new NextRequest("http://localhost/api/tts/free", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
}

beforeEach(() => { state.generate.mockReset().mockResolvedValue(Buffer.from("mock-mp3")); });

describe("free voice preview route", () => {
  it("defaults an Eric preview to English when only the voice is supplied", async () => {
    const response = await request({ voice: "en-US-EricNeural" });
    expect(response.status).toBe(200);
    expect(state.generate).toHaveBeenCalledWith(ttsVoicePreviewText("en-US-EricNeural"), { voice: "en-US-EricNeural", rate: undefined });
    expect(await response.text()).toBe("mock-mp3");
  });

  it("preserves explicit narration rather than translating or replacing it", async () => {
    await request({ voice: "en-US-EricNeural", text: "用户指定的文案" });
    expect(state.generate).toHaveBeenCalledWith("用户指定的文案", { voice: "en-US-EricNeural", rate: undefined });
  });

  it("returns a provider failure as an error response", async () => {
    state.generate.mockRejectedValue(new Error("Edge TTS 未返回音频"));
    const response = await request({ voice: "en-US-EricNeural" });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Edge TTS 未返回音频" });
  });
});
