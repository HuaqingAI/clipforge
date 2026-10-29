import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ElevenLabsError } from "./errors";
import { ELEVENLABS_CLI_VERSION } from "./types";

export interface ElevenLabsInstallation { executable: string; version: string }

/** Keep the user's OS identity for OAuth/keyring, but never inherit API keys or endpoint overrides. */
export function buildElevenLabsEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "DBUS_SESSION_BUS_ADDRESS", "LANG", "LC_ALL"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.NO_COLOR = "1";
  return env;
}

async function exists(file: string): Promise<boolean> { try { await fs.access(file); return true; } catch { return false; } }

export async function verifyElevenLabsPackage(packageInput: string): Promise<ElevenLabsInstallation> {
  if (!path.isAbsolute(packageInput) || /[\x00\r\n]/.test(packageInput)) throw new ElevenLabsError("ELEVENLABS_INVALID_INSTALLATION", "ELEVENLABS_CLI_PATH 必须是官方 CLI 安装的绝对路径。", 400);
  let packagePath: string;
  let manifest: { name?: string; version?: string; bin?: { elevenlabs?: string } };
  try {
    packagePath = await fs.realpath(packageInput);
    manifest = JSON.parse(await fs.readFile(path.join(packagePath, "package.json"), "utf8"));
  } catch { throw new ElevenLabsError("ELEVENLABS_INVALID_INSTALLATION", "未找到有效的 ElevenLabs CLI 安装目录。", 400); }
  const platformName = `@elevenlabs/cli-${process.platform}-${process.arch}`;
  if (!["@elevenlabs/cli", platformName].includes(manifest.name ?? "") || manifest.version !== ELEVENLABS_CLI_VERSION) {
    throw new ElevenLabsError("ELEVENLABS_UNSUPPORTED_VERSION", `仅支持官方 @elevenlabs/cli@${ELEVENLABS_CLI_VERSION}，请安装此版本。`, 409);
  }
  const filename = process.platform === "win32" ? "elevenlabs.exe" : "elevenlabs";
  if (manifest.name === "@elevenlabs/cli") {
    if (manifest.bin?.elevenlabs !== "bin/cli.js") throw new ElevenLabsError("ELEVENLABS_INVALID_INSTALLATION", "ElevenLabs CLI 入口与已验证版本不一致。", 409);
    // Run the native binary directly: the npm JS shim creates an unhidden nested process on Windows.
    return verifyElevenLabsPackage(path.join(path.dirname(packagePath), `cli-${process.platform}-${process.arch}`));
  }
  let executable: string;
  try { executable = await fs.realpath(path.join(packagePath, filename)); }
  catch { throw new ElevenLabsError("ELEVENLABS_NOT_FOUND", "ElevenLabs 平台二进制缺失，请重新安装 CLI（保留 optionalDependencies）。", 409); }
  const relative = path.relative(packagePath, executable);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new ElevenLabsError("ELEVENLABS_INVALID_INSTALLATION", "ElevenLabs 二进制必须位于官方安装包内。", 409);
  return { executable, version: ELEVENLABS_CLI_VERSION };
}

async function configuredPackage(input: string): Promise<string> {
  if (!path.isAbsolute(input) || input.length > 4096 || /[\x00\r\n]/.test(input)) return input;
  let resolved = input;
  try { resolved = await fs.realpath(input); } catch { /* reported by verification */ }
  const name = path.basename(resolved).toLowerCase();
  if (name === "package.json") return path.dirname(resolved);
  if (name === "cli.js") return path.resolve(resolved, "../..");
  if (name === "elevenlabs.exe" || name === "elevenlabs") {
    const parent = path.dirname(resolved);
    if (await exists(path.join(parent, "package.json"))) return parent;
  }
  if (/^elevenlabs(?:\.cmd|\.ps1)?$/.test(name)) return path.join(path.dirname(resolved), "node_modules", "@elevenlabs", "cli");
  return resolved;
}

/** Discover existing installations only. Requests never invoke npm/npx or install code. */
export async function discoverElevenLabsInstallation(): Promise<ElevenLabsInstallation> {
  const configured = process.env.ELEVENLABS_CLI_PATH?.trim();
  if (configured) return verifyElevenLabsPackage(await configuredPackage(configured));
  // The launcher prepares code only; OAuth continues to use the current OS user.
  // A broken managed installation must surface its validation error instead of
  // silently selecting another version from a global installation or npm cache.
  const prepared = process.env.CLIPFORGE_ELEVENLABS_PACKAGE_PATH?.trim();
  if (prepared) return verifyElevenLabsPackage(prepared);
  const moduleRoots = [
    process.env.APPDATA && path.join(process.env.APPDATA, "npm", "node_modules"),
    process.env.npm_config_prefix && path.join(process.env.npm_config_prefix, "node_modules"),
    path.join(path.dirname(process.execPath), "node_modules"),
    path.resolve(path.dirname(process.execPath), "../lib/node_modules"),
    "/usr/local/lib/node_modules", "/usr/lib/node_modules",
    path.join(os.homedir(), ".npm-global/lib/node_modules"),
    ...((process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter(Boolean).flatMap((entry) => [path.join(entry, "node_modules"), path.resolve(entry, "../lib/node_modules")])),
  ].filter((entry): entry is string => Boolean(entry));
  const candidates = [...new Set(moduleRoots)].map((root) => path.join(root, "@elevenlabs", "cli"));
  const caches = [...new Set([
    process.env.npm_config_cache,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "npm-cache"),
    path.join(os.homedir(), ".npm"),
  ].filter((value): value is string => Boolean(value)))];
  for (const cache of caches) {
    const npxRoot = path.join(cache, "_npx");
    try {
      const entries = await fs.readdir(npxRoot, { withFileTypes: true });
      for (const entry of entries.slice(0, 256)) if (entry.isDirectory()) candidates.push(path.join(npxRoot, entry.name, "node_modules", "@elevenlabs", "cli"));
    } catch { /* cache is optional */ }
  }
  let versionError: ElevenLabsError | undefined;
  for (const candidate of candidates) {
    if (!await exists(path.join(candidate, "package.json"))) continue;
    try { return await verifyElevenLabsPackage(candidate); }
    catch (error) { if (error instanceof ElevenLabsError) versionError = error; }
  }
  if (versionError) throw versionError;
  throw new ElevenLabsError("ELEVENLABS_NOT_FOUND", `未找到 ElevenLabs CLI，请双击 start.cmd 自动准备，或运行 npm install -g @elevenlabs/cli@${ELEVENLABS_CLI_VERSION}。`, 409);
}
