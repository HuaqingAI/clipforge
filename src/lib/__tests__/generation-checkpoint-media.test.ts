// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactCompletedGenerationCheckpoint, generationResultFilePath, persistGenerationCheckpointMedia, persistGenerationMediaUrls } from "@/lib/generation-checkpoint-media";
import { generationCheckpoint, generationContextCheckpoint, withGenerationContext } from "@/lib/generation-context";

let directory: string;
const bytes = Buffer.from("a durable paid image");
const image = `data:image/png;base64,${bytes.toString("base64")}`;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "clipforge-checkpoint-media-")); vi.stubEnv("APP_DATA_DIR", directory); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

describe("paid generation checkpoint media", () => {
  it("stores one durable file for duplicate output aliases and leaves frozen inputs unchanged", () => {
    const plan = { referenceImage: image, options: { mask: image } };
    const value = persistGenerationCheckpointMedia("A", { imageUrls: [image], resultUrls: [image], generationResult: { imageUrls: [image] }, refinementPlan: plan, taskId: "paid-id" });
    const url = (value.imageUrls as string[])[0];
    expect(url).toMatch(/^\/api\/files\/A\/generation-result-[a-f0-9]{64}\.png$/);
    expect(value).toMatchObject({ resultUrls: [url], generationResult: { imageUrls: [url] }, taskId: "paid-id" });
    expect(value.refinementPlan).toBe(plan);
    expect(readFileSync(generationResultFilePath("A", url)!)).toEqual(bytes);
    expect(readdirSync(join(directory, "uploads", "A"))).toEqual([url.split("/").pop()]);
    expect(persistGenerationMediaUrls("A", [image, "https://provider.test/paid.png", url])).toEqual([url, "https://provider.test/paid.png", url]);
  });

  it("writes the file before saving a reference and does not update the in-memory checkpoint after a database failure", async () => {
    const saved = vi.fn((value: Record<string, unknown>) => {
      const url = (value.imageUrls as string[])[0];
      expect(readFileSync(generationResultFilePath("A", url)!)).toEqual(bytes);
      throw new Error("database unavailable");
    });
    await withGenerationContext({ itemId: "item", projectId: "A", checkpoint: { taskId: "paid-id" }, save: saved }, async () => {
      expect(() => generationCheckpoint({ imageUrls: [image] })).toThrow("database unavailable");
      expect(generationContextCheckpoint()).toEqual({ taskId: "paid-id" });
    });
    expect(saved).toHaveBeenCalledOnce();
  });

  it("keeps the raw paid response in SQLite when uploads cannot be written, then stops for import recovery", async () => {
    writeFileSync(join(directory, "uploads"), "blocks directory creation");
    const saved = vi.fn();
    await withGenerationContext({ itemId: "item", projectId: "A", checkpoint: { submissionState: "submitting" }, save: saved }, async () => {
      expect(() => generationCheckpoint({ taskId: "paid-id", submissionState: "acknowledged", imageUrls: [image] })).toThrow(expect.objectContaining({ code: "GENERATION_IMPORT_FAILED", retryable: true }));
      expect(saved).toHaveBeenCalledWith({ taskId: "paid-id", submissionState: "acknowledged", imageUrls: [image] });
      expect(generationContextCheckpoint()).toEqual(saved.mock.calls[0][0]);
    });
  });

  it("compacts redundant provider images only after all imported files are present, retaining recovery identity and plans", () => {
    const target = join(directory, "uploads", "A");
    mkdirSync(target, { recursive: true }); writeFileSync(join(target, "saved.png"), bytes);
    const result = { assetId: "asset", imageUrls: ["/api/files/A/saved.png"] };
    const checkpoint = { taskId: "paid-id", remoteTaskId: "remote-id", childJobId: "child", submissionState: "acknowledged", refinementPlan: { source: "original" }, imageUrls: [image], resultUrls: [image], generationResult: { imageUrls: [image] }, localPaths: { 0: "/api/files/A/saved.png" } };
    expect(compactCompletedGenerationCheckpoint("A", checkpoint, result)).toEqual({ taskId: "paid-id", remoteTaskId: "remote-id", childJobId: "child", submissionState: "acknowledged", refinementPlan: checkpoint.refinementPlan, localPaths: checkpoint.localPaths, completedResult: result });
    expect(readdirSync(target)).toEqual(["saved.png"]);
    expect(compactCompletedGenerationCheckpoint("A", checkpoint, { imageUrls: ["/api/files/A/missing.png"] })).toBe(checkpoint);
    expect(compactCompletedGenerationCheckpoint("A", checkpoint, { imageUrls: ["/api/files/A/saved.png", "https://provider.test/not-imported.png"] })).toBe(checkpoint);
    expect(compactCompletedGenerationCheckpoint("A", checkpoint, { assetId: "unverified" })).toBe(checkpoint);
    const partial = { ...checkpoint, imageUrls: [image, "https://provider.test/second-paid-image.png"] };
    expect(compactCompletedGenerationCheckpoint("A", partial, result)).toBe(partial);
    writeFileSync(join(target, "saved.png"), "");
    expect(compactCompletedGenerationCheckpoint("A", checkpoint, result)).toBe(checkpoint);
  });

  it("does not resolve a foreign project, traversal, or an encoded filename as a local result", () => {
    for (const url of ["/api/files/B/paid.png", "/api/files/A/../paid.png", "/api/files/A/%2e%2e.png", "C:\\paid.png"]) expect(generationResultFilePath("A", url)).toBeUndefined();
    expect(existsSync(join(directory, "uploads"))).toBe(false);
  });
});
