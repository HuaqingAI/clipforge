import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { klingProfiles } from "./profile-schema";
import { KlingError, classifyCliFailure } from "./errors";
import { buildControlledCliEnvironment, verifyInstallation } from "./environment";
import { extractGenerationId, parseCliJson, record } from "./protocol";
import type { KlingProfile, KlingCliResult, KlingRunOptions, KlingLease } from "./types";

export const KLING_BOOT_ID = randomUUID();
const LEASE_MS = 45_000;
const activeChildren = new Map<string, () => void>();
function processExists(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } }

/** SQLite CAS + fencing. A timed-out owner whose process is alive is never stolen. */
export async function withKlingLease<T>(profile: KlingProfile, fn: (lease: KlingLease) => Promise<T>): Promise<T> {
  const owner = `${process.pid}:${KLING_BOOT_ID}:${randomUUID()}`;
  const token = db.transaction((tx) => {
    const row = tx.select().from(klingProfiles).where(eq(klingProfiles.id, profile.id)).get();
    if (!row) throw new KlingError("KLING_PROFILE_NOT_FOUND", "Kling 配置不存在。", 404);
    if (row.leaseOwner) {
      const pid = Number(row.leaseOwner.split(":")[0]);
      if ((row.leaseExpiresAt ?? 0) > Date.now() || !Number.isSafeInteger(pid) || pid <= 0 || processExists(pid) || row.leaseChildPid === -2 || (row.leaseChildPid != null && row.leaseChildPid > 0 && processExists(row.leaseChildPid))) throw new KlingError("KLING_PROFILE_BUSY", "此 Kling 账号正在执行其他操作，或旧进程仍未确认退出。请稍后重试。", 409);
    }
    const next = row.leaseToken + 1;
    const acquired = tx.update(klingProfiles).set({ leaseOwner: owner, leaseToken: next, leaseExpiresAt: Date.now() + LEASE_MS, leaseChildPid: -1 }).where(and(eq(klingProfiles.id, profile.id), eq(klingProfiles.leaseToken, row.leaseToken))).run();
    if (acquired.changes !== 1) throw new KlingError("KLING_PROFILE_BUSY", "此 Kling 账号正在执行其他操作，请稍后重试。", 409);
    return next;
  });
  let lost = false;
  const match = and(eq(klingProfiles.id, profile.id), eq(klingProfiles.leaseOwner, owner), eq(klingProfiles.leaseToken, token));
  const lease: KlingLease = { profileId: profile.id, owner, token, assertOwned() {
    const row = db.select().from(klingProfiles).where(match).get();
    if (lost || !row) throw new KlingError("KLING_LEASE_LOST", "Kling 操作锁已失效，请查询原任务后继续。", 409);
  } };
  const heartbeat = setInterval(() => {
    try { if (db.update(klingProfiles).set({ leaseExpiresAt: Date.now() + LEASE_MS }).where(match).run().changes !== 1) throw new Error("lease lost"); }
    catch { lost = true; activeChildren.get(owner)?.(); }
  }, 10_000);
  heartbeat.unref();
  try { const result = await fn(lease); lease.assertOwned(); return result; }
  finally {
    clearInterval(heartbeat);
    // runKling resolves only after close. If it cannot establish close it keeps this lease occupied.
    if (!activeChildren.has(owner)) db.update(klingProfiles).set({ leaseOwner: null, leaseExpiresAt: null }).where(match).run();
  }
}

