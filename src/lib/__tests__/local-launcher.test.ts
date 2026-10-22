// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { acquireLock, compatibleNode, fingerprint, healthyInstance, portAvailable, readHealth, ROOT } from "../../../scripts/launch-local.mjs";

const temporaryDirectories: string[] = [];
function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "clipforge-launcher-"));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return address.port;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
}

describe("local launcher Node compatibility", () => {
  it.each(["22.13.0", "v22.13.0", "22.22.2", "24.0.0", "v24.18.0"])("accepts supported LTS version %s", (version) => {
    expect(compatibleNode(version)).toBe(true);
  });
  it.each(["18.20.0", "20.20.0", "22.12.9", "23.9.0", "25.0.0", "26.0.0", "garbage"])("rejects unsupported version %s", (version) => {
    expect(compatibleNode(version)).toBe(false);
  });
});

describe("local launcher build fingerprints", () => {
  it("ignores traversal order and unselected runtime files while detecting source changes", () => {
    const directory = temporaryDirectory();
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "src", "app.ts"), "initial source");
    writeFileSync(join(directory, "package.json"), "{}");
    const initial = fingerprint(directory, ["src", "package.json"], "node-runtime");
    expect(fingerprint(directory, ["package.json", "src"], "node-runtime")).toBe(initial);
    mkdirSync(join(directory, ".clipforge"));
    writeFileSync(join(directory, ".clipforge", "launcher.log"), "new log");
    expect(fingerprint(directory, ["src", "package.json"], "node-runtime")).toBe(initial);
    writeFileSync(join(directory, "src", "app.ts"), "updated source");
    expect(fingerprint(directory, ["src", "package.json"], "node-runtime")).not.toBe(initial);
  });

  it("invalidates a build when environment configuration or native runtime changes", () => {
    const directory = temporaryDirectory();
    const paths = [".env.local", "next.config.ts"];
    writeFileSync(join(directory, "next.config.ts"), "export default {}");
    const absentEnvironment = fingerprint(directory, paths, "node-22/abi-127/win32/x64");
    writeFileSync(join(directory, ".env.local"), "NEXT_PUBLIC_NAME=first");
    const configured = fingerprint(directory, paths, "node-22/abi-127/win32/x64");
    expect(configured).not.toBe(absentEnvironment);
    writeFileSync(join(directory, ".env.local"), "NEXT_PUBLIC_NAME=second");
    expect(fingerprint(directory, paths, "node-22/abi-127/win32/x64")).not.toBe(configured);
    expect(fingerprint(directory, paths, "node-24/abi-137/win32/x64"))
      .not.toBe(fingerprint(directory, paths, "node-22/abi-127/win32/x64"));
  });
});

describe("local launcher ownership lock", () => {
  it("does not take a live process lock and releases its own lock", () => {
    const file = join(temporaryDirectory(), "launcher.lock");
    const release = acquireLock(file);
    expect(release).toBeTypeOf("function");
    expect(acquireLock(file)).toBeNull();
    expect(JSON.parse(readFileSync(file, "utf8")).pid).toBe(process.pid);
    release!();
    expect(existsSync(file)).toBe(false);
    release!();
  });

  it("recovers a lock left by a process that has exited", () => {
    const file = join(temporaryDirectory(), "launcher.lock");
    const departed = spawnSync(process.execPath, ["-e", ""], { windowsHide: true });
    expect(departed.status).toBe(0);
    expect(departed.pid).toBeGreaterThan(0);
    writeFileSync(file, JSON.stringify({ pid: departed.pid }));
    const release = acquireLock(file);
    expect(release).toBeTypeOf("function");
    expect(JSON.parse(readFileSync(file, "utf8")).pid).toBe(process.pid);
    release!();
  });

  it("leaves a newly written partial lock alone and recovers an old malformed lock", () => {
    const file = join(temporaryDirectory(), "launcher.lock");
    writeFileSync(file, "{");
    expect(acquireLock(file)).toBeNull();
    const old = new Date(Date.now() - 60_000);
    utimesSync(file, old, old);
    const release = acquireLock(file);
    expect(release).toBeTypeOf("function");
    release!();
    expect(existsSync(file)).toBe(false);
  });

  it("does not remove a lock that has been replaced by another owner", () => {
    const file = join(temporaryDirectory(), "launcher.lock");
    const release = acquireLock(file);
    expect(release).toBeTypeOf("function");
    writeFileSync(file, JSON.stringify({ pid: process.pid + 1 }));
    release!();
    expect(JSON.parse(readFileSync(file, "utf8")).pid).toBe(process.pid + 1);
  });
});

