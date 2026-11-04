// Node built-ins only: start.cmd can initialize this runtime on a clean checkout.
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ALIGNMENT_SPEC, alignmentEnvironment, alignmentPaths, probeAlignmentRuntime } from "./lib/alignment-runtime.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UV_VERSION = "0.11.31";

export async function fileMatches(file, expected) {
  try {
    if (statSync(file).size !== expected.size) return false;
    const hash = createHash("sha256");
    const handle = await open(file);
    try { for await (const chunk of handle.createReadStream()) hash.update(chunk); }
    finally { await handle.close(); }
    return hash.digest("hex") === expected.sha256;
  } catch { return false; }
}

async function download(url, file, { expected, log = console.log } = {}) {
  const partial = `${file}.${process.pid}.part`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let handle;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      handle = await open(partial, "w");
      let bytes = 0;
      let lastReported = 0;
      for await (const chunk of response.body) {
        await handle.write(chunk);
        bytes += chunk.length;
        if (bytes - lastReported > 32 * 1024 * 1024) {
          log(`音频对齐模型已下载 ${(bytes / 1024 ** 2).toFixed(0)} MiB`);
          lastReported = bytes;
        }
      }
      await handle.close(); handle = undefined;
      if (expected && !(await fileMatches(partial, expected))) throw new Error("下载文件的大小或 SHA256 校验失败");
      await rename(partial, file);
      return;
    } catch (error) {
      if (handle) await handle.close();
      await rm(partial, { force: true });
      if (attempt === 3) throw new Error(`无法下载 ${url}：${error.message}。请检查网络，再双击 start.cmd 重试。`);
      log(`下载未完成，正在重试 (${attempt}/3)：${error.message}`);
    }
  }
}

function run(executable, args, env, { capture = false } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(executable, args, { cwd: ROOT, env, windowsHide: true, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let output = "";
    let errors = "";
    if (capture) {
      child.stdout.on("data", data => { output += data; });
      child.stderr.on("data", data => { errors = (errors + data).slice(-12_000); });
    }
    child.once("error", reject);
    child.once("exit", code => code === 0 ? done(output.trim()) : reject(new Error(`${executable} 执行失败 (${code})${errors ? `：${errors}` : "；请查看上方安装日志"}`)));
  });
}

