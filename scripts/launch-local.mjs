// Source checkout launcher. Runs with Node built-ins before dependencies exist.
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { localBuildStatus } from "./lib/local-build.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEPENDENCY_PATHS = ["package.json", "pnpm-lock.yaml", ".npmrc", ".pnpmrc.json", "pnpm-workspace.yaml"];

export function buildInputPaths(root) {
  return [
    ...DEPENDENCY_PATHS,
    "src", "public", "drizzle", "scripts/start-standalone.mjs", "next.config.ts", "tsconfig.json",
    "next-env.d.ts", "postcss.config.mjs",
    ...readdirSync(root).filter((name) => name === ".env" || name.startsWith(".env.")),
  ];
}

const KLING_PACKAGE = "@klingai/cli-global";
const KLING_VERSION = "0.2.0";

export function compatibleNode(version) {
  const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
  return (major === 22 && minor >= 13) || major === 24;
}

export function fingerprint(root, paths, runtime = `${process.version}/${process.versions.modules}/${process.platform}/${process.arch}`) {
  const hash = createHash("sha256").update(`clipforge-launcher-v1\0${runtime}\0`);
  function visit(file) {
    if (!existsSync(file)) { hash.update(`missing:${relative(root, file)}\0`); return; }
    const directory = readdirSafe(file);
    if (directory) {
      for (const entry of directory.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
        if (entry.isDirectory() || entry.isFile()) visit(join(file, entry.name));
      }
    } else {
      hash.update(relative(root, file).replaceAll("\\", "/") + "\0");
      hash.update(readFileSync(file)).update("\0");
    }
  }
  for (const name of [...paths].sort()) visit(join(root, name));
  return hash.digest("hex");
}
function readdirSafe(file) { try { return readdirSync(file, { withFileTypes: true }); } catch (error) { if (error.code === "ENOTDIR") return null; throw error; } }

export function healthyInstance(health, instanceId) {
  return health?.app === "clipforge" && health.instanceId === instanceId && health.db?.status === "ok" && !health.db.initError && !health.db.migrationError;
}
export async function readHealth(url) {
  try { const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3000) }); return response.ok ? await response.json() : null; } catch { return null; }
}
export async function portAvailable(port) {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen(port, "127.0.0.1", () => server.close(() => done(true)));
  });
}
function json(file) { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } }
function writeJson(file, value) { const temporary = `${file}.${process.pid}.tmp`; writeFileSync(temporary, JSON.stringify(value, null, 2)); renameSync(temporary, file); }
function processAlive(pid) { try { if (!Number.isSafeInteger(pid) || pid <= 0) return false; process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } }

export function acquireLock(file) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); } finally { closeSync(fd); }
      return () => { if (json(file)?.pid === process.pid) { try { unlinkSync(file); } catch { /* already removed */ } } };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = json(file);
      // A partial lock may belong to a process that is currently writing it.
      if (!owner) {
        try { if (Date.now() - statSync(file).mtimeMs < 30000) return null; } catch { continue; }
      } else if (processAlive(owner.pid)) return null;
      try { unlinkSync(file); } catch { return null; }
    }
  }
  return null;
}

