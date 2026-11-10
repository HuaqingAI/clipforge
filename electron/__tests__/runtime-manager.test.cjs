const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { createRuntimeArchive, downloadResource, extractResource, prepareRuntime, verifyRuntime, validateManifest } = require("../runtime-manager.cjs");

async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function holdDirectory(directory) {
  const child = spawn(process.execPath, ["-e", "process.send('ready');setInterval(()=>{},1000)"], { cwd: directory, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const closed = new Promise(resolve => child.once("close", resolve));
  try { await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); child.once("exit", code => reject(new Error(`Directory holder exited before ready (${code})`))); }); }
  catch (error) { child.kill(); await closed; throw error; }
  let releasing;
  return { release: () => releasing ||= (async () => { if (child.exitCode === null) child.kill(); await closed; })() };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipforge-runtime-中文 空格-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const content = {
    "node/node.exe": "node fixture",
    "cli/kling/dist/cli.js": "kling fixture",
    "cli/eleven/elevenlabs.exe": "eleven fixture",
    "alignment/python.exe": "python fixture",
    "alignment/check.py": "checker fixture",
    "alignment/model/weights": "model fixture",
    "asr/wasm/engine.wasm": "wasm fixture",
    "media/ffmpeg.exe": "ffmpeg fixture",
    "media/ffprobe.exe": "ffprobe fixture",
    [`asr/${"模型目录".repeat(35)}/empty`]: "",
  };
  for (const [name, value] of Object.entries(content)) { await mkdir(path.dirname(path.join(source, name)), { recursive: true }); await writeFile(path.join(source, name), value); }
  const archive = path.join(root, "fixture.tar.gz"); const resource = await createRuntimeArchive({ sourceDir: source, outputPath: archive });
  const buffer = await readFile(archive); let requests = 0;
  const server = createServer((req, res) => { requests++; res.writeHead(200, { "Content-Length": buffer.length }); res.end(buffer); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/fixture.tar.gz`;
  const manifest = {
    schemaVersion: 1, runtimeId: "fixture-v1", platform: process.platform, arch: process.arch, nodeVersion: process.versions.node, nodeAbi: Number(process.versions.modules),
    resources: [{ id: "fixture", url, ...resource }],
    paths: { nodePath: "node/node.exe", klingPackagePath: "cli/kling", elevenLabsPackagePath: "cli/eleven", elevenLabsExecutable: "cli/eleven/elevenlabs.exe", alignmentRuntimeDir: "alignment", alignmentPythonPath: "alignment/python.exe", alignmentModelDir: "alignment/model", alignmentCheckerPath: "alignment/check.py", asrModelDir: "asr", wasmDir: "asr/wasm", ffmpegPath: "media/ffmpeg.exe", ffprobePath: "media/ffprobe.exe" },
  };
  const manifestPath = path.join(root, "manifest.json"); await writeFile(manifestPath, JSON.stringify(manifest));
  const baseDir = path.join(root, "installed");
  const probe = async paths => writeFile(path.join(paths.alignmentRuntimeDir, "ready.json"), JSON.stringify({ schemaVersion: 1, runtimeVersion: "english-alignment-v1", model: "facebook/wav2vec2-base-960h", device: "cpu", asrUsed: false }));
  return { root, source, archive, resource, manifest, manifestPath, baseDir, probe, requests: () => requests, content };
}

test("archives preserve Unicode/long paths and empty files and validate every payload", async t => {
  const f = await fixture(t); const output = path.join(f.root, "expanded"); await mkdir(output);
  await extractResource(f.archive, output, f.resource.files);
  for (const [name, value] of Object.entries(f.content)) assert.equal(await readFile(path.join(output, name), "utf8"), value);
  await assert.rejects(extractResource(f.archive, path.join(f.root, "missing-entry"), f.resource.files.slice(1)), /不在清单内/);
  const changed = f.resource.files.map((file, index) => index === 0 ? { ...file, sha256: "0".repeat(64) } : file);
  await assert.rejects(extractResource(f.archive, path.join(f.root, "corrupt-entry"), changed), /校验失败/);
});

test("manifest rejects path traversal, duplicate Windows names, unexpected targets and remote HTTP", async t => {
  const f = await fixture(t);
  assert.throws(() => validateManifest(f.manifest), /HTTPS/);
  assert.doesNotThrow(() => validateManifest(f.manifest, { allowHttpForTests: true }));
  const copy = structuredClone(f.manifest); copy.resources[0].files[0].path = "../outside";
  assert.throws(() => validateManifest(copy, { allowHttpForTests: true }), /路径/);
  const duplicate = structuredClone(f.manifest); duplicate.resources[0].files.push({ ...duplicate.resources[0].files[0], path: duplicate.resources[0].files[0].path.toUpperCase() });
  assert.throws(() => validateManifest(duplicate, { allowHttpForTests: true }), /重复/);
  assert.throws(() => validateManifest({ ...f.manifest, platform: "wrong" }, { allowHttpForTests: true }), /平台/);
  const remote = structuredClone(f.manifest); remote.resources[0].url = "http://example.com/fixture.tar.gz";
  assert.throws(() => validateManifest(remote, { allowHttpForTests: true }), /HTTPS/);
});

test("download resumes a partial with Range and validates final SHA256", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipforge-download-")); t.after(() => rm(root, { recursive: true, force: true }));
  const payload = Buffer.from("verified runtime resource payload".repeat(100)); const prefix = 117; let range;
  const server = createServer((req, res) => { range = req.headers.range; const start = range ? Number(range.match(/bytes=(\d+)-/)[1]) : 0; res.writeHead(start ? 206 : 200, { "Content-Length": payload.length - start, "Content-Range": `bytes ${start}-${payload.length - 1}/${payload.length}`, ETag: '"pinned"' }); res.end(payload.subarray(start)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const resource = { id: "range", url: `http://127.0.0.1:${server.address().port}/range`, size: payload.length, sha256: createHash("sha256").update(payload).digest("hex") };
  const target = path.join(root, "download.tar.gz"); await writeFile(`${target}.part`, payload.subarray(0, prefix)); await writeFile(`${target}.part.json`, JSON.stringify({ url: resource.url, sha256: resource.sha256, etag: '"pinned"' }));
  await downloadResource(resource, target, { allowHttpForTests: true });
  assert.equal(range, `bytes=${prefix}-`); assert.deepEqual(await readFile(target), payload);
  await assert.rejects(stat(`${target}.part`), { code: "ENOENT" });
});

