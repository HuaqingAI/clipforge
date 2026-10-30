// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Shot } from "@/lib/db/schema";
import { createPremiumProductCgProfile, createTideweOutdoorProfile } from "@/lib/creative-profiles";
import { buildKeyframeRefinementPrompt, KEYFRAME_SPATIAL_INTEGRATION_POLICY } from "@/lib/keyframe-refinement-prompt";
import { PREMIUM_CG_IMAGE_POLICY } from "@/lib/premium-cg-prompt";
import { TIDEWE_IMAGE_FOCUS_TARGET, TIDEWE_PHOTOGRAPHIC_POLICY } from "@/lib/tidewe/visual-policy";

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

describe("spatial integration and natural depth", () => {
  it("repairs excessive blur at any depth without notes or changes to healthy anatomy, identity or scene content", () => {
    const input = { ...shot, description: "猎人穿着狩猎靴站在落叶地面，远处树林自然柔化。", camera: "全身" };
    const before = structuredClone(input);
    const result = prompt({ shot: input, issues: ["integration"] });
    expect(result).toContain(KEYFRAME_SPATIAL_INTEGRATION_POLICY);
    expect(result).toContain("If the source already has excessive blur at any distance or subject-background separation, correct that optical defect");
    expect(result).toContain("Preserving background content does not require reproducing defective blur or cutout edges");
    expect(result).toContain("retaining the existing background content, layout, perspective, lighting and color");
    expect(result).toContain("not permission to move the camera, widen the crop, replace the background, add objects or invent fine markings");
    expect(result).toContain("preserve their identity, face, age, hair, clothing and body build");
    expect(result).toContain("Preserve camera position, framing, overall action intent");
    expect(result).toContain("Preserve the existing body pose and gestures");
    expect(result).not.toContain("LOCAL ANATOMY REPAIR PRIORITY");
    expect(result).not.toContain("Additional defect report");
    expect(input).toEqual(before);
  });

  it.each(["hands", "product", "details"] as const)("keeps TIDEWE %s repairs spatially coherent even when integration is not separately selected", (issue) => {
    const result = prompt({ issues: [issue], profile: createTideweOutdoorProfile() });
    expect(result.split(KEYFRAME_SPATIAL_INTEGRATION_POLICY)).toHaveLength(2);
    expect(result).toContain("Keep product contact points and their supporting surfaces clear");
    expect(result).toContain("not stronger sharpening or a blurrier background");
    expect(result).toContain("Existing excessive blur in the foreground, midground or background, cutout edges");
    expect(result).toContain("同一焦平面周边清晰");
    expect(result).toContain("中远景中现有树干分叉、灌木轮廓、道路延伸或其他场景结构仍清楚可辨");
    if (issue === "hands") expect(result).toContain("LOCAL ANATOMY REPAIR PRIORITY");
    if (issue === "details") expect(result).toContain("do not selectively sharpen the person or product and blur the surroundings");
  });

  it("limits slight close-up softness to distant background behind the subject", () => {
    const result = prompt({ issues: ["integration", "details"], profile: createTideweOutdoorProfile() });
    expect(result.split(KEYFRAME_SPATIAL_INTEGRATION_POLICY)).toHaveLength(2);
    expect(result).toContain("In full-body and medium views, use broad depth of field");
    expect(result).toContain("keep existing background structures recognizable at normal viewing size");
    expect(result).toContain("Even the far background may have only slight natural optical softness");
    expect(result).toContain("never broad creamy blur, large bokeh discs or featureless color patches");
    expect(result).toContain("component, touching hand and surrounding surfaces on the same focus plane coherent");
    expect(result).toContain("Only distant background BEHIND the subject may have slight natural optical softness");
    expect(result).toContain("including disconnected nearer objects and frame edges");
    expect(result).toContain("Do not force every distant leaf equally sharp");
    expect(result).toContain("inspect ALL existing foreground from the bottom edge to the subject");
    expect(result).not.toContain("out-of-plane softness on separate objects");
    expect(result).not.toContain("preserve moderate natural distant softness");
    expect(result).not.toContain("only distant scenery may gradually soften");
  });

  it.each([
    { category: "boots", productName: "男士狩猎靴", framing: "close_up" as const, description: "低机位近景，靴子站在落叶地面，地面从画面下沿延伸至靴底接触处。" },
    { category: "apparel", productName: "户外夹克", framing: "detail" as const, description: "低机位特写，手按已有台面上的衣料接缝，台面从画面下沿延伸至衣料接触处。" },
  ])("does not let the $category close-shot exception preserve a blurred bottom supporting surface", ({ category, productName, framing, description }) => {
    const input: Shot = { ...shot, description, camera: "低机位固定近距离拍摄，前景虚化突出商品", tidewe: {
      copySpan: { start: 0, end: 0 }, translation: "", shotGoal: "观察当前商品和支撑的接触", productVisible: true,
      personVisible: true, sceneId: "existing-scene", factRefs: [], visualPlan: {
        framing, visualRole: "detail", productFocus: "参考支持的商品接触部位和已有支撑面",
        actionStart: "商品已与现有支撑面接触", action: "保持静态观察", actionEnd: "接触状态保持稳定",
      },
    } };
    const before = structuredClone(input);
    const result = prompt({ shot: input, issues: ["integration"], profile: createTideweOutdoorProfile(), productCategory: category, productName });
    expect(result).toContain(TIDEWE_IMAGE_FOCUS_TARGET);
    expect(result).toContain("re-render the entire existing photograph with coherent extended depth of field");
    expect(result).toContain("Do not move the camera, widen or crop the image");
    expect(result).toContain("add or extend surfaces");
    expect(result).toContain("Preserve camera position, perspective, framing, crop");
    expect(result).not.toContain("前景虚化突出商品");
    expect(result).not.toContain("Allow only slight physically plausible nearer or farther out-of-plane softness");
    expect(result).not.toContain("焦平面前后只允许轻微合理失焦");
    if (category !== "boots") expect(result).not.toContain("靴底");
    expect(input).toEqual(before);
  });

  it("balances an overcrisp subject without blanket sharpening or invented background texture", () => {
    const result = prompt({ issues: ["integration", "details"], profile: createTideweOutdoorProfile() });
    expect(result).toContain("reduce selective edge enhancement and local microcontrast");
    expect(result).toContain("preserving facial identity and real product texture and markings");
    expect(result).toContain("Do not sharpen the whole background, smear the subject, or invent fine scenery texture");
    expect(result).toContain("Do not simulate focus repair with global sharpening or a smeared subject");
    expect(result).toContain("最远景仅轻微自然失焦");
    expect(result).toContain("不用全图锐化补偿背景虚化");
    expect(result).not.toContain("while preserving distant natural softness");
  });

  it("uses identity and product references without importing portrait or studio optics", () => {
    const result = prompt({ issues: ["integration"] });
    expect(result).toContain("without importing its background, panel layout, depth of field or clothing");
    expect(result).toContain("not as a separately sharpened pasted portrait");
    expect(result).toContain("without importing their background, studio lighting or depth of field");
    expect(result).toContain("scene's shared exposure, texture and contact shadows");
    const withoutRefs = prompt({ issues: ["integration"], hasPresenterReference: false, productReferenceCount: 0 });
    expect(withoutRefs).not.toContain("Reference image 2");
    expect(withoutRefs).not.toContain("saved product views");
    expect(withoutRefs).toContain(KEYFRAME_SPATIAL_INTEGRATION_POLICY);
  });

  it("does not force a focus repair into an unrelated generic or Premium repair", () => {
    for (const profile of [undefined, createPremiumProductCgProfile()]) {
      const result = prompt({ issues: ["hands"], profile });
      expect(result).not.toContain(KEYFRAME_SPATIAL_INTEGRATION_POLICY);
      expect(result).not.toContain("Final focus check:");
      expect(result).not.toContain(TIDEWE_PHOTOGRAPHIC_POLICY);
      expect(result).toContain("LOCAL ANATOMY REPAIR PRIORITY");
    }
  });

  it("keeps a Premium empty backdrop empty when integration is requested", () => {
    const result = prompt({ issues: ["integration"], profile: createPremiumProductCgProfile() });
    expect(result).toContain(KEYFRAME_SPATIAL_INTEGRATION_POLICY);
    expect(result).toContain("Keep intentional empty backgrounds empty");
    expect(result).toContain(PREMIUM_CG_IMAGE_POLICY);
    expect(result).not.toContain(TIDEWE_PHOTOGRAPHIC_POLICY);
    expect(result).not.toContain("TIDEWE outdoor photographic demonstration");
  });
});

