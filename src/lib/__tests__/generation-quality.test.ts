import { describe, expect, it } from "vitest";
import {
  buildShotQualityContract,
  buildQualityEvaluationPrompt,
  parseGenerationQuality,
  qualityDisposition,
  rankQualityCandidates,
} from "@/lib/generation-quality";
import type { Shot } from "@/lib/db/schema";

const shot: Shot = {
  shotId: 2,
  type: "demo",
  duration: 5,
  description: "A presenter presses the blue pump once and spreads one drop on the back of her hand",
  camera: "locked macro close-up",
  visualSource: "ai_generate",
  transition: "ai_reference",
  voiceover: "One pump is enough",
  prompt: "blue serum bottle, one pump, hand demo",
};

describe("generation quality contracts", () => {
  it("reviews Tidewe interaction as a sequence while limiting first-frame review to feasible staging", () => {
    const interaction = { purpose: "为当前任务整理装备", contact: "一手固定接触点，另一手沿可见方向施力", response: "已有可动部件沿连接移动，邻近面料收拢", continuation: "松手后继续原任务" };
    const planned: Shot = { ...shot, tidewe: { copySpan: { start: 0, end: 0 }, translation: "", shotGoal: "展示真实使用", productVisible: true, personVisible: true, factRefs: [], sceneId: "outdoors",
      visualPlan: { framing: "detail", visualRole: "demonstration", actionStart: "手已在可操作位置，产品有稳固支撑", action: "沿参考支持方向操作", actionEnd: "松手后延续任务", interaction } } };
    const video = buildShotQualityContract({ shot: planned, mediaType: "video", tidewePhotography: true });
    expect(video.tideweActionPlan).toEqual({ stage: "sequence", start: planned.tidewe!.visualPlan!.actionStart, action: planned.tidewe!.visualPlan!.action, end: planned.tidewe!.visualPlan!.actionEnd, interaction });
    expect(video.dimensions.find(row => row.id === "action-binding")?.required).toBe(true);
    const videoReview = buildQualityEvaluationPrompt(video, "zh", "Frames at 0, 1 and 2 seconds");
    expect(videoReview).toContain(interaction.response);
    expect(videoReview).toContain("contact sliding");
    expect(videoReview).toContain("lower confidence and request manual review");
    const image = buildShotQualityContract({ shot: planned, mediaType: "image", tidewePhotography: true });
    expect(image.tideweActionPlan).toEqual({ stage: "first-frame", start: planned.tidewe!.visualPlan!.actionStart, interaction: { purpose: interaction.purpose, contact: interaction.contact } });
    const imageReview = buildQualityEvaluationPrompt(image, "zh");
    expect(imageReview).not.toContain(interaction.response);
    expect(imageReview).not.toContain(interaction.continuation);
    expect(imageReview).toContain("do not demand an end-state from a first frame");
    expect(buildShotQualityContract({ shot: planned, mediaType: "video" })).not.toHaveProperty("tideweActionPlan");
    for (const visibility of [{ personVisible: false }, { productVisible: false }]) {
      const hidden = buildShotQualityContract({ shot: { ...planned, tidewe: { ...planned.tidewe!, ...visibility } }, mediaType: "image", tidewePhotography: true });
      expect(hidden.tideweActionPlan).not.toHaveProperty("interaction");
    }
    const continuity = buildShotQualityContract({ shot: planned, mediaType: "image", tidewePhotography: true, hasPreviousReference: true });
    const continuityCriteria = continuity.dimensions.find(row => row.id === "continuity")!.criteria.join(" ");
    expect(continuityCriteria).toContain("Independent first frames may start a new activity");
    expect(continuityCriteria).not.toContain("Opening state should continue naturally");
  });

  it("weights video, product, action, and continuity requirements from the real shot", () => {
    const contract = buildShotQualityContract({
      shot,
      mediaType: "video",
      intent: { subject: "blue serum bottle", action: "press the pump once", productConstraints: ["same blue label"] },
      bible: {
        characterAnchors: ["black bob"],
        productAnchors: ["blue glass bottle"],
        wardrobeAnchors: [],
        environmentAnchors: ["white vanity"],
        lightingAnchors: ["soft daylight"],
        forbiddenChanges: ["red bottle"],
      },
      hasProductReference: true,
      hasPreviousReference: true,
      hasSourceKeyframe: true,
    });

    expect(contract.dimensions.reduce((sum, dimension) => sum + dimension.weight, 0)).toBe(100);
    expect(contract.dimensions.find((dimension) => dimension.id === "temporal-coherence")?.required).toBe(true);
    expect(contract.dimensions.find((dimension) => dimension.id === "subject-fidelity")?.required).toBe(true);
    expect(contract.dimensions.find((dimension) => dimension.id === "continuity")?.required).toBe(true);
    expect(contract.referenceRoles).toEqual(["generated-output", "source-keyframe", "product-reference", "previous-shot-tail"]);
  });

  it("drops the temporal dimension for a still image", () => {
    const contract = buildShotQualityContract({ shot, mediaType: "image" });
    expect(contract.dimensions.some((dimension) => dimension.id === "temporal-coherence")).toBe(false);
    expect(contract.dimensions.reduce((sum, dimension) => sum + dimension.weight, 0)).toBe(100);
  });

  it("adds five complete, observable photography checks only for frozen TIDEWE reviews", () => {
    const contract = buildShotQualityContract({ shot, mediaType: "image", tidewePhotography: true, hasCharacterReference: true });
    const visual = contract.dimensions.find((dimension) => dimension.id === "visual-fidelity")!;
    expect(visual.criteria).toHaveLength(6);
    const prompt = buildQualityEvaluationPrompt(contract, "zh");
    expect(prompt).toContain("including isolated near grass, leaves, frame-edge objects");
    expect(prompt).toContain("Only distant scenery BEHIND the subject may be slightly soft");
    expect(prompt).toContain("separate sharp/blurred layers or abrupt blur boundaries");
    expect(prompt).toContain("warm/orange cast");
    expect(prompt).toContain("painted/oil-paint texture");
    expect(prompt).toContain("credible contact, occlusion and weight");
    expect(prompt).toContain("Do not require a person, eye contact or a new action");
    expect(prompt).toContain("Clothing must follow the approved shot/source, not the identity reference");
    expect(prompt).not.toContain("build and outfit must match the character reference");
    const ordinary = buildShotQualityContract({ shot, mediaType: "image", hasCharacterReference: true });
    expect(ordinary.dimensions.find((dimension) => dimension.id === "visual-fidelity")?.criteria).toHaveLength(1);
    expect(buildQualityEvaluationPrompt(ordinary, "en")).not.toContain("foreground bokeh");
    expect(buildQualityEvaluationPrompt(ordinary, "en")).toContain("build and outfit must match the character reference");
  });

  it("recomputes the weighted result and refuses a critical identity failure", () => {
    const contract = buildShotQualityContract({ shot, mediaType: "video", hasProductReference: true });
    const dimensions = contract.dimensions.map((dimension) => ({
      id: dimension.id,
      score: dimension.id === "subject-fidelity" ? 35 : 94,
      confidence: 0.9,
      summary: "checked",
      evidence: [{ time: 2.1, observation: "visible evidence", severity: dimension.id === "subject-fidelity" ? "critical" : "positive" }],
    }));
    const report = parseGenerationQuality(JSON.stringify({
      summary: "The bottle changes shape",
      dimensions,
      issues: [{ code: "product-shape-drift", dimension: "subject-fidelity", severity: "critical", summary: "Bottle silhouette changes", suggestedFix: "Reuse the product reference", time: 2.1 }],
    }), contract, new Date("2026-08-28T00:00:00Z"));

    expect(report.verdict).toBe("reject");
    expect(report.overall).toBeLessThan(90);
    expect(qualityDisposition(report)).toMatchObject({ action: "regenerate", paid: true, automatic: false });
    expect(qualityDisposition(report, { priorRejectsForModel: 2 })).toMatchObject({ action: "switch-model", paid: true });
  });

  it("forces human review when a required score is missing instead of inventing confidence", () => {
    const contract = buildShotQualityContract({ shot, mediaType: "image", hasProductReference: true });
    const report = parseGenerationQuality('{"summary":"partial","dimensions":[],"issues":[]}', contract);
    expect(report.verdict).toBe("reject");
    expect(report.confidence).toBe(0.2);
    expect(report.dimensions.every((dimension) => dimension.summary === "Not reliably assessed")).toBe(true);
  });

  it("ranks reviewed candidates before unreviewed or selected-but-weaker candidates", () => {
    const contract = buildShotQualityContract({ shot, mediaType: "image" });
    const make = (score: number) => parseGenerationQuality(JSON.stringify({
      summary: "candidate",
      dimensions: contract.dimensions.map((dimension) => ({ id: dimension.id, score, confidence: 0.9, summary: "ok", evidence: [] })),
      issues: [],
    }), contract);
    const ranked = rankQualityCandidates([
      { id: "unreviewed", selected: true, report: null },
      { id: "good", selected: false, report: make(90) },
      { id: "okay", selected: false, report: make(75) },
    ]);
    expect(ranked.map((candidate) => candidate.id)).toEqual(["good", "okay", "unreviewed"]);
  });
});
