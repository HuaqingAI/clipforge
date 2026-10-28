import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NewProjectPage from "@/app/project/new/page";
import ScriptPage from "@/app/project/[id]/script/page";
import { createTideweOutdoorProfile } from "@/lib/creative-profiles";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { useCharacterStore, type Character } from "@/lib/stores/project-store";
import { buildTideweProductFacts, tideweProductInputFromFacts } from "@/components/tidewe-product-fields";
import { TideweProjectSettings } from "@/components/tidewe-project-settings";
import { snapshotTidewePresenter } from "@/lib/tidewe/presenter";
import { normalizeProductFacts } from "@/lib/tidewe/facts";
import { AD_TEMPLATES } from "@/lib/ad-templates";
import type { ProductFacts, TideweCopyDocument } from "@/lib/tidewe/types";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "tidewe-project" }),
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("@/components/project-header", () => ({ ProjectHeader: () => null }));
const i18nOptions = vi.hoisted(() => ({ showModeCopy: false }));
vi.mock("@/lib/i18n", async () => {
  const { tidewe } = await import("@/lib/i18n/messages/tidewe");
  const { newProject } = await import("@/lib/i18n/messages/newProject");
  const modeKeys = new Set(["modeCloseupLabel", "modeCloseupDesc", "modeSceneLabel", "modeSceneDesc", "cgModeCloseupLabel", "cgModeCloseupDesc", "cgModeSceneLabel", "cgModeSceneDesc", "modeHint"]);
  return {
    useT: (namespace: string) => (key: string) => i18nOptions.showModeCopy && modeKeys.has(key)
      ? (namespace === "tidewe" ? tidewe : newProject).zh[key] ?? key
      : key,
    useLocale: () => "zh",
  };
});

