/* Install pinned upstream artifacts from reviewed mirrors or official sources.
 * No self-hosted release fallback,
 * package index resolution, system Python/npm, or shell extraction is involved. */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const manager = require("./runtime-manager.cjs");
const { validateResourceMirrors } = require("./runtime-sources.cjs");
const { safeRelative, inside, sourceUrl, matches, writeJson, manifestDigest, resolvedPaths, run, acquireLock, checkAbort, REQUIRED_PATHS } = manager._internals;

const MAX_EXPANDED = 8 * 1024 ** 3;
const FORMATS = new Set(["zip", "tgz", "gzip", "file", "wheel"]);
const OFFICIAL_HOSTS = new Set(["nodejs.org", "www.python.org", "registry.npmjs.org", "files.pythonhosted.org", "download.pytorch.org", "download-r2.pytorch.org", "huggingface.co", "raw.githubusercontent.com", "github.com"]);

function validateOfficialManifest(manifest, { platform = process.platform, arch = process.arch, allowHttpForTests = false } = {}) {
  if (manifest?.schemaVersion !== 2 || manifest.installMode !== "official-sources" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/.test(manifest.runtimeId || "")) throw new Error("官方运行资源清单版本或标识无效");
  if (manifest.platform !== platform || manifest.arch !== arch) throw new Error(`运行资源不支持当前平台 ${platform}-${arch}`);
  if (!/^\d+\.\d+\.\d+$/.test(manifest.nodeVersion || "") || !Number.isSafeInteger(manifest.nodeAbi)) throw new Error("官方运行资源未固定 Node 版本与 ABI");
  if (!Array.isArray(manifest.resources) || !manifest.resources.length) throw new Error("官方运行资源清单为空");
  const ids = new Map();
  for (const resource of manifest.resources) {
    if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(resource.id || "") || ids.has(resource.id)) throw new Error("官方资源标识无效或重复");
    ids.set(resource.id, resource);
    const url = sourceUrl(resource.url, allowHttpForTests);
    if (!(allowHttpForTests && url.protocol === "http:") && !OFFICIAL_HOSTS.has(url.hostname)) throw new Error(`运行资源必须来自官方上游：${url.hostname}`);
    if (url.hostname === "github.com" && !url.pathname.startsWith("/eugeneware/ffmpeg-static/releases/download/")) throw new Error("GitHub 资源只能使用 FFmpeg 官方发行来源，不能使用自建运行资源包");
    validateResourceMirrors(resource, { allowHttpForTests });
    if (!Number.isSafeInteger(resource.size) || resource.size <= 0 || !/^[a-f0-9]{64}$/.test(resource.sha256 || "") || !FORMATS.has(resource.format)) throw new Error(`官方资源 ${resource.id} 缺少固定大小、SHA256 或格式`);
    safeRelative(resource.target);
    if (resource.stripPrefix) safeRelative(resource.stripPrefix.replace(/\/$/, ""));
    if (resource.format === "wheel") {
      const filename = wheelFilename(resource);
      if (!filename.endsWith(".whl") || filename.includes("/")) throw new Error("Python wheel 文件名无效");
      if (resource.role !== "pip" && !/^[A-Za-z0-9_.-]+==[A-Za-z0-9_.+!-]+$/.test(resource.pythonRequirement || "")) throw new Error("Python 依赖必须使用固定版本");
    }
  }
  for (const key of REQUIRED_PATHS) safeRelative(manifest.paths?.[key]);
  safeRelative(manifest.paths?.elevenLabsExecutable);
  if (!/^3\.12\.\d+$/.test(manifest.python?.version || "") || ids.get(manifest.python.pipResourceId)?.role !== "pip" || ids.get(manifest.python.pipResourceId)?.format !== "wheel" || !Array.isArray(manifest.python.wheelResourceIds) || !manifest.python.wheelResourceIds.length) throw new Error("官方便携 Python 配置不完整");
  const wheels = new Set();
  for (const id of manifest.python.wheelResourceIds) {
    if (wheels.has(id) || ids.get(id)?.format !== "wheel" || !ids.get(id).pythonRequirement) throw new Error("Python wheel 依赖清单无效或重复");
    wheels.add(id);
  }
  if (!Array.isArray(manifest.supportFiles) || !manifest.supportFiles.length) throw new Error("安装器缺少应用配套脚本清单");
  const support = new Set();
  for (const file of manifest.supportFiles) {
    safeRelative(file.path);
    if (support.has(file.path.toLowerCase()) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256 || "")) throw new Error("应用配套脚本清单无效");
    support.add(file.path.toLowerCase());
  }
  for (const required of [manifest.paths.alignmentCheckerPath, "alignment/scripts/align.py", "alignment/scripts/runtime-spec.json", "media/fonts/subtitle.otf"]) if (!support.has(required.toLowerCase())) throw new Error(`安装器缺少配套文件 ${required}`);
  return manifest;
}

