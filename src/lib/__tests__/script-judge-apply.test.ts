import { describe, expect, it } from "vitest";
import type { Shot } from "@/lib/db/schema";
import type { JudgeId, JudgeReport } from "@/lib/script-judge";
import { parseJudgeApplyResponse, type JudgeEditableScript } from "@/lib/script-judge-apply";
import { TIDEWE_COMPILER_VERSION, TIDEWE_CORPUS_VERSION, type ProductFacts } from "@/lib/tidewe/types";
import { assertTideweScript, englishWordCount, productFactsHash } from "@/lib/tidewe/validation";
import { compileTideweVisualPrompt } from "@/lib/tidewe/visual-policy";

function shot(shotId: number, voiceover: string): Shot {
  return {
    shotId, type: "demo", duration: 5, voiceover, description: "人物在林边展示靴子。",
    camera: "固定中景", prompt: "林边展示靴子的画面", visualIntent: "呈现户外使用情境",
    visualSource: "ai_generate", transition: "direct_concat",
  };
}

function report(judge: JudgeId = "voice", shotId: number | undefined = 1): JudgeReport {
  return { verdicts: [{ judge, issues: [{ shotId, tier: "default", issue: "Fix the quoted problem." }] }], rewrites: [], descriptionRewrites: [] };
}

function apply(script: JudgeEditableScript, patches: unknown[], feedback = report()) {
  return parseJudgeApplyResponse(JSON.stringify({ patches }), script, feedback);
}

function tidewe(segments = ["Wait.", "Go."], opts: { imported?: boolean; sku?: string; gap?: string } = {}): JudgeEditableScript {
  const facts: ProductFacts = { version: 1, brand: "TIDEWE", sku: opts.sku, category: "waterproof_boots", items: [] };
  const gap = opts.gap ?? "\r\n\r\n";
  let text = "";
  const shots = segments.map((segment, i): Shot => {
    if (i) text += gap;
    const start = text.length;
    text += segment;
    return {
      ...shot(i + 1, segment.trim()),
      tidewe: { copySpan: { start, end: text.length }, translation: "原中文译文。", sceneId: "woods", shotGoal: "展示林边场景", productVisible: true, factRefs: [] },
    };
  });
  return {
    styleType: "tidewe_outdoor", shots,
    copyDocument: {
      version: 1, language: "en-US", source: opts.imported ? "user_provided" : "ai_generated",
      text, translation: "原中文译文。", angle: "outdoors", hookType: "scene", claimedFactIds: [],
      factsSnapshot: facts, factsHash: productFactsHash(facts), corpusVersion: TIDEWE_CORPUS_VERSION,
      compilerVersion: TIDEWE_COMPILER_VERSION, exampleIds: [], wordCount: englishWordCount(text), estimatedDuration: 5,
    },
  };
}

function tideweWithProductionMetadata(): JudgeEditableScript {
  const script = tidewe();
  for (const shot of script.shots!) {
    shot.tidewe!.visualPlan = { framing: "detail", visualRole: "detail", actionStart: "指腹已接触靴口边缘。", action: "轻压靴口一次。", actionEnd: "手指松开后在靴口旁停稳。" };
  }
  script.copyDocument!.visualBeats = script.shots!.map(shot => ({ text: shot.voiceover, visualRole: "detail", visualIdea: "观察已有靴口的局部接触。", factRefs: [] }));
  return script;
}

