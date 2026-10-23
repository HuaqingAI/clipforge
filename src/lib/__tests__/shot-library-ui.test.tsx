import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShotLibrary } from "@/app/projects/_components/shot-library";
import type { LocalShotVideo } from "@/lib/shot-library-types";

vi.mock("@/lib/i18n", () => {
  const translate = (key: string, values?: Record<string, string | number>) => `${key}${values ? ` ${Object.values(values).join(" ")}` : ""}`;
  return { useT: () => translate, useLocale: () => "zh" };
});

const fetchMock = vi.fn();
const countChanged = vi.fn();
let root: Root;
let container: HTMLDivElement;
let confirmMock: ReturnType<typeof vi.spyOn>;
let rows: LocalShotVideo[];
let load: () => Promise<Response>;
let remove: (id: string) => Promise<Response>;

function shot(id: string, overrides: Partial<LocalShotVideo> = {}): LocalShotVideo {
  return {
    id, projectId: "project-1", projectName: "Blender project", productName: "Portable blender",
    scriptId: "script-a", scriptTitle: "Kitchen demo", scriptVersion: 1, scriptStyle: "demo",
    shotId: 1, shotDescription: "Fruit close-up", url: `/api/files/project-1/${id}.mp4`,
    thumbnailUrl: `/api/files/project-1/${id}.mp4.thumb.jpg`, duration: 5000,
    createdAt: "2026-10-21T10:00:00Z", sizeBytes: 2 * 1024 * 1024, selected: false,
    provider: "kling", model: "kling3.0", fileName: `${id}.mp4`, ...overrides,
  };
}