function wheelFilename(resource) {
  const filename = resource.fileName || decodeURIComponent(new URL(resource.url).pathname.split("/").pop());
  safeRelative(filename);
  if (filename.includes("/")) throw new Error("wheel 文件名不能包含目录");
  return filename;
}
function archiveName(name) {
  const normalized = name.replace(/\/$/, "");
  if (!normalized) return "";
  return safeRelative(normalized);
}
function outputName(name, prefix) {
  if (!prefix) return name;
  prefix = prefix.replace(/\/$/, "");
  if (name === prefix) return "";
  return name.startsWith(`${prefix}/`) ? name.slice(prefix.length + 1) : null;
}
async function readAt(handle, length, position) {
  const buffer = Buffer.alloc(length); let offset = 0;
  while (offset < length) { const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset); if (!bytesRead) throw new Error("官方 ZIP 文件已截断"); offset += bytesRead; }
  return buffer;
}

/** Parse central-directory ZIPs with built-in zlib. Entry sizes, CRCs, paths,
 * duplicates and Unix link bits are checked before writing private staging. */
async function extractZip(archive, destination, { stripPrefix, signal, maxExpandedSize = MAX_EXPANDED } = {}) {
  const handle = await fsp.open(archive, "r");
  try {
    const size = (await handle.stat()).size;
    const tail = await readAt(handle, Math.min(size, 65557), Math.max(0, size - 65557));
    let end = -1;
    for (let offset = tail.length - 22; offset >= 0; offset--) if (tail.readUInt32LE(offset) === 0x06054b50 && offset + 22 + tail.readUInt16LE(offset + 20) === tail.length) { end = offset; break; }
    if (end < 0) throw new Error("官方 ZIP 缺少目录记录");
    const count = tail.readUInt16LE(end + 10); const directorySize = tail.readUInt32LE(end + 12); const directoryOffset = tail.readUInt32LE(end + 16);
    if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || count !== tail.readUInt16LE(end + 8) || count === 65535 || directorySize > 64 * 1024 ** 2 || directoryOffset + directorySize > size) throw new Error("不支持的多卷或 ZIP64 官方资源");
    const directory = await readAt(handle, directorySize, directoryOffset); const seen = new Set(); let cursor = 0; let expanded = 0; let selected = 0;
    await fsp.mkdir(destination, { recursive: true });
    for (let index = 0; index < count; index++) {
      checkAbort(signal);
      if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== 0x02014b50) throw new Error("官方 ZIP 目录损坏");
      const flags = directory.readUInt16LE(cursor + 8); const method = directory.readUInt16LE(cursor + 10); const crc = directory.readUInt32LE(cursor + 16); const compressedSize = directory.readUInt32LE(cursor + 20); const expandedSize = directory.readUInt32LE(cursor + 24);
      const nameLength = directory.readUInt16LE(cursor + 28); const extraLength = directory.readUInt16LE(cursor + 30); const commentLength = directory.readUInt16LE(cursor + 32); const mode = directory.readUInt32LE(cursor + 38) >>> 16; const localOffset = directory.readUInt32LE(cursor + 42);
      const rawName = directory.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8"); const name = archiveName(rawName);
      cursor += 46 + nameLength + extraLength + commentLength;
      if (cursor > directory.length || !name || seen.has(name.toLowerCase()) || flags & 1 || ![0, 8].includes(method) || (mode & 0xf000) === 0xa000) throw new Error("官方 ZIP 包含重复、链接、加密或无效条目");
      seen.add(name.toLowerCase()); expanded += expandedSize;
      if (expanded > maxExpandedSize) throw new Error("官方 ZIP 展开大小超出限制");
      const relative = outputName(name, stripPrefix);
      if (relative === null || !relative) continue;
      const target = inside(destination, relative);
      if (rawName.endsWith("/")) { await fsp.mkdir(target, { recursive: true }); continue; }
      const local = await readAt(handle, 30, localOffset);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(8) !== method) throw new Error("官方 ZIP 本地文件头损坏");
      const start = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      if (start + compressedSize > directoryOffset) throw new Error("官方 ZIP 文件数据越界");
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const output = await fsp.open(target, "wx"); let received = 0; let checksum = 0;
      try {
        if (compressedSize) {
          const source = fs.createReadStream(archive, { start, end: start + compressedSize - 1 });
          const input = method === 8 ? source.pipe(zlib.createInflateRaw()) : source;
          source.on("error", error => input.destroy(error));
          try {
            for await (const chunk of input) {
              checkAbort(signal); received += chunk.length; checksum = zlib.crc32(chunk, checksum);
              if (received > expandedSize) throw new Error("官方 ZIP 文件展开大小异常");
              let offset = 0; while (offset < chunk.length) offset += (await output.write(chunk, offset, chunk.length - offset)).bytesWritten;
            }
          } finally { source.destroy(); input.destroy(); }
        }
      } finally { await output.close(); }
      if (received !== expandedSize || checksum !== crc) throw new Error(`官方 ZIP 文件 CRC 或大小不匹配：${name}`);
      selected++;
    }
    if (!selected) throw new Error("官方 ZIP 未包含需要安装的文件");
  } finally { await handle.close(); }
}

