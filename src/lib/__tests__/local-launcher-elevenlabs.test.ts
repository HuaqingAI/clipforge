// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ELEVENLABS_PACKAGE, ELEVENLABS_VERSION, elevenLabsReady } from "../../../scripts/launch-local.mjs";

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawnSync: spawnSyncMock,
}));

const temporaryDirectories: string[] = [];
beforeEach(() => {
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue({ status: 0, stdout: "elevenlabs 1.8.0\n", stderr: "", signal: null });
});
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function installation() {
  const root = mkdtempSync(join(tmpdir(), "clipforge-elevenlabs-launcher-"));
  temporaryDirectories.push(root);
  const wrapper = join(root, "node_modules", "@elevenlabs", "cli");
  const native = join(root, "node_modules", "@elevenlabs", `cli-${process.platform}-${process.arch}`);
  const shim = join(wrapper, "bin", "cli.js");
  const executable = join(native, process.platform === "win32" ? "elevenlabs.exe" : "elevenlabs");
  mkdirSync(join(wrapper, "bin"), { recursive: true });
  mkdirSync(native, { recursive: true });
  const wrapperManifest = { name: ELEVENLABS_PACKAGE, version: ELEVENLABS_VERSION, bin: { elevenlabs: "bin/cli.js" } };
  const nativeManifest = { name: `@elevenlabs/cli-${process.platform}-${process.arch}`, version: ELEVENLABS_VERSION };
  writeFileSync(join(wrapper, "package.json"), JSON.stringify(wrapperManifest));
  writeFileSync(join(native, "package.json"), JSON.stringify(nativeManifest));
  writeFileSync(shim, "fixture shim, never executed");
  writeFileSync(executable, "fixture native binary, never executed");
  return { wrapper, native, shim, executable, wrapperManifest, nativeManifest };
}

describe("local launcher ElevenLabs readiness", () => {
  it("requires the complete pinned CLI and probes only its native version without logging in or generating", () => {
    const fixture = installation();
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", CLIPFORGE_LAUNCHER_TEST: "preserve launch environment" };
    expect(ELEVENLABS_PACKAGE).toBe("@elevenlabs/cli");
    expect(ELEVENLABS_VERSION).toBe("1.8.0");
    expect(elevenLabsReady(fixture.wrapper, env)).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledExactlyOnceWith(fixture.executable, ["--version"], {
      cwd: fixture.wrapper,
      env,
      windowsHide: true,
      encoding: "utf8",
      timeout: 10_000,
    });
  });

  it.each([
    { description: "another package", changes: { name: "another-cli" } },
    { description: "an unsupported wrapper version", changes: { version: "1.7.0" } },
    { description: "a different command shim", changes: { bin: { elevenlabs: "other.js" } } },
    { description: "a missing command mapping", changes: { bin: {} } },
  ])("rejects $description before running code", ({ changes }) => {
    const fixture = installation();
    writeFileSync(join(fixture.wrapper, "package.json"), JSON.stringify({ ...fixture.wrapperManifest, ...changes }));
    expect(elevenLabsReady(fixture.wrapper)).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("rejects an absent or malformed wrapper manifest", () => {
    const fixture = installation();
    writeFileSync(join(fixture.wrapper, "package.json"), "{");
    expect(elevenLabsReady(fixture.wrapper)).toBe(false);
    rmSync(join(fixture.wrapper, "package.json"));
    expect(elevenLabsReady(fixture.wrapper)).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("rejects a missing command shim and a directory mistaken for the shim", () => {
    const fixture = installation();
    rmSync(fixture.shim);
    expect(elevenLabsReady(fixture.wrapper)).toBe(false);
    mkdirSync(fixture.shim);
    expect(elevenLabsReady(fixture.wrapper)).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("detects an installation that omitted the native optional package", () => {
    const fixture = installation();
    rmSync(fixture.native, { recursive: true });
    expect(elevenLabsReady(fixture.wrapper)).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it.each([
    { description: "another native package", changes: { name: "@elevenlabs/cli-another-platform" } },
    { description: "an unsupported native version", changes: { version: "1.7.0" } },
  ])("rejects $description", ({ changes }) => {
    const fixture = installation();
    writeFileSync(join(fixture.native, "package.json"), JSON.stringify({ ...fixture.nativeManifest, ...changes }));
    expect(elevenLabsReady(fixture.wrapper)).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("rejects a missing binary and a directory mistaken for the executable", () => {
    const fixture = installation();
    rmSync(fixture.executable);
    expect(elevenLabsReady(fixture.wrapper)).toBe(false);
    mkdirSync(fixture.executable);
    expect(elevenLabsReady(fixture.wrapper)).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it.each([
    { description: "a failing process", result: { status: 1, stdout: "elevenlabs 1.8.0", stderr: "cannot start" } },
    { description: "an unavailable executable", result: { status: null, stdout: "", stderr: "", error: new Error("ENOENT") } },
    { description: "a timed out process", result: { status: null, stdout: "", stderr: "", error: new Error("ETIMEDOUT") } },
    { description: "a process error despite a zero exit code", result: { status: 0, stdout: "elevenlabs 1.8.0", stderr: "", error: new Error("spawn failed") } },
    { description: "a different runtime version", result: { status: 0, stdout: "elevenlabs 1.7.0", stderr: "" } },
    { description: "a longer version sharing the pinned prefix", result: { status: 0, stdout: "elevenlabs 1.8.00", stderr: "" } },
    { description: "no version output", result: { status: 0, stdout: "", stderr: "" } },
  ])("requires a working version probe, rejecting $description", ({ result }) => {
    const fixture = installation();
    spawnSyncMock.mockReturnValue(result);
    expect(elevenLabsReady(fixture.wrapper)).toBe(false);
    expect(spawnSyncMock).toHaveBeenCalledOnce();
    expect(spawnSyncMock.mock.calls[0][1]).toEqual(["--version"]);
  });
});
