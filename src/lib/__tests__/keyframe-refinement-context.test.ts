// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  checkCreativeProfileContext,
  createCreativeProfileSnapshot,
  createPremiumProductCgProfile,
  createTideweOutdoorProfile,
} from "@/lib/creative-profiles";
import { checkKeyframeRefinementContext } from "@/lib/keyframe-refinement-context";
function fixture() {
  const profile = createTideweOutdoorProfile();
  return {
    project: { creativeProfile: profile, creativeConfigRevision: 6 },
    script: { styleType: "tidewe_outdoor", creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 2) },
  };
}

describe("existing-keyframe creative context", () => {
  it("uses the shared script policy without a separate refinement revision guard", () => {
    const { project, script } = fixture();
    expect(checkKeyframeRefinementContext).toBe(checkCreativeProfileContext);
    expect(checkKeyframeRefinementContext(project, script)).toMatchObject({ ok: true, projectRevision: 6, scriptRevision: 2, scriptProfile: script.creativeProfileSnapshot.profile });
    expect(script.creativeProfileSnapshot.creativeConfigRevision).toBe(2);
    expect(checkCreativeProfileContext(project, script).ok).toBe(true);
  });

  it("keeps same-revision requests usable", () => {
    const { project, script } = fixture();
    expect(checkKeyframeRefinementContext({ creativeProfile: project.creativeProfile, creativeConfigRevision: 2 }, script).ok).toBe(true);
  });

  it("does not depend on object property order", () => {
    const { project, script } = fixture();
    const reorderedProfile = Object.fromEntries(Object.entries(project.creativeProfile).reverse());
    expect(checkKeyframeRefinementContext({ ...project, creativeProfile: reorderedProfile }, script).ok).toBe(true);
  });

  it("uses the frozen visual and presenter policy after project settings change", () => {
    const { project, script } = fixture();
    expect(checkKeyframeRefinementContext({ ...project, creativeProfile: createTideweOutdoorProfile({ speechMode: "voiceover" }) }, script))
      .toMatchObject({ ok: true, projectProfile: script.creativeProfileSnapshot.profile, scriptProfile: script.creativeProfileSnapshot.profile });
    expect(checkKeyframeRefinementContext({ ...project, creativeProfile: createTideweOutdoorProfile({ presenter: {
      id: "new-host", name: "New host", appearance: "成年户外主播", referenceImages: ["https://example.test/new.png"],
    } }) }, script)).toMatchObject({ ok: true, scriptProfile: script.creativeProfileSnapshot.profile });
  });

  it("never allows a creation-type mismatch", () => {
    const { project, script } = fixture();
    expect(checkKeyframeRefinementContext({ ...project, creativeProfile: createPremiumProductCgProfile() }, script))
      .toMatchObject({ ok: false, code: "CREATIVE_PROFILE_MISMATCH" });
  });

  it("keeps premium CG narration policy frozen to the selected script", () => {
    const profile = createPremiumProductCgProfile({ narrationMode: "none" });
    const script = { styleType: "premium_product_cg", creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 2) };
    expect(checkKeyframeRefinementContext({ creativeProfile: profile, creativeConfigRevision: 6 }, script).ok).toBe(true);
    expect(checkKeyframeRefinementContext({ creativeProfile: createPremiumProductCgProfile({ narrationMode: "restrained" }), creativeConfigRevision: 6 }, script))
      .toMatchObject({ ok: true, projectProfile: script.creativeProfileSnapshot.profile, scriptProfile: script.creativeProfileSnapshot.profile });
  });
});
