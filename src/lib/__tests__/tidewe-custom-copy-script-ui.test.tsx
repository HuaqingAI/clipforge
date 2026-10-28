import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ScriptPage from "@/app/project/[id]/script/page";
import { createPremiumProductCgProfile, createShortVideoSalesProfile, createTideweOutdoorProfile } from "@/lib/creative-profiles";
import { useSettingsStore } from "@/lib/stores/settings-store";
import type { TideweCopyDocument } from "@/lib/tidewe/types";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "custom-copy-project" }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/components/project-header", () => ({ ProjectHeader: () => null }));
vi.mock("@/components/generation-runs-panel", () => ({ GenerationRunsPanel: () => null }));
vi.mock("@/lib/hooks/use-generation-runs", async (original) => ({ ...await original<typeof import("@/lib/hooks/use-generation-runs")>(), useGenerationRuns: () => ({ runs: [], loading: false, error: null }) }));
vi.mock("@/components/tidewe-project-settings", () => ({ TideweProjectSettings: () => null }));
vi.mock("@/components/script-history-dialog", () => ({ ScriptHistoryDialog: ({ onRestore }: { onRestore(id: string): Promise<void> }) => createElement("button", { onClick: () => void onRestore("historic") }, "restoreSavedOriginal") }));
vi.mock("@/lib/i18n", () => ({ useT: () => (key: string) => key, useLocale: () => "zh" }));

const settingsInitial = useSettingsStore.getInitialState();
const fetchMock = vi.fn();
const projectUrl = "/api/project/custom-copy-project";
const scriptsUrl = `${projectUrl}/scripts`;
const generationUrl = "/api/generation-runs";
const presenter = { id: "employee-presenter", name: "Jerry", appearance: "An adult with a green cap", referenceImages: ["/api/files/jerry.png"] };
const profile = createTideweOutdoorProfile({ presenter });
const project = { name: "TIDEWE waders", productName: "TIDEWE waders", productImages: [], creativeProfile: profile, creativeConfigRevision: 7 };
const originalText = "Cold mornings start here. Take a closer look at these waders.";
function script(id = "original", text = originalText, version = 1) {
  const document: TideweCopyDocument = {
    version: 1, language: "en-US", text, translation: "英文脚本的中文审阅译文。", angle: "scene_pain", hookType: "situation",
    claimedFactIds: [], factsSnapshot: { version: 1, brand: "TIDEWE", category: "waders", items: [] }, factsHash: "facts",
    corpusVersion: "test", compilerVersion: "test", exampleIds: [], wordCount: 13, estimatedDuration: 40,
  };
  return { id, selected: true, version, title: `TIDEWE ${id}`, styleType: "tidewe_outdoor", totalDuration: 40, scriptHash: `hash-${id}`, copyDocument: document,
    shots: [{ shotId: 1, type: "demo", duration: 40, description: "主播在水边展示涉水服", voiceover: text, visualSource: "ai_generate", transition: "direct_concat" }] };
}
let root: Root;
let container: HTMLDivElement;

function button(label: string, last = false): HTMLButtonElement {
  const matches = [...container.querySelectorAll("button")].filter((node) => node.textContent === label);
  expect(matches.length, `button ${label}`).toBeGreaterThan(0);
  return matches[last ? matches.length - 1 : 0];
}
async function click(label: string, last = false) {
  if (label === "copySourceManual" || label === "copySourceAi") {
    const source = container.querySelector(`input[type="radio"][value="${label === "copySourceManual" ? "manual" : "ai"}"]`) as HTMLInputElement;
    expect(source).not.toBeNull();
    await act(async () => source.click());
  } else await act(async () => button(label, last).click());
}
async function enterCopy(text: string, selector = "#tidewe-custom-copy-text") {
  const textarea = container.querySelector(selector) as HTMLTextAreaElement;
  expect(textarea).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function generationCalls() { return fetchMock.mock.calls.filter(([url]) => url === generationUrl).map(([url, init]) => [url, { ...init, body: JSON.stringify(JSON.parse(init.body).items[0].request) }] as const); }
async function submitReplacement() { await click("copyInputGenerate"); await click("copyInputGenerate", true); }

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const response = await fetchMock(url, init);
    if (url !== generationUrl || !response.ok) return response;
    const result = await response.json();
    return Response.json({ id: "run-script", projectId: "custom-copy-project", kind: "script", status: "completed", total: 1, done: 1, failed: 0,
      items: [{ id: "item-script", kind: "script", status: "completed", result }] });
  });
  useSettingsStore.setState({ ...settingsInitial, uiMode: "pro", llm: { provider: "fixture", baseUrl: "https://example.test", apiKey: "fixture-key", model: "fixture-model" } });
  fetchMock.mockReset().mockImplementation(async (url: string) => {
    if (url === projectUrl) return Response.json(project);
    if (url === scriptsUrl) return Response.json([script()]);
    throw new Error(`Unexpected request: ${url}`);
  });
  window.history.replaceState(null, "", "/project/custom-copy-project/script");
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

