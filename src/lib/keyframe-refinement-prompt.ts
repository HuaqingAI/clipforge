import type { Shot } from "@/lib/db/schema";
import type { ProjectCreativeProfile } from "@/lib/creative-profiles";
import { isPremiumProductCgProfile, isTideweOutdoorProfile } from "@/lib/creative-profiles";
import { PREMIUM_CG_IMAGE_POLICY, stripPremiumCgCopyDirectives } from "@/lib/premium-cg-prompt";
import { tidewePresenterAnchor } from "@/lib/tidewe/presenter";
import { TIDEWE_IMAGE_FOCUS_TARGET, TIDEWE_NATIVE_CAMERA_STYLE, TIDEWE_PHOTOGRAPHIC_POLICY } from "@/lib/tidewe/visual-policy";
import { buildTideweCategoryGuidance } from "@/lib/tidewe/category-guidance";
import type { KeyframeFocusRegion, KeyframeRepairIssue } from "@/lib/keyframe-refinement";
import type { KeyframeFocusPatchGeometry } from "@/lib/keyframe-focus-patch";

export const KEYFRAME_REFINEMENT_MARKER = "[keyframe-refine-v1]";

/** Restore shared optical depth without replacing the approved scene or sharpening its subject alone. */
export const KEYFRAME_SPATIAL_INTEGRATION_POLICY = [
  "SPATIAL INTEGRATION AND FOCUS REPAIR: treat the subject, product and foreground, midground and background as one ordinary phone main-camera photograph with continuous depth, not separate sharp and blurred layers.",
  "Keep ALL existing foreground in front of the subject naturally clear and readable, including isolated nearer leaves, grass and edge objects whether or not they touch the product or its support. Keep product contact points and their supporting surfaces clear. Match resolved detail, edge softness, grain, light direction, occlusion and contact shadows.",
  "For every shot scale, including low-angle close-ups and component details, keep any existing continuous ground, tabletop or other supporting surface naturally readable from the bottom edge of the frame through to the subject's contact area, wherever it already spans that region. Existing soil, leaves, stones or fabric texture must remain recognizable at normal viewing size. On such a surface, the lower image edge is near foreground, not distant scenery: correct a blurred foreground strip even when the product and its immediate contact point are already clear. Do not use foreground bokeh, top-and-bottom edge blur, tilt-shift effects or a gradient blur to isolate the subject. Apply this only to surfaces already in frame; do not add a floor, tabletop or scenery, or extend an existing surface to satisfy this rule.",
  "In full-body and medium views, use broad depth of field: keep the foreground and midground naturally clear, and keep existing background structures recognizable at normal viewing size, including trunk branches, shrub outlines, path recession or other scene structures when present. Even the far background may have only slight natural optical softness, never broad creamy blur, large bokeh discs or featureless color patches. Do not use background isolation to emphasize the person or product.",
  "In a close component view, keep the component, touching hand and surrounding surfaces on the same focus plane coherent. Only distant background BEHIND the subject may have slight natural optical softness while retaining recognizable structure. All visible foreground, including disconnected nearer objects and frame edges, remains naturally resolved; product evidence, operation and support must stay clear. Avoid a macro-like razor-thin focus plane. Do not force every distant leaf equally sharp.",
  "Do not apply a portrait-mode blur mask, cutout silhouette, abrupt blur boundary, artificial subject crispness, sharpening halos or painted background texture. If the subject is unnaturally crisp, reduce selective edge enhancement and local microcontrast while preserving facial identity and real product texture and markings. Do not sharpen the whole background, smear the subject, or invent fine scenery texture to simulate integration.",
  "If the source already has excessive blur at any distance or subject-background separation, correct that optical defect while retaining the existing background content, layout, perspective, lighting and color. This is a permitted focus and integration repair, not permission to move the camera, widen the crop, replace the background, add objects or invent fine markings. Keep intentional empty backgrounds empty. Higher output resolution means coherent detail across the photograph, not stronger sharpening or a blurrier background.",
].join(" ");