function tarNumber(header, offset, length) {
  const text = header.subarray(offset, offset + length).toString("ascii").replace(/\0.*$/, "").trim();
  if (text && !/^[0-7]+$/.test(text)) throw new Error("官方 tar 数字字段损坏");
  const result = parseInt(text || "0", 8); if (!Number.isSafeInteger(result) || result < 0) throw new Error("官方 tar 文件大小无效"); return result;
}
function tarText(header, offset, length) { return header.subarray(offset, offset + length).toString("utf8").replace(/\0.*$/, ""); }
function paxAttributes(buffer) {
  const result = {}; let cursor = 0;
  while (cursor < buffer.length) {
    const space = buffer.indexOf(32, cursor); const length = Number(buffer.subarray(cursor, space).toString("ascii"));
    if (space < 0 || !Number.isSafeInteger(length) || length < 4 || cursor + length > buffer.length || buffer[cursor + length - 1] !== 10) throw new Error("官方 tar PAX 记录损坏");
    const text = buffer.subarray(space + 1, cursor + length - 1).toString("utf8"); const equal = text.indexOf("=");
    if (equal < 1) throw new Error("官方 tar PAX 属性无效"); result[text.slice(0, equal)] = text.slice(equal + 1); cursor += length;
  }
  return result;
}
async function extractTgz(archive, destination, { stripPrefix, signal, maxExpandedSize = MAX_EXPANDED } = {}) {
  const source = fs.createReadStream(archive); const input = zlib.createGunzip(); source.on("error", error => input.destroy(error)); source.pipe(input);
  let pending = Buffer.alloc(0); let state = "header"; let remaining = 0; let padding = 0; let output; let special; let parts = []; let attributes = {}; let ended = false; let total = 0; let selected = 0;
  const seen = new Set();
  const finish = async () => {
    if (output) { await output.close(); output = undefined; selected++; }
    if (special === "x") attributes = paxAttributes(Buffer.concat(parts));
    if (special === "L") attributes.path = Buffer.concat(parts).toString("utf8").replace(/\0.*$/, "");
    special = undefined; parts = []; state = padding ? "padding" : "header";
  };
  try {
    for await (const chunk of input) {
      checkAbort(signal); pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length) {
        if (ended) { if (pending.some(byte => byte !== 0)) throw new Error("官方 tar 末尾有异常数据"); pending = Buffer.alloc(0); break; }
        if (state === "header") {
          if (pending.length < 512) break;
          const header = pending.subarray(0, 512); pending = pending.subarray(512);
          if (header.every(byte => byte === 0)) { ended = true; continue; }
          let sum = 0; for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : header[index];
          if (sum !== tarNumber(header, 148, 8)) throw new Error("官方 tar 文件头校验失败");
          const type = String.fromCharCode(header[156] || 48); const prefix = tarText(header, 345, 155);
          const rawName = attributes.path || `${prefix ? `${prefix}/` : ""}${tarText(header, 0, 100)}`; attributes = {};
          remaining = tarNumber(header, 124, 12); padding = (512 - remaining % 512) % 512;
          if (!["0", "5", "x", "L"].includes(type)) throw new Error("官方 tar 不能包含链接或特殊文件");
          if (["x", "L"].includes(type)) { if (remaining > 16384) throw new Error("官方 tar 扩展头过大"); special = type; }
          else {
            const name = archiveName(rawName);
            if (!name || seen.has(name.toLowerCase())) throw new Error("官方 tar 包含重复路径");
            seen.add(name.toLowerCase()); total += remaining; if (total > maxExpandedSize) throw new Error("官方 tar 展开大小超出限制");
            const relative = outputName(name, stripPrefix);
            if (relative) {
              const target = inside(destination, relative);
              await fsp.mkdir(type === "5" ? target : path.dirname(target), { recursive: true });
              if (type === "0") output = await fsp.open(target, "wx");
            }
          }
          state = "body"; if (!remaining) await finish();
        } else if (state === "body") {
          const size = Math.min(remaining, pending.length); const part = pending.subarray(0, size); pending = pending.subarray(size); remaining -= size;
          if (special) parts.push(part);
          else if (output) { let offset = 0; while (offset < part.length) offset += (await output.write(part, offset, part.length - offset)).bytesWritten; }
          if (!remaining) await finish();
        } else {
          const size = Math.min(padding, pending.length); if (pending.subarray(0, size).some(byte => byte !== 0)) throw new Error("官方 tar 填充损坏"); pending = pending.subarray(size); padding -= size; if (!padding) state = "header";
        }
      }
    }
    if (!ended || state !== "header" || !selected) throw new Error("官方 tar 文件不完整或没有目标文件");
  } finally { await output?.close(); source.destroy(); input.destroy(); }
}