export async function runKling(profile: KlingProfile, args: string[], opts: KlingRunOptions = {}): Promise<KlingCliResult> {
  if (!opts.lease) return withKlingLease(profile, (lease) => runKling(profile, args, { ...opts, lease }));
  const lease = opts.lease;
  if (lease.profileId !== profile.id) throw new KlingError("KLING_INVALID_LEASE", "Kling 账号锁不匹配。", 409);
  lease.assertOwned();
  if (profile.disabledAt) throw new KlingError("KLING_PROFILE_DISABLED", "此 Kling 配置已停用。", 409);
  if (profile.environmentState !== "ready") throw new KlingError("KLING_ENVIRONMENT_REQUIRED", "请先在设置页检测 Kling CLI 环境。", 409);
  const commands = new Set(["login", "logout", "who_am_i", "account", "text_to_video", "image_to_video", "query_tasks"]);
  if (!commands.has(args[0]) || args.some((a) => typeof a !== "string" || a.includes("\0")) || args.some((a) => /^--(?:poll|base[-_]url|credentials|endpoint|home|config)(?:=|$)/i.test(a))) throw new KlingError("KLING_INVALID_COMMAND", "不支持的 Kling 命令参数。", 400);
  if (args[0] === "login" && !opts.interactiveLogin) throw new KlingError("KLING_INTERACTIVE_FORBIDDEN", "请通过设置页发起登录。", 400);
  if (opts.interactiveLogin && args[0] !== "login") throw new KlingError("KLING_INVALID_COMMAND", "仅登录操作允许浏览器授权。", 400);
  if (args.join(" ").length > 28_000) throw new KlingError("KLING_ARGUMENTS_TOO_LONG", "Kling 输入参数过长，请缩短提示词并使用本地参考图。", 400);
  const verified = await verifyInstallation(profile);
  if (verified.cliEntry !== profile.cliEntry || verified.nodePath !== profile.nodePath) throw new KlingError("KLING_ENVIRONMENT_CHANGED", "Kling 安装路径已改变，请重新检测环境。", 409);
  if (opts.signal?.aborted) throw new KlingError("KLING_CANCELLED", "Kling 本地操作已取消。", 409);
  // Job deletion may revoke dispatch while installation verification is awaiting disk I/O.
  opts.beforeSpawn?.();
  return new Promise<KlingCliResult>((resolve, reject) => {
    const actualArgs = args.includes("--quiet") ? args : [...args, "--quiet"];
    db.update(klingProfiles).set({ leaseChildPid: -2 }).where(and(eq(klingProfiles.id, profile.id), eq(klingProfiles.leaseOwner, lease.owner), eq(klingProfiles.leaseToken, lease.token))).run();
    const child = (() => {
      try { return spawn(profile.nodePath, [profile.cliEntry, ...actualArgs], { shell: false, windowsHide: true, cwd: profile.homePath, env: buildControlledCliEnvironment(profile, !!opts.interactiveLogin), stdio: ["ignore", "pipe", "pipe"] }); }
      catch (error) {
        const result: KlingCliResult = { exitCode: null, signal: null, stdout: "", stderr: error instanceof Error ? error.message.slice(0, 4096) : "Node.js process could not start", timedOut: false, aborted: false, spawnFailed: true };
        try { db.update(klingProfiles).set({ leaseChildPid: -1 }).where(and(eq(klingProfiles.id, profile.id), eq(klingProfiles.leaseOwner, lease.owner), eq(klingProfiles.leaseToken, lease.token))).run(); }
        catch { reject(new KlingError("KLING_RECEIPT_FAILED", "Kling 启动失败，且本地执行记录未能保存。", 500, result)); return; }
        if (opts.allowFailure) resolve(result);
        else reject(new KlingError("KLING_SPAWN_FAILED", "Kling CLI 无法启动，请重新检测环境。", 502, result));
      }
    })();
    if (!child) return;
    let stdout = "", stderr = "", timedOut = false, aborted = false, tooLarge = false, callbackFailed = false, spawned = false;
    let generationId: string | undefined;
    const outDecoder = new StringDecoder("utf8"), errDecoder = new StringDecoder("utf8");
    const kill = () => { child.kill(); };
    activeChildren.set(lease.owner, kill);
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { kill(); hardKill ??= setTimeout(() => child.kill("SIGKILL"), 5_000); hardKill.unref(); };
    const onAbort = () => { aborted = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, opts.timeoutMs ?? (opts.interactiveLogin ? 330_000 : 90_000));
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const observe = () => {
      const id = extractGenerationId(parseCliJson(stdout));
      if (id && !generationId) { generationId = id; try { opts.onGenerationId?.(id); } catch { callbackFailed = true; stop(); } }
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout += outDecoder.write(chunk); if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) { tooLarge = true; stop(); } else observe(); });
    child.stderr.on("data", (chunk: Buffer) => { const text = errDecoder.write(chunk); if (Buffer.byteLength(stderr) + Buffer.byteLength(text) > 2 * 1024 * 1024) { tooLarge = true; stop(); return; } stderr += text; try { opts.onStderr?.(text); } catch { callbackFailed = true; stop(); } });
    child.once("spawn", () => { spawned = true; try { if (child.pid) { db.update(klingProfiles).set({ leaseChildPid: child.pid }).where(and(eq(klingProfiles.id, profile.id), eq(klingProfiles.leaseOwner, lease.owner), eq(klingProfiles.leaseToken, lease.token))).run(); opts.onSpawn?.(child.pid); } } catch { callbackFailed = true; stop(); } });
    let spawnFailed = false;
    child.once("error", (error) => {
      // A later process/kill error does not prove that generation never started.
      spawnFailed = !spawned;
      if (spawnFailed) stderr += `${stderr ? "\n" : ""}${error.message.slice(0, 4096)}`;
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer); if (hardKill) clearTimeout(hardKill); opts.signal?.removeEventListener("abort", onAbort); activeChildren.delete(lease.owner);
      stdout += outDecoder.end(); stderr += errDecoder.end(); observe();
      const json = parseCliJson(stdout);
      const result: KlingCliResult = { exitCode, signal, json, generationId: generationId ?? extractGenerationId(json), stdout, stderr, timedOut, aborted, spawnFailed };
      try { db.update(klingProfiles).set({ leaseChildPid: -1 }).where(and(eq(klingProfiles.id, profile.id), eq(klingProfiles.leaseOwner, lease.owner), eq(klingProfiles.leaseToken, lease.token))).run(); }
      catch { reject(new KlingError("KLING_RECEIPT_FAILED", "Kling 已退出，但本地执行记录未能保存；请查询原任务后继续。", 500, result)); return; }
      try { lease.assertOwned(); } catch (error) { if (error instanceof KlingError) error.result ??= result; reject(error); return; }
      if (callbackFailed) { reject(new KlingError("KLING_RECEIPT_FAILED", "本地操作记录保存失败，请勿重复生成；请查询原任务。", 500, result)); return; }
      if (opts.allowFailure) { resolve(result); return; }
      if (spawnFailed) { reject(new KlingError("KLING_SPAWN_FAILED", "Kling CLI 无法启动，请重新检测环境。", 502, result)); return; }
      if (tooLarge) { reject(new KlingError("KLING_OUTPUT_TOO_LARGE", "Kling 返回内容超过安全限制，请检查 CLI 版本。", 502, result)); return; }
      if (exitCode !== 0 || timedOut || aborted || record(json).ok === false) { reject(classifyCliFailure(result)); return; }
      if (!json) { reject(new KlingError("KLING_INVALID_RESPONSE", "Kling 未返回有效 JSON，请检查固定 CLI 版本。", 502, result)); return; }
      resolve(result);
    });
  });
}
