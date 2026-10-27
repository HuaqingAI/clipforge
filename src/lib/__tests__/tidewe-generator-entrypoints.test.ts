// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTideweOutdoorProfile } from "@/lib/creative-profiles";
import { generateScript, generateSingleScript, generateScriptStream, createScriptStream, type ScriptInput } from "@/lib/script-engine/generator";

const model = vi.hoisted(() => ({ create: vi.fn(), replies: [] as unknown[] }));
vi.mock("@/lib/llm-error", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/llm-error")>(),
  createLLMClient: () => ({ chat: { completions: { create: model.create } } }),
}));
const input: ScriptInput = { productName: "TIDEWE outdoor jacket", category: "fashion", styleType: "tidewe_outdoor", creativeProfile: createTideweOutdoorProfile(), count: 1, llmConfig: { baseUrl: "https://example.test/v1", apiKey: "test", model: "test" } };
const text = "Walking warms you up. Waiting is different. Check the fit before your next trip.";
const copy = { copies: [{ title: "静候时刻", text, translation: "走动暖身，静候不同。下次出发前核对尺码。", angle: "long_wait", hookType: "contrast", claimedFactIds: [] }] };
const plan = { scripts: [{ copyIndex: 0, shots: [{ scriptSegment: text, translation: copy.copies[0].translation, narrativeRole: "hook", duration: 10, description: "林边人物自然等待", camera: "稳定中景", shotGoal: "展现等待场景", visualIntent: "清晨户外使用场景", prompt: "林边真实自然光", productVisible: true, factRefs: [], sceneId: "woods" }] }] };
beforeEach(() => {
  model.replies = [copy, plan];
  model.create.mockReset().mockImplementation(async () => ({ choices: [{ message: { content: JSON.stringify(model.replies.shift()) } }] }));
});
describe("shared TIDEWE generator dispatch", () => {
  it("routes batch and single generation through two complete-copy stages", async () => {
    const scripts = await generateScript(input);
    expect(scripts[0].copyDocument?.text).toBe(text);
    expect(model.create).toHaveBeenCalledTimes(2);
    const params = model.create.mock.calls.map(([p]) => p);
    expect(params.every(p => !p.stream && p.messages[0].content.includes("TIDEWE"))).toBe(true);
    model.replies = [copy, plan];
    expect((await generateSingleScript(input)).styleType).toBe("tidewe_outdoor");
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
});
