// The installer downloads fixed upstream distributions. This builder ships only
// their reviewed lock/manifest and this project's small scripts/font support.
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { refreshOfficialSources, DESKTOP_NODE_VERSION, DESKTOP_NODE_ABI, RESOURCE_PATHS } from "./lib/desktop-official-sources.mjs";

export { DESKTOP_NODE_VERSION, DESKTOP_NODE_ABI };
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = join(ROOT, "scripts/lib/desktop-official-sources.lock.json");
const require = createRequire(import.meta.url);

async function supportInventory(directory) {
  const files = [];
  async function visit(current) {
    for (const item of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (item.isSymbolicLink()) throw new Error("Runtime support cannot contain symbolic links.");
      const filename = join(current, item.name);
      if (item.isDirectory()) await visit(filename);
      else if (item.isFile()) {
        const bytes = await readFile(filename);
        files.push({ path: relative(directory, filename).split(sep).join("/"), size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      } else throw new Error("Runtime support cannot contain special files.");
    }
  }
  await visit(directory); return files;
}

export async function buildDesktopRuntime({ output = join(ROOT, "artifacts/runtime"), workDir = join(ROOT, ".clipforge/desktop-runtime-build"), refreshLock = false, lockPath = LOCK } = {}) {
  output = resolve(output); workDir = resolve(workDir); lockPath = resolve(lockPath);
  if (refreshLock) {
    const lock = await refreshOfficialSources({ root: ROOT, cache: join(workDir, "cache") });
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n");
    console.log(`Updated pinned official-source lock: ${lockPath}`);
  }
  let lock;
  try { lock = JSON.parse(await readFile(lockPath, "utf8")); }
  catch (error) { throw new Error("Missing or invalid official-source lock; maintainers must run desktop:runtime --refresh-lock and review the result.", { cause: error }); }
  if (lock.schemaVersion !== 2 || lock.installMode !== "official-sources" || lock.platform !== "win32" || lock.arch !== "x64" || lock.nodeVersion !== DESKTOP_NODE_VERSION || lock.nodeAbi !== DESKTOP_NODE_ABI) throw new Error("Official-source lock has an unsupported runtime contract.");
  const requirements = (await readFile(join(ROOT, "scripts/lib/desktop-runtime-requirements.txt"), "utf8")).split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  const lockedRequirements = lock.resources.filter(resource => resource.role === "python-dependency").map(resource => resource.pythonRequirement).sort();
  if (JSON.stringify(requirements.toSorted()) !== JSON.stringify(lockedRequirements)) throw new Error("Python requirements changed; refresh and review the official-source lock.");
  const ortRoot = resolve(dirname(require.resolve("onnxruntime-web")), "..");
  const ortVersion = JSON.parse(await readFile(join(ortRoot, "package.json"), "utf8")).version;
  if (lock.sources.ortVersion !== ortVersion) throw new Error("ORT package changed; refresh and review its matching official-source lock.");
  await mkdir(output, { recursive: true });
  const support = join(output, "support");
  const fromOutput = relative(output, support);
  if (!fromOutput || fromOutput.startsWith("..") || isAbsolute(fromOutput)) throw new Error("Invalid runtime-support output path.");
  await rm(support, { recursive: true, force: true });
  await mkdir(join(support, "media/fonts"), { recursive: true });
  await cp(join(ROOT, "scripts/alignment"), join(support, "alignment/scripts"), { recursive: true, filter: source => !source.includes("__pycache__") && !/\.py[co]$/.test(source) });
  for (const name of ["subtitle.otf", "OFL.txt"]) await cp(join(ROOT, "public/fonts", name), join(support, "media/fonts", name));
  const appVersion = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version;
  const manifest = { ...lock, appVersion, paths: RESOURCE_PATHS, supportFiles: await supportInventory(support) };
  const fingerprint = createHash("sha256").update(JSON.stringify(manifest)).digest("hex").slice(0, 16);
  manifest.runtimeId = `desktop-v2-node${DESKTOP_NODE_VERSION}-win32-x64-${fingerprint}`;
  const { validateManifest } = require("../electron/runtime-manager.cjs");
  validateManifest(manifest, { platform: "win32", arch: "x64" });
  await writeFile(join(output, "desktop-runtime-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const total = manifest.resources.reduce((sum, resource) => sum + resource.size, 0);
  console.log(`Official-source manifest ready: ${manifest.resources.length} pinned downloads (${(total / 1024 ** 2).toFixed(1)} MiB).\n${output}\nOnly manifest and support are packaged; no hosted ClipForge resource archives are required.`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { output: { type: "string" }, "work-dir": { type: "string" }, "refresh-lock": { type: "boolean" }, help: { type: "boolean" } } });
    if (values.help) console.log("Usage: node scripts/build-desktop-runtime.mjs [--output artifacts/runtime] [--refresh-lock] [--work-dir .clipforge/desktop-runtime-build]");
    else await buildDesktopRuntime({ ...(values.output ? { output: values.output } : {}), ...(values["work-dir"] ? { workDir: values["work-dir"] } : {}), refreshLock: Boolean(values["refresh-lock"]) });
  } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
