// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTideweOutdoorProfile } from "@/lib/creative-profiles";
import { productFactsFromDescription } from "@/lib/tidewe/facts";
import { compileTideweVisualPrompt } from "@/lib/tidewe/visual-policy";
import { buildTideweCategoryGuidance } from "@/lib/tidewe/category-guidance";
import type { ProductFacts } from "@/lib/tidewe/types";
import { generateScript, generateSingleScript, generateScriptStream, createScriptStream, type ScriptInput } from "@/lib/script-engine/generator";

const model = vi.hoisted(() => ({ create: vi.fn(), replies: [] as unknown[] }));
vi.mock("@/lib/llm-error", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/llm-error")>(),
  createLLMClient: () => ({ chat: { completions: { create: model.create } } }),
}));
const input: ScriptInput = { productName: "TIDEWE outdoor jacket", category: "fashion", styleType: "tidewe_outdoor", creativeProfile: createTideweOutdoorProfile({ targetDuration: 30 }), count: 1, llmConfig: { baseUrl: "https://example.test/v1", apiKey: "test", model: "test" } };
const shotTargets = [{ targetDuration: 30, shotCount: 7 }, { targetDuration: 40, shotCount: 8 }, { targetDuration: 60, shotCount: 9 }] as const;
// English direction preparation is verified separately; these generator checks bind speech delivery.
const preparedVideoDirection = { action: "Observe the visible product and its established physical contacts.", camera: "Hold the approved framing." };
const text = "Walking warms you up. Waiting is different. Check the fit before your next trip.";
const visualBeats = [
  { text: "Walking warms you up.", visualRole: "demonstration", visualIdea: "人物已经站在小径上，向前走一步。", factRefs: [] },
  { text: "Waiting is different.", visualRole: "context", visualIdea: "从林缘宽景观察停步等待的状态。", factRefs: [] },
  { text: "Check the fit before your next trip.", visualRole: "presenter", visualIdea: "主播面对拍摄朋友展示衣服的穿着状态。", factRefs: [] },
];
const copy = { copies: [{ title: "静候时刻", text, translation: "走动暖身，静候不同。下次出发前核对尺码。", angle: "long_wait", hookType: "contrast", claimedFactIds: [], visualBeats }] };
const plan = { scripts: [{ copyIndex: 0, shots: [{ scriptSegment: text, translation: copy.copies[0].translation, narrativeRole: "hook", duration: 10, description: "人物穿着当前外套在林边向拍摄朋友走一步，衣服与地面接触关系自然清楚。", camera: "稳定中景", shotGoal: "观察当前外套的实际穿着状态", visualIntent: "清晨户外穿着演示", prompt: "林边真实自然光，当前外套完整可辨。", productVisible: true, factRefs: [], sceneId: "woods", visualPlan: { framing: "medium", visualRole: "demonstration", productFocus: "当前外套的躯干轮廓与衣袖穿着状态", actionStart: "人物穿着当前外套，双脚已经踩稳林缘地面。", action: "穿着外套向拍摄朋友走一步。", actionEnd: "双脚站稳，外套自然垂落并保持清楚可见。" } }] }] };
type PlannedShot = (typeof plan)["scripts"][number]["shots"][number];
const planSegments = ["Walking warms you up.", "Waiting", "is different.", "Check the fit", "before", "your next", "trip."];
function allocateShots(frozenText: string, seed: PlannedShot, shotCount = 7): PlannedShot[] {
  const words = [...frozenText.matchAll(/\S+/g)];
  const segments = Array.from({ length: shotCount }, (_, index) => {
    const startWord = Math.floor(index * words.length / shotCount);
    const endWord = Math.floor((index + 1) * words.length / shotCount) - 1;
    return frozenText.slice(words[startWord].index, words[endWord].index! + words[endWord][0].length);
  });
  return segments.map((scriptSegment, index) => ({
    ...structuredClone(seed), scriptSegment, duration: 3,
    shotGoal: `观察当前商品第${index + 1}处外观与使用状态`,
    visualPlan: { ...seed.visualPlan, framing: ["medium", "close_up", "wide"][index % 3], visualRole: index === 1 ? "detail" : "demonstration", action: `观察当前商品第${index + 1}处可见状态。` },
  }));
}
plan.scripts[0].shots = allocateShots(text, plan.scripts[0].shots[0]).map((shot, index) => ({ ...shot, scriptSegment: planSegments[index] }));

