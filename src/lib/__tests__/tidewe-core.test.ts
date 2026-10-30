import { describe, expect, it, vi } from "vitest";
import { createTideweOutdoorProfile, sanitizeCreativeProfile, validateCreativeProfileInput, checkCreativeProfileContext, isTideweNativeSpeech } from "@/lib/creative-profiles";
import { normalizeProductFacts, normalizeTideweCategory, productFactsFromDescription, claimableFacts } from "@/lib/tidewe/facts";
import { resolveTideweShopCategory, TIDEWE_SHOP_CATEGORIES } from "@/lib/tidewe/categories";
import { assertTideweCopyClaims, assertTideweImportedCopy, assertTideweScript, mapTideweCopySpans, productFactsHash } from "@/lib/tidewe/validation";
import { generateTideweScripts, type TideweCompletion } from "@/lib/tidewe/generator";
import { buildBatchPrompt } from "@/lib/script-engine/prompts";
import type { ScriptInput } from "@/lib/script-engine/generator";
import corpus from "@/lib/tidewe/corpus.json";
import { snapshotTidewePresenter, tidewePresenterAnchor } from "@/lib/tidewe/presenter";

const facts = productFactsFromDescription("Fleece lining", "heated_apparel", "JTC001");
const input: ScriptInput = { productName: "TIDEWE Jacket", category: "fashion", styleType: "tidewe_outdoor", creativeProfile: createTideweOutdoorProfile(), productFacts: facts, count: 1, llmConfig: { apiKey: "test", baseUrl: "https://example.test", model: "mock" } };
const copy = "Walking warms you up. Waiting feels different. Check the fit in the link.";
const visualBeats = [
  { text: "Walking warms you up.", visualRole: "demonstration", visualIdea: "衣服穿在身上，沿林间小径走一步。", factRefs: [] },
  { text: "Waiting feels different.", visualRole: "context", visualIdea: "观察林缘停步等待的实际状态。", factRefs: [] },
  { text: "Check the fit in the link.", visualRole: "presenter", visualIdea: "主播面向镜头示意查看穿着外观。", factRefs: [] },
];
const copyReply = { copies: [{ title: "静候时的选择", text: copy, translation: "行走暖身，等待不同。点链接核对尺码。", angle: "long_wait", hookType: "contrast", claimedFactIds: [], visualBeats }] };
const shot = (scriptSegment: string, sceneId = "woods-1") => ({ scriptSegment, translation: "行走暖身，等待不同。", narrativeRole: "demo", duration: 6, description: "人物穿着外套在林边走近拍摄朋友一步，保持衣服外观。", camera: "稳定中景", shotGoal: "呈现衣服的实际穿着状态", visualIntent: "户外穿着使用", prompt: "清晨林边自然光", productVisible: true, factRefs: [], sceneId, visualPlan: { framing: "medium", visualRole: "demonstration", productFocus: "穿在人物身上的外套及其衣袖", actionStart: "双脚已经站稳在林缘地面，外套自然穿在身上。", action: "穿着外套向拍摄朋友走近一步。", actionEnd: "站姿稳定，衣服保持自然穿着状态。" } });

// Keep each contract's original narration while supplying a complete new storyboard.
function completePlan(planned: Record<string, unknown>[], productCloseup = false) {
  const presenter = planned.some(s => String(s.description).includes("{{PRESENTER}}")) ? "{{PRESENTER}}" : "人物";
  const inserts = [
    { ...shot(""), duration: 2, personVisible: false, description: "外套衣袖的面料与缝线完整入画，没有人物。", shotGoal: "观察当前外套衣袖的可见做工", visualPlan: { framing: "detail", visualRole: "detail", productFocus: "外套衣袖的表面面料和缝线", actionStart: "衣袖表面已经清晰入画。", action: "静态观察衣袖的既有缝线。", actionEnd: "保持衣袖细节的稳定构图。" } },
    { ...shot(""), duration: 2, personVisible: false, productVisible: false, description: "自然光下林缘小径的环境空镜，没有人物。", shotGoal: "建立林缘小径的空间关系", visualPlan: { framing: "wide", visualRole: "context", actionStart: "林缘小径与树木完整入画。", action: "静态观察小径的自然状态。", actionEnd: "保持林缘的稳定全景。" } },
    { ...shot(""), duration: 2, personVisible: !productCloseup, description: productCloseup ? "平放外套的衣领边缘清晰入画，没有人物。" : `${presenter}已穿好外套，扶住衣服下摆后自然松手。`, shotGoal: productCloseup ? "观察平放外套的衣领边缘" : "呈现外套穿着后的自然状态", visualPlan: { framing: productCloseup ? "close_up" : "medium", visualRole: productCloseup ? "detail" : "demonstration", productFocus: productCloseup ? "当前外套的衣领轮廓与可见缝边" : "穿在人物身上的外套下摆与完整轮廓", actionStart: productCloseup ? "外套衣领边缘已经清晰入画。" : "人物已穿好外套并扶住衣服下摆。", action: productCloseup ? "静态观察衣领的既有轮廓。" : "松开下摆并保持自然站姿。", actionEnd: productCloseup ? "保持衣领原有状态和构图。" : "双手自然放松，外套保持正常穿着。" } },
  ];
  return [...planned, ...Array.from({ length: Math.max(0, 7 - planned.length) }, (_, index) => inserts[index % inserts.length])];
}

