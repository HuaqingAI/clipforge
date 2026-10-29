// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildElevenLabsEnvironment, discoverElevenLabsInstallation } from "@/lib/elevenlabs/environment";
import { ELEVENLABS_CLI_VERSION } from "@/lib/elevenlabs/types";

let fixtureRoot: string;
const platformPackage = `cli-${process.platform}-${process.arch}`;
const binaryName = process.platform === "win32" ? "elevenlabs.exe" : "elevenlabs";

async function createInstallation(name: string, overrides: { version?: string; bin?: string; native?: boolean } = {}) {
  const scope = path.join(fixtureRoot, name, "node_modules", "@elevenlabs");
  const packagePath = path.join(scope, "cli");
  const nativePath = path.join(scope, platformPackage);
  await fs.mkdir(packagePath, { recursive: true });
  await fs.mkdir(nativePath, { recursive: true });
  await fs.writeFile(path.join(packagePath, "package.json"), JSON.stringify({
    name: "@elevenlabs/cli", version: overrides.version ?? ELEVENLABS_CLI_VERSION,
    bin: { elevenlabs: overrides.bin ?? "bin/cli.js" },
  }));
  await fs.writeFile(path.join(nativePath, "package.json"), JSON.stringify({
    name: `@elevenlabs/${platformPackage}`, version: ELEVENLABS_CLI_VERSION,
  }));
  const executable = path.join(nativePath, binaryName);
  if (overrides.native !== false) await fs.writeFile(executable, "fixture binary; discovery must not execute it");
  return { packagePath, executable };
}

beforeEach(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "clipforge-elevenlabs-environment-"));
  vi.stubEnv("ELEVENLABS_CLI_PATH", "");
  vi.stubEnv("CLIPFORGE_ELEVENLABS_PACKAGE_PATH", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

describe("ElevenLabs launcher-managed installation discovery", () => {
  it("uses the prepared project package before a global installation", async () => {
    const managed = await createInstallation(".clipforge/tools/elevenlabs");
    const global = await createInstallation("global");
    vi.stubEnv("CLIPFORGE_ELEVENLABS_PACKAGE_PATH", managed.packagePath);
    vi.stubEnv("npm_config_prefix", path.resolve(global.packagePath, "../../.."));

    expect(await discoverElevenLabsInstallation()).toEqual({
      executable: await fs.realpath(managed.executable), version: ELEVENLABS_CLI_VERSION,
    });
  });

  it("keeps an explicit CLI override ahead of a broken managed installation", async () => {
    const configured = await createInstallation("explicit");
    vi.stubEnv("ELEVENLABS_CLI_PATH", configured.packagePath);
    vi.stubEnv("CLIPFORGE_ELEVENLABS_PACKAGE_PATH", path.join(fixtureRoot, "missing-managed"));

    expect((await discoverElevenLabsInstallation()).executable).toBe(await fs.realpath(configured.executable));
  });

  it.each([
    { label: "missing native binary", override: { native: false }, code: "ELEVENLABS_NOT_FOUND", message: "平台二进制缺失" },
    { label: "unsupported package version", override: { version: "0.0.0" }, code: "ELEVENLABS_UNSUPPORTED_VERSION", message: "仅支持官方" },
    { label: "unexpected wrapper entry", override: { bin: "other.js" }, code: "ELEVENLABS_INVALID_INSTALLATION", message: "入口与已验证版本不一致" },
  ])("reports $label without silently falling back to another installation", async ({ override, code, message }) => {
    const managed = await createInstallation("managed", override);
    const global = await createInstallation("global");
    vi.stubEnv("CLIPFORGE_ELEVENLABS_PACKAGE_PATH", managed.packagePath);
    vi.stubEnv("npm_config_prefix", path.resolve(global.packagePath, "../../.."));

    await expect(discoverElevenLabsInstallation()).rejects.toMatchObject({ code, message: expect.stringContaining(message) });
  });

  it("rejects an invalid managed path instead of ignoring it", async () => {
    vi.stubEnv("CLIPFORGE_ELEVENLABS_PACKAGE_PATH", "relative/cli");
    await expect(discoverElevenLabsInstallation()).rejects.toMatchObject({ code: "ELEVENLABS_INVALID_INSTALLATION" });
  });

  it("passes OS identity for existing OAuth while excluding launcher and API overrides from CLI commands", () => {
    vi.stubEnv("HOME", path.join(fixtureRoot, "oauth-user"));
    vi.stubEnv("USERPROFILE", path.join(fixtureRoot, "oauth-profile"));
    vi.stubEnv("CLIPFORGE_ELEVENLABS_PACKAGE_PATH", path.join(fixtureRoot, "managed"));
    vi.stubEnv("ELEVENLABS_API_KEY", "unused-api-key");

    expect(buildElevenLabsEnvironment()).toMatchObject({ HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE });
    expect(buildElevenLabsEnvironment()).not.toHaveProperty("CLIPFORGE_ELEVENLABS_PACKAGE_PATH");
    expect(buildElevenLabsEnvironment()).not.toHaveProperty("ELEVENLABS_API_KEY");
  });
});