async function extractOfficialResource(resource, archive, staging, options = {}) {
  const target = inside(staging, resource.target);
  if (resource.format === "zip") return extractZip(archive, target, { ...options, stripPrefix: resource.stripPrefix });
  if (resource.format === "tgz") return extractTgz(archive, target, { ...options, stripPrefix: resource.stripPrefix });
  if (resource.format === "wheel") return;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  if (resource.format === "file") { await fsp.copyFile(archive, target, fs.constants.COPYFILE_EXCL); return; }
  if (resource.format === "gzip") {
    let size = 0; const unzip = zlib.createGunzip();
    unzip.on("data", chunk => { size += chunk.length; if (size > MAX_EXPANDED) unzip.destroy(new Error("官方 gzip 展开大小超出限制")); });
    return pipeline(fs.createReadStream(archive), unzip, fs.createWriteStream(target, { flags: "wx" }), { signal: options.signal });
  }
  throw new Error(`不支持的官方资源格式 ${resource.format}`);
}

async function copySupport(manifest, supportDir, staging) {
  if (!supportDir) throw new Error("安装器缺少配套脚本目录，请重新安装客户端");
  const realRoot = await fsp.realpath(supportDir);
  for (const file of manifest.supportFiles) {
    const source = inside(realRoot, file.path); const actual = await fsp.realpath(source);
    const part = path.relative(realRoot, actual);
    if (!part || part.startsWith("..") || path.isAbsolute(part) || !await matches(source, file)) throw new Error(`应用配套文件校验失败：${file.path}`);
    const target = inside(staging, file.path); await fsp.mkdir(path.dirname(target), { recursive: true }); await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  }
}
const pythonPath = value => process.platform === "win32" ? path.toNamespacedPath(value) : value;
async function configurePythonPaths(directory, version) {
  await fsp.mkdir(path.join(directory, "Lib/site-packages"), { recursive: true });
  const names = (await fsp.readdir(directory)).filter(name => /^python\d+\._pth$/.test(name));
  if (names.length !== 1) throw new Error("官方便携 Python 缺少独立路径配置");
  const majorMinor = version.split(".").slice(0, 2).join("");
  // Embedded CPython normalizes ._pth entries without the executable's extended
  // prefix. Those ordinary entries precede site-added extended paths, causing
  // deep Transformers imports to fail despite an extended python.exe path.
  // Python imports this relocatable hook for every invocation before scripts or
  // pip import third-party modules; no build/staging/final path is persisted.
  await fsp.writeFile(path.join(directory, "sitecustomize.py"), [
    '"""ClipForge portable Python paths; no external interpreter configuration."""',
    "import os", "import sys", "",
    "sys.dont_write_bytecode = True",
    'if os.name == "nt":',
    "    def _extended(value):",
    "        value = os.path.abspath(value)",
    '        if value.startswith("\\\\\\\\?\\\\"):',
    "            return value",
    '        if value.startswith("\\\\\\\\"):',
    '            return "\\\\\\\\?\\\\UNC\\\\" + value[2:]',
    '        return "\\\\\\\\?\\\\" + value',
    "    sys.path[:] = list(dict.fromkeys(_extended(item) for item in sys.path if item))",
    '    for _name in ("prefix", "base_prefix", "exec_prefix", "base_exec_prefix", "executable"):',
    "        setattr(sys, _name, _extended(getattr(sys, _name)))",
    "    sys.path_importer_cache.clear()", "",
  ].join("\n"));
  await fsp.writeFile(path.join(directory, names[0]), `python${majorMinor}.zip\n.\nLib/site-packages\nimport site\n`);
}
async function configurePython(manifest, staging, cache, { signal, onProgress }) {
  const python = inside(staging, manifest.paths.alignmentPythonPath); const directory = path.dirname(python); const packages = path.join(directory, "Lib/site-packages");
  await configurePythonPaths(directory, manifest.python.version);
  const env = { ...process.env, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8", PIP_CONFIG_FILE: process.platform === "win32" ? "NUL" : "/dev/null", PIP_NO_INDEX: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" };
  for (const key of Object.keys(env)) if (/^(?:PYTHONHOME|PYTHONPATH|PYTHONUSERBASE|NODE_OPTIONS|ELECTRON_RUN_AS_NODE)$/i.test(key)) delete env[key];
  const identity = JSON.parse(await run(pythonPath(python), ["-c", "import json,sys,struct;print(json.dumps({'version':'.'.join(map(str,sys.version_info[:3])),'bits':struct.calcsize('P')*8}))"], { env, signal }));
  if (identity.version !== manifest.python.version || identity.bits !== 64) throw new Error("官方 Python 版本或平台不匹配");
  const wheelhouse = path.join(staging, ".wheelhouse"); await fsp.mkdir(wheelhouse);
  const resources = new Map(manifest.resources.map(resource => [resource.id, resource])); const requirements = [];
  for (const id of manifest.python.wheelResourceIds) {
    const resource = resources.get(id); const target = path.join(wheelhouse, wheelFilename(resource));
    try { await fsp.link(cache.get(id), target); } catch { await fsp.copyFile(cache.get(id), target); }
    requirements.push(`${resource.pythonRequirement} --hash=sha256:${resource.sha256}`);
  }
  const lock = path.join(staging, "alignment/python-requirements.lock"); await fsp.writeFile(lock, requirements.join("\n") + "\n");
  const pip = cache.get(manifest.python.pipResourceId);
  const bootstrap = "import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_module('pip',run_name='__main__')";
  onProgress({ phase: "installing-python", message: "正在离线配置已下载的 Python 依赖，无需系统 Python 或 pip" });
  const heartbeat = setInterval(() => onProgress({ phase: "installing-python", message: "正在配置本地音频对齐环境，请稍候" }), 5000);
  try {
    await run(pythonPath(python), ["-c", bootstrap, pythonPath(pip), "install", "--no-index", "--no-deps", "--no-compile", "--require-hashes", "--no-warn-script-location", "--find-links", pythonPath(wheelhouse), "--target", pythonPath(packages), "-r", pythonPath(lock)], { env, signal, timeout: 15 * 60_000 });
  } finally { clearInterval(heartbeat); await fsp.rm(wheelhouse, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  const torch = path.join(packages, "torch");
  try { for (const name of await fsp.readdir(path.join(torch, "lib"))) if (name.endsWith(".lib")) await fsp.rm(path.join(torch, "lib", name)); } catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const name of ["include", "test"]) await fsp.rm(path.join(torch, name), { recursive: true, force: true });
}

async function verifyOfficialRuntime({ manifest, baseDir, deep = false, signal, onProgress = () => {}, _probeRuntime = manager.probeRuntime }) {
  const runtimeDir = path.join(path.resolve(baseDir), "runtimes", manifest.runtimeId);
  onProgress({ phase: "checking-installed", message: "正在检查官方运行资源安装状态" });
  const ready = JSON.parse(await fsp.readFile(path.join(runtimeDir, "runtime-ready.json"), "utf8"));
  if (ready.schemaVersion !== 2 || ready.manifestSha256 !== manifestDigest(manifest) || ready.runtimeId !== manifest.runtimeId || !Array.isArray(ready.files) || !ready.files.length) throw new Error("官方运行资源尚未就绪或版本不匹配");
  let last = 0; let count = 0;
  for (const file of ready.files) {
    checkAbort(signal); safeRelative(file.path);
    if (!await matches(inside(runtimeDir, file.path), file, deep)) throw new Error(`官方运行资源缺失或已损坏：${file.path}`);
    count++;
    if (Date.now() - last > 500 || count === ready.files.length) { last = Date.now(); onProgress({ phase: "checking-installed", checkedFiles: count, totalFiles: ready.files.length, message: `正在校验已安装的官方资源（${count}/${ready.files.length}）` }); }
  }
  const paths = resolvedPaths(manifest, runtimeDir);
  for (const key of REQUIRED_PATHS) { const stat = await fsp.lstat(paths[key]); if (stat.isSymbolicLink()) throw new Error("官方运行资源不能使用链接"); }
  const alignment = JSON.parse(await fsp.readFile(path.join(paths.alignmentRuntimeDir, "ready.json"), "utf8"));
  if (alignment.schemaVersion !== 1 || alignment.runtimeVersion !== "english-alignment-v1" || alignment.device !== "cpu" || alignment.asrUsed !== false) throw new Error("官方音频对齐环境未通过自检");
  if (deep) await _probeRuntime(paths, manifest, { signal, onProgress });
  return paths;
}

async function prepareOfficialRuntime({ manifest, baseDir, supportDir, signal, onProgress = () => {}, allowHttpForTests = false, _probeRuntime = manager.probeRuntime, _configurePython = configurePython, _renameTimeoutMs = 15_000 }) {
  baseDir = path.resolve(baseDir); onProgress({ phase: "preparing-directory", message: "正在准备官方运行资源安装目录" }); await fsp.mkdir(baseDir, { recursive: true });
  const release = await acquireLock(baseDir, signal, onProgress); let staging; let failure;
  try {
    try { const paths = await verifyOfficialRuntime({ manifest, baseDir, deep: true, signal, onProgress, _probeRuntime }); onProgress({ phase: "ready", message: "官方运行资源已就绪，复用现有安装" }); return paths; } catch { checkAbort(signal); }
    const required = manifest.resources.reduce((sum, resource) => sum + resource.size * 5, 256 * 1024 ** 2);
    onProgress({ phase: "checking-space", message: "正在检查官方资源下载与配置所需磁盘空间" });
    const disk = await fsp.statfs(baseDir); if (Number(disk.bavail) * Number(disk.bsize) < required) throw new Error(`官方资源安装至少需要 ${(required / 1024 ** 3).toFixed(1)} GiB 可用磁盘空间`);
    staging = path.join(baseDir, "runtimes", `.staging-${crypto.randomUUID()}`); await fsp.mkdir(staging, { recursive: true });
    const cache = new Map();
    for (const [index, resource] of manifest.resources.entries()) {
      checkAbort(signal);
      const progress = event => onProgress({ ...event, completedResources: index, totalResources: manifest.resources.length });
      const archive = path.join(baseDir, "downloads", `${resource.id}-${resource.sha256}.download`);
      await manager.downloadResource(resource, archive, { signal, onProgress: progress, allowHttpForTests }); cache.set(resource.id, archive);
      if (resource.format !== "wheel") { progress({ phase: "extracting", resourceId: resource.id, message: `正在安装官方资源 ${resource.id}` }); await extractOfficialResource(resource, archive, staging, { signal }); }
    }
    await copySupport(manifest, supportDir, staging);
    await _configurePython(manifest, staging, cache, { signal, onProgress });
    onProgress({ phase: "verifying", message: "正在离线检查官方程序、模型与媒体工具" });
    await _probeRuntime(resolvedPaths(manifest, staging), manifest, { signal, onProgress }); checkAbort(signal);
    const runtimeDir = path.join(baseDir, "runtimes", manifest.runtimeId); const paths = resolvedPaths(manifest, runtimeDir);
    const readyPath = path.join(staging, manifest.paths.alignmentRuntimeDir, "ready.json");
    const alignmentReady = JSON.parse(await fsp.readFile(readyPath, "utf8"));
    await fsp.rm(readyPath);
    onProgress({ phase: "checking-files", message: "正在记录已安装官方资源的完整性信息" });
    const files = (await manager.inventory(staging)).filter(file => !/(?:^|\/)__pycache__(?:\/|$)|\.py[co]$/.test(file.path));
    await writeJson(readyPath, { ...alignmentReady, python: paths.alignmentPythonPath, modelDirectory: paths.alignmentModelDir });
    await writeJson(path.join(staging, "runtime-ready.json"), { schemaVersion: 2, runtimeId: manifest.runtimeId, manifestSha256: manifestDigest(manifest), installedAt: new Date().toISOString(), files });
    onProgress({ phase: "committing", message: "正在完成官方运行资源安装" }); let previous;
    try { await fsp.access(runtimeDir); previous = `${runtimeDir}.invalid-${crypto.randomUUID()}`; await manager.renameDirectory(runtimeDir, previous, { signal, onProgress, timeoutMs: _renameTimeoutMs, action: "backup" }); } catch (error) { if (error.code !== "ENOENT") throw error; }
    try { await manager.renameDirectory(staging, runtimeDir, { signal, onProgress, timeoutMs: _renameTimeoutMs }); staging = undefined; }
    catch (error) {
      if (previous) try { await manager.renameDirectory(previous, runtimeDir, { onProgress, timeoutMs: _renameTimeoutMs, action: "rollback" }); } catch (rollback) { throw new AggregateError([error, rollback], `原官方运行资源已保留在 ${previous}`); }
      throw error;
    }
    if (previous) await fsp.rm(previous, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await writeJson(path.join(baseDir, "runtime-state.json"), { schemaVersion: 2, runtimeId: manifest.runtimeId, manifestSha256: manifestDigest(manifest) });
    onProgress({ phase: "ready", message: "官方程序与模型全部准备完成", completedResources: manifest.resources.length, totalResources: manifest.resources.length });
    return paths;
  } catch (error) { failure = error; throw error; }
  finally {
    try { if (staging) try { await fsp.rm(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (cleanup) { if (!failure) throw cleanup; failure.cleanupError = cleanup; } }
    finally { await release(); }
  }
}

module.exports = { validateOfficialManifest, prepareOfficialRuntime, verifyOfficialRuntime, extractZip, extractTgz, extractOfficialResource, configurePython, configurePythonPaths };
