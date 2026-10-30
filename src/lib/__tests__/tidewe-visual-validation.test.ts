import { describe, expect, it } from "vitest";
import type { Shot } from "@/lib/db/schema";
import { productFactsFromDescription } from "@/lib/tidewe/facts";
import { TIDEWE_COMPILER_VERSION, TIDEWE_CORPUS_VERSION, type TideweCopyDocument } from "@/lib/tidewe/types";
import { assertTideweScript, productFactsHash } from "@/lib/tidewe/validation";

const text = "Check the fit before your next trip.";
const facts = productFactsFromDescription("", "hunting_chair");
const copyDocument: TideweCopyDocument = {
  version: 1, language: "en-US", text, translation: "下次出发前核对是否合适。",
  angle: "practical_choice", hookType: "question", claimedFactIds: [], factsSnapshot: facts,
  factsHash: productFactsHash(facts), corpusVersion: TIDEWE_CORPUS_VERSION,
  compilerVersion: TIDEWE_COMPILER_VERSION, exampleIds: [], wordCount: 8, estimatedDuration: 4,
};
function script(overrides: Partial<Shot> = {}) {
  const shot: Shot = {
    shotId: 1, type: "demo", duration: 5, voiceover: text,
    description: "林边人物自然等待。", camera: "稳定中景", prompt: "林边真实自然光",
    visualIntent: "呈现真实户外使用场景", visualSource: "ai_generate", transition: "direct_concat",
    tidewe: { copySpan: { start: 0, end: text.length }, translation: copyDocument.translation,
      shotGoal: "呈现静候场景", productVisible: true, factRefs: [], sceneId: "woods" },
    ...overrides,
  };
  return { copyDocument, shots: [shot] };
}

