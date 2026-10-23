import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NewProjectPage from "@/app/project/new/page";
import { useSettingsStore } from "@/lib/stores/settings-store";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
const empty = vi.hoisted(() => ({ products: [], characters: [], templates: [] }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: navigation.push }) }));
vi.mock("@/lib/i18n", () => { const t = (key: string) => key; return { useT: () => t, useLocale: () => "zh" }; });
vi.mock("@/lib/stores/product-library-store", () => ({ useProductLibraryStore: () => ({ products: empty.products }) }));
vi.mock("@/lib/stores/project-store", () => ({ useCharacterStore: () => ({ characters: empty.characters }) }));
vi.mock("@/lib/stores/template-store", () => ({ useTemplateStore: () => ({ templates: empty.templates, incrementUseCount: vi.fn() }) }));

const initialSettings = useSettingsStore.getInitialState();
const fetchMock = vi.fn();
let root: Root;
let container: HTMLDivElement;

function button(key: string) {
  return [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(key))!;
}
function source(value: "product_image" | "ai_generate") {
  return container.querySelector(`input[name="visualSource"][value="${value}"]`) as HTMLInputElement;
}
function body(url: string) {
  const call = fetchMock.mock.calls.find(([path, init]) => path === url && init?.method === "POST");
  return JSON.parse(call![1].body as string);
}
async function mount(type: "short_video_sales" | "premium_product_cg") {
  await act(async () => root.render(<NewProjectPage />));
  await act(async () => button(type === "premium_product_cg" ? "creationTypeCgLabel" : "creationTypeSalesLabel").click());
}
async function fillProduct() {
  const name = container.querySelector("#productName") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Test chair");
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const files = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(files, "files", { configurable: true, value: [new File(["chair"], "chair.png", { type: "image/png" })] });
  await act(async () => files.dispatchEvent(new Event("change", { bubbles: true })));
}
async function submit(type: "short_video_sales" | "premium_product_cg") {
  await act(async () => button(type === "premium_product_cg" ? "submitGenerateCg" : "submitGenerate").click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  const NativeURL = URL;
  vi.stubGlobal("URL", class extends NativeURL {
    static createObjectURL = vi.fn(() => "blob:product-preview");
    static revokeObjectURL = vi.fn();
  });
  useSettingsStore.setState({ ...initialSettings, llm: { provider: "fixture", baseUrl: "https://example.test", apiKey: "fixture-key", model: "fixture-model" } });
  navigation.push.mockReset();
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/ad-template/mine") return Response.json({ templates: [] });
    if (url === "/api/project" && init?.method === "POST") return Response.json({ id: "project-1" });
    if (url === "/api/upload") return Response.json({ paths: ["/api/files/chair.png"] });
    if (url === "/api/project/project-1" && init?.method === "PATCH") return Response.json({ success: true });
    if (url === "/api/llm/script") return Response.json({ success: true });
    throw new Error("Unexpected request: " + url);
  });
  window.history.replaceState(null, "", "/project/new");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useSettingsStore.setState(initialSettings);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("new project visual source", () => {
  it.each([
    ["short_video_sales", "product_image"],
    ["premium_product_cg", "product_image"],
    ["short_video_sales", "ai_generate"],
    ["premium_product_cg", "ai_generate"],
  ] as const)("sends the selected %s source %s to project creation and script generation", async (type, visualSource) => {
    await mount(type);
    expect(source("product_image").checked).toBe(true);
    expect(source("ai_generate").checked).toBe(false);
    if (visualSource === "ai_generate") await act(async () => source("ai_generate").click());
    await fillProduct();
    vi.useFakeTimers();
    await submit(type);
    for (const url of ["/api/project", "/api/llm/script"]) {
      const payload = body(url);
      expect(payload.creativeProfile.visualSource).toBe(visualSource);
      expect(payload.creativeProfileDrafts[type].visualSource).toBe(visualSource);
    }
    expect(body("/api/llm/script").productImages).toEqual(["/api/files/chair.png"]);
    await act(async () => vi.advanceTimersByTimeAsync(800));
    expect(navigation.push).toHaveBeenCalledExactlyOnceWith("/project/project-1/script");
  });

  it("keeps each creation type's source choice when switching types", async () => {
    await mount("short_video_sales");
    await act(async () => source("ai_generate").click());
    await act(async () => button("creationTypeCgLabel").click());
    expect(source("product_image").checked).toBe(true);
    await act(async () => button("creationTypeSalesLabel").click());
    expect(source("ai_generate").checked).toBe(true);
    await act(async () => button("creationTypeCgLabel").click());
    expect(source("product_image").checked).toBe(true);
    await fillProduct();
    vi.useFakeTimers();
    await submit("premium_product_cg");
    const payload = body("/api/llm/script");
    expect(payload.creativeProfileDrafts.short_video_sales.visualSource).toBe("ai_generate");
    expect(payload.creativeProfileDrafts.premium_product_cg.visualSource).toBe("product_image");
    await act(async () => vi.advanceTimersByTimeAsync(800));
  });

  it("prevents changing source while generating and enables it after failure", async () => {
    let finish!: (response: Response) => void;
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === "/api/llm/script"
      ? new Promise<Response>((resolve) => { finish = resolve; })
      : normalFetch(url, init));
    await mount("premium_product_cg");
    await fillProduct();
    await submit("premium_product_cg");
    expect(source("product_image").matches(":disabled")).toBe(true);
    expect(source("ai_generate").matches(":disabled")).toBe(true);
    await act(async () => source("ai_generate").click());
    expect(source("product_image").checked).toBe(true);
    await act(async () => finish(Response.json({ error: "failed" }, { status: 500 })));
    expect(source("ai_generate").matches(":disabled")).toBe(false);
    expect(container.textContent).toContain("errorScriptFailed");
  });

  it("stops before script generation when saving uploaded reference images fails", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === "/api/project/project-1"
      ? Promise.resolve(Response.json({ error: "not saved" }, { status: 500 }))
      : normalFetch(url, init));
    await mount("premium_product_cg");
    await fillProduct();
    await submit("premium_product_cg");
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/llm/script")).toBe(false);
    expect(container.textContent).toContain("errorUploadFailed");
    expect(source("ai_generate").matches(":disabled")).toBe(false);
    expect(navigation.push).not.toHaveBeenCalled();
  });
});
