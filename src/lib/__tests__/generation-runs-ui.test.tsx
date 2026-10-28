import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GenerationRunsPanel } from "@/components/generation-runs-panel";
import { GENERATION_RUNS_REFRESH_EVENT, submitGenerationRun, useGenerationRuns, type GenerationRun, type GenerationRunInput } from "@/lib/hooks/use-generation-runs";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(window.location.search) }));

const request = vi.fn();
let root: Root;
let container: HTMLDivElement;
let observed: ReturnType<typeof useGenerationRuns>;
function Probe({ projectId }: { projectId: string }) {
  const value = useGenerationRuns(projectId);
  useEffect(() => { observed = value; });
  return <div>{value.runs.map((run) => run.id).join(",")}{value.error}</div>;
}
function run(id: string, projectId = "A", overrides: Partial<GenerationRun> = {}): GenerationRun {
  return { id, projectId, kind: "video_batch", status: "running", total: 2, done: 0, failed: 0, items: [{ id: `${id}-1`, kind: "video", scriptId: "old-script", shotId: 1, status: "running", stage: "cloud_running" }, { id: `${id}-2`, kind: "video", scriptId: "new-script", shotId: 2, status: "queued" }], ...overrides };
}
function input(): GenerationRunInput {
  return { projectId: "A", clientRequestId: "stable-confirmation", kind: "video_batch", items: [{ kind: "video", scriptId: "script-A", shotId: 1, request: { provider: "fixture", model: "original-model", options: { duration: 5 } }, asset: { expectedSelectedAssetId: "frame-A" } }] };
}
async function mount(projectId = "A") { await act(async () => root.render(<Probe projectId={projectId} />)); }
async function tick(ms: number) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }
async function click(text: string) { await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === text)!.click()); }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", request);
  request.mockReset().mockResolvedValue(Response.json({ runs: [] }));
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  window.history.replaceState(null, "", "/");
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