test("download prefers a verified mirror and reuses its cache after source settings change", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipforge-mirror-cache-")); t.after(() => rm(root, { recursive: true, force: true }));
  const payload = Buffer.from("verified model bytes"); const requests = [];
  const origin = await serve(t, (req, res) => { requests.push(req.url); res.writeHead(200, { "Content-Length": payload.length }); res.end(payload); });
  const resource = { id: "model", url: `${origin}/upstream`, mirrors: [`${origin}/mirror`], size: payload.length, sha256: createHash("sha256").update(payload).digest("hex") };
  const target = path.join(root, "model.download"); const events = [];
  await downloadResource(resource, target, { allowHttpForTests: true, onProgress: event => events.push(event) });
  assert.deepEqual(requests, ["/mirror"]);
  assert.deepEqual(await readFile(target), payload);
  assert.ok(events.some(event => event.sourceUrl === resource.mirrors[0]));
  await downloadResource({ ...resource, mirrors: [], url: `${origin}/new-upstream` }, target, { allowHttpForTests: true });
  assert.deepEqual(requests, ["/mirror"]);
});

test("missing and same-size corrupt mirrors fall back without changing the pinned checksum", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipforge-mirror-fallback-")); t.after(() => rm(root, { recursive: true, force: true }));
  const payload = Buffer.from("trusted fixed wheel content"); const requests = [];
  const origin = await serve(t, (req, res) => {
    requests.push(req.url);
    if (req.url === "/missing") { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Length": payload.length }); res.end(req.url === "/corrupt" ? Buffer.alloc(payload.length, 0x78) : payload);
  });
  const resource = { id: "wheel", url: `${origin}/upstream`, mirrors: [`${origin}/missing`, `${origin}/corrupt`], size: payload.length, sha256: createHash("sha256").update(payload).digest("hex") };
  const target = path.join(root, "wheel.download"); const events = [];
  await downloadResource(resource, target, { allowHttpForTests: true, onProgress: event => events.push(event) });
  assert.deepEqual(requests, ["/missing", "/corrupt", "/upstream"]);
  assert.deepEqual(await readFile(target), payload);
  assert.equal(events.filter(event => event.phase === "fallback").length, 2);
  assert.ok(events.some(event => event.phase === "fallback" && /SHA256/.test(event.message)));
  await assert.rejects(stat(`${target}.part`), { code: "ENOENT" });
});

