// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import nextConfig from "../../../next.config";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function prepareTrace(projectFiles: string[], externalFiles: string[] = []) {
  const projectDir = mkdtempSync(join(tmpdir(), "clipforge-build-tracing-"));
  directories.push(projectDir);
  const distDir = join(projectDir, ".next");
  const traceFile = join(distDir, "server", "instrumentation.js.nft.json");
  mkdirSync(dirname(traceFile), { recursive: true });
  const tracedPaths = [...projectFiles.map((file) => join(projectDir, file)), ...externalFiles.map((file) => join(projectDir, "..", file))];
  const files = tracedPaths.map((file) => relative(dirname(traceFile), file).replaceAll("\\", "/"));
  writeFileSync(traceFile, JSON.stringify({ version: 1, files }));
  return { projectDir, distDir, traceFile, files };
}

describe("standalone instrumentation tracing", () => {
  it("excludes user data and launcher tools from the trace while leaving the original files intact", async () => {
    const setup = prepareTrace(["data/sqlite.db", ".clipforge/tools/kling/package.json", ".clipforge/logs/launcher.log", "src/instrumentation.ts"]);
    for (const file of ["data/sqlite.db", ".clipforge/tools/kling/package.json"]) {
      const target = join(setup.projectDir, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "private runtime content");
    }
    await nextConfig.compiler!.runAfterProductionCompile!(setup);
    expect(JSON.parse(readFileSync(setup.traceFile, "utf8"))).toEqual({ version: 1, files: [setup.files[3]] });
    expect(readFileSync(join(setup.projectDir, "data/sqlite.db"), "utf8")).toBe("private runtime content");
    expect(readFileSync(join(setup.projectDir, ".clipforge/tools/kling/package.json"), "utf8")).toBe("private runtime content");
  });

  it("preserves source prefixes, migrations, nested directory names and dependencies outside the project", async () => {
    const setup = prepareTrace([
      "database/helpers.ts", ".clipforge-tools/helper.js", ".gitignore", "src/data/schema.ts", "src/.clipforge/helper.ts", "drizzle/0000_initial.sql", "node_modules/data/index.js",
    ], ["node_modules/external-package/index.js", "data/external-dependency.js"]);
    await nextConfig.compiler!.runAfterProductionCompile!(setup);
    expect(JSON.parse(readFileSync(setup.traceFile, "utf8"))).toEqual({ version: 1, files: setup.files });
  });
});
