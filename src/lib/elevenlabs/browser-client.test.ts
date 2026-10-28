// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("ElevenLabs browser session requests", () => {
  it("acquires CSRF protection, preserves caller headers and forces local request credentials", async () => {
    const expected = Response.json({ compositionId: "composition-1" }, { status: 202 });
    fetchMock.mockResolvedValueOnce(Response.json({ csrfToken: "local-token" })).mockResolvedValueOnce(expected);
    const { elevenLabsFetch } = await import("./browser-client");
    const headers = new Headers({ "X-Request-ID": "request-1", "X-Clipforge-ElevenLabs-CSRF": "stale-token" });
    const signal = new AbortController().signal;
    const body = JSON.stringify({ ttsConfig: { provider: "elevenlabs-cli" } });

    expect(await elevenLabsFetch("/api/project/project-1/compose", {
      method: "POST", headers, body, signal, credentials: "include", cache: "force-cache",
    })).toBe(expected);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]).toEqual(["/api/integrations/elevenlabs/session", {
      cache: "no-store", credentials: "same-origin", headers: { "X-Clipforge-ElevenLabs": "1" },
    }]);
    const [url, request] = fetchMock.mock.calls[1];
    expect(url).toBe("/api/project/project-1/compose");
    expect(request).toMatchObject({ method: "POST", body, signal, credentials: "same-origin", cache: "no-store" });
    const sentHeaders = new Headers(request?.headers);
    expect(sentHeaders.get("X-Clipforge-ElevenLabs-CSRF")).toBe("local-token");
    expect(sentHeaders.get("X-Request-ID")).toBe("request-1");
    expect(sentHeaders.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Clipforge-ElevenLabs-CSRF")).toBe("stale-token");
    expect(headers.has("Content-Type")).toBe(false);
  });

  it("shares one in-flight session across concurrent status and catalog requests", async () => {
    let finishSession!: (response: Response) => void;
    fetchMock.mockImplementation((input) => input === "/api/integrations/elevenlabs/session"
      ? new Promise<Response>((resolve) => { finishSession = resolve; })
      : Promise.resolve(Response.json({ ok: true })));
    const { elevenLabsFetch } = await import("./browser-client");

    const status = elevenLabsFetch("/api/integrations/elevenlabs/status");
    const catalog = elevenLabsFetch("/api/integrations/elevenlabs/catalog");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finishSession(Response.json({ csrfToken: "shared-token" }));
    await Promise.all([status, catalog]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, request] of fetchMock.mock.calls.slice(1)) {
      const sentHeaders = new Headers(request?.headers);
      expect(sentHeaders.get("X-Clipforge-ElevenLabs-CSRF")).toBe("shared-token");
      expect(sentHeaders.has("Content-Type")).toBe(false);
      expect(request).toMatchObject({ credentials: "same-origin", cache: "no-store" });
    }
    await elevenLabsFetch("/api/integrations/elevenlabs/status");
    expect(fetchMock.mock.calls.filter(([input]) => input === "/api/integrations/elevenlabs/session")).toHaveLength(1);
  });

  it("returns a mutation's 401 without replay and reacquires a token for the next explicit request", async () => {
    const denied = Response.json({ error: { message: "Session expired" } }, { status: 401 });
    const accepted = Response.json({ compositionId: "composition-2" }, { status: 202 });
    fetchMock.mockResolvedValueOnce(Response.json({ csrfToken: "old-token" }))
      .mockResolvedValueOnce(denied)
      .mockResolvedValueOnce(Response.json({ csrfToken: "new-token" }))
      .mockResolvedValueOnce(accepted);
    const { elevenLabsFetch } = await import("./browser-client");
    const input = "/api/project/project-1/compose";
    const init = { method: "POST", body: "{}" };

    expect(await elevenLabsFetch(input, init)).toBe(denied);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.filter(([url]) => url === input)).toHaveLength(1);

    expect(await elevenLabsFetch(input, init)).toBe(accepted);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[2][0]).toBe("/api/integrations/elevenlabs/session");
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("X-Clipforge-ElevenLabs-CSRF")).toBe("old-token");
    expect(new Headers(fetchMock.mock.calls[3][1]?.headers).get("X-Clipforge-ElevenLabs-CSRF")).toBe("new-token");
  });

  it("does not submit a mutation when session creation fails and lets the next explicit request recover", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: { message: "Local access denied" } }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ csrfToken: "recovered-token" }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const { elevenLabsFetch } = await import("./browser-client");

    await expect(elevenLabsFetch("/api/tts", { method: "POST", body: "{}" })).rejects.toThrow("Local access denied");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await elevenLabsFetch("/api/tts", { method: "POST", body: "{}" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/tts")).toHaveLength(1);
  });

  it("does not replay a potentially billed mutation after a network failure", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ csrfToken: "local-token" }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { elevenLabsFetch } = await import("./browser-client");

    await expect(elevenLabsFetch("/api/tts", { method: "POST", body: "{}" })).rejects.toThrow("Failed to fetch");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/tts")).toHaveLength(1);
  });
});
