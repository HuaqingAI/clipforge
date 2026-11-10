/* Online desktop resources. Built-ins only: this module also runs before Node/npm
 * exists on an end user's computer, inside Electron's main process. */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { spawn } = require("node:child_process");
const net = require("node:net");
const { resourceDownloadUrls, validateResourceMirrors } = require("./runtime-sources.cjs");

const SCHEMA_VERSION = 1;
const REQUIRED_PATHS = ["nodePath", "klingPackagePath", "elevenLabsPackagePath", "alignmentRuntimeDir", "alignmentPythonPath", "alignmentModelDir", "alignmentCheckerPath", "asrModelDir", "wasmDir", "ffmpegPath", "ffprobePath"];
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
  const abort = () => { done(); reject(signal.reason || new Error("安装已取消")); };
  const timer = setTimeout(() => { done(); resolve(); }, ms);
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
});
function checkAbort(signal) { signal?.throwIfAborted(); }
function fail(message) { throw new Error(message); }
function safeRelative(value) {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\\\x00-\x1f:]/.test(value) || value.startsWith("/") || value.split("/").some(part => !part || part === "." || part === "..")) fail("运行资源包含无效的相对路径");
  return value;
}
function inside(root, relative) {
  const result = path.resolve(root, safeRelative(relative));
  if (!path.relative(root, result) || path.relative(root, result).startsWith("..") || path.isAbsolute(path.relative(root, result))) fail("运行资源路径超出受管目录");
  return result;
}
function sourceUrl(value, allowHttpForTests = false) {
  const url = new URL(value);
  if (url.username || url.password || url.hash || !(url.protocol === "https:" || allowHttpForTests && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) fail("运行资源必须使用 HTTPS 下载地址");
  return url;
}
async function sha256(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function matches(file, entry, deep = true) {
  try { const stat = await fsp.lstat(file); return stat.isFile() && !stat.isSymbolicLink() && stat.size === entry.size && (!deep || await sha256(file) === entry.sha256); }
  catch { return false; }
}
async function writeJson(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await fsp.rename(temp, file);
}
function manifestDigest(manifest) { return crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex"); }

function validateManifest(manifest, { platform = process.platform, arch = process.arch, allowHttpForTests = false } = {}) {
  if (manifest?.schemaVersion === 2) return require("./official-runtime.cjs").validateOfficialManifest(manifest, { platform, arch, allowHttpForTests });
  if (manifest?.schemaVersion !== SCHEMA_VERSION || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/.test(manifest.runtimeId || "")) fail("桌面运行资源清单版本或标识无效");
  if (manifest.platform !== platform || manifest.arch !== arch) fail(`运行资源不支持当前平台 ${platform}-${arch}`);
  if (!/^\d+\.\d+\.\d+$/.test(manifest.nodeVersion || "") || !Number.isSafeInteger(manifest.nodeAbi)) fail("运行资源缺少固定 Node 版本/ABI");
  if (!Array.isArray(manifest.resources) || !manifest.resources.length) fail("运行资源清单为空");
  const ids = new Set(); const allFiles = new Map(); const caseFolded = new Set();
  for (const resource of manifest.resources) {
    if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(resource.id || "") || ids.has(resource.id)) fail("运行资源标识重复或无效");
    ids.add(resource.id); sourceUrl(resource.url, allowHttpForTests);
    validateResourceMirrors(resource, { allowHttpForTests });
    if (!Number.isSafeInteger(resource.size) || resource.size <= 0 || !/^[a-f0-9]{64}$/.test(resource.sha256 || "") || !Array.isArray(resource.files) || !resource.files.length) fail("运行资源校验数据不完整");
    for (const file of resource.files) {
      safeRelative(file.path);
      if (!Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256 || "") || allFiles.has(file.path) || caseFolded.has(file.path.toLowerCase())) fail("运行资源文件清单存在重复或无效数据");
      allFiles.set(file.path, file); caseFolded.add(file.path.toLowerCase());
    }
  }
  for (const key of REQUIRED_PATHS) safeRelative(manifest.paths?.[key]);
  for (const key of ["nodePath", "alignmentPythonPath", "alignmentCheckerPath", "ffmpegPath", "ffprobePath"]) if (!allFiles.has(manifest.paths[key])) fail(`运行资源缺少 ${key}`);
  return manifest;
}
async function loadManifest(manifestPath, options) { return validateManifest(JSON.parse(await fsp.readFile(manifestPath, "utf8")), options); }
function resolvedPaths(manifest, runtimeDir) {
  const values = Object.fromEntries(Object.entries(manifest.paths).map(([key, value]) => [key, inside(runtimeDir, value)]));
  return { ...values, runtimeDir, runtimeId: manifest.runtimeId, nodeVersion: manifest.nodeVersion, nodeAbi: manifest.nodeAbi };
}

async function fetchTrusted(url, options, allowHttpForTests) {
  let current = sourceUrl(url, allowHttpForTests);
  for (let redirects = 0; redirects < 8; redirects++) {
    const response = await fetch(current, { ...options, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) fail("资源下载重定向缺少地址");
    current = sourceUrl(new URL(location, current).href, allowHttpForTests);
  }
  fail("资源下载重定向过多");
}

async function downloadResource(resource, file, { signal, onProgress = () => {}, allowHttpForTests = false, connectTimeoutMs = 30_000, idleTimeoutMs = 60_000 } = {}) {
  for (const value of [connectTimeoutMs, idleTimeoutMs]) if (!Number.isSafeInteger(value) || value <= 0) fail("资源下载超时设置无效");
  sourceUrl(resource.url, allowHttpForTests);
  validateResourceMirrors(resource, { allowHttpForTests });
  checkAbort(signal);
  onProgress({ phase: "checking-cache", resourceId: resource.id, message: `正在校验 ${resource.id} 下载缓存` });
  if (await matches(file, resource)) { onProgress({ phase: "cached", resourceId: resource.id, message: `${resource.id} 下载缓存校验通过` }); return file; }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const urls = resourceDownloadUrls(resource); const errors = [];
  // A cancelled fallback may already have downloaded most of a large model.
  // Resume it only while its exact URL is still an approved candidate.
  let pending;
  try {
    const metadata = JSON.parse(await fsp.readFile(`${file}.part.json`, "utf8"));
    const info = await fsp.lstat(`${file}.part`);
    if (metadata.sha256 === resource.sha256 && info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= resource.size) pending = metadata.url;
  } catch { /* no reusable partial */ }
  const pendingIndex = urls.indexOf(pending);
  if (pendingIndex > 0) {
    urls.splice(pendingIndex, 1); urls.unshift(pending);
    onProgress({ phase: "resuming", resourceId: resource.id, sourceUrl: pending, sourceHost: new URL(pending).hostname, message: `正在续传 ${resource.id} 上次未完成的下载 · ${new URL(pending).hostname}` });
  }
  for (const [index, url] of urls.entries()) {
    checkAbort(signal);
    const host = new URL(url).hostname;
    const progress = event => onProgress({ ...event, sourceUrl: url, sourceHost: host, message: event.message ? `${event.message} · ${host}` : event.message });
    try {
      return await downloadFromSource({ ...resource, url }, file, { signal, onProgress: progress, allowHttpForTests, connectTimeoutMs, idleTimeoutMs, maxAttempts: url === resource.url ? 3 : 1 });
    } catch (error) {
      checkAbort(signal);
      if (urls.length === 1) throw error;
      errors.push(new Error(`${host}: ${error.message}`, { cause: error }));
      if (index === urls.length - 1) throw new AggregateError(errors, `无法下载 ${resource.id}，镜像和官方源均失败：${errors.map(error => error.message).join("；")}`);
      const nextUrl = urls[index + 1]; const nextHost = new URL(nextUrl).hostname;
      onProgress({ phase: "fallback", resourceId: resource.id, sourceUrl: nextUrl, sourceHost: nextHost, receivedBytes: 0, totalBytes: resource.size, message: `${resource.id} 从 ${host} 下载失败：${error.message}；正在切换到 ${nextHost}` });
    }
  }
}

/** Resume only the same URL across runs; never mix bytes or ETags from mirrors.
 * Every candidate must pass the original manifest's fixed size and SHA256. */
async function downloadFromSource(resource, file, { signal, onProgress, allowHttpForTests, connectTimeoutMs, idleTimeoutMs, maxAttempts }) {
  const partial = `${file}.part`; const metadataPath = `${partial}.json`;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    checkAbort(signal);
    let handle; let deadline;
    const requestController = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, requestController.signal]) : requestController.signal;
    const setDeadline = (milliseconds, message) => {
      clearTimeout(deadline);
      deadline = setTimeout(() => requestController.abort(new Error(message)), milliseconds);
    };
    try {
      let offset = 0; let metadata;
      try { metadata = JSON.parse(await fsp.readFile(metadataPath, "utf8")); } catch { /* no reusable metadata */ }
      if (metadata?.sha256 === resource.sha256 && metadata.url === resource.url) {
        try { offset = (await fsp.stat(partial)).size; } catch { /* no reusable partial */ }
      } else {
        await fsp.rm(partial, { force: true }); await fsp.rm(metadataPath, { force: true }); metadata = undefined;
      }
      if (offset > resource.size) offset = 0;
      if (offset === resource.size && await matches(partial, resource)) { await fsp.rename(partial, file); await fsp.rm(metadataPath, { force: true }); onProgress({ phase: "cached", resourceId: resource.id, message: `${resource.id} 已完成的下载校验通过` }); return file; }
      const headers = offset ? { Range: `bytes=${offset}-`, ...(metadata.etag ? { "If-Range": metadata.etag } : {}) } : {};
      onProgress({ phase: "connecting", resourceId: resource.id, attempt, message: `正在连接 ${resource.id} 下载服务器${offset ? "，准备续传" : ""}（最多等待 ${Math.ceil(connectTimeoutMs / 1000)} 秒）` });
      setDeadline(connectTimeoutMs, `连接资源服务器超时（${Math.ceil(connectTimeoutMs / 1000)} 秒），请检查网络后重试`);
      const response = await fetchTrusted(resource.url, { headers, signal: requestSignal }, allowHttpForTests);
      clearTimeout(deadline);
      if (response.status === 416) { await response.body?.cancel(); await fsp.rm(partial, { force: true }); await fsp.rm(metadataPath, { force: true }); throw new Error("资源续传位置无效，正在重新下载"); }
      if (![200, 206].includes(response.status) || !response.body) {
        await response.body?.cancel();
        const detail = response.status === 404 ? "在线资源尚未发布或下载地址不存在" : [401, 403].includes(response.status) ? "在线资源无法公开访问，请检查资源是否已发布" : "资源服务器无法提供下载";
        const error = new Error(`${detail}（HTTP ${response.status}）`);
        error.permanent = response.status >= 400 && response.status < 500 && ![408, 425, 429].includes(response.status);
        throw error;
      }
      if (response.status === 206 && response.headers.get("content-range") !== `bytes ${offset}-${resource.size - 1}/${resource.size}`) { await response.body.cancel(); fail("服务器返回了不匹配的资源续传范围"); }
      if (response.status === 200) offset = 0;
      await writeJson(metadataPath, { url: resource.url, sha256: resource.sha256, etag: response.headers.get("etag") });
      handle = await fsp.open(partial, offset ? "a" : "w", 0o600);
      let receivedBytes = offset;
      onProgress({ phase: "downloading", resourceId: resource.id, message: `正在下载 ${resource.id}`, receivedBytes, totalBytes: resource.size });
      const resetIdleDeadline = () => setDeadline(idleTimeoutMs, `下载连续 ${Math.ceil(idleTimeoutMs / 1000)} 秒没有收到数据，请检查网络后重试`);
      resetIdleDeadline();
      for await (const chunk of response.body) {
        resetIdleDeadline();
        checkAbort(signal); receivedBytes += chunk.length;
        if (receivedBytes > resource.size) fail("资源下载大小超出清单，已停止下载");
        let written = 0;
        while (written < chunk.length) written += (await handle.write(chunk, written, chunk.length - written)).bytesWritten;
        onProgress({ phase: "downloading", resourceId: resource.id, message: `正在下载 ${resource.id}`, receivedBytes, totalBytes: resource.size });
      }
      clearTimeout(deadline);
      await handle.close(); handle = undefined;
      onProgress({ phase: "checking-download", resourceId: resource.id, message: `正在校验 ${resource.id} 下载内容`, receivedBytes, totalBytes: resource.size });
      if (!(await matches(partial, resource))) { await fsp.rm(partial, { force: true }); await fsp.rm(metadataPath, { force: true }); fail("资源下载的大小或 SHA256 校验失败"); }
      await fsp.rename(partial, file); await fsp.rm(metadataPath, { force: true }); return file;
    } catch (error) {
      await handle?.close(); checkAbort(signal);
      const reason = requestController.signal.aborted ? requestController.signal.reason?.message || error.message : error.cause?.code ? `${error.message} (${error.cause.code})` : error.message;
      if (error.permanent || attempt === maxAttempts) throw new Error(`无法下载 ${resource.id}：${reason}`);
      onProgress({ phase: "retrying", resourceId: resource.id, message: `${resource.id} 下载重试 ${attempt}/${maxAttempts}：${reason}` });
    } finally {
      clearTimeout(deadline);
      requestController.abort();
    }
    await sleep(attempt * 200, signal);
  }
}