describe("project background run recovery", () => {
  it("ignores a late A response after switching to B and aborts only the stale read", async () => {
    let finishA!: (response: Response) => void;
    let signalA: AbortSignal | undefined;
    request.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("projectId=A")) { signalA = init?.signal as AbortSignal; return new Promise((resolve) => { finishA = resolve; }); }
      return Promise.resolve(Response.json({ runs: [run("B-current", "B")] }));
    });
    await mount();
    await mount("B");
    expect(signalA?.aborted).toBe(true);
    expect(observed.runs.map((item) => item.id)).toEqual(["B-current"]);
    await act(async () => finishA(Response.json({ runs: [run("A-late")] })));
    expect(container.textContent).toBe("B-current");
    expect(request.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it("reloads every batch and script version when returning to a project", async () => {
    request.mockImplementation((url: string) => Promise.resolve(Response.json({ runs: url.includes("projectId=A") ? [run("A-first"), run("A-second", "A", { status: "completed", done: 2 })] : [run("B-first", "B")] })));
    await mount();
    await mount("B");
    expect(observed.runs[0].projectId).toBe("B");
    await mount();
    expect(observed.runs.map((item) => item.id)).toEqual(["A-first", "A-second"]);
    expect(observed.runs[0].items.map((item) => item.scriptId)).toEqual(["old-script", "new-script"]);
  });

  it("polls active work, pauses in a hidden tab and refreshes immediately on return", async () => {
    vi.useFakeTimers();
    request.mockImplementation(() => Promise.resolve(Response.json({ runs: [run("active")] })));
    await mount();
    expect(request).toHaveBeenCalledTimes(1);
    await tick(2500);
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
    await tick(20_000);
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("recovers after a stalled response body even if the transport ignores abort", async () => {
    vi.useFakeTimers();
    request.mockResolvedValueOnce({ ok: true, json: () => new Promise(() => {}) });
    await mount();
    await tick(15_000);
    expect(observed.loading).toBe(false);
    expect(observed.error).toContain("读取后台任务超时");
    request.mockImplementation(() => Promise.resolve(Response.json({ runs: [run("recovered")] })));
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(observed.runs[0].id).toBe("recovered");
    expect(observed.error).toBeNull();
  });

  it("keeps the submitted snapshot independent of subsequent UI settings and read cleanup", async () => {
    let finish!: (response: Response) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const original = input();
    const promise = submitGenerationRun(original);
    const [, posted] = request.mock.calls[0];
    original.items[0].request.model = "B-new-model";
    expect(JSON.parse(posted.body).items[0].request.model).toBe("original-model");
    expect(posted.signal.aborted).toBe(false);
    finish(Response.json(run("submitted"), { status: 202 }));
    await expect(promise).resolves.toMatchObject({ id: "submitted" });
  });

  it("bounds a missing submission acknowledgement and signals the task list to reconcile", async () => {
    vi.useFakeTimers();
    request.mockResolvedValueOnce({ ok: true, json: () => new Promise(() => {}) });
    const changed = vi.fn(); window.addEventListener(GENERATION_RUNS_REFRESH_EVENT, changed);
    const promise = submitGenerationRun(input());
    const failed = expect(promise).rejects.toThrow("后台任务提交超时，请刷新任务列表核对提交结果。");
    await tick(15_000); await failed;
    expect(request.mock.calls[0][1].signal.aborted).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    window.removeEventListener(GENERATION_RUNS_REFRESH_EVENT, changed);
  });
});

describe("generation run history panel", () => {
  it("opens a historical deep link and refreshes saved results without selecting its old script", async () => {
    window.history.replaceState(null, "", "/project/A/assets?runId=old-batch");
    const old = run("old-batch", "A", { status: "completed", done: 1, items: [{ id: "old-shot", kind: "video", scriptId: "historical-script", shotId: 7, status: "completed", result: { childJobId: "child-job" } }] });
    request.mockImplementation((url: string) => Promise.resolve(Response.json(url === "/api/generation-runs/old-batch" ? old : { runs: [run("current")] })));
    const completed = vi.fn();
    await act(async () => root.render(<GenerationRunsPanel projectId="A" onCompleted={completed} />));
    expect(container.querySelector('details[data-run-id="old-batch"]')?.hasAttribute("open")).toBe(true);
    expect(container.textContent).toContain("historical-script");
    expect(container.querySelector('a')?.getAttribute("href")).toBe("/project/A/assets?klingJob=child-job");
    expect(completed).toHaveBeenCalledWith(old);
    expect(container.querySelectorAll("details")).toHaveLength(2);
  });

  it("rejects a deep link from another project", async () => {
    window.history.replaceState(null, "", "/project/A/assets?runId=foreign");
    request.mockImplementation((url: string) => Promise.resolve(Response.json(url.endsWith("/foreign") ? run("foreign", "B") : { runs: [] })));
    await act(async () => root.render(<GenerationRunsPanel projectId="A" />));
    expect(container.querySelectorAll("details")).toHaveLength(0);
    expect(container.textContent).toContain("暂无后台任务");
  });

  it("refreshes assets only for newly completed results and includes all historical batches", async () => {
    const completed = vi.fn();
    let current = run("batch", "A", { done: 1, items: [{ id: "one", kind: "image", scriptId: "old-script", shotId: 1, status: "completed", result: { assetId: "asset-one" } }, { id: "two", kind: "video", scriptId: "new-script", shotId: 2, status: "running", stage: "internal_raw_phase" }] });
    request.mockImplementation(() => Promise.resolve(Response.json({ runs: [current, run("older", "A", { status: "cancelled" })] })));
    await act(async () => root.render(<GenerationRunsPanel projectId="A" onCompleted={completed} />));
    expect(completed).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("old-script");
    expect(container.textContent).toContain("new-script");
    expect(container.textContent).not.toContain("internal_raw_phase");
    await click("刷新任务");
    expect(completed).toHaveBeenCalledTimes(1);
    current = { ...current, status: "completed", done: 2, items: current.items.map((item) => ({ ...item, status: "completed", result: { assetId: item.id } })) };
    await click("刷新任务");
    expect(completed).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll("details")).toHaveLength(2);
  });

  it("offers stopping queued work and recovering saved outputs as distinct server actions", async () => {
    request.mockImplementation((url: string, init?: RequestInit) => Promise.resolve(Response.json(init?.method === "POST" ? run(url.endsWith("/active") ? "active" : "recover") : { runs: [run("active"), run("recover", "A", { status: "needs_attention", failed: 1 })] })));
    await act(async () => root.render(<GenerationRunsPanel projectId="A" />));
    await click("停止未提交镜头");
    await click("恢复保存");
    const actions = request.mock.calls.filter(([, init]) => init?.method === "POST").map(([url, init]) => [url, JSON.parse(init.body)]);
    expect(actions).toEqual([["/api/generation-runs/active", { action: "cancel" }], ["/api/generation-runs/recover", { action: "retry_import" }]]);
  });
});