function countedPlanFixture(counts: number[]) {
  const parts = ["edge", "shape", "seam", "opening", "sleeve", "surface", "outline", "fabric", "fit", "hem"];
  const copies = counts.map((count, copyIndex) => {
    const segments = parts.slice(0, count).map(part => `Look at this ${part}.`);
    const frozenText = segments.join(" ");
    return { ...copy.copies[0], title: `方案${copyIndex + 1}`, text: frozenText,
      visualBeats: [{ text: frozenText, visualRole: "demonstration", visualIdea: "观察当前外套实际可见的外观与穿着状态。", factRefs: [] }],
    };
  });
  const scripts = counts.map((count, copyIndex) => ({ copyIndex, shots: parts.slice(0, count).map((part, shotIndex) => ({
    ...structuredClone(plan.scripts[0].shots[0]), scriptSegment: `Look at this ${part}.`, duration: 3,
    shotGoal: `观察当前外套第${shotIndex + 1}处可见状态`,
    visualPlan: { ...plan.scripts[0].shots[0].visualPlan, framing: ["medium", "close_up", "wide"][shotIndex % 3], visualRole: shotIndex === 1 ? "detail" : "demonstration", action: `观察当前外套第${shotIndex + 1}处可见状态。` },
  })) }));
  return { copy: { copies }, plan: { scripts } };
}