export function probeDependencies(root, env, standalone = false) {
  // Run native modules in a fresh process, using the runtime that will serve the app.
  // Also inspect Next's hashed external copies: desktop bundling can change their ABI.
  const probe = `
    const {createRequire}=require('node:module');
    const {join}=require('node:path');
    const {existsSync,readdirSync}=require('node:fs');
    const root=${JSON.stringify(root)};
    const standalone=${JSON.stringify(standalone)};
    const distDirName='.next';
    const base=standalone?join(root,distDirName,'standalone'):root;
    const req=createRequire(join(base,'package.json'));
    for(const name of standalone?['next','react']:['next','react','typescript','@tailwindcss/postcss']) req.resolve(name);
    const databases=[req('better-sqlite3')];
    const externals=join(base,distDirName,'node_modules');
    if(standalone && existsSync(externals)) for(const name of readdirSync(externals)) {
      if(name.startsWith('better-sqlite3')) databases.push(req(join(externals,name)));
    }
    for(const DB of databases) { const db=new DB(':memory:');db.prepare('SELECT 1').get();db.close(); }
    for(const p of [process.env.FFMPEG_PATH||req('ffmpeg-static'),process.env.FFPROBE_PATH||req('@ffprobe-installer/ffprobe').path]) {
      if(!p) throw Error('Missing media binary');
      require('node:child_process').execFileSync(p,['-version'],{stdio:'ignore',windowsHide:true});
    }
  `;
  return spawnSync(process.execPath, ["-e", probe], { cwd: root, env, windowsHide: true, encoding: "utf8", timeout: 30000 });
}