test("switching a failed source never forwards its partial Range or ETag to the next source", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipforge-mirror-range-")); t.after(() => rm(root, { recursive: true, force: true }));
  const payload = Buffer.from("trusted complete model payload"); const requests = [];
  const origin = await serve(t, (req, res) => {
    requests.push({ url: req.url, range: req.headers.range, ifRange: req.headers["if-range"] });
    if (req.url === "/mirror") { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Length": payload.length }); res.end(payload);
  });
  const resource = { id: "model", url: `${origin}/upstream`, mirrors: [`${origin}/mirror`], size: payload.length, sha256: createHash("sha256").update(payload).digest("hex") };
  const target = path.join(root, "model.download");
  await writeFile(`${target}.part`, Buffer.alloc(5, 0x78));
  await writeFile(`${target}.part.json`, JSON.stringify({ url: resource.mirrors[0], sha256: resource.sha256, etag: '"mirror-only"' }));
  await downloadResource(resource, target, { allowHttpForTests: true });
  assert.deepEqual(requests, [{ url: "/mirror", range: "bytes=5-", ifRange: '"mirror-only"' }, { url: "/upstream", range: undefined, ifRange: undefined }]);
  assert.deepEqual(await readFile(target), payload);
});

test("restarting preserves a partial from an approved fallback but never requests an unlisted metadata URL", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipforge-mirror-restart-")); t.after(() => rm(root, { recursive: true, force: true }));
  const payload = Buffer.from("verified partial model bytes retained across install runs"); const prefix = 17; const requests = [];
  const origin = await serve(t, (req, res) => {
    requests.push({ url: req.url, range: req.headers.range, ifRange: req.headers["if-range"] });
    if (req.url === "/missing-first") { res.writeHead(404); res.end(); return; }
    const offset = req.headers.range ? Number(req.headers.range.match(/^bytes=(\d+)-$/)[1]) : 0;
    res.writeHead(offset ? 206 : 200, { "Content-Length": payload.length - offset, "Content-Range": `bytes ${offset}-${payload.length - 1}/${payload.length}`, ETag: '"retained-source"' });
    res.end(payload.subarray(offset));
  });
  const resource = { id: "model", url: `${origin}/upstream`, mirrors: [`${origin}/missing-first`, `${origin}/second-mirror`], size: payload.length, sha256: createHash("sha256").update(payload).digest("hex") };
  for (const pathname of ["/second-mirror", "/upstream"]) {
    requests.length = 0;
    const target = path.join(root, `${pathname.slice(1)}.download`);
    await writeFile(`${target}.part`, payload.subarray(0, prefix));
    await writeFile(`${target}.part.json`, JSON.stringify({ url: `${origin}${pathname}`, sha256: resource.sha256, etag: '"retained-source"' }));
    await downloadResource(resource, target, { allowHttpForTests: true });
    assert.deepEqual(requests, [{ url: pathname, range: `bytes=${prefix}-`, ifRange: '"retained-source"' }]);
    assert.deepEqual(await readFile(target), payload);
  }
  requests.length = 0;
  const target = path.join(root, "unlisted.download");
  await writeFile(`${target}.part`, Buffer.alloc(prefix, 0x78));
  await writeFile(`${target}.part.json`, JSON.stringify({ url: `${origin}/unlisted-source`, sha256: resource.sha256, etag: '"unlisted-etag"' }));
  await downloadResource(resource, target, { allowHttpForTests: true });
  assert.deepEqual(requests, [{ url: "/missing-first", range: undefined, ifRange: undefined }, { url: "/second-mirror", range: undefined, ifRange: undefined }]);
  assert.deepEqual(await readFile(target), payload);
});