describe("single-task TIDEWE focus refinement", () => {
  const presenter = { id: "tom", name: "Tom", appearance: "成年户外主播", referenceImages: ["https://example.test/tom.png"] };
  const profile = createTideweOutdoorProfile({ presenter });

  it("uses one whole-image optical target without injecting unselected repair work", () => {
    const result = prompt({ issues: ["integration"], profile });
    expect(result.startsWith("[keyframe-refine-v1]")).toBe(true);
    expect(result).toContain("SINGLE FOCUS TASK: re-render the entire existing photograph");
    expect(result.split(TIDEWE_IMAGE_FOCUS_TARGET)).toHaveLength(2);
    expect(result).not.toContain(KEYFRAME_SPATIAL_INTEGRATION_POLICY);
    expect(result).not.toContain(TIDEWE_PHOTOGRAPHIC_POLICY);
    for (const unrelatedTask of ["LOCAL ANATOMY REPAIR PRIORITY", "Reconstruct each visibly defective hand", "Correct visible anatomical discontinuities", "Remove accidental duplicate objects", "Repair warped product geometry", "check arm-to-wrist continuity"]) {
      expect(result).not.toContain(unrelatedTask);
    }
  });

  it("locks scene geometry and real identity while allowing source optical rendering to change", () => {
    const instructions = "Make the existing lower support readable; keep the pose and the evening scene.";
    const result = prompt({ issues: ["integration"], profile, instructions });
    expect(result).toContain("Image 1 is the cropped approved single-shot scene");
    expect(result).toContain("identity, face, age, hair, clothing and body build");
    expect(result).toContain("real silhouette, proportions, material, color, construction and markings");
    expect(result).toContain("Keep existing positions, poses, gestures, object counts, contact, occlusion, scene geometry and background content");
    expect(result).toContain("Preserve camera position, perspective, framing, crop, light direction, time of day and color palette");
    expect(result).toContain("Do not move the camera, widen or crop the image, replace the setting, add or extend surfaces, add objects, or change the time of day");
    expect(result).toContain("source blur, cutout edges, sharpening halos and excessive subject microcontrast are defects to correct, not protected pixel attributes");
    expect(result).toContain("source similarity must not preserve those optical defects");
    expect(result).toContain(JSON.stringify(instructions));
    expect(result).toContain("specific defect corrections take priority over copying erroneous local source details");
    expect(result).toContain("Server-owned identity, product, visibility and scene-geometry policies remain mandatory");
    expect(result).toContain("the requested optical corrections take priority over reproducing source blur and edge artifacts");
    expect(result).toContain("with no grid, border, comparison panel, annotations, action stages or dialogue text");
  });

  it("separates all six reference roles from scene optics without requesting product reconstruction", () => {
    const result = prompt({ issues: ["integration"], profile, productReferenceCount: 4 });
    expect(result).toContain("Reference image 2 is the frozen presenter identity reference only");
    expect(result).toContain("without importing its background, panel layout, depth of field or clothing over image 1");
    expect(result).toContain("The last 4 reference image(s) are saved product views");
    expect(result).toContain("reference-supported visible construction and real markings");
    expect(result).toContain("without importing their background, studio lighting or depth of field, or adding product copies");
    expect(result).toContain("Frozen presenter: 所选主播 Tom（成年户外主播）");
    expect(result).toContain("No thermal imaging, glowing heated zones, cutaways, invented mechanisms");
    const noRefs = prompt({ issues: ["integration"], profile: createTideweOutdoorProfile(), hasPresenterReference: false, productReferenceCount: 0 });
    expect(noRefs).not.toContain("Reference image 2");
    expect(noRefs).not.toContain("saved product views");
    expect(noRefs).toContain(TIDEWE_IMAGE_FOCUS_TARGET);
  });

  it("keeps person-free and product-free shots empty despite supplied references", () => {
    const emptyShot: Shot = { ...shot, tidewe: {
      copySpan: { start: 0, end: 0 }, translation: "", shotGoal: "环境", productVisible: false,
      personVisible: false, sceneId: "woods", factRefs: [],
    } };
    const result = prompt({ shot: emptyShot, issues: ["integration"], profile, productCategory: "boots" });
    expect(result).toContain("Do not add a presenter, face, hands or bystanders");
    expect(result).toContain("do not add the product or brand markings");
    expect(result).toContain("person-visibility rule remains authoritative");
    expect(result).toContain("product-visibility rule remains authoritative");
    expect(result).toContain("Keep intentional empty backgrounds empty");
    expect(result).not.toContain("Frozen presenter:");
    expect(result).not.toContain("CATEGORY_REPAIR_CONTEXT:");
  });

  it("retains category evidence limits without adding a second focus policy or a staged example", () => {
    const result = prompt({ issues: ["integration"], profile, productCategory: "heated_gear", productName: "加热坐垫" });
    const context = JSON.parse(result.split("CATEGORY_REPAIR_CONTEXT: ")[1].split("\n")[0]);
    expect(context).toMatchObject({ category: "heated_gear", label: "加热装备", evidenceLimits: expect.stringContaining("不默认加热区、温度、档位、续航或附送电池") });
    expect(Object.keys(context).sort()).toEqual(["category", "evidenceLimits", "label"]);
    expect(result).toContain("Do not stage a new action, expose a hidden component");
    expect(result).not.toContain("椅脚");
  });

  it("keeps mixed repairs on the full policy branch and substantially shortens a focus-only task", () => {
    const common = { profile, productCategory: "boots", productName: "男士狩猎靴", productReferenceCount: 4 };
    const compact = prompt({ ...common, issues: ["integration"] });
    const combined = prompt({ ...common, issues: ["integration", "details"] });
    expect(combined).toContain(KEYFRAME_SPATIAL_INTEGRATION_POLICY);
    expect(combined).toContain(TIDEWE_PHOTOGRAPHIC_POLICY);
    expect(combined).toContain("Recover coherent, naturally resolved detail");
    expect(combined).not.toContain("SINGLE FOCUS TASK:");
    expect(compact.length).toBeLessThan(combined.length * 0.6);
  });
});

