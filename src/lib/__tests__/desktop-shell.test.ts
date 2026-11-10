// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const require = createRequire(import.meta.url);
const { createSettingsStore, applicationKey } = require("../../../electron/settings.cjs");
const { acquireWorkspaceLock, readHealth, assertHealthy } = require("../../../electron/desktop-service.cjs");
const temporary: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) { if (child.exitCode === null && child.signalCode === null) child.kill(); }
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function directory() { const value = mkdtempSync(join(tmpdir(), "clipforge-shell-test-")); temporary.push(value); return value; }
function encryption() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "dpapi",
    encryptString(value: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([iv, cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(value: Buffer) {
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString("utf8");
    },
  };
}

describe("desktop settings independent of Chromium origin", () => {
  it("persists across sessions and keeps provider secrets out of the disk JSON", () => {
    const root = directory();
    const crypto = encryption();
    const first = createSettingsStore(root, crypto);
    first.setItem("daihuo-jianshou-settings", '{"apiKey":"secret-provider-value"}');
    first.setItem("clipforge:project:one:voiceover", "voice-id");
    const persisted = readFileSync(join(root, "browser-storage.json"), "utf8");
    expect(persisted).not.toContain("secret-provider-value");
    expect(persisted).not.toContain("voice-id");
    const next = createSettingsStore(root, crypto);
    expect(next.getItem("daihuo-jianshou-settings")).toContain("secret-provider-value");
    expect(next.keys().sort()).toEqual(["clipforge:project:one:voiceover", "daihuo-jianshou-settings"]);
    next.removeItem("clipforge:project:one:voiceover");
    expect(createSettingsStore(root, crypto).getItem("clipforge:project:one:voiceover")).toBeNull();
  });
  it("never silently falls back to plaintext when OS encryption is unavailable", () => {
    const root = directory();
    const unavailable = { ...encryption(), isEncryptionAvailable: () => false };
    expect(() => createSettingsStore(root, unavailable).setItem("clipforge_nav_collapsed", "1")).toThrow(/系统凭据/);
    expect(existsSync(join(root, "browser-storage.json"))).toBe(false);
    const basicText = { ...encryption(), getSelectedStorageBackend: () => "basic_text" };
    expect(() => createSettingsStore(root, basicText).keys()).toThrow(/明文/);
  });
  it("reports corrupt data instead of replacing existing settings with empty defaults", () => {
    const root = directory();
    const filename = join(root, "browser-storage.json");
    writeFileSync(filename, '{"version":999,"encrypted":"broken"}');
    expect(() => createSettingsStore(root, encryption()).getItem("daihuo-jianshou-settings")).toThrow(/格式无效/);
    expect(readFileSync(filename, "utf8")).toContain("broken");
  });
  it("restricts the IPC store to application keys", () => {
    const store = createSettingsStore(directory(), encryption());
    expect(applicationKey("clipforge_nav_collapsed")).toBe(true);
    expect(applicationKey("daihuo-jianshou-characters")).toBe(true);
    for (const key of ["__proto__", "../settings", "unrelated-site", "clipforge\nsecret"]) {
      expect(() => store.setItem(key, "value")).toThrow(/配置项/);
    }
  });
});

describe("desktop workspace ownership", () => {
  it("rejects a concurrent owner and releases only its own lock", () => {
    const root = directory();
    const release = acquireWorkspaceLock(root);
    expect(() => acquireWorkspaceLock(root)).toThrow(/已有/);
    release();
    const anotherRelease = acquireWorkspaceLock(root);
    writeFileSync(join(root, ".desktop-service-owner.json"), JSON.stringify({ pid: process.pid, token: "another-owner" }));
    anotherRelease();
    expect(existsSync(join(root, ".desktop-service-owner.json"))).toBe(true);
  });
  it("recovers a stale lock without overwriting an active owner's directory", () => {
    const root = directory();
    writeFileSync(join(root, ".desktop-service-owner.json"), JSON.stringify({ pid: 2147483647, token: "stale" }));
    const release = acquireWorkspaceLock(root);
    expect(JSON.parse(readFileSync(join(root, ".desktop-service-owner.json"), "utf8")).pid).toBe(process.pid);
    release();
  });
});

describe("packaged backend readiness", () => {
  const healthy = () => ({ app: "clipforge", instanceId: "instance-one", db: { status: "ok", initError: null, migrationError: null }, paths: { dataDirWritable: true, migrationsDirExists: true }, runtime: { moduleAbi: "137", electron: null }, ffmpeg: { exists: true } });
  it("requires the actual instance, DB, resources and ordinary Node ABI", () => {
    expect(() => assertHealthy(healthy(), "instance-one", "137")).not.toThrow();
    expect(() => assertHealthy(healthy(), "other-instance", "137")).toThrow(/实例/);
    expect(() => assertHealthy({ ...healthy(), db: { status: "no such table" } }, "instance-one", "137")).toThrow(/数据库/);
    expect(() => assertHealthy(healthy(), "instance-one", "146")).toThrow(/ABI/);
    expect(() => assertHealthy({ ...healthy(), runtime: { moduleAbi: "137", electron: "42" } }, "instance-one", "137")).toThrow(/Electron/);
  });
  it("does not accept HTTP failures as a successful startup probe", async () => {
    const server = createServer((_req, res) => { res.writeHead(500); res.end('{"error":"database failed"}'); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    try {
      expect(address && typeof address !== "string").toBe(true);
      await expect(readHealth(`http://127.0.0.1:${typeof address === "object" && address?.port}`)).rejects.toThrow(/HTTP 500/);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it("supervises ordinary Node child processes and accepts an explicit shutdown handshake", async () => {
    const root = directory();
    const entry = join(root, "standalone.cjs");
    mkdirSync(root, { recursive: true });
    writeFileSync(entry, `const cp=require('node:child_process'); const child=cp.spawn(process.execPath,['-e','setTimeout(()=>{},20000)']); process.on('SIGTERM',()=>{child.kill();process.send({type:'test-shutdown'});process.exit(0);});`);
    const child = spawn(process.execPath, [resolve("electron/server-entry.cjs"), entry], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
    children.push(child);
    const [first] = await once(child, "message");
    expect(first).toMatchObject({ type: "clipforge:child-start" });
    child.send({ type: "clipforge:shutdown" });
    const [code] = await once(child, "exit");
    expect(code).toBe(0);
  });
  it("stops its subprocess when the Electron parent connection disappears", async () => {
    const root = directory();
    const entry = join(root, "standalone.cjs");
    writeFileSync(entry, "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},20000)']);process.on('SIGTERM',()=>process.exit(0));");
    const child = spawn(process.execPath, [resolve("electron/server-entry.cjs"), entry], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
    children.push(child);
    const [first] = await once(child, "message") as [{ type: string; pid: number }];
    expect(first.type).toBe("clipforge:child-start");
    const exited = once(child, "exit");
    child.disconnect();
    expect((await exited)[0]).toBe(0);
    expect(() => process.kill(first.pid, 0)).toThrow();
  });
});
