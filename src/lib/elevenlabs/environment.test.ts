// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildElevenLabsEnvironment, discoverElevenLabsInstallation, verifyElevenLabsPackage } from "./environment";

const temporary: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clipforge-elevenlabs-install-"));
  temporary.push(root);
  const wrapper = path.join(root, "node_modules", "@elevenlabs", "cli");
  const native = path.join(root, "node_modules", "@elevenlabs", `cli-${process.platform}-${process.arch}`);
  await fs.mkdir(wrapper, { recursive: true }); await fs.mkdir(native, { recursive: true });
  await fs.writeFile(path.join(wrapper, "package.json"), JSON.stringify({ name: "@elevenlabs/cli", version: "1.8.0", bin: { elevenlabs: "bin/cli.js" } }));
  await fs.writeFile(path.join(native, "package.json"), JSON.stringify({ name: `@elevenlabs/cli-${process.platform}-${process.arch}`, version: "1.8.0" }));
  const executable = path.join(native, process.platform === "win32" ? "elevenlabs.exe" : "elevenlabs");
  await fs.writeFile(executable, "fixture, never executed");
  return { root, wrapper, native, executable };
}

describe("ElevenLabs executable discovery", () => {
  it("resolves the pinned npm package to its native executable without a shell or npm launcher", async () => {
    const install = await fixture();
    const result = await verifyElevenLabsPackage(install.wrapper);
    expect(result).toEqual({ executable: await fs.realpath(install.executable), version: "1.8.0" });
    vi.stubEnv("ELEVENLABS_CLI_PATH", install.executable);
    expect(await discoverElevenLabsInstallation()).toEqual(result);
  });
  it("supports the global Windows command shim path without executing the shim", async () => {
    const install = await fixture();
    const shim = path.join(install.root, "elevenlabs.cmd");
    await fs.writeFile(shim, "must never execute");
    vi.stubEnv("ELEVENLABS_CLI_PATH", shim);
    expect((await discoverElevenLabsInstallation()).executable).toBe(await fs.realpath(install.executable));
  });
  it("fails closed for unsupported official versions and nonofficial packages", async () => {
    const install = await fixture();
    await fs.writeFile(path.join(install.native, "package.json"), JSON.stringify({ name: `@elevenlabs/cli-${process.platform}-${process.arch}`, version: "9.0.0" }));
    await expect(verifyElevenLabsPackage(install.wrapper)).rejects.toMatchObject({ code: "ELEVENLABS_UNSUPPORTED_VERSION" });
    await fs.writeFile(path.join(install.wrapper, "package.json"), JSON.stringify({ name: "another-cli", version: "1.8.0" }));
    await expect(verifyElevenLabsPackage(install.wrapper)).rejects.toMatchObject({ code: "ELEVENLABS_UNSUPPORTED_VERSION" });
    await expect(verifyElevenLabsPackage("relative/path")).rejects.toMatchObject({ code: "ELEVENLABS_INVALID_INSTALLATION" });
  });
  it("preserves OS keyring identity while excluding API keys and endpoint overrides", () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "MUST_NOT_INHERIT");
    vi.stubEnv("ELEVENLABS_BASE_URL", "https://untrusted.invalid");
    vi.stubEnv("ELEVENLABS_TOKEN", "MUST_NOT_INHERIT");
    const env = buildElevenLabsEnvironment();
    expect(env.USERPROFILE).toBe(process.env.USERPROFILE);
    expect(env.HOME).toBe(process.env.HOME);
    expect(env.ELEVENLABS_API_KEY).toBeUndefined();
    expect(env.ELEVENLABS_BASE_URL).toBeUndefined();
    expect(env.ELEVENLABS_TOKEN).toBeUndefined();
  });
});