test("a stalled mirror times out once before trying the upstream", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipforge-mirror-timeout-")); t.after(() => rm(root, { recursive: true, force: true }));
  const payload = Buffer.from("pinned content"); const requests = [];
  const origin = await serve(t, (req, res) => {
    requests.push(req.url);
    if (req.url === "/mirror") return;
    res.writeHead(200, { "Content-Length": payload.length }); res.end(payload);
  });
  const resource = { id: "model", url: `${origin}/upstream`, mirrors: [`${origin}/mirror`], size: payload.length, sha256: createHash("sha256").update(payload).digest("hex") };
  await downloadResource(resource, path.join(root, "model.download"), { allowHttpForTests: true, connectTimeoutMs: 100 });
  assert.deepEqual(requests, ["/mirror", "/upstream"]);
});

test("cancelling an active mirror download never starts another source", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipforge-mirror-cancel-")); t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController(); const payload = Buffer.from("pinned content"); const requests = [];
  const origin = await serve(t, (req, res) => { requests.push(req.url); res.writeHead(200, { "Content-Length": payload.length }); res.write(payload.subarray(0, 3)); });
  const resource = { id: "model", url: `${origin}/upstream`, mirrors: [`${origin}/mirror`], size: payload.length, sha256: createHash("sha256").update(payload).digest("hex") };
  const target = path.join(root, "model.download");
  await assert.rejects(downloadResource(resource, target, { allowHttpForTests: true, signal: controller.signal,
    onProgress: event => { if (event.phase === "downloading" && event.receivedBytes > 0) controller.abort(new Error("cancel mirror test")); },
  }), /cancel mirror test/);
  assert.deepEqual(requests, ["/mirror"]);
  await assert.rejects(stat(target), { code: "ENOENT" });
});

test("prepare commits only after native probes and reuses a verified install without another download", async t => {
  const f = await fixture(t); let probes = 0;
  const options = { manifestPath: f.manifestPath, baseDir: f.baseDir, allowHttpForTests: true, _probeRuntime: async paths => { probes++; await f.probe(paths); } };
  const first = await prepareRuntime(options); assert.equal(f.requests(), 1); assert.equal(probes, 1);
  const ready = JSON.parse(await readFile(path.join(first.alignmentRuntimeDir, "ready.json"), "utf8"));
  assert.equal(ready.python, first.alignmentPythonPath); assert.equal(ready.modelDirectory, first.alignmentModelDir);
  const quick = await verifyRuntime({ manifestPath: f.manifestPath, baseDir: f.baseDir, allowHttpForTests: true });
  assert.equal(quick.nodePath, first.nodePath);
  const second = await prepareRuntime(options); assert.equal(second.runtimeDir, first.runtimeDir); assert.equal(f.requests(), 1); assert.equal(probes, 2);
  await writeFile(first.nodePath, "broken");
  await assert.rejects(verifyRuntime({ manifestPath: f.manifestPath, baseDir: f.baseDir, allowHttpForTests: true }), /缺失或已损坏/);
  const repaired = await prepareRuntime(options); assert.equal(await readFile(repaired.nodePath, "utf8"), "node fixture"); assert.equal(f.requests(), 1);
});