const repairInstructions: Record<KeyframeRepairIssue, string> = {
  hands: "Reconstruct each visibly defective hand as a coherent anatomical structure, not merely a sharper copy or a finger-count correction. Trace its connection from shoulder through elbow, forearm and wrist to determine the correct left or right hand. Correct palm-versus-back orientation, forearm rotation, wrist alignment, the thumb's anatomical side and its opposable attachment to the palm, finger order and natural joint bends. Do not mirror the opposite hand onto this arm. Keep the intended action recognizable, but change the local hand rotation, wrist angle and finger arrangement when necessary; the source hand's incorrect orientation must not be preserved. Keep contact and occlusion physically plausible, including naturally hidden fingers.",
  anatomy: "Correct visible anatomical discontinuities, disconnected limbs and impossible body proportions. Restore a missing visible limb only where the existing pose and framing clearly require it; retain natural occlusion and limbs outside the frame.",
  duplicates: "Remove accidental duplicate objects, ghost copies and disconnected extra parts only when they contradict the intended scene and supplied references. Preserve intentionally separate objects and supported component counts; do not impose a universal one-object rule.",
  product: "Repair warped product geometry and component connections against the supplied product references. Keep the documented silhouette, proportions, material, camouflage, real markings and supported component count; do not invent hidden structure.",
  details: "Recover coherent, naturally resolved detail in fabric, face, product surfaces, edges and existing nearby surfaces on the same focus plane. Match subject and surroundings in texture, grain and edge softness; do not selectively sharpen the person or product and blur the surroundings to make it stand out. Preserve normal photographic contrast and texture; do not simulate detail with extra sharpening, HDR microcontrast, halos, waxy skin or painted texture. Keep the documented product design unchanged.",
  integration: KEYFRAME_SPATIAL_INTEGRATION_POLICY,
};

