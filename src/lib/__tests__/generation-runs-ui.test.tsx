import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GenerationRunsPanel } from "@/components/generation-runs-panel";
import { GENERATION_RUNS_REFRESH_EVENT, GenerationRunSubmissionError, submitGenerationRun, useGenerationRuns, type GenerationRun, type GenerationRunInput } from "@/lib/hooks/use-generation-runs";
import { TASK_FEED_REFRESH_EVENT } from "@/lib/task-feed";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(window.location.search) }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h3>{children}</h3>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const request = vi.fn();
let root: Root;
let container: HTMLDivElement;
let observed: ReturnType<typeof useGenerationRuns>;
function Probe({ projectId }: { projectId: string }) {
  const value = useGenerationRuns(projectId);
  useEffect(() => { observed = value; });
  return <div>{value.runs.map((run) => run.id).join(",")}{value.error}</div>;
}
function SharedPanel({ projectId, onCompleted }: { projectId: string; onCompleted?(run: GenerationRun): void | Promise<void> }) {
  const controller = useGenerationRuns(projectId);
  useEffect(() => { observed = controller; });
  return <GenerationRunsPanel projectId={projectId} controller={controller} onCompleted={onCompleted} />;
}
function run(id: string, projectId = "A", overrides: Partial<GenerationRun> = {}): GenerationRun {
  return { id, projectId, kind: "video_batch", status: "running", total: 2, done: 0, failed: 0, items: [{ id: `${id}-1`, kind: "video", scriptId: "old-script", shotId: 1, status: "running", stage: "cloud_running" }, { id: `${id}-2`, kind: "video", scriptId: "new-script", shotId: 2, status: "queued" }], ...overrides };
}
function finished(id: string, projectId = "A", status: "completed" | "failed" = "completed"): GenerationRun {
  return run(id, projectId, { status, done: status === "completed" ? 1 : 0, failed: status === "failed" ? 1 : 0, total: 1,
    items: [{ id: `${id}-one`, kind: "image", status, result: status === "completed" ? { assetId: `asset-${id}` } : undefined }] });
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

  it.each([
    { status: 409, code: "GENERATION_ALREADY_ACTIVE", message: "该镜头或生成阶段已有未结束任务，请查看原任务。" },
    { status: 400, code: "INVALID_GENERATION_RUN", message: "任务条目无效。" },
  ])("preserves a definite $status registration rejection without marking its outcome unknown", async ({ status, code, message }) => {
    request.mockResolvedValueOnce(Response.json({ error: message, code }, { status }));
    const failure = await submitGenerationRun(input()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GenerationRunSubmissionError);
    expect(failure).toMatchObject({ message, status, code, clientRequestId: "stable-confirmation", outcomeUnknown: false });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe("/api/generation-runs");
  });

  it.each([
    { label: "request timeout", response: () => Response.json({ error: "请求超时", code: "REQUEST_TIMEOUT" }, { status: 408 }) },
    { label: "existing request conflict", response: () => Response.json({ error: "相同请求编号的内容已变化，请重新确认。", code: "GENERATION_REQUEST_CONFLICT" }, { status: 409 }) },
    { label: "server error", response: () => Response.json({ error: "暂时无法读取任务", code: "GENERATION_FAILED" }, { status: 500 }) },
    { label: "unreadable gateway response", response: () => new Response("<html>Bad gateway</html>", { status: 502 }) },
    { label: "success without a task ID", response: () => Response.json({ accepted: true }, { status: 202 }) },
    { label: "unstructured client error", response: () => Response.json({ error: "请求被拒绝" }, { status: 400 }) },
    { label: "unreadable client error", response: () => new Response("<html>Unavailable</html>", { status: 400 }) },
  ])("keeps $label blocked as an unknown registration outcome", async ({ response }) => {
    request.mockResolvedValueOnce(response());
    const failure = await submitGenerationRun(input()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GenerationRunSubmissionError);
    expect(failure).toMatchObject({ clientRequestId: "stable-confirmation", outcomeUnknown: true });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps a transport failure unknown and preserves the request key for reconciliation", async () => {
    request.mockRejectedValueOnce(new TypeError("Network interrupted"));
    const failure = await submitGenerationRun(input()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GenerationRunSubmissionError);
    expect(failure).toMatchObject({ message: "Network interrupted", clientRequestId: "stable-confirmation", outcomeUnknown: true });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("bounds a missing submission acknowledgement and signals the task list to reconcile", async () => {
    vi.useFakeTimers();
    request.mockResolvedValueOnce({ ok: true, json: () => new Promise(() => {}) });
    const changed = vi.fn(); window.addEventListener(GENERATION_RUNS_REFRESH_EVENT, changed);
    const promise = submitGenerationRun(input());
    const failed = expect(promise).rejects.toMatchObject({ message: "后台任务提交超时，请刷新任务列表核对提交结果。", clientRequestId: "stable-confirmation", outcomeUnknown: true });
    await tick(15_000); await failed;
    await expect(promise).rejects.toBeInstanceOf(GenerationRunSubmissionError);
    expect(request.mock.calls[0][1].signal.aborted).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    window.removeEventListener(GENERATION_RUNS_REFRESH_EVENT, changed);
  });
});

describe("generation run history panel", () => {
  it("shares the page controller for initial reads, polling and refresh without a redundant deep-link read", async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/project/A/assets?runId=shared-active");
    request.mockImplementation(() => Promise.resolve(Response.json({ runs: [run("shared-active")] })));
    await act(async () => root.render(<SharedPanel projectId="A" />));
    expect(request.mock.calls.map(([url]) => url)).toEqual(["/api/generation-runs?projectId=A"]);
    expect(container.querySelector('details[data-run-id="shared-active"]')?.hasAttribute("open")).toBe(true);
    await tick(2500);
    expect(request).toHaveBeenCalledTimes(2);
    await click("刷新任务");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("baselines all historical completions and notifies for a newly saved batch after the initial list", async () => {
    const completed = vi.fn();
    let current = [finished("history-one"), finished("history-two"), finished("history-three"), finished("history-failed", "A", "failed")];
    request.mockImplementation(() => Promise.resolve(Response.json({ runs: current })));
    await act(async () => root.render(<SharedPanel projectId="A" onCompleted={completed} />));
    expect(completed).not.toHaveBeenCalled();
    expect(container.querySelectorAll("details")).toHaveLength(4);
    current = [...current, finished("newly-saved")];
    await click("刷新任务");
    expect(completed).toHaveBeenCalledExactlyOnceWith(current[4]);
    await click("刷新任务");
    expect(completed).toHaveBeenCalledOnce();
  });

  it.each(["ISO", "milliseconds"])("reconciles a completion during the initial asset read from a %s timestamp without reloading history", async (format) => {
    vi.useFakeTimers();
    const mountedAt = Date.parse("2026-11-02T00:00:00.750Z");
    vi.setSystemTime(mountedAt);
    const completed = vi.fn();
    const recent = { ...finished("completed-during-initial-read"), updatedAt: format === "ISO" ? "2026-11-02T00:00:00.000Z" : mountedAt };
    const current = [
      { ...finished("older-than-session"), updatedAt: "2026-11-01T23:59:59.999Z" },
      finished("timestamp-unknown"),
      { ...finished("timestamp-invalid"), updatedAt: "unreadable" },
      recent,
    ];
    let finishInitial!: (response: Response) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => { finishInitial = resolve; }))
      .mockImplementation(() => Promise.resolve(Response.json({ runs: current })));
    await act(async () => root.render(<SharedPanel projectId="A" onCompleted={completed} />));
    // The page's parallel asset GET may already have captured the old assets
    // before the task list first reports this completion.
    await tick(1250);
    await act(async () => finishInitial(Response.json({ runs: current })));
    expect(completed).toHaveBeenCalledExactlyOnceWith(recent);
    await click("刷新任务");
    expect(completed).toHaveBeenCalledOnce();
  });

  it("reconciles a newly completed deep link while retaining the historical-list baseline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T00:00:00.750Z"));
    window.history.replaceState(null, "", "/project/A/assets?runId=recent-linked");
    const completed = vi.fn();
    const recent = { ...finished("recent-linked"), updatedAt: "2026-11-02T00:00:00.000Z" };
    request.mockImplementation((url: string) => Promise.resolve(Response.json(url === "/api/generation-runs/recent-linked" ? recent : { runs: [finished("linked-old-history")] })));
    await act(async () => root.render(<SharedPanel projectId="A" onCompleted={completed} />));
    expect(completed).toHaveBeenCalledExactlyOnceWith(recent);
    await click("刷新任务");
    expect(completed).toHaveBeenCalledOnce();
  });

  it("waits for a successful initial list before baselining history after a read failure", async () => {
    const completed = vi.fn();
    request.mockResolvedValueOnce(Response.json({ error: "读取暂不可用" }, { status: 503 }));
    await act(async () => root.render(<SharedPanel projectId="A" onCompleted={completed} />));
    expect(container.textContent).toContain("读取暂不可用");
    request.mockImplementation(() => Promise.resolve(Response.json({ runs: [finished("recovered-history")] })));
    await click("刷新任务");
    expect(completed).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("读取暂不可用");
  });

  it("tracks an active linked run through completion and does not notify again when it enters the list", async () => {
    window.history.replaceState(null, "", "/project/A/assets?runId=linked-active");
    const completed = vi.fn();
    let linked = run("linked-active");
    let listed: GenerationRun[] = [];
    request.mockImplementation((url: string) => Promise.resolve(Response.json(url === "/api/generation-runs/linked-active" ? linked : { runs: listed })));
    await act(async () => root.render(<SharedPanel projectId="A" onCompleted={completed} />));
    expect(completed).not.toHaveBeenCalled();
    linked = finished("linked-active");
    await click("刷新任务");
    expect(completed).toHaveBeenCalledExactlyOnceWith(linked);
    listed = [linked];
    await click("刷新任务");
    expect(completed).toHaveBeenCalledOnce();
    expect(container.querySelectorAll("details")).toHaveLength(1);
  });

  it("baselines the next project's history and still observes its active work completing", async () => {
    const completed = vi.fn();
    let projectB = [finished("B-history", "B"), run("B-active", "B")];
    request.mockImplementation((url: string) => Promise.resolve(Response.json({ runs: url.includes("projectId=A") ? [finished("A-history")] : projectB })));
    await act(async () => root.render(<SharedPanel projectId="A" onCompleted={completed} />));
    await act(async () => root.render(<SharedPanel projectId="B" onCompleted={completed} />));
    expect(completed).not.toHaveBeenCalled();
    projectB = [projectB[0], finished("B-active", "B")];
    await click("刷新任务");
    expect(completed).toHaveBeenCalledExactlyOnceWith(projectB[1]);
  });

  it.each(["synchronous", "asynchronous"])("shows a recoverable error for a %s completion callback failure", async (mode) => {
    let current = run(`callback-${mode}`);
    request.mockImplementation(() => Promise.resolve(Response.json({ runs: [current] })));
    const completed = vi.fn(() => {
      if (mode === "synchronous") throw new Error("refresh failed");
      return Promise.reject(new Error("refresh failed"));
    });
    await act(async () => root.render(<SharedPanel projectId="A" onCompleted={completed} />));
    current = finished(current.id);
    await click("刷新任务");
    expect(completed).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("任务已完成，刷新素材失败，请重新读取。");
    expect(container.querySelector(`details[data-run-id="${current.id}"]`)).not.toBeNull();
  });

  it("offers deletion only when every item is completed or failed and confirms bulk cleanup", async () => {
    let current = [finished("cleanup-done"), finished("cleanup-failed", "A", "failed"), run("cleanup-active"),
      run("cleanup-attention", "A", { status: "needs_attention" }), run("cleanup-cancelled", "A", { status: "cancelled" }),
      run("cleanup-mixed-cancelled", "A", { status: "failed", items: [{ id: "failed", kind: "image", status: "failed" }, { id: "cancelled", kind: "video", status: "cancelled" }] }),
      run("cleanup-empty", "A", { status: "completed", items: [] })];
    request.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") { current = current.filter((item) => !["cleanup-done", "cleanup-failed"].includes(item.id)); return Promise.resolve(Response.json({ deletedIds: ["cleanup-done", "cleanup-failed"], deletedCount: 2 })); }
      return Promise.resolve(Response.json({ runs: current }));
    });
    await act(async () => root.render(<GenerationRunsPanel projectId="A" />));
    expect(container.querySelectorAll('button[aria-label^="删除任务记录"]')).toHaveLength(2);
    expect(container.querySelector('details[data-run-id="cleanup-mixed-cancelled"]')?.parentElement?.querySelector('button[aria-label^="删除任务记录"]')).toBeNull();
    await click("清理已完成和失败");
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("生成素材会保留");
    expect(request.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);
    await click("取消清理");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await click("清理已完成和失败"); await click("确认清理");
    expect(request.mock.calls.filter(([, init]) => init?.method === "DELETE").map(([url]) => url)).toEqual(["/api/generation-runs?projectId=A"]);
    expect(container.textContent).toContain("已清理 2 条任务记录，生成素材已保留");
    expect(container.querySelectorAll("details")).toHaveLength(5);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(request.mock.calls.some(([, init]) => ["POST", "PATCH"].includes(init?.method))).toBe(false);
  });

  it("deletes one record directly, disables concurrent actions, and refreshes all task feeds", async () => {
    let finish!: (response: Response) => void;
    let current = [finished("single-delete"), finished("single-retained")];
    request.mockImplementation((_url: string, init?: RequestInit) => init?.method === "DELETE" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(Response.json({ runs: current })));
    const feedChanged = vi.fn(); window.addEventListener(TASK_FEED_REFRESH_EVENT, feedChanged);
    await act(async () => root.render(<><GenerationRunsPanel projectId="A" /><Probe projectId="A" /></>));
    const folded = container.querySelector<HTMLDetailsElement>('details[data-run-id="single-delete"]')!;
    const deleteButton = container.querySelector<HTMLButtonElement>('button[aria-label="删除任务记录 single-delete"]')!;
    expect(folded.open).toBe(false);
    expect(deleteButton.closest("details")).toBeNull();
    expect(deleteButton.parentElement).toBe(folded.parentElement);
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="删除任务记录 single-delete"]')!.click());
    expect(folded.open).toBe(false);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="删除任务记录 single-delete"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="删除任务记录 single-retained"]')?.disabled).toBe(true);
    current = [current[1]];
    await act(async () => finish(Response.json({ deletedIds: ["single-delete"], deletedCount: 1 })));
    expect(request.mock.calls.filter(([, init]) => init?.method === "DELETE").map(([url]) => url)).toEqual(["/api/generation-runs/single-delete?projectId=A"]);
    expect(container.querySelector('details[data-run-id="single-delete"]')).toBeNull();
    expect(observed.runs.map((item) => item.id)).toEqual(["single-retained"]);
    expect(feedChanged).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("任务记录已删除，生成素材已保留");
    window.removeEventListener(TASK_FEED_REFRESH_EVENT, feedChanged);
  });

  it("keeps a failed bulk cleanup reviewable and locks the confirmation while pending", async () => {
    let finish!: (response: Response) => void;
    request.mockImplementation((_url: string, init?: RequestInit) => init?.method === "DELETE" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(Response.json({ runs: [finished("cleanup-error-record")] })));
    await act(async () => root.render(<GenerationRunsPanel projectId="A" />));
    await click("清理已完成和失败");
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "确认清理")!.click());
    expect([...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "正在清理…")?.disabled).toBe(true);
    expect([...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "取消清理")?.disabled).toBe(true);
    await act(async () => finish(Response.json({ error: "暂时无法清理任务记录" }, { status: 503 })));
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("暂时无法清理任务记录");
    expect(container.querySelector('details[data-run-id="cleanup-error-record"]')).not.toBeNull();
    expect([...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "确认清理")?.disabled).toBe(false);
    expect(request.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });

  it("bounds a deletion whose response body stalls and refreshes without hiding an unconfirmed record", async () => {
    vi.useFakeTimers();
    request.mockImplementation((_url: string, init?: RequestInit) => Promise.resolve(init?.method === "DELETE" ? { ok: true, json: () => new Promise(() => {}) } : Response.json({ runs: [finished("delete-timeout-record")] })));
    await act(async () => root.render(<GenerationRunsPanel projectId="A" />));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="删除任务记录 delete-timeout-record"]')!.click());
    await tick(15_000);
    expect(container.textContent).toContain("删除任务记录超时，请刷新列表核对结果");
    expect(container.querySelector('details[data-run-id="delete-timeout-record"]')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="删除任务记录 delete-timeout-record"]')?.disabled).toBe(false);
    const deletion = request.mock.calls.find(([, init]) => init?.method === "DELETE")!;
    expect(deletion[1].signal.aborted).toBe(true);
    expect(request.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });

  it("retains a rejected deletion, shows its error and allows a later retry", async () => {
    request.mockImplementation((_url: string, init?: RequestInit) => Promise.resolve(init?.method === "DELETE"
      ? Response.json({ error: "任务状态已变化，请刷新后重试" }, { status: 409 }) : Response.json({ runs: [finished("delete-rejected")] })));
    await act(async () => root.render(<GenerationRunsPanel projectId="A" />));
    await click("删除记录");
    expect(container.querySelector('details[data-run-id="delete-rejected"]')).not.toBeNull();
    expect(container.textContent).toContain("任务状态已变化，请刷新后重试");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="删除任务记录 delete-rejected"]')?.disabled).toBe(false);
    request.mockImplementation((_url: string, init?: RequestInit) => Promise.resolve(Response.json(init?.method === "DELETE" ? { deletedIds: [], deletedCount: 0 } : { runs: [finished("delete-rejected")] })));
    await click("删除记录");
    expect(container.querySelector('details[data-run-id="delete-rejected"]')).toBeNull();
  });

  it("does not resurrect a deleted record from a stale poll or an unchanged deep-link URL", async () => {
    window.history.replaceState(null, "", "/project/A/assets?runId=delete-linked");
    const old = finished("delete-linked");
    let finishPoll!: (response: Response) => void;
    let deferPoll = false;
    request.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return Promise.resolve(Response.json({ deletedIds: [old.id], deletedCount: 1 }));
      if (url === "/api/generation-runs/delete-linked") return Promise.resolve(Response.json(old));
      if (deferPoll) { deferPoll = false; return new Promise((resolve) => { finishPoll = resolve; }); }
      return Promise.resolve(Response.json({ runs: [old] }));
    });
    await act(async () => root.render(<><GenerationRunsPanel projectId="A" /><Probe projectId="A" /></>));
    const initialLinkedReads = request.mock.calls.filter(([url]) => url === "/api/generation-runs/delete-linked").length;
    deferPoll = true;
    await act(async () => { void observed.refresh(); });
    await click("删除记录");
    expect(container.querySelector('details[data-run-id="delete-linked"]')).toBeNull();
    await act(async () => finishPoll(Response.json({ runs: [old] })));
    await click("刷新任务");
    expect(container.querySelector('details[data-run-id="delete-linked"]')).toBeNull();
    expect(observed.runs).toEqual([]);
    expect(window.location.search).toBe("?runId=delete-linked");
    expect(request.mock.calls.filter(([url]) => url === "/api/generation-runs/delete-linked")).toHaveLength(initialLinkedReads);
  });

  it("ignores a late deep-link response after the same record was deleted by another hook", async () => {
    window.history.replaceState(null, "", "/project/A/assets?runId=delete-late-link");
    let finishLink!: (response: Response) => void;
    request.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return Promise.resolve(Response.json({ deletedIds: ["delete-late-link"], deletedCount: 1 }));
      if (url === "/api/generation-runs/delete-late-link") return new Promise((resolve) => { finishLink = resolve; });
      return Promise.resolve(Response.json({ runs: [] }));
    });
    await act(async () => root.render(<><GenerationRunsPanel projectId="A" /><Probe projectId="A" /></>));
    await act(async () => { await observed.deleteRun("delete-late-link"); });
    await act(async () => finishLink(Response.json(finished("delete-late-link"))));
    expect(container.querySelectorAll("details")).toHaveLength(0);
    expect(container.textContent).not.toContain("读取后台任务失败");
  });

  it("does not show a late deletion error from A in project B", async () => {
    let failA!: (response: Response) => void;
    request.mockImplementation((url: string, init?: RequestInit) => init?.method === "DELETE" ? new Promise((resolve) => { failA = resolve; }) : Promise.resolve(Response.json({ runs: url.includes("projectId=A") ? [finished("delete-switch-A")] : [finished("delete-switch-B", "B")] })));
    await act(async () => root.render(<GenerationRunsPanel projectId="A" />));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="删除任务记录 delete-switch-A"]')!.click());
    await act(async () => root.render(<GenerationRunsPanel projectId="B" />));
    await act(async () => failA(Response.json({ error: "A deletion failed" }, { status: 409 })));
    expect(container.querySelector('details[data-run-id="delete-switch-B"]')).not.toBeNull();
    expect(container.textContent).not.toContain("A deletion failed");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="删除任务记录 delete-switch-B"]')?.disabled).toBe(false);
  });

  it("treats a deleted deep link's 410 as gone without repeatedly fetching it", async () => {
    window.history.replaceState(null, "", "/project/A/assets?runId=already-deleted");
    request.mockImplementation((url: string) => Promise.resolve(url === "/api/generation-runs/already-deleted" ? Response.json({ error: "任务记录已删除" }, { status: 410 }) : Response.json({ runs: [] })));
    await act(async () => root.render(<GenerationRunsPanel projectId="A" />));
    const count = request.mock.calls.filter(([url]) => url === "/api/generation-runs/already-deleted").length;
    await click("刷新任务");
    expect(request.mock.calls.filter(([url]) => url === "/api/generation-runs/already-deleted")).toHaveLength(count);
    expect(container.querySelectorAll("details")).toHaveLength(0);
    expect(container.textContent).not.toContain("任务记录已删除");
  });

  it("counts attention separately from actual failures, including legacy combined failure totals", async () => {
    const attention = run("attention", "A", { status: "needs_attention", total: 5, failed: 5, items: Array.from({ length: 5 }, (_, index) => ({ id: `attention-${index}`, kind: "video", shotId: index + 1, status: "needs_attention" })) });
    const mixed = run("mixed", "A", { status: "needs_attention", total: 3, done: 1, failed: 2, items: [
      { id: "saved", kind: "video", status: "completed" },
      { id: "failed", kind: "video", status: "failed" },
      { id: "attention", kind: "video", status: "needs_attention" },
    ] });
    request.mockResolvedValue(Response.json({ runs: [attention, mixed] }));
    await act(async () => root.render(<GenerationRunsPanel projectId="A" />));
    const attentionSummary = container.querySelector('details[data-run-id="attention"] summary')?.textContent;
    expect(attentionSummary).toContain("需处理 5");
    expect(attentionSummary).not.toContain("失败");
    const mixedSummary = container.querySelector('details[data-run-id="mixed"] summary')?.textContent;
    expect(mixedSummary).toContain("失败 1");
    expect(mixedSummary).toContain("需处理 1");
    expect(mixedSummary).not.toContain("失败 2");
  });

  it("links completed refinement candidates from historical scripts without adopting them", async () => {
    const refined = run("refinement", "A", { kind: "keyframe_refine_batch", status: "completed", done: 1, items: [{ id: "candidate", kind: "keyframe_refine", scriptId: "historical-script", shotId: 3, status: "completed", result: { asset: { filePath: "/api/files/A/refined%20frame.png" } } }] });
    request.mockResolvedValue(Response.json({ runs: [refined] }));
    await act(async () => root.render(<GenerationRunsPanel projectId="A" />));
    expect(container.textContent).toContain("批量关键帧精修");
    expect(container.textContent).toContain("historical-script");
    const link = [...container.querySelectorAll("a")].find((item) => item.textContent === "查看精修候选");
    expect(link?.getAttribute("href")).toBe("/api/files/A/refined%20frame.png");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(request.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it.each(["https://elsewhere.invalid/candidate.png", "//elsewhere.invalid/candidate.png", "/api/files/../secret", "/api/files/%2e%2e/secret", "/api/files/%252e%252e/secret", "/api/files/%5c..%5csecret", "javascript:alert(1)"])("does not expose unsafe refinement candidate paths: %s", async (filePath) => {
    request.mockResolvedValue(Response.json({ runs: [run("refinement", "A", { kind: "keyframe_refine", status: "completed", done: 1, items: [{ id: "candidate", kind: "keyframe_refine", status: "completed", result: { asset: { filePath } } }] })] }));
    await act(async () => root.render(<GenerationRunsPanel projectId="A" />));
    expect(container.textContent).toContain("关键帧精修");
    expect(container.textContent).not.toContain("查看精修候选");
  });

  it("opens a historical deep link without reloading saved results or selecting its old script", async () => {
    window.history.replaceState(null, "", "/project/A/assets?runId=old-batch");
    const old = run("old-batch", "A", { status: "completed", done: 1, items: [{ id: "old-shot", kind: "video", scriptId: "historical-script", shotId: 7, status: "completed", result: { childJobId: "child-job" } }] });
    request.mockImplementation((url: string) => Promise.resolve(Response.json(url === "/api/generation-runs/old-batch" ? old : { runs: [run("current")] })));
    const completed = vi.fn();
    await act(async () => root.render(<GenerationRunsPanel projectId="A" onCompleted={completed} />));
    expect(container.querySelector('details[data-run-id="old-batch"]')?.hasAttribute("open")).toBe(true);
    expect(container.textContent).toContain("historical-script");
    expect(container.querySelector('a')?.getAttribute("href")).toBe("/project/A/assets?klingJob=child-job");
    expect(completed).not.toHaveBeenCalled();
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
    expect(completed).not.toHaveBeenCalled();
    expect(container.textContent).toContain("old-script");
    expect(container.textContent).toContain("new-script");
    expect(container.textContent).not.toContain("internal_raw_phase");
    await click("刷新任务");
    expect(completed).not.toHaveBeenCalled();
    current = { ...current, status: "completed", done: 2, items: current.items.map((item) => ({ ...item, status: "completed", result: { assetId: item.id } })) };
    await click("刷新任务");
    expect(completed).toHaveBeenCalledOnce();
    expect(container.querySelectorAll("details")).toHaveLength(2);
    current = { ...current, items: current.items.map((item) => item.id === "one" ? { ...item, result: { assetId: "replacement" } } : item) };
    await click("刷新任务");
    expect(completed).toHaveBeenCalledTimes(2);
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

describe("interrupted Kling shot release", () => {
  function interrupted(projectId = "A"): GenerationRun {
    return run(`interrupted-${projectId}`, projectId, { status: "needs_attention", total: 2, done: 1, failed: 1, items: [
      { id: `uncertain-${projectId}`, kind: "video", scriptId: `script-${projectId}`, shotId: 4, status: "needs_attention", canReleaseBlock: true, error: "提交进程已中断，平台可能已受理", result: { childJobId: `original-${projectId}` } },
      { id: `saved-${projectId}`, kind: "video", shotId: 5, status: "completed", result: { assetId: "saved-video" } },
    ] });
  }
  function released(before: GenerationRun): GenerationRun {
    return { ...before, status: "cancelled", failed: 0, items: before.items.map((item) => item.status === "needs_attention"
      ? { ...item, status: "cancelled", stage: "released", canReleaseBlock: false } : item) };
  }
  it("requires explicit confirmation, releases only that item once and retains original results without generating", async () => {
    let current = interrupted();
    let finish!: (response: Response) => void;
    request.mockImplementation((_url: string, init?: RequestInit) => init?.method === "POST"
      ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(Response.json({ runs: [current] })));
    const onReleased = vi.fn(), onCompleted = vi.fn(), generationChanged = vi.fn(), feedChanged = vi.fn();
    window.addEventListener(GENERATION_RUNS_REFRESH_EVENT, generationChanged);
    window.addEventListener(TASK_FEED_REFRESH_EVENT, feedChanged);
    try {
      await act(async () => root.render(<GenerationRunsPanel projectId="A" onReleased={onReleased} onCompleted={onCompleted} />));
      await click("解除阻塞");
      expect(container.querySelector('[role="dialog"]')?.textContent).toContain("原云端任务可能仍在运行或已扣费");
      expect(container.querySelector('[role="dialog"]')?.textContent).toContain("重新生成可能再次消耗积分");
      expect(request.mock.calls.some(([, init]) => init?.method)).toBe(false);
      const confirm = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "确认解除阻塞")!;
      await act(async () => { confirm.click(); confirm.click(); });
      expect(container.querySelector('[role="dialog"]')?.textContent).toContain("正在解除…");
      expect([...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "暂不解除")?.disabled).toBe(true);
      const actions = request.mock.calls.filter(([, init]) => init?.method === "POST");
      expect(actions).toHaveLength(1);
      expect(actions[0][0]).toBe("/api/generation-runs/interrupted-A");
      expect(JSON.parse(actions[0][1].body)).toEqual({ action: "release_block", itemId: "uncertain-A", acknowledgePossibleCharge: true, projectId: "A" });
      current = released(current);
      await act(async () => finish(Response.json(current)));
      expect(onReleased).toHaveBeenCalledOnce();
      expect(onCompleted).not.toHaveBeenCalled();
      expect(generationChanged).toHaveBeenCalledOnce(); expect(feedChanged).toHaveBeenCalledOnce();
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(container.textContent).toContain("镜头 4 · 已解除阻塞");
      expect(container.textContent).toContain("镜头 5 · 已完成");
      expect(container.querySelector('summary')?.textContent).toContain("已结束");
      expect(container.textContent).toContain("提交进程已中断");
      expect(container.querySelector('a[href="/project/A/assets?klingJob=original-A"]')).not.toBeNull();
      expect(request.mock.calls.some(([url, init]) => url === "/api/generation-runs" && init?.method === "POST")).toBe(false);
    } finally {
      window.removeEventListener(GENERATION_RUNS_REFRESH_EVENT, generationChanged);
      window.removeEventListener(TASK_FEED_REFRESH_EVENT, feedChanged);
    }
  });

  it("only offers release when the server explicitly marks the item releasable", async () => {
    const current = interrupted();
    current.items[0].canReleaseBlock = undefined;
    current.items.push({ ...current.items[0], id: "explicitly-blocked", canReleaseBlock: false });
    request.mockImplementation(() => Promise.resolve(Response.json({ runs: [current] })));
    await act(async () => root.render(<GenerationRunsPanel projectId="A" />));
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "解除阻塞")).toBe(false);
    expect(request.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it("keeps a rejected release visible and allows an explicit retry", async () => {
    let current = interrupted();
    let attempts = 0;
    request.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return Promise.resolve(Response.json({ runs: [current] }));
      if (++attempts === 1) return Promise.resolve(Response.json({ error: "原任务仍在处理，请稍后重试" }, { status: 409 }));
      current = released(current); return Promise.resolve(Response.json(current));
    });
    const onReleased = vi.fn();
    await act(async () => root.render(<GenerationRunsPanel projectId="A" onReleased={onReleased} />));
    await click("解除阻塞"); await click("确认解除阻塞");
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("原任务仍在处理");
    expect([...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "确认解除阻塞")?.disabled).toBe(false);
    expect(onReleased).not.toHaveBeenCalled();
    await click("确认解除阻塞");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(onReleased).toHaveBeenCalledOnce();
    expect(attempts).toBe(2);
  });

  it("bounds a stalled release response and leaves the original item for reconciliation", async () => {
    vi.useFakeTimers();
    request.mockImplementation((_url: string, init?: RequestInit) => Promise.resolve(init?.method === "POST"
      ? { ok: true, json: () => new Promise(() => {}) } : Response.json({ runs: [interrupted()] })));
    const onReleased = vi.fn();
    await act(async () => root.render(<GenerationRunsPanel projectId="A" onReleased={onReleased} />));
    await click("解除阻塞"); await click("确认解除阻塞");
    await tick(15_000);
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("解除阻塞超时，请刷新任务列表核对结果");
    const action = request.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(action[1].signal.aborted).toBe(true);
    expect(container.textContent).toContain("镜头 4 · 需要处理");
    expect(onReleased).not.toHaveBeenCalled();
  });

  it("discards late release responses and callbacks after the project changes", async () => {
    let finish!: (response: Response) => void;
    request.mockImplementation((url: string, init?: RequestInit) => init?.method === "POST"
      ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(Response.json({ runs: [interrupted(url.includes("projectId=B") ? "B" : "A")] })));
    const onReleased = vi.fn();
    await act(async () => root.render(<GenerationRunsPanel projectId="A" onReleased={onReleased} />));
    await click("解除阻塞"); await click("确认解除阻塞");
    await act(async () => root.render(<GenerationRunsPanel projectId="B" onReleased={onReleased} />));
    await act(async () => finish(Response.json(released(interrupted()))));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('details[data-run-id="interrupted-B"]')).not.toBeNull();
    expect(container.querySelector('details[data-run-id="interrupted-A"]')).toBeNull();
    expect(onReleased).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("可以重新转动态");
    await click("解除阻塞");
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("解除镜头 4");
    const actions = request.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(actions).toHaveLength(1); expect(JSON.parse(actions[0][1].body).projectId).toBe("A");
  });
});