test("failed probes do not install ready state, replace an older runtime, or leave a lock", async t => {
  const f = await fixture(t); const older = path.join(f.baseDir, "runtimes/older-version"); await mkdir(older, { recursive: true }); await writeFile(path.join(older, "keep"), "older remains usable");
  await assert.rejects(prepareRuntime({ manifestPath: f.manifestPath, baseDir: f.baseDir, allowHttpForTests: true, _probeRuntime: async () => { throw new Error("native inference failed"); } }), /native inference failed/);
  assert.equal(await readFile(path.join(older, "keep"), "utf8"), "older remains usable");
  assert.deepEqual(await readdir(path.join(f.baseDir, "runtimes")), ["older-version"]);
  await assert.rejects(stat(path.join(f.baseDir, ".runtime-install.lock")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(f.baseDir, "runtime-state.json")), { code: "ENOENT" });
});

test("checksum failure cannot reach extraction or produce a ready marker", async t => {
  const f = await fixture(t); f.manifest.resources[0].sha256 = "0".repeat(64); await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  let probed = false;
  await assert.rejects(prepareRuntime({ manifestPath: f.manifestPath, baseDir: f.baseDir, allowHttpForTests: true, _probeRuntime: async () => { probed = true; } }), /SHA256/);
  assert.equal(probed, false); assert.deepEqual(await readdir(path.join(f.baseDir, "runtimes")), []);
});

test("parallel installers serialize with a kernel mutex even when a dead PID file remains", async t => {
  const f = await fixture(t); await mkdir(f.baseDir, { recursive: true });
  await writeFile(path.join(f.baseDir, ".runtime-install.lock"), JSON.stringify({ pid: 2147483646, nonce: "dead-owner" }));
  let active = 0; let maximum = 0;
  const probe = async paths => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 30)); await f.probe(paths); active--; };
  const options = { manifestPath: f.manifestPath, baseDir: f.baseDir, allowHttpForTests: true, _probeRuntime: probe };
  const [first, second] = await Promise.all([prepareRuntime(options), prepareRuntime(options)]);
  assert.equal(first.runtimeDir, second.runtimeDir); assert.equal(maximum, 1); assert.equal(f.requests(), 1);
  await assert.rejects(stat(path.join(f.baseDir, ".runtime-install.lock")), { code: "ENOENT" });
});

test("native probes use compact staging paths regardless of runtime identifier length", async t => {
  const f = await fixture(t);
  f.manifest.runtimeId = `desktop-${"r".repeat(130)}`;
  await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  const paths = await prepareRuntime({
    manifestPath: f.manifestPath, baseDir: f.baseDir, allowHttpForTests: true,
    _probeRuntime: async staged => {
      const metadata = path.join(staged.alignmentRuntimeDir, "python/Lib/site-packages/torchaudio-2.8.0+cpu.dist-info/METADATA");
      assert.ok(metadata.length < 260, `Native metadata exceeds Windows MAX_PATH: ${metadata.length}`);
      await f.probe(staged);
    },
  });
  assert.equal(path.basename(paths.runtimeDir), f.manifest.runtimeId);
});

test("installation reports each preparation stage before download and reports deep reuse checks", async t => {
  const f = await fixture(t); const events = [];
  const options = { manifestPath: f.manifestPath, baseDir: f.baseDir, allowHttpForTests: true, _probeRuntime: f.probe, onProgress: event => events.push(event) };
  await prepareRuntime(options);
  const phases = events.map(event => event.phase);
  const expected = ["manifest", "preparing-directory", "checking-lock", "checking-installed", "checking-space", "checking-cache", "connecting", "downloading", "checking-download", "extracting", "verifying", "ready"];
  for (let index = 1; index < expected.length; index++) assert.ok(phases.indexOf(expected[index - 1]) < phases.indexOf(expected[index]), `${expected[index - 1]} should precede ${expected[index]}`);
  events.length = 0;
  await prepareRuntime(options);
  assert.ok(events.some(event => event.phase === "checking-installed" && event.checkedFiles === f.resource.files.length));
  assert.ok(!events.some(event => event.phase === "connecting"));
  events.length = 0;
  await assert.rejects(prepareRuntime({ ...options, manifestPath: path.join(f.root, "missing-manifest.json") }), { code: "ENOENT" });
  assert.deepEqual(events.map(event => event.phase), ["manifest"]);
});