export function compatiblePython(executable, prefix = [], env = process.env) {
  const result = spawnSync(executable, [...prefix, "-c", "import struct,sys; print(sys.executable if sys.version_info[:2] in [(3,12),(3,13)] and struct.calcsize('P') == 8 else '')"], {
    env, encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

async function portableUv(runtime, env, log) {
  // The managed installer is needed only when no compatible local Python exists.
  const executable = join(runtime, "uv", process.platform === "win32" ? "uv.exe" : "uv");
  if (existsSync(executable)) return executable;
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("未找到 Python 3.12/3.13。请先安装兼容的 64 位 Python，再启动项目。Windows x64 会自动准备便携 Python。");
  }
  const directory = dirname(executable);
  mkdirSync(directory, { recursive: true });
  const name = "uv-x86_64-pc-windows-msvc.zip";
  const base = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;
  const archive = join(directory, name);
  const checksum = await fetch(`${base}/${name}.sha256`, { signal: AbortSignal.timeout(60_000) });
  if (!checksum.ok) throw new Error(`无法读取便携 Python 安装工具校验清单 (HTTP ${checksum.status})`);
  const hash = (await checksum.text()).match(/\b[0-9a-f]{64}\b/i)?.[0]?.toLowerCase();
  if (!hash) throw new Error("便携 Python 安装工具的校验清单无效");
  log("正在下载便携 Python 安装工具（仅保存到项目目录）...");
  await download(`${base}/${name}`, archive, { log });
  const actual = createHash("sha256").update(await readFile(archive)).digest("hex");
  if (actual !== hash) throw new Error("便携 Python 安装工具 SHA256 校验失败");
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // Pass paths through the environment; native PowerShell 5.1 argument quoting
  // cannot safely transport arbitrary checkout names inside a command string.
  await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", "Expand-Archive -LiteralPath $env:APP_UV_ARCHIVE -DestinationPath $env:APP_UV_DIRECTORY -Force"],
    { ...env, APP_UV_ARCHIVE: archive, APP_UV_DIRECTORY: directory });
  unlinkSync(archive);
  if (!existsSync(executable)) throw new Error("便携 Python 安装工具解压失败");
  return executable;
}

async function prepareAlignment({ root = ROOT, env: suppliedEnv = process.env, log = console.log } = {}) {
  const env = alignmentEnvironment(root, suppliedEnv);
  const paths = alignmentPaths(root, env);
  mkdirSync(paths.runtime, { recursive: true });
  // Recheck the model and native CPU inference even if a previous ready stamp
  // exists. A partially deleted or corrupt runtime must never appear ready.
  if (probeAlignmentRuntime(root, env, { writeReady: true }).status === 0) {
    log("WhisperX 英文音频对齐环境和模型已就绪，复用本地安装。");
    return paths;
  }
  if (existsSync(paths.ready)) unlinkSync(paths.ready);
  if (!compatiblePython(paths.python, [], env)) {
    let python = compatiblePython("python", [], env) || compatiblePython("python3", [], env);
    if (!python && process.platform === "win32") python = compatiblePython("py", ["-3.12"], env) || compatiblePython("py", ["-3.13"], env);
    if (python) {
      log("正在创建项目独立 Python 音频对齐环境...");
      await run(python, ["-m", "venv", join(paths.runtime, ".venv")], env);
    } else {
      const uv = await portableUv(paths.runtime, env, log);
      const pythonEnv = { ...env, UV_PYTHON_INSTALL_DIR: join(paths.runtime, "python"), UV_PYTHON_BIN_DIR: join(paths.runtime, "python-bin") };
      log("正在下载项目独立 Python 3.12（不修改系统 Python）...");
      await run(uv, ["python", "install", "3.12", "--no-bin", "--no-registry"], pythonEnv);
      await run(uv, ["venv", "--python", "3.12", "--managed-python", "--seed", join(paths.runtime, ".venv")], pythonEnv);
    }
  }
  const packages = spawnSync(paths.python, [paths.checker, "--runtime-dir", paths.runtime, "--packages-only"], { cwd: root, env, windowsHide: true, timeout: 90_000, encoding: "utf8" });
  if (packages.status !== 0) {
    log("正在安装 CPU 音频对齐依赖（首次下载较大，无需显卡、无需音频 API 密钥）...");
    await run(paths.python, ["-m", "ensurepip", "--upgrade"], env);
    const pip = ["-m", "pip", "install", "--disable-pip-version-check", "--prefer-binary", "--retries", "3", "--timeout", "90"];
    await run(paths.python, [...pip, "torch==2.8.0", "torchaudio==2.8.0", ...(process.platform === "darwin" ? [] : ["--index-url", "https://download.pytorch.org/whl/cpu"])], env);
    await run(paths.python, [...pip, "-r", join(root, "scripts", "alignment", "requirements.txt")], env);
    await run(paths.python, [...pip, "--no-deps", `whisperx==${ALIGNMENT_SPEC.packages.whisperx}`], env);
  }
  mkdirSync(paths.model, { recursive: true });
  for (const item of ALIGNMENT_SPEC.modelFiles) {
    const target = join(paths.model, item.name);
    if (await fileMatches(target, item)) continue;
    const previous = join(root, ".clipforge", "validation", "english-alignment", "model", item.name);
    if (await fileMatches(previous, item)) {
      log(`复用已验证的英文对齐模型：${item.name}`);
      copyFileSync(previous, target);
    } else {
      log(`正在下载英文对齐模型：${item.name}`);
      await download(`https://huggingface.co/${ALIGNMENT_SPEC.model}/resolve/${ALIGNMENT_SPEC.modelRevision}/${item.name}`, target, { expected: item, log });
    }
  }
  const previousTokenizer = join(root, ".clipforge", "validation", "english-alignment", "nltk-data", "tokenizers", "punkt_tab", "english");
  const tokenizer = join(paths.runtime, "nltk-data", "tokenizers", "punkt_tab", "english");
  if (!existsSync(tokenizer) && existsSync(previousTokenizer)) cpSync(previousTokenizer, tokenizer, { recursive: true });
  log("正在校验模型和英文分词资源，执行本地 CPU 推理检查...");
  await run(paths.python, [paths.checker, "--runtime-dir", paths.runtime, "--prepare-nltk", "--write-ready"], env);
  log("WhisperX 英文音频对齐已就绪；仅使用已有文案做对齐，不加载 Whisper 转写模型。");
  return paths;
}

export async function setupAlignment(options = {}) {
  const root = options.root || ROOT;
  const runtime = alignmentPaths(root, options.env || process.env).runtime;
  mkdirSync(runtime, { recursive: true });
  const file = join(runtime, ".setup.lock");
  let lock;
  for (let attempt = 0; !lock && attempt < 1800; attempt++) {
    try {
      lock = await open(file, "wx");
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner;
      try { owner = JSON.parse(await readFile(file, "utf8")); } catch { /* owner may still be writing */ }
      let alive = true;
      if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; }
      } else {
        try { if (Date.now() - statSync(file).mtimeMs > 30_000) alive = false; }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
      }
      if (!alive) { await rm(file, { force: true }); continue; }
      if (attempt % 30 === 0) (options.log || console.log)("另一个启动窗口正在准备音频对齐环境，正在等待完成...");
      await new Promise(done => setTimeout(done, 1000));
    }
  }
  if (!lock) throw new Error("等待音频对齐环境初始化超时，请查看另一个启动窗口后重试。");
  try { return await prepareAlignment(options); }
  finally { await lock.close(); await rm(file, { force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setupAlignment().catch(error => { console.error(`音频对齐环境初始化失败：${error.message}`); process.exitCode = 1; });
}
