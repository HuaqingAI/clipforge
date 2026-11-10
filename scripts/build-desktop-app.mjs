import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleStandalone } from "./bundle-standalone.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = process.env.CLIPFORGE_BUILD_RUNTIME_MANIFEST || join(root, "artifacts/runtime/desktop-runtime-manifest.json");
const manifest = await readFile(manifestPath, "utf8").then(JSON.parse).catch(() => { throw new Error("Run pnpm desktop:runtime to prepare the pinned official-source manifest before building the installer."); });
if (manifest.schemaVersion !== 2 || manifest.installMode !== "official-sources") throw new Error("Desktop installers must download directly from pinned upstream sources; regenerate with pnpm desktop:runtime.");
const app = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (manifest.appVersion !== app.version || manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error("Build online resources for this application version and platform before packaging desktop.");
if (manifest.nodeVersion !== process.versions.node || String(manifest.nodeAbi) !== process.versions.modules) throw new Error(`Desktop build requires Node ${manifest.nodeVersion} ABI ${manifest.nodeAbi}; current Node is ${process.versions.node}/${process.versions.modules}.`);
const require = createRequire(import.meta.url);
await new Promise((done, reject) => {
  const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "build"], {
    cwd: root,
    env: { ...process.env, CLIPFORGE_BUILD_TARGET: "desktop", NEXT_TELEMETRY_DISABLED: "1", APP_DATA_DIR: join(root, ".next-desktop", "build-data") },
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", code => code === 0 ? done() : reject(new Error(`Desktop Next build failed (${code}).`)));
});
console.log(await bundleStandalone({ root, manifestPath }));
