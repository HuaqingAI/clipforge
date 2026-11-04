// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Shot } from "@/lib/db/schema";
import { compileTideweVideoPrompt, TIDEWE_VIDEO_STYLE } from "@/lib/tidewe/video-prompt";
import { TIDEWE_IMAGE_CAPTURE_POLICY, TIDEWE_PHOTOGRAPHIC_POLICY } from "@/lib/tidewe/visual-policy";
import type { TideweVideoDirection } from "@/lib/tidewe/video-direction";
import { validateVideoPrompt } from "@/lib/video-prompt";

const direction: TideweVideoDirection = {
  start: "The hand rests beside the existing zipper.",
  action: "The presenter pulls the existing zipper halfway up once.",
  end: "The hand stops beside the closed section.",
  camera: "A restrained handheld medium shot follows the hand.",
  focus: "Keep the existing zipper and its connected fabric visible.",
};
const shot: Partial<Shot> = {
  description: direction.action, camera: direction.camera, voiceover: "I'd check the fit first. Don't rush it.",
  tidewe: { productVisible: true, personVisible: true, copySpan: { start: 0, end: 43 }, translation: "先检查合身程度。", shotGoal: "", factRefs: [], sceneId: "woods" },
};

describe("compact English TIDEWE image-to-video template", () => {
  it("preserves the directed start, action, end and camera with one short photographic style block", () => {
    const before = structuredClone(shot);
    const output = compileTideweVideoPrompt(shot, "voiceover", undefined, "native", direction);
    expect(validateVideoPrompt(output.prompt)).toEqual([]);
    for (const text of Object.values(direction)) expect(output.prompt).toContain(text);
    expect(output.prompt.split(TIDEWE_VIDEO_STYLE)).toHaveLength(2);
    expect(output.prompt).toMatch(/first frame/i);
    expect(output.prompt).toMatch(/ordinary everyday pace/i);
    expect(output.prompt).toMatch(/independently of narration length/i);
    expect(output.prompt).not.toMatch(/once at normal speed, then settle/i);
    expect(output.prompt).not.toContain(TIDEWE_IMAGE_CAPTURE_POLICY);
    expect(output.prompt).not.toContain(TIDEWE_PHOTOGRAPHIC_POLICY);
    expect(output.prompt.length).toBeLessThan(2400);
    expect(output.prompt).not.toMatch(/[\u3400-\u9fff]/);
    expect(output.negativePrompt).not.toMatch(/[\u3400-\u9fff]/);
    const style = output.prompt + output.negativePrompt;
    for (const requirement of [/iPhone 8/i, /natural ambient light/i, /colors/i, /shadows/i, /exposure/i, /material detail/i, /fill light/i, /flash/i, /reflectors/i, /rim light/i, /HDR/i, /beauty retouch/i, /sharpen/i, /cinematic grading/i, /artificial noise/i, /global blur/i, /artificial depth of field/i]) {
      expect(style).toMatch(requirement);
    }
    expect(shot).toEqual(before);
  });

  it("carries the complete physical interaction into provider output without replacing the approved action or ending", () => {
    const interaction = {
      purpose: "Close the garment to its approved position.",
      contact: "Keep the existing pull gripped and support the adjacent fabric.",
      response: "The teeth close behind the pull while the fabric responds to tension.",
      continuation: "Retain the hand at the stated resting point without another operation.",
    };
    const bound = { ...shot, tidewe: { ...shot.tidewe!, visualPlan: { framing: "detail" as const, visualRole: "demonstration" as const, actionStart: "手已握住拉链。", action: "拉动一次。", actionEnd: "手停在规定位置。", interaction: { purpose: "合拢衣襟。", contact: "手指握住现有拉链。", response: "齿链闭合，布料响应拉力。", continuation: "保持规定的终态。" } } } };
    expect(() => compileTideweVideoPrompt(bound, "voiceover", undefined, "native", direction)).toThrow(/English before preview or generation/);
    const output = compileTideweVideoPrompt(bound, "voiceover", undefined, "native", { ...direction, interaction });
    expect(validateVideoPrompt(output.prompt)).toEqual([]);
    for (const text of Object.values(interaction)) expect(output.prompt).toContain(text);
    expect(output.prompt).toContain(direction.action);
    expect(output.prompt).toContain(direction.end);
    expect(output.prompt).toContain("Rigid parts keep their shape");
    expect(output.prompt).toContain("add no task or idle gesture");
    expect(output.prompt).not.toMatch(/nod|glance|look down|natural breathing/i);
    const unplanned = compileTideweVideoPrompt(shot, "voiceover", undefined, "native", { ...direction, interaction });
    expect(unplanned.prompt).not.toContain("Interaction purpose:");
    expect(unplanned.prompt).not.toContain(interaction.continuation);
  });

  it("keeps different approved actions and camera moves distinct without turning a still observation into an extra action", () => {
    const observation = { action: "The existing chair remains still on the leaf-covered ground.", camera: "Locked-off low-angle close-up." };
    const movement = { action: "The presenter takes one step in the boots and settles.", camera: "A short restrained lateral follow." };
    const first = compileTideweVideoPrompt(shot, "voiceover", undefined, "post", observation);
    const second = compileTideweVideoPrompt(shot, "voiceover", undefined, "post", movement);
    expect(validateVideoPrompt(first.prompt)).toEqual([]);
    expect(validateVideoPrompt(second.prompt)).toEqual([]);
    expect(first.prompt).toContain(observation.action);
    expect(first.prompt).toContain(observation.camera);
    expect(first.prompt).not.toContain(movement.action);
    expect(first.prompt).not.toContain(direction.action);
    expect(second.prompt).toContain(movement.action);
    expect(second.prompt).toContain(movement.camera);
    expect(second.prompt).not.toContain(observation.action);
    expect(first.prompt).toMatch(/observational shots stay observational/i);
  });

  it("uses unambiguous English fields directly but requires prepared English direction for Chinese or additional manual context", () => {
    const english = compileTideweVideoPrompt(shot);
    expect(validateVideoPrompt(english.prompt)).toEqual([]);
    expect(english.prompt).toContain(direction.action);
    expect(english.prompt).toContain(direction.camera);
    const chinese = { ...shot, description: "主播将现有拉链拉到一半后停稳。", camera: "克制的手持中景" };
    expect(() => compileTideweVideoPrompt(chinese)).toThrow(/English/);
    const before = structuredClone(chinese);
    const translated = compileTideweVideoPrompt(chinese, "voiceover", undefined, "native", direction);
    expect(validateVideoPrompt(translated.prompt)).toEqual([]);
    expect(translated.prompt).toContain(direction.action);
    expect(translated.prompt).not.toContain(chinese.description);
    expect(chinese).toEqual(before);
    expect(() => compileTideweVideoPrompt({ ...shot, visualIntent: "Keep the left sleeve in view." })).toThrow(/English/);
    expect(() => compileTideweVideoPrompt(shot, "voiceover", undefined, "native", { action: "拉动现有拉链一次。" })).toThrow(/English/);
  });

  it("puts the exact native on-camera line in the prompt once with a visible mouth and synchronized lips", () => {
    const exact = "I'd say \"check fit\" first. Don't rush it.";
    const output = compileTideweVideoPrompt({ ...shot, voiceover: exact }, "on_camera", undefined, "native", direction);
    expect(validateVideoPrompt(output.prompt)).toEqual([]);
    const quoted = JSON.stringify(exact);
    expect(output.prompt.split(quoted)).toHaveLength(2);
    expect(output.prompt).toMatch(/visible presenter.*exact US English line.*once/i);
    expect(output.prompt).toMatch(/synchronized lips/i);
    expect(output.prompt).toMatch(/mouth visible/i);
    expect(output.prompt).toMatch(/finish the entire line by [\d.]+ seconds from the clip start/i);
    expect(output.negativePrompt).not.toMatch(/visible speaking(?:,|$)|lip synchronization(?:,|$)/i);
    expect(output.negativePrompt).toMatch(/lip.sync mismatch/i);
  });

  it.each(["native", "post"] as const)("keeps the ten-word delivery window fixed when %s video generation lasts longer", (audioMode) => {
    const line = "Check the fit before you choose the gear for tomorrow.";
    const short = compileTideweVideoPrompt({ ...shot, voiceover: line, duration: 4 }, "on_camera", undefined, audioMode, direction);
    const longer = compileTideweVideoPrompt({ ...shot, voiceover: line, duration: 10 }, "on_camera", undefined, audioMode, direction);
    for (const output of [short, longer]) {
      expect(validateVideoPrompt(output.prompt)).toEqual([]);
      expect(output.prompt).toContain("215 words per minute (210-220)");
      expect(output.prompt).toContain("Start within 0.15 seconds");
      expect(output.prompt).toContain("Finish the entire line by 2.94 seconds from the clip start");
      expect(output.prompt).toContain("Do not slow the line or add pauses to fill a longer generated clip");
      expect(output.prompt).toContain("Speech cadence does not speed up the approved physical actions");
      expect(output.prompt).not.toMatch(/brief pauses at both ends|conversational pace/i);
      expect(output.prompt.split(JSON.stringify(line))).toHaveLength(2);
    }
    expect(short.prompt).toEqual(longer.prompt);
  });

  it("gives native off-camera narration the same brisk speech window without adding visible speech", () => {
    const line = "Check the fit before you choose the gear for tomorrow.";
    const output = compileTideweVideoPrompt({ ...shot, voiceover: line, duration: 5, tidewe: { ...shot.tidewe!, speechDelivery: "off_camera" } }, "on_camera", undefined, "native", direction);
    expect(validateVideoPrompt(output.prompt)).toEqual([]);
    expect(output.prompt).toContain("215 words per minute (210-220)");
    expect(output.prompt).toContain("Finish the entire line by 2.94 seconds from the clip start");
    expect(output.prompt).toMatch(/off-camera narration.*no speaking or lip synchronization/i);
    expect(output.prompt).not.toMatch(/mouth visible/i);
  });

  it.each(["native", "post"] as const)("preserves a historical line whose planned %s clip is too short instead of imposing an impossible deadline", (audioMode) => {
    const bound = { ...shot, voiceover: "Check the fit before you choose the gear for tomorrow.", duration: 1.5 };
    const before = structuredClone(bound);
    const output = compileTideweVideoPrompt(bound, "on_camera", undefined, audioMode, direction);
    expect(validateVideoPrompt(output.prompt)).toEqual([]);
    expect(output.prompt).toContain("The planned 1.5 seconds is too short");
    expect(output.prompt).toContain("needs at least 3.09 seconds at this cadence");
    expect(output.prompt).toContain("Preserve the complete line; extend its timing budget");
    expect(output.prompt).toContain("rather than omit words, truncate the sentence or force a faster delivery");
    expect(output.prompt).not.toMatch(/Finish the entire line by|entire line inside this clip/i);
    expect(output.prompt.split(JSON.stringify(bound.voiceover))).toHaveLength(2);
    expect(bound).toEqual(before);
  });

  it.each([true, false])("keeps native off-camera narration exact while preserving person visibility=%s", (personVisible) => {
    const bound = { ...shot, tidewe: { ...shot.tidewe!, personVisible, speechDelivery: "off_camera" as const } };
    const output = compileTideweVideoPrompt(bound, "on_camera", undefined, "native", direction);
    expect(validateVideoPrompt(output.prompt)).toEqual([]);
    expect(output.prompt.split(JSON.stringify(shot.voiceover))).toHaveLength(2);
    expect(output.prompt).toMatch(/off.camera narration/i);
    expect(output.prompt).toMatch(/no speaking or lip synchronization/i);
    expect(output.prompt).toMatch(/do not add a face or change the framing/i);
    expect(output.prompt).not.toMatch(/mouth visible/i);
    if (!personVisible) expect(output.prompt).toContain("No people, faces or hands.");
    expect(output.negativePrompt).toMatch(/visible speaking, lip synchronization/i);
  });

  it("silently articulates the exact visible line for dubbing without requesting an audio track", () => {
    const output = compileTideweVideoPrompt(shot, "on_camera", undefined, "post", direction);
    expect(validateVideoPrompt(output.prompt)).toEqual([]);
    expect(output.prompt.split(JSON.stringify(shot.voiceover))).toHaveLength(2);
    expect(output.prompt).toMatch(/no audio track/i);
    expect(output.prompt).toMatch(/visible presenter silently articulates.*once/i);
    expect(output.prompt).toMatch(/lip timing for later dubbing/i);
    expect(output.prompt).toMatch(/mouth visible/i);
    expect(output.negativePrompt).not.toMatch(/visible speaking(?:,|$)|lip synchronization(?:,|$)/i);
  });

  it("keeps post off-camera narration silent with no visible lip motion or frozen copy in the visual prompt", () => {
    const output = compileTideweVideoPrompt({ ...shot, tidewe: { ...shot.tidewe!, speechDelivery: "off_camera" } }, "on_camera", undefined, "post", direction);
    expect(validateVideoPrompt(output.prompt)).toEqual([]);
    expect(output.prompt).toMatch(/silent footage.*post/i);
    expect(output.prompt).toMatch(/no audio track, visible speaking or lip synchronization/i);
    expect(output.prompt).not.toContain(shot.voiceover);
    expect(output.prompt).not.toContain("Exact line:");
    expect(output.prompt).not.toContain("words per minute");
    expect(output.prompt).not.toMatch(/silently articulates/i);
    expect(output.negativePrompt).toMatch(/visible speaking, lip synchronization/i);
  });

  it.each(["native", "post"] as const)("keeps historical voiceover mode silent even with on-camera metadata and audioMode=%s", (audioMode) => {
    const output = compileTideweVideoPrompt({ ...shot, tidewe: { ...shot.tidewe!, speechDelivery: "on_camera" } }, "voiceover", undefined, audioMode, direction);
    expect(validateVideoPrompt(output.prompt)).toEqual([]);
    expect(output.prompt).toMatch(/silent footage/i);
    expect(output.prompt).toMatch(/no audio track/i);
    expect(output.prompt).not.toContain(shot.voiceover);
    expect(output.prompt).not.toContain("Exact line:");
    expect(output.prompt).not.toMatch(/silently articulates/i);
  });

  it("requests only natural location/object sound for an unvoiced native shot", () => {
    const output = compileTideweVideoPrompt({ ...shot, voiceover: "" }, "on_camera", undefined, "native", direction);
    expect(validateVideoPrompt(output.prompt)).toEqual([]);
    expect(output.prompt).toMatch(/natural location and object sounds only/i);
    expect(output.prompt).toMatch(/no invented dialogue/i);
    expect(output.prompt).not.toContain("Exact line:");
    expect(output.prompt).not.toMatch(/silent footage|silently articulates/i);
  });

  it("does not append unrelated SKU or battery sales claims to a simple existing zipper action", () => {
    const output = compileTideweVideoPrompt(shot, "voiceover", undefined, "native", direction);
    for (const forbidden of [/HJ006/i, /HC001/i, /BL025/i, /battery/i, /sold separately/i, /heat(?:ing|ed) zone/i, /temperature/i]) {
      expect(output.prompt).not.toMatch(forbidden);
      expect(output.negativePrompt).not.toMatch(forbidden);
    }
  });

  it("keeps approved continuous walking rhythmic without a forced stop or a ban on alternating steps", () => {
    const walking: TideweVideoDirection = {
      action: "Walk toward the bank with continuous alternating steps.",
      end: "Continue along the established shallow-water route as the shot ends.",
      camera: "Follow at the established side and distance.",
      motionType: "continuous",
    };
    const output = compileTideweVideoPrompt({ ...shot, duration: 9 }, "on_camera", undefined, "native", walking);
    expect(validateVideoPrompt(output.prompt)).toEqual([]);
    expect(output.prompt).toContain(walking.action);
    expect(output.prompt).toContain(walking.end);
    expect(output.prompt).toMatch(/continuous activity with natural cyclic movement/i);
    expect(output.prompt).toMatch(/without an unplanned stop/i);
    expect(output.prompt).not.toMatch(/then settle|complete .* once at normal speed/i);
    expect(output.negativePrompt).not.toContain("repeated action");
    expect(output.negativePrompt).toContain("looped replay of a completed demonstration");
  });

  it("gives the reported nine-second single step a brief action window and preserves its exact destination", () => {
    const oneStep: TideweVideoDirection = {
      start: "Both boots are planted on the shallow bottom, facing the nearby bank.",
      action: "Take one natural step toward shore.",
      end: "Both feet are planted steadily at the shoreline.",
      camera: "Track with that step, then hold the established side view.",
      motionType: "bounded", actionWindow: [0, 2],
      timing: "Complete the single step with ordinary weight transfer, then remain at the reached shoreline with natural breathing and small balance adjustments.",
    };
    const bound = { ...shot, duration: 9, tidewe: { ...shot.tidewe!, speechDelivery: "off_camera" as const } };
    const before = structuredClone(bound);
    const output = compileTideweVideoPrompt(bound, "on_camera", undefined, "native", oneStep);
    expect(validateVideoPrompt(output.prompt)).toEqual([]);
    expect(output.prompt).toContain("Action window: 0-2 seconds within this clip.");
    expect(output.prompt).toContain(oneStep.action);
    expect(output.prompt).toContain(oneStep.end);
    expect(output.prompt).toContain(oneStep.timing);
    expect(output.prompt).toMatch(/independently of narration length/i);
    expect(output.prompt).not.toMatch(/continuous alternating steps|unlimited walking|complete .* once at normal speed/i);
    expect(output.prompt.split(JSON.stringify(bound.voiceover))).toHaveLength(2);
    expect(bound).toEqual(before);
  });

  it("lets a bounded product operation finish before the end of the voice line without adding another demonstration", () => {
    const bounded: TideweVideoDirection = {
      ...direction, motionType: "bounded", actionWindow: [1, 3],
      timing: "Pull the zipper at an ordinary physical pace, then keep the hand at its approved resting point with small natural body movements for the remaining time.",
    };
    const output = compileTideweVideoPrompt({ ...shot, duration: 8 }, "on_camera", undefined, "post", bounded);
    expect(validateVideoPrompt(output.prompt)).toEqual([]);
    expect(output.prompt).toContain("Action window: 1-3 seconds within this clip.");
    expect(output.prompt).toContain(bounded.timing);
    expect(output.prompt).toMatch(/silently articulates/i);
    expect(output.prompt.split(JSON.stringify(shot.voiceover))).toHaveLength(2);
    expect(output.prompt).not.toMatch(/repeat the operation|stretch .* to match the line/i);
  });

  it("preserves a deliberately careful physical cadence and keeps observations free of invented operations", () => {
    const cautious: TideweVideoDirection = {
      action: "Take one slow, careful step onto the slippery bank.",
      end: "Keep both boots planted at the reached position.",
      motionType: "bounded", actionWindow: [0, 4],
      timing: "Use the directed cautious weight transfer and settle safely at the reached position; retain natural breathing afterward.",
    };
    const careful = compileTideweVideoPrompt({ ...shot, duration: 6 }, "voiceover", undefined, "post", cautious);
    expect(validateVideoPrompt(careful.prompt)).toEqual([]);
    expect(careful.prompt).toContain(cautious.action);
    expect(careful.prompt).toContain(cautious.timing);
    expect(careful.prompt).not.toMatch(/walk briskly|speed up|rapid footsteps/i);
    const observation = compileTideweVideoPrompt({ ...shot, duration: 6, tidewe: { ...shot.tidewe!, personVisible: false } }, "voiceover", undefined, "post", {
      action: "Observe the existing boot sole resting on the ground.", motionType: "observation",
    });
    expect(validateVideoPrompt(observation.prompt)).toEqual([]);
    expect(observation.prompt).toMatch(/only the directed natural motion; do not add a demonstration/i);
    expect(observation.prompt).not.toMatch(/complete .* once|then settle|natural breathing/i);
  });

  it.each([[0, 10], [-1, 2], [3, 2], [2, 2], [0, Number.NaN]])("refuses an invalid action window %j before producing a provider prompt", (start, end) => {
    expect(() => compileTideweVideoPrompt({ ...shot, duration: 9 }, "on_camera", undefined, "native", {
      ...direction, motionType: "bounded", timing: "Pull the zipper and remain naturally at the approved ending.", actionWindow: [start, end],
    })).toThrow(/English before preview or generation/);
  });
});