function tarNumber(header, start, length) {
  const raw = header.subarray(start, start + length).toString("ascii").replace(/\0.*$/, "").trim();
  if (raw && !/^[0-7]+$/.test(raw)) fail("资源压缩包数字字段无效");
  const number = parseInt(raw || "0", 8);
  if (!Number.isSafeInteger(number) || number < 0) fail("资源压缩包大小无效");
  return number;
}
function tarText(header, start, length) { return header.subarray(start, start + length).toString("utf8").replace(/\0.*$/, ""); }
function parsePax(buffer) {
  const attributes = {}; let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(32, offset); if (space < 0) fail("无效的 PAX 压缩包头");
    const length = Number(buffer.subarray(offset, space).toString("ascii"));
    if (!Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > buffer.length || buffer[offset + length - 1] !== 10) fail("无效的 PAX 压缩包长度");
    const field = buffer.subarray(space + 1, offset + length - 1).toString("utf8"); const equal = field.indexOf("=");
    if (equal < 1) fail("无效的 PAX 压缩包属性");
    attributes[field.slice(0, equal)] = field.slice(equal + 1); offset += length;
  }
  return attributes;
}

/** Extract our regular-file-only tar format without trusting tar.exe, links,
 * archive paths, oversized entries, or a machine-wide extraction utility. */
