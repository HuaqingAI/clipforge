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
const input: ScriptInput = { productName: "TIDEWE outdoor jacket", category: "fashion", styleType: "tidewe_outdoor", creativeProfile: createTideweOutdoorProfile(), count: 1, llmConfig: { baseUrl: "https://example.test/v1", apiKey: "test", model: "test" } };
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
function allocateSevenShots(frozenText: string, seed: PlannedShot): PlannedShot[] {
  const words = [...frozenText.matchAll(/\S+/g)];
  const segments = Array.from({ length: 7 }, (_, index) => {
    const startWord = Math.floor(index * words.length / 7);
    const endWord = Math.floor((index + 1) * words.length / 7) - 1;
    return frozenText.slice(words[startWord].index, words[endWord].index! + words[endWord][0].length);
  });
  return segments.map((scriptSegment, index) => ({
    ...structuredClone(seed), scriptSegment, duration: 3,
    shotGoal: `观察当前商品第${index + 1}处外观与使用状态`,
    visualPlan: { ...seed.visualPlan, framing: ["medium", "close_up", "wide"][index % 3], visualRole: index === 1 ? "detail" : "demonstration", action: `观察当前商品第${index + 1}处可见状态。` },
  }));
}
plan.scripts[0].shots = allocateSevenShots(text, plan.scripts[0].shots[0]).map((shot, index) => ({ ...shot, scriptSegment: planSegments[index] }));

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
beforeEach(() => {
  model.replies = [copy, plan];
  model.create.mockReset().mockImplementation(async () => ({ choices: [{ message: { content: JSON.stringify(model.replies.shift()) } }] }));
});
describe("shared TIDEWE generator dispatch", () => {
  it("routes batch and single generation through two complete-copy stages", async () => {
    const scripts = await generateScript(input);
    expect(scripts[0].shots).toHaveLength(7);
    expect(scripts[0].copyDocument?.text).toBe(text);
    expect(scripts[0].copyDocument?.visualBeats).toEqual(visualBeats);
    expect(scripts[0].shots[0].tidewe?.visualPlan).toEqual(plan.scripts[0].shots[0].visualPlan);
    expect(model.create).toHaveBeenCalledTimes(2);
    const params = model.create.mock.calls.map(([p]) => p);
    expect(params.every(p => !p.stream && p.messages[0].content.includes("TIDEWE"))).toBe(true);
    expect(JSON.parse(params[1].messages[1].content).copies[0].visualBeats).toEqual(visualBeats);
    model.replies = [copy, plan];
    const regenerated = await generateSingleScript(input);
    expect(regenerated.styleType).toBe("tidewe_outdoor");
    expect(regenerated.shots).toHaveLength(7);
    expect(model.create).toHaveBeenCalledTimes(4);
  });
  it("emits only validated completion for both stream adapters", async () => {
    const onToken = vi.fn();
    const scripts = await new Promise<unknown>((resolve, reject) => { generateScriptStream(input, { onToken, onComplete: resolve, onError: reject }); });
    expect(scripts).toHaveLength(1);
    expect(onToken).toHaveBeenCalledTimes(1);
    expect(JSON.parse(onToken.mock.calls[0][0]).scripts[0].copyDocument.text).toBe(text);
    model.replies = [copy, plan];
    const reader = createScriptStream(input).getReader();
    const result = await reader.read();
    expect(JSON.parse(new TextDecoder().decode(result.value)).scripts[0].copyDocument.text).toBe(text);
    expect((await reader.read()).done).toBe(true);
  });
  it("repairs each invalid stage once, retaining frozen copy during planner repair", async () => {
    model.replies = [{ copies: [] }, copy, { scripts: [] }, plan];
    expect((await generateScript(input))[0].copyDocument?.text).toBe(text);
    expect(model.create).toHaveBeenCalledTimes(4);
    expect(model.create.mock.calls[3][0].messages[1].content).toContain(text);
    expect(model.create.mock.calls[3][0].messages).toHaveLength(4);
  });
  it("fails after one planner repair instead of returning sales fallback or partial copy", async () => {
    model.replies = [copy, { scripts: [] }, { scripts: [] }];
    await expect(generateScript(input)).rejects.toThrow(/every frozen copy/);
    expect(model.create).toHaveBeenCalledTimes(3);
  });

  it.each([7, 8, 9])("accepts %i shots per AI or supplied copy without spending a repair", async shotCount => {
    for (const imported of [false, true]) {
      model.create.mockClear();
      const fixture = countedPlanFixture([shotCount]);
      model.replies = [fixture.copy, fixture.plan];
      const [script] = await generateScript({ ...input, ...(imported && { copyText: fixture.copy.copies[0].text }) });
      expect(script.shots).toHaveLength(shotCount);
      expect(script.copyDocument?.text).toBe(fixture.copy.copies[0].text);
      expect(script.copyDocument?.source).toBe(imported ? "user_provided" : "ai_generated");
      expect(model.create).toHaveBeenCalledTimes(2);
      expect(JSON.parse(model.create.mock.calls[1][0].messages[1].content).shotCount).toEqual({ min: 7, max: 9 });
    }
  });

  it.each([6, 10])("rejects %i-shot AI and supplied-copy plans after the existing single repair", async shotCount => {
    for (const imported of [false, true]) {
      model.create.mockClear();
      const fixture = countedPlanFixture([shotCount]);
      model.replies = [fixture.copy, fixture.plan, fixture.plan];
      await expect(generateScript({ ...input, ...(imported && { copyText: fixture.copy.copies[0].text }) })).rejects.toThrow(new RegExp(`copy 1.*7-9 shots.*received ${shotCount}`, "i"));
      expect(model.create).toHaveBeenCalledTimes(3);
      expect(model.create.mock.calls[2][0].messages).toHaveLength(4);
    }
  });

  it("keeps every candidate within 7-9 shots independently", async () => {
    const fixture = countedPlanFixture([7, 8, 9]);
    model.replies = [fixture.copy, fixture.plan];
    const scripts = await generateScript({ ...input, count: 3 });
    expect(scripts.map(script => script.shots.length)).toEqual([7, 8, 9]);
    expect(scripts.map(script => script.copyDocument?.text)).toEqual(fixture.copy.copies.map(candidate => candidate.text));
    expect(model.create).toHaveBeenCalledTimes(2);
  });

  it.each([
    { counts: [6, 8, 9], invalidCopy: 1, received: 6 },
    { counts: [7, 6, 9], invalidCopy: 2, received: 6 },
    { counts: [7, 8, 6], invalidCopy: 3, received: 6 },
    { counts: [7, 10, 9], invalidCopy: 2, received: 10 },
  ])("rejects candidate $invalidCopy with $received shots even when other candidates satisfy the range", async ({ counts, invalidCopy, received }) => {
    const fixture = countedPlanFixture(counts);
    model.replies = [fixture.copy, fixture.plan, fixture.plan];
    await expect(generateScript({ ...input, count: 3 })).rejects.toThrow(new RegExp(`copy ${invalidCopy}.*7-9 shots.*received ${received}`, "i"));
    expect(model.create).toHaveBeenCalledTimes(3);
  });

  it.each([6, 10])("repairs a %i-shot plan by reallocating the same frozen copy without regenerating prose", async shotCount => {
    const fixture = countedPlanFixture([shotCount === 6 ? 7 : 10]);
    const merged = structuredClone(fixture.plan);
    const shots = merged.scripts[0].shots;
    const ending = shots.pop()!;
    shots.at(-1)!.scriptSegment += ` ${ending.scriptSegment}`;
    shots.at(-1)!.duration += ending.duration;
    const initialPlan = shotCount === 6 ? merged : fixture.plan;
    const repairedPlan = shotCount === 6 ? fixture.plan : merged;
    model.replies = [fixture.copy, initialPlan, repairedPlan];
    const [script] = await generateScript(input);
    expect(script.shots).toHaveLength(shotCount === 6 ? 7 : 9);
    expect(script.copyDocument?.text).toBe(fixture.copy.copies[0].text);
    expect(script.shots.map(shot => shot.voiceover).join(" ")).toBe(fixture.copy.copies[0].text);
    expect(model.create).toHaveBeenCalledTimes(3);
    expect(model.create.mock.calls[2][0].messages[1].content).toBe(model.create.mock.calls[1][0].messages[1].content);
    expect(model.create.mock.calls[2][0].messages[3].content).toContain("7-9 shots");
  });

  it("does not emit an undersized candidate while the planner repair is rejected", async () => {
    const fixture = countedPlanFixture([6]);
    model.replies = [fixture.copy, fixture.plan, fixture.plan];
    const onToken = vi.fn();
    const onComplete = vi.fn();
    await expect(new Promise((resolve, reject) => {
      generateScriptStream(input, { onToken, onComplete: scripts => { onComplete(scripts); resolve(scripts); }, onError: reject });
    })).rejects.toThrow(/7-9 shots/);
    expect(onToken).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it.each([
    { category: "hunting_blind", name: "TIDEWE hunting blind", expected: "hunting_blind" },
    { category: "waders", name: "TIDEWE waders", expected: "waders" },
    { category: "heated_apparel", name: "TIDEWE heated jacket", expected: "heated_gear" },
    { category: "hunting_apparel", name: "TIDEWE unheated jacket", expected: "apparel" },
    { category: "waterproof_boots", name: "TIDEWE hunting boots", expected: "boots" },
    { category: "hunting_chair", name: "TIDEWE hunting chair", expected: "accessories" },
    { category: "other", name: "Current unspecified item", expected: "unspecified" },
    { category: "配件", name: "TIDEWE hunting chair", expected: "accessories" },
    { category: "clothing", name: "TIDEWE unheated jacket", expected: "apparel" },
    { category: "other", hint: "配件", hintOnly: true, name: "TIDEWE hunting chair", expected: "accessories" },
    { category: "other", hint: "boots", name: "Current unspecified item", expected: "unspecified" },
    { category: "unknown_category", hint: "boots", name: "Current unspecified item", expected: "unspecified" },
  ] as const)("injects $expected guidance in both actual generation stages without extra calls or rewriting imported copy", async fixture => {
    const { category, name, expected } = fixture;
    const hint = "hint" in fixture ? fixture.hint : undefined;
    const hintOnly = "hintOnly" in fixture && fixture.hintOnly;
    const facts: ProductFacts = { version: 1, brand: "TIDEWE", category: category as ProductFacts["category"], items: [] };
    const observations = "当前参考可见商品外形、表面与既有接触位置。";
    const categoryInput = { ...input, productName: name, productFacts: hintOnly ? undefined : facts, productCategoryHint: hint, productAnalysis: observations };
    const originalFacts = structuredClone(facts);
    for (const imported of [false, true]) {
      model.create.mockClear();
      const frozenText = imported ? "“Look at this part.”\r\n\r\nCheck.  Check the current product." : "Look at this part. Check the current product before your next trip.";
      const beats = [{ text: frozenText, visualRole: "demonstration", visualIdea: "人物已扶住当前参考商品，轻触可见边缘后停稳。", factRefs: [] }];
      const categoryCopy = { copies: [{ ...copy.copies[0], text: imported ? "An attempted rewrite." : frozenText, visualBeats: beats }] };
      const categoryPlan = { scripts: [{ copyIndex: 0, shots: [{ ...structuredClone(plan.scripts[0].shots[0]), scriptSegment: frozenText,
        description: "人物在真实户外环境中已扶住当前参考商品，轻触可见边缘后保持稳定。", shotGoal: "观察当前参考商品与接触位置。",
        visualIntent: "呈现当前商品普通接触状态。", prompt: "真实户外自然光，当前参考商品与接触的手完整入画。",
        visualPlan: { framing: "medium", visualRole: "demonstration", productFocus: "当前参考商品的完整轮廓与手部接触处", actionStart: "人物已站稳并扶住当前商品。", action: "轻触当前商品的可见边缘一次。", actionEnd: "手与商品保持稳定支撑。" } }] }] };
      categoryPlan.scripts[0].shots = allocateSevenShots(frozenText, categoryPlan.scripts[0].shots[0]);
      model.replies = [categoryCopy, categoryPlan];
      const [script] = await generateScript({ ...categoryInput, ...(imported && { copyText: frozenText }) });
      expect(model.create).toHaveBeenCalledTimes(2);
      const copyPayload = JSON.parse(model.create.mock.calls[0][0].messages[1].content);
      const planPayload = JSON.parse(model.create.mock.calls[1][0].messages[1].content);
      const guidance = buildTideweCategoryGuidance(hintOnly ? hint : category, { productName: name, visualObservations: observations });
      expect(copyPayload.categoryGuidance).toEqual(guidance);
      expect(planPayload.categoryGuidance).toEqual(guidance);
      expect(planPayload.categoryGuidance.category).toBe(expected);
      expect(planPayload.product).toEqual({ name, visualObservations: observations });
      expect(planPayload.copies[0].text).toBe(frozenText);
      expect(script.copyDocument).toMatchObject({ text: frozenText, source: imported ? "user_provided" : "ai_generated", factsSnapshot: { category: expected === "unspecified" ? "other" : expected } });
      expect(script.shots).toHaveLength(7);
      expect(script.shots.map(shot => shot.voiceover).join(" ").replace(/\s+/g, " ")).toBe(frozenText.replace(/\s+/g, " "));
      expect(facts).toEqual(originalFacts);
      if (imported) {
        expect(copyPayload.frozenImportedCopy).toBe(frozenText);
        expect(copyPayload.categoryGuidanceUse).toContain("Visual planning only");
        expect(planPayload.copies[0]).not.toHaveProperty("visualBeats");
        expect(script.copyDocument?.exampleIds).toEqual([]);
      } else {
        expect(planPayload.copies[0].visualBeats).toEqual(beats);
        if (["boots", "apparel", "unspecified"].includes(expected)) expect(script.copyDocument?.exampleIds).toEqual([]);
        if (expected === "accessories") expect(script.copyDocument?.exampleIds.every(id => /^THC00[34]-/.test(id))).toBe(true);
      }
    }
  });

  it("passes observed boot appearance to planning and repairs a product-free plan without rewriting frozen copy", async () => {
    const fixture = observedBootFixture();
    model.replies = [fixture.frozenCopy, fixture.personOnly, fixture.repaired];
    const [script] = await generateScript(fixture.bootInput);
    expect(model.create).toHaveBeenCalledTimes(3);
    const copyPrompt = JSON.parse(model.create.mock.calls[0][0].messages[1].content);
    const planPrompt = JSON.parse(model.create.mock.calls[1][0].messages[1].content);
    expect(copyPrompt.product).toMatchObject({ name: fixture.bootInput.productName, visualObservations: fixture.visualObservations, facts: { items: [] } });
    expect(planPrompt.product).toEqual({ name: fixture.bootInput.productName, visualObservations: fixture.visualObservations });
    expect(planPrompt.facts.items).toEqual([]);
    expect(planPrompt.copies[0]).toMatchObject({ text: fixture.frozenText, visualBeats: fixture.beats });
    expect(JSON.parse(model.create.mock.calls[2][0].messages[1].content)).toEqual(planPrompt);
    expect(model.create.mock.calls[2][0].messages).toHaveLength(4);
    expect(model.create.mock.calls[2][0].messages[3].content).toMatch(/product|storyboard|item/i);
    expect(script.copyDocument).toMatchObject({ text: fixture.frozenText, visualBeats: fixture.beats, productName: fixture.bootInput.productName, visualObservations: fixture.visualObservations, factsSnapshot: { items: [] } });
    expect(script.shots.map(shot => shot.voiceover)).toEqual(fixture.segments);
    expect(script.shots.map(shot => shot.tidewe?.productVisible)).toEqual([true, true, false, true, true, true, true]);
    expect(script.shots[0].tidewe).toMatchObject({ personVisible: true, visualPlan: { visualRole: "demonstration", productFocus: "穿在脚上的迷彩高筒靴与地面接触关系" } });
    expect(script.shots[1].tidewe).toMatchObject({ speechDelivery: "off_camera", visualPlan: { framing: "close_up", visualRole: "detail", productFocus: "完整高筒轮廓、迷彩边界与黑色鞋底沟槽" } });
    for (const shot of script.shots) {
      expect(fixture.frozenText.slice(shot.tidewe!.copySpan.start, shot.tidewe!.copySpan.end)).toBe(shot.voiceover);
    }
  });

  it("rejects a second product-free plan without emitting a partial or completed script to save", async () => {
    const fixture = observedBootFixture();
    model.replies = [fixture.frozenCopy, fixture.personOnly, fixture.personOnly];
    const onToken = vi.fn();
    const onComplete = vi.fn();
    const result = new Promise<unknown>((resolve, reject) => {
      generateScriptStream(fixture.bootInput, { onToken, onComplete: scripts => { onComplete(scripts); resolve(scripts); }, onError: reject });
    });
    await expect(result).rejects.toThrow(/product|storyboard|item/i);
    expect(model.create).toHaveBeenCalledTimes(3);
    expect(model.create.mock.calls.map(([params]) => params.messages.length)).toEqual([2, 2, 4]);
    expect(JSON.parse(model.create.mock.calls[2][0].messages[1].content).copies[0]).toMatchObject({ text: fixture.frozenText, visualBeats: fixture.beats });
    expect(onToken).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(model.replies).toEqual([]);
  });

  it.each([
    { framing: "detail", personVisible: true, delivery: "on_camera" },
    { framing: "detail", personVisible: false, delivery: "on_camera" },
    { framing: "detail", personVisible: true, delivery: undefined },
    { framing: "detail", personVisible: false, delivery: undefined },
    { framing: "close_up", personVisible: false, delivery: "on_camera" },
    { framing: "close_up", personVisible: false, delivery: undefined },
  ])("uses off-camera narration without a repair for $framing, personVisible=$personVisible, delivery=$delivery", async ({ framing, personVisible, delivery }) => {
    const fixture = observedBootFixture();
    const planned = structuredClone(fixture.repaired);
    const plannedDetail = planned.scripts[0].shots[1];
    plannedDetail.visualPlan.framing = framing;
    plannedDetail.personVisible = personVisible;
    if (delivery === undefined) Reflect.deleteProperty(plannedDetail, "speechDelivery");
    else plannedDetail.speechDelivery = delivery;
    if (personVisible) {
      plannedDetail.description = "画面只包含人物的双手与当前高筒靴，手已扶住靴筒外侧，完整靴筒轮廓清楚可见。";
      plannedDetail.prompt = "林边中性散射光，只取双手、完整靴筒与黑色鞋底边缘，面部在画幅外。";
      plannedDetail.visualPlan.actionStart = "双手已扶稳当前高筒靴，完整靴筒清楚入画。";
    }
    const expectedPlan = structuredClone(plannedDetail.visualPlan);
    model.replies = [fixture.frozenCopy, planned];

    const [script] = await generateScript(fixture.bootInput);
    expect(model.create).toHaveBeenCalledTimes(2);
    expect(model.create.mock.calls.map(([params]) => params.messages.length)).toEqual([2, 2]);
    expect(model.replies).toEqual([]);
    expect(script.copyDocument).toMatchObject({ text: fixture.frozenText, visualBeats: fixture.beats });
    expect(script.shots.map(shot => shot.voiceover)).toEqual(fixture.segments);
    for (const shot of script.shots) {
      expect(fixture.frozenText.slice(shot.tidewe!.copySpan.start, shot.tidewe!.copySpan.end)).toBe(shot.voiceover);
    }
    const detail = script.shots[1];
    expect(detail).toMatchObject({ description: plannedDetail.description, camera: plannedDetail.camera, prompt: plannedDetail.prompt, visualSource: "ai_generate", tidewe: { personVisible, productVisible: true, speechDelivery: "off_camera", visualPlan: expectedPlan } });
    expect(detail.tidewe?.visualPlan).toEqual(expectedPlan);
    expect(script.shots[2].tidewe?.speechDelivery).toBe("on_camera");

    const firstFrame = compileTideweVisualPrompt(detail, "image", "on_camera");
    const nativeVideo = compileTideweVisualPrompt(detail, "video", "on_camera");
    const postVideo = compileTideweVisualPrompt(detail, "video", "on_camera", undefined, "post");
    for (const compiled of [firstFrame, nativeVideo, postVideo]) {
      expect(compiled.prompt).toContain("完整高筒轮廓、迷彩边界与黑色鞋底沟槽");
      expect(compiled.prompt).toContain("不要求出现脸部或嘴部");
      expect(compiled.prompt).not.toContain("本镜为写实成年户外使用者真人口播");
      expect(compiled.prompt).not.toContain("must visibly articulate");
      expect(compiled.prompt).not.toContain("lips, jaw and mouth must move");
      expect(compiled.negativePrompt).toContain("说话口型");
    }
    expect(nativeVideo.prompt).toContain("Generate native audio and video with off-camera narration.");
    expect(nativeVideo.prompt).toContain(JSON.stringify(fixture.segments[1]));
    expect(postVideo.prompt).toContain("no speaking or lip synchronization");
    expect(postVideo.prompt).toContain("No audio track.");
  });

  it("keeps global post-production voiceover and product-image details free of native speech delivery", async () => {
    const fixture = observedBootFixture();
    const planned = structuredClone(fixture.repaired);
    planned.scripts[0].shots.forEach(shot => { Reflect.deleteProperty(shot, "speechDelivery"); });
    const plannedDetail = planned.scripts[0].shots[1];
    plannedDetail.visualPlan.framing = "detail";
    Object.assign(plannedDetail, { visualSource: "product_image" });
    model.replies = [fixture.frozenCopy, planned];

    const [script] = await generateScript({ ...fixture.bootInput, creativeProfile: createTideweOutdoorProfile({ speechMode: "voiceover" }) });
    expect(model.create).toHaveBeenCalledTimes(2);
    expect(script.copyDocument?.text).toBe(fixture.frozenText);
    expect(script.shots.map(shot => shot.voiceover)).toEqual(fixture.segments);
    script.shots.forEach(shot => { expect(shot.tidewe).not.toHaveProperty("speechDelivery"); });
    const detail = script.shots[1];
    expect(detail).toMatchObject({ visualSource: "product_image", tidewe: { personVisible: false, productVisible: true, visualPlan: plannedDetail.visualPlan } });
    const compiled = compileTideweVisualPrompt(detail, "video", "voiceover");
    expect(compiled.prompt).toContain("英文画外旁白由后期统一添加");
    expect(compiled.prompt).not.toContain("Generate native audio and video");
    expect(compiled.negativePrompt).toContain("说话口型");
    expect(JSON.parse(model.create.mock.calls[1][0].messages[1].content).outputFormat.scripts[0].shots[0]).not.toHaveProperty("speechDelivery");
  });

  it.each([
    { delivery: undefined, expected: "on_camera" },
    { delivery: "off_camera", expected: "off_camera" },
  ])("preserves visible close-up speech choice: delivery=$delivery", async ({ delivery, expected }) => {
    const planned = structuredClone(plan);
    const visibleCloseUp = planned.scripts[0].shots[0];
    visibleCloseUp.visualPlan.framing = "close_up";
    Object.assign(visibleCloseUp, { personVisible: true });
    if (delivery !== undefined) Object.assign(visibleCloseUp, { speechDelivery: delivery });
    model.replies = [copy, planned];

    const [script] = await generateScript(input);
    expect(model.create).toHaveBeenCalledTimes(2);
    expect(script.copyDocument?.text).toBe(text);
    expect(script.shots[0].tidewe).toMatchObject({ personVisible: true, speechDelivery: expected, visualPlan: { framing: "close_up" } });
    const compiled = compileTideweVisualPrompt(script.shots[0], "video", "on_camera");
    if (expected === "on_camera") {
      expect(compiled.prompt).toContain("Generate native synchronized audio and video.");
      expect(compiled.negativePrompt).not.toContain("说话口型");
    } else {
      expect(compiled.prompt).toContain("Generate native audio and video with off-camera narration.");
      expect(compiled.negativePrompt).toContain("说话口型");
    }
  });

  it.each([
    { framing: "detail", personVisible: true },
    { framing: "close_up", personVisible: false },
  ])("rejects an invalid speech choice before normalizing $framing, personVisible=$personVisible", async ({ framing, personVisible }) => {
    const fixture = observedBootFixture();
    const invalidPlan = structuredClone(fixture.repaired);
    const detail = invalidPlan.scripts[0].shots[1];
    detail.visualPlan.framing = framing;
    detail.personVisible = personVisible;
    detail.speechDelivery = "silent";
    model.replies = [fixture.frozenCopy, invalidPlan, invalidPlan];

    await expect(generateScript(fixture.bootInput)).rejects.toThrow(/Invalid shot speechDelivery/);
    expect(model.create).toHaveBeenCalledTimes(3);
    expect(model.create.mock.calls.map(([params]) => params.messages.length)).toEqual([2, 2, 4]);
    expect(JSON.parse(model.create.mock.calls[2][0].messages[1].content).copies[0]).toMatchObject({ text: fixture.frozenText, visualBeats: fixture.beats });
  });

  it("accepts explicit visual prohibitions without spending a planner repair", async () => {
    const safePlan = structuredClone(plan);
    safePlan.scripts[0].shots[0].prompt = "林边真实自然光。不生成热成像、发光热区或透视剖面，也不展示独立电池。";
    model.replies = [copy, safePlan];
    const [script] = await generateScript(input);
    expect(script.copyDocument?.text).toBe(text);
    expect(script.shots[0].prompt).toContain("不生成热成像");
    expect(model.create).toHaveBeenCalledTimes(2);
  });

  it("repairs a positive prohibited visual while retaining the frozen copy", async () => {
    const unsafePlan = structuredClone(plan);
    unsafePlan.scripts[0].shots[0].prompt = "用热成像展示衣服温度。";
    model.replies = [copy, unsafePlan, plan];
    const [script] = await generateScript(input);
    expect(script.copyDocument?.text).toBe(text);
    expect(script.shots[0].prompt).toBe(plan.scripts[0].shots[0].prompt);
    expect(model.create).toHaveBeenCalledTimes(3);
    expect(model.create.mock.calls[2][0].messages[1].content).toContain(text);
  });

  it("still rejects a repeated positive prohibited visual after the single repair", async () => {
    const unsafePlan = structuredClone(plan);
    unsafePlan.scripts[0].shots[0].shotGoal = "使用发光热区展示加热功能。";
    model.replies = [copy, unsafePlan, unsafePlan];
    await expect(generateScript(input)).rejects.toThrow(/镜头\s*1.*发光热区/);
    expect(model.create).toHaveBeenCalledTimes(3);
  });

  it("preserves imported punctuation and ignores unexpected AI visual beats without a repair", async () => {
    const original = "“Don't rush,” I say.\r\n\r\nWait.  Wait.\r\nCheck the fit.";
    const annotation = { ...copy.copies[0], text: "An attempted rewrite.", visualBeats: [{ text: "Replace the original!", visualRole: "invented", visualIdea: "随意改写原文。", factRefs: ["unsupported"] }] };
    const importedPlan = structuredClone(plan);
    importedPlan.scripts[0].shots = allocateSevenShots(original, importedPlan.scripts[0].shots[0]);
    model.replies = [{ copies: [annotation] }, importedPlan];
    const [script] = await generateScript({ ...input, copyText: original });
    expect(script.copyDocument).toMatchObject({ source: "user_provided", text: original });
    expect(script.copyDocument).not.toHaveProperty("visualBeats");
    expect(script.shots).toHaveLength(7);
    expect(script.shots.map(shot => shot.voiceover).join(" ").replace(/\s+/g, " ")).toBe(original.replace(/\s+/g, " "));
    expect(script.shots[0].tidewe?.copySpan.start).toBe(0);
    expect(script.shots.at(-1)?.tidewe?.copySpan.end).toBe(original.length);
    for (const shot of script.shots) {
      expect(original.slice(shot.tidewe!.copySpan.start, shot.tidewe!.copySpan.end)).toBe(shot.voiceover);
    }
    expect(JSON.parse(model.create.mock.calls[1][0].messages[1].content).copies[0]).not.toHaveProperty("visualBeats");
    expect(model.create).toHaveBeenCalledTimes(2);
  });

  it("repairs a spoken duration that leaves too little settling time without changing the copy", async () => {
    const rushedPlan = structuredClone(plan);
    rushedPlan.scripts[0].shots[0].duration = 1.5;
    model.replies = [copy, rushedPlan, plan];
    const [script] = await generateScript(input);
    expect(script.shots[0].duration).toBe(3);
    expect(script.copyDocument?.text).toBe(text);
    expect(script.copyDocument?.visualBeats).toEqual(visualBeats);
    expect(model.create).toHaveBeenCalledTimes(3);
    expect(JSON.parse(model.create.mock.calls[2][0].messages[1].content).copies[0]).toMatchObject({ text, visualBeats });
    expect(model.create.mock.calls[2][0].messages).toHaveLength(4);
  });

  it("reserves settling time for at least seven shots before freezing AI copy with only one meaning beat", async () => {
    const withinBudget = "Before you choose your jacket, look at how it sits on your shoulders. Check the visible sleeve shape while your hands rest naturally by your sides. Then compare the outer fabric and the seam with the product pictures. I would use this view to decide what to inspect more closely. Keep the actual fit and your own trip in mind before you choose the gear you want to bring along next time.";
    const budgetCopy = (frozenText: string) => ({ copies: [{ ...copy.copies[0], text: frozenText,
      visualBeats: [{ text: frozenText, visualRole: "demonstration", visualIdea: "观察当前外套的可见轮廓与实际穿着状态。", factRefs: [] }],
    }] });
    const repairedCopy = budgetCopy(withinBudget);
    const budgetPlan = { scripts: [{ copyIndex: 0, shots: allocateSevenShots(withinBudget, plan.scripts[0].shots[0]).map(shot => ({ ...shot, duration: 5 })) }] };
    // Both copies fit 30s with one beat pause; only the 72-word copy also reserves seven shot pauses.
    model.replies = [budgetCopy(`${withinBudget} Carefully.`), repairedCopy, budgetPlan];
    const [script] = await generateScript({ ...input, creativeProfile: createTideweOutdoorProfile({ targetDuration: 30 }) });
    expect(script.copyDocument).toMatchObject({ text: withinBudget, wordCount: 72, visualBeats: repairedCopy.copies[0].visualBeats });
    expect(script.shots).toHaveLength(7);
    expect(model.create).toHaveBeenCalledTimes(3);
    expect(model.create.mock.calls[1][0].messages).toHaveLength(4);
    expect(model.create.mock.calls[1][0].messages[3].content).toContain("conversational speech budget");
    expect(model.create.mock.calls[2][0].messages).toHaveLength(2);
    expect(JSON.parse(model.create.mock.calls[2][0].messages[1].content).copies[0].text).toBe(withinBudget);
  });

  it("repairs seven repeated presenter medium shots into varied views using the same frozen copy", async () => {
    const segments = ["First, check how it sits.", "Look at the outer fabric.", "See the trail around you.", "Move one sleeve a little.", "Then look back at me.", "Notice the seam up close.", "Check the fit before heading out."];
    const frozenText = segments.join(" ");
    const roles = ["presenter", "detail", "context", "demonstration", "presenter", "detail", "context"];
    const framings = ["medium", "detail", "wide", "close_up", "medium", "detail", "wide"];
    const beats = segments.map((segment, index) => ({ text: segment, visualRole: roles[index], visualIdea: `观察林边装备的第${index + 1}处可见状态。`, factRefs: [] }));
    const frozenCopy = { copies: [{ ...copy.copies[0], text: frozenText, visualBeats: beats }] };
    const repeated = { scripts: [{ copyIndex: 0, shots: segments.map((segment) => ({ ...structuredClone(plan.scripts[0].shots[0]), scriptSegment: segment, duration: 6, visualPlan: { ...plan.scripts[0].shots[0].visualPlan, visualRole: "presenter" } })) }] };
    const varied = structuredClone(repeated);
    varied.scripts[0].shots.forEach((shot, index) => {
      shot.visualPlan = { framing: framings[index], visualRole: roles[index], productFocus: `当前外套第${index + 1}处可见穿着状态与面料轮廓`, actionStart: `装备第${index + 1}处已经稳定入画。`, action: `静态观察第${index + 1}处已有穿着状态。`, actionEnd: "保持当前稳定构图。" };
      shot.shotGoal = `展现第${index + 1}处可见状态。`;
      Object.assign(shot, { speechDelivery: roles[index] === "presenter" ? "on_camera" : "off_camera", personVisible: roles[index] !== "context" });
    });
    model.replies = [frozenCopy, repeated, varied];
    const [script] = await generateScript(input);
    expect(model.create).toHaveBeenCalledTimes(3);
    expect(script.copyDocument?.text).toBe(frozenText);
    expect(script.copyDocument?.visualBeats).toEqual(beats);
    expect(script.shots.map(shot => shot.voiceover)).toEqual(segments);
    expect(new Set(script.shots.map(shot => shot.tidewe?.visualPlan?.framing)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(script.shots.map(shot => shot.tidewe?.visualPlan?.visualRole)).size).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(model.create.mock.calls[2][0].messages[1].content).copies[0]).toMatchObject({ text: frozenText, visualBeats: beats });
    expect(model.create.mock.calls[2][0].messages).toHaveLength(4);
  });

  it.each([
    { name: "missing visualPlan", mutate: (shot: PlannedShot) => { Reflect.deleteProperty(shot, "visualPlan"); } },
    { name: "unsupported framing", mutate: (shot: PlannedShot) => { shot.visualPlan.framing = "portrait"; } },
    { name: "English action start", mutate: (shot: PlannedShot) => { shot.visualPlan.actionStart = "Hand beside the jacket"; } },
    { name: "missing product focus", mutate: (shot: PlannedShot) => { Reflect.deleteProperty(shot.visualPlan, "productFocus"); } },
  ])("rejects $name after the existing single planner repair", async ({ mutate }) => {
    const invalidPlan = structuredClone(plan);
    mutate(invalidPlan.scripts[0].shots[0]);
    model.replies = [copy, invalidPlan, invalidPlan];
    await expect(generateScript(input)).rejects.toThrow(/visual|framing|Chinese|action/i);
    expect(model.create).toHaveBeenCalledTimes(3);
    const originalPlanningCopy = JSON.parse(model.create.mock.calls[1][0].messages[1].content).copies[0];
    expect(JSON.parse(model.create.mock.calls[2][0].messages[1].content).copies[0]).toEqual(originalPlanningCopy);
    expect(model.create.mock.calls[2][0].messages).toHaveLength(4);
  });

  it("repairs an incomplete AI beat allocation before planning the complete frozen copy", async () => {
    const omittedBeat = structuredClone(copy);
    omittedBeat.copies[0].visualBeats.pop();
    model.replies = [omittedBeat, copy, plan];
    const [script] = await generateScript(input);
    expect(script.copyDocument).toMatchObject({ text, visualBeats });
    expect(model.create).toHaveBeenCalledTimes(3);
    expect(model.create.mock.calls[1][0].messages).toHaveLength(4);
    expect(JSON.parse(model.create.mock.calls[2][0].messages[1].content).copies[0]).toMatchObject({ text, visualBeats });
  });
});