describe("apply judge feedback to existing shots", () => {
  it("changes the reviewed line and its narration alias while preserving the timeline and other shots", () => {
    const first = { ...shot(1, "Original line."), narration: "Original line." };
    const second = shot(2, "Healthy line.");
    const result = apply({ styleType: "talking_head", shots: [first, second] }, [{ shotId: 1, voiceover: "A natural line." }]);
    expect(result.shots[0]).toEqual({ ...first, voiceover: "A natural line.", narration: "A natural line." });
    expect(result.shots[1]).toBe(second);
  });

  it("carries a corrected visual action into image and video generation fields", () => {
    const script = { styleType: "scene", shots: [shot(1, "Check the fit.")] };
    const description = "人物穿上靴子，屈膝检查脚踝是否舒适。";
    expect(apply(script, [{ shotId: 1, description }], report("visual")).shots[0]).toMatchObject({ description, prompt: description, visualIntent: description });
  });

  it("rejects narration changes for visual-only feedback and changes outside a specific reviewed shot", () => {
    const script = { styleType: "scene", shots: [shot(1, "First."), shot(2, "Second.")] };
    expect(() => apply(script, [{ shotId: 1, voiceover: "Rewritten." }], report("visual"))).toThrow(/Visual-only/);
    expect(() => apply(script, [{ shotId: 2, voiceover: "Rewritten." }])).toThrow(/outside/);
  });

  it("allows a global issue to correct multiple shots without changing their identities", () => {
    const script = { styleType: "scene", shots: [shot(1, "First."), shot(2, "Second.")] };
    const feedback = report("structure");
    delete feedback.verdicts[0].issues[0].shotId;
    const result = apply(script, [{ shotId: 1, voiceover: "A first line." }, { shotId: 2, voiceover: "A second line." }], feedback);
    expect(result.shots.map(item => item.shotId)).toEqual([1, 2]);
  });

  it("does not turn taste suggestions into edits or lose original numeric facts", () => {
    const script = { styleType: "scene", shots: [shot(1, "It weighs 3 kg.")] };
    const taste = report();
    taste.verdicts[0].issues[0].tier = "taste";
    expect(() => apply(script, [{ shotId: 1, voiceover: "This feels light." }], taste)).toThrow(/outside/);
    expect(() => apply(script, [{ shotId: 1, voiceover: "It weighs 13 kg." }])).toThrow(/numeric/);
  });

  it("rejects duplicate shot IDs even when the first patch has no changes", () => {
    const script = { styleType: "scene", shots: [shot(1, "Original.")] };
    expect(() => apply(script, [{ shotId: 1 }, { shotId: 1, voiceover: "Changed." }])).toThrow(/duplicate/);
  });

  it.each([
    { patches: [] },
    { patches: [{ shotId: 99, voiceover: "Changed." }] },
    { patches: [{ shotId: 1, voiceover: "Original." }] },
  ])("rejects invalid or ineffective patch sets: %j", ({ patches }) => {
    expect(() => apply({ styleType: "scene", shots: [shot(1, "Original.")] }, patches)).toThrow();
  });
});

