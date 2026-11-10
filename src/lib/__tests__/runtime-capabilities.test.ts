// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLocalCliRuntimeEnabled } from "@/lib/runtime-capabilities";
import { NextRequest } from "next/server";
import { assertLocalKlingOrigin } from "@/lib/kling/local-access";
import { assertLocalElevenLabsOrigin } from "@/lib/elevenlabs/local-access";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "clipforge-desktop-capability-"));
  for (const key of ["CLIPFORGE_RUNTIME", "CLIPFORGE_DESKTOP_LOCAL", "CLIPFORGE_PROBE_MODE", "CLIPFORGE_KLING_DISABLED", "CLIPFORGE_ELEVENLABS_DISABLED", "CLIPFORGE_KLING_PACKAGE_PATH", "CLIPFORGE_ELEVENLABS_PACKAGE_PATH"]) vi.stubEnv(key, "");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

describe("managed local CLI capability", () => {
  it.each(["kling", "elevenlabs"] as const)("retains local web support for %s", service => {
    expect(isLocalCliRuntimeEnabled(service)).toBe(true);
  });
  it.each(["kling", "elevenlabs"] as const)("requires the managed flag and prepared package for desktop %s", async service => {
    vi.stubEnv("CLIPFORGE_RUNTIME", "desktop");
    expect(isLocalCliRuntimeEnabled(service)).toBe(false);
    vi.stubEnv("CLIPFORGE_DESKTOP_LOCAL", "1");
    expect(isLocalCliRuntimeEnabled(service)).toBe(false);
    const packageDirectory = join(directory, service);
    await mkdir(packageDirectory);
    await writeFile(join(packageDirectory, "package.json"), "{}");
    vi.stubEnv(service === "kling" ? "CLIPFORGE_KLING_PACKAGE_PATH" : "CLIPFORGE_ELEVENLABS_PACKAGE_PATH", packageDirectory);
    expect(isLocalCliRuntimeEnabled(service)).toBe(true);
    vi.stubEnv("CLIPFORGE_PROBE_MODE", "1");
    expect(isLocalCliRuntimeEnabled(service)).toBe(false);
  });
  it("does not let a managed flag bypass the explicit service disable", () => {
    vi.stubEnv("CLIPFORGE_KLING_DISABLED", "1");
    expect(isLocalCliRuntimeEnabled("kling")).toBe(false);
    expect(isLocalCliRuntimeEnabled("elevenlabs")).toBe(true);
  });
  it.each([
    ["CLIPFORGE_KLING_PACKAGE_PATH", assertLocalKlingOrigin],
    ["CLIPFORGE_ELEVENLABS_PACKAGE_PATH", assertLocalElevenLabsOrigin],
  ] as const)("keeps origin protection for a prepared desktop package %s", async (variable, assertOrigin) => {
    await writeFile(join(directory, "package.json"), "{}");
    vi.stubEnv("CLIPFORGE_RUNTIME", "desktop");
    vi.stubEnv("CLIPFORGE_DESKTOP_LOCAL", "1");
    vi.stubEnv(variable, directory);
    const request = (origin: string) => new NextRequest("http://localhost:3000/api", { headers: { host: "localhost:3000", origin } });
    expect(() => assertOrigin(request("http://localhost:3000"))).not.toThrow();
    expect(() => assertOrigin(request("https://evil.example"))).toThrow();
  });
});
