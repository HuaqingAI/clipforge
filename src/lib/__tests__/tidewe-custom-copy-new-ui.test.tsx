import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NewProjectPage from "@/app/project/new/page";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { useCharacterStore, type Character } from "@/lib/stores/project-store";
import { snapshotTidewePresenter } from "@/lib/tidewe/presenter";
import { tideweCopyInputError, TIDEWE_COPY_INPUT_MAX_LENGTH } from "@/lib/tidewe/copy-input";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("@/lib/i18n", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "zh",
}));

const fetchMock = vi.fn();
const settingsInitial = useSettingsStore.getInitialState();
const charactersInitial = useCharacterStore.getInitialState();
const presenter: Character = {
  id: "tidewe-host", name: "TIDEWE host", appearance: "An adult woman wearing a green cap",
  referenceImages: ["/api/files/tidewe-host.png"],
};
const original = "  Cold mornings? I still want to head outside.\n\nHere is how I use this gear.\nTake a closer look.  ";
let container: HTMLDivElement;
let root: Root;

function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll("button")].find((node) => node.textContent === label || node.textContent?.startsWith(label));
  expect(result, `button ${label}`).toBeDefined();
  return result!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function input(selector: string, value: string) {
  const element = container.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
  expect(element, selector).not.toBeNull();
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function source(value: "manual" | "ai") {
  const element = container.querySelector(`input[type="radio"][name="tidewe-copy-input-source"][value="${value}"]`) as HTMLInputElement;
  expect(element).not.toBeNull();
  await act(async () => element.click());
}
async function product() {
  await input("#productName", "TIDEWE outdoor gear");
  const upload = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(upload, "files", { value: [new File(["product"], "product.png", { type: "image/png" })] });
  await act(async () => upload.dispatchEvent(new Event("change", { bubbles: true })));
}
function generationBodies() {
  return fetchMock.mock.calls.filter(([url]) => url === "/api/generation-runs").map(([, init]) => JSON.parse(init.body).items[0].request);
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:tidewe-custom-copy-product");
  useSettingsStore.setState({ ...settingsInitial, uiMode: "pro", llm: { provider: "fixture", baseUrl: "https://example.test", apiKey: "fixture-key", model: "fixture" } });
  useCharacterStore.setState({ ...charactersInitial, characters: [presenter] });
  fetchMock.mockReset().mockImplementation(async (url: string) => {
    if (url === "/api/ad-template/mine") return Response.json({ templates: [] });
    if (url === "/api/project") return Response.json({ id: "new-tidewe", creativeConfigRevision: 7 });
    if (url === "/api/upload") return Response.json({ paths: ["/uploads/product.png"] });
    if (url === "/api/project/new-tidewe") return Response.json({ id: "new-tidewe", creativeConfigRevision: 9 });
    // A rejected registration keeps the original draft available for retry.
    if (url === "/api/generation-runs") return Response.json({ error: "Task registration is unavailable; try again." }, { status: 503 });
    throw new Error(`Unexpected request: ${url}`);
  });
  window.history.replaceState(null, "", "/project/new?creationType=tidewe_outdoor");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useSettingsStore.setState(settingsInitial);
  useCharacterStore.setState(charactersInitial);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TIDEWE custom copy before project creation", () => {
  it("defaults to AI copy without sending a user original", async () => {
    await act(async () => root.render(createElement(NewProjectPage)));
    expect((container.querySelector('input[type="radio"][value="ai"]') as HTMLInputElement).checked).toBe(true);
    expect(container.querySelector("#tidewe-copy-input")).toBeNull();
    await product();
    await click("submit");
    expect(generationBodies()).toHaveLength(1);
    expect(generationBodies()[0]).not.toHaveProperty("copyText");
    expect(generationBodies()[0]).not.toHaveProperty("count");
  });

  it.each([false, true])("sends the exact multiline original as one plan with the latest revision and optional frozen presenter, selected=%s", async (selected) => {
    await act(async () => root.render(createElement(NewProjectPage)));
    await source("manual");
    await input("#tidewe-copy-input", original);
    if (selected) {
      const picker = container.querySelector("#tidewe-presenter") as HTMLSelectElement;
      await act(async () => { picker.value = presenter.id; picker.dispatchEvent(new Event("change", { bubbles: true })); });
    }
    await product();
    await click("copyInputGenerate");
    const creation = JSON.parse(fetchMock.mock.calls.find(([url]) => url === "/api/project")![1].body);
    const patch = JSON.parse(fetchMock.mock.calls.find(([url]) => url === "/api/project/new-tidewe")![1].body);
    expect(patch).toMatchObject({ expectedCreativeConfigRevision: 7, productImages: ["/uploads/product.png"] });
    expect(generationBodies()).toHaveLength(1);
    expect(generationBodies()[0]).toMatchObject({
      copyText: original, count: 1, expectedCreativeConfigRevision: 9, requestId: expect.any(String),
      platforms: "tiktok", styleType: "tidewe_outdoor", productImages: ["/uploads/product.png"],
      creativeProfile: { creationType: "tidewe_outdoor", speechMode: "on_camera" },
    });
    if (selected) {
      expect(creation.creativeProfile.presenter).toEqual(snapshotTidewePresenter(presenter));
      expect(generationBodies()[0].creativeProfile.presenter).toEqual(creation.creativeProfile.presenter);
    } else {
      expect(creation.creativeProfile).not.toHaveProperty("presenter");
      expect(generationBodies()[0].creativeProfile).not.toHaveProperty("presenter");
    }
  });

  it.each([
    { name: "empty", text: "", error: "copyInputRequired" },
    { name: "whitespace", text: " \n ", error: "copyInputRequired" },
    { name: "Chinese", text: "公司完整脚本", error: "copyInputEnglish" },
    { name: "mixed Chinese and English", text: "Use this 装备 outdoors.", error: "copyInputEnglish" },
    { name: "over the limit", text: "A".repeat(TIDEWE_COPY_INPUT_MAX_LENGTH + 1), error: "copyInputTooLong" },
  ])("blocks an original that is $name before creating a project", async ({ text, error }) => {
    await act(async () => root.render(createElement(NewProjectPage)));
    await product();
    await source("manual");
    await input("#tidewe-copy-input", text);
    expect(button("copyInputGenerate").disabled).toBe(true);
    expect(container.textContent).toContain(error);
    expect((container.querySelector("#tidewe-copy-input") as HTMLTextAreaElement).value).toBe(text);
    await click("copyInputGenerate");
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/project")).toBe(false);
    expect(generationBodies()).toEqual([]);
  });

  it("keeps the manual draft across source and style switches without sending it for AI, sales or CG", async () => {
    await act(async () => root.render(createElement(NewProjectPage)));
    await product();
    await source("manual");
    await input("#tidewe-copy-input", original);
    await source("ai");
    await click("submit");
    await source("manual");
    expect((container.querySelector("#tidewe-copy-input") as HTMLTextAreaElement).value).toBe(original);
    await click("creationTypeSalesLabel");
    expect(container.querySelector("#tidewe-copy-input")).toBeNull();
    await click("submitGenerate");
    await click("creationTypeCgLabel");
    expect(container.querySelector("#tidewe-copy-input")).toBeNull();
    await click("submitGenerateCg");
    expect(generationBodies()).toHaveLength(3);
    for (const body of generationBodies()) {
      expect(body).not.toHaveProperty("copyText");
      expect(body).not.toHaveProperty("count");
    }
    await click("label");
    expect((container.querySelector('input[type="radio"][value="manual"]') as HTMLInputElement).checked).toBe(true);
    expect((container.querySelector("#tidewe-copy-input") as HTMLTextAreaElement).value).toBe(original);
  });

  it("retains the original and allows retry when background registration fails", async () => {
    await act(async () => root.render(createElement(NewProjectPage)));
    await source("manual");
    await input("#tidewe-copy-input", original);
    await product();
    await click("copyInputGenerate");
    expect(container.textContent).toContain("Task registration is unavailable; try again.");
    expect((container.querySelector("#tidewe-copy-input") as HTMLTextAreaElement).value).toBe(original);
    expect(button("copyInputGenerate").disabled).toBe(false);
    await click("copyInputGenerate");
    expect(generationBodies().map((body) => body.copyText)).toEqual([original, original]);
  });

  it("disables original editing and source changes while background registration is pending", async () => {
    let finish!: (response: Response) => void;
    const fallback = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === "/api/generation-runs"
      ? new Promise<Response>((resolve) => { finish = resolve; })
      : fallback(url, init));
    await act(async () => root.render(createElement(NewProjectPage)));
    await product();
    await source("manual");
    await input("#tidewe-copy-input", original);
    await click("copyInputGenerate");
    const textarea = container.querySelector("#tidewe-copy-input") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    for (const radio of container.querySelectorAll('input[name="tidewe-copy-input-source"]')) expect(radio.matches(":disabled")).toBe(true);
    await source("ai");
    expect(textarea.value).toBe(original);
    expect((container.querySelector('input[value="manual"]') as HTMLInputElement).checked).toBe(true);
    await act(async () => finish(Response.json({ error: "Retry background registration." }, { status: 503 })));
    expect(textarea.disabled).toBe(false);
  });
});

