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