const fetchMock = vi.fn();
const settingsInitial = useSettingsStore.getInitialState();
const charactersInitial = useCharacterStore.getInitialState();
const hunter: Character = { id: "hunter-1", name: "Outdoor creator", appearance: "An adult hunter with a short beard and a green cap", description: "Calm gear demonstrations", referenceImages: ["/api/files/hunter-sheet.png"], sourceReferenceImages: ["https://example.test/hunter.png"] };
let root: Root;
let container: HTMLDivElement;
const facts: ProductFacts = { version: 1, brand: "TIDEWE", category: "heated_apparel", sku: "HJ006", items: [] };
const copy: TideweCopyDocument = {
  version: 1, language: "en-US", text: "Cold mornings are when I want a choice. Take a closer look.", translation: "冷天更想要能自己选择。可以仔细看看。", angle: "scene_pain", hookType: "situation", claimedFactIds: [], factsSnapshot: facts, factsHash: "facts", corpusVersion: "test", compilerVersion: "test", exampleIds: [], wordCount: 13, estimatedDuration: 40,
};
function script(id = "copy-1", selected = true, version = 1, document = copy) {
  return { id, selected, version, title: `TIDEWE ${id}`, styleType: "tidewe_outdoor", totalDuration: 40, scriptHash: `hash-${id}`, copyDocument: document, shots: [{ shotId: 1, type: "demo", duration: 40, description: "猎帐内自然静候", voiceover: document.text, visualSource: "ai_generate", transition: "direct_concat" }] };
}
const project = { name: "TIDEWE jacket", productName: "TIDEWE jacket", productCategory: "heated_apparel", productImages: [], creativeProfile: createTideweOutdoorProfile(), creativeConfigRevision: 4, productFacts: facts };
function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll("button")].find((node) => node.textContent === label || node.textContent?.startsWith(label));
  expect(result, `button ${label}`).toBeDefined(); return result!;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function changeText(selector: string, value: string) {
  const input = container.querySelector(selector) as HTMLTextAreaElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function changeInput(selector: string, value: string) {
  const input = container.querySelector(selector) as HTMLInputElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function changeSelect(selector: string, value: string) {
  const input = container.querySelector(selector) as HTMLSelectElement;
  expect(input).not.toBeNull();
  await act(async () => { input.value = value; input.dispatchEvent(new Event("change", { bubbles: true })); });
}
beforeEach(() => {
  i18nOptions.showModeCopy = false;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", fetchMock);
  useSettingsStore.setState({ ...settingsInitial, uiMode: "pro", llm: { provider: "fixture", baseUrl: "https://example.test", apiKey: "fixture-key", model: "fixture" } });
  useCharacterStore.setState({ ...charactersInitial, characters: [] });
  fetchMock.mockReset().mockImplementation(async (url: string) => {
    if (url.startsWith("/api/generation-runs?")) return Response.json({ runs: [] });
    if (url === "/api/ad-template/mine") return Response.json({ templates: [] });
    if (url === "/api/project/tidewe-project") return Response.json(project);
    if (url === "/api/project/tidewe-project/scripts") return Response.json([script()]);
    throw new Error(`Unexpected request: ${url}`);
  });
  window.history.replaceState(null, "", "/project/new");
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useSettingsStore.setState(settingsInitial); useCharacterStore.setState(charactersInitial); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("TIDEWE product facts input", () => {
  it("supports image-only projects and gives unrelated specifications distinct keys", () => {
    expect(buildTideweProductFacts({ category: "other", sku: "", specifications: "", source: "" }).items).toEqual([]);
    const result = normalizeProductFacts(buildTideweProductFacts({ category: "heated_apparel", sku: "HJ006", specifications: "Three heat settings\nBattery sold separately", source: "manual-check" }))!;
    expect(result.items.map((item) => item.status)).toEqual(["confirmed", "confirmed"]);
    expect(result.blockedClaims).toBeUndefined();
  });
  it("preserves observed information, original sources and restrictions without promoting image guesses", () => {
    const existing: ProductFacts = { ...facts, items: [
      { id: "image-1", key: "color", value: "Camo", status: "observed", source: { kind: "uploaded_image", ref: "image.png" } },
      { id: "battery", key: "batteryIncluded", value: "Battery sold separately", status: "confirmed", source: { kind: "product_page", ref: "https://example.test/HJ006" } },
    ], blockedClaims: [{ key: "runtime", reason: "Conflicting sources", sourceRefs: ["manual"] }] };
    const result = buildTideweProductFacts(tideweProductInputFromFacts(existing), existing);
    expect(result.items).toEqual(existing.items);
    expect(result.blockedClaims).toEqual(existing.blockedClaims);
    expect(tideweProductInputFromFacts(existing).specifications).not.toContain("Camo");
  });
  it("does not turn reordered existing and newly added specifications into false conflicts", () => {
    const existing = buildTideweProductFacts({ category: "heated_apparel", sku: "HJ006", specifications: "Three heat settings\nBattery sold separately", source: "manual-check" });
    const result = normalizeProductFacts(buildTideweProductFacts({ category: "heated_apparel", sku: "HJ006", specifications: "Battery sold separately\nCamo pattern", source: "new-check" }, existing))!;
    expect(result.items[0]).toEqual(existing.items[1]);
    expect(new Set(result.items.map((item) => item.key)).size).toBe(2);
    expect(result.blockedClaims).toBeUndefined();
    const inserted = normalizeProductFacts(buildTideweProductFacts({ category: "heated_apparel", sku: "HJ006", specifications: "Camo pattern\nThree heat settings", source: "new-check" }, existing))!;
    expect(inserted.items[1]).toEqual(existing.items[0]);
    expect(new Set(inserted.items.map((item) => item.id)).size).toBe(2);
    expect(inserted.blockedClaims).toBeUndefined();
  });
});

describe("TIDEWE creation and script editing", () => {
  it("shows people and visible faces only in TIDEWE's scene-mode copy while retaining sales and CG descriptions", async () => {
    i18nOptions.showModeCopy = true;
    await act(async () => root.render(createElement(NewProjectPage)));
    await click("label");
    expect(button("真人场景演示").className).toContain("bg-primary/10");
    expect(container.textContent).toContain("真人边演示边用英语口播，嘴部清晰可见");
    expect(container.textContent).toContain("真人自然演示，可露脸出镜，用美式英语介绍装备，嘴型配合发音并保留原声；同步程度取决于视频模型。");
    expect(container.textContent).toContain("真人口播介绍装备细节，穿插无口播特写");
    expect(container.textContent).not.toContain("不含人脸");
    await click("产品特写");
    expect(button("产品特写").className).toContain("bg-primary/10");
    await click("creationTypeSalesLabel");
    expect(container.textContent).toContain("AI 生成使用场景，不含人脸");
    expect(container.textContent).not.toContain("真人场景演示");
    await click("creationTypeCgLabel");
    expect(container.textContent).toContain("使用场景 CG");
    expect(container.textContent).toContain("按产品品类匹配场景，以真实尺度与适度交互呈现产品");
    expect(container.textContent).not.toContain("人物可露脸");
  });
  it("keeps three independent duration drafts and skips domestic sales choices", async () => {
    await act(async () => root.render(createElement(NewProjectPage)));
    await click("creationTypeSalesLabel"); await click("60s"); await click("label");
    expect(button("40s").className).toContain("bg-primary/10");
    expect(container.querySelector("#tidewe-category")).not.toBeNull();
    expect(container.textContent).toContain("language");
    expect(container.textContent).not.toContain("templatesSummary");
    expect(container.textContent).not.toContain("platformDouyin");
    expect(container.textContent).not.toContain("sourceIngestLead");
    expect(container.textContent).not.toContain("sourceExampleLead");
    await click("30s"); await click("creationTypeCgLabel");
    expect(button("30s").className).toContain("bg-primary/10");
    await click("creationTypeSalesLabel"); expect(button("60s").className).toContain("bg-primary/10");
    await click("label"); expect(button("30s").className).toContain("bg-primary/10");
  });
  it.each([
    ["short_video_sales", "creationTypeSalesLabel", "modeCloseupLabel"],
    ["premium_product_cg", "creationTypeCgLabel", "cgModeCloseupLabel"],
  ])("opens the %s shortcut with its default configuration and product form", async (creationType, label, modeLabel) => {
    window.history.replaceState(null, "", `/project/new?creationType=${creationType}`);
    await act(async () => root.render(createElement(NewProjectPage)));
    expect(button(label).className).toContain("bg-primary/10");
    expect(button("30s").className).toContain("bg-primary/10");
    expect(button(modeLabel).className).toContain("bg-primary/10");
    expect(container.querySelector("#productName")).not.toBeNull();
    expect(container.querySelector("#tidewe-category")).toBeNull();
  });
  it("opens the TIDEWE shortcut with 40 seconds and the outdoor facts editor", async () => {
    window.history.replaceState(null, "", "/project/new?creationType=tidewe_outdoor");
    await act(async () => root.render(createElement(NewProjectPage)));
    expect(button("label").className).toContain("bg-primary/10");
    expect(button("40s").className).toContain("bg-primary/10");
    expect(button("modeSceneLabel").className).toContain("bg-primary/10");
    expect(container.querySelector("#productName")).not.toBeNull();
    expect(container.querySelector("#tidewe-category")).not.toBeNull();
  });
  it("leaves creation types unselected for an unknown shortcut", async () => {
    window.history.replaceState(null, "", "/project/new?creationType=unknown");
    await act(async () => root.render(createElement(NewProjectPage)));
    for (const label of ["creationTypeSalesLabel", "creationTypeCgLabel", "label"]) {
      expect(button(label).className).not.toContain("bg-primary/10");
    }
    expect(container.querySelector("#productName")).toBeNull();
    expect(container.querySelector("#tidewe-category")).toBeNull();
  });
  it("keeps an asynchronous sales-template result inside its sales draft after switching to TIDEWE", async () => {
    let finishTemplate!: (response: Response) => void;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/ad-template/mine") return Response.json({ templates: [] });
      if (url === "/api/ad-template/generate") return new Promise<Response>((resolve) => { finishTemplate = resolve; });
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => root.render(createElement(NewProjectPage)));
    await click("creationTypeSalesLabel");
    await changeInput("#productName", "TIDEWE jacket");
    await click("adTemplateAiButton");
    await click("label");
    await act(async () => finishTemplate(Response.json({ template: { ...AD_TEMPLATES[0], styleType: "talking_head", videoMode: "live_presenter" } })));
    expect(button("modeSceneLabel").className).toContain("bg-primary/10");
    expect(container.textContent).not.toContain("modePresenterLabel");
    await click("creationTypeSalesLabel");
    expect(button("modePresenterLabel").className).toContain("bg-primary/10");
  });
  it.each([false, true])("creates a TIDEWE project with an optional frozen presenter and the latest image revision, selected=%s", async (selected) => {
    useCharacterStore.setState({ characters: [hunter] });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:tidewe-fixture");
    window.history.replaceState(null, "", "/project/new?creationType=tidewe_outdoor");
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/ad-template/mine") return Response.json({ templates: [] });
      if (url === "/api/project") return Response.json({ id: "new-tidewe", creativeConfigRevision: 1 });
      if (url === "/api/upload") return Response.json({ paths: ["/uploads/product.png"] });
      if (url === "/api/project/new-tidewe" && init?.method === "PATCH") {
        const body = JSON.parse(init.body as string);
        if (body.expectedCreativeConfigRevision !== 1) return Response.json({ error: "Revision required" }, { status: 400 });
        return Response.json({ id: "new-tidewe", creativeConfigRevision: 2 });
      }
      if (url === "/api/generation-runs") return Response.json({ id: "new-script-run" }, { status: 202 });
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => root.render(createElement(NewProjectPage)));
    if (selected) await changeSelect("#tidewe-presenter", hunter.id);
    await changeInput("#productName", "TIDEWE outdoor jacket");
    const upload = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(upload, "files", { value: [new File(["product"], "product.png", { type: "image/png" })] });
    await act(async () => upload.dispatchEvent(new Event("change", { bubbles: true })));
    await click("submit");
    const creation = JSON.parse(fetchMock.mock.calls.find(([url]) => url === "/api/project")![1].body);
    expect(creation).toMatchObject({ productFacts: { items: [] }, creativeProfile: { creationType: "tidewe_outdoor", targetDuration: 40, speechMode: "on_camera" } });
    if (selected) expect(creation.creativeProfile.presenter).toEqual(snapshotTidewePresenter(hunter));
    else expect(creation.creativeProfile).not.toHaveProperty("presenter");
    const registered = JSON.parse(fetchMock.mock.calls.find(([url]) => url === "/api/generation-runs")![1].body);
    expect(registered).toMatchObject({ projectId: "new-tidewe", kind: "script", items: [{ kind: "script" }] });
    const generation = registered.items[0].request;
    expect(generation).toMatchObject({ expectedCreativeConfigRevision: 2, requestId: expect.any(String), platforms: "tiktok", styleType: "tidewe_outdoor", productImages: ["/uploads/product.png"] });
    expect(generation).not.toHaveProperty("templateId");
    expect(generation).not.toHaveProperty("customRequirements");
    expect(generation.creativeProfile.presenter).toEqual(creation.creativeProfile.presenter);
  });
  it("keeps TIDEWE's presenter draft separate from the sales presenter and supports appearance-only or image-only identities", async () => {
    const sales: Character = { id: "sales", name: "Sales creator", appearance: "An adult wearing a plain shirt", referenceImages: [] };
    const imageOnly: Character = { id: "portrait-only", name: "Portrait creator", referenceImages: [], sourceReferenceImages: ["/api/files/portrait.png"] };
    const incomplete: Character = { id: "empty", name: "Incomplete", referenceImages: [] };
    useCharacterStore.setState({ characters: [hunter, sales, imageOnly, incomplete] });
    await act(async () => root.render(createElement(NewProjectPage)));
    await click("creationTypeSalesLabel"); await click("modePresenterLabel"); await click(sales.name);
    expect(button(sales.name).className).toContain("bg-primary/10");
    await click("label");
    await changeSelect("#tidewe-presenter", hunter.id);
    expect(container.textContent).toContain(hunter.appearance);
    expect((container.querySelector('#tidewe-presenter option[value="empty"]') as HTMLOptionElement).disabled).toBe(true);
    await changeSelect("#tidewe-presenter", imageOnly.id);
    expect(container.querySelector('img[src="/api/files/portrait.png"]')).not.toBeNull();
    expect(container.textContent).toContain("presenterImageOnly");
    await changeSelect("#tidewe-presenter", sales.id);
    expect(container.textContent).toContain(sales.appearance);
    await changeSelect("#tidewe-presenter", hunter.id);
    await click("creationTypeSalesLabel");
    expect(button(sales.name).className).toContain("bg-primary/10");
    expect(button(hunter.name).className).not.toContain("bg-primary/10");
    await click("label");
    expect((container.querySelector("#tidewe-presenter") as HTMLSelectElement).value).toBe(hunter.id);
  });
  it("shows canonical English and Chinese, then explicitly saves a new fully planned version with concurrency guards", async () => {
    await act(async () => root.render(createElement(ScriptPage)));
    expect(container.textContent).toContain(copy.text); expect(container.textContent).toContain(copy.translation);
    await click("editCopy");
    const changed = "I want the warmth I can choose for this cold wait. Have a closer look.";
    await changeText("#tidewe-copy-text", changed);
    const updated = { ...copy, text: changed, translation: "我想按需要选择暖意。" };
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/generation-runs?")) return Response.json({ runs: [] });
      if (url === "/api/generation-runs" && init?.method === "POST") return Response.json({ id: "replan-run", projectId: "tidewe-project", kind: "script", status: "completed", items: [{ id: "replan-item", kind: "script", status: "completed", result: { scripts: [script("copy-1", false), script("copy-2", true, 2, updated)] } }] });
      throw new Error(`Unexpected request: ${url}`);
    });
    await click("saveAndReplan");
    const request = fetchMock.mock.calls.find(([url, init]) => url === "/api/generation-runs" && init?.method === "POST");
    expect(JSON.parse(request![1].body).items[0].request).toMatchObject({ generationEndpoint: "/api/project/tidewe-project/scripts", generationMethod: "PATCH", scriptId: "copy-1", expectedScriptHash: "hash-copy-1", expectedCreativeConfigRevision: 4, copyText: changed, requestId: expect.any(String), llmConfig: { apiKey: "fixture-key" } });
    expect(container.textContent).toContain(updated.translation);
    expect(container.textContent).toContain("TIDEWE copy-2");
  });
  it("retains the original copy and the edit on a failed replanning request", async () => {
    await act(async () => root.render(createElement(ScriptPage)));
    await click("editCopy"); await changeText("#tidewe-copy-text", "A new complete English narration.");
    fetchMock.mockResolvedValue(Response.json({ error: "Revision changed; refresh this project." }, { status: 409 }));
    await click("saveAndReplan");
    expect(container.querySelector("#tidewe-copy-text")).not.toBeNull();
    expect(container.textContent).toContain("Revision changed; refresh this project.");
    expect(container.textContent).toContain(copy.translation);
  });
  it("preserves historical voiceover on save and allows an explicit revision-guarded switch to on-camera speech", async () => {
    const profile = createTideweOutdoorProfile({ speechMode: "voiceover" });
    const saved = vi.fn();
    fetchMock.mockResolvedValue(Response.json({ ...project, creativeProfile: profile }));
    await act(async () => root.render(createElement(TideweProjectSettings, { projectId: "tidewe-project", revision: 4, facts, profile, drafts: { tidewe_outdoor: profile }, disabled: false, onBusyChange: vi.fn(), onSaved: saved })));
    const mode = container.querySelector('[aria-label="speechMode"]') as HTMLSelectElement;
    expect(mode.value).toBe("voiceover");
    await click("saveFacts");
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toMatchObject({ expectedCreativeConfigRevision: 4, creativeProfile: { speechMode: "voiceover" } });
    await act(async () => { mode.value = "on_camera"; mode.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.textContent).toContain("speechChangeHint");
    await click("saveFacts");
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toMatchObject({ expectedCreativeConfigRevision: 4, creativeProfile: { speechMode: "on_camera" }, creativeProfileDrafts: { tidewe_outdoor: { speechMode: "on_camera" } } });
    expect(saved).toHaveBeenCalledTimes(2);
  });
  it("retains a deleted presenter's saved identity and only syncs library changes explicitly before saving", async () => {
    const presenter = snapshotTidewePresenter(hunter)!;
    const profile = createTideweOutdoorProfile({ presenter });
    fetchMock.mockResolvedValue(Response.json({ ...project, creativeProfile: profile }));
    await act(async () => root.render(createElement(TideweProjectSettings, { projectId: "tidewe-project", revision: 4, facts, profile, drafts: { tidewe_outdoor: profile }, disabled: false, onBusyChange: vi.fn(), onSaved: vi.fn() })));
    expect(container.textContent).toContain("presenterDeletedHint");
    expect(container.textContent).toContain(hunter.appearance);
    expect(container.querySelector('img[src="/api/files/hunter-sheet.png"]')).not.toBeNull();
    await click("saveFacts");
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toMatchObject({ expectedCreativeConfigRevision: 4, creativeProfile: { presenter } });
    const changed = { ...hunter, appearance: "An adult hunter with a blue cap", referenceImages: ["/api/files/new-sheet.png"] };
    await act(async () => useCharacterStore.setState({ characters: [changed] }));
    expect(container.textContent).toContain(hunter.appearance);
    expect(container.textContent).not.toContain(changed.appearance);
    await click("saveFacts");
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body).creativeProfile.presenter).toEqual(presenter);
    await click("presenterSync");
    expect(container.textContent).toContain(changed.appearance);
    await click("saveFacts");
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toMatchObject({ expectedCreativeConfigRevision: 4, creativeProfile: { presenter: snapshotTidewePresenter(changed) }, creativeProfileDrafts: { tidewe_outdoor: { presenter: snapshotTidewePresenter(changed) } } });
    await changeSelect("#project-tidewe-presenter", ""); await click("saveFacts");
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body).creativeProfile).not.toHaveProperty("presenter");
  });
});
