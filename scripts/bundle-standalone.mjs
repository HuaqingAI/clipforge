// Desktop staging never rewrites the Web build or changes SQLite to Electron's ABI.
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const privateRoots = new Set([".git", ".github", ".clipforge", "data", "docs", "tasks", "release", "artifacts", "integrations", "e2e", "remotion", "AGENTS.md", "CLAUDE.md"]);
const onlinePackages = /^(?:ffmpeg-static(?:-|$)|@ffprobe-installer$|@klingai$|@elevenlabs$)/;

export function includeDesktopFile(source, sourceRoot) {
  const parts = relative(sourceRoot, source).split(sep);
  // Conservative tracing can collect the entire checkout, including a local
  // npm credential file. Only the actual Next output is a shippable dot-folder.
  if (parts[0].startsWith(".") && parts[0] !== ".next-desktop") return false;
  if (privateRoots.has(parts[0]) || parts.some(part => /^\.env(?:\.|$)/.test(part) || part === "build-data" || /^(?:sqlite\.db(?:-wal|-shm)?|generation-task\.key)$/.test(part))) return false;
  // Dynamic require tracing must not pull installer-managed binaries into the app.
  if (parts.some(part => onlinePackages.test(part))) return false;
  return true;
}

function stagingPath(root, target) {
  const boundary = resolve(root, "artifacts", "desktop");
  const output = resolve(root, target);
  const fromBoundary = relative(boundary, output);
  if (!fromBoundary || fromBoundary.startsWith(`..${sep}`) || fromBoundary === ".." || isAbsolute(fromBoundary)) {
    throw new Error("Desktop staging must be a child of artifacts/desktop; source builds cannot be overwritten.");
  }
  return output;
}

export async function bundleStandalone({ root = ROOT, distDir = ".next-desktop", outputDir = `artifacts/desktop/${process.platform}-${process.arch}/standalone`, manifestPath = "artifacts/runtime/desktop-runtime-manifest.json" } = {}) {
  root = resolve(root);
  const build = resolve(root, distDir);
  const source = join(build, "standalone");
  const output = stagingPath(root, outputDir);
  if (!existsSync(join(source, "server.js"))) throw new Error(`Missing ${distDir}/standalone/server.js; run the desktop build first.`);
  const manifest = JSON.parse(await readFile(resolve(root, manifestPath), "utf8"));
  if (![1, 2].includes(manifest.schemaVersion) || manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error("Runtime manifest does not match the desktop build platform/architecture.");
  if (manifest.nodeVersion !== process.versions.node || String(manifest.nodeAbi) !== process.versions.modules) {
    throw new Error(`Build desktop with Node ${manifest.nodeVersion} (ABI ${manifest.nodeAbi}); current Node is ${process.versions.node} (ABI ${process.versions.modules}).`);
  }
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(source, output, { recursive: true, dereference: true, filter: sourceFile => includeDesktopFile(sourceFile, source) });
  const name = relative(root, build);
  for (const [from, to] of [
    [join(build, "static"), join(output, name, "static")],
    [join(root, "public"), join(output, "public")],
    [join(root, "drizzle"), join(output, "drizzle")],
    [join(root, "scripts", "alignment"), join(output, "scripts", "alignment")],
  ]) await cp(from, to, { recursive: true, dereference: true });
  await writeFile(join(output, "desktop-build.json"), JSON.stringify({ schemaVersion: 1, platform: process.platform, arch: process.arch, nodeVersion: process.versions.node, nodeAbi: process.versions.modules, distDir: name, runtimeId: manifest.runtimeId }, null, 2));
  await assertDesktopBundle(output);
  return output;
}

export async function assertDesktopBundle(directory) {
  for (const required of ["server.js", "node_modules/next/package.json", "drizzle/meta/_journal.json", "scripts/alignment/align.py", "scripts/alignment/check-runtime.py"]) {
    if (!(await stat(join(directory, required)).catch(() => null))?.isFile()) throw new Error(`Incomplete desktop staging: ${required}`);
  }
  async function visit(current) {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const file = join(current, item.name);
      if (!includeDesktopFile(file, directory) || /(?:model\.safetensors|(?:encoder_model|decoder_model).*\.onnx|desktop-runtime.*\.tar\.gz)$/.test(item.name)) throw new Error(`Online runtime or private file leaked into desktop app: ${relative(directory, file)}`);
      if (item.isSymbolicLink()) throw new Error(`Desktop staging must contain real files: ${relative(directory, file)}`);
      if (item.isDirectory()) await visit(file);
    }
  }
  await visit(directory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { "dist-dir": { type: "string" }, output: { type: "string" }, manifest: { type: "string" } } });
  const output = await bundleStandalone({ distDir: values["dist-dir"], outputDir: values.output, manifestPath: values.manifest });
  console.log(`Desktop standalone staged at ${output}; Web output and Node ABI preserved.`);
}
