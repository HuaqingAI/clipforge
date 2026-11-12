import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NewProjectPage from "@/app/project/new/page";
import ScriptPage from "@/app/project/[id]/script/page";
import { createTideweOutdoorProfile } from "@/lib/creative-profiles";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { useProductLibraryStore } from "@/lib/stores/product-library-store";
import { useCharacterStore, type Character } from "@/lib/stores/project-store";
import { TideweProductFields, buildTideweProductFacts, tideweProductInputFromFacts } from "@/components/tidewe-product-fields";
import { TIDEWE_SHOP_CATEGORIES } from "@/lib/tidewe/categories";
import { TideweProjectSettings } from "@/components/tidewe-project-settings";
import { snapshotTidewePresenter } from "@/lib/tidewe/presenter";
import { normalizeProductFacts } from "@/lib/tidewe/facts";
import type { ProductFacts, TideweCopyDocument } from "@/lib/tidewe/types";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "tidewe-project" }),
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("@/components/project-header", () => ({ ProjectHeader: () => null }));
const i18nOptions = vi.hoisted(() => ({ showModeCopy: false, showProductCopy: false, locale: "zh" as "zh" | "en" }));
vi.mock("@/lib/i18n", async () => {
  const { tidewe } = await import("@/lib/i18n/messages/tidewe");
  const { newProject } = await import("@/lib/i18n/messages/newProject");
  const modeKeys = new Set(["modeCloseupLabel", "modeCloseupDesc", "modeSceneLabel", "modeSceneDesc", "cgModeCloseupLabel", "cgModeCloseupDesc", "cgModeSceneLabel", "cgModeSceneDesc", "modeHint"]);
  return {
    useT: (namespace: string) => (key: string) => i18nOptions.showProductCopy && namespace === "tidewe"
      ? tidewe[i18nOptions.locale][key] ?? key
      : i18nOptions.showModeCopy && modeKeys.has(key) ? (namespace === "tidewe" ? tidewe : newProject).zh[key] ?? key : key,
    useLocale: () => i18nOptions.locale,
  };
});

