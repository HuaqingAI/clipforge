import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScriptHistoryDialog } from "@/components/script-history-dialog";

vi.mock("@/lib/i18n", () => {
  const t = (key: string, values?: Record<string, string | number>) => values?.n != null ? `${key}:${values.n}` : values?.date != null ? `${key}:${values.date}` : key;
  return { useT: () => t, useLocale: () => "zh" };
});

const fetchMock = vi.fn();
const onClose = vi.fn();
const onRestore = vi.fn();
let root: Root | undefined;
let container: HTMLDivElement;

function script(id: string, version: number, selected = false) {
  return {
    id, version, selected, title: `Option ${id}`, styleType: "scene", totalDuration: 8,
    createdAt: `2026-10-${20 + version}T08:30:00.000Z`,
    shots: [{ shotId: 1, type: "demo", duration: 8, description: `Picture ${id}`,
      camera: `Camera ${id}`, voiceover: `Voice ${id}`,
      visualSource: "ai_generate", transition: "direct_concat" }],
  };
}

const rows = [script("oldest", 1), script("history-a", 2), script("current", 3, true), script("history-b", 2)];

function button(label: string): HTMLButtonElement {
  const result = [...document.body.querySelectorAll("button")].find((node) => node.textContent === label || node.getAttribute("aria-label") === label);
  expect(result, `button ${label}`).toBeDefined();
  return result!;
}

async function click(label: string) {
  await act(async () => button(label).click());
}

async function mount(overrides: Partial<Parameters<typeof ScriptHistoryDialog>[0]> = {}) {
  await act(async () => root!.render(createElement(ScriptHistoryDialog, {
    projectId: "project-1", busy: false, onClose, onRestore, ...overrides,
  })));
}

function preview() { return document.body.querySelector('[aria-label="historyView"]')!; }

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockResolvedValue(Response.json(rows));
  onClose.mockReset();
  onRestore.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("script history viewer", () => {
  it("groups all saved options by newest version, labels the current batch and previews without mutations", async () => {
    await mount();
    expect(fetchMock).toHaveBeenCalledWith("/api/project/project-1/scripts", expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
    const groups = [...document.body.querySelectorAll("[data-history-version]")];
    expect(groups.map((group) => group.getAttribute("data-history-version"))).toEqual(["3", "2", "1"]);
    expect(groups[0].textContent).toContain("historyCurrentBatch");
    expect(groups[1].textContent).toContain("historyOptionCount:2");
    expect(groups[1].textContent).toContain("2026");
    expect(preview().textContent).toContain("Picture current");
    expect(preview().textContent).not.toContain("historyRestore");

    await click("Option history-b");
    expect(preview().textContent).toContain("Picture history-b");
    expect(preview().textContent).toContain("Camera history-b");
    expect(preview().textContent).toContain("Voice history-b");
    expect(preview().textContent).toContain("historyDuration:8");
    expect(document.body.querySelector("textarea,input")).toBeNull();
    expect(onRestore).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[role="dialog"]')?.getAttribute("aria-modal")).toBe("true");
  });

  it("requires confirmation and allows cancellation before restoring an exact historical option", async () => {
    await mount();
    await click("Option history-b");
    await click("historyRestore");
    expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain("historyRestoreConfirmDesc");
    expect(onRestore).not.toHaveBeenCalled();
    await click("historyCancel");
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    await click("historyRestore");
    await click("historyRestoreConfirmOk");
    expect(onRestore).toHaveBeenCalledExactlyOnceWith("history-b");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("prevents duplicate submissions and closing while a restoration is pending", async () => {
    let finish!: () => void;
    onRestore.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    await mount();
    await click("Option history-a");
    await click("historyRestore");
    await click("historyRestoreConfirmOk");
    expect(button("historyRestoring").disabled).toBe(true);
    expect(button("historyClose").disabled).toBe(true);
    expect(button("historyCancel").disabled).toBe(true);
    await click("historyRestoring");
    await click("historyClose");
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish());
  });

  it("shows restoration errors and allows the same confirmation to be retried", async () => {
    onRestore.mockRejectedValueOnce(new Error("A generation is still running"));
    await mount();
    await click("Option history-a");
    await click("historyRestore");
    await click("historyRestoreConfirmOk");
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("A generation is still running");
    expect(button("historyClose").disabled).toBe(false);
    await click("historyRestoreConfirmOk");
    expect(onRestore).toHaveBeenCalledTimes(2);
  });

  it("offers restoration when there is no selected script and falls back for missing dates", async () => {
    fetchMock.mockResolvedValue(Response.json([{ ...script("archived", 4), createdAt: null }]));
    await mount();
    expect(document.body.textContent).not.toContain("historyCurrentBatch");
    expect(document.body.textContent).toContain("historyUnknownDate");
    await click("historyRestore");
    await click("historyRestoreConfirmOk");
    expect(onRestore).toHaveBeenCalledExactlyOnceWith("archived");
  });

  it("handles empty history and allows closing", async () => {
    fetchMock.mockResolvedValue(Response.json([]));
    await mount();
    expect(document.body.textContent).toContain("historyEmpty");
    await click("historyClose");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows failed loads and retries with a fresh request", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "failure" }, { status: 500 }))
      .mockResolvedValueOnce(Response.json(rows));
    await mount();
    expect(document.body.textContent).toContain("historyLoadFailed");
    await click("historyRetry");
    expect(document.body.textContent).not.toContain("historyLoadFailed");
    expect(preview().textContent).toContain("Picture current");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows an error for an invalid response instead of attempting to render malformed shots", async () => {
    fetchMock.mockResolvedValue(Response.json([{ ...script("bad", 1), shots: [null] }]));
    await mount();
    expect(document.body.textContent).toContain("historyLoadFailed");
  });

  it("times out a stalled response even if the transport ignores cancellation", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    await mount();
    expect(document.body.textContent).toContain("historyLoading");
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(document.body.textContent).toContain("historyLoadFailed");
    expect(document.body.textContent).not.toContain("historyLoading");
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
  });

  it("cancels the previous project's request and ignores its late response", async () => {
    let resolveFirst!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(Response.json([script("other-project", 1)]));
    await mount();
    const firstSignal = (fetchMock.mock.calls[0][1] as RequestInit).signal!;
    await mount({ projectId: "project-2" });
    expect(firstSignal.aborted).toBe(true);
    expect(preview().textContent).toContain("Picture other-project");
    await act(async () => resolveFirst(Response.json(rows)));
    expect(preview().textContent).toContain("Picture other-project");
    expect(document.body.textContent).not.toContain("Option current");
  });

  it("aborts pending history reads when the dialog is unmounted", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    await mount();
    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal!;
    await act(async () => root!.unmount());
    root = undefined;
    expect(signal.aborted).toBe(true);
  });

  it("disables restoration and closing while a parent script action is busy", async () => {
    await mount();
    await click("Option history-a");
    await mount({ busy: true });
    expect(button("historyRestore").disabled).toBe(true);
    expect(button("historyClose").disabled).toBe(true);
    await click("historyRestore");
    await click("historyClose");
    expect(onRestore).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
