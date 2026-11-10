// Exercise the reviewed mirrors/upstream downloads and packaged ordinary-Node
// backend. Only historical schema-1 archive fixtures use a loopback server.
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function createSmokeManifest(manifest, fixtureOrigin) {
  if (manifest.schemaVersion === 2) {
    if (manifest.installMode !== "official-sources" || !Array.isArray(manifest.resources) || !manifest.resources.length) throw new Error("Official installation requires a schema-2 official-sources manifest.");
    for (const resource of manifest.resources) {
      const url = new URL(resource.url);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error(`Official smoke requires the original public HTTPS resource URL: ${resource.id}`);
    }
    return manifest;
  }
  if (manifest.schemaVersion !== 1 || !fixtureOrigin) throw new Error("Unsupported desktop runtime manifest.");
  return { ...manifest, resources: manifest.resources.map(resource => ({ ...resource, url: `${fixtureOrigin}/${new URL(resource.url).pathname.split("/").pop()}` })) };
}

export async function snapshotOfficialDownloads(manifest, baseDir) {
  const files = [];
  for (const resource of manifest.resources) {
    if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(resource.id) || !/^[a-f0-9]{64}$/.test(resource.sha256)) throw new Error("Invalid official resource cache identity.");
    const file = join(baseDir, "downloads", `${resource.id}-${resource.sha256}.download`);
    const info = await stat(file);
    if (!info.isFile() || info.size !== resource.size) throw new Error(`Official download cache has the wrong size: ${resource.id}`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    const sha256 = hash.digest("hex");
    if (sha256 !== resource.sha256) throw new Error(`Official download cache failed SHA256 validation: ${resource.id}`);
    files.push({ id: resource.id, size: info.size, sha256, mtimeMs: info.mtimeMs });
  }
  return files;
}

export function assertOfficialDownloadReuse(before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("The graphical installer changed an official download cache instead of reusing its verified installation.");
}