describe("category-aware repair context", () => {
  it.each([
    { category: "hunting_blind", productName: "狩猎帐篷", label: "狩猎帐篷", contact: "帐篷底边" },
    { category: "waders", productName: "涉水服", label: "涉水服", contact: "涉水服与身体贴合" },
    { category: "heated_gear", productName: "加热背心", label: "加热装备", contact: "实际产品形态" },
    { category: "apparel", productName: "户外夹克", label: "服装", contact: "衣料随身体受压" },
    { category: "boots", productName: "男士狩猎靴", label: "靴子", contact: "靴底" },
    { category: "accessories", productName: "狩猎椅", label: "配件", contact: "椅脚接地" },
  ])("uses only $label repair contacts without staging a new category example", ({ category, productName, label, contact }) => {
    const result = prompt({ issues: ["integration", "details"], profile: createTideweOutdoorProfile(), productCategory: category, productName });
    const context = JSON.parse(result.split("CATEGORY_REPAIR_CONTEXT: ")[1].split("\n")[0]);
    expect(context).toMatchObject({ category, label, contactAndFocus: expect.stringContaining(contact) });
    expect(context).not.toHaveProperty("visualExamples");
    expect(context).not.toHaveProperty("copyAngles");
    expect(result).toContain("Do not stage a new action, expose a hidden component");
    if (category !== "boots") {
      expect(result).not.toContain("boot soles");
      expect(result).not.toContain("靴筒");
      expect(result).not.toContain("靴底");
    }
  });

  it("keeps category examples out of empty shots and non-TIDEWE repairs", () => {
    const emptyShot: Shot = { ...shot, tidewe: { copySpan: { start: 0, end: 0 }, translation: "", shotGoal: "环境", productVisible: false, personVisible: false, sceneId: "woods", factRefs: [] } };
    expect(prompt({ profile: createTideweOutdoorProfile(), shot: emptyShot, productCategory: "boots" })).not.toContain("CATEGORY_REPAIR_CONTEXT:");
    expect(prompt({ productCategory: "boots" })).not.toContain("CATEGORY_REPAIR_CONTEXT:");
    const unknown = prompt({ profile: createTideweOutdoorProfile() });
    expect(unknown).toContain('"category":"unspecified"');
    expect(unknown).not.toContain("靴筒");
    expect(unknown).not.toContain("椅脚");
  });
});

