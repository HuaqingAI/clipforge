import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ScriptPage from "@/app/project/[id]/script/page";
import { createShortVideoSalesProfile, createTideweOutdoorProfile } from "@/lib/creative-profiles";
import { useSettingsStore } from "@/lib/stores/settings-store";
import type { JudgeReport } from "@/lib/script-judge";
import type { TideweCopyDocument } from "@/lib/tidewe/types";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "judge-project" }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/components/project-header", () => ({ ProjectHeader: () => null }));
vi.mock("@/lib/i18n", () => {
  const t = (key: string) => key;
  return { useT: () => t, useLocale: () => "zh" };
});

const projectUrl = "/api/project/judge-project";
const scriptsUrl = `${projectUrl}/scripts`;
const reviewUrl = `${projectUrl}/script-judge`;
const applyUrl = `${reviewUrl}/apply`;
const settingsInitial = useSettingsStore.getInitialState();
const fetchMock = vi.fn();
const copy: TideweCopyDocument = {
  version: 1, language: "en-US", text: "Cold mornings are when I want a choice. Take a closer look.",
  translation: "冷天更想要能自己选择。可以仔细看看。", angle: "scene_pain", hookType: "situation",
  claimedFactIds: [], factsSnapshot: { version: 1, brand: "TIDEWE", category: "other", items: [] },
  factsHash: "facts", corpusVersion: "test", compilerVersion: "test", exampleIds: [], wordCount: 13, estimatedDuration: 40,
};
const original = {
  id: "script-1", title: "Original script", styleType: "tidewe_outdoor", selected: true, version: 1,
  totalDuration: 40, scriptHash: "reviewed-hash", copyDocument: copy,
  shots: [{ shotId: 1, type: "demo", duration: 40, description: "猎帐内自然静候", voiceover: copy.text, visualSource: "ai_generate", transition: "direct_concat" }],
};
const feedback: JudgeReport = {
  sourceScriptHash: original.scriptHash,
  verdicts: [{ judge: "voice", issues: [{ shotId: 1, issue: "「Take a closer look」应具体说明查看什么。", tier: "default" }] }],
  rewrites: [], descriptionRewrites: [], summary: "Review of the original script",
};
let root: Root;
let container: HTMLDivElement;

