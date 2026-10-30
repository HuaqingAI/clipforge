import { describe, expect, it } from "vitest";
import type { Shot } from "@/lib/db/schema";
import { parseTideweCopyBeats, parseTideweVisualPlan, assertTidewePlanQuality, getTideweProductCoverageIssues, assertTideweProductCoverage } from "@/lib/tidewe/planning-quality";
import { assertTideweGeneratedShotCount, assertTideweScript, productFactsHash, TideweValidationError } from "@/lib/tidewe/validation";
import { TIDEWE_COMPILER_VERSION, TIDEWE_CORPUS_VERSION, type ProductFacts, type TideweCopyBeat, type TideweVisualPlan } from "@/lib/tidewe/types";

const facts: ProductFacts = { version: 1, brand: "TIDEWE", category: "hunting_chair", items: [
  { id: "seat", key: "seat", value: "Padded seat", status: "confirmed", source: { kind: "manual", ref: "manual" } },
  { id: "camo", key: "color", value: "Camo", status: "observed", source: { kind: "uploaded_image", ref: "photo" } },
  { id: "runtime-a", key: "runtime", value: "4 hours", status: "confirmed", source: { kind: "manual", ref: "sheet-a" } },
  { id: "runtime-b", key: "runtime", value: "8 hours", status: "confirmed", source: { kind: "manual", ref: "sheet-b" } },
] };
const visualPlan: TideweVisualPlan = { framing: "medium", visualRole: "demonstration", productFocus: "座垫边缘与手掌的实际接触", actionStart: "手掌已搭在座垫边缘", action: "轻压座垫一次", actionEnd: "松手后保持原位" };
function makeShot(shotId: number, plan: Partial<TideweVisualPlan> = {}, overrides: Partial<Shot> = {}): Shot {
  return { shotId, type: "demo", duration: 5, description: "林边展示椅子。", camera: "固定中景", visualIntent: "展示自然使用", prompt: "自然光下林边展示", visualSource: "ai_generate", transition: "direct_concat", voiceover: "Check the fit.",
    tidewe: { copySpan: { start: 0, end: 14 }, translation: "核对尺寸。", shotGoal: `呈现第${shotId}处产品细节`, productVisible: true, personVisible: true, factRefs: [], sceneId: "woods", visualPlan: { ...visualPlan, ...plan } }, ...overrides };
}
const beat = (text: string): TideweCopyBeat => ({ text, visualRole: "detail", visualIdea: "近景轻压真实座垫边缘", factRefs: ["seat"] });

describe("AI copy evidence beats", () => {
  it("preserves complete ordered prose, repeated lines and UTF-16 characters while binding current evidence", () => {
    const text = "Check it. 🌲\r\n\r\nCheck it. Then compare the fit.";
    const values = [beat("Check it. 🌲"), beat("Check it."), { ...beat("Then compare the fit."), visualRole: "presenter", factRefs: [] }];
    const before = structuredClone(values);
    expect(parseTideweCopyBeats(values, text, facts)).toEqual(values);
    expect(values).toEqual(before);
  });
  it.each([
    ["omitted ending", [beat("Check it.")]],
    ["rewritten words", [beat("Check this. Then compare the fit.")]],
    ["reordered words", [beat("Then compare the fit."), beat("Check it.")]],
    ["duplicated words", [beat("Check it."), beat("Check it."), beat("Then compare the fit.")]],
  ])("rejects %s rather than silently changing frozen copy", (_label, values) => {
    expect(() => parseTideweCopyBeats(values, "Check it. Then compare the fit.", facts)).toThrow(/complete frozen narration verbatim and in order/);
  });
  it.each(["camo", "runtime-a", "missing"])("rejects unverified or conflicting fact citation %s", (factRef) => {
    expect(() => parseTideweCopyBeats([{ ...beat("Check it."), factRefs: [factRef] }], "Check it.", facts)).toThrow(/confirmed, nonconflicting/);
  });
  it.each([undefined, [], [{ ...beat("Check it."), visualRole: "film" }], [{ ...beat("Check it."), visualIdea: "Show the seat" }], [{ ...beat("Check it."), factRefs: "seat" }]])("rejects incomplete copy planning metadata", (values) => {
    expect(() => parseTideweCopyBeats(values, "Check it.", facts)).toThrow(TideweValidationError);
  });
});

