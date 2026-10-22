// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";

const state = vi.hoisted(() => ({ directory: "" }));
vi.mock("@/lib/paths", () => ({ getDataDir: () => state.directory }));
vi.mock("@/lib/db", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE kling_profiles (id TEXT PRIMARY KEY, data TEXT NOT NULL, lease_owner TEXT, lease_expires_at INTEGER, lease_token INTEGER NOT NULL DEFAULT 0, lease_child_pid INTEGER); CREATE TABLE kling_auth_sessions (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL);");
  return { db: drizzle(sqlite) };
});
import { db } from "@/lib/db";
import { klingProfiles, klingAuthSessions } from "./profile-schema";
import { createProfile, detectProfile, getProfile, saveProfile } from "./profiles";
import { runKling, withKlingLease } from "./cli-runner";
import { KlingError } from "./errors";
import { refreshProfile, startLogin, cancelLogin, getAuthSession } from "./auth";
import { buildControlledCliEnvironment, verifyInstallation } from "./environment";
import type { KlingProfile } from "./types";

let profile: KlingProfile;
describe("Kling isolated CLI runner", () => {
  beforeAll(async () => {
    state.directory = await fs.mkdtemp(path.join(os.tmpdir(), "clipforge-kling-test-"));
    const packagePath = path.join(state.directory, "用户安装 Kling & CLI");
    await fs.mkdir(path.join(packagePath, "dist"), { recursive: true });
    await fs.writeFile(path.join(packagePath, "package.json"), JSON.stringify({ name: "@klingai/cli-global", version: "0.2.0", type: "module", bin: { kling: "dist/cli.js" } }));
    await fs.writeFile(path.join(packagePath, "dist/cli.js"), `
import fs from 'node:fs'; import path from 'node:path';
const args=process.argv.slice(2); const command=args[0];
if(command==='--version'){ console.log('kling-cli 0.2.0'); }
else if(command==='login'){if(fs.existsSync(path.join(process.env.KLING_HOME,'fixture-login-hang'))){console.error('[kling] Waiting for browser authorization...');setTimeout(()=>{},10000);}else console.log(JSON.stringify({ok:true,loggedIn:true}));}
else if(command==='who_am_i'){if(fs.existsSync(path.join(process.env.KLING_HOME,'fixture-logged-out'))){console.error('No login state found for the configured endpoint (.credentials is missing ACCESS_TOKEN). Run: kling login');process.exitCode=1;}else console.log(JSON.stringify({ok:true,body:{userId:'user-1',availableModels:{text_to_video:[{model:'m',arguments:[{name:'duration',allowedValues:[5,10]}]}]}}})); }
else if(command==='account'){if(fs.existsSync(path.join(process.env.KLING_HOME,'fixture-credits-error'))){console.error('Upstream credits temporarily unavailable');process.exitCode=1;}else console.log(JSON.stringify({ok:true,body:{available_points:10,access_token:'MUST_NOT_ESCAPE'}})); }
else if(args.includes('hang')){setTimeout(()=>{},10000);}
else if(args.includes('nonzero')){console.log(JSON.stringify({ok:true,body:{generationId:'accepted-123'}}));process.exitCode=1;}
else if(args.includes('invalid')){console.log('<html>Not JSON</html>');}
else {console.log(JSON.stringify({ok:true,body:{generationId:'accepted-ok',environment:{home:process.env.KLING_HOME,noninteractive:process.env.KLING_NONINTERACTIVE},args}}));}
`);
    profile = await createProfile({ packagePath });
    profile = await detectProfile(profile.id);
  });
  afterAll(async () => { if (state.directory) await fs.rm(state.directory, { recursive: true, force: true }); });
  it("checks the fixed manifest, version and actual Node entrypoint", () => {
    expect(profile.environmentState).toBe("ready");
    expect(profile.cliEntry).toContain("用户安装 Kling & CLI");
  });
  it("uses the isolated home and noninteractive business environment with literal argv", async () => {
    const args = ["text_to_video", "--model", "m", "literal & $(never execute) 中文"];
    const result = await runKling(profile, args);
    expect(result.json).toMatchObject({ body: { environment: { home: profile.homePath, noninteractive: "1" }, args: [...args, "--quiet"] } });
    expect(profile.homePath).not.toBe(path.join(os.homedir(), ".kling"));
    expect(result.spawnFailed).toBe(false);
  });
  it("preserves accepted task IDs and invokes receipt callbacks on nonzero exit", async () => {
    const seen: string[] = [];
    const result = await runKling(profile, ["text_to_video", "nonzero"], { allowFailure: true, onGenerationId: (id) => { seen.push(id); } });
    expect(result.exitCode).toBe(1); expect(result.generationId).toBe("accepted-123"); expect(seen).toEqual(["accepted-123"]);
  });
  it("retains acknowledgment on the thrown error when allowFailure is omitted", async () => {
    await expect(runKling(profile, ["text_to_video", "nonzero"])).rejects.toMatchObject({ code: "KLING_CLI_FAILED", result: { generationId: "accepted-123" } });
  });
  it("rejects polling and interactive login from ordinary business calls", async () => {
    await expect(runKling(profile, ["query_tasks", "g", "--poll", "60"])).rejects.toMatchObject({ code: "KLING_INVALID_COMMAND" });
    await expect(runKling(profile, ["login"])).rejects.toMatchObject({ code: "KLING_INTERACTIVE_FORBIDDEN" });
  });
  it("checks a revoked job after installation verification and before spawning a command", async () => {
    const spawned = vi.fn();
    const revoked = Object.assign(new Error("任务已删除"), { code: "KLING_JOB_DELETED" });
    await expect(runKling(profile, ["text_to_video", "must-never-start"], {
      beforeSpawn: () => { throw revoked; }, onSpawn: spawned,
    })).rejects.toBe(revoked);
    expect(spawned).not.toHaveBeenCalled();
    expect(db.select().from(klingProfiles).where(eq(klingProfiles.id, profile.id)).get()?.leaseOwner).toBeNull();
  });
  it("does not cross the spawn boundary when installation verification fails", async () => {
    const beforeSpawn = vi.fn(), spawned = vi.fn();
    await expect(runKling({ ...profile, packagePath: path.join(state.directory, "missing-package") }, ["text_to_video", "must-never-start"], {
      beforeSpawn, onSpawn: spawned,
    })).rejects.toMatchObject({ code: "KLING_INVALID_PACKAGE" });
    expect(beforeSpawn).not.toHaveBeenCalled();
    expect(spawned).not.toHaveBeenCalled();
  });
  it("preserves definite launch failure evidence even when allowFailure is enabled", async () => {
    const spawned = vi.fn();
    const result = await runKling({ ...profile, homePath: path.join(state.directory, "missing-home") }, ["text_to_video", "must-never-start"], {
      allowFailure: true, onSpawn: spawned,
    });
    expect(result).toMatchObject({ spawnFailed: true, stdout: "", generationId: undefined, timedOut: false, aborted: false });
    expect(result.stderr).toContain("ENOENT");
    expect(spawned).not.toHaveBeenCalled();
    expect(db.select().from(klingProfiles).where(eq(klingProfiles.id, profile.id)).get()?.leaseOwner).toBeNull();
  });
  it("attaches definite launch failure evidence to its thrown error", async () => {
    await expect(runKling({ ...profile, homePath: path.join(state.directory, "missing-home") }, ["text_to_video", "must-never-start"])).rejects.toMatchObject({
      code: "KLING_SPAWN_FAILED", result: { spawnFailed: true, stdout: "", generationId: undefined },
    });
  });
  it("captures synchronous launch validation failures without starting a child", async () => {
    const spawned = vi.fn();
    const result = await runKling({ ...profile, homePath: `${profile.homePath}\0` }, ["text_to_video", "must-never-start"], {
      allowFailure: true, onSpawn: spawned,
    });
    expect(result).toMatchObject({ spawnFailed: true, stdout: "", timedOut: false, aborted: false });
    expect(spawned).not.toHaveBeenCalled();
    expect(db.select().from(klingProfiles).where(eq(klingProfiles.id, profile.id)).get()?.leaseChildPid).toBe(-1);
  });
  it("retains an accepted receipt when the lease check fails after process close", async () => {
    await withKlingLease(profile, async (lease) => {
      const assertOwned = lease.assertOwned.bind(lease);
      let receiptObserved = false;
      // A lease failure can follow a valid generation receipt; it must not erase that ID.
      lease.assertOwned = () => {
        if (receiptObserved) throw new KlingError("KLING_LEASE_LOST", "lease lost after receipt", 409);
        assertOwned();
      };
      await expect(runKling(profile, ["text_to_video", "nonzero"], {
        lease, allowFailure: true, onGenerationId: () => { receiptObserved = true; },
      })).rejects.toMatchObject({ code: "KLING_LEASE_LOST", result: { generationId: "accepted-123", spawnFailed: false } });
      lease.assertOwned = assertOwned;
    });
  });
  it("fails malformed JSON without exposing HTML to callers", async () => {
    await expect(runKling(profile, ["query_tasks", "invalid"])).rejects.toMatchObject({ code: "KLING_INVALID_RESPONSE" });
  });
  it("times out and waits for child close before releasing the profile", async () => {
    await expect(runKling(profile, ["query_tasks", "hang"], { timeoutMs: 50 })).rejects.toMatchObject({ code: "KLING_TIMEOUT" });
    expect(db.select().from(klingProfiles).where(eq(klingProfiles.id, profile.id)).get()?.leaseOwner).toBeNull();
  });
  it("rejects a second concurrent operation through the persisted lease", async () => {
    await withKlingLease(profile, async (lease) => {
      await expect(runKling(profile, ["who_am_i"])).rejects.toMatchObject({ code: "KLING_PROFILE_BUSY" });
      await expect(runKling(profile, ["who_am_i"], { lease })).resolves.toMatchObject({ exitCode: 0 });
    });
  });
  it("refreshes identity and catalog under one lease and sanitizes credits", async () => {
    const refreshed = await refreshProfile(profile.id);
    expect(refreshed).toMatchObject({ authState: "authenticated", principalKey: '["global","user-1"]', creditsSummary: { available_points: 10 } });
    expect(refreshed.catalogSnapshot).toHaveLength(1);
    expect(JSON.stringify(refreshed)).not.toContain("MUST_NOT_ESCAPE");
  });
  it("blocks changed principals without silently rebinding old task ownership", async () => {
    saveProfile({ ...getProfile(profile.id), principalKey: '["global","another-user"]' });
    await expect(refreshProfile(profile.id, undefined, { credits: false })).rejects.toMatchObject({ code: "KLING_ACCOUNT_MISMATCH" });
    expect(getProfile(profile.id).authState).toBe("account_mismatch");
    saveProfile({ ...getProfile(profile.id), principalKey: '["global","user-1"]' });
  });
  it("invalidates the authenticated flag and catalog on stderr-only credential failure", async () => {
    const marker = path.join(profile.homePath, "fixture-logged-out");
    await fs.writeFile(marker, "1");
    try {
      await expect(refreshProfile(profile.id, undefined, { credits: false })).rejects.toMatchObject({ code: "KLING_AUTH_REQUIRED" });
      expect(getProfile(profile.id)).toMatchObject({ authState: "reauth_required", catalogSnapshot: [] });
    } finally { await fs.unlink(marker); }
  });
  it("keeps identity verified when the independent credit query fails", async () => {
    const marker = path.join(profile.homePath, "fixture-credits-error");
    await fs.writeFile(marker, "1");
    try {
      const refreshed = await refreshProfile(profile.id);
      expect(refreshed.authState).toBe("authenticated");
      expect(refreshed.creditsSummary).toBeUndefined();
      expect(refreshed.creditsError).toContain("积分暂时无法读取");
    } finally { await fs.unlink(marker); }
  });
  it("tracks a nonblocking login until identity verification completes", async () => {
    const session = startLogin(profile.id);
    expect(session.state).toBe("queued");
    await vi.waitFor(() => { expect(getAuthSession(session.id).session.state).toBe("succeeded"); }, { timeout: 3000 });
    expect(getProfile(profile.id).authState).toBe("authenticated");
  });
  it("cancels the created login process and persists its final state", async () => {
    const marker = path.join(profile.homePath, "fixture-login-hang");
    await fs.writeFile(marker, "1");
    try {
      const session = startLogin(profile.id);
      await vi.waitFor(() => { expect(getAuthSession(session.id).session.state).toBe("waiting_browser"); }, { timeout: 3000 });
      cancelLogin(session.id);
      await vi.waitFor(() => { expect(getAuthSession(session.id).session.state).toBe("cancelled"); }, { timeout: 3000 });
      expect(db.select().from(klingProfiles).where(eq(klingProfiles.id, profile.id)).get()?.leaseOwner).toBeNull();
    } finally { await fs.unlink(marker); }
  });
  it("marks persisted authentication sessions interrupted after their owner dies", () => {
    const now = Date.now();
    db.insert(klingAuthSessions).values({ id: "abandoned-session", profileId: profile.id, state: "waiting_browser", data: { id: "abandoned-session", profileId: profile.id, state: "waiting_browser", runnerOwner: "999999999:old-process", startedAt: now, deadlineAt: now + 10000 } }).run();
    expect(getAuthSession("abandoned-session").session).toMatchObject({ state: "interrupted", errorCode: "KLING_AUTH_INTERRUPTED" });
  });
  it("does not inherit Node injection variables", () => {
    process.env.NODE_OPTIONS = "--require arbitrary.js";
    try { expect(buildControlledCliEnvironment(profile).NODE_OPTIONS).toBeUndefined(); }
    finally { delete process.env.NODE_OPTIONS; }
  });
  it("refuses legacy credentials without reading or migrating them", async () => {
    const legacy = path.join(profile.packagePath, ".credentials");
    await fs.writeFile(legacy, "PRIVATE");
    await expect(verifyInstallation(profile)).rejects.toMatchObject({ code: "KLING_LEGACY_CREDENTIALS" });
    expect(await fs.readFile(legacy, "utf8")).toBe("PRIVATE");
    await fs.unlink(legacy);
  });
});
