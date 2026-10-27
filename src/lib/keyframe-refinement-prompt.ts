import type { Shot } from "@/lib/db/schema";
import type { ProjectCreativeProfile } from "@/lib/creative-profiles";
import { isPremiumProductCgProfile, isTideweOutdoorProfile } from "@/lib/creative-profiles";
import { PREMIUM_CG_IMAGE_POLICY, stripPremiumCgCopyDirectives } from "@/lib/premium-cg-prompt";
import { tidewePresenterAnchor } from "@/lib/tidewe/presenter";
import type { KeyframeRepairIssue } from "@/lib/keyframe-refinement";

export const KEYFRAME_REFINEMENT_MARKER = "[keyframe-refine-v1]";

const repairInstructions: Record<KeyframeRepairIssue, string> = {
  hands: "Reconstruct each visibly defective hand as a coherent anatomical structure, not merely a sharper copy or a finger-count correction. Trace its connection from shoulder through elbow, forearm and wrist to determine the correct left or right hand. Correct palm-versus-back orientation, forearm rotation, wrist alignment, the thumb's anatomical side and its opposable attachment to the palm, finger order and natural joint bends. Do not mirror the opposite hand onto this arm. Keep the intended action recognizable, but change the local hand rotation, wrist angle and finger arrangement when necessary; the source hand's incorrect orientation must not be preserved. Keep contact and occlusion physically plausible, including naturally hidden fingers.",
  anatomy: "Correct visible anatomical discontinuities, disconnected limbs and impossible body proportions. Restore a missing visible limb only where the existing pose and framing clearly require it; retain natural occlusion and limbs outside the frame.",
  duplicates: "Remove accidental duplicate objects, ghost furniture, repeated legs and disconnected extra parts only when they contradict the intended scene and supplied references. Preserve intentionally separate objects; do not impose a universal one-object or one-chair rule.",
  product: "Repair warped product geometry and component connections against the supplied product references. Keep the documented silhouette, proportions, material, camouflage, real markings and supported component count; do not invent hidden structure.",
  details: "Regenerate crisp, coherent fine detail in fabric, face, product surfaces and edges, preserving natural photographic texture without oversharpening or changing the design.",
};

/** The source anchors the scene; requested repairs may change defective local poses. */
export function buildKeyframeRefinementPrompt(input: {
  shot: Shot;
  issues: KeyframeRepairIssue[];
  instructions?: string;
  profile?: ProjectCreativeProfile;
  hasPresenterReference: boolean;
  productReferenceCount: number;
}): string {
  const { shot, profile } = input;
  const premiumCg = isPremiumProductCgProfile(profile);
  const tidewe = isTideweOutdoorProfile(profile) ? profile : undefined;
  const personVisible = shot.tidewe?.personVisible !== false;
  const productVisible = shot.tidewe?.productVisible !== false;
  const repairHumanStructure = input.issues.some((issue) => issue === "hands" || issue === "anatomy");
  const notes = premiumCg ? stripPremiumCgCopyDirectives(input.instructions) : input.instructions?.trim();
  return [
    KEYFRAME_REFINEMENT_MARKER,
    "Edit and regenerate ONE high-resolution still keyframe from reference image 1. Image 1 is the cropped single-shot storyboard frame and is the primary scene and composition anchor. Its defective anatomy or object geometry is not a correctness reference. This is an image repair, not a new scene or a contact sheet.",
    "If people are already visible, preserve their identity, face, age, hair, clothing and body build. Do not add people to an unpopulated frame. Preserve camera position, framing, overall action intent, scene layout, background, light direction, time of day and color palette. Preserve physically plausible poses outside the regions identified for repair. Make the smallest sufficient visual changes to actually correct the reported defects; source similarity must not preserve an identified defect. Preserve continuity with neighboring storyboard shots. Return one clean full-frame image with no grid, border, comparison panel or annotations.",
    repairHumanStructure ? "LOCAL ANATOMY REPAIR PRIORITY: within the hands or body regions selected for repair, anatomical correctness takes precedence over copying the source's local pose. You may reconstruct the wrist and adjacent forearm together with the defective hand, adjusting rotation, palm-facing direction and thumb placement as needed while keeping the overall action and composition. Use the connected body to infer handedness; do not assume that image-left equals the person's left. Do not force every palm to face the camera. Repair only actual visible errors; if the report identifies one hand, preserve the other physically plausible hand." : "Preserve the existing body pose and gestures except for local changes explicitly required by the defect report. Do not alter healthy anatomy for a clarity or product-only repair.",
    "The issues below describe defects to remove, not desired objects or composition. Do not reproduce or label those defects. Keep naturally occluded body parts hidden, retain the source crop, and never force a full body or extra limbs into a partial-body frame. Freeze one instant; do not draw multiple action stages, motion trails or spoken words. Local pose corrections required for a repair are allowed; unrelated new actions are not.",
    input.hasPresenterReference ? `Reference image 2 is the ${tidewe ? "frozen" : "saved"} presenter identity reference only: use it to preserve facial identity and body build, without importing its background, panel layout or clothing over the scene anchor.` : "",
    input.productReferenceCount > 0 ? `The last ${input.productReferenceCount} reference image(s) are saved product views: use them only to correct the same product's visible construction and markings, without importing their background or adding extra product copies.` : "",
    ...input.issues.map((issue) => repairInstructions[issue]),
    notes ? `Additional defect report and repair request (specific defect corrections take priority over copying erroneous local source details; preserve identity, framing and product/presenter policy): ${JSON.stringify(notes)}` : "",
    tidewe ? [
      "TIDEWE outdoor photographic demonstration. Preserve the real outdoor setting, realistic materials and the source frame's static moment.",
      personVisible && tidewe.presenter ? `Frozen presenter: ${tidewePresenterAnchor(tidewe.presenter)}. Preserve this identity; do not introduce another presenter.` : "",
      !personVisible ? "This approved shot has no visible person. Do not add a presenter, face, hands or bystanders." : "",
      !productVisible ? "This approved shot is environmental or contextual; do not add the product or brand markings." : "",
      "No new on-screen text, subtitles, sales graphics, prices, watermarks or invented logos. Keep only real markings visible in the product references. No thermal imaging, glowing heated zones, cutaways, invented mechanisms, performance demonstrations or standalone battery. A native-speech keyframe may have a natural visible mouth, but never draw dialogue, lip sequences or captions.",
    ].filter(Boolean).join("\n") : "",
    premiumCg ? PREMIUM_CG_IMAGE_POLICY : "",
    "Before returning the image, check the requested repairs in their body or object context. For a hand repair, check arm-to-wrist continuity, palm/back orientation, thumb side and finger articulation; sharper texture alone does not satisfy the repair. Return the repaired image only. Preserve unreported, physically plausible details and the intended number of people and objects. Server-owned identity and product policies remain mandatory; within a reported defective region, correcting the defect takes priority over reproducing its source geometry or local pose.",
  ].filter(Boolean).join("\n\n");
}
