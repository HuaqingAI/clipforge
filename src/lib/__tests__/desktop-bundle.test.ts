// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bundleStandalone } from "../../../scripts/bundle-standalone.mjs";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clipforge-desktop-构建 "));
  roots.push(root);
  async function file(path: string, content = "fixture") {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  for (const path of [".next-desktop/standalone/server.js", ".next-desktop/standalone/node_modules/next/package.json", ".next-desktop/static/app.js", "public/fonts/caption.ttf", "drizzle/meta/_journal.json", "scripts/alignment/align.py", "scripts/alignment/check-runtime.py"]) await file(path);
  await file(".next/standalone/node_modules/better-sqlite3/build/Release/better_sqlite3.node", "web-native-original");
  await file(".next-desktop/standalone/node_modules/better-sqlite3/build/Release/better_sqlite3.node", "desktop-node-native");
  await file("artifacts/runtime/desktop-runtime-manifest.json", JSON.stringify({ schemaVersion: 1, runtimeId: "test-runtime", platform: process.platform, arch: process.arch, nodeVersion: process.versions.node, nodeAbi: process.versions.modules }));
  return { root, file };
}

describe("isolated desktop packaging", () => {
  it("stages static assets, migrations and Python runners without changing either build's native binary", async () => {
    const { root } = await fixture();
    const output = await bundleStandalone({ root });
    expect(await readFile(join(output, ".next-desktop/static/app.js"), "utf8")).toBe("fixture");
    expect(await readFile(join(output, "scripts/alignment/align.py"), "utf8")).toBe("fixture");
    expect(await readFile(join(output, "node_modules/better-sqlite3/build/Release/better_sqlite3.node"), "utf8")).toBe("desktop-node-native");
    expect(await readFile(join(root, ".next/standalone/node_modules/better-sqlite3/build/Release/better_sqlite3.node"), "utf8")).toBe("web-native-original");
    expect(await readFile(join(root, ".next-desktop/standalone/node_modules/better-sqlite3/build/Release/better_sqlite3.node"), "utf8")).toBe("desktop-node-native");
  });

  it("omits user data, environment files and installer-managed media from all external module copies", async () => {
    const { root, file } = await fixture();
    for (const path of ["data/sqlite.db", ".next-desktop/build-data/sqlite.db", ".next-desktop/build-data/generation-task.key", "nested/sqlite.db-wal", "nested/generation-task.key", ".env.local", ".npmrc", "AGENTS.md", "CLAUDE.md", ".clipforge/tools/kling/package.json", "node_modules/ffmpeg-static/ffmpeg.exe", ".next-desktop/node_modules/ffmpeg-static-hash/ffmpeg.exe", "node_modules/@ffprobe-installer/win32-x64/ffprobe.exe"]) await file(`.next-desktop/standalone/${path}`, "must-not-ship");
    const output = await bundleStandalone({ root });
    for (const path of ["data/sqlite.db", ".next-desktop/build-data", "nested/sqlite.db-wal", "nested/generation-task.key", ".env.local", ".npmrc", "AGENTS.md", "CLAUDE.md", ".clipforge", "node_modules/ffmpeg-static", ".next-desktop/node_modules/ffmpeg-static-hash", "node_modules/@ffprobe-installer"]) await expect(readFile(join(output, path))).rejects.toThrow();
  });

  it("refuses a different Node ABI before deleting any existing staged application", async () => {
    const { root, file } = await fixture();
    await file("artifacts/runtime/desktop-runtime-manifest.json", JSON.stringify({ schemaVersion: 1, platform: process.platform, arch: process.arch, nodeVersion: process.versions.node, nodeAbi: "wrong-abi" }));
    await file(`artifacts/desktop/${process.platform}-${process.arch}/standalone/previous.txt`, "keep");
    await expect(bundleStandalone({ root })).rejects.toThrow(/ABI/);
    expect(await readFile(join(root, `artifacts/desktop/${process.platform}-${process.arch}/standalone/previous.txt`), "utf8")).toBe("keep");
  });

  it("rejects destinations outside the dedicated staging root", async () => {
    const { root } = await fixture();
    await expect(bundleStandalone({ root, outputDir: ".next/standalone" })).rejects.toThrow(/staging/);
  });
});
