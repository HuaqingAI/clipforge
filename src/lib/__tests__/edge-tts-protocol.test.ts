import { afterEach, describe, expect, it, vi } from "vitest";
import { generateSecMsGec } from "@/lib/edge-tts-token";

const cache = vi.hoisted(() => ({
  readTtsCache: vi.fn().mockResolvedValue(null),
  readTtsWords: vi.fn().mockResolvedValue(null),
  writeTtsCache: vi.fn().mockResolvedValue(undefined),
  writeTtsWords: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/tts-cache", () => ({
  ...cache,
  ttsCacheKey: () => "protocol-test",
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Edge Read Aloud protocol", () => {
  it("sends a matching v2 token/version and accepts framed audio and word timings", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T03:10:00Z"));
    const connections: { url: string; messages: string[] }[] = [];
    const audio = Buffer.from([0xff, 0xfb, 0x14, 0xc4]);
    class SynthesisSocket {
      binaryType = "blob";
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
      onerror = null;
      onclose = null;
      private connection: { url: string; messages: string[] };

      constructor(url: string) {
        this.connection = { url, messages: [] };
        connections.push(this.connection);
        void Promise.resolve().then(() => this.onopen?.());
      }

      send(message: string) {
        this.connection.messages.push(message);
        if (!message.includes("Path:ssml\r\n")) return;
        const header = Buffer.from("Path:audio\r\nContent-Type:audio/mpeg\r\n");
        const frame = Buffer.alloc(2 + header.length + audio.length);
        frame.writeUInt16BE(header.length);
        header.copy(frame, 2);
        audio.copy(frame, 2 + header.length);
        this.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer });
        this.onmessage?.({ data: 'Path:audio.metadata\r\n\r\n{"Metadata":[{"Type":"WordBoundary","Data":{"Offset":1000000,"Duration":2000000,"text":{"Text":"你好"}}}]}' });
        this.onmessage?.({ data: "Path:turn.end\r\n\r\n" });
      }

      close() {}
    }
    vi.stubGlobal("WebSocket", SynthesisSocket);
    const { generateSpeechFreeDetailed } = await import("@/lib/edge-tts");
    const result = await generateSpeechFreeDetailed("你好");

    expect(connections).toHaveLength(1);
    const requestUrl = new URL(connections[0].url);
    expect(requestUrl.searchParams.get("Sec-MS-GEC-Version")).toBe("2-143.0.3650.75");
    expect(requestUrl.searchParams.get("Sec-MS-GEC")).toBe(generateSecMsGec(Date.now()));
    expect(connections[0].messages[0]).toContain("Mon Oct 19 2026 03:10:00 GMT+0000");
    expect(result).toEqual({ audio, words: [{ text: "你好", startSec: 0.1, endSec: 0.3 }] });
    expect(cache.writeTtsCache).toHaveBeenCalledWith("protocol-test", audio);
  });
});