describe("structured first-frame and action plans", () => {
  it("retains an explicit start, modest action and stable ending without altering the input", () => {
    const value = { ...visualPlan, action: "  轻压座垫一次  ", ignored: "extra output" };
    expect(parseTideweVisualPlan(value)).toEqual(visualPlan);
    expect(value.action).toBe("  轻压座垫一次  ");
  });
  it.each([
    undefined, {}, { ...visualPlan, framing: "cinematic" }, { ...visualPlan, visualRole: "random" },
    { ...visualPlan, actionStart: "" }, { ...visualPlan, action: "Press once" },
    { ...visualPlan, actionEnd: "长".repeat(241) },
    { ...visualPlan, productFocus: "" }, { ...visualPlan, productFocus: "Seat seam" },
    { ...visualPlan, productFocus: "长".repeat(241) },
  ])("rejects missing or unusable first-frame/action metadata", (value) => {
    expect(() => parseTideweVisualPlan(value)).toThrow(TideweValidationError);
  });
  it("parses optional product focus without requiring new metadata on historical plans", () => {
    const legacyPlan = { ...visualPlan };
    delete legacyPlan.productFocus;
    expect(parseTideweVisualPlan(legacyPlan)).toEqual(legacyPlan);
    expect(parseTideweVisualPlan({ ...visualPlan, productFocus: "  真实座垫缝线  " }).productFocus).toBe("真实座垫缝线");
  });
});

function fiveShotProductPlan(): Shot[] {
  const shots = [
    makeShot(1),
    makeShot(2, { framing: "detail", visualRole: "detail", productFocus: "座垫表面的可见缝线", actionStart: "镜头已对准座垫表面", action: "静态观察既有缝线", actionEnd: "保持缝线的稳定构图" }),
    makeShot(3, { framing: "wide", visualRole: "context", actionStart: "林间道路已完整入画", action: "静态观察林边小径", actionEnd: "保持原有环境构图" }),
    makeShot(4, { visualRole: "presenter", productFocus: "人物身旁完整入画的椅子", actionStart: "人物站在椅子旁", action: "向拍摄同伴点头说明", actionEnd: "目光停在镜头方向" }),
    makeShot(5, { framing: "wide", visualRole: "context", actionStart: "树林与地面层次已入画", action: "观察微风下的树叶", actionEnd: "保持树林全景" }),
  ];
  for (const index of [2, 4]) {
    shots[index].tidewe!.productVisible = false;
    shots[index].tidewe!.personVisible = false;
    delete shots[index].tidewe!.visualPlan!.productFocus;
  }
  return shots;
}

