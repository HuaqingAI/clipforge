import { describe, expect, it } from "vitest";
import { assetScopeForShot, type ScriptContext } from "@/lib/asset-context";
import type { Shot } from "@/lib/db/schema";
import { hasTrustedPremiumCgAssetProvenance, type PremiumCgAssetCandidate } from "@/lib/premium-cg-assets";

const shot: Shot = { shotId: 1, type: "demo", duration: 5, description: "Chair in a studio", camera: "Static", voiceover: "", visualSource: "ai_generate", transition: "direct_concat" };
const script: ScriptContext = { id: "script", shots: [shot] };
const original = "/api/files/project/asset-1-1793066373000-grid.png";
const refinement: PremiumCgAssetCandidate = {
  shotId: 1, type: "ai_generated", status: "done",
  filePath: "/api/files/project/keyframe-refine-1-1793066373000-abcd1234.png",
  prompt: "[keyframe-refine-v1]\nServer-owned product policy",
  sourceKeyframeUrl: original, ...assetScopeForShot(script, shot, "original-asset"),
};

describe("premium CG keyframe refinement provenance", () => {
  it("allows scoped server refinement candidates to be adopted and reused", () => {
    expect(hasTrustedPremiumCgAssetProvenance(refinement, "project", script)).toBe(true);
    expect(hasTrustedPremiumCgAssetProvenance({ ...refinement, filePath: original, prompt: "[storyboard-grid]" }, "project", script)).toBe(true);
  });

  it("reuses a trusted same-script candidate after shot edits or revision metadata drift", () => {
    const editedScript = { ...script, version: 9, shots: [{ ...shot, camera: "Slow push in" }] };
    expect(hasTrustedPremiumCgAssetProvenance(refinement, "project", editedScript)).toBe(true);
    expect(hasTrustedPremiumCgAssetProvenance({ ...refinement, sourceShotKey: "changed-shot", sourceRevision: "historical-revision" }, "project", script)).toBe(true);
    expect(hasTrustedPremiumCgAssetProvenance(refinement, "project", { ...script, shots: [] })).toBe(false);
  });

  it.each<Partial<PremiumCgAssetCandidate>>([
    { filePath: "/api/files/another/keyframe-refine-1-1793066373000-abcd1234.png" },
    { filePath: "/api/files/project/keyframe-refine-2-1793066373000-abcd1234.png" },
    { filePath: "/api/files/project/upload.png" },
    { prompt: "User-supplied image repair" },
    { derivedFromAssetId: null },
    { sourceKeyframeUrl: "/api/files/another/frame.png" },
    { sourceScriptId: "another-script" },
    { sourceScriptId: null, sourceShotKey: null, sourceRevision: null },
  ])("rejects missing or mismatched provenance: %j", (overrides) => {
    expect(hasTrustedPremiumCgAssetProvenance({ ...refinement, ...overrides }, "project", script)).toBe(false);
  });
});