describe("masked foreground focus repair", () => {
  const focusRegion = { x: 0, y: 0.8, width: 1, height: 0.2 };

  it.each(["boots", "apparel", "accessories", "hunting_blind", "waders", "heated_gear"])("uses a local redraw scope for %s without a competing whole-image task", (productCategory) => {
    const input = { issues: ["integration"] as const, focusRegion, profile: createTideweOutdoorProfile(), productCategory };
    const before = structuredClone(input);
    const result = prompt({ ...input, issues: [...input.issues] });
    expect(result).toContain("REGIONAL FOCUS REPAIR");
    expect(result).toContain(JSON.stringify(focusRegion));
    expect(result).toContain("Transparent pixels designate the selected repair region");
    expect(result).toContain("The mask applies to image 1 only");
    expect(result).toContain("Redraw existing defocused foreground INSIDE this region");
    expect(result).toContain("isolated near objects, grass, leaves, soil or other surfaces only where already present");
    expect(result).toContain("synthesized texture redrawing, not recovery of unseen exact detail");
    expect(result).toContain("Merely sharpening the same blurred patch does not complete the repair");
    expect(result).toContain("does not imply exact pixel preservation outside its boundary");
    expect(result).not.toContain("SINGLE FOCUS TASK");
    expect(result).not.toContain(TIDEWE_IMAGE_FOCUS_TARGET);
    expect(result).not.toContain(KEYFRAME_SPATIAL_INTEGRATION_POLICY);
    expect(result).not.toContain(TIDEWE_PHOTOGRAPHIC_POLICY);
    if (productCategory !== "boots") expect(result).not.toMatch(/靴底|靴筒/);
    expect(input).toEqual(before);
  });

  it("retains person/product absence and frozen scene despite supplied references", () => {
    const empty: Shot = { ...shot, tidewe: { copySpan: { start: 0, end: 0 }, translation: "", shotGoal: "环境", productVisible: false, personVisible: false, sceneId: "existing", factRefs: [] } };
    const result = prompt({ shot: empty, issues: ["integration"], focusRegion, profile: createTideweOutdoorProfile(), productCategory: "boots" });
    expect(result).toContain("Do not add a presenter, face, hands or bystanders");
    expect(result).toContain("do not add the product or brand markings");
    expect(result).not.toContain("CATEGORY_EVIDENCE_BOUNDARY");
    expect(result).toContain("object counts, layout, contacts, light direction, time of day and framing");
    expect(result).toContain("do not request a whole-image focus change, camera move, crop");
  });

  it("preserves Premium product restrictions and strips marketing notes in regional mode", () => {
    const result = prompt({ issues: ["integration"], focusRegion, profile: createPremiumProductCgProfile(), instructions: "Fix existing foreground. Add a price label. Buy now." });
    expect(result).toContain(PREMIUM_CG_IMAGE_POLICY);
    expect(result).toContain("Do not restage it in a studio");
    expect(result).toContain("Fix existing foreground");
    expect(result).not.toContain("Add a price label");
    expect(result).not.toContain("Buy now");
    expect(result).not.toContain(TIDEWE_IMAGE_FOCUS_TARGET);
  });
});