describe("shared product coverage for generation, grid and review", () => {
  const strict = { requireEvidence: true, videoMode: "scene_demo" as const };
  const codes = (shots: Shot[], options = strict) => getTideweProductCoverageIssues(shots, options).map(issue => issue.code);

  it("rejects a real five-shot people/environment plan with no product even in historical mode", () => {
    const shots = fiveShotProductPlan();
    shots.forEach(shot => {
      shot.tidewe!.productVisible = false;
      shot.tidewe!.visualPlan!.visualRole = shot.tidewe!.personVisible ? "presenter" : "context";
    });
    expect(codes(shots)).toEqual(expect.arrayContaining(["PRODUCT_NOT_VISIBLE", "PRODUCT_COVERAGE_LOW", "PRODUCT_DETAIL_MISSING", "PRODUCT_USE_MISSING"]));
    expect(getTideweProductCoverageIssues(shots).map(issue => issue.code)).toEqual(["PRODUCT_NOT_VISIBLE"]);
    expect(() => assertTidewePlanQuality(shots, { videoMode: "scene_demo" })).toThrow(/show the current product/);
  });

  it("accepts an honest five-shot product plan without forcing nine shots or performance facts", () => {
    const shots = fiveShotProductPlan();
    const before = structuredClone(shots);
    expect(getTideweProductCoverageIssues(shots, strict)).toEqual([]);
    expect(() => assertTideweProductCoverage(shots, strict)).not.toThrow();
    expect(() => assertTidewePlanQuality(shots, { videoMode: "scene_demo", targetDuration: 40 })).not.toThrow();
    expect(shots).toEqual(before);
    const observedOnly: ProductFacts = { version: 1, brand: "TIDEWE", category: "hunting_chair", items: [facts.items[1]] };
    expect(parseTideweCopyBeats([{ ...beat("Look at the visible seam."), visualIdea: "观察参考图片里直接可见的座垫缝线", factRefs: [] }], "Look at the visible seam.", observedOnly)).toHaveLength(1);
    expect(shots.every(shot => shot.tidewe!.factRefs.length === 0)).toBe(true);
  });

  it("counts required product shots using ceiling and requires an actual close product detail", () => {
    const shots = fiveShotProductPlan();
    shots[3].tidewe!.productVisible = false;
    expect(codes(shots)).toContain("PRODUCT_COVERAGE_LOW");
    shots[3].tidewe!.productVisible = true;
    shots[1].tidewe!.visualPlan!.framing = "medium";
    expect(codes(shots)).toContain("PRODUCT_DETAIL_MISSING");
    shots[1].tidewe!.visualPlan!.framing = "close_up";
    expect(codes(shots)).toEqual([]);
    expect(codes([shots[0], shots[1], shots[2], shots[4]])).toEqual([]);
  });

  it("requires shared person/product demonstration for scene use but not product_closeup", () => {
    const shots = fiveShotProductPlan();
    shots[0].tidewe!.personVisible = false;
    expect(codes(shots)).toContain("PRODUCT_USE_MISSING");
    expect(getTideweProductCoverageIssues(shots, { requireEvidence: true, videoMode: "product_closeup" })).toEqual([]);
    shots[0].tidewe!.personVisible = true;
    shots[0].tidewe!.visualPlan!.visualRole = "presenter";
    expect(codes(shots)).toContain("PRODUCT_USE_MISSING");
  });

  it.each(["detail", "demonstration"] as const)("rejects a known %s role that hides the product", visualRole => {
    const shot = makeShot(12, { visualRole });
    shot.tidewe!.productVisible = false;
    const issues = getTideweProductCoverageIssues([makeShot(1), shot]);
    expect(issues).toEqual([expect.objectContaining({ code: "PRODUCT_ROLE_WITHOUT_PRODUCT", shotId: 12 })]);
  });

  it("requires bounded Chinese productFocus on fresh product-visible shots only", () => {
    const shots = fiveShotProductPlan();
    delete shots[0].tidewe!.visualPlan!.productFocus;
    expect(getTideweProductCoverageIssues(shots, strict)).toEqual([expect.objectContaining({ code: "PRODUCT_FOCUS_MISSING", shotId: 1 })]);
    expect(() => assertTidewePlanQuality(shots)).toThrow(/Shot 1 must name the visible current-product/);
    expect(getTideweProductCoverageIssues(shots)).toEqual([]);
  });

  it("keeps strict product requirements after a manual edit removes structured shot intent", () => {
    const shots = fiveShotProductPlan();
    delete shots[1].tidewe!.visualPlan;
    expect(codes(shots)).toEqual(expect.arrayContaining(["PRODUCT_FOCUS_MISSING", "PRODUCT_DETAIL_MISSING"]));
    delete shots[0].tidewe!.visualPlan;
    expect(codes(shots)).toEqual(expect.arrayContaining(["PRODUCT_FOCUS_MISSING", "PRODUCT_DETAIL_MISSING", "PRODUCT_USE_MISSING"]));
  });

  it("preserves a frozen detail beat instead of erasing it into a talking presenter", () => {
    const text = "Look at the seam. Then compare the fit.";
    const visualBeats: TideweCopyBeat[] = [
      { ...beat("Look at the seam."), visualRole: "detail", factRefs: [] },
      { text: "Then compare the fit.", visualRole: "presenter", visualIdea: "主播在椅子旁说明选购问题", factRefs: [] },
    ];
    const shots = [makeShot(1, { visualRole: "presenter" }), makeShot(2, { framing: "detail", visualRole: "detail" })];
    const seamEnd = text.indexOf(" Then");
    shots[0].tidewe!.copySpan = { start: 0, end: seamEnd };
    shots[1].tidewe!.copySpan = { start: seamEnd + 1, end: text.length };
    const options = { requireEvidence: true, copyDocument: { text, visualBeats } };
    expect(getTideweProductCoverageIssues(shots, options)).toEqual([expect.objectContaining({ code: "COPY_BEAT_PRODUCT_EVIDENCE_MISSING", message: expect.stringContaining("beat 1 (detail)") })]);
    shots[0].tidewe!.visualPlan!.visualRole = "detail";
    expect(getTideweProductCoverageIssues(shots, options)).toEqual([]);
    shots[0].tidewe!.productVisible = false;
    expect(getTideweProductCoverageIssues(shots, options).map(issue => issue.code)).toContain("COPY_BEAT_PRODUCT_EVIDENCE_MISSING");
  });

  it("maps repeated copy, paragraphs and UTF-16 spans in order and permits split/merged beats", () => {
    const text = "Check it. 🌲\r\n\r\nCheck it. Then inspect the seam.";
    const visualBeats: TideweCopyBeat[] = [
      { ...beat("Check it. 🌲"), visualRole: "presenter", factRefs: [] },
      { ...beat("Check it."), visualRole: "demonstration", factRefs: [] },
      { ...beat("Then inspect the seam."), visualRole: "detail", factRefs: [] },
    ];
    const first = makeShot(1, { visualRole: "demonstration" });
    const detailA = makeShot(2, { framing: "close_up", visualRole: "detail" });
    const detailB = makeShot(3, { framing: "detail", visualRole: "detail" });
    const detailStart = text.indexOf("Then");
    first.tidewe!.copySpan = { start: 0, end: detailStart - 1 };
    detailA.tidewe!.copySpan = { start: detailStart, end: text.indexOf("the seam") };
    detailB.tidewe!.copySpan = { start: detailA.tidewe!.copySpan.end, end: text.length };
    const options = { ...strict, copyDocument: { text, visualBeats } };
    expect(getTideweProductCoverageIssues([first, detailA, detailB], options)).toEqual([]);
    // A role attached to the first repeated phrase cannot satisfy the later repeat.
    first.tidewe!.copySpan.end = "Check it. 🌲".length;
    expect(getTideweProductCoverageIssues([first, detailA, detailB], options).map(issue => issue.code)).toContain("COPY_BEAT_PRODUCT_EVIDENCE_MISSING");
  });

  it("requires positive overlap and reports malformed complete-copy beat mapping", () => {
    const text = "Check it. Inspect the seam.";
    const copyDocument = { text, visualBeats: [{ ...beat("Check it."), visualRole: "presenter" as const }, { ...beat("Inspect the seam."), factRefs: [] }] };
    const shot = makeShot(1, { framing: "detail", visualRole: "detail" });
    shot.tidewe!.copySpan = { start: 0, end: text.indexOf("Inspect") };
    expect(getTideweProductCoverageIssues([shot], { copyDocument }).map(issue => issue.code)).toContain("COPY_BEAT_PRODUCT_EVIDENCE_MISSING");
    expect(getTideweProductCoverageIssues([shot], { copyDocument: { text, visualBeats: [copyDocument.visualBeats[1]] } }).map(issue => issue.code)).toEqual(["COPY_BEAT_SPANS_INVALID"]);
  });

  it("keeps absent historical plans optional while checking any decidable beat gap", () => {
    const shot = makeShot(1);
    delete shot.tidewe!.visualPlan;
    expect(getTideweProductCoverageIssues([shot])).toEqual([]);
    const text = "Check the fit.";
    const copyDocument = { text, visualBeats: [{ ...beat(text), factRefs: [] }] };
    expect(getTideweProductCoverageIssues([shot], { copyDocument })).toEqual([]);
    expect(getTideweProductCoverageIssues([shot], { copyDocument, requireEvidence: true }).map(issue => issue.code)).toEqual(expect.arrayContaining(["PRODUCT_FOCUS_MISSING", "COPY_BEAT_PRODUCT_EVIDENCE_MISSING"]));
    shot.tidewe!.productVisible = false;
    expect(getTideweProductCoverageIssues([shot], { copyDocument }).map(issue => issue.code)).toEqual(["PRODUCT_NOT_VISIBLE", "COPY_BEAT_PRODUCT_EVIDENCE_MISSING"]);
  });
});