function observedBootFixture() {
  const visualObservations = "参考图可见高筒轮廓、迷彩图案和黑色鞋底沟槽；这些只说明外观，不证明防蛇咬、防水或抓地性能。";
  const bootInput: ScriptInput = { ...input, productName: "TIDEWE men's hunting boots", productAnalysis: visualObservations, productFacts: productFactsFromDescription("", "waterproof_boots") };
  const segments = ["Watch this step.", "Look at the full boot shaft.", "Check the fit before the next walk.", "See the camo boundary.", "Look at the boot opening.", "Check the visible sole edge.", "Choose what fits your next trip."];
  const frozenText = segments.join(" ");
  const beats = [
    { text: segments[0], visualRole: "demonstration", visualIdea: "穿着当前高筒靴在林边平地迈一步，靴底与地面接触可见。", factRefs: [] },
    { text: segments[1], visualRole: "detail", visualIdea: "让完整靴筒轮廓、迷彩边界和黑色鞋底纹路清楚入画。", factRefs: [] },
    { text: segments[2], visualRole: "presenter", visualIdea: "主播面对拍摄朋友自然说明出行前查看穿着状态。", factRefs: [] },
    ...segments.slice(3).map(segment => ({ text: segment, visualRole: "detail", visualIdea: "近景观察当前靴子真实可见的外观细节。", factRefs: [] })),
  ];
  const frozenCopy = { copies: [{ ...copy.copies[0], text: frozenText, visualBeats: beats }] };
  const personOnly = { scripts: [{ copyIndex: 0, shots: segments.map((scriptSegment, index) => ({
    ...structuredClone(plan.scripts[0].shots[0]), scriptSegment, duration: 6, personVisible: true, speechDelivery: "on_camera", productVisible: false,
    description: "人物上半身面对拍摄朋友自然讲话，嘴部清楚可见，靴子在画面之外。",
    visualIntent: "人物向拍摄朋友说明出行前的查看事项。", prompt: "林边自然光，胸部以上取景，人物自然讲话。",
    shotGoal: `人物说明第${index + 1}段原文。`,
    visualPlan: { framing: ["medium", "close_up", "wide"][index % 3], visualRole: index === 3 ? "context" : "presenter", actionStart: "人物已经站稳并面向拍摄朋友。", action: "自然点头回应拍摄朋友。", actionEnd: "保持站姿并自然看向镜头。" },
  })) }] };
  const repaired = { scripts: [{ copyIndex: 0, shots: [
    { ...structuredClone(plan.scripts[0].shots[0]), scriptSegment: segments[0], duration: 6, personVisible: true, speechDelivery: "off_camera", description: "人物穿着当前迷彩高筒靴在林边平地迈一步，双靴与脚下地面完整同框。", camera: "稳定全身宽景", shotGoal: "观察当前靴子穿在脚上迈一步的状态。", visualIntent: "展示当前靴子的普通穿着动作。", prompt: "林边中性自然光，人物穿着当前高筒靴迈一步，双靴与地面完整同框。", visualPlan: { framing: "wide", visualRole: "demonstration", productFocus: "穿在脚上的迷彩高筒靴与地面接触关系", actionStart: "人物穿着双靴站稳在林边平地。", action: "前脚向前迈一步。", actionEnd: "前脚鞋底已踩稳地面，后脚自然停留。" } },
    { ...structuredClone(plan.scripts[0].shots[0]), scriptSegment: segments[1], duration: 6, personVisible: false, speechDelivery: "off_camera", description: "当前迷彩高筒靴已经稳定放在林边木桩上，完整靴筒轮廓与鞋底边缘清楚可辨。", camera: "稳定近景，完整单靴入画。", shotGoal: "查看当前靴子的完整靴筒外形与可见纹路。", visualIntent: "观察当前靴子的外观细节。", prompt: "林边中性散射光，当前单只高筒靴完整入画，迷彩边界与黑色鞋底沟槽清楚可见。", visualPlan: { framing: "close_up", visualRole: "detail", productFocus: "完整高筒轮廓、迷彩边界与黑色鞋底沟槽", actionStart: "单只当前靴子已放稳，完整靴筒清楚入画。", action: "静态观察完整靴筒轮廓与外侧纹路。", actionEnd: "靴子与画面构图保持稳定。" } },
    structuredClone(personOnly.scripts[0].shots[2]),
  ] }] };
  repaired.scripts[0].shots[2].visualPlan.framing = "medium";
  repaired.scripts[0].shots.push(...segments.slice(3).map((scriptSegment, index) => ({
    ...structuredClone(repaired.scripts[0].shots[1]), scriptSegment, duration: 3,
    shotGoal: `观察当前靴子第${index + 1}处真实可见外观`,
    visualPlan: { ...repaired.scripts[0].shots[1].visualPlan, action: `静态观察当前靴子第${index + 1}处外观细节。` },
  })));
  return { bootInput, visualObservations, segments, frozenText, beats, frozenCopy, personOnly, repaired };
}
function reply(copyResponse: { copies: unknown[] } = copy, planResponse: { scripts: unknown[] } = plan) {
  return { ...copyResponse, ...planResponse };
}
function payload() {
  return JSON.parse(model.create.mock.calls[0][0].messages[1].content);
}
beforeEach(() => {
  model.replies = [reply()];
  model.create.mockReset().mockImplementation(async () => ({ choices: [{ message: { content: JSON.stringify(model.replies.shift()) } }] }));
});
describe("shared TIDEWE generator dispatch", () => {
  it.each([false, true])("preserves interaction staging and frozen presenter references with staff copy=%s", async imported => {
    const presenter = { id: "saved-presenter", name: "Creator", appearance: "", referenceImages: ["https://example.test/creator.png"] };
    const interaction = {
      purpose: "  {{PRESENTER}}为继续当前任务整理已有装备。  ",
      contact: "{{PRESENTER}}一手固定已有接触处，另一手沿可见方向施力。",
      response: "对应可动部位沿已有连接移动，邻近面料形成自然褶皱。",
      continuation: "{{PRESENTER}}松手后延续原任务，在有意义的状态切镜。",
    };
    const planned = { scripts: [{ copyIndex: 0, shots: plan.scripts[0].shots.map(shot => ({
      ...structuredClone(shot), personVisible: true,
      description: `{{PRESENTER}}在林边穿着当前装备，${shot.description}`,
      visualPlan: { ...shot.visualPlan, interaction: structuredClone(interaction) },
    })) }] };
    model.replies = [reply(copy, planned)];
    const [script] = await generateScript({ ...input, creativeProfile: createTideweOutdoorProfile({ targetDuration: 30, presenter }), ...(imported ? { copyText: text } : {}) });
    const expected = Object.fromEntries(Object.entries(interaction).map(([field, value]) => [field, value.trim().replaceAll("{{PRESENTER}}", "所选主播")]));
    expect(script.shots.every(shot => JSON.stringify(shot.tidewe?.visualPlan?.interaction) === JSON.stringify(expected))).toBe(true);
    expect(script.shots[0].tidewe?.presenter).toEqual(presenter);
    expect(script.copyDocument?.text).toBe(text);
    expect(script.shots.map(shot => shot.voiceover).join(" ")).toBe(text);
    expect(model.create).toHaveBeenCalledTimes(1);
    expect(planned.scripts[0].shots[0].visualPlan.interaction.purpose).toBe(interaction.purpose);
  });

  it("rejects an incomplete supplied interaction instead of silently losing its contact contract", async () => {
    const planned = { scripts: [{ copyIndex: 0, shots: plan.scripts[0].shots.map(shot => ({
      ...structuredClone(shot), visualPlan: { ...shot.visualPlan, interaction: { purpose: "整理装备", contact: "接触已有部位", continuation: "继续任务" } },
    })) }] };
    model.replies = [reply(copy, planned)];
    await expect(generateScript(input)).rejects.toThrow(/interaction response/);
    expect(model.create).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("generates copy and physical pacing in one response with staff copy=%s", async imported => {
    const [script] = await generateScript({ ...input, ...(imported ? { copyText: text } : {}) });
    expect(model.create).toHaveBeenCalledTimes(1);
    const system = model.create.mock.calls[0][0].messages[0].content;
    expect(system).toContain("Plan physical pacing independently from narration length");
    expect(system).toContain("more continuing steps, not a fixed single step stretched across the clip");
    expect(system).toContain("complete the operation once at its ordinary physical speed");
    expect(system).toContain("Preserve an explicitly requested slow or cautious physical action");
    expect(payload().outputFormat).toHaveProperty("copies");
    expect(payload().outputFormat).toHaveProperty("scripts");
    if (imported) expect(payload().frozenImportedCopy).toBe(text);
    expect(script.copyDocument?.text).toBe(text);
    expect(script.shots.map(shot => shot.voiceover).join(" ")).toBe(text);
  });

  it("carries a scene direction through the combined AI generation request", async () => {
    const fixture = countedPlanFixture([7]);
    const sceneDescription = "傍晚湖边，猎人穿着当前外套向拍摄朋友展示衣服，氛围轻松自然。";
    model.replies = [reply(fixture.copy, fixture.plan)];
    const scripts = await generateScript({ ...input, count: 3, sceneDescription: `  ${sceneDescription}\n` });
    expect(scripts).toHaveLength(1);
    expect(scripts[0].copyDocument).toMatchObject({ text: fixture.copy.copies[0].text, source: "ai_generated" });
    expect(model.create).toHaveBeenCalledTimes(1);
    expect(payload().sceneDescription).toBe(sceneDescription);
    expect(payload().sceneDirectionGuidance).toContain("not complete spoken copy");
  });

  it.each(["", " \r\n\t "])("leaves the AI prompt unchanged for a blank scene direction %j", async sceneDescription => {
    await generateScript(input);
    const originalPrompt = model.create.mock.calls[0][0].messages;
    model.create.mockClear();
    model.replies = [reply()];
    await generateScript({ ...input, sceneDescription });
    expect(model.create.mock.calls[0][0].messages).toEqual(originalPrompt);
  });

  it("keeps a stale AI scene brief out of supplied-copy generation", async () => {
    const sceneDescription = "改成沙漠徒步的全新故事。";
    const [script] = await generateScript({ ...input, copyText: text, sceneDescription });
    expect(script.copyDocument).toMatchObject({ text, source: "user_provided" });
    expect(model.create).toHaveBeenCalledTimes(1);
    expect(payload()).not.toHaveProperty("sceneDescription");
    expect(payload()).not.toHaveProperty("sceneDirectionGuidance");
    expect(model.create.mock.calls[0][0].messages[1].content).not.toContain(sceneDescription);
  });

  it("uses one generation call for both batch and single-script entry points", async () => {
    const [script] = await generateScript(input);
    expect(script.shots).toHaveLength(7);
    expect(script.copyDocument?.text).toBe(text);
    expect(script.shots[0].tidewe?.visualPlan).toEqual(plan.scripts[0].shots[0].visualPlan);
    expect(model.create).toHaveBeenCalledTimes(1);
    expect(model.create.mock.calls[0][0]).not.toHaveProperty("stream");
    model.replies = [reply()];
    const regenerated = await generateSingleScript(input);
    expect(regenerated.styleType).toBe("tidewe_outdoor");
    expect(regenerated.shots).toHaveLength(7);
    expect(model.create).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, 2, 3])("emits one complete response through both stream adapters when requested count is %s", async count => {
    const generationInput = { ...input, count };
    const onToken = vi.fn();
    const scripts = await new Promise<unknown>((resolve, reject) => { generateScriptStream(generationInput, { onToken, onComplete: resolve, onError: reject }); });
    expect(scripts).toHaveLength(1);
    expect(onToken).toHaveBeenCalledTimes(1);
    expect(JSON.parse(onToken.mock.calls[0][0]).scripts[0].copyDocument.text).toBe(text);
    expect(model.create).toHaveBeenCalledTimes(1);
    model.replies = [reply()];
    const reader = createScriptStream(generationInput).getReader();
    const result = await reader.read();
    expect(JSON.parse(new TextDecoder().decode(result.value)).scripts[0].copyDocument.text).toBe(text);
    expect((await reader.read()).done).toBe(true);
    expect(model.create).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "missing copy", response: reply({ copies: [] }) },
    { name: "missing plan", response: reply(copy, { scripts: [] }) },
    { name: "empty shots", response: reply(copy, { scripts: [{ copyIndex: 0, shots: [] }] }) },
  ])("reports $name once without automatically asking the model to repair it", async ({ response }) => {
    model.replies = [response, reply()];
    await expect(generateScript(input)).rejects.toThrow();
    expect(model.create).toHaveBeenCalledTimes(1);
    expect(model.replies).toHaveLength(1);
  });

  it.each(shotTargets)("requests $shotCount shots for $targetDuration seconds during generation and regeneration", async ({ targetDuration, shotCount }) => {
    for (const imported of [false, true]) {
      model.create.mockClear();
      const fixture = countedPlanFixture([shotCount]);
      model.replies = [reply(fixture.copy, fixture.plan)];
      const durationInput = { ...input, creativeProfile: createTideweOutdoorProfile({ targetDuration }), ...(imported && { copyText: fixture.copy.copies[0].text }) };
      const [script] = await generateScript(durationInput);
      expect(script.shots).toHaveLength(shotCount);
      expect(script.copyDocument).toMatchObject({ text: fixture.copy.copies[0].text, source: imported ? "user_provided" : "ai_generated" });
      expect(model.create).toHaveBeenCalledTimes(1);
      expect(payload()).toMatchObject({ targetDuration, shotCount });
      model.replies = [reply(fixture.copy, fixture.plan)];
      const regenerated = await generateSingleScript(durationInput);
      expect(regenerated.shots).toHaveLength(shotCount);
      expect(model.create).toHaveBeenCalledTimes(2);
    }
  });

  it("requests eight shots for the default 40 second profile", async () => {
    const fixture = countedPlanFixture([8]);
    model.replies = [reply(fixture.copy, fixture.plan)];
    const [script] = await generateScript({ ...input, creativeProfile: undefined, targetDuration: undefined });
    expect(script.shots).toHaveLength(8);
    expect(payload()).toMatchObject({ targetDuration: 40, shotCount: 8 });
    expect(model.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    { targetDuration: 30, received: 6 }, { targetDuration: 30, received: 9 },
    { targetDuration: 40, received: 7 }, { targetDuration: 60, received: 10 },
  ] as const)("applies a $received-shot response for $targetDuration seconds without a quality repair", async ({ targetDuration, received }) => {
    const fixture = countedPlanFixture([received]);
    model.replies = [reply(fixture.copy, fixture.plan)];
    const [script] = await generateScript({ ...input, creativeProfile: createTideweOutdoorProfile({ targetDuration }) });
    expect(script.shots).toHaveLength(received);
    expect(script.copyDocument?.text).toBe(fixture.copy.copies[0].text);
    expect(model.create).toHaveBeenCalledTimes(1);
  });

  it.each([2, 3])("rejects a %s-copy response without a repair", async count => {
    const fixture = countedPlanFixture(Array.from({ length: count }, () => 7));
    model.replies = [reply(fixture.copy, fixture.plan), reply()];
    await expect(generateScript({ ...input, count })).rejects.toThrow(/Expected 1 full-copy candidates/);
    expect(model.create).toHaveBeenCalledTimes(1);
    expect(model.replies).toHaveLength(1);
  });

  it.each([
    { category: "hunting_blind", name: "TIDEWE hunting blind", expected: "hunting_blind" },
    { category: "waders", name: "TIDEWE waders", expected: "waders" },
    { category: "heated_apparel", name: "TIDEWE heated jacket", expected: "heated_gear" },
    { category: "hunting_apparel", name: "TIDEWE unheated jacket", expected: "apparel" },
    { category: "waterproof_boots", name: "TIDEWE hunting boots", expected: "boots" },
    { category: "hunting_chair", name: "TIDEWE hunting chair", expected: "accessories" },
    { category: "other", name: "Current unspecified item", expected: "unspecified" },
  ] as const)("passes $expected guidance in the single generation request", async ({ category, name, expected }) => {
    const facts: ProductFacts = { version: 1, brand: "TIDEWE", category, items: [] };
    const observations = "参考图2特写当前商品侧缘的半月形连接片与两层织物交界，保留这个局部主体。";
    const categoryInput = { ...input, productName: name, productFacts: facts, productAnalysis: observations };
    for (const imported of [false, true]) {
      model.create.mockClear();
      model.replies = [reply()];
      const [script] = await generateScript({ ...categoryInput, ...(imported && { copyText: text }) });
      expect(model.create).toHaveBeenCalledTimes(1);
      expect(payload().categoryGuidance).toEqual(buildTideweCategoryGuidance(category, { productName: name, visualObservations: observations }));
      expect(payload().categoryGuidance.category).toBe(expected);
      expect(payload().categoryGuidance.referenceAppearancePolicy).toMatch(/外观|形状/);
      expect(payload().product).toMatchObject({ name, visualObservations: observations, facts: { items: [] } });
      expect(script.copyDocument).toMatchObject({ text, source: imported ? "user_provided" : "ai_generated", factsSnapshot: { category: expected === "unspecified" ? "other" : expected } });
      if (imported) {
        expect(payload().frozenImportedCopy).toBe(text);
        expect(script.copyDocument?.exampleIds).toEqual([]);
      }
    }
  });

  it("passes observed boot appearance and directly applies product-free framing", async () => {
    const fixture = observedBootFixture();
    model.replies = [reply(fixture.frozenCopy, fixture.personOnly)];
    const [script] = await generateScript(fixture.bootInput);
    expect(model.create).toHaveBeenCalledTimes(1);
    expect(payload().product).toMatchObject({ name: fixture.bootInput.productName, visualObservations: fixture.visualObservations });
    expect(script.copyDocument).toMatchObject({ text: fixture.frozenText, productName: fixture.bootInput.productName, visualObservations: fixture.visualObservations, factsSnapshot: { items: [] } });
    expect(script.shots.map(shot => shot.voiceover)).toEqual(fixture.segments);
    expect(script.shots.every(shot => shot.tidewe?.productVisible === false)).toBe(true);
  });

  it.each([
    { framing: "detail", personVisible: true, delivery: "on_camera" },
    { framing: "detail", personVisible: false, delivery: undefined },
    { framing: "close_up", personVisible: false, delivery: "on_camera" },
  ])("binds off-camera narration to $framing framing without another model call", async ({ framing, personVisible, delivery }) => {
    const fixture = observedBootFixture();
    const planned = structuredClone(fixture.repaired);
    const plannedDetail = planned.scripts[0].shots[1];
    plannedDetail.visualPlan.framing = framing;
    plannedDetail.personVisible = personVisible;
    if (delivery === undefined) Reflect.deleteProperty(plannedDetail, "speechDelivery");
    else plannedDetail.speechDelivery = delivery;
    model.replies = [reply(fixture.frozenCopy, planned)];
    const [script] = await generateScript(fixture.bootInput);
    expect(model.create).toHaveBeenCalledTimes(1);
    expect(script.shots.map(shot => shot.voiceover)).toEqual(fixture.segments);
    const detail = script.shots[1];
    expect(detail).toMatchObject({ visualSource: "ai_generate", tidewe: { personVisible, productVisible: true, speechDelivery: "off_camera", visualPlan: plannedDetail.visualPlan } });
    const nativeVideo = compileTideweVisualPrompt(detail, "video", "on_camera", undefined, "native", { direction: preparedVideoDirection });
    expect(nativeVideo.prompt).toContain("off-camera narration");
    expect(nativeVideo.prompt).toContain(JSON.stringify(fixture.segments[1]));
    expect(nativeVideo.negativePrompt).toContain("visible speaking, lip synchronization");
  });

  it("keeps post-production voiceover and product-image details free of native speech delivery", async () => {
    const fixture = observedBootFixture();
    const planned = structuredClone(fixture.repaired);
    planned.scripts[0].shots.forEach(shot => { Reflect.deleteProperty(shot, "speechDelivery"); });
    Object.assign(planned.scripts[0].shots[1], { visualSource: "product_image" });
    model.replies = [reply(fixture.frozenCopy, planned)];
    const [script] = await generateScript({ ...fixture.bootInput, creativeProfile: createTideweOutdoorProfile({ targetDuration: 30, speechMode: "voiceover" }) });
    expect(model.create).toHaveBeenCalledTimes(1);
    expect(script.shots[1].visualSource).toBe("product_image");
    script.shots.forEach(shot => { expect(shot.tidewe).not.toHaveProperty("speechDelivery"); });
    expect(payload().outputFormat.scripts[0].shots[0]).not.toHaveProperty("speechDelivery");
  });

  it("retains generated visual wording without applying a content-quality gate", async () => {
    const generated = structuredClone(plan);
    generated.scripts[0].shots[0].prompt = "用热成像展示衣服温度。";
    model.replies = [reply(copy, generated)];
    const [script] = await generateScript(input);
    expect(script.shots[0].prompt).toBe(generated.scripts[0].shots[0].prompt);
    expect(model.create).toHaveBeenCalledTimes(1);
  });

  it("preserves imported punctuation and rejects a model rewrite of frozen narration without a repair", async () => {
    const original = "“Don't rush,” I say.\r\n\r\nWait.  Wait.\r\nCheck the fit.";
    const annotation = { ...copy.copies[0], text: "An attempted rewrite.", visualBeats: [{ text: "Replace the original!", visualRole: "invented", visualIdea: "随意改写原文。", factRefs: ["unsupported"] }] };
    const importedPlan = structuredClone(plan);
    importedPlan.scripts[0].shots = allocateShots(original, importedPlan.scripts[0].shots[0]);
    model.replies = [reply({ copies: [annotation] }, importedPlan)];
    const [script] = await generateScript({ ...input, copyText: original });
    expect(script.copyDocument).toMatchObject({ source: "user_provided", text: original });
    expect(script.copyDocument).not.toHaveProperty("visualBeats");
    expect(script.shots[0].tidewe?.copySpan.start).toBe(0);
    expect(script.shots.at(-1)?.tidewe?.copySpan.end).toBe(original.length);
    for (const shot of script.shots) expect(original.slice(shot.tidewe!.copySpan.start, shot.tidewe!.copySpan.end)).toBe(shot.voiceover);
    expect(model.create).toHaveBeenCalledTimes(1);

    model.create.mockClear();
    importedPlan.scripts[0].shots[0].scriptSegment = "A rewritten opening.";
    model.replies = [reply({ copies: [annotation] }, importedPlan), reply()];
    await expect(generateScript({ ...input, copyText: original })).rejects.toThrow(/rewrote|reordered/);
    expect(model.create).toHaveBeenCalledTimes(1);
  });

  it("applies a 14-word shot at five seconds without the previous 5.7-second rejection", async () => {
    const rushed = structuredClone(plan);
    rushed.scripts[0].shots = [{ ...rushed.scripts[0].shots[0], scriptSegment: text, duration: 5 }];
    model.replies = [reply(copy, rushed)];
    const [script] = await generateScript(input);
    expect(script.shots[0]).toMatchObject({ voiceover: text, duration: 5 });
    expect(script.copyDocument?.wordCount).toBe(14);
    expect(model.create).toHaveBeenCalledTimes(1);
  });

  it("preserves AI paragraph breaks and internal spaces while mapping the returned narration", async () => {
    const original = "Walking  warms you up.\r\n\r\nWaiting feels different.";
    const generatedCopy = { copies: [{ ...copy.copies[0], text: original }] };
    const generatedPlan = { scripts: [{ copyIndex: 0, shots: [{ ...plan.scripts[0].shots[0], scriptSegment: original }] }] };
    model.replies = [reply(generatedCopy, generatedPlan)];
    const [script] = await generateScript(input);
    expect(script.copyDocument?.text).toBe(original);
    expect(script.shots[0].voiceover).toBe(original);
    expect(script.shots[0].tidewe?.copySpan).toEqual({ start: 0, end: original.length });
    expect(model.create).toHaveBeenCalledTimes(1);
  });

  it("applies repeated presenter views and a long copy without requesting a rewrite", async () => {
    const longText = `${text} ${text} ${text} ${text} ${text} ${text}`;
    const generatedCopy = { copies: [{ ...copy.copies[0], text: longText }] };
    const generatedPlan = { scripts: [{ copyIndex: 0, shots: allocateShots(longText, plan.scripts[0].shots[0]).map(shot => ({ ...shot, duration: 2, visualPlan: { ...shot.visualPlan, framing: "medium", visualRole: "presenter" } })) }] };
    model.replies = [reply(generatedCopy, generatedPlan)];
    const [script] = await generateScript(input);
    expect(script.copyDocument?.text).toBe(longText);
    expect(new Set(script.shots.map(shot => shot.tidewe?.visualPlan?.framing))).toEqual(new Set(["medium"]));
    expect(model.create).toHaveBeenCalledTimes(1);
  });
});