async function extractResource(archive, destination, files, { signal } = {}) {
  const expected = new Map(files.map(file => [safeRelative(file.path), file])); const seen = new Set();
  const source = fs.createReadStream(archive); const unzip = zlib.createGunzip();
  source.on("error", error => unzip.destroy(error)); source.pipe(unzip);
  let pending = Buffer.alloc(0); let state = "header"; let remaining = 0; let padding = 0;
  let current; let handle; let hash; let pax = {}; let paxParts = []; let ended = false;
  const consumeBody = async chunk => {
    if (current.type === "x") paxParts.push(chunk);
    else { hash.update(chunk); let offset = 0; while (offset < chunk.length) offset += (await handle.write(chunk, offset, chunk.length - offset)).bytesWritten; }
    remaining -= chunk.length;
    if (!remaining) {
      if (current.type === "x") pax = parsePax(Buffer.concat(paxParts));
      else {
        await handle.close(); handle = undefined;
        if (hash.digest("hex") !== current.expected.sha256) fail(`解压资源校验失败：${current.name}`);
        seen.add(current.name);
        if (current.expected.executable && process.platform !== "win32") await fsp.chmod(inside(destination, current.name), 0o755);
      }
      state = padding ? "padding" : "header";
    }
  };
  try {
    for await (const chunk of unzip) {
      checkAbort(signal); pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length) {
        if (ended) { if (pending.some(byte => byte !== 0)) fail("资源压缩包末尾包含异常数据"); pending = Buffer.alloc(0); break; }
        if (state === "header") {
          if (pending.length < 512) break;
          const header = pending.subarray(0, 512); pending = pending.subarray(512);
          if (header.every(byte => byte === 0)) { ended = true; continue; }
          let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
          if (sum !== tarNumber(header, 148, 8)) fail("资源压缩包头校验失败");
          const type = String.fromCharCode(header[156] || 48); const prefix = tarText(header, 345, 155);
          const name = pax.path || `${prefix ? `${prefix}/` : ""}${tarText(header, 0, 100)}`;
          const size = tarNumber(header, 124, 12); pax = {};
          if (!["0", "x"].includes(type)) fail("资源压缩包不能包含链接或特殊文件");
          if (type === "x") { if (size > 16 * 1024) fail("资源压缩包扩展头过大"); paxParts = []; current = { type }; }
          else {
            safeRelative(name); const entry = expected.get(name);
            if (!entry || seen.has(name) || entry.size !== size) fail(`资源压缩包文件不在清单内：${name}`);
            const output = inside(destination, name); await fsp.mkdir(path.dirname(output), { recursive: true });
            // The destination is a newly-created private staging directory. Never
            // overwrite an earlier entry or follow an existing filesystem link.
            handle = await fsp.open(output, "wx", entry.executable ? 0o755 : 0o644); hash = crypto.createHash("sha256");
            current = { type, name, expected: entry };
          }
          remaining = size; padding = (512 - size % 512) % 512; state = "body";
          if (!remaining) await consumeBody(Buffer.alloc(0));
        } else if (state === "body") {
          const size = Math.min(remaining, pending.length); const part = pending.subarray(0, size); pending = pending.subarray(size); await consumeBody(part);
        } else {
          const size = Math.min(padding, pending.length); if (pending.subarray(0, size).some(byte => byte !== 0)) fail("资源压缩包填充无效"); pending = pending.subarray(size); padding -= size; if (!padding) state = "header";
        }
      }
    }
    if (!ended || state !== "header" || seen.size !== expected.size) fail("资源压缩包不完整");
  } finally { await handle?.close(); source.destroy(); unzip.destroy(); }
}