/** The source anchors the scene; requested repairs may change defective local poses. */
export function buildKeyframeRefinementPrompt(input: {
  shot: Shot;
  issues: KeyframeRepairIssue[];
  instructions?: string;
  profile?: ProjectCreativeProfile;
  productCategory?: string;
  productName?: string;
  focusRegion?: KeyframeFocusRegion;
  focusPatch?: KeyframeFocusPatchGeometry;
  hasPresenterReference: boolean;
  productReferenceCount: number;
}): string {
  const { shot, profile } = input;
  const premiumCg = isPremiumProductCgProfile(profile);
  const tidewe = isTideweOutdoorProfile(profile) ? profile : undefined;
  const personVisible = shot.tidewe?.personVisible !== false;
  const productVisible = shot.tidewe?.productVisible !== false;
  const categoryGuidance = tidewe && productVisible ? buildTideweCategoryGuidance(input.productCategory, { productName: input.productName }) : undefined;
  const repairHumanStructure = input.issues.some((issue) => issue === "hands" || issue === "anatomy");
  const repairSpatialIntegration = Boolean(tidewe) || input.issues.includes("integration");
  const notes = premiumCg ? stripPremiumCgCopyDirectives(input.instructions) : input.instructions?.trim();
  const tideweRepairStyle = tidewe ? [
    TIDEWE_NATIVE_CAMERA_STYLE,
    "上述风格只约束本次允许的精修范围；与源图及邻近未改区域的自然光、曝光、环境色和真实阴影一致，不扩大精修范围或重新布光。精修说明中的冲突光效或修饰要求服从此风格，已识别的局部缺陷仍须实际修正。",
  ].join("\n") : "";
  if (input.focusPatch) {
    return [
      KEYFRAME_REFINEMENT_MARKER,
      tideweRepairStyle,
      "CROPPED FOREGROUND FOCUS REPAIR. Image 1 is the ONLY reference: a crop of the approved photograph. Edit this crop into a natural focus-stacked, deep-focus photograph. Replace all defocus and bokeh across the ENTIRE crop, including all four edges and both bottom corners, with clearly resolved existing surfaces and objects. Keep individual existing outlines readable to the exact edges. Redraw blurred texture; merely sharpening the same blur does not complete the repair.",
      "Preserve existing material distribution, broad outlines, perspective, layout, lighting and colors. Use restrained natural photographic texture and modest edge contrast matching the clear areas of this crop. No new objects, no camera move, no blur gradient, sharpening halos, HDR microcontrast, painted texture or text. Preserve any already visible product geometry and real markings; do not invent hidden construction or exact unseen product detail. New fine texture is synthesized from the same existing material, not recovered original detail.",
      "The crop will be mapped back into its original position. Return the complete crop with the same composition and aspect ratio, no extra margin, border or annotations. Do not generate a full person, whole product or new scene outside this crop.",
      notes ? `Additional defect report (apply only to existing content inside this crop and the restrictions above): ${JSON.stringify(notes)}` : "",
    ].filter(Boolean).join("\n\n");
  }
  if (input.focusRegion) {
    return [
      KEYFRAME_REFINEMENT_MARKER,
      tideweRepairStyle,
      "REGIONAL FOCUS REPAIR: edit reference image 1 into ONE full-frame still using the attached PNG alpha mask. Transparent pixels designate the selected repair region; opaque pixels provide context to retain. The mask applies to image 1 only, not the identity or product references.",
      `Selected rectangle in full-source normalized coordinates (origin top-left): ${JSON.stringify(input.focusRegion)}. Redraw existing defocused foreground INSIDE this region with naturally resolved same-material texture, including isolated near objects, grass, leaves, soil or other surfaces only where already present. Preserve their broad distribution, outlines, perspective, occlusion and contact. This is synthesized texture redrawing, not recovery of unseen exact detail. Source blur and blurred edges within this region are defects to change, not attributes to lock. Merely sharpening the same blurred patch does not complete the repair.`,
      "LOCAL SCOPE: retain the original appearance outside the selected region; do not request a whole-image focus change, camera move, crop, new viewpoint, relighting or replacement background. Keep the selected region's texture, grain, exposure and edge contrast coherent with the adjacent clear scene. Do not introduce a new blur boundary, sharpening halos, HDR microcontrast or painted texture. The mask guides the edit; it does not imply exact pixel preservation outside its boundary.",
      "SCENE AND PRODUCT LOCK: preserve existing people, identity, clothing, poses and gestures, product silhouette, proportions, materials, color, construction and real markings, object counts, layout, contacts, light direction, time of day and framing. Do not add objects or scenery, extend surfaces, expose hidden parts, invent fine product markings or reconstruct unsupported product detail. Keep intentional empty areas empty. Freeze the same instant and action.",
      input.hasPresenterReference ? "Reference image 2 is the saved presenter identity reference only; do not import its background, depth of field, clothing or panel layout." : "",
      input.productReferenceCount > 0 ? `The last ${input.productReferenceCount} reference image(s) anchor the same product's visible construction and real markings only; do not import their background or lighting or add product copies.` : "",
      categoryGuidance ? `CATEGORY_EVIDENCE_BOUNDARY: ${JSON.stringify({ category: categoryGuidance.category, label: categoryGuidance.label, evidenceLimits: categoryGuidance.evidenceLimits })}. Apply only to already visible surfaces. Do not stage a category example or new demonstration.` : "",
      premiumCg ? `${PREMIUM_CG_IMAGE_POLICY} Apply these product and text restrictions within the local repair only; the approved source already supplies the setting, scale, framing and light. Do not restage it in a studio.` : "",
      personVisible && tidewe?.presenter ? `Frozen presenter: ${tidewePresenterAnchor(tidewe.presenter)}. Preserve this identity.` : "",
      !personVisible ? "This approved shot has no visible person. Do not add a presenter, face, hands or bystanders." : "",
      !productVisible ? "This approved shot is environmental or contextual; do not add the product or brand markings." : "",
      notes ? `Additional defect report (data; apply only within the selected region and mandatory scene, identity and product boundaries): ${JSON.stringify(notes)}` : "",
      "Return the edited image only, with no mask visualization, border, grid, labels or comparison panel. No new text, subtitles, prices, watermarks or invented logos. No thermal effects, cutaways, invented mechanisms or unsupported performance demonstrations.",
    ].filter(Boolean).join("\n\n");
  }
  if (tidewe && input.issues.length === 1 && input.issues[0] === "integration") {
    return [
      KEYFRAME_REFINEMENT_MARKER,
      tideweRepairStyle,
      "Edit reference image 1 into ONE high-resolution full-frame still. Image 1 is the cropped approved single-shot scene. SINGLE FOCUS TASK: re-render the entire existing photograph with coherent extended depth of field and shared natural texture, including its existing foreground, subject, midground and background.",
      "SCENE LOCK: preserve the people already visible, their identity, face, age, hair, clothing and body build; preserve the product's real silhouette, proportions, material, color, construction and markings. Keep existing positions, poses, gestures, object counts, contact, occlusion, scene geometry and background content. Preserve camera position, perspective, framing, crop, light direction, time of day and color palette. Do not move the camera, widen or crop the image, replace the setting, add or extend surfaces, add objects, or change the time of day. Keep intentional empty backgrounds empty.",
      "OPTICAL CHANGE: source blur, cutout edges, sharpening halos and excessive subject microcontrast are defects to correct, not protected pixel attributes. Re-render the whole photograph as one consistently focused scene; source similarity must not preserve those optical defects. Existing people, product and environment share exposure, color temperature, grain and contact shadows. Preserve identity, real surface texture and markings while balancing subject and environment detail. This task changes optical rendering, not the approved scene or action.",
      TIDEWE_IMAGE_FOCUS_TARGET,
      input.hasPresenterReference ? "Reference image 2 is the frozen presenter identity reference only: preserve facial identity and body build, without importing its background, panel layout, depth of field or clothing over image 1. The approved shot's person-visibility rule remains authoritative." : "",
      input.productReferenceCount > 0 ? `The last ${input.productReferenceCount} reference image(s) are saved product views: preserve only the same product's reference-supported visible construction and real markings, without importing their background, studio lighting or depth of field, or adding product copies. The approved shot's product-visibility rule remains authoritative.` : "",
      categoryGuidance ? `CATEGORY_REPAIR_CONTEXT: ${JSON.stringify({ category: categoryGuidance.category, label: categoryGuidance.label, evidenceLimits: categoryGuidance.evidenceLimits })}\nUse this evidence boundary only for the already visible product. Do not stage a new action, expose a hidden component, add a person or product, or change framing to illustrate an example.` : "",
      personVisible && tidewe.presenter ? `Frozen presenter: ${tidewePresenterAnchor(tidewe.presenter)}. Preserve this identity; do not introduce another presenter.` : "",
      !personVisible ? "This approved shot has no visible person. Do not add a presenter, face, hands or bystanders." : "",
      !productVisible ? "This approved shot is environmental or contextual; do not add the product or brand markings." : "",
      notes ? `Additional defect report and repair request (specific defect corrections take priority over copying erroneous local source details; preserve identity, framing and product/presenter policy): ${JSON.stringify(notes)}` : "",
      "Server-owned identity, product, visibility and scene-geometry policies remain mandatory. Within those boundaries, the requested optical corrections take priority over reproducing source blur and edge artifacts. Freeze one existing instant. No new text, subtitles, sales graphics, prices, watermarks or invented logos; retain only real reference-supported markings. No thermal imaging, glowing heated zones, cutaways, invented mechanisms, performance demonstrations or standalone battery. Return the repaired image only, with no grid, border, comparison panel, annotations, action stages or dialogue text.",
    ].filter(Boolean).join("\n\n");
  }
  return [
    KEYFRAME_REFINEMENT_MARKER,
    "Edit and regenerate ONE high-resolution still keyframe from reference image 1. Image 1 is the cropped single-shot storyboard frame and is the primary scene and composition anchor. Its defective anatomy or object geometry is not a correctness reference. This is an image repair, not a new scene or a contact sheet.",
    "If people are already visible, preserve their identity, face, age, hair, clothing and body build. Do not add people to an unpopulated frame. Preserve camera position, framing, overall action intent, scene layout, background content and geometry, light direction, time of day and color palette. Preserving background content does not require reproducing defective blur or cutout edges when focus or integration repair is requested below. Preserve physically plausible poses outside the regions identified for repair. Make the smallest sufficient visual changes to actually correct the reported defects; source similarity must not preserve an identified defect. Preserve continuity with neighboring storyboard shots. Return one clean full-frame image with no grid, border, comparison panel or annotations.",
    repairHumanStructure ? "LOCAL ANATOMY REPAIR PRIORITY: within the hands or body regions selected for repair, anatomical correctness takes precedence over copying the source's local pose. You may reconstruct the wrist and adjacent forearm together with the defective hand, adjusting rotation, palm-facing direction and thumb placement as needed while keeping the overall action and composition. Use the connected body to infer handedness; do not assume that image-left equals the person's left. Do not force every palm to face the camera. Repair only actual visible errors; if the report identifies one hand, preserve the other physically plausible hand." : "Preserve the existing body pose and gestures except for local changes explicitly required by the defect report. Do not alter healthy anatomy for a clarity or product-only repair.",
    "The issues below describe defects to remove, not desired objects or composition. Do not reproduce or label those defects. Keep naturally occluded body parts hidden, retain the source crop, and never force a full body or extra limbs into a partial-body frame. Freeze one instant; do not draw multiple action stages, motion trails or spoken words. Local pose corrections required for a repair are allowed; unrelated new actions are not.",
    input.hasPresenterReference ? `Reference image 2 is the ${tidewe ? "frozen" : "saved"} presenter identity reference only: use it to preserve facial identity and body build, without importing its background, panel layout, depth of field or clothing over the scene anchor. Render the person within the scene's shared light and focus, not as a separately sharpened pasted portrait.` : "",
    input.productReferenceCount > 0 ? `The last ${input.productReferenceCount} reference image(s) are saved product views: use them only to correct the same product's visible construction and markings, without importing their background, studio lighting or depth of field, or adding extra product copies. Render the product with the scene's shared exposure, texture and contact shadows.` : "",
    ...input.issues.filter((issue) => issue !== "integration").map((issue) => repairInstructions[issue]),
    repairSpatialIntegration ? repairInstructions.integration : "",
    notes ? `Additional defect report and repair request (specific defect corrections take priority over copying erroneous local source details; preserve identity, framing and product/presenter policy): ${JSON.stringify(notes)}` : "",
    tidewe ? [
      "TIDEWE outdoor photographic demonstration. Preserve the real outdoor setting, realistic materials and the source frame's static moment.",
      TIDEWE_PHOTOGRAPHIC_POLICY,
      categoryGuidance ? `CATEGORY_REPAIR_CONTEXT: ${JSON.stringify({ category: categoryGuidance.category, label: categoryGuidance.label, contactAndFocus: categoryGuidance.contactAndFocus, evidenceLimits: categoryGuidance.evidenceLimits })}\nUse this category context only for already visible, reference-supported surfaces and contacts. Do not stage a new action, expose a hidden component, add a person or product, or change the approved framing to illustrate an example.` : "",
      "Apply this photographic baseline while preserving the source's plausible light, time of day, framing and background content. Existing excessive blur in the foreground, midground or background, cutout edges or a mismatch in subject/environment detail are optical defects, not protected background content. Restore readable scene structures with at most slight distant softness; do not relight the whole scene or replace its background during an unrelated hand or product repair.",
      personVisible && tidewe.presenter ? `Frozen presenter: ${tidewePresenterAnchor(tidewe.presenter)}. Preserve this identity; do not introduce another presenter.` : "",
      !personVisible ? "This approved shot has no visible person. Do not add a presenter, face, hands or bystanders." : "",
      !productVisible ? "This approved shot is environmental or contextual; do not add the product or brand markings." : "",
      "No new on-screen text, subtitles, sales graphics, prices, watermarks or invented logos. Keep only real markings visible in the product references. No thermal imaging, glowing heated zones, cutaways, invented mechanisms, performance demonstrations or standalone battery. A native-speech keyframe may have a natural visible mouth, but never draw dialogue, lip sequences or captions.",
    ].filter(Boolean).join("\n") : "",
    premiumCg ? PREMIUM_CG_IMAGE_POLICY : "",
    "Before returning the image, check the requested repairs in their body or object context. For a hand repair, check arm-to-wrist continuity, palm/back orientation, thumb side and finger articulation; sharper texture alone does not satisfy the repair. Return the repaired image only. Preserve unreported, physically plausible details and the intended number of people and objects. Server-owned identity and product policies remain mandatory; within a reported defective region, correcting the defect takes priority over reproducing its source geometry or local pose.",
    repairSpatialIntegration ? "Final focus check: at every shot scale, inspect ALL existing foreground from the bottom edge to the subject, including isolated nearer objects disconnected from the support. Remove any foreground blur band, bokeh or top-and-bottom tilt-shift blur; keep the product, contact and nearby support naturally resolved. Existing midground and farther structures remain recognizable. Slight natural softness is allowed only in distant background BEHIND the subject. Do not add scenery or move the camera to satisfy this check. Do not simulate focus repair with global sharpening or a smeared subject." : "",
  ].filter(Boolean).join("\n\n");
}