test("valid archive cache reports validation and reuse without contacting its server", async t => {
  const f = await fixture(t); const phases = [];
  await downloadResource(f.manifest.resources[0], f.archive, { allowHttpForTests: true, onProgress: event => phases.push(event.phase) });
  assert.deepEqual(phases, ["checking-cache", "cached"]);
  assert.equal(f.requests(), 0);
});

test("missing public resources fail once with a publication error and initial connection progress", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipforge-missing-resource-")); t.after(() => rm(root, { recursive: true, force: true }));
  const events = []; let requests = 0; let phasesAtRequest;
  const origin = await serve(t, (_req, res) => { requests++; phasesAtRequest = events.map(event => event.phase); res.writeHead(404); res.end("Not Found"); });
  const resource = { id: "node", url: `${origin}/not-published.tar.gz`, size: 10, sha256: "0".repeat(64) };
  await assert.rejects(downloadResource(resource, path.join(root, "download.tar.gz"), { allowHttpForTests: true, onProgress: event => events.push(event) }), /在线资源尚未发布.*HTTP 404/);
  assert.equal(requests, 1);
  assert.deepEqual(phasesAtRequest, ["checking-cache", "connecting"]);
  assert.ok(!events.some(event => event.phase === "retrying"));
});

test("a server that never sends headers hits the connection deadline with bounded retries", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipforge-connection-timeout-")); t.after(() => rm(root, { recursive: true, force: true }));
  let requests = 0; const events = [];
  const origin = await serve(t, () => { requests++; });
  const resource = { id: "model", url: `${origin}/no-response`, size: 10, sha256: "0".repeat(64) };
  const started = Date.now();
  await assert.rejects(downloadResource(resource, path.join(root, "download.tar.gz"), { allowHttpForTests: true, connectTimeoutMs: 150, idleTimeoutMs: 100, onProgress: event => events.push(event) }), /连接资源服务器超时/);
  assert.equal(requests, 3);
  assert.equal(events.filter(event => event.phase === "connecting").length, 3);
  assert.equal(events.filter(event => event.phase === "retrying").length, 2);
  assert.ok(Date.now() - started < 5000, "A stalled connection must fail without waiting for a model download deadline");
});

test("a stalled body times out and resumes its partial bytes on the next attempt", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipforge-idle-timeout-")); t.after(() => rm(root, { recursive: true, force: true }));
  const payload = Buffer.from("offline model payload".repeat(20)); const prefix = 31; const events = []; let requests = 0; let resumedRange;
  const origin = await serve(t, (req, res) => {
    requests++;
    if (requests === 1) { res.writeHead(200, { "Content-Length": payload.length, ETag: '"immutable-model"' }); res.write(payload.subarray(0, prefix)); }
    else { resumedRange = req.headers.range; res.writeHead(206, { "Content-Length": payload.length - prefix, "Content-Range": `bytes ${prefix}-${payload.length - 1}/${payload.length}` }); res.end(payload.subarray(prefix)); }
  });
  const resource = { id: "model", url: `${origin}/paused-body`, size: payload.length, sha256: createHash("sha256").update(payload).digest("hex") };
  const target = path.join(root, "download.tar.gz");
  await downloadResource(resource, target, { allowHttpForTests: true, connectTimeoutMs: 1000, idleTimeoutMs: 100, onProgress: event => events.push(event) });
  assert.equal(requests, 2); assert.equal(resumedRange, `bytes=${prefix}-`);
  assert.deepEqual(await readFile(target), payload);
  assert.ok(events.some(event => event.phase === "retrying" && /没有收到数据/.test(event.message)));
});