async function generateSelectedPresenterScript() {
  const profile = createTideweOutdoorProfile({ presenter: { id: "chosen", name: "Selected creator", appearance: "An adult with a green hat", referenceImages: ["/api/files/selected.png"] } });
  const planned = ["Walking warms you up. Waiting feels different.", "Check the fit in the link."].map(segment => ({
    ...shot(segment), personVisible: true, description: "{{PRESENTER}}在林边面向镜头介绍装备，嘴部清晰可见。",
  }));
  const responses = [copyReply, { scripts: [{ copyIndex: 0, shots: completePlan(planned) }] }];
  const complete: TideweCompletion = async (_system, _prompt, parse) => parse(JSON.stringify(responses.shift()));
  const [script] = await generateTideweScripts({ ...input, creativeProfile: profile }, complete);
  return { profile, script };
}

describe("TIDEWE core contracts", () => {
  it("has an independent English 40 second profile with isolated identity", () => {
    expect(createTideweOutdoorProfile()).toMatchObject({ creationType: "tidewe_outdoor", language: "en-US", targetDuration: 40, videoMode: "scene_demo", speechMode: "on_camera", composeSnapshot: { ttsEnabled: false, nativeAudio: true, subtitles: true, ctaEnabled: false } });
    const legacy = createTideweOutdoorProfile({ speechMode: "voiceover" });
    expect(sanitizeCreativeProfile(legacy)).toMatchObject({ speechMode: "voiceover", composeSnapshot: { ttsEnabled: true, nativeAudio: false } });
    expect(isTideweNativeSpeech(legacy)).toBe(false);
    expect(isTideweNativeSpeech(createTideweOutdoorProfile())).toBe(true);
    expect(validateCreativeProfileInput({ creationType: "tidewe_outdoor", id: "short_video_sales_v1" }).error).toBeTruthy();
    const historical = sanitizeCreativeProfile({ ...createTideweOutdoorProfile(), corpusVersion: "old-corpus", promptCompilerVersion: "old-compiler" });
    expect(historical).toMatchObject({ corpusVersion: "old-corpus", promptCompilerVersion: "old-compiler" });
    expect(validateCreativeProfileInput(historical).error).toMatch(/Unsupported/);
    expect(checkCreativeProfileContext({ creativeProfile: createTideweOutdoorProfile() }, { styleType: "pain_point" }).ok).toBe(false);
  });
  it("does not promote image observations or pick a winner for contradictory facts", () => {
    const conflict = normalizeProductFacts({ ...facts, items: [
      { ...facts.items[0], key: "runtime", value: "6 hours" },
      { ...facts.items[0], id: "second", key: "runtime", value: "8 hours" },
      { ...facts.items[0], id: "image", key: "waterproof", source: { kind: "uploaded_image", ref: "product.png" } },
    ] })!;
    expect(conflict.items[2].status).toBe("observed");
    expect(conflict.blockedClaims?.[0].key).toBe("runtime");
    expect(claimableFacts(conflict)).toEqual([]);
    expect(normalizeProductFacts({})).toBeUndefined();
    expect(productFactsFromDescription("", "waders").items).toEqual([]);
    expect(productFactsHash(facts)).toBe(productFactsHash({ ...facts, items: [...facts.items] }));
  });
  it("exposes exactly the six SHOP categories and leaves unknown or unset values unclassified", () => {
    expect(TIDEWE_SHOP_CATEGORIES).toEqual(["hunting_blind", "waders", "heated_gear", "apparel", "boots", "accessories"]);
    for (const category of TIDEWE_SHOP_CATEGORIES) {
      expect(resolveTideweShopCategory(category)).toBe(category);
      expect(normalizeTideweCategory(category)).toBe(category);
      expect(normalizeProductFacts({ version: 1, brand: "TIDEWE", category, items: [] })?.category).toBe(category);
    }
    for (const unset of [undefined, null, "", "other", "unknown", "unrelated category", {}, 1, "toString"]) {
      expect(resolveTideweShopCategory(unset)).toBeUndefined();
    }
    expect(resolveTideweShopCategory(" Heated Gear ")).toBe("heated_gear");
    expect(resolveTideweShopCategory("Hunting Blinds")).toBe("hunting_blind");
    expect(resolveTideweShopCategory("靴子")).toBe("boots");
    expect(normalizeTideweCategory("heated jacket")).toBe("heated_apparel");
    expect(normalizeTideweCategory("outdoor chair")).toBe("hunting_chair");
  });
  it.each([
    { legacy: "hunting_chair" as const, shop: "accessories", hash: "62ca818c6bdb58b2fdd89d9bb304857c23157bb2ae260cc79b6bab9dd78b80c7" },
    { legacy: "heated_apparel" as const, shop: "heated_gear", hash: "c27ba845d190fc12997e67d7de883d19a936d9cd942858f5bec8c8ff241c2988" },
    { legacy: "hunting_apparel" as const, shop: "apparel", hash: "45a025cc5d91bae0d0afe9f3c1823f56a7b3c34dd66012df97d2fd41ecf8f2e7" },
    { legacy: "waterproof_boots" as const, shop: "boots", hash: "5223fc58d2d3368e00da15568a0bec14d88808a2765ab137a8d41f0a3f4025ee" },
  ])("resolves editable $legacy to SHOP $shop without rehashing frozen legacy facts", ({ legacy, shop, hash }) => {
    const frozenFacts = { version: 1 as const, brand: "TIDEWE", category: legacy, items: [] };
    const original = structuredClone(frozenFacts);
    expect(resolveTideweShopCategory(legacy)).toBe(shop);
    expect(normalizeTideweCategory(legacy)).toBe(legacy);
    expect(normalizeProductFacts(frozenFacts)).toEqual(original);
    expect(productFactsHash(frozenFacts)).toBe(hash);
    expect(frozenFacts).toEqual(original);
  });
  it("matches repeated phrases sequentially and rejects omissions or rewrites", () => {
    expect(mapTideweCopySpans("Wait. Wait. Go.", [{ scriptSegment: "Wait." }, { scriptSegment: "" }, { scriptSegment: "Wait. Go." }])).toEqual([{ start: 0, end: 5 }, { start: 6, end: 6 }, { start: 6, end: 15 }]);
    expect(() => mapTideweCopySpans(copy, [{ scriptSegment: "Waiting feels different." }])).toThrow(/rewrote/);
    expect(() => mapTideweCopySpans(copy, [{ scriptSegment: "Walking warms you up." }])).toThrow(/omitted/);
    expect(() => mapTideweCopySpans("Don't wait.", [{ scriptSegment: "Don’t wait." }])).toThrow();
  });
  it("rejects cross-SKU battery and unsupported numeric specifications", () => {
    const hj = { ...facts, sku: "HJ006" };
    expect(() => assertTideweCopyClaims("This heated jacket includes an included battery.", hj, [])).toThrow();
    expect(() => assertTideweCopyClaims("This heated jacket keeps things simple. A compatible battery is sold separately.", hj, [])).not.toThrow();
    expect(() => assertTideweCopyClaims("Runs for 12 hours.", facts, [])).toThrow(/numeric/);
    expect(() => assertTideweCopyClaims("Waterproof jacket.", facts, [])).toThrow(/JTC001/);
    expect(() => assertTideweCopyClaims("Wait [pause] until the wind settles.", facts, [])).toThrow(/stage directions/);
  });
  it("uses cited workbook samples while bypassing the sales compiler", () => {
    expect(corpus.sourceSha256).toHaveLength(64);
    expect(corpus.examples.every(e => e.text && e.translation && e.source.cells)).toBe(true);
    const prompt = buildBatchPrompt(input, 1);
    expect(prompt).toContain("styleExamples");
    expect(prompt).not.toContain("AIDA");
  });
  it("makes two batch calls and freezes copy through semantic planning", async () => {
    const responses = [copyReply, { scripts: [{ copyIndex: 0, shots: completePlan([{ ...shot("Walking warms you up. Waiting feels different."), visualSource: "product_image" }, shot("Check the fit in the link.")]) }] }];
    const calls = vi.fn();
    const complete: TideweCompletion = async (system, prompt, parse) => { calls(system, prompt); return parse(JSON.stringify(responses.shift())); };
    const [script] = await generateTideweScripts(input, complete);
    expect(calls).toHaveBeenCalledTimes(2);
    expect(JSON.parse(calls.mock.calls[0][1]).speechMode).toContain("speaks directly to camera");
    expect(JSON.parse(calls.mock.calls[1][1]).speechMode).toBe("on_camera");
    expect(JSON.parse(calls.mock.calls[1][1]).copies[0].visualBeats).toEqual(visualBeats);
    expect(script.copyDocument?.text).toBe(copy);
    expect(script.copyDocument?.visualBeats).toEqual(visualBeats);
    expect(script.shots[0].tidewe?.visualPlan).toEqual(shot("").visualPlan);
    expect(script.shots[0].tidewe?.copySpan).toEqual({ start: 0, end: 46 });
    expect(script.shots[0].visualSource).toBe("ai_generate");
    expect(() => assertTideweScript(script)).not.toThrow();
    script.shots[0].voiceover += " Buy it.";
    expect(() => assertTideweScript(script)).toThrow(/changed frozen copy/);
  });
  it("keeps one frozen narration across a visible presenter, narrated hand detail and narrated person-free environment", async () => {
    const profile = createTideweOutdoorProfile({ presenter: { id: "chosen", name: "Selected creator", appearance: "An adult in a cap", referenceImages: [] } });
    const segments = ["Walking warms you up.", "Waiting feels different.", "Check the fit in the link."];
    const planned = [
      { ...shot(segments[0]), personVisible: true, speechDelivery: "on_camera", description: "{{PRESENTER}}向拍摄朋友走近一步并自然口播，嘴部可见。" },
      { ...shot(segments[1]), personVisible: true, speechDelivery: "off_camera", description: "{{PRESENTER}}的手已经接触衣袖，轻压一次后松开，画面只包含手与衣料。", visualSource: "product_image", visualPlan: { framing: "detail", visualRole: "detail", productFocus: "指腹接触的外套衣袖面料", actionStart: "指腹已接触衣袖面料。", action: "轻压衣袖一次后松开。", actionEnd: "面料恢复，手指停在衣袖旁。" } },
      { ...shot(segments[2]), personVisible: false, speechDelivery: "off_camera", productVisible: false, description: "自然光下林边小径的环境空镜。", visualSource: "product_image", visualPlan: { framing: "wide", visualRole: "context", actionStart: "林间小径和地面层次已经完整入画。", action: "静态观察林缘的自然状态。", actionEnd: "保持同一片林缘的稳定构图。" } },
    ];
    const mixedCopy = { copies: [{ ...copyReply.copies[0], visualBeats: visualBeats.map((beat, index) => index === 1 ? { ...beat, visualRole: "detail", visualIdea: "观察指腹与衣袖表面的接触，不推断保暖性能。" } : beat) }] };
    const responses = [mixedCopy, { scripts: [{ copyIndex: 0, shots: completePlan(planned) }] }];
    const complete: TideweCompletion = async (_system, _prompt, parse) => parse(JSON.stringify(responses.shift()));
    const [script] = await generateTideweScripts({ ...input, creativeProfile: profile }, complete);
    expect(script.copyDocument?.text).toBe(copy);
    expect(script.shots.slice(0, 3).map(s => s.voiceover)).toEqual(segments);
    expect(script.shots.slice(3).every(s => s.voiceover === "")).toBe(true);
    expect(script.shots.slice(0, 3).map(s => s.visualSource)).toEqual(["ai_generate", "ai_generate", "ai_generate"]);
    expect(script.shots.slice(0, 3).map(s => s.tidewe?.speechDelivery)).toEqual(["on_camera", "off_camera", "off_camera"]);
    expect(script.shots.slice(0, 3).map(s => s.tidewe?.personVisible)).toEqual([true, true, false]);
    expect(script.shots[1].description).toContain(tidewePresenterAnchor(profile.presenter!));
    expect(script.shots[2].description).toBe(planned[2].description);
    for (const s of script.shots) {
      expect(copy.slice(s.tidewe!.copySpan.start, s.tidewe!.copySpan.end)).toBe(s.voiceover);
    }
    expect(() => assertTideweScript(script, profile.presenter)).not.toThrow();
    script.shots[2].tidewe!.speechDelivery = "on_camera";
    expect(() => assertTideweScript(script, profile.presenter)).toThrow(/presenter to be visible/);
  });
  it.each(["voiceover", "silent", null, 1])("rejects an unsupported per-shot native speech delivery: %s", async speechDelivery => {
    const responses = [copyReply, { scripts: [{ copyIndex: 0, shots: completePlan([{ ...shot(copy), speechDelivery }]) }] }];
    const complete: TideweCompletion = async (_system, _prompt, parse) => parse(JSON.stringify(responses.shift()));
    await expect(generateTideweScripts(input, complete)).rejects.toThrow(/Invalid shot speechDelivery/);
  });
  it("validates persisted delivery values and keeps omitted historical delivery compatible", async () => {
    const { script } = await generateSelectedPresenterScript();
    delete script.shots[0].tidewe!.speechDelivery;
    expect(() => assertTideweScript(script)).not.toThrow();
    Object.assign(script.shots[0].tidewe!, { speechDelivery: "invented" });
    expect(() => assertTideweScript(script)).toThrow(/speechDelivery must be/);
  });
  it("preserves the global post-production voiceover path for person-free static product shots", async () => {
    const profile = createTideweOutdoorProfile({ speechMode: "voiceover", videoMode: "product_closeup" });
    const planned = { ...shot(copy), personVisible: false, visualSource: "product_image", description: "外套平放在林边干燥的木质平台上，没有人物。", visualPlan: { framing: "medium", visualRole: "context", productFocus: "平放外套的完整轮廓与现有衣袖", actionStart: "外套已经完整平放入画。", action: "静态观察外套的既有外观。", actionEnd: "保持外套原有状态与构图。" } };
    const staticCopy = { copies: [{ ...copyReply.copies[0], visualBeats: visualBeats.map(beat => ({ ...beat, visualRole: "context", visualIdea: "外套在自然环境里保持静态完整入画。" })) }] };
    const responses = [staticCopy, { scripts: [{ copyIndex: 0, shots: completePlan([planned], true) }] }];
    const calls = vi.fn();
    const complete: TideweCompletion = async (system, prompt, parse) => { calls(system, prompt); return parse(JSON.stringify(responses.shift())); };
    const [script] = await generateTideweScripts({ ...input, creativeProfile: profile }, complete);
    expect(script.shots[0]).toMatchObject({ voiceover: copy, visualSource: "product_image", tidewe: { personVisible: false } });
    expect(script.shots[0].tidewe).not.toHaveProperty("speechDelivery");
    expect(JSON.parse(calls.mock.calls[1][1]).outputFormat.scripts[0].shots[0]).not.toHaveProperty("speechDelivery");
  });
  it("rejects a planner that adds words to frozen AI copy", async () => {
    const responses = [copyReply, { scripts: [{ copyIndex: 0, shots: completePlan([shot(copy + " Buy it.")]) }] }];
    const bad: TideweCompletion = async (_system, _prompt, parse) => parse(JSON.stringify(responses.shift()));
    await expect(generateTideweScripts(input, bad)).rejects.toThrow(/rewrote/);
  });
  it("owns imported narration on the server, preserving paragraphs, quotes and UTF-16 spans without AI style rewriting", async () => {
    const first = "“I’ve worn this for 3 seasons,” I tell them. 🌲";
    const second = "Wait.  Wait.\r\nBuy now if it fits.";
    const original = `${first}\r\n\r\n${second}`;
    const profile = createTideweOutdoorProfile({ presenter: { id: "chosen", name: "Staff creator", appearance: "An adult in a cap", referenceImages: [] } });
    // Annotation needs no English text; even an unexpected rewritten text field is ignored.
    const annotation = { ...copyReply.copies[0], text: "AI tried to replace the staff's script.", visualBeats: [{ text: "AI also replaced this line!", visualRole: "invented", visualIdea: "改写原文", factRefs: ["invented-evidence"] }] };
    const planned = [first, second].map(segment => ({ ...shot(segment), personVisible: true, description: "{{PRESENTER}}面向镜头自然讲述，嘴部清晰可见。" }));
    const responses = [{ copies: [annotation] }, { scripts: [{ copyIndex: 0, shots: completePlan(planned) }] }];
    const calls = vi.fn();
    const complete: TideweCompletion = async (system, prompt, parse) => { calls(system, prompt); return parse(JSON.stringify(responses.shift())); };
    const [script] = await generateTideweScripts({ ...input, creativeProfile: profile, copyText: original, count: 3 }, complete);
    expect(calls).toHaveBeenCalledTimes(2);
    const firstPrompt = JSON.parse(calls.mock.calls[0][1]);
    expect(firstPrompt.frozenImportedCopy).toBe(original);
    expect(firstPrompt.outputFormat.copies[0]).not.toHaveProperty("text");
    expect(firstPrompt.outputFormat.copies[0]).not.toHaveProperty("visualBeats");
    expect(firstPrompt).not.toHaveProperty("styleExamples");
    expect(calls.mock.calls[0][0]).toContain("not a draft to rewrite");
    expect(JSON.parse(calls.mock.calls[1][1]).copies[0]).toMatchObject({ source: "user_provided", text: original });
    expect(JSON.parse(calls.mock.calls[1][1]).copies[0]).not.toHaveProperty("visualBeats");
    expect(script.copyDocument).toMatchObject({ source: "user_provided", text: original, exampleIds: [], claimedFactIds: [] });
    expect(script.copyDocument).not.toHaveProperty("visualBeats");
    expect(script.copyDocument?.factsSnapshot).toEqual({ ...facts, category: "heated_gear" });
    expect(script.shots.slice(0, 2).map(s => s.voiceover)).toEqual([first, second]);
    expect(script.shots.slice(2).every(s => s.voiceover === "")).toBe(true);
    expect(script.shots.slice(0, 2).map(s => s.tidewe?.copySpan)).toEqual([{ start: 0, end: first.length }, { start: first.length + 4, end: original.length }]);
    expect(script.shots[0].tidewe?.presenter).toEqual(profile.presenter);
    expect(() => assertTideweScript(script, profile.presenter)).not.toThrow();
    // Historical/default AI copy still uses AI factual/style gates; source is not a global bypass.
    delete script.copyDocument!.source;
    expect(() => assertTideweScript(script, profile.presenter)).toThrow(/urgency|testimonials|numeric/);
  });
  it("annotates imported text without requiring an English reply and rejects unsupported fact citations before planning", async () => {
    const annotation = Object.fromEntries(Object.entries(copyReply.copies[0]).filter(([key]) => key !== "text"));
    const responses = [{ copies: [annotation] }, { scripts: [{ copyIndex: 0, shots: completePlan([shot(copy)]) }] }];
    const complete: TideweCompletion = async (_system, _prompt, parse) => parse(JSON.stringify(responses.shift()));
    expect((await generateTideweScripts({ ...input, copyText: copy }, complete))[0].copyDocument).toMatchObject({ source: "user_provided", text: copy });
    const invalidCalls = vi.fn();
    const bad: TideweCompletion = async (_system, _prompt, parse) => {
      invalidCalls();
      return parse(JSON.stringify({ copies: [{ ...annotation, claimedFactIds: ["invented-evidence"] }] }));
    };
    await expect(generateTideweScripts({ ...input, copyText: copy }, bad)).rejects.toThrow(/unknown, inferred or conflicting/);
    expect(invalidCalls).toHaveBeenCalledTimes(1);
  });
  it.each(["", "纯中文口播文案", "English copy with 中文注释", "1234", "a".repeat(12001)])("rejects invalid imported copy before annotation: %s", async invalid => {
    const complete = vi.fn();
    expect(() => assertTideweImportedCopy(invalid)).toThrow();
    await expect(generateTideweScripts({ ...input, copyText: invalid }, complete)).rejects.toMatchObject({ code: "TIDEWE_IMPORTED_COPY_INVALID", status: 400 });
    expect(complete).not.toHaveBeenCalled();
  });
  it.each([false, true])("binds a frozen selected presenter into the planner and generated shots, image-only=%s", async (imageOnly) => {
    const library = { id: "chosen", name: "Selected creator", appearance: imageOnly ? "" : "An adult with a green hat", referenceImages: ["/api/files/selected.png"] };
    const profile = createTideweOutdoorProfile({ presenter: library });
    const planned = { ...shot(copy), personVisible: true, description: "{{PRESENTER}}在林边面向镜头自然介绍装备，嘴部清晰可见。", camera: "稳定中景拍摄{{PRESENTER}}", prompt: "{{PRESENTER}}在林边自然演示", shotGoal: "呈现{{PRESENTER}}讲解装备", visualIntent: "{{PRESENTER}}真人自然演示" };
    const responses = [copyReply, { scripts: [{ copyIndex: 0, shots: completePlan([planned]) }] }];
    const calls = vi.fn();
    const complete: TideweCompletion = async (system, prompt, parse) => { calls(system, prompt); return parse(JSON.stringify(responses.shift())); };
    const [script] = await generateTideweScripts({ ...input, creativeProfile: profile }, complete);
    const anchor = tidewePresenterAnchor(snapshotTidewePresenter(library)!);
    for (const field of [script.shots[0].description, script.shots[0].camera, script.shots[0].prompt, script.shots[0].visualIntent, script.shots[0].tidewe!.shotGoal]) {
      expect(field).toContain(anchor);
      expect(field).not.toContain("{{PRESENTER}}");
    }
    expect(script.shots[0].tidewe).toMatchObject({ personVisible: true, presenter: snapshotTidewePresenter(library) });
    expect(script.copyDocument!.text).toBe(copy);
    expect(() => assertTideweScript(script)).not.toThrow();
    for (const [, prompt] of calls.mock.calls) {
      expect(prompt).toContain(library.name);
      expect(prompt).not.toContain("/api/files/selected.png");
    }
    if (imageOnly) {
      expect(script.shots[0].description).toContain("所选主播 Selected creator（外貌以所选主播参考图为准）");
      expect(script.shots[0].description).not.toContain("green hat");
    }
    library.appearance = "Changed library appearance"; library.referenceImages[0] = "/api/files/changed.png";
    expect(script.shots[0].tidewe!.presenter?.referenceImages).toEqual(["/api/files/selected.png"]);
    expect(script.shots[0].description).not.toContain("Changed library appearance");
  });
  it("rejects a different presenter snapshot in a later shot even when the identity ID is unchanged", async () => {
    const { profile, script } = await generateSelectedPresenterScript();
    expect(() => assertTideweScript(script, profile.presenter)).not.toThrow();
    script.shots[1].tidewe!.presenter = { ...profile.presenter!, appearance: "An adult with a red hat" };
    expect(() => assertTideweScript(script, profile.presenter)).toThrow(/same frozen presenter/);
  });
  it("keeps a long frozen presenter identity while resolving concise action placeholders", async () => {
    const appearance = "成年户外使用者，短棕发与灰色胡须，穿着自然合身的迷彩衣服。".repeat(12);
    expect(appearance.length).toBeGreaterThan(240);
    const presenter = { id: "detailed-host", name: "Detailed host", appearance, referenceImages: ["/api/files/detailed-host.png"] };
    const profile = createTideweOutdoorProfile({ presenter });
    const planned = {
      ...shot(copy), personVisible: true, description: "{{PRESENTER}}站在林缘面向拍摄朋友自然讲述，嘴部清楚可见。",
      visualPlan: { framing: "medium", visualRole: "demonstration", productFocus: "{{PRESENTER}}衣袖与手指的接触位置。", actionStart: "{{PRESENTER}}双脚已经站稳并扶住衣服边缘。", action: "{{PRESENTER}}轻压衣袖一次。", actionEnd: "{{PRESENTER}}松开手指后保持站稳。" },
    };
    const responses = [copyReply, { scripts: [{ copyIndex: 0, shots: completePlan([planned]) }] }];
    const complete: TideweCompletion = async (_system, _prompt, parse) => parse(JSON.stringify(responses.shift()));
    const [script] = await generateTideweScripts({ ...input, creativeProfile: profile }, complete);
    expect(script.copyDocument?.text).toBe(copy);
    expect(script.shots[0].tidewe?.presenter).toEqual(profile.presenter);
    expect(script.shots[0].description).toContain(tidewePresenterAnchor(profile.presenter!));
    expect(script.shots[0].description).toContain(appearance);
    const visualPlan = script.shots[0].tidewe!.visualPlan!;
    for (const value of [visualPlan.actionStart, visualPlan.action, visualPlan.actionEnd, visualPlan.productFocus!]) {
      expect(value.length).toBeLessThanOrEqual(240);
      expect(value).toContain("所选主播");
      expect(value).not.toContain("{{PRESENTER}}");
    }
    expect(() => assertTideweScript(script, profile.presenter)).not.toThrow();
  });
  it("rejects editing the selected presenter's saved appearance anchor in a person-visible description", async () => {
    const { profile, script } = await generateSelectedPresenterScript();
    script.shots[0].description = script.shots[0].description.replace("green hat", "red hat");
    expect(script.shots[0].tidewe!.presenter).toEqual(profile.presenter);
    expect(() => assertTideweScript(script, profile.presenter)).toThrow(/retain the saved presenter identity/);
  });
  it("rejects a script that does not match the expected frozen profile presenter", async () => {
    const { profile, script } = await generateSelectedPresenterScript();
    const changedReference = { ...profile.presenter!, referenceImages: ["/api/files/other-presenter.png"] };
    expect(() => assertTideweScript(script, changedReference)).toThrow(/does not match its frozen creative profile/);
    expect(() => assertTideweScript(script, null)).toThrow(/does not match its frozen creative profile/);
  });
  it.each([
    { patch: {}, message: /explicit personVisible/ },
    { patch: { personVisible: true, description: "一名随机人物在树林中口播。" }, message: /\{\{PRESENTER\}\}/ },
  ])("rejects a selected presenter plan with missing visibility or identity binding: $patch", async ({ patch, message }) => {
    const profile = createTideweOutdoorProfile({ presenter: { id: "chosen", name: "Selected creator", appearance: "An adult in a cap", referenceImages: [] } });
    const responses = [copyReply, { scripts: [{ copyIndex: 0, shots: completePlan([{ ...shot(copy), description: "{{PRESENTER}}在树林中口播。", ...patch }]) }] }];
    const complete: TideweCompletion = async (_system, _prompt, parse) => parse(JSON.stringify(responses.shift()));
    await expect(generateTideweScripts({ ...input, creativeProfile: profile }, complete)).rejects.toThrow(message);
  });
  it("allows silent person-free B-roll before a selected presenter's full spoken copy without inserting an identity into the environment", async () => {
    const profile = createTideweOutdoorProfile({ presenter: { id: "chosen", name: "Selected creator", appearance: "An adult in a cap", referenceImages: [] } });
    const broll = { ...shot(""), personVisible: false, productVisible: false, description: "清晨树林的环境空镜。", prompt: "自然光下的树林", shotGoal: "建立树林环境", visualIntent: "环境空镜", visualPlan: { framing: "wide", visualRole: "context", actionStart: "树林与地面层次完整入画。", action: "静态观察林缘环境。", actionEnd: "保持树林的稳定全景。" } };
    const spoken = { ...shot(copy), personVisible: true, description: "{{PRESENTER}}面向镜头介绍装备，嘴部清楚可见。" };
    const responses = [copyReply, { scripts: [{ copyIndex: 0, shots: completePlan([broll, spoken]) }] }];
    const complete: TideweCompletion = async (_system, _prompt, parse) => parse(JSON.stringify(responses.shift()));
    const [script] = await generateTideweScripts({ ...input, creativeProfile: profile }, complete);
    expect(script.shots[0]).toMatchObject({ description: broll.description, voiceover: "", tidewe: { personVisible: false, productVisible: false, copySpan: { start: 0, end: 0 } } });
    expect(script.shots[0].description).not.toContain(profile.presenter!.name);
    expect(script.shots[1]).toMatchObject({ voiceover: copy, tidewe: { personVisible: true, presenter: profile.presenter } });
    expect(() => assertTideweScript(script)).not.toThrow();
  });
});
