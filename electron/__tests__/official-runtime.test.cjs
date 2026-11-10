const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");
const { createHash } = require("node:crypto");
const { createServer } = require("node:http");
const { spawnSync } = require("node:child_process");
const manager = require("../runtime-manager.cjs");
const { validateOfficialManifest, prepareOfficialRuntime, extractZip, extractTgz, configurePythonPaths } = require("../official-runtime.cjs");
const { withDomesticMirrors } = require("../runtime-sources.cjs");
const digest = value => createHash("sha256").update(value).digest("hex");

function zip(entries) {
  const local = []; const central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name); const bytes = Buffer.from(entry.content || ""); const compressed = zlib.deflateRawSync(bytes); const crc = zlib.crc32(bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8); header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(8, 10); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(((entry.symlink ? 0xa1ff : 0x81a4) << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42); central.push(directory, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
async function directory(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), "clipforge-official-中文 ")); t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return root; }

test("official ZIP extraction preserves content and rejects traversal, links, duplicates and CRC damage", async t => {
  const root = await directory(t); const archive = path.join(root, "test.zip"); const output = path.join(root, "safe");
  await fs.writeFile(archive, zip([{ name: "dist/中文/empty", content: "" }, { name: "dist/file.txt", content: "official payload" }, { name: "not-selected.txt", content: "other" }]));
  await extractZip(archive, output, { stripPrefix: "dist" });
  assert.equal(await fs.readFile(path.join(output, "file.txt"), "utf8"), "official payload");
  assert.equal((await fs.stat(path.join(output, "中文/empty"))).size, 0);
  await assert.rejects(fs.stat(path.join(output, "not-selected.txt")), { code: "ENOENT" });
  for (const [name, entries, pattern] of [
    ["traversal", [{ name: "../outside", content: "bad" }], /路径/],
    ["link", [{ name: "link", symlink: true, content: "outside" }], /链接/],
    ["duplicate", [{ name: "File", content: "one" }, { name: "file", content: "two" }], /重复/],
  ]) {
    const target = path.join(root, `${name}.zip`); await fs.writeFile(target, zip(entries));
    await assert.rejects(extractZip(target, path.join(root, name)), pattern);
  }
  const damaged = zip([{ name: "file", content: "payload" }]); damaged.writeUInt32LE(0, damaged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 16); await fs.writeFile(archive, damaged);
  await assert.rejects(extractZip(archive, path.join(root, "crc")), /CRC/);
});

test("official npm tar extraction strips its package prefix and supports PAX Unicode paths", async t => {
  const root = await directory(t); const source = path.join(root, "source");
  await fs.mkdir(path.join(source, "package/dist/中文"), { recursive: true }); await fs.writeFile(path.join(source, "package/dist/中文/cli.js"), "official npm CLI");
  const archive = path.join(root, "cli.tgz"); await manager.createRuntimeArchive({ sourceDir: source, outputPath: archive });
  await extractTgz(archive, path.join(root, "installed"), { stripPrefix: "package" });
  assert.equal(await fs.readFile(path.join(root, "installed/dist/中文/cli.js"), "utf8"), "official npm CLI");
});