describe("TIDEWE employee copy on existing projects", () => {
  it("reopens a saved employee original in manual mode and replans that same text by default", async () => {
    const saved = script();
    saved.copyDocument.source = "user_provided";
    fetchMock.mockImplementation(async (url: string) => {
      if (url === projectUrl) return Response.json(project);
      if (url === scriptsUrl) return Response.json([saved]);
      if (url === generationUrl) return Response.json({ scripts: [script("employee-replanned", originalText, 2)] });
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => root.render(createElement(ScriptPage)));
    expect((container.querySelector('input[type="radio"][value="manual"]') as HTMLInputElement).checked).toBe(true);
    expect((container.querySelector("#tidewe-custom-copy-text") as HTMLTextAreaElement).value).toBe(originalText);
    await submitReplacement();
    expect(JSON.parse(generationCalls()[0][1].body)).toMatchObject({ copyText: originalText, count: 1 });
  });

  it("keeps an unsaved draft through alternate selection and a late historical-original restore", async () => {
    const saved = script();
    saved.copyDocument.source = "user_provided";
    const alternate = { ...script("alternate", "An alternate saved original."), selected: false };
    alternate.copyDocument.source = "user_provided";
    const historic = script("historic", "An older employee original.");
    historic.copyDocument.source = "user_provided";
    let finishRestore!: (response: Response) => void;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === projectUrl) return Response.json(project);
      if (url === scriptsUrl && init?.method === "PATCH") {
        const payload = JSON.parse(init.body as string);
        if (payload.restoreScriptId) return new Promise<Response>((resolve) => { finishRestore = resolve; });
        return Response.json({ ok: true });
      }
      if (url === scriptsUrl) return Response.json([saved, alternate]);
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => root.render(createElement(ScriptPage)));
    const draft = "My next complete English original stays in this input.";
    await enterCopy(draft);
    const title = [...container.querySelectorAll("h3")].find((node) => node.textContent === "TIDEWE alternate")!;
    await act(async () => (title.closest('[data-slot="card"]') as HTMLElement).click());
    expect((container.querySelector("#tidewe-custom-copy-text") as HTMLTextAreaElement).value).toBe(draft);
    await click("historyButton"); await click("restoreSavedOriginal");
    await act(async () => finishRestore(Response.json({ scripts: [historic] })));
    expect(container.textContent).toContain("TIDEWE historic");
    expect((container.querySelector("#tidewe-custom-copy-text") as HTMLTextAreaElement).value).toBe(draft);
  });

  it("uses the explicitly edited complete English original for the next planning action", async () => {
    const edited = "This is my own revised complete English script.";
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === projectUrl) return Response.json(project);
      if (url === scriptsUrl && init?.method === "PATCH") {
        const result = script("edited", edited, 2);
        result.copyDocument.source = "user_provided";
        return Response.json({ scripts: [result] });
      }
      if (url === scriptsUrl) return Response.json([script()]);
      if (url === generationUrl) {
        const request = JSON.parse(init!.body as string).items[0].request;
        const result = script(request.generationMethod === "PATCH" ? "edited" : "edited-replanned", edited, request.generationMethod === "PATCH" ? 2 : 3);
        result.copyDocument.source = "user_provided";
        return Response.json({ scripts: [result] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => root.render(createElement(ScriptPage)));
    await click("editCopy"); await enterCopy(edited, "#tidewe-copy-text"); await click("saveAndReplan");
    expect((container.querySelector('input[type="radio"][value="manual"]') as HTMLInputElement).checked).toBe(true);
    expect((container.querySelector("#tidewe-custom-copy-text") as HTMLTextAreaElement).value).toBe(edited);
    await submitReplacement();
    expect(JSON.parse(generationCalls()[1][1].body)).toMatchObject({ copyText: edited, sourceScriptId: "edited", expectedScriptHash: "hash-edited" });
  });

  it("accepts the first complete English script before any generated script exists", async () => {
    let posted: Record<string, unknown> | undefined;
    const employeeCopy = "  I know this cold walk.\n\nThese are the waders I brought today.  ";
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === projectUrl) return Response.json(project);
      if (url === scriptsUrl) return Response.json([]);
      if (url === generationUrl) {
        posted = JSON.parse(init!.body as string).items[0].request;
        return Response.json({ scripts: [script("employee-first", employeeCopy)] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => root.render(createElement(ScriptPage)));
    await click("copySourceManual");
    expect(button("copyInputGenerate").disabled).toBe(true);
    await enterCopy(employeeCopy);
    await click("copyInputGenerate");
    expect(posted).toMatchObject({ projectId: "custom-copy-project", copyText: employeeCopy, count: 1, expectedCreativeConfigRevision: 7, requestId: expect.any(String), creativeProfile: { presenter } });
    expect(posted).not.toHaveProperty("sourceScriptId");
    expect(container.textContent).toContain("TIDEWE employee-first");
    expect(container.textContent).toContain("These are the waders I brought today.");
  });

  it.each(["simple", "pro"] as const)("submits exact employee text with the selected script's concurrency guards in %s mode", async (uiMode) => {
    useSettingsStore.setState({ uiMode });
    let complete!: (response: Response) => void;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === projectUrl) return Response.json(project);
      if (url === scriptsUrl) return Response.json([script()]);
      if (url === generationUrl) return new Promise<Response>((resolve) => { complete = resolve; });
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => root.render(createElement(ScriptPage)));
    await click("copySourceManual");
    const employeeCopy = "Don't rush the water.\nI brought my TIDEWE waders for this morning.";
    await enterCopy(employeeCopy);
    await click("copySourceAi");
    await click("copySourceManual");
    expect((container.querySelector("#tidewe-custom-copy-text") as HTMLTextAreaElement).value).toBe(employeeCopy);
    await submitReplacement();
    const request = JSON.parse(generationCalls()[0][1].body);
    expect(request).toMatchObject({ copyText: employeeCopy, count: 1, sourceScriptId: "original", expectedScriptHash: "hash-original", expectedCreativeConfigRevision: 7, creativeProfile: { presenter } });
    expect(button("copyInputGenerating").disabled).toBe(true);
    expect(container.querySelector('input[type="radio"][value="ai"]')?.closest("fieldset")?.disabled).toBe(true);
    expect((container.querySelector("#tidewe-custom-copy-text") as HTMLTextAreaElement).disabled).toBe(true);
    await act(async () => { button("copyInputGenerating").click(); });
    expect(generationCalls()).toHaveLength(1);
    await act(async () => complete(Response.json({ scripts: [script("employee-next", employeeCopy, 2)] })));
    expect(container.textContent).toContain("TIDEWE employee-next");
    expect(button("copyInputGenerate").disabled).toBe(false);
  });

  it("retains the employee draft and original script when planning fails, then permits a retry", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === projectUrl) return Response.json(project);
      if (url === scriptsUrl) return Response.json([script()]);
      if (url === generationUrl) return Response.json({ error: "The project changed. Refresh and retry." }, { status: 409 });
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => root.render(createElement(ScriptPage)));
    await click("copySourceManual");
    const employeeCopy = "The first step is always cold. I brought these waders today.";
    await enterCopy(employeeCopy);
    await submitReplacement();
    expect(container.textContent).toContain("The project changed. Refresh and retry.");
    expect(container.textContent).toContain("TIDEWE original");
    expect(container.textContent).toContain(originalText);
    expect((container.querySelector("#tidewe-custom-copy-text") as HTMLTextAreaElement).value).toBe(employeeCopy);
    await submitReplacement();
    expect(generationCalls()).toHaveLength(2);
    const requests = generationCalls().map(([, init]) => JSON.parse(init.body));
    expect(requests[0].copyText).toBe(requests[1].copyText);
    expect(requests[0].requestId).not.toBe(requests[1].requestId);
  });

  it("does not send the retained manual draft when the user chooses AI creation", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === projectUrl) return Response.json(project);
      if (url === scriptsUrl) return Response.json([script()]);
      if (url === generationUrl) return Response.json({ scripts: [script("ai-next", originalText, 2)] });
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => root.render(createElement(ScriptPage)));
    await click("copySourceManual"); await enterCopy("Employee draft for another take."); await click("copySourceAi");
    await click("regenerate"); await click("regenConfirmOk");
    const request = JSON.parse(generationCalls()[0][1].body);
    expect(request).not.toHaveProperty("copyText");
    expect(request).not.toHaveProperty("count");
  });

  it.each([createShortVideoSalesProfile(), createPremiumProductCgProfile()])("keeps the manual TIDEWE source control out of other creation types: $creationType", async (creativeProfile) => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === projectUrl) return Response.json({ ...project, creativeProfile });
      if (url === scriptsUrl) return Response.json([script()]);
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => root.render(createElement(ScriptPage)));
    expect(container.textContent).not.toContain("copySourceManual");
    expect(container.querySelector("#tidewe-custom-copy-text")).toBeNull();
  });
});