describe("TIDEWE visual prohibition intent", () => {
  it.each([
    "低机位观察双靴，前景草叶轻微虚化，主体清晰。",
    "让前景落叶失焦，突出靴筒。",
    "前景散景衬托人物。",
    "将画面下沿虚化，保留产品清楚。",
    "虚化前景以突出人物。",
    "林边自然光，softly blurred foreground leaves frame the boots。",
    "林边自然光，foreground bokeh isolates the product。",
    "林边自然光，foreground leaves are slightly out of focus。",
    "林边自然光，defocus the foreground。",
    "不使用前景虚化，随后添加 foreground blur。",
    "禁止前景散景；接着虚化前景。",
    "不是不让前景虚化。",
    "林边自然光，not without foreground bokeh。",
  ])("rejects explicit positive foreground defocus instructions: %s", prompt => {
    expect(() => assertTideweScript(script({ prompt }))).toThrow(/镜头\s*1.*不支持的视觉/);
  });

  it.each([
    "低机位观察双靴，前景草叶与地面清楚，远处背景轻微失焦。",
    "前景与靴底共同合焦，最远景只有轻微自然虚化。",
    "不使用前景虚化、前景散景或热成像。",
    "不要让前景落叶失焦，保持脚下支撑面清楚。",
    "避免把前景虚化，双靴与地面自然可读。",
    "前景虚化禁止，远处树木略有自然柔化。",
    "林边自然光。No foreground blur, foreground bokeh, or thermal imaging。",
    "林边自然光，do not blur the foreground。",
    "林边自然光，avoid softly blurred foreground leaves。",
    "林边自然光，without foreground defocus。",
    "林边自然光，foreground blur is forbidden。",
    "林边自然光，foreground leaves remain clear; distant background is slightly out of focus。",
    "林边自然光，no thermal imaging or foreground bokeh。",
  ])("preserves negated foreground bans and slight distant softness: %s", prompt => {
    expect(() => assertTideweScript(script({ prompt }))).not.toThrow();
  });

  it.each(["description", "prompt", "visualIntent", "camera", "shotGoal", "actionStart", "action", "actionEnd", "productFocus"] as const)("checks foreground instructions independently in %s", field => {
    const candidate = script({ prompt: "保持近前景清楚，不使用前景虚化。" });
    candidate.shots[0].tidewe!.visualPlan = { framing: "close_up", visualRole: "detail", actionStart: "双靴已经着地", action: "轻触靴筒可见部位", actionEnd: "手停在靴筒旁", productFocus: "实际靴筒与落叶地面" };
    if (field === "shotGoal") candidate.shots[0].tidewe!.shotGoal = "让前景草叶虚化。";
    else if (["actionStart", "action", "actionEnd", "productFocus"].includes(field)) candidate.shots[0].tidewe!.visualPlan[field as "actionStart" | "action" | "actionEnd" | "productFocus"] = "让前景草叶虚化。";
    else candidate.shots[0][field as "description" | "prompt" | "visualIntent" | "camera"] = "让前景草叶虚化。";
    expect(() => assertTideweScript(candidate)).toThrow("前景草叶虚化");
  });

  it("validates optional structured actions without requiring metadata on historical scripts", () => {
    const legacy = script();
    expect(() => assertTideweScript(legacy)).not.toThrow();
    legacy.shots[0].tidewe!.visualPlan = { framing: "medium", visualRole: "presenter", actionStart: "手已扶住装备边缘", action: "自然指向可见部位一次", actionEnd: "手停稳并回应同伴" };
    expect(() => assertTideweScript(legacy)).not.toThrow();
    legacy.shots[0].tidewe!.visualPlan.action = "用热成像证明温度";
    expect(() => assertTideweScript(legacy)).toThrow(/演示动作.*热成像/);
    legacy.shots[0].tidewe!.visualPlan.action = "自然指向可见部位一次";
    legacy.shots[0].tidewe!.visualPlan.actionStart = "standing";
    expect(() => assertTideweScript(legacy)).toThrow(/动作起止不完整/);
  });

  it("validates product focus as actual visual direction without allowing hidden effects or unresolved presenters", () => {
    const candidate = script();
    candidate.shots[0].tidewe!.visualPlan = { framing: "detail", visualRole: "detail", productFocus: "狩猎靴的现有筒口扣带", actionStart: "手已接触扣带", action: "轻触可见扣带", actionEnd: "手停在扣带边缘" };
    expect(() => assertTideweScript(candidate)).not.toThrow();
    candidate.shots[0].tidewe!.visualPlan.productFocus = "靴筒添加热成像效果";
    expect(() => assertTideweScript(candidate)).toThrow("热成像");
    candidate.shots[0].tidewe!.visualPlan.productFocus = "{{PRESENTER}}手中的靴筒";
    expect(() => assertTideweScript(candidate)).toThrow(/presenter placeholder/);
  });
  it.each([
    "真实操作加热按钮，不生成热成像、发光热区或透视剖面，也不展示独立电池。",
    "林边自然光，禁止 thermal imaging 与 glowing heat，不展示 standalone battery。",
    "镜头不使用热成像；仅用自然光呈现人物等候。",
    "林边自然光。No thermal imaging or glowing heat; 不展示独立电池。",
    "林边自然光，热成像禁用。",
    "林边自然光，without thermal imaging。",
    "林边自然光，无热成像、发光热区、透视剖面或独立电池展示。",
    "林边自然光。No thermal imaging, glowing heat, or standalone battery displays.",
    "林边自然光，don't show thermal imaging or glowing heat。",
  ])("allows explicit negative constraints: %s", prompt => {
    expect(() => assertTideweScript(script({ prompt }))).not.toThrow();
  });

  it.each([
    ["用热成像展示椅面温度。", "热成像"],
    ["坐垫出现发光热区。", "发光热区"],
    ["透视剖面展示加热层。", "透视剖面"],
    ["独立电池摆在椅子旁。", "独立电池"],
    ["林边加入 thermal imaging 效果。", "thermal imaging"],
    ["先禁止热成像，随后展示独立电池。", "独立电池"],
    ["不要 glowing heat，随后添加 thermal imaging。", "thermal imaging"],
    ["不是热成像，而是发光热区。", "发光热区"],
    ["不只是热成像，也展示独立电池。", "热成像"],
    ["镜头不使用热成像；随后添加热成像。", "热成像"],
    ["林边自然光。No thermal imaging. 随后加入 glowing heat。", "glowing heat"],
    ["镜头不是不使用热成像。", "热成像"],
    ["镜头不能不使用热成像。", "热成像"],
    ["镜头不得不使用热成像。", "热成像"],
    ["林边自然光，not without thermal imaging。", "thermal imaging"],
  ])("rejects actual prohibited visuals: %s", (prompt, term) => {
    expect(() => assertTideweScript(script({ prompt }))).toThrow(/镜头\s*1/);
    expect(() => assertTideweScript(script({ prompt }))).toThrow(term);
  });

  it.each(["description", "prompt", "visualIntent", "camera", "shotGoal"] as const)("checks %s independently", field => {
    const candidate = script();
    if (field === "shotGoal") candidate.shots[0].tidewe!.shotGoal = "展示独立电池。";
    else candidate.shots[0][field] = "展示独立电池。";
    expect(() => assertTideweScript(candidate)).toThrow(/镜头\s*1/);
    expect(() => assertTideweScript(candidate)).toThrow("独立电池");
  });

  it.each(["description", "prompt", "visualIntent", "camera", "shotGoal"] as const)("allows explicit negative wording in %s", field => {
    const candidate = script();
    if (field === "shotGoal") candidate.shots[0].tidewe!.shotGoal = "不展示独立电池。";
    else candidate.shots[0][field] = "不展示独立电池。";
    expect(() => assertTideweScript(candidate)).not.toThrow();
  });

  it("does not let a negative instruction in another field hide a positive visual", () => {
    expect(() => assertTideweScript(script({ description: "林边自然光，禁止热成像。", prompt: "热成像展示椅面。" }))).toThrow("热成像");
    const candidate = script({ prompt: "林边自然光，不展示独立电池。" });
    candidate.shots[0].tidewe!.shotGoal = "展示独立电池。";
    expect(() => assertTideweScript(candidate)).toThrow("独立电池");
  });

  it("does not let a negative instruction in one shot hide the next shot", () => {
    const candidate = script({ prompt: "林边自然光，禁止热成像。" });
    candidate.shots.push({ ...candidate.shots[0], shotId: 2, voiceover: "", prompt: "热成像展示椅面。",
      tidewe: { ...candidate.shots[0].tidewe!, copySpan: { start: text.length, end: text.length } } });
    expect(() => assertTideweScript(candidate)).toThrow(/镜头\s*2/);
    expect(() => assertTideweScript(candidate)).toThrow("热成像");
  });
});
