import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { getDataDir } from "@/lib/paths";
import { klingProfiles, klingAuthSessions } from "./profile-schema";
import { KLING_PACKAGE, KLING_VERSION, KLING_ADAPTER_VERSION, KLING_ENDPOINT, type KlingProfile, type KlingPublicStatus } from "./types";
import { KlingError } from "./errors";
import { getDefaultKlingPackagePath, inspectEnvironment } from "./environment";
import { klingJobs } from "./job-schema";
import { klingJobOccupiesGenerationSlot, klingJobHasUnknownSubmission } from "./concurrency";

export function getProfile(id: string): KlingProfile {
  if (typeof id !== "string" || !/^[a-f\d-]{36}$/i.test(id)) throw new KlingError("KLING_PROFILE_NOT_FOUND", "Kling 配置不存在。", 404);
  const row = db.select().from(klingProfiles).where(eq(klingProfiles.id, id)).get();
  if (!row) throw new KlingError("KLING_PROFILE_NOT_FOUND", "Kling 配置不存在。", 404);
  return row.data;
}
export function listProfiles(): KlingProfile[] { return db.select().from(klingProfiles).all().map((r) => r.data); }
export function saveProfile(profile: KlingProfile): KlingProfile {
  const current = { ...profile, updatedAt: Date.now() };
  db.update(klingProfiles).set({ data: current }).where(eq(klingProfiles.id, profile.id)).run();
  return current;
}
export interface ProfileInput { label?: string; nodePath?: string; packagePath?: string; }
function readInput(input: ProfileInput): ProfileInput {
  for (const value of [input.label, input.nodePath, input.packagePath]) if (value !== undefined && (typeof value !== "string" || value.length > 2048 || /[\x00\r\n]/.test(value))) throw new KlingError("KLING_INVALID_CONFIG", "Kling 配置格式不正确。", 400);
  return { label: input.label?.trim().slice(0, 80), nodePath: input.nodePath?.trim(), packagePath: input.packagePath?.trim() };
}
export async function createProfile(input: ProfileInput = {}): Promise<KlingProfile> {
  const values = readInput(input); const now = Date.now(); const id = randomUUID();
  const profile: KlingProfile = { id, label: values.label || "Kling 官方 CLI", region: "global", cliPackage: KLING_PACKAGE, cliVersion: KLING_VERSION, adapterVersion: KLING_ADAPTER_VERSION, nodePath: values.nodePath || process.execPath, packagePath: values.packagePath || getDefaultKlingPackagePath(), cliEntry: "", homePath: path.join(getDataDir(), "integrations/kling/profiles", id, "home"), endpoint: KLING_ENDPOINT, environmentState: "not_configured", authState: "unknown", authRevision: 0, catalogSnapshot: [], createdAt: now, updatedAt: now };
  await fs.mkdir(profile.homePath, { recursive: true, mode: 0o700 });
  db.insert(klingProfiles).values({ id, data: profile }).run();
  return profile;
}
/** Another account gets a new credential home and keeps the original account's jobs bound to it. */
export async function createAccountProfile(sourceId: string, label?: string): Promise<KlingProfile> {
  if (typeof sourceId !== "string" || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(sourceId)) {
    throw new KlingError("KLING_INVALID_CONFIG", "请选择有效的 Kling 来源账户。", 400);
  }
  const source = getProfile(sourceId);
  const profile = await createProfile({ label, nodePath: source.nodePath, packagePath: source.packagePath });
  try { return await detectProfile(profile.id); }
  catch (error) {
    // Detection saves its actionable failure state. Return the created account so it can be fixed
    // and checked again instead of making a retry create another hidden credential home.
    const current = getProfile(profile.id);
    if (current.environmentCheckedAt !== undefined && current.environmentError) return current;
    throw error;
  }
}
export function updateProfile(id: string, input: ProfileInput): KlingProfile {
  const values = readInput(input); const profile = getProfile(id);
  const row = db.select().from(klingProfiles).where(eq(klingProfiles.id, id)).get()!;
  if (row.leaseOwner) throw new KlingError("KLING_PROFILE_BUSY", "Kling 正在执行操作，请稍后修改配置。", 409);
  const nodePath = values.nodePath === undefined ? profile.nodePath : values.nodePath || process.execPath;
  const packagePath = values.packagePath === undefined ? profile.packagePath : values.packagePath || getDefaultKlingPackagePath();
  const changed = nodePath !== profile.nodePath || packagePath !== profile.packagePath;
  return saveProfile({ ...profile, ...(values.label !== undefined ? { label: values.label || "Kling 官方 CLI" } : {}), nodePath, packagePath, ...(changed ? { cliEntry: "", environmentState: "not_configured", environmentCheckedAt: undefined, environmentError: undefined, authState: "unknown", authRevision: profile.authRevision + 1, catalogSnapshot: [], catalogRevision: undefined, catalogCheckedAt: undefined } : {}) });
}
export async function detectProfile(id: string): Promise<KlingProfile> {
  const profile = getProfile(id);
  // The same cross-process lock used by regular commands also covers credential migration in --version.
  const { withKlingLease } = await import("./cli-runner");
  return withKlingLease(profile, async (lease) => {
    try { const inspected = await inspectEnvironment(profile); lease.assertOwned(); return saveProfile(inspected); }
    catch (error) { lease.assertOwned(); const code = error instanceof KlingError ? error.code : "KLING_ENVIRONMENT_FAILED";
      const state = code === "KLING_NOT_FOUND" ? "not_found" : code === "KLING_NODE_UNAVAILABLE" ? "node_unavailable" : code === "KLING_UNSUPPORTED_VERSION" ? "unsupported_version" : "invalid_package";
      saveProfile({ ...getProfile(id), environmentState: state, environmentError: error instanceof KlingError ? error.message : "Kling 环境检测失败。", environmentCheckedAt: Date.now(), catalogSnapshot: [], catalogRevision: undefined, catalogCheckedAt: undefined }); throw error;
    }
  });
}
export function getPublicKlingStatus(profileId?: string): KlingPublicStatus {
  const profiles = listProfiles(); const profile = profileId ? getProfile(profileId) : profiles.find((p) => !p.disabledAt) ?? profiles[0] ?? null;
  const latest = profile ? db.select().from(klingAuthSessions).where(eq(klingAuthSessions.profileId, profile.id)).orderBy(sql`json_extract(${klingAuthSessions.data}, '$.startedAt') desc`).get()?.data : undefined;
  const models = profile?.catalogSnapshot.map((model) => {
    const { disabledReason: _reason, ...descriptor } = model;
    void _reason;
    return { ...descriptor, available: true, capabilities: { image: true, tailFrame: true, multiImage: true, audio: true } };
  }) ?? [];
  let publicProfile: KlingPublicStatus["profile"] = null;
  if (profile) { const { homePath: _private, ...rest } = profile; void _private; publicProfile = { ...rest, catalogSnapshot: models }; }
  const jobs = profile?.principalKey ? db.select().from(klingJobs).where(and(eq(klingJobs.principalKey, profile.principalKey), eq(klingJobs.region, profile.region))).all() : [];
  const concurrency = { active: jobs.filter(klingJobOccupiesGenerationSlot).length, max: null, blockedByUnknownSubmission: jobs.some(klingJobHasUnknownSubmission) };
  const defaultPackagePath = !profile ? getDefaultKlingPackagePath() : "";
  return { profile: publicProfile, profiles: profiles.map((p) => ({ id: p.id, label: p.label, authState: p.authState, disabled: !!p.disabledAt, ...(p.accountSummary ? { accountSummary: p.accountSummary } : {}) })), configured: profile?.environmentState === "ready", loggedIn: profile?.authState === "authenticated", models: profile?.authState === "authenticated" ? models : [], concurrency, ...(latest ? { authSession: latest } : {}), ...(defaultPackagePath ? { installationDefaults: { nodePath: process.execPath, packagePath: defaultPackagePath } } : {}) };
}