const fetchMock = vi.fn();
const settingsInitial = useSettingsStore.getInitialState();
const charactersInitial = useCharacterStore.getInitialState();
const productsInitial = useProductLibraryStore.getInitialState();
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
  i18nOptions.showProductCopy = false; i18nOptions.locale = "zh";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", fetchMock);
  useSettingsStore.setState({ ...settingsInitial, uiMode: "pro", llm: { provider: "fixture", baseUrl: "https://example.test", apiKey: "fixture-key", model: "fixture" } });
  useCharacterStore.setState({ ...charactersInitial, characters: [] });
  useProductLibraryStore.setState({ ...productsInitial, products: [] });
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
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useSettingsStore.setState(settingsInitial); useCharacterStore.setState(charactersInitial); useProductLibraryStore.setState(productsInitial); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("TIDEWE product facts input", () => {
  it("supports empty historical facts and gives unrelated selling points distinct keys", () => {
    expect(buildTideweProductFacts({ category: "other", specifications: "" }).items).toEqual([]);
    const result = normalizeProductFacts(buildTideweProductFacts({ category: "heated_apparel", specifications: "Three heat settings\nBattery sold separately" }))!;
    expect(result.category).toBe("heated_gear");
    expect(result.sku).toBeUndefined();
    expect(result.items.map((item) => item.status)).toEqual(["confirmed", "confirmed"]);
    expect(result.items.map((item) => item.source)).toEqual(result.items.map((item) => ({ kind: "manual", ref: "user-entered", excerpt: item.value })));
    expect(result.blockedClaims).toBeUndefined();
  });
  it("preserves observed information, original sources and restrictions without promoting image guesses", () => {
    const existing: ProductFacts = { ...facts, items: [
      { id: "image-1", key: "color", value: "Camo", status: "observed", source: { kind: "uploaded_image", ref: "image.png" } },
      { id: "battery", key: "batteryIncluded", value: "Battery sold separately", status: "confirmed", source: { kind: "product_page", ref: "https://example.test/HJ006" } },
    ], blockedClaims: [{ key: "runtime", reason: "Conflicting sources", sourceRefs: ["manual"] }] };
    const result = buildTideweProductFacts(tideweProductInputFromFacts(existing), existing);
    expect(result.sku).toBe(existing.sku);
    expect(result.items).toEqual(existing.items);
    expect(result.blockedClaims).toEqual(existing.blockedClaims);
    expect(tideweProductInputFromFacts(existing).specifications).not.toContain("Camo");
  });
  it("does not turn reordered existing and newly added specifications into false conflicts", () => {
    const existing: ProductFacts = { ...facts, items: [
      { id: "manual-1", key: "specification-1", value: "Three heat settings", status: "confirmed", source: { kind: "manual", ref: "manual-check" } },
      { id: "manual-2", key: "specification-2", value: "Battery sold separately", status: "confirmed", source: { kind: "product_page", ref: "https://example.test/HJ006" } },
    ] };
    const result = normalizeProductFacts(buildTideweProductFacts({ category: "heated_apparel", specifications: "Battery sold separately\nCamo pattern" }, existing))!;
    expect(result.items[0]).toEqual(existing.items[1]);
    expect(result.items[1].source).toEqual({ kind: "manual", ref: "user-entered", excerpt: "Camo pattern" });
    expect(new Set(result.items.map((item) => item.key)).size).toBe(2);
    expect(result.blockedClaims).toBeUndefined();
    const inserted = normalizeProductFacts(buildTideweProductFacts({ category: "heated_apparel", specifications: "Camo pattern\nThree heat settings" }, existing))!;
    expect(inserted.items[1]).toEqual(existing.items[0]);
    expect(new Set(inserted.items.map((item) => item.id)).size).toBe(2);
    expect(inserted.blockedClaims).toBeUndefined();
  });
  it.each([
    { locale: "zh" as const, labels: ["狩猎帐篷", "涉水服", "加热装备", "服装", "靴子", "配件"], placeholder: "请选择", sellingPointsLabel: "产品卖点（每行一项）", removedLabels: ["产品型号 / SKU", "规格来源"] },
    { locale: "en" as const, labels: ["Hunting Blinds", "Waders", "Heated Gear", "Apparel", "Boots", "Accessories"], placeholder: "Please select", sellingPointsLabel: "Product selling points (one per line)", removedLabels: ["Model / SKU", "Specification source"] },
  ])("offers required selling points and six SHOP choices without model or source inputs: $locale", async ({ locale, labels, placeholder, sellingPointsLabel, removedLabels }) => {
    i18nOptions.showProductCopy = true; i18nOptions.locale = locale;
    const changed = vi.fn();
    const value = { category: "other" as const, specifications: "Confirmed specification" };
    await act(async () => root.render(createElement(TideweProductFields, { value, onChange: changed })));
    const select = container.querySelector<HTMLSelectElement>("#tidewe-category")!;
    expect([...select.options].map((option) => [option.value, option.text])).toEqual([["", placeholder], ...TIDEWE_SHOP_CATEGORIES.map((category, index) => [category, labels[index]])]);
    expect(select.value).toBe("");
    expect(select.options[0].disabled).toBe(true);
    expect([...select.options].filter((option) => !option.disabled)).toHaveLength(6);
    expect(container.querySelector("#tidewe-sku")).toBeNull();
    expect(container.querySelector("#tidewe-source")).toBeNull();
    const sellingPoints = container.querySelector<HTMLTextAreaElement>("#tidewe-specifications")!;
    const sellingPointsTitle = container.querySelector('label[for="tidewe-specifications"]')!;
    expect(sellingPoints.required).toBe(true);
    expect(sellingPoints.getAttribute("aria-required")).toBe("true");
    expect(sellingPointsTitle.textContent).toContain(sellingPointsLabel);
    expect(sellingPointsTitle.querySelector(".text-destructive")?.textContent?.trim()).toBe("*");
    for (const label of removedLabels) expect(container.textContent).not.toContain(label);
    for (const category of TIDEWE_SHOP_CATEGORIES) {
      await changeSelect("#tidewe-category", category);
      expect(changed).toHaveBeenLastCalledWith({ ...value, category });
      expect(buildTideweProductFacts(changed.mock.calls.at(-1)![0]).category).toBe(category);
    }
    expect(changed).toHaveBeenCalledTimes(6);
  });
  it.each([
    { legacy: "hunting_chair" as const, shop: "accessories", next: "hunting_blind" },
    { legacy: "heated_apparel" as const, shop: "heated_gear", next: "waders" },
    { legacy: "hunting_apparel" as const, shop: "apparel", next: "boots" },
    { legacy: "waterproof_boots" as const, shop: "boots", next: "apparel" },
  ])("shows legacy $legacy as SHOP $shop and saves canonical product data after a user selection", async ({ legacy, shop, next }) => {
    const stored: ProductFacts = { ...facts, category: legacy, items: [
      { id: "heat", key: "heatSettings", value: "Three heat settings", status: "confirmed", source: { kind: "manual", ref: "verified-manual", excerpt: "Three settings" } },
      { id: "battery", key: "batteryIncluded", value: "Battery sold separately", status: "confirmed", source: { kind: "product_page", ref: "https://example.test/HJ006" } },
    ] };
    const original = structuredClone(stored);
    const profile = createTideweOutdoorProfile();
    const saved = vi.fn();
    expect(tideweProductInputFromFacts(stored).category).toBe(shop);
    expect(buildTideweProductFacts({ ...tideweProductInputFromFacts(stored), category: legacy }, stored).category).toBe(shop);
    const changed = vi.fn();
    await act(async () => root.render(createElement(TideweProductFields, { value: { ...tideweProductInputFromFacts(stored), category: legacy }, onChange: changed })));
    expect(container.querySelector<HTMLSelectElement>("#tidewe-category")?.value).toBe(shop);
    await changeText("#tidewe-specifications", "Updated specification");
    expect(changed).toHaveBeenLastCalledWith({ category: shop, specifications: "Updated specification" });
    await act(async () => root.render(createElement(TideweProjectSettings, { projectId: "tidewe-project", revision: 4, facts: stored, profile, drafts: { tidewe_outdoor: profile }, disabled: false, onBusyChange: vi.fn(), onSaved: saved })));
    expect(container.querySelector<HTMLSelectElement>("#project-tidewe-category")?.value).toBe(shop);
    expect(container.querySelector("#project-tidewe-sku")).toBeNull();
    expect(container.querySelector("#project-tidewe-source")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    await changeSelect("#project-tidewe-category", next);
    await click("saveFacts");
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toMatchObject({ expectedCreativeConfigRevision: 4, productCategory: next, productFacts: { category: next, sku: stored.sku, items: stored.items } });
    expect(saved).toHaveBeenCalledTimes(1);
    expect(stored).toEqual(original);
  });
  it("requires nonblank selling points before saving settings for a historical project", async () => {
    const profile = createTideweOutdoorProfile();
    const saved = vi.fn();
    const busy = vi.fn();
    await act(async () => root.render(createElement(TideweProjectSettings, { projectId: "tidewe-project", revision: 4, facts, profile, drafts: { tidewe_outdoor: profile }, disabled: false, onBusyChange: busy, onSaved: saved })));
    expect(button("saveFacts").disabled).toBe(true);
    await changeText("#project-tidewe-specifications", " \n\t ");
    expect(button("saveFacts").disabled).toBe(true);
    await click("saveFacts");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(busy).not.toHaveBeenCalled();
    const sellingPoints = " \n  Battery sold separately  \n\t ";
    await changeText("#project-tidewe-specifications", sellingPoints);
    expect(button("saveFacts").disabled).toBe(false);
    await click("saveFacts");
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toMatchObject({ productFacts: { sku: facts.sku, items: [{ value: "Battery sold separately", status: "confirmed", source: { kind: "manual", ref: "user-entered", excerpt: "Battery sold separately" } }] } });
    expect(saved).toHaveBeenCalledTimes(1);
    await changeText("#project-tidewe-specifications", "");
    expect(button("saveFacts").disabled).toBe(true);
  });
});

describe("TIDEWE creation and script editing", () => {
  it("keeps TIDEWE video and speech choices independent", async () => {
    i18nOptions.showModeCopy = true;
    await act(async () => root.render(createElement(NewProjectPage)));
    expect(button("真人场景演示").className).toContain("bg-primary/10");
    const speechMode = container.querySelector<HTMLSelectElement>("#tidewe-speech-mode")!;
    expect(speechMode.value).toBe("on_camera");
    expect([...speechMode.options].map((option) => option.value)).toEqual(["on_camera", "voiceover"]);
    await changeSelect("#tidewe-speech-mode", "voiceover");
    expect(button("真人场景演示").className).toContain("bg-primary/10");
    await click("产品特写");
    expect(button("产品特写").className).toContain("bg-primary/10");
    expect(speechMode.value).toBe("voiceover");
    await click("真人场景演示");
    expect(speechMode.value).toBe("voiceover");
    expect(container.textContent).not.toContain("creationTypeSalesLabel");
    expect(container.textContent).not.toContain("modeMontageLabel");
    expect(container.textContent).not.toContain("modePresenterLabel");
  });
  it("offers TIDEWE durations and skips domestic sales choices", async () => {
    await act(async () => root.render(createElement(NewProjectPage)));
    expect(button("40s").className).toContain("bg-primary/10");
    expect(container.querySelector("#tidewe-category")).not.toBeNull();
    expect(container.textContent).toContain("language");
    for (const key of ["templatesSummary", "platformDouyin", "sourceIngestLead", "sourceExampleLead", "15s", "creationTypeSalesLabel"]) {
      expect(container.textContent).not.toContain(key);
    }
    for (const duration of ["30s", "60s", "40s"]) {
      await click(duration);
      expect(button(duration).className).toContain("bg-primary/10");
    }
    expect(fetchMock.mock.calls.some(([url]) => url.startsWith("/api/ad-template"))).toBe(false);
  });
  it.each(["", "tidewe_outdoor", "short_video_sales", "unknown", "premium_product_cg"])("opens only TIDEWE with 40 seconds for a %s shortcut", async (creationType) => {
    window.history.replaceState(null, "", `/project/new?creationType=${creationType}`);
    await act(async () => root.render(createElement(NewProjectPage)));
    expect(container.textContent).toContain("label");
    expect(container.textContent).not.toContain("creationTypeSalesLabel");
    expect(button("40s").className).toContain("bg-primary/10");
    expect(button("modeSceneLabel").className).toContain("bg-primary/10");
    expect(container.querySelector("#productName")).not.toBeNull();
    expect(container.querySelector("#tidewe-category")).not.toBeNull();
  });
  it("prefills TIDEWE name, selling points and images when the product library hydrates", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:library-product");
    window.history.replaceState(null, "", "/project/new?productId=library-product");
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/uploads/library-product.png") return new Response(new Blob(["product"], { type: "image/png" }));
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => root.render(createElement(NewProjectPage)));
    await act(async () => useProductLibraryStore.setState({ products: [{
      id: "library-product", name: "TIDEWE outdoor jacket", category: "fashion",
      description: "Compact pack size", images: ["/uploads/library-product.png"], videoCount: 0, createdAt: new Date(),
    }] }));
    expect(container.querySelector<HTMLInputElement>("#productName")?.value).toBe("TIDEWE outdoor jacket");
    expect(container.querySelector<HTMLTextAreaElement>("#tidewe-specifications")?.value).toBe("Compact pack size");
    expect(container.querySelector('img[src="blob:library-product"]')).not.toBeNull();
    expect(button("submit").disabled).toBe(false);
  });
  it("requires a nonblank selling point for TIDEWE AI creation", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:tidewe-fixture");
    await act(async () => root.render(createElement(NewProjectPage)));
    await changeInput("#productName", "TIDEWE outdoor jacket");
    const upload = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(upload, "files", { value: [new File(["product"], "product.png", { type: "image/png" })] });
    await act(async () => upload.dispatchEvent(new Event("change", { bubbles: true })));
    expect(button("submit").disabled).toBe(true);
    await changeText("#tidewe-specifications", " \n\t ");
    expect(button("submit").disabled).toBe(true);
    await click("submit");
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/project")).toBe(false);
    await changeText("#tidewe-specifications", " \n  Compact pack size  \n ");
    expect(button("submit").disabled).toBe(false);
    await changeText("#tidewe-specifications", "");
    expect(button("submit").disabled).toBe(true);
  });
  it.each([
    { selected: false, speechMode: "on_camera", videoMode: "scene_demo" },
    { selected: true, speechMode: "on_camera", videoMode: "product_closeup" },
    { selected: false, speechMode: "voiceover", videoMode: "product_closeup" },
    { selected: true, speechMode: "voiceover", videoMode: "scene_demo" },
  ] as const)("creates and generates $videoMode / $speechMode with frozen presenter=$selected and the latest image revision", async ({ selected, speechMode, videoMode }) => {
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
    await changeSelect("#tidewe-speech-mode", "voiceover");
    if (speechMode === "on_camera") await changeSelect("#tidewe-speech-mode", "on_camera");
    await click(videoMode === "product_closeup" ? "modeCloseupLabel" : "modeSceneLabel");
    expect(container.querySelector<HTMLSelectElement>("#tidewe-speech-mode")?.value).toBe(speechMode);
    if (selected) await changeSelect("#tidewe-presenter", hunter.id);
    await changeInput("#productName", "TIDEWE outdoor jacket");
    await changeText("#tidewe-specifications", "Three heat settings\nBattery sold separately");
    const upload = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(upload, "files", { value: [new File(["product"], "product.png", { type: "image/png" })] });
    await act(async () => upload.dispatchEvent(new Event("change", { bubbles: true })));
    await click("submit");
    const creation = JSON.parse(fetchMock.mock.calls.find(([url]) => url === "/api/project")![1].body);
    expect(creation).toMatchObject({ productFacts: { items: [{ value: "Three heat settings" }, { value: "Battery sold separately" }] }, videoMode, creativeProfile: { creationType: "tidewe_outdoor", targetDuration: 40, speechMode, videoMode, composeSnapshot: { ttsEnabled: speechMode === "voiceover", nativeAudio: speechMode === "on_camera" } } });
    expect(creation.creativeProfileDrafts).toEqual({ tidewe_outdoor: creation.creativeProfile });
    if (selected) expect(creation.creativeProfile.presenter).toEqual(snapshotTidewePresenter(hunter));
    else expect(creation.creativeProfile).not.toHaveProperty("presenter");
    const registered = JSON.parse(fetchMock.mock.calls.find(([url]) => url === "/api/generation-runs")![1].body);
    expect(registered).toMatchObject({ projectId: "new-tidewe", kind: "script", items: [{ kind: "script" }] });
    const generation = registered.items[0].request;
    expect(generation).toMatchObject({ expectedCreativeConfigRevision: 2, requestId: expect.any(String), platforms: "tiktok", styleType: "tidewe_outdoor", productImages: ["/uploads/product.png"], count: 1, videoMode });
    expect(generation.creativeProfile).toEqual(creation.creativeProfile);
    expect(generation.creativeProfileDrafts.tidewe_outdoor).toEqual(creation.creativeProfile);
    expect(generation).not.toHaveProperty("templateId");
    expect(generation).not.toHaveProperty("customRequirements");
    expect(generation.creativeProfile.presenter).toEqual(creation.creativeProfile.presenter);
  });
  it("supports appearance-only or image-only TIDEWE presenter identities", async () => {
    const appearanceOnly: Character = { id: "appearance-only", name: "Outdoor presenter", appearance: "An adult wearing a plain shirt", referenceImages: [] };
    const imageOnly: Character = { id: "portrait-only", name: "Portrait creator", referenceImages: [], sourceReferenceImages: ["/api/files/portrait.png"] };
    const incomplete: Character = { id: "empty", name: "Incomplete", referenceImages: [] };
    useCharacterStore.setState({ characters: [hunter, appearanceOnly, imageOnly, incomplete] });
    await act(async () => root.render(createElement(NewProjectPage)));
    await changeSelect("#tidewe-presenter", hunter.id);
    expect(container.textContent).toContain(hunter.appearance);
    expect((container.querySelector('#tidewe-presenter option[value="empty"]') as HTMLOptionElement).disabled).toBe(true);
    await changeSelect("#tidewe-presenter", imageOnly.id);
    expect(container.querySelector('img[src="/api/files/portrait.png"]')).not.toBeNull();
    expect(container.textContent).toContain("presenterImageOnly");
    await changeSelect("#tidewe-presenter", appearanceOnly.id);
    expect(container.textContent).toContain(appearanceOnly.appearance);
    await changeSelect("#tidewe-presenter", hunter.id);
    await click("modeCloseupLabel");
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
    await changeText("#project-tidewe-specifications", "Battery sold separately");
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
    await changeText("#project-tidewe-specifications", "Battery sold separately");
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
