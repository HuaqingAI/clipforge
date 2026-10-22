// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reusableStoryboardGrid, saveStoryboardGridManifest, storyboardGridSignature } from "@/lib/storyboard-grid-cache";

let directory: string;
const signatureInput = {
  scriptId: "script-1",
  shots: [{ shotId: 1, description: "Product shot", voiceover: "First line" }, { shotId: 2, description: "Side view" }],
  characters: [],
  prompt: "Full grid prompt",
  referenceInputs: ["/api/files/project-a/front.png", "/api/files/project-a/side.png"],
  referenceContents: ["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"],
  provider: "openai",
  model: "gpt-image-2",
  baseUrl: "https://provider.test/v1",
  options: { width: 720, height: 1280 },
};
const manifest = {
  version: 1 as const,
  signature: storyboardGridSignature(signatureInput),
  gridPath: "/api/files/project-a/grid.png",
  cells: [1, 2].map((shotId) => ({ shotId, filePath: `/api/files/project-a/cell-${shotId}.png` })),
};
const active = manifest.cells.map((cell) => ({ ...cell, selected: true, status: "done" }));

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "clipforge-grid-cache-"));
  vi.stubEnv("APP_DATA_DIR", directory);
  await mkdir(join(directory, "uploads", "project-a"), { recursive: true });
  await Promise.all(["grid.png", "cell-1.png", "cell-2.png"].map((name) =>
    writeFile(join(directory, "uploads", "project-a", name), "nonempty-image-fixture")));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("storyboard grid reuse manifest", () => {
  it("compares canonical settings while retaining ordered references and complete script content", () => {
    const digest = storyboardGridSignature(signatureInput);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(storyboardGridSignature({ ...signatureInput, options: { height: 1280, width: 720 } })).toBe(digest);
    const changes = [
      { ...signatureInput, shots: [{ ...signatureInput.shots[0], voiceover: "Changed dialogue" }, signatureInput.shots[1]] },
      { ...signatureInput, referenceInputs: [...signatureInput.referenceInputs].reverse() },
      { ...signatureInput, referenceContents: ["data:image/png;base64,CHANGED", signatureInput.referenceContents[1]] },
      { ...signatureInput, model: "gpt-image-1.5" },
      { ...signatureInput, options: { width: 1080, height: 1920 } },
      { ...signatureInput, prompt: "A product-only grid prompt" },
    ];
    for (const changed of changes) expect(storyboardGridSignature(changed)).not.toBe(digest);
  });

  it("loads a complete persisted grid using only its original active image cells", async () => {
    await saveStoryboardGridManifest("project-a", manifest);
    expect(await reusableStoryboardGrid("project-a", manifest.signature, [1, 2], active)).toEqual(manifest);
    expect(await reusableStoryboardGrid("project-a", "changed", [1, 2], active)).toBeUndefined();
    expect(await reusableStoryboardGrid("project-a", manifest.signature, [2, 1], active)).toBeUndefined();
    expect(await reusableStoryboardGrid("project-a", manifest.signature, [1, 2], [active[0]])).toBeUndefined();
    expect(await reusableStoryboardGrid("project-a", manifest.signature, [1, 2], [...active, active[0]])).toBeUndefined();
    expect(await reusableStoryboardGrid("project-a", manifest.signature, [1, 2], [{ ...active[0], filePath: "/api/files/project-a/different.png" }, active[1]])).toBeUndefined();
  });

  it("misses missing, malformed, and older manifests without inferring reuse from assets", async () => {
    expect(await reusableStoryboardGrid("project-a", manifest.signature, [1, 2], active)).toBeUndefined();
    await saveStoryboardGridManifest("project-a", manifest);
    await writeFile(join(directory, "storyboard-grids", "project-a.json"), "{bad-json");
    expect(await reusableStoryboardGrid("project-a", manifest.signature, [1, 2], active)).toBeUndefined();
    await writeFile(join(directory, "storyboard-grids", "project-a.json"), JSON.stringify({ ...manifest, version: 0 }));
    expect(await reusableStoryboardGrid("project-a", manifest.signature, [1, 2], active)).toBeUndefined();
  });

  it("requires both the grid and every cropped cell to remain on disk", async () => {
    await saveStoryboardGridManifest("project-a", manifest);
    await rm(join(directory, "uploads", "project-a", "cell-2.png"));
    expect(await reusableStoryboardGrid("project-a", manifest.signature, [1, 2], active)).toBeUndefined();
    await writeFile(join(directory, "uploads", "project-a", "cell-2.png"), "image");
    await rm(join(directory, "uploads", "project-a", "grid.png"));
    expect(await reusableStoryboardGrid("project-a", manifest.signature, [1, 2], active)).toBeUndefined();
  });

  it("rejects manifest paths that traverse into another project", async () => {
    await mkdir(join(directory, "uploads", "project-b"));
    await writeFile(join(directory, "uploads", "project-b", "grid.png"), "private-image");
    await saveStoryboardGridManifest("project-a", { ...manifest, gridPath: "/api/files/project-a/../project-b/grid.png" });
    expect(await reusableStoryboardGrid("project-a", manifest.signature, [1, 2], active)).toBeUndefined();
  });
});
