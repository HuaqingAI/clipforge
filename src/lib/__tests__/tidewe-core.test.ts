import { describe, expect, it, vi } from "vitest";
import { createTideweOutdoorProfile, sanitizeCreativeProfile, validateCreativeProfileInput, checkCreativeProfileContext, isTideweNativeSpeech } from "@/lib/creative-profiles";
import { normalizeProductFacts, productFactsFromDescription, claimableFacts } from "@/lib/tidewe/facts";
import { assertTideweCopyClaims, assertTideweImportedCopy, assertTideweScript, mapTideweCopySpans, productFactsHash } from "@/lib/tidewe/validation";
import { generateTideweScripts, type TideweCompletion } from "@/lib/tidewe/generator";
import { buildBatchPrompt } from "@/lib/script-engine/prompts";
import type { ScriptInput } from "@/lib/script-engine/generator";
import corpus from "@/lib/tidewe/corpus.json";
import { snapshotTidewePresenter, tidewePresenterAnchor } from "@/lib/tidewe/presenter";

const facts = productFactsFromDescription("Fleece lining", "heated_apparel", "JTC001");
const input: ScriptInput = { productName: "TIDEWE Jacket", category: "fashion", styleType: "tidewe_outdoor", creativeProfile: createTideweOutdoorProfile(), productFacts: facts, count: 1, llmConfig: { apiKey: "test", baseUrl: "https://example.test", model: "mock" } };
const copy = "Walking warms you up. Waiting feels different. Check the fit in the link.";
const copyReply = { copies: [{ title: "静候时的选择", text: copy, translation: "行走暖身，等待不同。点链接核对尺码。", angle: "long_wait", hookType: "contrast", claimedFactIds: [] }] };
const shot = (scriptSegment: string, sceneId = "woods-1") => ({ scriptSegment, translation: "行走暖身，等待不同。", narrativeRole: "demo", duration: 6, description: "人物在林边自然等待，保持衣服外观。", camera: "稳定中景", shotGoal: "呈现静候场景", visualIntent: "户外使用", prompt: "清晨林边自然光", productVisible: true, factRefs: [], sceneId });

