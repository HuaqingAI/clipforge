// @vitest-environment node
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compositionErrorMessage, readCompositionError, saveCompositionError } from "@/lib/composition-error";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "clipforge-compose-error-"));
  vi.stubEnv("APP_DATA_DIR", directory);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("composition failure details", () => {
  it("preserves classified messages and extracts FFmpeg diagnostics without argv/banner", () => {
    const friendly = "磁盘空间不足，无法写出成片——请清理磁盘后重试";
    expect(compositionErrorMessage(new Error(friendly))).toBe(friendly);
    const diagnostic = "Unrecognized option 'filter_complex_script'.\nError splitting the argument list: Option not found";
    const error = Object.assign(new Error("Command failed: ffmpeg -i PRIVATE_INPUT -filter_complex_script PRIVATE_GRAPH"), {
      stderr: `ffmpeg version 9.0\n  built with gcc\n  configuration: --enable-libx264\n  libavutil      61.  3.100 / 61.  3.100\n${diagnostic}`,
    });
    expect(compositionErrorMessage(error)).toBe(diagnostic);
    expect(compositionErrorMessage(new Error(`Command failed: ffmpeg PRIVATE_INPUT\n${error.stderr}`))).toBe(diagnostic);
    expect(compositionErrorMessage(new Error("Command failed: ffmpeg PRIVATE_INPUT"))).not.toContain("PRIVATE_INPUT");
  });

  it("bounds diagnostics and retains the final useful error", () => {
    const message = compositionErrorMessage({ stderr: `${"x".repeat(5000)}\nCannot open output file` });
    expect(message.length).toBeLessThanOrEqual(1200);
    expect(message).toMatch(/Cannot open output file$/);
    expect(compositionErrorMessage(undefined)).toContain("视频合成失败");
  });

  it("persists details per project and composition, and tolerates missing/corrupt files", async () => {
    await saveCompositionError("project-a", "take-a", new Error("Missing input frame"));
    expect(await readCompositionError("project-a", "take-a")).toBe("Missing input frame");
    expect(await readCompositionError("project-b", "take-a")).toBeNull();
    expect(await readCompositionError("project-a", "take-b")).toBeNull();
    await writeFile(join(directory, "output", "project-a", ".composition-take-a.error.json"), "{incomplete", "utf8");
    expect(await readCompositionError("project-a", "take-a")).toBeNull();
  });

  it("rejects paths outside a project's error sidecars", async () => {
    expect(await readCompositionError("../project-a", "take-a")).toBeNull();
    expect(await readCompositionError("project-a", "../take-a")).toBeNull();
    await expect(saveCompositionError("project-a", "../take-a", new Error("private"))).rejects.toThrow("Invalid composition error ID");
  });
});