function octal(header, value, start, length) { header.write(value.toString(8).padStart(length - 1, "0") + "\0", start, length, "ascii"); }
function tarHeader(name, size, type = "0", executable = false) {
  const header = Buffer.alloc(512); header.write(name, 0, 100, "ascii");
  octal(header, executable ? 0o755 : 0o644, 100, 8); octal(header, 0, 108, 8); octal(header, 0, 116, 8); octal(header, size, 124, 12); octal(header, 0, 136, 12);
  header.fill(32, 148, 156); header[156] = type.charCodeAt(0); header.write("ustar\0", 257, 6, "ascii"); header.write("00", 263, 2, "ascii");
  octal(header, header.reduce((sum, byte) => sum + byte, 0), 148, 7); header[155] = 32; return header;
}
function paxRecord(key, value) {
  const body = `${key}=${value}\n`; let size = Buffer.byteLength(body) + 2;
  while (Buffer.byteLength(String(size)) + 1 + Buffer.byteLength(body) !== size) size = Buffer.byteLength(String(size)) + 1 + Buffer.byteLength(body);
  return Buffer.from(`${size} ${body}`);
}
async function inventory(sourceDir) {
  const files = [];
  async function visit(directory) {
    for (const entry of (await fsp.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const absolute = path.join(directory, entry.name); const relative = path.relative(sourceDir, absolute).split(path.sep).join("/"); safeRelative(relative);
      if (entry.isSymbolicLink()) fail(`资源构建不允许符号链接：${relative}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) { const stat = await fsp.stat(absolute); files.push({ path: relative, size: stat.size, sha256: await sha256(absolute), ...(stat.mode & 0o111 ? { executable: true } : {}) }); }
      else fail(`资源构建不允许特殊文件：${relative}`);
    }
  }
  await visit(sourceDir); return files;
}
async function createRuntimeArchive({ sourceDir, outputPath }) {
  const files = await inventory(sourceDir);
  async function* contents() {
    for (const file of files) {
      const extended = Buffer.byteLength(file.path) > 100 || /[^\x20-\x7e]/.test(file.path);
      if (extended) { const data = paxRecord("path", file.path); yield tarHeader("PaxHeader", data.length, "x"); yield data; if (data.length % 512) yield Buffer.alloc(512 - data.length % 512); }
      yield tarHeader(extended ? "PaxFile" : file.path, file.size, "0", file.executable);
      for await (const chunk of fs.createReadStream(inside(sourceDir, file.path))) yield chunk;
      if (file.size % 512) yield Buffer.alloc(512 - file.size % 512);
    }
    yield Buffer.alloc(1024);
  }
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await pipeline(Readable.from(contents()), zlib.createGzip({ level: 6 }), fs.createWriteStream(outputPath));
  return { files, size: (await fsp.stat(outputPath)).size, sha256: await sha256(outputPath), expandedSize: files.reduce((sum, file) => sum + file.size, 0) };
}

async function run(executable, args, { cwd, env = process.env, signal, timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    checkAbort(signal);
    const child = spawn(executable, args, { cwd, env, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let errors = ""; let killed = false;
    const stop = () => { killed = true; child.kill(); };
    const timer = setTimeout(stop, timeout); signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", data => { output = (output + data).slice(-128 * 1024); }); child.stderr.on("data", data => { errors = (errors + data).slice(-32 * 1024); });
    const clean = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); };
    child.once("error", error => { clean(); reject(error); });
    child.once("close", code => { clean(); if (code === 0 && !killed) resolve(output); else reject(new Error(`${path.basename(executable)} 自检失败${killed ? "（超时或取消）" : ` (${code})`}：${errors.slice(-2000)}`)); });
  });
}
async function probeRuntime(paths, manifest, { signal, onProgress = () => {} } = {}) {
  // Python derives sys.prefix/site-packages from its executable path. Passing
  // only extended script/model paths still leaves imports at Windows MAX_PATH.
  const pythonPath = value => process.platform === "win32" ? path.toNamespacedPath(value) : value;
  const env = { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", PYTHONIOENCODING: "utf-8", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", APP_ALIGNMENT_MODEL_DIR: pythonPath(paths.alignmentModelDir) };
  for (const key of Object.keys(env)) if (/^(?:ELEVENLABS|KLING|OPENAI|HF_TOKEN|HUGGING_FACE_HUB_TOKEN|NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|PYTHONHOME|PYTHONPATH|PYTHONUSERBASE)/i.test(key)) delete env[key];
  onProgress({ phase: "verifying-node", message: "正在检查应用运行环境" });
  const node = JSON.parse(await run(paths.nodePath, ["-p", "JSON.stringify({version:process.versions.node,abi:Number(process.versions.modules),platform:process.platform,arch:process.arch})"], { env, signal }));
  if (node.version !== manifest.nodeVersion || node.abi !== manifest.nodeAbi || node.platform !== manifest.platform || node.arch !== manifest.arch) fail("下载的 Node 版本、ABI 或平台不匹配");
  onProgress({ phase: "verifying-kling", message: "正在检查 Kling CLI" });
  const kling = await run(paths.nodePath, [path.join(paths.klingPackagePath, "dist", "cli.js"), "--version"], { env, signal, cwd: paths.runtimeDir });
  if (kling.trim() !== "kling-cli 0.2.0") fail("Kling CLI 版本自检失败");
  const elevenlabs = inside(paths.runtimeDir, manifest.paths.elevenLabsExecutable);
  onProgress({ phase: "verifying-elevenlabs", message: "正在检查 ElevenLabs CLI" });
  if (!/(?:^|\s)v?1\.8\.0(?:\s|$)/.test(await run(elevenlabs, ["--version"], { env, signal, cwd: paths.runtimeDir }))) fail("ElevenLabs CLI 版本自检失败");
  onProgress({ phase: "verifying-alignment", message: "正在加载并检查音频对齐模型，首次可能需要数分钟" });
  const started = Date.now();
  const heartbeat = setInterval(() => onProgress({ phase: "verifying-alignment", message: `正在检查音频对齐模型（已用 ${Math.floor((Date.now() - started) / 1000)} 秒）` }), 5000);
  try { await run(pythonPath(paths.alignmentPythonPath), [pythonPath(paths.alignmentCheckerPath), "--runtime-dir", pythonPath(paths.alignmentRuntimeDir), "--write-ready"], { env, signal, timeout: 10 * 60_000 }); }
  finally { clearInterval(heartbeat); }
  onProgress({ phase: "verifying-media", message: "正在检查视频与字幕合成工具" });
  const filters = await run(paths.ffmpegPath, ["-hide_banner", "-filters"], { env, signal });
  for (const filter of ["drawtext", "subtitles", "ass", "xfade", "acrossfade"]) if (!new RegExp(`\\b${filter}\\s`).test(filters)) fail(`FFmpeg 缺少必要滤镜：${filter}`);
  await run(paths.ffprobePath, ["-version"], { env, signal });
  const output = path.join(paths.runtimeDir, ".install-probe.mp4");
  try { await run(paths.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=128x128:r=10:d=0.2", "-vf", "drawtext=fontfile=fonts/subtitle.otf:text=ClipForge:fontsize=14:fontcolor=white", "-c:v", "libx264", "-pix_fmt", "yuv420p", output], { cwd: path.join(paths.runtimeDir, "media"), env, signal }); }
  finally { await fsp.rm(output, { force: true }); }
}

async function acquireLock(baseDir, signal, onProgress) {
  onProgress({ phase: "checking-lock", message: "正在检查运行资源安装状态" });
  const file = path.join(baseDir, ".runtime-install.lock"); const nonce = crypto.randomUUID();
  // Kernel-owned endpoints disappear on process exit, unlike PID files. A stale
  // file cannot be reclaimed by two installers racing to delete a newer lock.
  const identity = crypto.createHash("sha256").update(process.platform === "win32" ? baseDir.toLowerCase() : baseDir).digest("hex").slice(0, 40);
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\clipforge-runtime-${identity}` : process.platform === "linux" ? `\0clipforge-runtime-${identity}` : null;
  if (!endpoint) fail("当前平台尚未实现桌面运行资源安装互斥，请使用已支持的 Windows x64 安装器");
  for (let attempt = 0; attempt < 180; attempt++) {
    checkAbort(signal);
    const server = net.createServer(socket => socket.destroy()); server.unref();
    const acquired = await new Promise((resolve, reject) => {
      server.once("error", error => ["EADDRINUSE", "EACCES"].includes(error.code) ? resolve(false) : reject(error));
      server.listen(endpoint, () => resolve(true));
    });
    if (acquired) {
      try { await writeJson(file, { pid: process.pid, nonce, endpoint: "kernel-managed" }); }
      catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }
      return async () => {
        try { if (JSON.parse(await fsp.readFile(file, "utf8")).nonce === nonce) await fsp.rm(file); } catch { /* diagnostic file only */ }
        await new Promise(resolve => server.close(resolve));
      };
    }
    if (attempt % 10 === 0) onProgress({ phase: "waiting", message: "另一个安装过程正在准备运行资源，请稍候" });
    await sleep(1000, signal);
  }
  fail("等待运行资源安装锁超时");
}
async function inspectInstalled(manifest, runtimeDir, { deep = false, _probeRuntime = probeRuntime, signal, onProgress = () => {} } = {}) {
  onProgress({ phase: "checking-installed", message: "正在检查已安装的运行资源" });
  const ready = JSON.parse(await fsp.readFile(path.join(runtimeDir, "runtime-ready.json"), "utf8"));
  if (ready.manifestSha256 !== manifestDigest(manifest) || ready.runtimeId !== manifest.runtimeId) fail("运行资源版本不匹配，请重新安装或修复资源");
  for (const [index, resource] of manifest.resources.entries()) {
    let checkedFiles = 0; let lastProgress = Date.now();
    const progress = () => onProgress({ phase: "checking-installed", resourceId: resource.id, completedResources: index, totalResources: manifest.resources.length, checkedFiles, totalFiles: resource.files.length, message: `正在校验已安装的 ${resource.id}（${checkedFiles}/${resource.files.length}）` });
    progress();
    for (const file of resource.files) {
      checkAbort(signal);
      if (!(await matches(inside(runtimeDir, file.path), file, deep))) fail(`运行资源缺失或已损坏：${file.path}`);
      checkedFiles++;
      if (Date.now() - lastProgress >= 500 || checkedFiles === resource.files.length) { progress(); lastProgress = Date.now(); }
    }
  }
  const paths = resolvedPaths(manifest, runtimeDir);
  for (const key of REQUIRED_PATHS) { const stat = await fsp.lstat(paths[key]); if (stat.isSymbolicLink()) fail("运行资源不能使用符号链接"); }
  const alignment = JSON.parse(await fsp.readFile(path.join(paths.alignmentRuntimeDir, "ready.json"), "utf8"));
  if (alignment.schemaVersion !== 1 || alignment.runtimeVersion !== "english-alignment-v1" || alignment.model !== "facebook/wav2vec2-base-960h" || alignment.device !== "cpu" || alignment.asrUsed !== false) fail("音频对齐就绪信息缺失或无效，请修复运行资源");
  if (deep) await _probeRuntime(paths, manifest, { signal, onProgress });
  return paths;
}
async function verifyRuntime({ manifestPath, baseDir, deep = false, allowHttpForTests = false, onProgress = () => {} }) {
  onProgress({ phase: "manifest", message: "正在读取并校验在线资源清单" });
  const manifest = await loadManifest(manifestPath, { allowHttpForTests });
  if (manifest.schemaVersion === 2) return require("./official-runtime.cjs").verifyOfficialRuntime({ manifest, baseDir, deep, onProgress });
  return inspectInstalled(manifest, path.join(path.resolve(baseDir), "runtimes", manifest.runtimeId), { deep, onProgress });
}

/** Windows scanners and exiting native probes may briefly retain a directory
 * handle. Retry the same atomic rename; never copy or remove its destination. */
async function renameDirectory(source, destination, { signal, onProgress = () => {}, timeoutMs = 15_000, action = "commit" } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail("运行资源目录切换超时设置无效");
  const started = Date.now(); let attempt = 0;
  const messages = { backup: "正在准备替换旧运行资源", commit: "正在完成运行资源安装", rollback: "正在恢复原运行资源" };
  for (;;) {
    checkAbort(signal);
    try { await fsp.rename(source, destination); return; }
    catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
      const elapsedMs = Date.now() - started;
      if (elapsedMs >= timeoutMs) {
        const failure = new Error(`等待运行资源目录释放超时（${error.code}），请稍后重试`, { cause: error });
        failure.code = error.code;
        throw failure;
      }
      attempt++;
      onProgress({ phase: "waiting-files", action, attempt, elapsedMs, message: `${messages[action] || messages.commit}，等待文件释放（${Math.floor(elapsedMs / 1000)} 秒，重试 ${attempt}）` });
      await sleep(Math.min(50 * 2 ** Math.min(attempt - 1, 5), 1000, timeoutMs - elapsedMs), signal);
    }
  }
}

async function prepareRuntime({ manifestPath, baseDir, supportDir, onProgress = () => {}, signal, allowHttpForTests = false, _probeRuntime = probeRuntime, _renameTimeoutMs = 15_000 }) {
  checkAbort(signal);
  onProgress({ phase: "manifest", message: "正在读取并校验在线资源清单" });
  const manifest = await loadManifest(manifestPath, { allowHttpForTests });
  if (manifest.schemaVersion === 2) return require("./official-runtime.cjs").prepareOfficialRuntime({ manifest, baseDir, supportDir, onProgress, signal, allowHttpForTests, _probeRuntime, _renameTimeoutMs });
  checkAbort(signal);
  onProgress({ phase: "preparing-directory", message: "正在准备运行资源安装目录" });
  baseDir = path.resolve(baseDir); await fsp.mkdir(baseDir, { recursive: true });
  const release = await acquireLock(baseDir, signal, onProgress);
  let staging; let failure;
  try {
    const runtimeDir = path.join(baseDir, "runtimes", manifest.runtimeId);
    try { const paths = await inspectInstalled(manifest, runtimeDir, { deep: true, _probeRuntime, signal, onProgress }); onProgress({ phase: "ready", message: "运行资源已就绪，复用已校验的安装" }); return paths; } catch { /* download/repair below */ }
    checkAbort(signal);
    const expanded = manifest.resources.flatMap(resource => resource.files).reduce((sum, file) => sum + file.size, 0);
    const required = expanded + manifest.resources.reduce((sum, resource) => sum + resource.size, 0) + 128 * 1024 ** 2;
    onProgress({ phase: "checking-space", message: "正在检查安装磁盘的可用空间" });
    const disk = await fsp.statfs(baseDir); if (Number(disk.bavail) * Number(disk.bsize) < required) fail(`安装磁盘空间不足，至少需要 ${(required / 1024 ** 3).toFixed(1)} GiB 可用空间`);
    // Keep temporary paths compact; Python also uses extended paths for deeply
    // nested imports. Including both runtimeId and UUID needlessly lengthened
    // paths even though the random UUID already identifies this staging tree.
    staging = path.join(baseDir, "runtimes", `.staging-${crypto.randomUUID()}`); await fsp.mkdir(staging, { recursive: true });
    for (let index = 0; index < manifest.resources.length; index++) {
      const resource = manifest.resources[index];
      const progress = event => onProgress({ ...event, completedResources: index, totalResources: manifest.resources.length });
      const archive = path.join(baseDir, "downloads", `${resource.id}-${resource.sha256}.tar.gz`);
      await downloadResource(resource, archive, { signal, onProgress: progress, allowHttpForTests });
      progress({ phase: "extracting", resourceId: resource.id, message: `正在展开并校验 ${resource.id}` });
      await extractResource(archive, staging, resource.files, { signal });
    }
    onProgress({ phase: "verifying", message: "正在离线自检 Node、CLI、Python 模型和媒体工具" });
    await _probeRuntime(resolvedPaths(manifest, staging), manifest, { signal, onProgress }); checkAbort(signal);
    // Native probing ran in staging. Write final informational paths before the
    // atomic move, so no ready.json ever depends on a transient build directory.
    const finalPaths = resolvedPaths(manifest, runtimeDir);
    const alignmentReadyPath = path.join(inside(staging, manifest.paths.alignmentRuntimeDir), "ready.json");
    const alignmentReady = JSON.parse(await fsp.readFile(alignmentReadyPath, "utf8"));
    await writeJson(alignmentReadyPath, { ...alignmentReady, python: finalPaths.alignmentPythonPath, modelDirectory: finalPaths.alignmentModelDir });
    // A stamp certifies both content hashes and native probes, never mere presence.
    await writeJson(path.join(staging, "runtime-ready.json"), { schemaVersion: 1, runtimeId: manifest.runtimeId, manifestSha256: manifestDigest(manifest), installedAt: new Date().toISOString() });
    onProgress({ phase: "committing", message: "正在保存已校验的运行资源" });
    let previous;
    try { await fsp.access(runtimeDir); previous = `${runtimeDir}.invalid-${crypto.randomUUID()}`; await renameDirectory(runtimeDir, previous, { signal, onProgress, timeoutMs: _renameTimeoutMs, action: "backup" }); } catch (error) { if (error.code !== "ENOENT") throw error; }
    try { await renameDirectory(staging, runtimeDir, { signal, onProgress, timeoutMs: _renameTimeoutMs }); staging = undefined; }
    catch (error) {
      if (previous) {
        onProgress({ phase: "rolling-back", message: "新资源尚未安装，正在恢复原运行资源" });
        // Rollback must run even when cancellation interrupted the commit.
        try { await renameDirectory(previous, runtimeDir, { onProgress, timeoutMs: _renameTimeoutMs, action: "rollback" }); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], `运行资源切换与恢复失败，原资源已保留在 ${previous}`, { cause: error }); }
      }
      throw error;
    }
    if (previous) await fsp.rm(previous, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await writeJson(path.join(baseDir, "runtime-state.json"), { schemaVersion: 1, runtimeId: manifest.runtimeId, manifestSha256: manifestDigest(manifest) });
    onProgress({ phase: "ready", message: "运行资源全部安装完成", completedResources: manifest.resources.length, totalResources: manifest.resources.length });
    return finalPaths;
  } catch (error) { failure = error; throw error; }
  finally {
    try {
      if (staging) {
        try { await fsp.rm(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
        catch (cleanupError) { if (!failure) throw cleanupError; failure.cleanupError = cleanupError; }
      }
    } finally { await release(); }
  }
}

module.exports = { prepareRuntime, verifyRuntime, validateManifest, loadManifest, downloadResource, extractResource, createRuntimeArchive, inventory, sha256, probeRuntime, renameDirectory,
  _internals: { safeRelative, inside, sourceUrl, matches, writeJson, manifestDigest, resolvedPaths, run, acquireLock, checkAbort, REQUIRED_PATHS } };
