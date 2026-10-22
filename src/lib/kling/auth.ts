import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { klingAuthSessions } from "./profile-schema";
import { getProfile, saveProfile } from "./profiles";
import { runKling, withKlingLease, KLING_BOOT_ID } from "./cli-runner";
import { extractPrincipal, parseCatalog, unwrapKlingBody, record } from "./protocol";
import { KlingError } from "./errors";
import type { KlingAuthSession, KlingLease, KlingProfile } from "./types";

const globalState = globalThis as unknown as { __clipforgeKlingAuth?: Map<string, { controller: AbortController; authorizationUrl?: string }> };
const active = globalState.__clipforgeKlingAuth ??= new Map();
const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
function saveSession(session: KlingAuthSession): void { db.update(klingAuthSessions).set({ state: session.state, data: session }).where(eq(klingAuthSessions.id, session.id)).run(); }
function rawSession(id: string): KlingAuthSession {
  const found = db.select().from(klingAuthSessions).where(eq(klingAuthSessions.id, id)).get()?.data;
  if (!found) throw new KlingError("KLING_AUTH_SESSION_NOT_FOUND", "Kling 登录会话不存在。", 404);
  return found;
}
function ownerExists(owner: string): boolean { const pid = Number(owner.split(":")[0]); try { if (!Number.isSafeInteger(pid) || pid <= 0) return false; process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } }
export function getAuthSession(id: string): { session: KlingAuthSession; authorizationUrl?: string } {
  let session = rawSession(id);
  if (!terminal.has(session.state) && (!ownerExists(session.runnerOwner) || session.deadlineAt + 30_000 < Date.now())) {
    session = { ...session, state: "interrupted", finishedAt: Date.now(), errorCode: "KLING_AUTH_INTERRUPTED", errorMessage: "登录进程已中断，请重新检测账号或登录。" };
    saveSession(session);
    const profile = getProfile(session.profileId);
    if (profile.authState === "logging_in") saveProfile({ ...profile, authState: "unknown", catalogSnapshot: [], catalogCheckedAt: undefined });
  }
  const authorizationUrl = active.get(id)?.authorizationUrl;
  return { session, ...(authorizationUrl && !terminal.has(session.state) ? { authorizationUrl } : {}) };
}

/** Force identity discovery under the caller's existing lock; account credits are independent. */
export async function refreshProfile(id: string, lease?: KlingLease, opts: { credits?: boolean } = {}): Promise<KlingProfile> {
  if (!lease) return withKlingLease(getProfile(id), (lock) => refreshProfile(id, lock, opts));
  lease.assertOwned();
  let profile = getProfile(id);
  try {
    const who = await runKling(profile, ["who_am_i"], { lease });
    const identity = extractPrincipal(who.json);
    if (profile.principalKey && profile.principalKey !== identity.principalKey) {
      saveProfile({ ...profile, authState: "account_mismatch", catalogSnapshot: [], catalogRevision: undefined, catalogCheckedAt: undefined });
      throw new KlingError("KLING_ACCOUNT_MISMATCH", "当前 Kling 账号与原配置绑定的账号不同。请登录原账号，或创建新的账号配置。", 409);
    }
    const catalog = parseCatalog(who.json, id);
    const changed = profile.authState !== "authenticated" || profile.catalogRevision !== catalog[0]?.catalogRevision;
    profile = saveProfile({ ...profile, ...identity, authState: "authenticated", authRevision: profile.authRevision + (changed ? 1 : 0), catalogSnapshot: catalog, catalogRevision: catalog[0]?.catalogRevision, catalogCheckedAt: Date.now(), accountCheckedAt: Date.now() });
  } catch (error) {
    if (error instanceof KlingError && error.code !== "KLING_ACCOUNT_MISMATCH" && ["KLING_AUTH_REQUIRED", "KLING_PRINCIPAL_UNVERIFIED"].includes(error.code)) saveProfile({ ...getProfile(id), authState: "reauth_required", catalogSnapshot: [], catalogRevision: undefined, catalogCheckedAt: undefined });
    throw error;
  }
  if (opts.credits !== false) {
    try {
      const info = await runKling(profile, ["account"], { lease, timeoutMs: 30_000 });
      const body = unwrapKlingBody(info.json);
      const summary: Record<string, string | number | boolean> = {};
      for (const key of ["credits", "availableCredits", "available_credits", "points", "availablePoints", "available_points", "membership", "membershipType", "membership_type", "plan"]) {
        const value = body[key]; if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") summary[key] = typeof value === "string" ? value.slice(0, 200) : value;
      }
      profile = saveProfile({ ...getProfile(id), creditsSummary: Object.keys(summary).length ? summary : undefined, creditsError: Object.keys(summary).length ? undefined : "官方积分响应尚无可识别的展示字段。" });
    } catch { profile = saveProfile({ ...getProfile(id), creditsSummary: undefined, creditsError: "积分暂时无法读取；账号与模型状态已单独验证。" }); }
  }
  lease.assertOwned(); return profile;
}

