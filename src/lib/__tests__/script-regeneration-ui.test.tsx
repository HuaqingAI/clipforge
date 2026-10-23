import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ScriptPage from "@/app/project/[id]/script/page";
import { useSettingsStore } from "@/lib/stores/settings-store";

const navigation = vi.hoisted(() => ({ projectId: "project-1" }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: navigation.projectId }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/components/project-header", () => ({ ProjectHeader: () => null }));
vi.mock("@/lib/i18n", () => {
  const t = (key: string) => key;
  return { useT: () => t, useLocale: () => "zh" };
});

const scriptsUrl = "/api/project/project-1/scripts";
const projectUrl = "/api/project/project-1";
const generationUrl = "/api/llm/script";
const settingsInitial = useSettingsStore.getInitialState();
const fetchMock = vi.fn();
let root: Root | undefined;
let container: HTMLDivElement;

function script(id: string, title: string, selected = true) {
  return {
    id,
    title,
    styleType: "scene",
    totalDuration: 5,
    selected,
    shots: [{
      shotId: 1,
      type: "demo",
      duration: 5,
      description: `${title} product`,
      voiceover: `${title} details`,
      visualSource: "ai_generate",
      transition: "direct_concat",
    }],
  };
}

const oldScript = script("script-old", "Original script");
const archivedOldScript = script("script-old", "Original script", false);
const newScript = script("script-new", "Regenerated result");

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((finish) => { resolve = finish; });
  return { promise, resolve };
}

