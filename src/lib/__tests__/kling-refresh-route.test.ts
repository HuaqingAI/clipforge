// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({ directory: "", refresh: vi.fn(), status: vi.fn() }));
vi.mock("@/lib/paths", () => ({ getDataDir: () => state.directory }));
vi.mock("@/lib/kling/auth", () => ({ refreshProfile: state.refresh }));
vi.mock("@/lib/kling/profiles", () => ({ getPublicKlingStatus: state.status }));

import { createKlingLocalSession } from "@/lib/kling/local-access";
import { KlingError } from "@/lib/kling/errors";
import { POST } from "@/app/api/integrations/kling/refresh/route";

let credentials: Record<string, string>;
function request(body: unknown, headers: Record<string, string> = credentials) {
  return new NextRequest("http://127.0.0.1:3000/api/integrations/kling/refresh", { method: "POST",
    headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

beforeAll(async () => {
  state.directory = await mkdtemp(join(tmpdir(), "clipforge-kling-refresh-"));
  const session = await createKlingLocalSession(request({}, { "x-clipforge-kling": "1" }));
  credentials = { cookie: session.headers.get("set-cookie")!.split(";")[0], "x-clipforge-kling-csrf": (await session.json()).csrfToken };
});
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("APP_MIGRATIONS_DIR", ""); vi.stubEnv("CLIPFORGE_KLING_DISABLED", "");
  state.refresh.mockResolvedValue({ id: "profile-1" });
  state.status.mockReturnValue({ profile: { id: "profile-1", authState: "authenticated" }, models: [] });
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await rm(state.directory, { recursive: true, force: true }); });

describe("Kling profile refresh endpoint", () => {
  it("omits account credits for the generation dialog's identity and catalog refresh", async () => {
    const response = await POST(request({ profileId: "profile-1", credits: false }));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(state.refresh).toHaveBeenCalledWith("profile-1", undefined, { credits: false });
    expect(state.status).toHaveBeenCalledWith("profile-1");
    expect(await response.json()).toMatchObject({ profile: { id: "profile-1", authState: "authenticated" } });
  });
  it.each([undefined, true])("keeps the settings refresh's account credits enabled (credits: %s)", async (credits) => {
    expect((await POST(request({ profileId: "profile-1", credits }))).status).toBe(200);
    expect(state.refresh).toHaveBeenCalledWith("profile-1", undefined, { credits: true });
  });
  it.each([null, [], {}, { profileId: "../private" }, { profileId: 42 }, { profileId: "profile-1", credits: "false" }, { profileId: "profile-1", credits: null }])("rejects malformed refresh options: %j", async (body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400); expect((await response.json()).error.code).toBe("KLING_INVALID_CONFIG");
    expect(state.refresh).not.toHaveBeenCalled(); expect(state.status).not.toHaveBeenCalled();
  });
  it("preserves the transient contention code so the dialog can defer and retry", async () => {
    state.refresh.mockRejectedValueOnce(new KlingError("KLING_PROFILE_BUSY", "Another command owns this profile", 409));
    const response = await POST(request({ profileId: "profile-1", credits: false }));
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("KLING_PROFILE_BUSY");
    expect(state.status).not.toHaveBeenCalled();
  });
  it("requires local authentication and CSRF before running either refresh mode", async () => {
    const response = await POST(request({ profileId: "profile-1", credits: false }, {}));
    expect(response.status).toBe(401); expect((await response.json()).error.code).toBe("KLING_LOCAL_ACCESS_DENIED");
    expect(state.refresh).not.toHaveBeenCalled(); expect(state.status).not.toHaveBeenCalled();
  });
});