export function startLogin(id: string): KlingAuthSession {
  const profile = getProfile(id);
  if (profile.environmentState !== "ready") throw new KlingError("KLING_ENVIRONMENT_REQUIRED", "请先检测 Kling CLI 环境。", 409);
  const existing = db.select().from(klingAuthSessions).where(eq(klingAuthSessions.profileId, id)).all().map((r) => r.data).find((s) => !terminal.has(getAuthSession(s.id).session.state));
  if (existing) return existing;
  const now = Date.now(); const session: KlingAuthSession = { id: randomUUID(), profileId: id, state: "queued", startedAt: now, deadlineAt: now + 330_000, runnerOwner: `${process.pid}:${KLING_BOOT_ID}` };
  db.insert(klingAuthSessions).values({ id: session.id, profileId: id, state: session.state, data: session }).run();
  const state = { controller: new AbortController(), authorizationUrl: undefined as string | undefined }; active.set(session.id, state);
  void (async () => {
    let current = session;
    try {
      await withKlingLease(profile, async (lease) => {
        current = { ...current, state: "starting" }; saveSession(current);
        saveProfile({ ...getProfile(id), authState: "logging_in", authRevision: profile.authRevision + 1, catalogSnapshot: [], catalogRevision: undefined, catalogCheckedAt: undefined });
        const cancellation = setInterval(() => { try { if (rawSession(session.id).cancelRequestedAt) state.controller.abort(); } catch { state.controller.abort(); } }, 500);
        cancellation.unref();
        try {
          let diagnostics = "";
          const login = await runKling(getProfile(id), ["login"], { lease, interactiveLogin: true, signal: state.controller.signal, timeoutMs: 330_000, onSpawn() { current = { ...current, state: "waiting_browser" }; saveSession(current); }, onStderr(chunk) {
            diagnostics = (diagnostics + chunk).slice(-32_768);
            for (const match of diagnostics.matchAll(/https:\/\/[^\s<>"']+/g)) {
              try { const url = new URL(match[0]); if (url.hostname === "kling.ai" && url.pathname === "/auth/authorize" && url.searchParams.has("state") && url.searchParams.has("code_challenge")) state.authorizationUrl = url.toString(); } catch { /* not an authorization URL */ }
            }
          } });
          if (record(login.json).loggedIn !== true) throw new KlingError("KLING_LOGIN_FAILED", "Kling 未确认登录成功，请重新登录。", 502);
          current = { ...current, state: "verifying" }; saveSession(current); state.authorizationUrl = undefined;
          await refreshProfile(id, lease);
          if (rawSession(session.id).cancelRequestedAt || state.controller.signal.aborted) throw new KlingError("KLING_CANCELLED", "登录已取消。", 409);
          current = { ...current, state: "succeeded", finishedAt: Date.now() }; saveSession(current);
        } catch (error) {
          // Login clears old state before authorizing, so do not retain a previous authenticated flag.
          if (getProfile(id).authState !== "account_mismatch") {
            try { await refreshProfile(id, lease, { credits: false }); }
            catch { if (getProfile(id).authState !== "account_mismatch") saveProfile({ ...getProfile(id), authState: "reauth_required", catalogSnapshot: [], catalogRevision: undefined, catalogCheckedAt: undefined }); }
          }
          throw error;
        } finally { clearInterval(cancellation); }
      });
    } catch (error) {
      const cancelled = state.controller.signal.aborted || rawSession(session.id).cancelRequestedAt;
      current = { ...current, state: cancelled ? "cancelled" : "failed", finishedAt: Date.now(), errorCode: error instanceof KlingError ? error.code : "KLING_LOGIN_FAILED", errorMessage: error instanceof KlingError ? error.message : "Kling 登录未完成，请重新检测后登录。" }; saveSession(current);
    } finally { active.delete(session.id); }
  })();
  return session;
}
export function cancelLogin(id: string): KlingAuthSession {
  const session = rawSession(id); if (terminal.has(session.state)) return session;
  const requested = { ...session, cancelRequestedAt: Date.now() }; saveSession(requested); active.get(id)?.controller.abort(); return requested;
}
export async function logoutProfile(id: string): Promise<KlingProfile> {
  return withKlingLease(getProfile(id), async (lease) => {
    const profile = getProfile(id);
    try {
      await runKling(profile, ["logout"], { lease });
      const check = await runKling(profile, ["who_am_i"], { lease, allowFailure: true, timeoutMs: 30_000 });
      if (check.exitCode === 0 && record(check.json).ok === true) throw new KlingError("KLING_LOGOUT_UNCERTAIN", "Kling 仍返回已登录状态，请重新检测账号。", 409);
      if (!/not.logged.in|no.credentials|no.login.state|missing.access.token|run:.kling.login|login required|登录|unauthori[sz]ed|authentication/i.test(`${check.stderr} ${JSON.stringify(check.json)}`)) throw new KlingError("KLING_LOGOUT_UNCERTAIN", "退出登录后的状态未能确认，请重新检测账号。", 409);
      return saveProfile({ ...getProfile(id), authState: "logged_out", authRevision: profile.authRevision + 1, catalogSnapshot: [], catalogRevision: undefined, catalogCheckedAt: undefined, creditsSummary: undefined, creditsError: undefined });
    } catch (error) { saveProfile({ ...getProfile(id), authState: "unknown", catalogSnapshot: [], catalogRevision: undefined, catalogCheckedAt: undefined }); throw error; }
  });
}
