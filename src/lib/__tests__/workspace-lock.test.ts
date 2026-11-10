// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireWorkspaceLock } from "@/lib/workspace-lock";

let directory: string;
let release: (() => void) | undefined;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "clipforge-workspace-")); });
afterEach(() => { release?.(); release = undefined; vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
const lockFile = () => join(directory, ".clipforge-service.lock");

describe("workspace service ownership", () => {
  it("reuses one process lease and cleans up on release", () => {
    release = acquireWorkspaceLock(directory);
    expect(acquireWorkspaceLock(directory)).toBe(release);
    expect(JSON.parse(readFileSync(lockFile(), "utf8")).pid).toBe(process.pid);
    release();
    expect(existsSync(lockFile())).toBe(false);
  });
  it("rejects an already-live owner before starting another runner", () => {
    writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, bootId: "other-service" }));
    expect(() => acquireWorkspaceLock(directory)).toThrow(/另一个 ClipForge/);
    expect(JSON.parse(readFileSync(lockFile(), "utf8")).bootId).toBe("other-service");
  });
  it("recovers a stopped owner's lock", () => {
    writeFileSync(lockFile(), JSON.stringify({ pid: 2147483647, bootId: "dead" }));
    release = acquireWorkspaceLock(directory);
    expect(JSON.parse(readFileSync(lockFile(), "utf8")).pid).toBe(process.pid);
  });
  it("does not remove a replacement owner's lock", () => {
    release = acquireWorkspaceLock(directory);
    writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, bootId: "replacement" }));
    release();
    expect(JSON.parse(readFileSync(lockFile(), "utf8")).bootId).toBe("replacement");
  });
  it("does not lock a workspace during installation probes", () => {
    vi.stubEnv("CLIPFORGE_PROBE_MODE", "1");
    release = acquireWorkspaceLock(directory);
    expect(existsSync(lockFile())).toBe(false);
  });
});