async function generateSelectedPresenterScript() {
  const profile = createTideweOutdoorProfile({ presenter: { id: "chosen", name: "Selected creator", appearance: "An adult with a green hat", referenceImages: ["/api/files/selected.png"] } });
  const planned = ["Walking warms you up. Waiting feels different.", "Check the fit in the link."].map(segment => ({
    ...shot(segment), personVisible: true, description: "{{PRESENTER}}在林边面向镜头介绍装备，嘴部清晰可见。",
  }));
  const responses = [copyReply, { scripts: [{ copyIndex: 0, shots: planned }] }];
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
    const responses = [copyReply, { scripts: [{ copyIndex: 0, shots: [{ ...shot("Walking warms you up. Waiting feels different."), visualSource: "product_image" }, shot("Check the fit in the link.")] }] }];
    const calls = vi.fn();
    const complete: TideweCompletion = async (system, prompt, parse) => { calls(system, prompt); return parse(JSON.stringify(responses.shift())); };
    const [script] = await generateTideweScripts(input, complete);
    expect(calls).toHaveBeenCalledTimes(2);
    expect(JSON.parse(calls.mock.calls[0][1]).speechMode).toContain("speaks directly to camera");
    expect(JSON.parse(calls.mock.calls[1][1]).speechMode).toBe("on_camera");
    expect(script.copyDocument?.text).toBe(copy);
    expect(script.shots[0].tidewe?.copySpan).toEqual({ start: 0, end: 46 });
    expect(script.shots[0].visualSource).toBe("ai_generate");
    expect(() => assertTideweScript(script)).not.toThrow();
    script.shots[0].voiceover += " Buy it.";
    expect(() => assertTideweScript(script)).toThrow(/changed frozen copy/);
  });
  it("rejects a planner that adds words to frozen AI copy", async () => {
    const responses = [copyReply, { scripts: [{ copyIndex: 0, shots: [shot(copy + " Buy it.")] }] }];
    const bad: TideweCompletion = async (_system, _prompt, parse) => parse(JSON.stringify(responses.shift()));
    await expect(generateTideweScripts(input, bad)).rejects.toThrow(/rewrote/);
  });
  it("owns imported narration on the server, preserving paragraphs, quotes and UTF-16 spans without AI style rewriting", async () => {
    const first = "“I’ve worn this for 3 seasons,” I tell them. 🌲";
    const second = "Wait.  Wait.\r\nBuy now if it fits.";
    const original = `${first}\r\n\r\n${second}`;
    const profile = createTideweOutdoorProfile({ presenter: { id: "chosen", name: "Staff creator", appearance: "An adult in a cap", referenceImages: [] } });
    // Annotation needs no English text; even an unexpected rewritten text field is ignored.
    const annotation = { ...copyReply.copies[0], text: "AI tried to replace the staff's script." };
    const planned = [first, second].map(segment => ({ ...shot(segment), personVisible: true, description: "{{PRESENTER}}面向镜头自然讲述，嘴部清晰可见。" }));
    const responses = [{ copies: [annotation] }, { scripts: [{ copyIndex: 0, shots: planned }] }];
    const calls = vi.fn();
    const complete: TideweCompletion = async (system, prompt, parse) => { calls(system, prompt); return parse(JSON.stringify(responses.shift())); };
    const [script] = await generateTideweScripts({ ...input, creativeProfile: profile, copyText: original, count: 3 }, complete);
    expect(calls).toHaveBeenCalledTimes(2);
    const firstPrompt = JSON.parse(calls.mock.calls[0][1]);
    expect(firstPrompt.frozenImportedCopy).toBe(original);
    expect(firstPrompt.outputFormat.copies[0]).not.toHaveProperty("text");
    expect(firstPrompt).not.toHaveProperty("styleExamples");
    expect(calls.mock.calls[0][0]).toContain("not a draft to rewrite");
    expect(JSON.parse(calls.mock.calls[1][1]).copies[0]).toMatchObject({ source: "user_provided", text: original });
    expect(script.copyDocument).toMatchObject({ source: "user_provided", text: original, exampleIds: [], claimedFactIds: [] });
    expect(script.copyDocument?.factsSnapshot).toEqual(facts);
    expect(script.shots.map(s => s.voiceover)).toEqual([first, second]);
    expect(script.shots.map(s => s.tidewe?.copySpan)).toEqual([{ start: 0, end: first.length }, { start: first.length + 4, end: original.length }]);
    expect(script.shots[0].tidewe?.presenter).toEqual(profile.presenter);
    expect(() => assertTideweScript(script, profile.presenter)).not.toThrow();
    // Historical/default AI copy still uses AI factual/style gates; source is not a global bypass.
    delete script.copyDocument!.source;
    expect(() => assertTideweScript(script, profile.presenter)).toThrow(/urgency|testimonials|numeric/);
  });
  it("annotates imported text without requiring an English reply and rejects unsupported fact citations before planning", async () => {
    const annotation = Object.fromEntries(Object.entries(copyReply.copies[0]).filter(([key]) => key !== "text"));
    const responses = [{ copies: [annotation] }, { scripts: [{ copyIndex: 0, shots: [shot(copy)] }] }];
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
    const responses = [copyReply, { scripts: [{ copyIndex: 0, shots: [planned] }] }];
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
    { patch: { personVisible: false }, message: /presenter to be visible/ },
    { patch: { personVisible: true, description: "一名随机人物在树林中口播。" }, message: /\{\{PRESENTER\}\}/ },
  ])("rejects a selected presenter plan with missing visibility or identity binding: $patch", async ({ patch, message }) => {
    const profile = createTideweOutdoorProfile({ presenter: { id: "chosen", name: "Selected creator", appearance: "An adult in a cap", referenceImages: [] } });
    const responses = [copyReply, { scripts: [{ copyIndex: 0, shots: [{ ...shot(copy), description: "{{PRESENTER}}在树林中口播。", ...patch }] }] }];
    const complete: TideweCompletion = async (_system, _prompt, parse) => parse(JSON.stringify(responses.shift()));
    await expect(generateTideweScripts({ ...input, creativeProfile: profile }, complete)).rejects.toThrow(message);
  });
  it("allows silent person-free B-roll before a selected presenter's full spoken copy without inserting an identity into the environment", async () => {
    const profile = createTideweOutdoorProfile({ presenter: { id: "chosen", name: "Selected creator", appearance: "An adult in a cap", referenceImages: [] } });
    const broll = { ...shot(""), personVisible: false, productVisible: false, description: "清晨树林的环境空镜。", prompt: "自然光下的树林", shotGoal: "建立树林环境", visualIntent: "环境空镜" };
    const spoken = { ...shot(copy), personVisible: true, description: "{{PRESENTER}}面向镜头介绍装备，嘴部清楚可见。" };
    const responses = [copyReply, { scripts: [{ copyIndex: 0, shots: [broll, spoken] }] }];
    const complete: TideweCompletion = async (_system, _prompt, parse) => parse(JSON.stringify(responses.shift()));
    const [script] = await generateTideweScripts({ ...input, creativeProfile: profile }, complete);
    expect(script.shots[0]).toMatchObject({ description: broll.description, voiceover: "", tidewe: { personVisible: false, productVisible: false, copySpan: { start: 0, end: 0 } } });
    expect(script.shots[0].description).not.toContain(profile.presenter!.name);
    expect(script.shots[1]).toMatchObject({ voiceover: copy, tidewe: { personVisible: true, presenter: profile.presenter } });
    expect(() => assertTideweScript(script)).not.toThrow();
  });
});
