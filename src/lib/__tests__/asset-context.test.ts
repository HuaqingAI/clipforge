import { describe, expect, it } from "vitest";
import { assetMatchesScript, assetScopeForShot, filterAssetsForScript, scriptRevision, shotKey } from "@/lib/asset-context";
import { buildAssetRows, isKlingVideoSelection } from "@/lib/assets-view";
import type { Shot } from "@/lib/db/schema";

const shot: Shot = { shotId: 1, type: "hook", duration: 5, description: "商品在桌面上旋转", camera: "static", visualSource: "ai_generate", transition: "direct_concat", voiceover: "看这个细节", prompt: "Rotate the product" };
const script = { id: "script-a", version: 1, shots: [shot], totalDuration: 5, styleType: "scene", characters: [] };

describe("asset script context", () => {
  it("uses a stable SHA256 of script content, independent of object key insertion order", () => {
    expect(scriptRevision(script)).toMatch(/^[a-f0-9]{64}$/);
    expect(scriptRevision({ ...script, shots: [{ ...shot, camera: "static" }] })).toBe(scriptRevision(script));
    expect(scriptRevision({ ...script, shots: [{ ...shot, prompt: "A new scene" }] })).not.toBe(scriptRevision(script));
    expect(shotKey(script.id, shot)).not.toBe(shotKey("script-b", shot));
  });

  it("reuses edited same-script shots while excluding another script or missing shot", () => {
    const scope = assetScopeForShot(script, shot);
    const rows = [
      { id: "current", shotId: 1, ...scope },
      { id: "other-script", shotId: 1, ...assetScopeForShot({ ...script, id: "script-b" }, shot) },
      { id: "old-shot", shotId: 1, ...assetScopeForShot(script, { ...shot, camera: "pan" }) },
      { id: "other-shot", shotId: 2, ...scope },
      { id: "legacy", shotId: 1, sourceScriptId: null, sourceRevision: null, sourceShotKey: null },
    ];
    expect(filterAssetsForScript(rows, script).map((row) => row.id)).toEqual(["current", "old-shot", "legacy"]);
  });

  it("retains both shots after a camera edit within the same alternative", () => {
    const sibling = { ...shot, shotId: 2 };
    const original = { ...script, shots: [shot, sibling] };
    const current = { ...original, shots: [shot, { ...sibling, camera: "Slow push in" }] };
    const rows = original.shots.map((item) => ({ shotId: item.shotId, ...assetScopeForShot(original, item) }));
    expect(scriptRevision(current)).not.toBe(scriptRevision(original));
    expect(filterAssetsForScript(rows, current).map((row) => row.shotId)).toEqual([1, 2]);
  });

  it("requires script ownership and an existing shot while treating hashes as optional metadata", () => {
    expect(assetMatchesScript({ shotId: 1 }, undefined)).toBe(true);
    expect(assetMatchesScript({ shotId: 1, sourceScriptId: script.id }, script)).toBe(true);
    const scope = assetScopeForShot(script, shot);
    expect(assetMatchesScript({ shotId: 1, ...scope, sourceRevision: null }, script)).toBe(true);
    expect(assetMatchesScript({ shotId: 1, ...scope, sourceShotKey: null }, script)).toBe(true);
    expect(assetMatchesScript({ shotId: 1, ...scope, sourceScriptId: null }, script)).toBe(false);
    expect(assetMatchesScript({ shotId: 1, sourceScriptId: "", sourceRevision: "", sourceShotKey: "" }, script)).toBe(false);
    expect(assetMatchesScript({ shotId: 1, ...assetScopeForShot(script, shot) }, null)).toBe(false);
  });

  it("requires explicit source provenance for TIDEWE and canonical copy scripts", () => {
    const legacy = { shotId: 1, sourceScriptId: null, sourceRevision: null, sourceShotKey: null };
    const outdoor = { ...script, styleType: "tidewe_outdoor" };
    expect(assetMatchesScript(legacy, outdoor)).toBe(false);
    expect(assetMatchesScript(legacy, { ...script, copyDocument: { text: "Outdoor narration." } })).toBe(false);
    expect(assetMatchesScript({ shotId: 1, ...assetScopeForShot(outdoor, shot) }, outdoor)).toBe(true);
    expect(assetMatchesScript(legacy, script)).toBe(true);
  });
});

describe("Kling asset source vs display poster", () => {
  it("does not treat a text-to-video poster as an original input keyframe", () => {
    const [row] = buildAssetRows([shot], [{ shotId: 1, filePath: "/api/files/p/clip.mp4", thumbnailPath: "/api/files/p/poster.jpg", provider: "kling-cli", status: "done" }], []);
    expect(row.videoUrl).toBe("/api/files/p/clip.mp4");
    expect(row.thumbnailUrl).toBe("/api/files/p/poster.jpg");
    expect(row.keyframeUrl).toBeUndefined();
  });

  it("retains explicit source input separately from poster and keeps older provider behavior", () => {
    const [row] = buildAssetRows([shot], [{ shotId: 1, filePath: "/api/files/p/clip.mp4", thumbnailPath: "/api/files/p/poster.jpg", sourceKeyframeUrl: "/api/files/p/input.jpg", provider: "kling-cli", status: "done" }], []);
    expect(row.keyframeUrl).toBe("/api/files/p/input.jpg");
    expect(buildAssetRows([shot], [{ shotId: 1, filePath: "/api/files/p/old.mp4", thumbnailPath: "/api/files/p/old-input.jpg", provider: "volcengine", status: "done" }], [])[0].keyframeUrl).toBe("/api/files/p/old-input.jpg");
  });

  it("recognizes encoded official model keys without matching third-party Kling names", () => {
    expect(isKlingVideoSelection(JSON.stringify(["kling-cli", "image_to_video", "live-model"]))).toBe(true);
    expect(isKlingVideoSelection("fal-ai/kling-video/image-to-video")).toBe(false);
    expect(isKlingVideoSelection(undefined)).toBe(false);
  });
});
