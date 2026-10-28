// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertGenerationInputs, captureGenerationInputs, GenerationInputError } from "@/lib/generation-inputs";

let directory: string;
const frameUrl = "/api/files/project/frame.png";
function file(name: string, content: string) {
  const path = join(directory, "uploads", "project", name);
  writeFileSync(path, content); return path;
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "clipforge-generation-inputs-"));
  vi.stubEnv("APP_DATA_DIR", directory);
  mkdirSync(join(directory, "uploads", "project"), { recursive: true });
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

describe("generation input content snapshots", () => {
  it("captures nested first/tail frames and ordered references once while skipping external URLs and data", () => {
    file("frame.png", "first-frame-bytes"); file("tail.png", "tail-frame-bytes"); file("reference.mp4", "reference-video-bytes");
    const inputs = captureGenerationInputs({ firstFrameUrl: frameUrl, options: { nested: [{ lastImageUrl: "/api/files/project/tail.png" }, { referenceVideoUrls: ["/api/files/project/reference.mp4", frameUrl] }] }, imageUrl: "https://remote.example.test/api/files/not-a-local-file.png", data: "data:image/png;base64,AAAA", ordinary: "Generate a shot using /api/files/project/mentioned.png" });
    expect(inputs).toEqual([
      { url: frameUrl, hash: createHash("sha256").update("first-frame-bytes").digest("hex") },
      { url: "/api/files/project/tail.png", hash: createHash("sha256").update("tail-frame-bytes").digest("hex") },
      { url: "/api/files/project/reference.mp4", hash: createHash("sha256").update("reference-video-bytes").digest("hex") },
    ]);
    expect(() => assertGenerationInputs(inputs)).not.toThrow();
  });

  it("resolves encoded filenames and ignores query/hash when reading their content", () => {
    file("frame one.png", "unchanged-frame");
    const url = "/api/files/project/frame%20one.png?revision=1#preview";
    const inputs = captureGenerationInputs({ imageUrl: url });
    expect(inputs[0].url).toBe(url);
    expect(inputs[0].hash).toBe(createHash("sha256").update("unchanged-frame").digest("hex"));
    expect(() => assertGenerationInputs(inputs)).not.toThrow();
  });

  it("detects a same-path replacement even if byte length and modification time are preserved", () => {
    const path = file("frame.png", "AAAA");
    const previous = statSync(path);
    const inputs = captureGenerationInputs({ firstFrameUrl: frameUrl });
    writeFileSync(path, "BBBB"); utimesSync(path, previous.atime, previous.mtime);
    expect(() => assertGenerationInputs(inputs)).toThrow(GenerationInputError);
    expect(() => assertGenerationInputs(inputs)).toThrow(expect.objectContaining({ code: "GENERATION_REFERENCE_CHANGED", url: frameUrl }));
  });

  it("allows rewriting the same bytes because the chosen content is unchanged", () => {
    const path = file("frame.png", "same-content");
    const inputs = captureGenerationInputs({ imageUrl: frameUrl });
    writeFileSync(path, "same-content");
    expect(() => assertGenerationInputs(inputs)).not.toThrow();
  });

  it("rejects a missing reference during enqueue and a deleted reference before submission", () => {
    expect(() => captureGenerationInputs({ referenceImageUrls: [frameUrl] })).toThrow(expect.objectContaining({ code: "GENERATION_REFERENCE_UNREADABLE" }));
    const path = file("frame.png", "chosen-content");
    const inputs = captureGenerationInputs({ referenceImageUrls: [frameUrl] }); unlinkSync(path);
    expect(() => assertGenerationInputs(inputs)).toThrow(expect.objectContaining({ code: "GENERATION_REFERENCE_UNREADABLE" }));
    try { assertGenerationInputs(inputs); } catch (error) { expect((error as Error).message).not.toContain(directory); }
  });

  it.each(["/api/files/../outside/secret.txt", "/api/files/%2e%2e%2foutside%2fsecret.txt", "/api/files/project/%00frame.png"])("refuses invalid local path %s instead of reading outside uploads", (url) => {
    mkdirSync(join(directory, "outside")); writeFileSync(join(directory, "outside", "secret.txt"), "private-content");
    expect(() => captureGenerationInputs({ imageUrl: url })).toThrow(GenerationInputError);
  });

  it("refuses an uploads symlink that leads outside the uploads root", () => {
    const outside = join(directory, "outside"); mkdirSync(outside); writeFileSync(join(outside, "secret.txt"), "private-content");
    symlinkSync(outside, join(directory, "uploads", "linked"), process.platform === "win32" ? "junction" : "dir");
    expect(() => captureGenerationInputs({ imageUrl: "/api/files/linked/secret.txt" })).toThrow(GenerationInputError);
  });

  it("does not interpret absolute disk paths as local references and accepts old snapshots", () => {
    expect(captureGenerationInputs({ path: join(directory, "outside", "secret.txt"), imageUrl: "https://example.test/image.png", image: "data:image/png;base64,AAAA" })).toEqual([]);
    expect(() => assertGenerationInputs(undefined)).not.toThrow();
  });

  it("handles repeated or cyclic nested containers without adding duplicate inputs", () => {
    file("frame.png", "same-content");
    const nested: Record<string, unknown> = { reference: frameUrl };
    nested.self = nested;
    expect(captureGenerationInputs({ options: [nested, nested] })).toHaveLength(1);
  });
});