describe("cropped foreground focus repair", () => {
  const focusRegion = { x: 0, y: 0.83, width: 1, height: 0.17 };
  const focusPatch = { width: 938, height: 1677, selection: { x: 0, y: 1391, width: 938, height: 286 }, context: { x: 0, y: 1333, width: 938, height: 344 } };

  it.each([undefined, createTideweOutdoorProfile(), createPremiumProductCgProfile()])("renders only the supplied crop without importing whole-scene focus or extra reference roles", (profile) => {
    const result = prompt({ issues: ["integration"], focusRegion, focusPatch, profile, hasPresenterReference: false, productReferenceCount: 0, productCategory: "boots" });
    expect(result).toContain("CROPPED FOREGROUND FOCUS REPAIR");
    expect(result).toContain("Image 1 is the ONLY reference");
    expect(result).toContain("ENTIRE crop, including all four edges and both bottom corners");
    expect(result).toContain("Redraw blurred texture; merely sharpening the same blur");
    expect(result).toContain("same composition and aspect ratio");
    expect(result).toContain("Preserve any already visible product geometry and real markings");
    expect(result).not.toContain("REGIONAL FOCUS REPAIR:");
    expect(result).not.toContain("SINGLE FOCUS TASK");
    expect(result).not.toContain("Reference image 2");
    expect(result).not.toContain("CATEGORY_");
    expect(result).not.toContain(TIDEWE_PHOTOGRAPHIC_POLICY);
    expect(result).not.toContain(TIDEWE_IMAGE_FOCUS_TARGET);
    expect(result.length).toBeLessThan(1700);
  });

  it("keeps the requested defect report within cropped scope", () => {
    const result = prompt({ issues: ["integration"], focusRegion, focusPatch, instructions: "Resolve the existing bottom-right leaves." });
    expect(result).toContain("Resolve the existing bottom-right leaves");
    expect(result).toContain("apply only to existing content inside this crop");
    expect(result).toContain("not recovered original detail");
    expect(result).toContain("Do not generate a full person, whole product or new scene outside this crop");
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
    expect(result).toContain(TIDEWE_PHOTOGRAPHIC_POLICY);
    expect(result).toContain("do not relight the whole scene or replace its background during an unrelated hand or product repair");
  });

  it("repairs details with natural texture while preserving the approved shot and reference roles", () => {
    const approved: Shot = { ...shot, description: "傍晚林缘，手扶迷彩椅子的靠背。", camera: "产品与手部近景" };
    const result = prompt({ shot: approved, issues: ["details"], profile: createTideweOutdoorProfile({ presenter }), instructions: "Remove sharpening halos on the fabric." });
    expect(result).toContain(TIDEWE_PHOTOGRAPHIC_POLICY);
    expect(result).toContain("do not simulate detail with extra sharpening");
    expect(result).toContain("Preserve camera position, framing, overall action intent");
    expect(result).toContain("use them only to correct the same product's visible construction");
    expect(result).toContain("Frozen presenter: 所选主播 Tom（成年户外主播）");
    expect(approved.description).toBe("傍晚林缘，手扶迷彩椅子的靠背。");
  });

  it("does not let a hand repair add a person or product to an approved empty TIDEWE shot", () => {
    const emptyShot: Shot = { ...shot, tidewe: {
      copySpan: { start: 0, end: 0 }, translation: "", shotGoal: "环境", productVisible: false,
      personVisible: false, sceneId: "blind", factRefs: [],
    } };
    const result = prompt({ shot: emptyShot, profile: createTideweOutdoorProfile({ presenter }), hasPresenterReference: false });
    expect(result).toContain("Do not add a presenter, face, hands or bystanders");
    expect(result).toContain("do not add the product or brand markings");
    expect(result).toContain(KEYFRAME_SPATIAL_INTEGRATION_POLICY);
    expect(result).toContain("Keep intentional empty backgrounds empty");
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
