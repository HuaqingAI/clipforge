// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localBuildStatus } from "../../../scripts/lib/local-build.mjs";

const temporaryDirectories: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clipforge-build-"));
  temporaryDirectories.push(root);
  const dist = join(root, ".next");
  const standalone = join(dist, "standalone");
  const standaloneDist = join(standalone, ".next");
  const route = "server/app/project/[id]/script/page.js";
  const clientManifest = "server/app/project/[id]/script/page_client-reference-manifest.js";
  const routeEntry = route.slice("server/".length);
  const files = [
    "BUILD_ID",
    "server/app-paths-manifest.json",
    "server/pages-manifest.json",
    "server/middleware-manifest.json",
    "server/server-reference-manifest.json",
    "required-server-files.json",
    "routes-manifest.json",
    "build-manifest.json",
    "prerender-manifest.json",
    "standalone/server.js",
    route,
    clientManifest,
  ];
  const standaloneFiles = files.filter((file) => file !== "BUILD_ID" && !file.startsWith("standalone/"));
  const write = (file: string, content = "ok") => {
    const target = join(dist, file);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  };
  write("BUILD_ID", "test-build\n");
  write("server/app-paths-manifest.json", JSON.stringify({ "/project/[id]/script": routeEntry }));
  write("server/pages-manifest.json", "{}");
  for (const file of ["server/middleware-manifest.json", "server/server-reference-manifest.json", "routes-manifest.json", "build-manifest.json", "prerender-manifest.json"]) write(file, "{}");
  write("standalone/server.js");
  write(route);
  write(clientManifest);
  write("required-server-files.json", JSON.stringify({ files: [".next\\BUILD_ID", ".next\\server\\app-paths-manifest.json"] }));
  mkdirSync(standaloneDist, { recursive: true });
  writeFileSync(join(standaloneDist, "BUILD_ID"), "test-build\n");
  for (const file of standaloneFiles) {
    if (file === "standalone/server.js") continue;
    const source = join(dist, file);
    const target = join(standaloneDist, file);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "ok");
  }
  return { root, dist, route, clientManifest };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("local production build validation", () => {
  it("accepts a complete standalone build including dynamic app manifests", () => {
    const { root } = fixture();
    expect(localBuildStatus(root)).toEqual({ ok: true, buildId: "test-build", missing: [] });
  });

  it("rejects a build when a dynamic route client manifest is missing", () => {
    const { root, dist, clientManifest } = fixture();
    rmSync(join(dist, "standalone", ".next", clientManifest));
    const result = localBuildStatus(root);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain(`standalone/.next/${clientManifest}`);
  });
});