describe("local launcher service readiness", () => {
  const ready = { app: "clipforge", instanceId: "this-checkout", db: { status: "ok", initError: null, migrationError: null } };
  it("requires a healthy database from the same checkout", () => {
    expect(healthyInstance(ready, "this-checkout")).toBe(true);
    for (const health of [
      null,
      {},
      { ...ready, app: "another-service" },
      { ...ready, instanceId: "another-checkout" },
      { ...ready, db: undefined },
      { ...ready, db: { ...ready.db, status: "no such table: projects" } },
      { ...ready, db: { ...ready.db, initError: "native ABI mismatch" } },
      { ...ready, db: { ...ready.db, migrationError: "migration failed" } },
    ]) expect(healthyInstance(health, "this-checkout")).toBe(false);
  });

  it("detects an occupied loopback port and releases its own availability probe", async () => {
    const server = createServer();
    const port = await listen(server);
    try { expect(await portAvailable(port)).toBe(false); }
    finally { await close(server); }
    expect(await portAvailable(port)).toBe(true);
    expect(await portAvailable(port)).toBe(true);
  });

  it("reads the health endpoint and tolerates non-JSON or unsuccessful services", async () => {
    let responseMode = "healthy";
    const paths: string[] = [];
    const server = createHttpServer((request, response) => {
      paths.push(request.url ?? "");
      response.statusCode = responseMode === "unavailable" ? 503 : 200;
      response.end(responseMode === "invalid" ? "not JSON" : JSON.stringify(ready));
    });
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}`;
    try {
      expect(await readHealth(url)).toEqual(ready);
      responseMode = "invalid";
      expect(await readHealth(url)).toBeNull();
      responseMode = "unavailable";
      expect(await readHealth(url)).toBeNull();
      expect(paths).toEqual(["/api/health", "/api/health", "/api/health"]);
    } finally { await close(server); }
    expect(await readHealth(url)).toBeNull();
  });
});

const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const canRunWindowsBootstrap = process.platform === "win32" && process.arch === "x64" && compatibleNode(process.version) && existsSync(npmCli);

describe("Windows PowerShell 5.1 bootstrap", () => {
  it.skipIf(!canRunWindowsBootstrap)("finds a supported PATH Node without downloading and forwards launcher arguments", () => {
    const directory = join(temporaryDirectory(), "源码 project");
    const scripts = join(directory, "scripts");
    mkdirSync(scripts, { recursive: true });
    copyFileSync(join(ROOT, "scripts", "start-local.ps1"), join(scripts, "start-local.ps1"));
    writeFileSync(join(directory, "package.json"), "{}");
    writeFileSync(join(scripts, "launch-local.mjs"), "console.log(JSON.stringify({node:process.execPath,version:process.version,args:process.argv.slice(2),npmCli:process.env.CLIPFORGE_NPM_CLI}));");
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
    env.Path = `${dirname(process.execPath)};${process.env.PATH ?? ""}`;
    const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(scripts, "start-local.ps1"), "--check", "--port", "43123", "--no-browser"], {
      cwd: directory, env, windowsHide: true, encoding: "utf8", timeout: 15_000,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const report = JSON.parse(result.stdout.trim());
    expect(resolve(report.node).toLowerCase()).toBe(resolve(process.execPath).toLowerCase());
    expect(report.version).toBe(process.version);
    expect(report.npmCli.toLowerCase()).toBe(npmCli.toLowerCase());
    expect(report.args).toEqual(["--check", "--port", "43123", "--no-browser"]);
    expect(existsSync(join(directory, ".clipforge"))).toBe(false);
  });
});