function card(id: string) { return container.querySelector<HTMLElement>(`[data-shot-id="${id}"]`); }
function button(key: string, within: ParentNode = container) {
  const found = [...within.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    item.textContent?.includes(key) || item.title.startsWith(key) || item.getAttribute("aria-label")?.startsWith(key));
  expect(found, `Expected button ${key}`).toBeTruthy();
  return found!;
}
function deleteCalls() { return fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE"); }
function loadCalls() { return fetchMock.mock.calls.filter(([url, init]) => url === "/api/shots" && !init?.method); }
async function mount(active = true, excludedProjectIds?: string[]) {
  await act(async () => root.render(<ShotLibrary active={active} onCountChange={countChanged} excludedProjectIds={excludedProjectIds} />));
}
async function click(target: HTMLElement) { await act(async () => target.click()); }
async function selectCard(id: string) { await click(card(id)!.querySelector<HTMLInputElement>('input[type="checkbox"]')!); }
async function changeSelect(target: HTMLSelectElement, value: string) {
  await act(async () => { target.value = value; target.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function search(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="shotsSearchPlaceholder"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  confirmMock = vi.spyOn(window, "confirm").mockReturnValue(true);
  countChanged.mockReset();
  rows = [
    shot("take-a", { selected: true, createdAt: "2026-10-20T10:00:00Z" }),
    shot("take-b"),
    shot("take-c", { scriptId: "script-b", scriptTitle: "Outdoor demo", scriptVersion: 2, shotDescription: "Outdoor blend" }),
    shot("take-d", { projectId: "project-2", projectName: "Coffee project", productName: "Coffee maker", scriptId: null, scriptTitle: null, scriptVersion: null, shotId: 2, shotDescription: "Coffee pouring" }),
  ];
  load = async () => Response.json({ shots: rows });
  remove = async (id) => Response.json({ success: true, deletedId: id, deletedFiles: 2, freedBytes: 100 });
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/shots" && !init?.method) return load();
    if (url.startsWith("/api/shots/") && init?.method === "DELETE") return remove(decodeURIComponent(url.slice("/api/shots/".length)));
    throw new Error(`Unexpected request ${url}`);
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("local shot library", () => {
  it("waits until activated to fetch and groups takes by their project and original script", async () => {
    await mount(false);
    expect(fetchMock).not.toHaveBeenCalled();
    await mount();
    expect(loadCalls()).toHaveLength(1);
    expect(countChanged).toHaveBeenLastCalledWith(4);
    const blender = container.querySelector('[data-project-id="project-1"]')!;
    const kitchen = blender.querySelector('[data-script-id="script-a"]')!;
    const outdoor = blender.querySelector('[data-script-id="script-b"]')!;
    expect(kitchen.textContent).toContain("Kitchen demo");
    expect(kitchen.querySelectorAll("[data-shot-id]")).toHaveLength(2);
    expect(kitchen.contains(card("take-a"))).toBe(true);
    expect(kitchen.contains(card("take-b"))).toBe(true);
    expect(outdoor.textContent).toContain("Outdoor demo");
    expect(outdoor.querySelectorAll("[data-shot-id]")).toHaveLength(1);
    expect(outdoor.contains(card("take-c"))).toBe(true);
    expect(card("take-a")!.textContent).toContain("shotsSelectedTake");
    expect(container.querySelector('[data-project-id="project-2"] [data-script-id="unassigned"]')?.textContent).toContain("shotsUnassignedScript");
  });

  it("filters by project and script and removes deleted projects from the library", async () => {
    await mount();
    const selects = [...container.querySelectorAll("select")];
    const projectSelect = selects.find((item) => item.querySelector('option[value="project-1"]'))!;
    await changeSelect(projectSelect, "project-1");
    expect(card("take-d")).toBeNull();
    const scriptSelect = [...container.querySelectorAll("select")].find((item) => item.querySelector('option[value="script-b"]'))!;
    await changeSelect(scriptSelect, "script-b");
    expect(card("take-a")).toBeNull();
    expect(card("take-c")).toBeTruthy();
    await mount(true, ["project-1"]);
    expect(card("take-c")).toBeNull();
    expect(card("take-d")).toBeTruthy();
    expect(countChanged).toHaveBeenLastCalledWith(1);
  });

  it("finds takes by script, shot description and file name and clears selection when searching", async () => {
    await mount();
    await selectCard("take-a");
    await search("OUTDOOR DEMO");
    expect(container.querySelectorAll("[data-shot-id]")).toHaveLength(1);
    expect(card("take-c")).toBeTruthy();
    expect(button("shotsDeleteSelected").disabled).toBe(true);
    await search("Coffee pouring");
    expect(container.querySelectorAll("[data-shot-id]")).toHaveLength(1);
    expect(card("take-d")).toBeTruthy();
    await search("take-b.mp4");
    expect(container.querySelectorAll("[data-shot-id]")).toHaveLength(1);
    expect(card("take-b")).toBeTruthy();
    await search("No such take");
    expect(container.querySelectorAll("[data-shot-id]")).toHaveLength(0);
    expect(container.textContent).toContain("shotsNoMatch");
    await search("");
    expect(container.querySelectorAll("[data-shot-id]")).toHaveLength(4);
  });

  it("previews the original video with controls and exposes a download for every take", async () => {
    await mount();
    const take = card("take-b")!;
    expect(take.querySelector('a[href="/api/files/project-1/take-b.mp4?download=1"]')).toBeTruthy();
    await click(button("shotsPreview", take));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog).toBeTruthy();
    expect(dialog.querySelector("video")?.getAttribute("src")).toBe("/api/files/project-1/take-b.mp4");
    expect(dialog.querySelector("video")?.controls).toBe(true);
  });

  it("cancels individual and batch deletion without removing files or rows", async () => {
    confirmMock.mockReturnValue(false);
    await mount();
    await click(button("shotsDelete", card("take-a")!));
    expect(confirmMock.mock.calls[0][0]).toContain("shotsDeleteConfirm");
    await selectCard("take-a");
    await selectCard("take-b");
    await click(button("shotsDeleteSelected"));
    expect(confirmMock.mock.calls[1][0]).toContain("shotsDeleteBatchConfirm");
    expect(deleteCalls()).toHaveLength(0);
    expect(container.querySelectorAll("[data-shot-id]")).toHaveLength(4);
    expect(card("take-a")!.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
  });

  it("blocks duplicate deletion and updates only the successfully deleted take and count", async () => {
    let finish!: (response: Response) => void;
    remove = () => new Promise<Response>((resolve) => { finish = resolve; });
    await mount();
    const trigger = button("shotsDelete", card("take-a")!);
    await act(async () => { trigger.click(); trigger.click(); });
    expect(deleteCalls()).toHaveLength(1);
    expect(confirmMock).toHaveBeenCalledOnce();
    expect(button("shotsDelete", card("take-a")!).disabled).toBe(true);
    expect(card("take-a")).toBeTruthy();
    await act(async () => finish(Response.json({ success: true, deletedId: "take-a" })));
    expect(card("take-a")).toBeNull();
    expect(card("take-b")).toBeTruthy();
    expect(countChanged).toHaveBeenLastCalledWith(3);
    await click(button("shotsRefresh"));
    expect(card("take-a")).toBeNull();
    expect(countChanged).toHaveBeenLastCalledWith(3);
  });

  it("confirms a batch once, deletes sequentially and retains failed rows with their error", async () => {
    let finishFirst!: (response: Response) => void;
    remove = (id) => id === "take-a"
      ? new Promise<Response>((resolve) => { finishFirst = resolve; })
      : Promise.resolve(Response.json({ error: "This take is still in use" }, { status: 409 }));
    await mount();
    await selectCard("take-a");
    await selectCard("take-b");
    const trigger = button("shotsDeleteSelected");
    await act(async () => { trigger.click(); trigger.click(); });
    expect(confirmMock).toHaveBeenCalledOnce();
    expect(deleteCalls().map(([url]) => url)).toEqual(["/api/shots/take-a"]);
    await act(async () => finishFirst(Response.json({ success: true, deletedId: "take-a" })));
    expect(deleteCalls().map(([url]) => url)).toEqual(["/api/shots/take-a", "/api/shots/take-b"]);
    expect(card("take-a")).toBeNull();
    expect(card("take-b")!.querySelector('[role="alert"]')?.textContent).toContain("This take is still in use");
    expect(card("take-c")!.querySelector('[role="alert"]')).toBeNull();
    expect(countChanged).toHaveBeenLastCalledWith(3);
    expect(button("shotsDelete", card("take-b")!).disabled).toBe(false);
  });

  it("retains a take with a translated inline error after a network deletion failure", async () => {
    remove = async () => { throw new TypeError("Offline"); };
    await mount();
    await click(button("shotsDelete", card("take-b")!));
    expect(card("take-b")!.querySelector('[role="alert"]')?.textContent).toContain("shotsDeleteFailed");
    expect(countChanged).toHaveBeenLastCalledWith(4);
    expect(button("shotsDelete", card("take-b")!).disabled).toBe(false);
  });

  it.each(["non-json", "network"])("shows a %s load failure and lets refresh retry the request", async (kind) => {
    load = async () => {
      if (kind === "network") throw new TypeError("Offline");
      return new Response("unavailable", { status: 503 });
    };
    await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("shotsLoadError");
    expect(card("take-a")).toBeNull();
    load = async () => Response.json({ shots: rows });
    await click(button("shotsRefresh"));
    expect(loadCalls()).toHaveLength(2);
    expect(card("take-a")).toBeTruthy();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(countChanged).toHaveBeenLastCalledWith(4);
  });
});