describe("new storyboard quality within the existing planner repair", () => {
  it.each([7, 8, 9])("accepts the generated-shot count boundary %i", count => {
    expect(() => assertTideweGeneratedShotCount(count)).not.toThrow();
  });
  it.each([0, 1, 6, 10, 30, 7.5, NaN, Infinity])("rejects invalid generated-shot count %s with the affected copy", count => {
    expect(() => assertTideweGeneratedShotCount(count, 2)).toThrow(/TIDEWE copy 3 must contain 7-9 shots/);
  });
  it("checks actual words plus a pause and names the shot that needs a timing repair", () => {
    const voiceover = "Check the fit before you choose the gear for tomorrow.";
    const minimum = 10 / 2.6 + 0.3;
    expect(() => assertTidewePlanQuality([makeShot(8, {}, { voiceover, duration: 3 })])).toThrow(/Shot 8 needs at least 4.2s/);
    expect(() => assertTidewePlanQuality([makeShot(8, {}, { voiceover, duration: minimum })])).not.toThrow();
    expect(() => assertTidewePlanQuality([makeShot(8, {}, { voiceover: "", duration: 1 })])).not.toThrow();
  });
  it("keeps historical quality review count-compatible while new generation rejects short or oversized plans", () => {
    expect(() => assertTidewePlanQuality([makeShot(1)], { targetDuration: 40 })).not.toThrow();
    expect(() => assertTideweGeneratedShotCount(1)).toThrow(/7-9 shots/);
    const scales = ["wide", "medium", "close_up", "detail"] as const;
    const shots = Array.from({ length: 12 }, (_, index) => makeShot(index + 1, { framing: scales[index % scales.length], visualRole: index % 2 ? "detail" : "demonstration" }));
    expect(() => assertTidewePlanQuality(shots, { targetDuration: 60, source: "ai_generated" })).not.toThrow();
    expect(() => assertTideweGeneratedShotCount(shots.length)).toThrow(/7-9 shots/);
  });
  it("requires varied framing and visual purpose in substantial plans", () => {
    const shots = Array.from({ length: 7 }, (_, index) => makeShot(index + 1));
    expect(() => assertTidewePlanQuality(shots)).toThrow(/three framing scales/);
    const scales = ["wide", "medium", "close_up"] as const;
    const variedScales = shots.map((shot, index) => ({ ...shot, tidewe: { ...shot.tidewe!, visualPlan: { ...visualPlan, framing: scales[index % scales.length] } } }));
    expect(() => assertTidewePlanQuality(variedScales)).toThrow(/at least two visual roles/);
    variedScales[2].tidewe!.visualPlan!.visualRole = "detail";
    expect(() => assertTidewePlanQuality(variedScales)).not.toThrow();
  });
  it("detects three repeated visual tasks despite punctuation and whitespace changes", () => {
    const shots = [makeShot(3), makeShot(4), makeShot(5), makeShot(6, { framing: "detail", visualRole: "detail" })];
    shots.slice(0, 3).forEach((shot, index) => {
      shot.tidewe!.shotGoal = ["展示座垫支撑。", "展示 座垫支撑！", "展示座垫支撑"][index];
      shot.tidewe!.visualPlan!.action = ["轻压座垫一次。", "轻压 座垫一次！", "轻压座垫一次"][index];
    });
    expect(() => assertTidewePlanQuality(shots)).toThrow(/Shots 3, 4 and 5 repeat/);
    shots[1].tidewe!.visualPlan!.action = "指向真实座垫缝线";
    expect(() => assertTidewePlanQuality(shots)).not.toThrow();
  });
  it("allows two similar tasks and recurring tasks separated by another useful view", () => {
    const same = () => makeShot(1, {}, { tidewe: { ...makeShot(1).tidewe!, shotGoal: "展示座垫支撑" } });
    expect(() => assertTidewePlanQuality([same(), same()])).not.toThrow();
    expect(() => assertTidewePlanQuality([same(), makeShot(2, { framing: "wide", visualRole: "context" }), same(), makeShot(3, { framing: "detail", visualRole: "detail" })])).not.toThrow();
  });
  it("limits AI timing drift while preserving authoritative imported copy length", () => {
    const longShot = makeShot(1, {}, { duration: 40 });
    expect(() => assertTidewePlanQuality([longShot], { targetDuration: 30, source: "ai_generated" })).toThrow(/exceeding 39.5s/);
    expect(() => assertTidewePlanQuality([longShot], { targetDuration: 30, source: "user_provided" })).not.toThrow();
    expect(longShot.voiceover).toBe("Check the fit.");
  });
  it("requires off-camera narration only for framing that excludes a speaking face", () => {
    const detail = makeShot(7, { framing: "detail", visualRole: "detail" });
    detail.tidewe!.speechDelivery = "on_camera";
    expect(() => assertTidewePlanQuality([detail])).toThrow(/Shot 7 has on_camera speech in detail framing/);
    detail.tidewe!.speechDelivery = "off_camera";
    expect(() => assertTidewePlanQuality([detail])).not.toThrow();
    const context = makeShot(9, { framing: "wide", visualRole: "context" });
    context.tidewe!.speechDelivery = "on_camera";
    expect(() => assertTidewePlanQuality([context])).not.toThrow();
    detail.voiceover = "";
    detail.tidewe!.speechDelivery = "on_camera";
    expect(() => assertTidewePlanQuality([detail])).not.toThrow();
  });
  it("reports absent new metadata without imposing it on historical script invariants", () => {
    const legacy = makeShot(1);
    delete legacy.tidewe!.visualPlan;
    const text = legacy.voiceover;
    const copyDocument = { version: 1 as const, language: "en-US" as const, text, translation: "核对尺寸。", angle: "fit", hookType: "question", claimedFactIds: [], factsSnapshot: facts, factsHash: productFactsHash(facts), corpusVersion: TIDEWE_CORPUS_VERSION, compilerVersion: TIDEWE_COMPILER_VERSION, exampleIds: [], wordCount: 3, estimatedDuration: 5 };
    expect(() => assertTideweScript({ shots: [legacy], copyDocument })).not.toThrow();
    expect(() => assertTidewePlanQuality([legacy])).toThrow(/Shot 1: Each new shot requires visualPlan/);
  });
});