export async function main() {
const { verifyRuntime } = createRequire(import.meta.url)("../electron/runtime-manager.cjs");
const { values } = parseArgs({ options: { executable: { type: "string" }, resources: { type: "string" }, work: { type: "string" }, "web-only": { type: "boolean" }, "gui-only": { type: "boolean" }, "timeout-minutes": { type: "string" }, keep: { type: "boolean" } } });
if (values["web-only"] && values["gui-only"]) throw new Error("Choose only one focused smoke mode.");
const focused = values["web-only"] || values["gui-only"];
if (focused && !values.work) throw new Error("Focused smoke modes require --work pointing to a completed installation smoke directory.");
const resourceDir = resolve(values.resources || join(root, "artifacts/runtime"));
const executable = resolve(values.executable || join(root, "release/win-unpacked/ClipForge.exe"));
const manifest = JSON.parse(await readFile(join(resourceDir, "desktop-runtime-manifest.json"), "utf8"));
const officialSources = manifest.schemaVersion === 2;
const timeoutMinutes = Number(values["timeout-minutes"] || (officialSources ? 60 : 15));
if (!Number.isSafeInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 240) throw new Error("Smoke timeout must be between 1 and 240 minutes.");
const boundary = join(root, ".clipforge", "desktop-smoke");
await mkdir(boundary, { recursive: true });
const work = values.work ? resolve(values.work) : await mkdtemp(join(boundary, "安装验证 "));
const workRelative = relative(boundary, work);
if (!workRelative || workRelative === ".." || workRelative.startsWith(`..${sep}`) || isAbsolute(workRelative)) throw new Error("Smoke work must be a child of .clipforge/desktop-smoke.");
await mkdir(work, { recursive: true });
const files = new Map((officialSources ? [] : manifest.resources).map(resource => [new URL(resource.url).pathname.split("/").pop(), resource]));
let archiveRequests = 0;
const server = officialSources ? undefined : createServer(async (req, res) => {
  try {
    const name = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname.slice(1));
    if (!["GET", "HEAD"].includes(req.method) || !files.has(name) || name.includes("/") || name.includes("\\")) { res.writeHead(404); res.end(); return; }
    if (req.method === "GET") archiveRequests++;
    const target = join(resourceDir, name);
    const size = (await stat(target)).size;
    const etag = `"${files.get(name).sha256}"`;
    const range = req.headers.range;
    let start = 0;
    if (range) {
      const match = /^bytes=(\d+)-$/.exec(range);
      if (!match || Number(match[1]) >= size) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); res.end(); return; }
      start = Number(match[1]);
    }
    res.writeHead(range ? 206 : 200, { "Content-Type": "application/gzip", "Content-Length": String(size - start), "Accept-Ranges": "bytes", ETag: etag, ...(range ? { "Content-Range": `bytes ${start}-${size - 1}/${size}` } : {}) });
    if (req.method === "HEAD") res.end();
    else createReadStream(target, { start }).on("error", error => res.destroy(error)).pipe(res);
  } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(error.message); }
});
if (server) await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
const fixtureOrigin = server ? `http://127.0.0.1:${server.address().port}` : undefined;
const testManifest = createSmokeManifest(manifest, fixtureOrigin);
const manifestPath = join(work, "desktop-runtime-manifest.json");
const baseDir = join(work, "managed-resources");
const supportDir = join(resourceDir, "support");
// A focused retry reuses the exact manifest that certified the installed
// resources. Its old fixture URLs are never fetched by verifyRuntime.
if (!focused) await writeFile(manifestPath, JSON.stringify(testManifest));
console.log(officialSources ? `OFFICIAL_UPSTREAM_SMOKE: ${manifest.resources.length} pinned HTTPS downloads from reviewed mirrors/upstreams; no loopback URL rewriting.` : "LEGACY_ARCHIVE_FIXTURE_SMOKE: resources served over loopback HTTP.");
let passed = false;
async function runPackaged(args, { selectedManifest = manifestPath, expectFailure = false, marker, gui = false } = {}) {
  return new Promise((done, reject) => {
    let output = "";
    let timedOut = false;
    let guiReady = false;
    let markerSeen = !marker;
    const env = { ...process.env, CLIPFORGE_RUNTIME_MANIFEST: selectedManifest, CLIPFORGE_RUNTIME_BASE_DIR: baseDir, CLIPFORGE_RUNTIME_SUPPORT_DIR: supportDir };
    if (officialSources) delete env.CLIPFORGE_RUNTIME_ALLOW_HTTP_TESTS;
    else env.CLIPFORGE_RUNTIME_ALLOW_HTTP_TESTS = "1";
    // --verify-runtime isolates userData without suppressing the real setup
    // window. HEADLESS_SMOKE or --silent would bypass the renderer handshake.
    if (gui) {
      delete env.HEADLESS_SMOKE;
      if (!args.includes("--install-runtime") || !args.includes("--verify-runtime") || args.includes("--silent")) throw new Error("GUI smoke must use isolated graphical installation flags.");
    } else env.HEADLESS_SMOKE = "1";
    delete env.ELECTRON_RUN_AS_NODE;
    if (process.platform === "win32") {
      for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
      const windows = process.env.SystemRoot || "C:\\Windows";
      env.Path = `${join(windows, "System32")};${windows}`;
    }
    // Chromium canonicalizes the file URL's drive letter. Exercise the Windows
    // installer case where its executable path retains a lowercase drive.
    const launchExecutable = gui && process.platform === "win32" ? executable.replace(/^[A-Z]:/, drive => drive.toLowerCase()) : executable;
    const child = spawn(launchExecutable, args, { cwd: dirname(launchExecutable), env, shell: false, windowsHide: !gui, stdio: ["ignore", "pipe", "pipe"] });
    const stop = async message => {
      if (timedOut) return;
      timedOut = true;
      clearTimeout(timer); clearTimeout(readyTimer);
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        if (process.platform === "win32") await new Promise(resolve => execFile(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }, error => { if (error) child.kill(); resolve(); }));
        else child.kill();
      }
      reject(new Error(`${message}\n${output.slice(-8000)}`));
    };
    const timer = setTimeout(() => { void stop(`Packaged desktop smoke timed out after ${timeoutMinutes} minutes.`); }, timeoutMinutes * 60_000);
    const readyTimer = gui ? setTimeout(() => { void stop("Graphical installer did not complete its trusted renderer handshake within 30 seconds."); }, 30_000) : undefined;
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
      const line = String(chunk); output = (output + line).slice(-64 * 1024); process.stdout.write(line);
      if (marker && output.includes(marker)) markerSeen = true;
      if (gui && output.includes("GUI_SETUP_READY")) { guiReady = true; clearTimeout(readyTimer); }
    });
    child.once("error", error => { clearTimeout(timer); clearTimeout(readyTimer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer); clearTimeout(readyTimer);
      if (timedOut) return;
      const accepted = expectFailure ? code !== null && code !== 0 && /CLIPFORGE_FAILED/.test(output) : code === 0 && markerSeen && (!gui || guiReady);
      if (accepted) done(); else reject(new Error(`Packaged desktop ${args.join(" ")} failed (${code}): ${output.slice(-8000)}`));
    });
  });
}
async function verifyWebBackend() {
  const runtime = await verifyRuntime({ manifestPath, baseDir, supportDir, allowHttpForTests: !officialSources });
  const resources = join(dirname(executable), "resources");
  const listener = createServer();
  await new Promise((done, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", done); });
  const backendPort = listener.address().port;
  await new Promise(done => listener.close(done));
  const dataDir = join(work, "web-data");
  await mkdir(dataDir, { recursive: true });
  const env = {
    ...process.env, NODE_ENV: "production", CLIPFORGE_RUNTIME: "web", CLIPFORGE_PROBE_MODE: "1",
    PORT: String(backendPort), HOSTNAME: "127.0.0.1", APP_DATA_DIR: dataDir,
    APP_RESOURCE_DIR: join(resources, "standalone"), APP_MIGRATIONS_DIR: join(resources, "standalone", "drizzle"),
    FFMPEG_PATH: runtime.ffmpegPath, FFPROBE_PATH: runtime.ffprobePath, NEXT_TELEMETRY_DISABLED: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.CLIPFORGE_DESKTOP_LOCAL;
  let output = "";
  const child = spawn(runtime.nodePath, [join(resources, "server-entry.cjs"), join(resources, "standalone", "server.js")], {
    cwd: join(resources, "standalone"), env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const closed = new Promise(done => child.once("close", done));
  let spawnError;
  child.once("error", error => { spawnError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output = (output + String(chunk)).slice(-8000); });
  const origin = `http://127.0.0.1:${backendPort}`;
  try {
    let health;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Web backend exited (${child.exitCode}): ${output}`);
      try {
        const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) });
        if (response.ok) { health = await response.json(); break; }
      } catch { /* wait for the isolated local listener */ }
      await new Promise(done => setTimeout(done, 200));
    }
    if (!health?.ok || health.runtime?.kind !== "web" || health.db?.projectCount !== 0) throw new Error(`Web backend health failed: ${JSON.stringify(health)} ${output}`);
    const descriptor = await fetch(`${origin}/api/runtime`).then(response => response.json());
    if (descriptor.asr?.mode !== "web") throw new Error("Web mode unexpectedly required desktop-managed models.");
    const html = await fetch(origin).then(response => response.text());
    if (!html.includes("ClipForge") || !html.includes("/_next/")) throw new Error("Web page did not render the production application.");
    for (const [route, expectedStatus] of [["/api/project/00000000-0000-4000-8000-000000000000/compose", 200], ["/api/media/analyze", 405]]) {
      const response = await fetch(`${origin}${route}`);
      const body = await response.text();
      if (response.status !== expectedStatus) throw new Error(`Packaged media route did not load correctly: ${route} (${response.status}). ${body} ${output}`);
      if (expectedStatus === 200 && JSON.parse(body).composition !== null) throw new Error("Web composition status did not use the fresh isolated database.");
    }
    console.log("WEB_BACKEND_SMOKE_OK: production server, fresh database, Web model policy, rendered page and media route imports.");
  } finally {
    if (child.connected) { try { child.send({ type: "clipforge:shutdown" }); } catch { /* already exited */ } }
    let timer;
    await Promise.race([closed, new Promise(done => { timer = setTimeout(() => { child.kill(); done(); }, 12_000); })]);
    clearTimeout(timer);
  }
}
try {
  if (values["gui-only"]) {
    await runPackaged(["--install-runtime", "--verify-runtime"], { gui: true, marker: "GUI_SETUP_OK" });
  } else if (!values["web-only"]) {
    await runPackaged(["--install-runtime", "--silent"], { selectedManifest: join(work, "missing-manifest.json"), expectFailure: true });
    console.log("Installer correctly rejected a missing resource manifest.");
    await runPackaged(["--install-runtime", "--verify-runtime"], { gui: true, marker: "GUI_SETUP_OK" });
    const officialDownloads = officialSources ? await snapshotOfficialDownloads(manifest, baseDir) : undefined;
    if (!officialSources && !values.work && archiveRequests < manifest.resources.length) throw new Error("The graphical first installation did not download all real resource archives.");
    console.log(`Graphical installer completed its trusted handshake, ${officialSources ? `installed and hashed all ${officialDownloads.length} official source downloads` : "downloaded resources"} and passed native/backend probes.`);
    const beforeReuse = archiveRequests;
    await runPackaged(["--install-runtime", "--verify-runtime"], { gui: true, marker: "GUI_SETUP_OK" });
    if (officialSources) assertOfficialDownloadReuse(officialDownloads, await snapshotOfficialDownloads(manifest, baseDir));
    else if (archiveRequests !== beforeReuse) throw new Error("The graphical installer downloaded archives instead of reusing its verified installation.");
    console.log("Graphical installer successfully reused its completed resource installation without changing verified download caches.");
    await runPackaged(["--verify-runtime"], { marker: "SMOKE_OK" });
  }
  if (!values["gui-only"]) await verifyWebBackend();
  passed = true;
  console.log(values["gui-only"] ? "GUI_ONLY_SMOKE_OK: isolated graphical setup handshake and native/backend preparation." : values["web-only"] ? "WEB_ONLY_SMOKE_OK: reused verified resources and passed production Web checks." : "DESKTOP_INSTALL_SMOKE_OK: graphical online installation and reuse, Python/CLI/media, SQLite, renderer and packaged Web backend.");
} finally {
  if (server) await new Promise(done => server.close(done));
  if (passed && !values.keep) {
    const checked = relative(boundary, work);
    if (!checked || checked === ".." || checked.startsWith(`..${sep}`) || isAbsolute(checked)) throw new Error("Invalid smoke cleanup directory.");
    await rm(work, { recursive: true, force: true });
  } else console.log(`Smoke artifacts retained at ${work}`);
}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.stack || error.message || error); process.exitCode = 1; });
}