describe("TIDEWE custom-copy input boundaries", () => {
  it("accepts the complete maximum-length original and rejects excess without trimming or truncating", () => {
    const maximum = `  ${"A".repeat(TIDEWE_COPY_INPUT_MAX_LENGTH - 4)}  `;
    expect(maximum.length).toBe(TIDEWE_COPY_INPUT_MAX_LENGTH);
    expect(tideweCopyInputError(maximum)).toBeUndefined();
    expect(tideweCopyInputError(`${maximum} `)).toBe("copyInputTooLong");
    expect(tideweCopyInputError("\n\t")).toBe("copyInputRequired");
    expect(tideweCopyInputError("1, 2, 3.")).toBe("copyInputEnglish");
  });

  it("does not use an HTML maxlength that would silently truncate a pasted original", async () => {
    await act(async () => root.render(createElement(NewProjectPage)));
    await source("manual");
    const textarea = container.querySelector("#tidewe-copy-input") as HTMLTextAreaElement;
    expect(textarea.hasAttribute("maxlength")).toBe(false);
    const oversized = "English copy. ".repeat(Math.ceil(TIDEWE_COPY_INPUT_MAX_LENGTH / 14));
    await input("#tidewe-copy-input", oversized);
    expect(textarea.value).toBe(oversized);
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
  });
});