function abortablePending(signal?: AbortSignal | null) {
  return new Promise<Response>((_resolve, reject) => {
    const abort = () => reject(new DOMException("The operation was aborted", "AbortError"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function button(label: string): HTMLButtonElement {
  return [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(label))!;
}

async function mount(uiMode: "simple" | "pro" = "pro") {
  useSettingsStore.setState({ uiMode });
  await act(async () => root!.render(createElement(ScriptPage)));
  expect(container.textContent).toContain("Original script");
}

async function regenerate() {
  await act(async () => button("regenerate").click());
  await act(async () => button("regenConfirmOk").click());
}

function expectBusy() {
  expect(button("regenerating").disabled).toBe(true);
  expect(button("regenerating").getAttribute("aria-busy")).toBe("true");
}

function expectReady() {
  const regenerateButton = button("regenerate");
  expect(regenerateButton).toBeDefined();
  expect(regenerateButton.disabled).toBe(false);
  expect(regenerateButton.getAttribute("aria-busy")).toBe("false");
  expect(container.textContent).not.toContain("regenerating");
}

async function advance(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}

beforeEach(() => {
  navigation.projectId = "project-1";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  useSettingsStore.setState({
    ...settingsInitial,
    locale: "zh",
    llm: { provider: "fixture", baseUrl: "https://example.test", apiKey: "fixture-key", model: "fixture-model" },
  });
  fetchMock.mockReset().mockImplementation(async (url: string) => {
    if (url === scriptsUrl) return Response.json([oldScript]);
    if (url === projectUrl) return Response.json({
      name: "Product",
      productName: "Product",
      productImages: [],
      videoMode: "product_closeup",
    });
    throw new Error(`Unexpected request: ${url}`);
  });
  window.history.replaceState(null, "", "/project/project-1/script");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container.remove();
  useSettingsStore.setState(settingsInitial);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("script regeneration recovers without a page refresh", () => {
  it.each(["simple", "pro"] as const)("applies the %s POST result without waiting for stalled refresh requests", async (uiMode) => {
    const normalFetch = fetchMock.getMockImplementation()!;
    const generation = deferredResponse();
    let started = false;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === generationUrl) { started = true; return generation.promise; }
      if (started && (url === projectUrl || url === scriptsUrl)) return abortablePending(init?.signal);
      return normalFetch(url, init);
    });
    await mount(uiMode);
    await regenerate();
    expectBusy();
    await act(async () => generation.resolve(Response.json({ scripts: [newScript] })));

    expectReady();
    expect(container.textContent).toContain("Regenerated result");
    expect(container.textContent).toContain("Regenerated result details");
    if (uiMode === "pro") expect(container.textContent).toContain("Original script");
    expect(fetchMock.mock.calls.filter(([url]) => url === projectUrl)).toHaveLength(1);
  });

  it("loads saved scripts when the POST response has no script rows", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    let started = false;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === generationUrl) { started = true; return Promise.resolve(Response.json({ success: true })); }
      if (started && url === scriptsUrl) return Promise.resolve(Response.json([archivedOldScript, newScript]));
      if (started && url === projectUrl) return abortablePending(init?.signal);
      return normalFetch(url, init);
    });
    await mount();
    await regenerate();

    expectReady();
    expect(container.textContent).toContain("Regenerated result");
    expect(container.textContent).toContain("Regenerated result details");
    expect(fetchMock.mock.calls.filter(([url]) => url === projectUrl)).toHaveLength(1);
  });

  it.each(["POST", "poll"] as const)("replaces topic history when the %s confirms new saved scripts", async (completion) => {
    const normalFetch = fetchMock.getMockImplementation()!;
    const generation = deferredResponse();
    let started = false;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === projectUrl) return Promise.resolve(Response.json({
        name: "Topic",
        contentType: "topic",
        topic: "A useful topic",
      }));
      if (url === "/api/topic/script") { started = true; return generation.promise; }
      if (started && url === scriptsUrl) return Promise.resolve(Response.json([newScript]));
      return normalFetch(url, init);
    });
    await mount();
    if (completion === "poll") vi.useFakeTimers();
    await regenerate();
    expectBusy();
    if (completion === "POST") {
      await act(async () => generation.resolve(Response.json({ scripts: [newScript] })));
    } else {
      await advance(2_500);
    }

    expectReady();
    expect(container.textContent).toContain("Regenerated result details");
    expect(container.textContent).not.toContain("Original script");
    const request = fetchMock.mock.calls.find(([url]) => url === "/api/topic/script");
    expect(JSON.parse(request![1].body)).toMatchObject({ projectId: "project-1", topic: "A useful topic" });
    expect(fetchMock.mock.calls.some(([url]) => url === generationUrl)).toBe(false);
  });

  it("finishes from selected saved rows while POST is pending and ignores its late response", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    const generation = deferredResponse();
    let started = false;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === generationUrl) { started = true; return generation.promise; }
      if (started && url === scriptsUrl) return Promise.resolve(Response.json([archivedOldScript, newScript]));
      return normalFetch(url, init);
    });
    await mount();
    vi.useFakeTimers();
    await regenerate();
    expectBusy();
    await advance(2_500);

    expectReady();
    expect(container.textContent).toContain("Regenerated result");
    expect(container.textContent).toContain("Regenerated result details");
    const poll = fetchMock.mock.calls.find(([url, init]) => url === scriptsUrl && init?.cache === "no-store");
    expect(poll).toBeDefined();
    await act(async () => generation.resolve(Response.json({ scripts: [script("late-script", "Stale late response")] })));
    expectReady();
    expect(container.textContent).toContain("Regenerated result");
    expect(container.textContent).toContain("Regenerated result details");
    expect(container.textContent).not.toContain("Stale late response");
  });

  it("waits past old selected rows and new unselected history until a new selected script is saved", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    let started = false;
    let savedRows = [oldScript];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === generationUrl) { started = true; return abortablePending(init?.signal); }
      if (started && url === scriptsUrl) return Promise.resolve(Response.json(savedRows));
      return normalFetch(url, init);
    });
    await mount();
    vi.useFakeTimers();
    await regenerate();
    await advance(2_500);
    expectBusy();

    savedRows = [oldScript, script("historical-script", "Unselected history", false)];
    await advance(2_500);
    expectBusy();
    expect(container.textContent).not.toContain("Unselected history");

    savedRows = [archivedOldScript, newScript];
    await advance(2_500);
    expectReady();
    expect(container.textContent).toContain("Regenerated result");
    expect(container.textContent).toContain("Regenerated result details");
  });

  it("retries a temporary polling failure while generation remains pending", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    let started = false;
    let polls = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === generationUrl) { started = true; return abortablePending(init?.signal); }
      if (started && url === scriptsUrl) {
        polls += 1;
        return Promise.resolve(polls === 1
          ? Response.json({ error: "temporarily unavailable" }, { status: 503 })
          : Response.json([newScript]));
      }
      return normalFetch(url, init);
    });
    await mount();
    vi.useFakeTimers();
    await regenerate();
    await advance(2_500);
    expectBusy();
    await advance(2_500);

    expectReady();
    expect(polls).toBe(2);
    expect(container.textContent).toContain("Regenerated result");
    expect(container.textContent).not.toContain("errorGenerationUnconfirmed");
  });

  it.each(["simple", "pro"] as const)("restores the %s button and current editor after a failed POST", async (uiMode) => {
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === generationUrl
      ? Promise.resolve(Response.json({ error: "fixture generation failed" }, { status: 500 }))
      : normalFetch(url, init));
    await mount(uiMode);
    await regenerate();

    expectReady();
    expect(container.textContent).toContain("fixture generation failed");
    expect(container.textContent).toContain("Original script");
  });

  it("ends an unconfirmed generation after ten minutes and stops polling", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    let generationSignal: AbortSignal | null | undefined;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === generationUrl) { generationSignal = init?.signal; return abortablePending(init?.signal); }
      return normalFetch(url, init);
    });
    await mount();
    vi.useFakeTimers();
    await regenerate();
    expectBusy();
    await advance(10 * 60_000);

    expectReady();
    expect(container.textContent).toContain("errorGenerationUnconfirmed");
    expect(container.textContent).toContain("Original script");
    expect(generationSignal?.aborted).toBe(true);
    const requestCount = fetchMock.mock.calls.length;
    await advance(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(requestCount);
  });

  it("aborts an overdue poll and retries so one stalled GET cannot block recovery", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    let started = false;
    let polls = 0;
    let stalledSignal: AbortSignal | null | undefined;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === generationUrl) { started = true; return abortablePending(init?.signal); }
      if (started && url === scriptsUrl) {
        polls += 1;
        if (polls === 1) { stalledSignal = init?.signal; return abortablePending(init?.signal); }
        return Promise.resolve(Response.json([newScript]));
      }
      return normalFetch(url, init);
    });
    await mount();
    vi.useFakeTimers();
    await regenerate();
    await advance(2_500);
    expectBusy();
    await advance(15_000);
    expect(stalledSignal?.aborted).toBe(true);
    await advance(2_500);

    expectReady();
    expect(container.textContent).toContain("Regenerated result");
  });

  it("aborts the pending POST and poll and clears generation timers on unmount", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    const activeSignals: (AbortSignal | null | undefined)[] = [];
    let started = false;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === generationUrl || (started && url === scriptsUrl)) {
        started = true;
        activeSignals.push(init?.signal);
        return abortablePending(init?.signal);
      }
      return normalFetch(url, init);
    });
    await mount();
    vi.useFakeTimers();
    await regenerate();
    await advance(2_500);
    expect(activeSignals).toHaveLength(2);

    await act(async () => root!.unmount());
    root = undefined;
    expect(activeSignals.every((signal) => signal?.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const requestCount = fetchMock.mock.calls.length;
    await advance(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(requestCount);
  });

  it("cancels the old generation and restores the button when route state is reused for another project", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    let generationSignal: AbortSignal | null | undefined;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === generationUrl) { generationSignal = init?.signal; return abortablePending(init?.signal); }
      if (url === "/api/project/project-2/scripts") return Promise.resolve(Response.json([script("other-script", "Other project script")]));
      if (url === "/api/project/project-2") return Promise.resolve(Response.json({ name: "Other product", productName: "Other product", productImages: [] }));
      return normalFetch(url, init);
    });
    await mount();
    vi.useFakeTimers();
    await regenerate();
    expectBusy();
    navigation.projectId = "project-2";
    await act(async () => root!.render(createElement(ScriptPage)));

    expect(generationSignal?.aborted).toBe(true);
    expect(container.textContent).toContain("Other project script");
    expectReady();
    expect(container.textContent).not.toContain("Original script");
    const requestCount = fetchMock.mock.calls.length;
    await advance(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(requestCount);
  });
});
