import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync, rmdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getDataDir } from "@/lib/paths";

interface LockOwner { pid: number; bootId: string }
interface WorkspaceLease { directory: string; owner: LockOwner; release: () => void }
const registry = globalThis as typeof globalThis & { clipforgeWorkspaceLease?: WorkspaceLease };

/** Identifies this process's exclusive lease; changes after releasing/reopening a workspace. */
export function workspaceLeaseId(): string | null {
  return registry.clipforgeWorkspaceLease?.owner.bootId ?? null;
}

function ownerOf(file: string): LockOwner | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.bootId === "string" ? value : null;
  } catch { return null; }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** One server owns a writable workspace; database leases alone do not limit process-wide work. */
export function acquireWorkspaceLock(directory = getDataDir()): () => void {
  if (process.env.CLIPFORGE_PROBE_MODE === "1") return () => {};
  const resolved = resolve(directory);
  const existing = registry.clipforgeWorkspaceLease;
  if (existing) {
    if (existing.directory === resolved) return existing.release;
    throw new Error("当前服务已打开另一个工作目录，请先停止服务");
  }
  mkdirSync(resolved, { recursive: true });
  const filename = join(resolved, ".clipforge-service.lock");
  const recovery = `${filename}.recovery`;
  const owner: LockOwner = { pid: process.pid, bootId: randomUUID() };
  let acquired = false;
  for (let attempt = 0; attempt < 3 && !acquired; attempt++) {
    try { writeFileSync(filename, JSON.stringify(owner), { flag: "wx", mode: 0o600 }); acquired = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = ownerOf(filename);
      if (current && alive(current.pid)) throw new Error(`工作目录已由另一个 ClipForge 服务使用（PID ${current.pid}）。请停止原 Web/客户端服务后重试。`);
      if (!current) {
        try { if (Date.now() - statSync(filename).mtimeMs < 30_000) throw new Error("工作目录正由另一个服务初始化，请稍后重试"); }
        catch (statError) { if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue; throw statError; }
      }
      let recovering = false;
      try {
        mkdirSync(recovery);
        recovering = true;
        const latest = ownerOf(filename);
        if (latest && alive(latest.pid)) throw new Error("工作目录已由另一个 ClipForge 服务使用，请停止原服务后重试");
        if (!latest && Date.now() - statSync(filename).mtimeMs < 30_000) throw new Error("工作目录正在初始化，请稍后重试");
        unlinkSync(filename);
      } catch (recoveryError) {
        if ((recoveryError as NodeJS.ErrnoException).code === "EEXIST") throw new Error("工作目录正在恢复，请稍后重试");
        if ((recoveryError as NodeJS.ErrnoException).code !== "ENOENT") throw recoveryError;
      } finally { if (recovering) rmdirSync(recovery); }
    }
  }
  if (!acquired) throw new Error("无法获取工作目录使用权，请停止其他 ClipForge 服务后重试");
  const release = () => {
    const current = ownerOf(filename);
    if (current?.pid === owner.pid && current.bootId === owner.bootId) {
      try { unlinkSync(filename); } catch { /* already removed */ }
    }
    if (registry.clipforgeWorkspaceLease?.owner.bootId === owner.bootId) delete registry.clipforgeWorkspaceLease;
    process.removeListener("exit", release);
  };
  registry.clipforgeWorkspaceLease = { directory: resolved, owner, release };
  process.once("exit", release);
  return release;
}
