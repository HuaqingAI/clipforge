import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { KlingError } from "./errors";
import { KLING_PACKAGE, KLING_VERSION, type KlingProfile } from "./types";

export function buildControlledCliEnvironment(profile: Pick<KlingProfile, "homePath">, login = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "LANG", "LC_ALL"]) if (process.env[key]) env[key] = process.env[key];
  env.KLING_HOME = profile.homePath;
  env.KLING_NONINTERACTIVE = login ? "0" : "1";
  env.NO_COLOR = "1";
  return env;
}

async function exists(file: string): Promise<boolean> { try { await fs.access(file); return true; } catch { return false; } }

/** The local launcher supplies an installation, never an account or credential home. */
export function getDefaultKlingPackagePath(): string {
  const value = process.env.CLIPFORGE_KLING_PACKAGE_PATH?.trim() ?? "";
  return value && value.length <= 2048 && !/[\x00\r\n]/.test(value) && path.isAbsolute(value) ? value : "";
}

export async function discoverPackagePath(): Promise<string> {
  const prepared = getDefaultKlingPackagePath();
  if (prepared) return prepared;
  const roots = [process.env.APPDATA && path.join(process.env.APPDATA, "npm", "node_modules"), process.env.npm_config_prefix && path.join(process.env.npm_config_prefix, "node_modules"), path.resolve(path.dirname(process.execPath), "node_modules"), path.resolve(path.dirname(process.execPath), "../lib/node_modules"), "/usr/local/lib/node_modules", "/usr/lib/node_modules", path.join(os.homedir(), ".npm-global/lib/node_modules")].filter((v): v is string => !!v);
  for (const root of roots) { const candidate = path.join(root, "@klingai", "cli-global"); if (await exists(path.join(candidate, "package.json"))) return candidate; }
  return "";
}

export async function verifyInstallation(profile: KlingProfile): Promise<Pick<KlingProfile, "nodePath" | "packagePath" | "cliEntry" | "cliVersion">> {
  const nodeInput = profile.nodePath || process.execPath;
  if (!path.isAbsolute(nodeInput) || !/^node(?:\.exe)?$/i.test(path.basename(nodeInput))) throw new KlingError("KLING_NODE_UNAVAILABLE", "请选择本机 Node.js 的 node 可执行文件。", 400);
  let nodePath: string;
  try { nodePath = await fs.realpath(nodeInput); } catch { throw new KlingError("KLING_NODE_UNAVAILABLE", "未找到配置的 Node.js，请检查路径。", 400); }
  let packageInput = profile.packagePath || await discoverPackagePath();
  if (!packageInput) throw new KlingError("KLING_NOT_FOUND", "未找到 Kling CLI。请先安装 @klingai/cli-global@0.2.0，或指定包目录。", 400);
  if (!path.isAbsolute(packageInput)) throw new KlingError("KLING_INVALID_PACKAGE", "CLI 包目录必须使用绝对路径。", 400);
  if (path.basename(packageInput) === "package.json") packageInput = path.dirname(packageInput);
  if (path.basename(packageInput) === "cli.js") packageInput = path.resolve(packageInput, "../..");
  let packagePath: string; let manifest: Record<string, unknown>;
  try { packagePath = await fs.realpath(packageInput); manifest = JSON.parse(await fs.readFile(path.join(packagePath, "package.json"), "utf8")); } catch { throw new KlingError("KLING_INVALID_PACKAGE", "目录中没有有效的 Kling package.json。", 400); }
  if (manifest.name !== KLING_PACKAGE) throw new KlingError("KLING_INVALID_PACKAGE", "仅支持官方 Global 包 @klingai/cli-global。", 400);
  if (manifest.version !== KLING_VERSION) throw new KlingError("KLING_UNSUPPORTED_VERSION", "当前仅支持 Kling CLI 0.2.0，请安装固定版本。", 400);
  if ((manifest.bin as Record<string, unknown> | undefined)?.kling !== "dist/cli.js") throw new KlingError("KLING_INVALID_PACKAGE", "CLI 的入口与已验证版本不一致。", 400);
  if (await exists(path.join(packagePath, ".credentials"))) throw new KlingError("KLING_LEGACY_CREDENTIALS", "CLI 安装目录中有旧版凭据，请先自行处理旧安装；应用不会读取或迁移该凭据。", 409);
  let cliEntry: string;
  try { cliEntry = await fs.realpath(path.join(packagePath, "dist/cli.js")); } catch { throw new KlingError("KLING_INVALID_PACKAGE", "CLI 入口 dist/cli.js 不存在。", 400); }
  if (path.relative(packagePath, cliEntry).startsWith("..") || path.isAbsolute(path.relative(packagePath, cliEntry))) throw new KlingError("KLING_INVALID_PACKAGE", "CLI 入口必须位于所选安装包内。", 400);
  return { nodePath, packagePath, cliEntry, cliVersion: KLING_VERSION };
}

/** Environment checks run only verified entrypoints; never a shell, npx or npm installation. */
export async function probeExecutable(nodePath: string, args: string[], profile: KlingProfile): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(nodePath, args, { shell: false, windowsHide: true, env: buildControlledCliEnvironment(profile), stdio: ["ignore", "pipe", "pipe"], cwd: profile.homePath });
    let output = ""; let excessive = false;
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (Buffer.byteLength(output) > 32_768) { excessive = true; child.kill(); } });
    child.stderr.resume();
    child.once("error", () => { clearTimeout(timer); reject(new KlingError("KLING_NODE_UNAVAILABLE", "Node.js 无法启动，请检查可执行文件。", 400)); });
    child.once("close", (code) => { clearTimeout(timer); if (code !== 0 || excessive) reject(new KlingError("KLING_ENVIRONMENT_FAILED", "CLI 环境检测失败，请检查固定版本安装和 Node.js。", 400)); else resolve(output.trim()); });
  });
}

export async function inspectEnvironment(profile: KlingProfile): Promise<KlingProfile> {
  const verified = await verifyInstallation(profile);
  await fs.mkdir(profile.homePath, { recursive: true, mode: 0o700 });
  const current = { ...profile, ...verified };
  const nodeVersion = await probeExecutable(verified.nodePath, ["--version"], current);
  if (!/^v(2[0-9]|[3-9][0-9])\./.test(nodeVersion)) throw new KlingError("KLING_NODE_UNAVAILABLE", "请使用 Node.js 20 或更新版本。", 400);
  const cliVersion = await probeExecutable(verified.nodePath, [verified.cliEntry, "--version"], current);
  if (cliVersion !== `kling-cli ${KLING_VERSION}`) throw new KlingError("KLING_UNSUPPORTED_VERSION", "CLI 实际版本与配置不一致。", 400);
  return { ...current, environmentState: "ready", environmentCheckedAt: Date.now(), environmentError: undefined };
}