async function fixture(t) {
  const root = await directory(t); const assets = new Map(); const requests = [];
  const source = path.join(root, "npm"); await fs.mkdir(path.join(source, "package/dist"), { recursive: true }); await fs.writeFile(path.join(source, "package/dist/cli.js"), "kling");
  const archive = path.join(root, "cli.tgz"); await manager.createRuntimeArchive({ sourceDir: source, outputPath: archive });
  const specs = [
    { id: "node", format: "zip", target: "node", stripPrefix: "distribution", payload: zip([{ name: "distribution/node.exe", content: "node" }]) },
    { id: "python", format: "zip", target: "alignment/python", payload: zip([{ name: "python.exe", content: "python" }, { name: "python312._pth", content: "python312.zip\n." }]) },
    { id: "kling", format: "tgz", target: "cli/kling", stripPrefix: "package", payload: await fs.readFile(archive) },
    { id: "elevenlabs", format: "file", target: "cli/eleven/elevenlabs.exe", payload: Buffer.from("eleven") },
    { id: "model", format: "file", target: "alignment/model/weights", payload: Buffer.from("weights") },
    { id: "wasm", format: "file", target: "asr/wasm/engine.wasm", payload: Buffer.from("wasm") },
    { id: "ffmpeg", format: "gzip", target: "media/ffmpeg.exe", payload: zlib.gzipSync(Buffer.from("ffmpeg")) },
    { id: "ffprobe", format: "file", target: "media/ffprobe.exe", payload: Buffer.from("ffprobe") },
    { id: "pip", format: "wheel", target: "alignment/wheelhouse/pip-1.0-py3-none-any.whl", fileName: "pip-1.0-py3-none-any.whl", role: "pip", payload: zip([{ name: "pip/__init__.py", content: "" }]) },
    { id: "dep", format: "wheel", target: "alignment/wheelhouse/dep-1.0-py3-none-any.whl", fileName: "dep-1.0-py3-none-any.whl", pythonRequirement: "dep==1.0", role: "python-dependency", payload: zip([{ name: "dep.py", content: "" }]) },
  ];
  const server = createServer((req, res) => { requests.push(req.url); const payload = assets.get(req.url); if (!payload) { res.writeHead(404); res.end(); return; } res.writeHead(200, { "Content-Length": payload.length }); res.end(payload); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const resources = specs.map(({ payload, ...entry }) => { assets.set(`/${entry.id}`, payload); return { ...entry, url: `${origin}/${entry.id}`, size: payload.length, sha256: digest(payload) }; });
  const supportDir = path.join(root, "support"); const supportFiles = [];
  for (const name of ["alignment/scripts/check-runtime.py", "alignment/scripts/align.py", "alignment/scripts/runtime-spec.json", "media/fonts/subtitle.otf"]) {
    const target = path.join(supportDir, name); await fs.mkdir(path.dirname(target), { recursive: true }); const bytes = Buffer.from(name); await fs.writeFile(target, bytes); supportFiles.push({ path: name, size: bytes.length, sha256: digest(bytes) });
  }
  const manifest = { schemaVersion: 2, installMode: "official-sources", runtimeId: "official-test-v1", appVersion: "1.0", platform: process.platform, arch: process.arch, nodeVersion: process.versions.node, nodeAbi: Number(process.versions.modules), resources, supportFiles,
    python: { version: "3.12.10", pipResourceId: "pip", wheelResourceIds: ["dep"] },
    paths: { nodePath: "node/node.exe", klingPackagePath: "cli/kling", elevenLabsPackagePath: "cli/eleven", elevenLabsExecutable: "cli/eleven/elevenlabs.exe", alignmentRuntimeDir: "alignment", alignmentPythonPath: "alignment/python/python.exe", alignmentModelDir: "alignment/model", alignmentCheckerPath: "alignment/scripts/check-runtime.py", asrModelDir: "asr", wasmDir: "asr/wasm", ffmpegPath: "media/ffmpeg.exe", ffprobePath: "media/ffprobe.exe" } };
  const manifestPath = path.join(root, "manifest.json"); await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const baseDir = path.join(root, "installed"); let configurations = 0; let probes = 0;
  const options = { manifest, baseDir, supportDir, allowHttpForTests: true,
    _configurePython: async (_manifest, staging, cache) => { configurations++; assert.equal(cache.size, resources.length); assert.equal(await fs.readFile(path.join(staging, "media/ffmpeg.exe"), "utf8"), "ffmpeg"); },
    _probeRuntime: async paths => { probes++; await fs.writeFile(path.join(paths.alignmentRuntimeDir, "ready.json"), JSON.stringify({ schemaVersion: 1, runtimeVersion: "english-alignment-v1", model: "facebook/wav2vec2-base-960h", device: "cpu", asrUsed: false })); },
  };
  return { root, manifest, manifestPath, baseDir, supportDir, resources, requests, options, configurations: () => configurations, probes: () => probes };
}

test("official-source installation downloads individual upstream artifacts, configures, verifies and reuses inventory", async t => {
  const f = await fixture(t);
  assert.equal(manager.validateManifest(f.manifest, { allowHttpForTests: true }), f.manifest);
  const paths = await prepareOfficialRuntime(f.options);
  assert.equal(f.requests.length, f.resources.length); assert.equal(f.configurations(), 1); assert.equal(f.probes(), 1);
  const stamp = JSON.parse(await fs.readFile(path.join(paths.runtimeDir, "runtime-ready.json"), "utf8"));
  assert.equal(stamp.schemaVersion, 2); assert.ok(stamp.files.length > 8); assert.ok(!stamp.files.some(file => /ready\.json|wheelhouse/.test(file.path)));
  const cached = await Promise.all(f.resources.map(async resource => (await fs.stat(path.join(f.baseDir, "downloads", `${resource.id}-${resource.sha256}.download`))).mtimeMs));
  await prepareOfficialRuntime(f.options);
  assert.equal(f.requests.length, f.resources.length); assert.equal(f.configurations(), 1); assert.equal(f.probes(), 2);
  assert.deepEqual(await Promise.all(f.resources.map(async resource => (await fs.stat(path.join(f.baseDir, "downloads", `${resource.id}-${resource.sha256}.download`))).mtimeMs)), cached);
  const verified = await manager.verifyRuntime({ manifestPath: f.manifestPath, baseDir: f.baseDir, allowHttpForTests: true }); assert.equal(verified.runtimeDir, paths.runtimeDir);
  await fs.writeFile(paths.nodePath, "broken");
  await assert.rejects(manager.verifyRuntime({ manifestPath: f.manifestPath, baseDir: f.baseDir, allowHttpForTests: true }), /缺失或已损坏/);
  await prepareOfficialRuntime(f.options); assert.equal(f.requests.length, f.resources.length); assert.equal(f.configurations(), 2);
});

test("official manifest rejects private bundles, missing dependency pins and unsafe targets", async t => {
  const f = await fixture(t);
  const bundle = structuredClone(f.manifest); bundle.resources[0].url = "https://github.com/HuaqingAI/clipforge/releases/download/v1/runtime.zip";
  assert.throws(() => validateOfficialManifest(bundle, { allowHttpForTests: true }), /自建运行资源包/);
  const traversal = structuredClone(f.manifest); traversal.resources[0].target = "../outside";
  assert.throws(() => validateOfficialManifest(traversal, { allowHttpForTests: true }), /路径/);
  const missing = structuredClone(f.manifest); delete missing.resources.at(-1).pythonRequirement;
  assert.throws(() => validateOfficialManifest(missing, { allowHttpForTests: true }), /固定版本/);
});

test("official manifests allow reviewed mirrors without authorizing arbitrary paths on their hosts", async t => {
  const f = await fixture(t); const dependency = f.manifest.resources.find(resource => resource.id === "dep");
  Object.assign(dependency, withDomesticMirrors({ ...dependency, url: "https://files.pythonhosted.org/packages/ab/cd/pinned/dep-1.0-py3-none-any.whl" }));
  assert.doesNotThrow(() => validateOfficialManifest(f.manifest, { allowHttpForTests: true }));
  dependency.mirrors[0] = dependency.mirrors[0].replace("dep-1.0", "dep-2.0");
  assert.throws(() => validateOfficialManifest(f.manifest, { allowHttpForTests: true }), /已审核/);
});

test("failed mirrors and upstreams cannot configure or commit a runtime", async t => {
  const f = await fixture(t); const first = f.manifest.resources[0]; const payload = Buffer.alloc(first.size, 0x78); const requested = [];
  const server = createServer((req, res) => { requested.push(req.url); if (req.url === "/missing") { res.writeHead(404); res.end(); return; } res.writeHead(200, { "Content-Length": payload.length }); res.end(payload); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  first.mirrors = [`${origin}/corrupt`]; first.url = `${origin}/missing`;
  await assert.rejects(prepareOfficialRuntime(f.options), /下载|SHA256/);
  assert.deepEqual(requested, ["/corrupt", "/missing"]);
  assert.equal(f.configurations(), 0); assert.equal(f.probes(), 0);
  await assert.rejects(fs.stat(path.join(f.baseDir, "downloads", `${first.id}-${first.sha256}.download`)), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(f.baseDir, "runtime-state.json")), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(path.join(f.baseDir, "runtimes")), []);
});

test("official-source failures never create ready state or replace existing versions", async t => {
  const f = await fixture(t); const previous = path.join(f.baseDir, "runtimes/older"); await fs.mkdir(previous, { recursive: true }); await fs.writeFile(path.join(previous, "keep"), "previous");
  await assert.rejects(prepareOfficialRuntime({ ...f.options, _probeRuntime: async () => { throw new Error("native failed"); } }), /native failed/);
  assert.deepEqual(await fs.readdir(path.join(f.baseDir, "runtimes")), ["older"]);
  await assert.rejects(fs.stat(path.join(f.baseDir, "runtime-state.json")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(f.baseDir, ".runtime-install.lock")), { code: "ENOENT" });
  await fs.writeFile(path.join(f.supportDir, f.manifest.supportFiles[0].path), "bad support");
  await assert.rejects(prepareOfficialRuntime(f.options), /配套文件校验失败/);
  assert.equal(await fs.readFile(path.join(previous, "keep"), "utf8"), "previous");
});

test("embedded Python automatically supports deep library imports before and after relocation", { skip: process.platform !== "win32" || !process.env.CLIPFORGE_TEST_EMBEDDED_PYTHON_DIR }, async t => {
  const root = await directory(t);
  const source = path.resolve(process.env.CLIPFORGE_TEST_EMBEDDED_PYTHON_DIR);
  const pythonDir = path.join(root, "安装 目录", "p".repeat(90), "python");
  await fs.mkdir(pythonDir, { recursive: true });
  // Copy the official embedded distribution, excluding installed dependencies.
  for (const entry of await fs.readdir(source, { withFileTypes: true })) if (entry.isFile() && entry.name !== "sitecustomize.py") await fs.copyFile(path.join(source, entry.name), path.join(pythonDir, entry.name));
  const moduleDir = path.join(pythonDir, "Lib/site-packages/deep_library", "m".repeat(60));
  await fs.mkdir(moduleDir, { recursive: true });
  const moduleFile = path.join(moduleDir, "configuration_long_windows_library.py");
  assert.ok(moduleFile.length > 260);
  await fs.writeFile(moduleFile, "value = 42\n");
  await configurePythonPaths(pythonDir, "3.12.10");
  const inspect = "import sys,json,importlib;module=importlib.import_module('deep_library.'+'m'*60+'.configuration_long_windows_library');print(json.dumps({'value':module.value,'file':module.__file__,'paths':sys.path,'no_bytecode':sys.dont_write_bytecode}))";
  const run = async directory => {
    const result = spawnSync(path.toNamespacedPath(path.join(directory, "python.exe")), ["-I", "-c", inspect], { encoding: "utf8", windowsHide: true, env: { SystemRoot: process.env.SystemRoot } });
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(result.stdout);
    assert.equal(state.value, 42); assert.equal(state.no_bytecode, true);
    assert.ok(state.paths.every(value => value.startsWith("\\\\?\\")));
    assert.ok(state.file.startsWith("\\\\?\\"));
    const rootPath = path.toNamespacedPath(directory);
    assert.ok(state.file.startsWith(rootPath));
  };
  await run(pythonDir);
  const moved = path.join(path.dirname(pythonDir), "installed-python");
  await fs.rename(pythonDir, moved);
  await run(moved);
  await assert.rejects(fs.stat(path.join(moved, "Lib/site-packages/deep_library", "m".repeat(60), "__pycache__")), { code: "ENOENT" });
});
