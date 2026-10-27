// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Shot } from "@/lib/db/schema";
import { createPremiumProductCgProfile, createTideweOutdoorProfile } from "@/lib/creative-profiles";
import { buildKeyframeRefinementPrompt } from "@/lib/keyframe-refinement-prompt";
import { PREMIUM_CG_IMAGE_POLICY } from "@/lib/premium-cg-prompt";

const shot: Shot = {
  shotId: 1, type: "demo", duration: 5,
  description: "A seated host gestures toward a window.",
  camera: "static", visualSource: "ai_generate", transition: "direct_concat", voiceover: "",
};

type PromptInput = Parameters<typeof buildKeyframeRefinementPrompt>[0];
function prompt(overrides: Partial<PromptInput> = {}) {
  return buildKeyframeRefinementPrompt({
    shot, issues: ["hands"], hasPresenterReference: true, productReferenceCount: 1, ...overrides,
  });
}

describe("keyframe repair priorities", () => {
  it.each(["hands", "anatomy"] as const)("allows %s corrections to change defective local pose without changing the scene", (issue) => {
    const result = prompt({ issues: [issue] });
    expect(result).toContain("anatomical correctness takes precedence over copying the source's local pose");
    expect(result).toContain("adjusting rotation, palm-facing direction and thumb placement");
    expect(result).toContain("Preserve physically plausible poses outside the regions identified for repair");
    expect(result).toContain("Preserve camera position, framing, overall action intent");
    expect(result).toContain("Do not force every palm to face the camera");
  });

  it("repairs handedness and wrist continuity instead of only finger count or sharpness", () => {
    const result = prompt();
    expect(result).toContain("from shoulder through elbow, forearm and wrist");
    expect(result).toContain("Correct palm-versus-back orientation");
    expect(result).toContain("the thumb's anatomical side");
    expect(result).toContain("Do not mirror the opposite hand onto this arm");
    expect(result).toContain("the source hand's incorrect orientation must not be preserved");
    expect(result).toContain("sharper texture alone does not satisfy the repair");
    expect(result).not.toContain("Preserve the original gesture and hand position");
    expect(result).not.toContain("pose anchor");
  });

  it.each(["details", "product"] as const)("preserves healthy gestures for a %s-only edit", (issue) => {
    const result = prompt({ issues: [issue] });
    expect(result).not.toContain("LOCAL ANATOMY REPAIR PRIORITY");
    expect(result).toContain("Preserve the existing body pose and gestures except for local changes explicitly required by the defect report");
    expect(result).toContain("Do not alter healthy anatomy for a clarity or product-only repair");
  });

  it("lets an explicit palm-direction report override defective source geometry even without a repair preset", () => {
    const instructions = "Only repair the raised hand: correct its palm direction and wrist connection.";
    const result = prompt({ issues: [], instructions });
    expect(result).toContain(instructions);
    expect(result).toContain("specific defect corrections take priority over copying erroneous local source details");
    expect(result).toContain("except for local changes explicitly required by the defect report");
    expect(result).toContain("correcting the defect takes priority over reproducing its source geometry or local pose");
    expect(result).not.toContain("subordinate to scene continuity");
    expect(result).not.toContain("Source-frame continuity and the server-owned policies above take precedence over conflicting repair notes");
  });
});

describe("repair policy boundaries", () => {
  const presenter = { id: "tom", name: "Tom", appearance: "成年户外主播", referenceImages: ["https://example.test/tom.png"] };

  it("retains frozen TIDEWE identity and product restrictions while allowing the hand repair", () => {
    const result = prompt({ profile: createTideweOutdoorProfile({ presenter }) });
    expect(result).toContain("anatomical correctness takes precedence");
    expect(result).toContain("Frozen presenter: 所选主播 Tom（成年户外主播）");
    expect(result).toContain("do not introduce another presenter");
    expect(result).toContain("No thermal imaging, glowing heated zones, cutaways, invented mechanisms");
    expect(result).toContain("Server-owned identity and product policies remain mandatory");
  });

  it("does not let a hand repair add a person or product to an approved empty TIDEWE shot", () => {
    const emptyShot: Shot = { ...shot, tidewe: {
      copySpan: { start: 0, end: 0 }, translation: "", shotGoal: "环境", productVisible: false,
      personVisible: false, sceneId: "blind", factRefs: [],
    } };
    const result = prompt({ shot: emptyShot, profile: createTideweOutdoorProfile({ presenter }), hasPresenterReference: false });
    expect(result).toContain("Do not add a presenter, face, hands or bystanders");
    expect(result).toContain("do not add the product or brand markings");
    expect(result).not.toContain("Frozen presenter:");
  });

  it("preserves Premium CG product policy and removes conflicting added-copy instructions", () => {
    const result = prompt({ profile: createPremiumProductCgProfile(), instructions: "Correct the raised hand and wrist. Add a price label. Buy now." });
    expect(result).toContain("Correct the raised hand and wrist.");
    expect(result).not.toContain("Add a price label");
    expect(result).not.toContain("Buy now");
    expect(result).toContain(PREMIUM_CG_IMAGE_POLICY);
    expect(result).toContain("Server-owned identity and product policies remain mandatory");
  });
});