describe("apply TIDEWE feedback without desynchronizing frozen copy", () => {
  it.each(["description", "prompt", "visualIntent"] as const)("clears stale visualPlan only on the shot whose %s changes", (field) => {
    const script = tideweWithProductionMetadata();
    const description = "人物在林边穿着靴子向前走一步，鞋底稳定接触地面。";
    const oldAction = script.shots![0].tidewe!.visualPlan!.action;
    const result = apply(script, [{ shotId: 1, [field]: description }], report("visual"));
    expect(result.shots[0][field]).toBe(description);
    expect(result.shots[0].tidewe?.visualPlan).toBeUndefined();
    expect(result.shots[1]).toBe(script.shots![1]);
    expect(result.shots[1].tidewe?.visualPlan).toEqual(script.shots![1].tidewe!.visualPlan);
    expect(result.copyDocument).toBe(script.copyDocument);
    expect(result.copyDocument?.visualBeats).toEqual(script.copyDocument!.visualBeats);
    expect(script.shots![0].tidewe!.visualPlan).toBeDefined();
    for (const kind of ["image", "video"] as const) {
      const compiled = compileTideweVisualPrompt(result.shots[0], kind);
      expect(compiled.prompt).not.toContain(oldAction);
      expect(compiled.prompt).not.toContain("指腹已接触靴口边缘");
      if (field !== "prompt") expect(compiled.prompt).toContain(description);
    }
  });

  it("keeps visualPlan for pure narration and translation edits while discarding beats tied to the old text", () => {
    const script = tideweWithProductionMetadata();
    const result = apply(script, [{ shotId: 1, voiceover: "Take a moment.", translation: "稍微等一会儿。", description: script.shots![0].description, prompt: script.shots![0].prompt, visualIntent: script.shots![0].visualIntent }]);
    expect(result.copyDocument?.text).toBe("Take a moment.\r\n\r\nGo.");
    expect(result.copyDocument).not.toHaveProperty("visualBeats");
    expect(script.copyDocument?.visualBeats).toHaveLength(2);
    expect(result.shots[0].tidewe?.translation).toBe("稍微等一会儿。");
    expect(result.shots[0].tidewe?.visualPlan).toEqual(script.shots![0].tidewe!.visualPlan);
    expect(result.shots[1].tidewe?.visualPlan).toEqual(script.shots![1].tidewe!.visualPlan);
    expect(result.shots[1].voiceover).toBe(script.shots![1].voiceover);
    expect(() => assertTideweScript(result)).not.toThrow();
  });

  it("accepts an English wording correction whose complete Chinese translation is unchanged", () => {
    const script = tidewe();
    const result = apply(script, [{ shotId: 1, voiceover: "Take a moment.", translation: "原中文译文。" }]);
    expect(result.copyDocument?.text).toBe("Take a moment.\r\n\r\nGo.");
    expect(result.shots[0].tidewe?.translation).toBe("原中文译文。");
    expect(result.copyDocument?.wordCount).toBe(4);
    expect(result.copyDocument?.estimatedDuration).toBe(1.7);
    expect(() => assertTideweScript(result)).not.toThrow();
  });

  it("preserves whitespace inside spans and between spans when rebuilding narration", () => {
    const script = tidewe(["  Wait. ", "Go.  "], { gap: "" });
    const result = apply(script, [{ shotId: 1, voiceover: "Stay here.", translation: "在这里等。" }]);
    expect(result.copyDocument?.text).toBe("  Stay here. Go.  ");
    expect(result.shots[1].voiceover).toBe("Go.");
    expect(result.shots[1].tidewe?.copySpan).toEqual({ start: 13, end: 18 });
    expect(() => assertTideweScript(result)).not.toThrow();
    expect(script.copyDocument?.text).toBe("  Wait. Go.  ");
  });

  it("keeps imported ownership and numeric statements intact during a visual-only correction", () => {
    const script = tidewe(["I've worn this for 3 years."], { imported: true, sku: "HC001" });
    const result = apply(script, [{ shotId: 1, description: "人物在林间把衣服递向镜头。" }], report("visual"));
    expect(result.copyDocument).toBe(script.copyDocument);
    expect(result.shots[0].voiceover).toBe(script.shots![0].voiceover);
  });

  it("preserves untouched imported prose while checking the rewritten shot for unsupported new facts", () => {
    const script = tidewe(["I've worn this for 3 years.", "Check fit."], { imported: true });
    const result = apply(script, [{ shotId: 2, voiceover: "Check the fit.", translation: "检查合脚程度。" }], report("voice", 2));
    expect(result.shots[0].voiceover).toBe(script.shots![0].voiceover);
    expect(() => apply(script, [{ shotId: 2, voiceover: "It lasts 12 hours.", translation: "能用十二小时。" }], report("voice", 2))).toThrow(/numeric/);
  });

  it.each([
    ["HC001", "This waterproof layer keeps things simple."],
    ["BL025", "The upward door keeps things simple."],
    ["HJ006", "This full-zip jacket keeps things simple."],
  ])("retains SKU-specific claim restrictions when rewriting imported %s copy", (sku, voiceover) => {
    const script = tidewe(["Check the fit."], { imported: true, sku });
    expect(() => apply(script, [{ shotId: 1, voiceover, translation: "检查产品细节。" }])).toThrow(new RegExp(sku));
  });

  it("recognizes the HJ006 battery purchase condition in another unchanged shot", () => {
    const script = tidewe(["This heated layer is one option.", "A compatible battery is sold separately."], { imported: true, sku: "HJ006" });
    const result = apply(script, [{ shotId: 1, voiceover: "This heated layer is worth a look.", translation: "这款加热衣值得看看。" }]);
    expect(result.shots[1].voiceover).toBe(script.shots![1].voiceover);
    expect(() => assertTideweScript(result)).not.toThrow();
    expect(() => apply(script, [{ shotId: 2, voiceover: "Check the details.", translation: "查看详情。" }], report("voice", 2))).toThrow(/battery purchase/);
  });
});
