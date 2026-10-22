// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { NextRequest } from "next/server";
import type { KlingProfile } from "@/lib/kling/types";

const state = vi.hoisted(() => ({ sqlite: null as Database.Database | null, directory: "", inspect: vi.fn() }));
vi.mock("@/lib/paths", () => ({ getDataDir: () => state.directory }));
vi.mock("@/lib/kling/environment", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/kling/environment")>(), inspectEnvironment: state.inspect }));
vi.mock("@/lib/db", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  state.sqlite = new Database(":memory:");
  const db = drizzle(state.sqlite);
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return { db, getDb: () => db };
});

import { createProfile, createAccountProfile, detectProfile, getProfile, listProfiles, saveProfile, updateProfile, getPublicKlingStatus } from "@/lib/kling/profiles";
import { discoverPackagePath, verifyInstallation } from "@/lib/kling/environment";
import { KlingError } from "@/lib/kling/errors";
import { createKlingLocalSession } from "@/lib/kling/local-access";
import { POST } from "@/app/api/integrations/kling/profiles/route";

let credentials: Record<string, string>;
function request(body: unknown, headers: Record<string, string> = credentials) {
  return new NextRequest("http://127.0.0.1:3000/api/integrations/kling/profiles", { method: "POST",
    headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
async function accountFixture(): Promise<KlingProfile> {
  const initial = await createProfile({ label: "Original account", nodePath: process.execPath, packagePath: path.join(state.directory, "installation") });
  await fs.writeFile(path.join(initial.homePath, "credentials.json"), "original-private-credential");
  return saveProfile({ ...initial, cliEntry: "original-cli-entry", environmentState: "ready", environmentCheckedAt: 10,
    authState: "account_mismatch", authRevision: 9, principalKey: "original-principal", accountSummary: { id: "account-1", displayName: "Original user" },
    catalogSnapshot: [{ selectionKey: "original-selection", provider: "kling-cli", profileId: initial.id, region: "global", tool: "text_to_video", remoteModelId: "model-1", displayName: "Model", catalogRevision: "original-catalog", available: true, parameters: [], inputSlots: [], capabilities: { image: false, tailFrame: false, multiImage: false, audio: false } }],
    catalogRevision: "original-catalog", catalogCheckedAt: 20, accountCheckedAt: 30, creditsSummary: { credits: 50 }, creditsError: "old error", disabledAt: 40 });
}

beforeAll(async () => {
  state.directory = await fs.mkdtemp(path.join(os.tmpdir(), "clipforge-kling-accounts-"));
  const response = await createKlingLocalSession(request({}, { "x-clipforge-kling": "1" }));
  credentials = { cookie: response.headers.get("set-cookie")!.split(";")[0], "x-clipforge-kling-csrf": (await response.json()).csrfToken };
});
beforeEach(() => {
  state.sqlite!.exec("DELETE FROM kling_auth_sessions; DELETE FROM kling_jobs; DELETE FROM kling_profiles;");
  vi.stubEnv("APP_MIGRATIONS_DIR", ""); vi.stubEnv("CLIPFORGE_KLING_DISABLED", ""); vi.stubEnv("CLIPFORGE_KLING_PACKAGE_PATH", "");
  state.inspect.mockReset();
  state.inspect.mockImplementation(async (profile: KlingProfile) => ({ ...profile, cliEntry: path.join(profile.packagePath, "dist", "cli.js"), environmentState: "ready", environmentCheckedAt: Date.now(), environmentError: undefined }));
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { state.sqlite?.close(); await fs.rm(state.directory, { recursive: true, force: true }); });

describe("launcher-prepared Kling installation", () => {
  it("offers installation defaults without creating or detecting an account", () => {
    const packagePath = path.join(state.directory, "启动脚本 tools", "@klingai", "cli-global");
    vi.stubEnv("CLIPFORGE_KLING_PACKAGE_PATH", packagePath);
    expect(getPublicKlingStatus()).toMatchObject({ profile: null, configured: false, loggedIn: false,
      installationDefaults: { nodePath: process.execPath, packagePath } });
    expect(listProfiles()).toEqual([]);
    expect(state.inspect).not.toHaveBeenCalled();
  });

  it.each(["", "   ", "relative/cli", "../cli", "\u0000invalid"])("ignores invalid launcher installation paths: %s", (packagePath) => {
    vi.stubEnv("CLIPFORGE_KLING_PACKAGE_PATH", packagePath);
    expect(getPublicKlingStatus()).not.toHaveProperty("installationDefaults");
  });

  it("uses defaults for blank paths while preserving an explicitly selected installation", async () => {
    const packagePath = path.join(state.directory, "launcher-cli");
    vi.stubEnv("CLIPFORGE_KLING_PACKAGE_PATH", packagePath);
    const created = await createProfile({ packagePath: "  " });
    expect(created).toMatchObject({ nodePath: process.execPath, packagePath, environmentState: "not_configured", authState: "unknown" });
    expect(getPublicKlingStatus(created.id)).not.toHaveProperty("installationDefaults");

    const customPath = path.join(state.directory, "user-selected-cli");
    const custom = await createProfile({ packagePath: customPath });
    expect(updateProfile(custom.id, { label: "User selection" }).packagePath).toBe(customPath);
    const ready = saveProfile({ ...getProfile(custom.id), environmentState: "ready", authState: "authenticated", authRevision: 3 });
    expect(updateProfile(ready.id, { packagePath: "" })).toMatchObject({ packagePath, environmentState: "not_configured", authState: "unknown", authRevision: 4 });
    expect(state.inspect).not.toHaveBeenCalled();
  });

  it("discovers the prepared path without bypassing manifest verification", async () => {
    const packagePath = path.join(state.directory, "invalid-prepared-cli");
    vi.stubEnv("CLIPFORGE_KLING_PACKAGE_PATH", packagePath);
    await fs.mkdir(packagePath, { recursive: true });
    await fs.writeFile(path.join(packagePath, "package.json"), JSON.stringify({ name: "unrelated-cli", version: "0.2.0" }));
    expect(await discoverPackagePath()).toBe(packagePath);
    const profile = await createProfile();
    await expect(verifyInstallation({ ...profile, packagePath: "" })).rejects.toMatchObject({ code: "KLING_INVALID_PACKAGE" });
  });
});

describe("isolated saved Kling accounts", () => {
  it("inherits only installation paths and detects the new home without modifying the original account", async () => {
    const source = await accountFixture();
    const created = await createAccountProfile(source.id, "  Second account  ");
    expect(created).toMatchObject({ label: "Second account", nodePath: source.nodePath, packagePath: source.packagePath,
      environmentState: "ready", authState: "unknown", authRevision: 0, catalogSnapshot: [] });
    expect(created.id).not.toBe(source.id);
    expect(created.homePath).toBe(path.join(state.directory, "integrations/kling/profiles", created.id, "home"));
    expect(await fs.readdir(created.homePath)).toEqual([]);
    for (const key of ["principalKey", "accountSummary", "accountCheckedAt", "creditsSummary", "creditsError", "catalogRevision", "catalogCheckedAt", "disabledAt"] as const) expect(created[key]).toBeUndefined();
    expect(state.inspect).toHaveBeenCalledWith(expect.objectContaining({ id: created.id, cliEntry: "", homePath: created.homePath, environmentState: "not_configured" }));
    expect(getProfile(source.id)).toEqual(source);
    expect(await fs.readFile(path.join(source.homePath, "credentials.json"), "utf8")).toBe("original-private-credential");
  });

  it("keeps a failed environment check visible and can recover the same account", async () => {
    const source = await accountFixture();
    state.inspect.mockRejectedValueOnce(new KlingError("KLING_NOT_FOUND", "Install Kling CLI first.", 400));
    const created = await createAccountProfile(source.id);
    expect(created).toMatchObject({ environmentState: "not_found", environmentError: "Install Kling CLI first.", authState: "unknown" });
    expect(listProfiles()).toHaveLength(2);
    const recovered = await detectProfile(created.id);
    expect(recovered).toMatchObject({ id: created.id, environmentState: "ready", authState: "unknown" });
    expect(recovered.environmentError).toBeUndefined();
    expect(listProfiles()).toHaveLength(2);
    expect(getProfile(source.id)).toEqual(source);
  });

  it("exposes account names in the profile picker without exposing credential homes", async () => {
    const source = await accountFixture();
    const other = await createAccountProfile(source.id, "New login");
    const status = getPublicKlingStatus(other.id);
    expect(status.profiles).toContainEqual({ id: source.id, label: source.label, authState: source.authState, disabled: true, accountSummary: source.accountSummary });
    expect(status.profiles).toContainEqual({ id: other.id, label: "New login", authState: "unknown", disabled: false });
    expect(status.profile).not.toHaveProperty("homePath");
    expect(status.models).toEqual([]);
    expect(JSON.stringify(status)).not.toContain(source.homePath);
  });
});

describe("saved Kling account endpoint", () => {
  it("creates and detects a new account using the source identifier", async () => {
    const source = await accountFixture();
    const response = await POST(request({ sourceProfileId: source.id, label: "Second login" }));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.profileId).not.toBe(source.id);
    expect(body.profile).toMatchObject({ id: body.profileId, label: "Second login", environmentState: "ready", authState: "unknown" });
    expect(body.profile).not.toHaveProperty("homePath");
    expect(body.profile).not.toHaveProperty("principalKey");
    expect(getProfile(source.id)).toEqual(source);
  });

  it("returns the created account and its actionable detection error", async () => {
    const source = await accountFixture();
    state.inspect.mockRejectedValueOnce(new KlingError("KLING_UNSUPPORTED_VERSION", "Install version 0.2.0.", 400));
    const response = await POST(request({ sourceProfileId: source.id }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.profile).toMatchObject({ id: body.profileId, environmentState: "unsupported_version", environmentError: "Install version 0.2.0." });
    expect(listProfiles()).toHaveLength(2);
  });

  it("keeps unexpected detection failures recoverable without exposing internal error details", async () => {
    const source = await accountFixture();
    state.inspect.mockRejectedValueOnce(new Error("private diagnostic with credentials"));
    const response = await POST(request({ sourceProfileId: source.id }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.profile).toMatchObject({ id: body.profileId, environmentState: "invalid_package" });
    expect(body.profile.environmentError).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("private diagnostic");
    expect(listProfiles()).toHaveLength(2);
  });

  it.each([null, 42, "", "../credentials", "------------------------------------", "abcdefabcdefabcdefabcdefabcdefabcdef"])("rejects malformed source identifiers: %s", async (sourceProfileId) => {
    const response = await POST(request({ sourceProfileId }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("KLING_INVALID_CONFIG");
    expect(listProfiles()).toEqual([]);
    expect(state.inspect).not.toHaveBeenCalled();
  });

  it.each(["id", "nodePath", "packagePath", "homePath", "cliEntry", "principalKey"])("rejects ambiguous account creation with %s", async (field) => {
    const source = await accountFixture();
    const response = await POST(request({ sourceProfileId: source.id, [field]: source.id }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("KLING_INVALID_CONFIG");
    expect(listProfiles()).toEqual([source]);
    expect(state.inspect).not.toHaveBeenCalled();
  });

  it("rejects missing sources before creating an account", async () => {
    const response = await POST(request({ sourceProfileId: randomUUID() }));
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("KLING_PROFILE_NOT_FOUND");
    expect(listProfiles()).toEqual([]);
  });

  it("preserves normal profile creation and update", async () => {
    const create = await POST(request({ label: "Custom installation", nodePath: process.execPath, packagePath: state.directory }));
    expect(create.status).toBe(201);
    const original = await create.json();
    expect(original.profile).toMatchObject({ label: "Custom installation", environmentState: "not_configured", packagePath: state.directory });
    const update = await POST(request({ id: original.profileId, label: "Renamed" }));
    expect(update.status).toBe(200);
    expect((await update.json()).profile).toMatchObject({ id: original.profileId, label: "Renamed" });
    expect(listProfiles()).toHaveLength(1);
    expect(state.inspect).not.toHaveBeenCalled();
  });

  it("enforces local session and CSRF before creating an account", async () => {
    const source = await accountFixture();
    expect((await POST(request({ sourceProfileId: source.id }, {}))).status).toBe(401);
    expect((await POST(request({ sourceProfileId: source.id }, { ...credentials, origin: "https://other.example" }))).status).toBe(403);
    expect(listProfiles()).toEqual([source]);
    expect(state.inspect).not.toHaveBeenCalled();
  });
});
