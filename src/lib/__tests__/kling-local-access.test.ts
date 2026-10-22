// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { assertKlingLocalRequest, assertLocalKlingOrigin, createKlingLocalSession } from "@/lib/kling/local-access";

const location = vi.hoisted(() => ({ directory: "" }));
vi.mock("@/lib/paths", () => ({ getDataDir: () => location.directory }));

function request(path = "/api/integrations/kling/status", headers: Record<string, string> = {}, url = "http://localhost:3000") {
  return new NextRequest(url + path, { headers: { host: new URL(url).host, ...headers } });
}
beforeAll(async () => { location.directory = await mkdtemp(join(tmpdir(), "clipforge-kling-access-")); });
beforeEach(() => {
  vi.stubEnv("CLIPFORGE_KLING_DISABLED", ""); vi.stubEnv("CLIPFORGE_RUNTIME", ""); vi.stubEnv("ELECTRON_RUN_AS_NODE", ""); vi.stubEnv("APP_MIGRATIONS_DIR", "");
});
afterAll(async () => { await rm(location.directory, { recursive: true, force: true }); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("local Kling browser access", () => {
  it.each(["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"])("allows exact loopback origin %s", (url) => {
    expect(() => assertLocalKlingOrigin(request("/", { origin: url, "sec-fetch-site": "same-origin" }, url))).not.toThrow();
  });

  it.each([
    ["http://192.168.1.10:3000", {}],
    ["http://localhost:3000", { host: "evil.example" }],
    ["http://localhost:3000", { origin: "http://evil.example" }],
    ["http://localhost:3000", { "sec-fetch-site": "cross-site" }],
    ["http://localhost:3000", { "sec-fetch-site": "same-site" }],
  ] as const)("rejects a nonlocal or mismatched request %s %o", (url, headers) => {
    expect(() => assertLocalKlingOrigin(request("/", headers, url))).toThrow();
  });

  it.each([["CLIPFORGE_KLING_DISABLED", "1"], ["CLIPFORGE_RUNTIME", "desktop"]])("does not enable CLI in disabled/desktop mode: %s", (name, value) => {
    vi.stubEnv(name, value);
    expect(() => assertLocalKlingOrigin(request())).toThrow(/本机运行的网页版/);
  });
  it("allows the production web server to provide its migration directory", () => {
    vi.stubEnv("APP_MIGRATIONS_DIR", "C:/ClipForge/drizzle");
    expect(() => assertLocalKlingOrigin(request())).not.toThrow();
    expect(() => assertLocalKlingOrigin(request("/", { origin: "https://evil.example" }))).toThrow();
  });
  it("blocks a real Electron runtime even when the explicit desktop flag is missing", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.versions, "electron");
    Object.defineProperty(process.versions, "electron", { configurable: true, value: "42.0.0" });
    try { expect(() => assertLocalKlingOrigin(request())).toThrow(/本机运行的网页版/); }
    finally {
      if (descriptor) Object.defineProperty(process.versions, "electron", descriptor);
      else delete process.versions.electron;
    }
  });
  it("does not confuse a Node terminal inherited flag with ClipForge Desktop", () => {
    vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
    expect(() => assertLocalKlingOrigin(request())).not.toThrow();
  });

  it("requires the session bootstrap header and returns a strict HTTP-only cookie", async () => {
    await expect(createKlingLocalSession(request())).rejects.toThrow(/请求标识/);
    const response = await createKlingLocalSession(request("/api/integrations/kling/session", { "X-Clipforge-Kling": "1" }));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(response.headers.get("set-cookie")).toMatch(/SameSite=strict/i);
    expect((await response.json()).csrfToken).toMatch(/^[\w-]+$/);
  });

  it("binds CSRF to the signed cookie and requires JSON for mutations", async () => {
    const response = await createKlingLocalSession(request("/api/integrations/kling/session", { "X-Clipforge-Kling": "1" }));
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    const { csrfToken } = await response.json();
    const headers = { cookie, "X-Clipforge-Kling-CSRF": csrfToken, "content-type": "application/json" };
    await expect(assertKlingLocalRequest(request("/", headers))).resolves.toBeUndefined();
    await expect(assertKlingLocalRequest(request("/", { ...headers, "X-Clipforge-Kling-CSRF": "wrong" }))).rejects.toMatchObject({ status: 401 });
    await expect(assertKlingLocalRequest(request("/", { ...headers, cookie: cookie + "x" }))).rejects.toMatchObject({ status: 401 });
    await expect(assertKlingLocalRequest(request("/", { ...headers, "content-type": "text/plain" }))).rejects.toMatchObject({ status: 415 });
    await expect(assertKlingLocalRequest(request("/", { cookie, "X-Clipforge-Kling-CSRF": csrfToken }), false)).resolves.toBeUndefined();
  });

  it("does not retry a mutation after a session rejection, and renews only before the next explicit action", async () => {
    vi.resetModules();
    const mockFetch = vi.fn().mockImplementation(async (url: string) => url.endsWith("/session") ? Response.json({ csrfToken: "fresh-csrf" }) : Response.json({ error: "session expired" }, { status: 401 }));
    vi.stubGlobal("fetch", mockFetch);
    const { klingFetch } = await import("@/lib/kling/client");
    const response = await klingFetch("/api/ai/video", { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual(["/api/integrations/kling/session", "/api/ai/video"]);
    const mutationInit = mockFetch.mock.calls[1][1] as RequestInit;
    expect(new Headers(mutationInit.headers).get("X-Clipforge-Kling-CSRF")).toBe("fresh-csrf");
    await klingFetch("/api/ai/video", { method: "POST", body: "{}" });
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual(["/api/integrations/kling/session", "/api/ai/video", "/api/integrations/kling/session", "/api/ai/video"]);
  });

  it("does not retry a mutation rejected by the network", async () => {
    vi.resetModules();
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/session")) return Response.json({ csrfToken: "csrf" });
      throw new TypeError("network lost after submit");
    });
    vi.stubGlobal("fetch", mockFetch);
    const { klingFetch } = await import("@/lib/kling/client");
    await expect(klingFetch("/api/ai/video", { method: "POST", body: "{}" })).rejects.toThrow(/network lost/);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