function button(label: string) {
  return [...container.querySelectorAll("button")].find((node) => node.textContent?.includes(label));
}
async function click(label: string) {
  expect(button(label), `button ${label}`).toBeDefined();
  await act(async () => button(label)!.click());
}
async function mount(tidewe = true, report = feedback) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === projectUrl) return Response.json({
      name: "Outdoor product", productName: "Outdoor product", productImages: [], creativeConfigRevision: 1,
      creativeProfile: tidewe ? createTideweOutdoorProfile() : createShortVideoSalesProfile(),
    });
    if (url === scriptsUrl) return Response.json([tidewe ? original : { ...original, styleType: "scene", copyDocument: null }]);
    if (url === reviewUrl) return Response.json(report);
    throw new Error(`Unexpected request: ${url}`);
  });
  await act(async () => root.render(createElement(ScriptPage)));
  await click("judgeButton");
  expect(container.textContent).toContain(report.summary);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  useSettingsStore.setState({ ...settingsInitial, uiMode: "pro", llm: { provider: "fixture", baseUrl: "https://example.test", apiKey: "fixture-key", model: "fixture" } });
  fetchMock.mockReset();
  window.history.replaceState(null, "", "/project/judge-project/script");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useSettingsStore.setState(settingsInitial);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("applying judge feedback", () => {
  it("updates canonical TIDEWE copy, Chinese translation and shots directly while retaining the report", async () => {
    await mount();
    await click("editCopy");
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    fetchMock.mockImplementation((url: string) => {
      if (url === applyUrl) return pending;
      throw new Error(`Unexpected request: ${url}`);
    });
    const apply = button("judgeApplyAdvice")!;
    await act(async () => { apply.click(); apply.click(); });
    expect(button("judgeAdviceApplying")?.disabled).toBe(true);
    expect(button("judgeButton")?.disabled).toBe(true);
    expect(button("regenerate")?.disabled).toBe(true);
    expect(fetchMock.mock.calls.filter(([url]) => url === applyUrl)).toHaveLength(1);
    const request = fetchMock.mock.calls.find(([url]) => url === applyUrl)!;
    expect(JSON.parse(request[1].body)).toMatchObject({
      scriptId: original.id, expectedScriptHash: original.scriptHash, report: feedback,
      llmConfig: { apiKey: "fixture-key", model: "fixture" },
    });
    const updatedCopy = { ...copy, text: "For a cold wait, I want warmth I can choose. Check the product details.", translation: "寒冷等待时，我希望能自己选择暖意。看看产品详情。" };
    const updated = { ...original, scriptHash: "updated-hash", copyDocument: updatedCopy, shots: [{ ...original.shots[0], voiceover: updatedCopy.text, description: "猎人将靴子移到镜头前展示" }] };
    await act(async () => finish(Response.json({ script: updated })));
    expect(container.textContent).toContain(updatedCopy.text);
    expect(container.textContent).toContain(updatedCopy.translation);
    expect(container.textContent).toContain(updated.shots[0].description);
    expect(container.textContent).toContain(feedback.summary);
    expect(container.textContent).toContain("judgeAppliedTip");
    expect(container.querySelector("#tidewe-copy-text")).toBeNull();
    expect(button("judgeApplyAdvice")).toBeUndefined();
    expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/llm/script" || (url === scriptsUrl && init?.method === "PATCH"))).toBe(false);
  });

  it("keeps the original and report after a conflict, then allows a retry", async () => {
    await mount();
    fetchMock.mockResolvedValueOnce(Response.json({ error: "The script changed. Run the judge panel again." }, { status: 409 }));
    await click("judgeApplyAdvice");
    expect(container.textContent).toContain(copy.text);
    expect(container.textContent).toContain(copy.translation);
    expect(container.textContent).toContain(feedback.summary);
    expect(container.textContent).toContain("The script changed. Run the judge panel again.");
    expect(button("judgeApplyAdvice")?.disabled).toBe(false);
    expect(container.textContent).not.toContain("judgeAppliedTip");
    fetchMock.mockResolvedValueOnce(Response.json({ script: { ...original, scriptHash: "updated-hash" } }));
    await click("judgeApplyAdvice");
    expect(container.textContent).toContain("judgeAppliedTip");
    expect(container.textContent).not.toContain("The script changed. Run the judge panel again.");
  });

  it("keeps taste-only feedback display-only", async () => {
    await mount(true, { ...feedback, verdicts: [{ judge: "voice", issues: [{ ...feedback.verdicts[0].issues[0], tier: "taste" }] }] });
    expect(button("judgeApplyAdvice")).toBeUndefined();
    expect(container.textContent).toContain("judgeTasteOnly");
    expect(container.textContent).not.toContain("judgeAllPass");
    expect(fetchMock.mock.calls.some(([url]) => url === applyUrl)).toBe(false);
  });

  it("also applies feedback-only reports for ordinary sales scripts", async () => {
    await mount(false);
    const updated = { ...original, styleType: "scene", copyDocument: null, scriptHash: "updated-hash", shots: [{ ...original.shots[0], voiceover: "Revised sales narration" }] };
    fetchMock.mockResolvedValueOnce(Response.json({ script: updated }));
    await click("judgeApplyAdvice");
    expect(fetchMock.mock.calls.some(([url, init]) => url === applyUrl && init?.method === "POST")).toBe(true);
    expect(container.textContent).toContain("Revised sales narration");
    expect(container.textContent).toContain("judgeAppliedTip");
  });

  it("uses the saved ordinary script hash when reviewing and applying after an inline edit", async () => {
    await mount(false);
    await click("editShot");
    const voiceover = container.querySelector("textarea")!;
    const editedText = "I check the fit before walking out into wet grass.";
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(voiceover, editedText);
      voiceover.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const edited = { ...original, styleType: "scene", copyDocument: null, scriptHash: "inline-edit-hash", shots: [{ ...original.shots[0], voiceover: editedText }] };
    const freshReport = { ...feedback, sourceScriptHash: edited.scriptHash };
    const applied = { ...edited, scriptHash: "applied-hash", shots: [{ ...edited.shots[0], voiceover: "I try the fit before heading into the wet grass." }] };
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === scriptsUrl && init?.method === "PATCH") return Response.json({ success: true, script: edited });
      if (url === reviewUrl) return Response.json(freshReport);
      if (url === applyUrl) return Response.json({ success: true, script: applied });
      throw new Error(`Unexpected request: ${url}`);
    });
    const save = [...container.querySelectorAll("button")].find((node) => node.textContent === "save")!;
    expect(save).toBeDefined();
    await act(async () => save.click());
    expect(fetchMock.mock.calls.some(([url, init]) => url === scriptsUrl && init?.method === "PATCH")).toBe(true);
    expect(container.textContent).toContain(editedText);
    await click("judgeButton");
    await click("judgeApplyAdvice");
    const request = fetchMock.mock.calls.find(([url]) => url === applyUrl);
    expect(request).toBeDefined();
    expect(JSON.parse(request![1].body)).toMatchObject({ expectedScriptHash: edited.scriptHash, report: { sourceScriptHash: edited.scriptHash } });
    expect(container.textContent).toContain(applied.shots[0].voiceover);
    expect(container.textContent).toContain("judgeAppliedTip");
    expect(container.textContent).not.toContain("judgeReportStale");
  });

  it("keeps concrete sales rewrites on their existing PATCH path without optimistic changes on failure", async () => {
    const report: JudgeReport = { ...feedback, verdicts: [], rewrites: [{ shotId: 1, voiceover: "Specific replacement narration", tier: "default" }] };
    await mount(false, report);
    expect(button("judgeApplyAdvice")).toBeUndefined();
    fetchMock.mockResolvedValueOnce(Response.json({ error: "Save unavailable" }, { status: 503 }));
    await click("judgeApply");
    expect(container.querySelector("textarea")?.value ?? container.textContent).toContain(copy.text);
    expect(container.textContent).toContain("Save unavailable");
    expect(container.textContent).not.toContain("judgeAppliedTip");
    const request = fetchMock.mock.calls.find(([url, init]) => url === scriptsUrl && init?.method === "PATCH")!;
    expect(JSON.parse(request[1].body)).toMatchObject({ scriptId: original.id, shotTexts: [{ shotId: 1, voiceover: "Specific replacement narration" }] });
    expect(fetchMock.mock.calls.some(([url]) => url === applyUrl)).toBe(false);
  });

  it("applies a mixed report together so suggestions without rewrites are also addressed", async () => {
    const report: JudgeReport = {
      ...feedback,
      verdicts: [...feedback.verdicts, { judge: "visual", issues: [{ shotId: 1, issue: "「自然静候」应补充具体可见动作。", tier: "default" }] }],
      rewrites: [{ shotId: 1, voiceover: "A proposed narration rewrite", tier: "default" }],
    };
    await mount(false, report);
    expect(button("judgeApplyAdvice")).toBeDefined();
    const updated = { ...original, styleType: "scene", copyDocument: null, scriptHash: "updated-hash", shots: [{ ...original.shots[0], voiceover: "Revised sales narration", description: "猎人提起靴子，双手转动靴身展示表面。" }] };
    fetchMock.mockResolvedValueOnce(Response.json({ script: updated }));
    await click("judgeApplyAdvice");
    const request = fetchMock.mock.calls.find(([url]) => url === applyUrl)!;
    expect(JSON.parse(request[1].body).report).toEqual(report);
    expect(fetchMock.mock.calls.some(([url, init]) => url === scriptsUrl && init?.method === "PATCH")).toBe(false);
    expect(container.textContent).toContain(updated.shots[0].voiceover);
    expect(container.textContent).toContain(updated.shots[0].description);
    expect(container.textContent).toContain("judgeAppliedTip");
  });
});
