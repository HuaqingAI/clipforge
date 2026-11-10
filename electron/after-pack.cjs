// Only the application and its trusted resource manifest enter the installer.
// Upstream binaries, Python packages and models download during installation.
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const { execFileSync } = require("child_process");
const { createRequire } = require("module");
const { Arch } = require("builder-util");
const { pathToFileURL } = require("url");

exports.default = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  const productName = packager.appInfo.productFilename;

  const resourcesDir =
    electronPlatformName === "darwin"
      ? path.join(appOutDir, `${productName}.app`, "Contents", "Resources")
      : path.join(appOutDir, "resources");

  const root = process.cwd();
  const { listPackage } = require("@electron/asar");
  for (const entry of listPackage(path.join(resourcesDir, "app.asar"))) {
    const first = entry.split(/[/\\]/).filter(Boolean)[0];
    if (first !== "electron" && first !== "package.json") throw new Error(`[afterPack] Unexpected app.asar content: ${entry}; desktop shell must not bundle runtime dependencies or private files.`);
  }
  const arch = Arch[context.arch];
  const src = path.join(root, "artifacts", "desktop", `${electronPlatformName}-${arch}`, "standalone");
  const dest = path.join(resourcesDir, "standalone");
  const manifestPath = process.env.CLIPFORGE_BUILD_RUNTIME_MANIFEST || path.join(root, "artifacts", "runtime", "desktop-runtime-manifest.json");
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 2 || manifest.installMode !== "official-sources") throw new Error("[afterPack] Regenerate the official-source runtime manifest with pnpm desktop:runtime; self-hosted resource bundles cannot ship.");
  require("./runtime-manager.cjs").validateManifest(manifest);
  const metadata = JSON.parse(await fsp.readFile(path.join(src, "desktop-build.json"), "utf8"));
  if (manifest.appVersion !== packager.appInfo.version || manifest.platform !== electronPlatformName || manifest.arch !== arch || metadata.runtimeId !== manifest.runtimeId || metadata.nodeVersion !== manifest.nodeVersion || String(metadata.nodeAbi) !== String(manifest.nodeAbi)) {
    throw new Error("[afterPack] Desktop application and online runtime manifest do not match.");
  }
  if (manifest.nodeVersion !== process.versions.node || String(manifest.nodeAbi) !== process.versions.modules) throw new Error("[afterPack] Use the manifest's Node version to build native dependencies.");
  if (!manifest.resources?.length || manifest.resources.some(resource => !resource.url?.startsWith("https://") || !/^[a-f0-9]{64}$/.test(resource.sha256))) throw new Error("[afterPack] Online resources require fixed HTTPS URLs and SHA256 checksums.");

  if (!fs.existsSync(src)) {
    throw new Error(`[afterPack] 未找到 ${src}，请先 pnpm desktop:build`);
  }

  await fsp.mkdir(dest, { recursive: true });
  await fsp.cp(src, dest, { recursive: true, dereference: true });
  await fsp.copyFile(manifestPath, path.join(resourcesDir, "desktop-runtime-manifest.json"));
  // Only small application-owned scripts/fonts ship as support assets. All
  // third-party runtimes and models are fetched from their pinned upstreams.
  await fsp.cp(path.join(path.dirname(manifestPath), "support"), path.join(resourcesDir, "runtime-support"), { recursive: true, dereference: false });
  // Ordinary Node cannot read Electron's app.asar virtual filesystem.
  await fsp.copyFile(path.join(root, "electron", "server-entry.cjs"), path.join(resourcesDir, "server-entry.cjs"));
  const { assertDesktopBundle } = await import(pathToFileURL(path.join(root, "scripts", "bundle-standalone.mjs")).href);
  await assertDesktopBundle(dest);

  const ok = fs.existsSync(path.join(dest, "node_modules", "next", "package.json"));
  console.log(`[afterPack] standalone 已拷入 ${dest}（next 模块就位:${ok}）`);
  if (!ok) throw new Error("[afterPack] 拷贝后未见 node_modules/next，打包中止");

  // Guardrail: prove Next's peer deps resolve from the copied `next`. This is exactly what silently failed on
  // Windows in issue #10 (@swc/helpers detached from next after the copy). Fail the build loudly rather than ship
  // a package whose local server crashes on startup. createRequire walks realpaths just like the runtime require.
  try {
    const reqFromNext = createRequire(path.join(dest, "node_modules", "next", "package.json"));
    reqFromNext.resolve("@swc/helpers/_/_interop_require_default");
    reqFromNext.resolve("styled-jsx");
  } catch (e) {
    throw new Error(`[afterPack] standalone 依赖自检失败(next 的 peer dep 不可解析):${e.message}。打包中止，避免再发出启动即崩的包（issue #10）。`);
  }
  console.log("[afterPack] 依赖自检通过：@swc/helpers、styled-jsx 均可从 next 解析 ✓");
  const sqliteCopies = [path.join(dest, "node_modules", "better-sqlite3")];
  const externalModules = path.join(dest, metadata.distDir, "node_modules");
  for (const entry of await fsp.readdir(externalModules, { withFileTypes: true })) {
    if (entry.name.startsWith("better-sqlite3")) sqliteCopies.push(path.join(externalModules, entry.name));
  }
  for (const moduleDir of sqliteCopies) {
    execFileSync(process.execPath, ["-e", "const Database=require(process.argv[1]);const db=new Database(':memory:');db.prepare('select 1').get();db.close()", moduleDir], { windowsHide: true, timeout: 30_000, cwd: dest });
  }
  console.log(`[afterPack] Node ABI ${manifest.nodeAbi} SQLite verified; CLI/Python/models/media will download during installation.`);
};