function openBrowser(url) {
  const command = process.platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: "ignore", windowsHide: true });
  child.once("error", () => console.log(`请手动打开：${url}`));
  child.unref();
}
function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    // Only this launcher's own child tree; never kill every node.exe on the machine.
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else child.kill("SIGTERM");
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { port: { type: "string" }, "no-browser": { type: "boolean" }, check: { type: "boolean" }, help: { type: "boolean" } } });
  if (values.help) { console.log("Usage: node scripts/launch-local.mjs [--port 3000] [--no-browser] [--check]\nWindows: double-click start.cmd. Keep the console open; Ctrl+C stops the service."); return; }
  if (!compatibleNode(process.version)) throw new Error("请使用 Node.js 22.13+ 或 24 LTS，或双击 start.cmd 自动准备便携 Node。");
  if (process.platform === "win32" && process.arch !== "x64") throw new Error("Windows 媒体依赖需要 x64 Node.js；请使用 start.cmd 自动准备兼容环境。");
  const port = Number(values.port ?? "3000");
  if (!/^\d+$/.test(values.port ?? "3000") || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口必须是 1 到 65535 之间的整数。");
  const root = realpathSync(ROOT);
  const local = join(root, ".clipforge");
  const instanceId = createHash("sha256").update(root).digest("hex");
  const url = `http://127.0.0.1:${port}`;
  const browserUrl = `${url}/settings`;
  const distDirName = ".next";
  const distDir = join(root, distDirName);
  const standaloneDir = join(distDir, "standalone");
  const manifest = json(join(root, "package.json"));
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(manifest?.packageManager ?? "")) throw new Error("package.json 中缺少固定的 pnpm 版本。");
  const pnpmVersion = manifest.packageManager.slice(5);
  const npmCli = process.env.CLIPFORGE_NPM_CLI || join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const pnpmPrefix = join(local, "tools", "pnpm");
  const pnpmEntry = join(pnpmPrefix, "node_modules", "pnpm", "bin", "pnpm.cjs");
  const klingPrefix = join(local, "tools", "kling");
  const klingPackage = join(klingPrefix, "node_modules", "@klingai", "cli-global");
  const env = { ...process.env, PATH: `${dirname(process.execPath)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH || ""}`, ELECTRON_SKIP_BINARY_DOWNLOAD: "1", NEXT_TELEMETRY_DISABLED: "1", CLIPFORGE_INSTANCE_ID: instanceId, CLIPFORGE_KLING_PACKAGE_PATH: klingPackage };
  // Do not pass a terminal's inherited Electron mode to the actual Node runtime.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CLIPFORGE_RUNTIME;
  delete env.NODE_ENV;
  const pnpmReady = () => json(join(pnpmPrefix, "node_modules/pnpm/package.json"))?.version === pnpmVersion && existsSync(pnpmEntry);
  const klingReady = () => json(join(klingPackage, "package.json"))?.version === KLING_VERSION && existsSync(join(klingPackage, "dist", "cli.js"));
  if (values.check) {
    const probe = probeDependencies(root, env);
    console.log(`Node ${process.version} (${process.arch})\npnpm: ${json(join(pnpmPrefix, "node_modules/pnpm/package.json"))?.version ?? "未准备"}\nKling CLI: ${json(join(klingPackage, "package.json"))?.version ?? "未准备"}\nSQLite / FFmpeg / FFprobe: ${probe.status === 0 ? "可用" : "需要安装或修复"}\n地址: ${browserUrl}`);
    if (probe.status !== 0 || !pnpmReady() || !klingReady()) throw new Error("环境检查未通过；正常双击启动会安装或修复依赖。" );
    return;
  }
  if (!(await portAvailable(port))) {
    const health = await readHealth(url);
    if (!healthyInstance(health, instanceId)) throw new Error(`端口 ${port} 已被其他服务占用，或当前服务的数据库未就绪。请检查原启动窗口；不会自动切换端口。`);
    console.log(`ClipForge 已在运行：${browserUrl}`);
    if (!values["no-browser"]) openBrowser(browserUrl);
    return;
  }
  mkdirSync(join(local, "logs"), { recursive: true });
  const release = acquireLock(join(local, "launcher.lock"));
  if (!release) { console.log("另一个启动窗口正在安装、构建或启动，请查看该窗口。"); return; }
  const logFile = join(local, "logs", "launcher.log");
  writeFileSync(logFile, `ClipForge ${new Date().toISOString()} Node ${process.version}\n`);
  let activeChild;
  let stopping = false;
  const stop = () => { stopping = true; stopChild(activeChild); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  function log(message) { console.log(message); appendFileSync(logFile, message + "\n"); }
  function start(script, arguments_) {
    if (stopping) throw new Error("启动已停止。");
    const child = spawn(process.execPath, [script, ...arguments_], { cwd: root, env, windowsHide: true, stdio: ["inherit", "pipe", "pipe"] });
    activeChild = child;
    for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) stream.on("data", (data) => { destination.write(data); appendFileSync(logFile, data); });
    // Attach exit handlers immediately so a fast failure during health polling is observable.
    child.completion = new Promise((done) => { child.once("error", (error) => done({ error })); child.once("exit", (code, signal) => done({ code, signal })); });
    return child;
  }
  async function run(script, arguments_) {
    const child = start(script, arguments_);
    const result = await child.completion;
    if (activeChild === child) activeChild = undefined;
    if (stopping) throw new Error("启动已停止。");
    if (result.error || result.code !== 0) throw new Error(`命令执行失败：${result.error?.message || `exit ${result.code}`}。详情见 ${logFile}`);
  }
  try {
    log("ClipForge 本机网页版启动器（首次安装与构建可能需要数分钟）");
    if (!existsSync(npmCli)) throw new Error("当前 Node.js 没有 npm。请使用 start.cmd 自动准备完整 Node.js。");
    if (!pnpmReady()) {
      log(`[1/5] 准备 pnpm ${pnpmVersion}（仅安装到项目目录）`);
      await run(npmCli, ["install", "--prefix", pnpmPrefix, "--no-audit", "--no-fund", "--ignore-scripts", "--save-exact", `pnpm@${pnpmVersion}`]);
    }
    const dependencyPaths = DEPENDENCY_PATHS;
    const dependenciesHash = fingerprint(root, dependencyPaths);
    const installed = json(join(local, "dependencies.json"));
    if (installed?.fingerprint !== dependenciesHash || probeDependencies(root, env).status !== 0) {
      log("[2/5] 安装项目依赖（保留 SQLite 和媒体工具安装脚本，跳过 Electron 下载）");
      await run(pnpmEntry, ["install", "--frozen-lockfile", "--prod=false", "--config.confirmModulesPurge=false", "--config.ignore-scripts=false"]);
      let probe = probeDependencies(root, env);
      if (probe.status !== 0) {
        log("修复当前 Node 版本所需的 SQLite / 媒体二进制...");
        await run(pnpmEntry, ["rebuild", "better-sqlite3", "ffmpeg-static", "@ffprobe-installer/ffprobe"]);
        probe = probeDependencies(root, env);
      }
      if (probe.status !== 0) throw new Error(`SQLite / FFmpeg / FFprobe 无法运行。请检查下载网络和系统架构。${probe.stderr?.trim() || probe.error?.message || ""}`);
      writeJson(join(local, "dependencies.json"), { fingerprint: dependenciesHash });
    } else log("[2/5] 项目依赖与媒体工具可用，复用现有安装。");
    if (!klingReady()) {
      log(`[3/5] 准备 Kling Global CLI ${KLING_VERSION}（不登录、不生成）`);
      await run(npmCli, ["install", "--prefix", klingPrefix, "--no-audit", "--no-fund", "--ignore-scripts", "--save-exact", `${KLING_PACKAGE}@${KLING_VERSION}`]);
    } else log("[3/5] Kling CLI 已准备。");
    const buildPaths = buildInputPaths(root);
    const built = json(join(local, "build.json"));
    const entry = join(standaloneDir, "server.js");
    const buildStatus = localBuildStatus(root, distDirName);
    if (built?.fingerprint !== fingerprint(root, buildPaths) || !buildStatus.buildId || built.buildId !== buildStatus.buildId || !buildStatus.ok || !existsSync(entry) || probeDependencies(root, env, true).status !== 0) {
      log("[4/5] 构建本机网页版（源码或配置更新后自动重建）");
      await run(pnpmEntry, ["run", "build"]);
      const rebuiltStatus = localBuildStatus(root, distDirName);
      if (!rebuiltStatus.ok || !rebuiltStatus.buildId || !existsSync(entry)) {
        throw new Error(`构建没有生成完整的 standalone 服务：${rebuiltStatus.missing.slice(0, 8).join(", ") || "缺少关键产物"}`);
      }
      const probe = probeDependencies(root, env, true);
      if (probe.status !== 0) throw new Error(`构建中的数据库或媒体依赖无法运行：${probe.stderr?.trim() || probe.error?.message || "未知错误"}`);
      writeJson(join(local, "build.json"), { fingerprint: fingerprint(root, buildPaths), buildId: rebuiltStatus.buildId });
    } else log("[4/5] 源码未变化，复用生产构建。");
    log(`[5/5] 启动 ${browserUrl}；请保留此窗口，按 Ctrl+C 停止。`);
    const server = start(join(root, "scripts", "start-standalone.mjs"), ["--port", String(port), "--hostname", "127.0.0.1"]);
    let ready = false;
    for (let attempt = 0; attempt < 120 && !stopping; attempt++) {
      const health = await readHealth(url);
      if (healthyInstance(health, instanceId)) { ready = true; break; }
      if (health?.app === "clipforge" && health.instanceId === instanceId && (health.db?.initError || health.db?.migrationError)) throw new Error("数据库初始化或迁移失败，请查看上方日志。");
      if (server.exitCode !== null || server.signalCode !== null) break;
      await new Promise((done) => setTimeout(done, 500));
    }
    if (!ready) throw new Error(stopping ? "服务已停止。" : "服务未就绪，请查看上方错误及启动日志。");
    log(`已就绪：${browserUrl}\nKling：在设置中启用平台，保存预填路径、检测环境并登录，再选择默认视频模型。`);
    if (!values["no-browser"]) openBrowser(browserUrl);
    const result = await server.completion;
    activeChild = undefined;
    if (!stopping && (result.error || result.code !== 0)) throw new Error(`本机服务已退出：${result.error?.message ?? result.code}`);
  } catch (error) {
    if (stopping) log("ClipForge 已停止。");
    else { log(`启动失败：${error.message}`); throw error; }
  } finally {
    stopChild(activeChild);
    release();
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`\n启动失败：${error.message}`); process.exitCode = 1; });
}
