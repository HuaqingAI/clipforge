// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { alignmentEnvironment, alignmentPaths, probeAlignmentRuntime } from "../../../scripts/lib/alignment-runtime.mjs";
import { compatiblePython, fileMatches } from "../../../scripts/setup-alignment.mjs";

const directories: string[] = [];
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "clipforge-alignment-bootstrap-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("English alignment startup resources", () => {
  it("keeps source and runtime paths absolute when the standalone server changes cwd", () => {
    const root = temporary();
    const env = alignmentEnvironment(root, { ...process.env, APP_ALIGNMENT_RUNTIME_DIR: "custom runtime", APP_RESOURCE_DIR: "stale source path" });
    expect(env.APP_RESOURCE_DIR).toBe(resolve(root));
    expect(env.APP_ALIGNMENT_RUNTIME_DIR).toBe(join(root, "custom runtime"));
    const nested = alignmentPaths(join(root, ".next", "standalone"), env);
    expect(nested.runtime).toBe(join(root, "custom runtime"));
    expect(nested.model).toBe(join(root, "custom runtime", "model"));
  });

  it("reports an absent runtime as unavailable without installing or downloading anything", () => {
    const root = temporary();
    const env = alignmentEnvironment(root, { ...process.env, APP_ALIGNMENT_RUNTIME_DIR: undefined });
    const result = probeAlignmentRuntime(root, env);
    expect(result.status).not.toBe(0);
    expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
    expect(compatiblePython(join(root, "missing-python"), [], env)).toBeNull();
  });
});

describe("alignment checkpoint integrity", () => {
  it("rejects missing, truncated and same-length corrupted downloads before model reuse", async () => {
    const file = join(temporary(), "checkpoint");
    const data = Buffer.from("trusted checkpoint contents");
    const expected = { size: data.length, sha256: createHash("sha256").update(data).digest("hex") };
    expect(await fileMatches(file, expected)).toBe(false);
    writeFileSync(file, data.subarray(0, -1));
    expect(await fileMatches(file, expected)).toBe(false);
    writeFileSync(file, Buffer.alloc(data.length, 0));
    expect(await fileMatches(file, expected)).toBe(false);
    writeFileSync(file, data);
    expect(await fileMatches(file, expected)).toBe(true);
  });
});