test("user cancellation while waiting for headers aborts promptly without retrying", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipforge-download-cancel-")); t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController(); const events = []; const cancelled = new Error("user cancelled download"); let requests = 0;
  const origin = await serve(t, () => { requests++; controller.abort(cancelled); });
  const resource = { id: "model", url: `${origin}/cancel`, size: 10, sha256: "0".repeat(64) };
  await assert.rejects(downloadResource(resource, path.join(root, "download.tar.gz"), { signal: controller.signal, allowHttpForTests: true, onProgress: event => events.push(event) }), error => error === cancelled);
  assert.equal(requests, 1);
  assert.ok(!events.some(event => event.phase === "retrying"));
});

test("Windows atomic commit waits for a real child process to release its working directory", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t); const events = []; let holder; let releaseTimer;
  try {
    const paths = await prepareRuntime({
      manifestPath: f.manifestPath, baseDir: f.baseDir, allowHttpForTests: true,
      _probeRuntime: async staged => { await f.probe(staged); holder = await holdDirectory(staged.runtimeDir); },
      onProgress: event => {
        events.push(event);
        if (event.phase === "waiting-files" && !releaseTimer) releaseTimer = setTimeout(() => { holder.release(); }, 180);
      },
    });
    assert.equal(await readFile(paths.nodePath, "utf8"), "node fixture");
    const waits = events.filter(event => event.phase === "waiting-files");
    assert.ok(waits.length >= 2, "A real Windows cwd sharing lock must block more than one rename attempt");
    assert.ok(waits.every(event => event.action === "commit" && event.attempt > 0 && event.elapsedMs >= 0));
    assert.equal(events.at(-1).phase, "ready");
    assert.deepEqual(await readdir(path.join(f.baseDir, "runtimes")), [f.manifest.runtimeId]);
  } finally { clearTimeout(releaseTimer); await holder?.release(); }
});

test("Windows commit lock timeout atomically restores the previous runtime and releases installation ownership", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  const first = await prepareRuntime({ manifestPath: f.manifestPath, baseDir: f.baseDir, allowHttpForTests: true, _probeRuntime: f.probe });
  await writeFile(path.join(first.runtimeDir, "keep-original"), "the previous runtime must survive");
  const originalReady = await readFile(path.join(first.runtimeDir, "runtime-ready.json"), "utf8");
  const originalState = await readFile(path.join(f.baseDir, "runtime-state.json"), "utf8");
  f.manifest.appVersion = "replacement"; await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  const events = []; let holder; let releaseTimer;
  try {
    await assert.rejects(prepareRuntime({
      manifestPath: f.manifestPath, baseDir: f.baseDir, allowHttpForTests: true, _renameTimeoutMs: 180,
      _probeRuntime: async staged => { await f.probe(staged); holder = await holdDirectory(staged.runtimeDir); },
      onProgress: event => {
        events.push(event);
        if (event.phase === "waiting-files" && !releaseTimer) releaseTimer = setTimeout(() => { holder.release(); }, 450);
      },
    }), /等待运行资源目录释放超时/);
  } finally { clearTimeout(releaseTimer); await holder?.release(); }
  assert.ok(events.some(event => event.phase === "waiting-files" && event.action === "commit"));
  assert.ok(events.some(event => event.phase === "rolling-back"));
  assert.ok(!events.some(event => event.phase === "ready"));
  assert.equal(await readFile(path.join(first.runtimeDir, "keep-original"), "utf8"), "the previous runtime must survive");
  assert.equal(await readFile(path.join(first.runtimeDir, "runtime-ready.json"), "utf8"), originalReady);
  assert.equal(await readFile(path.join(f.baseDir, "runtime-state.json"), "utf8"), originalState);
  assert.deepEqual(await readdir(path.join(f.baseDir, "runtimes")), [f.manifest.runtimeId]);
  await assert.rejects(stat(path.join(f.baseDir, ".runtime-install.lock")), { code: "ENOENT" });
});
