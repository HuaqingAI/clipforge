import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KlingFilmPanel } from "@/components/kling-film-panel";
import type { KlingFilmView } from "@/lib/kling/film-types";
import type { KlingVideoModelDescriptor } from "@/lib/kling/types";

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/lib/kling/client", () => ({ klingFetch: api.request, klingErrorMessage: (body: { error?: string }) => body.error ?? "Kling 操作失败" }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? children : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

const model: KlingVideoModelDescriptor = { selectionKey: '["kling-cli","image_to_video","account-model"]', provider: "kling-cli", profileId: "profile", region: "global", tool: "image_to_video", remoteModelId: "account-model", displayName: "Account Model", catalogRevision: "revision", available: true, parameters: [{ name: "duration", type: "number", required: true, allowedValues: [5, 10], default: 5 }, { name: "audio", type: "boolean", required: true, default: true }, { name: "aspect_ratio", type: "string", required: true, default: "16:9" }, { name: "motion", type: "number", required: false, allowedValues: [0.5, 1], default: 0.5 }], inputSlots: [{ name: "image", role: "image", required: true }], capabilities: { image: true, tailFrame: false, multiImage: false, audio: false } };
const plan: KlingFilmView = { runId: "film-1", projectId: "project", scriptId: "script", profileId: "profile", planHash: "frozen-plan", expiresAt: "2099-01-01T00:00:00Z", status: "draft", stage: "preview", model, output: { resolution: "720p", aspectRatio: "9:16", audioStrategy: "edge-tts", voice: "zh-CN-XiaoxiaoNeural", subtitles: true }, shots: [{ id: "shot-1", shotId: 1, status: "ready", source: "reuse", prompt: "Reused product shot", duration: 5, missingKeyframe: false, options: {}, assetId: "existing-video", videoUrl: "/api/files/existing.mp4", attempt: 0 }, { id: "shot-2", shotId: 2, status: "waiting", source: "generate", prompt: "Rotate product", duration: 5, generationDuration: 5, keyframeUrl: "/api/files/keyframe.jpg", missingKeyframe: false, options: { duration: 5 }, attempt: 0 }], totalShots: 2, readyShots: 1, billableShotCount: 1, missingKeyframes: [], warnings: [], allowedActions: [], createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z" };
let root: Root;
let container: HTMLDivElement;
let preview: KlingFilmView;
const fetchMock = vi.fn();
const onAssetsChanged = vi.fn();
const onOpenJob = vi.fn();
const onOpenChange = vi.fn();
const json = (value: unknown, status = 200) => Response.json(value, { status });
function button(part: string): HTMLButtonElement | undefined { return [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(part)); }
function deleteButton(runId: string) { return container.querySelector(`[aria-label="删除整片记录 ${runId}"]`) as HTMLButtonElement; }
function deleteRequests() { return api.request.mock.calls.filter(([, options]) => options?.method === "DELETE"); }
function mockFilmRecords(runs: KlingFilmView[], handleRequest?: (url: string, options?: RequestInit) => Promise<Response> | undefined) {
  const fallback = api.request.getMockImplementation()!;
  api.request.mockImplementation((url: string, options?: RequestInit) => {
    const handled = handleRequest?.(url, options);
    if (handled) return handled;
    if (url.includes("?projectId=")) return Promise.resolve(json({ runs }));
    const run = runs.find((item) => url === `/api/integrations/kling/films/${encodeURIComponent(item.runId)}`);
    return run ? Promise.resolve(json(run)) : fallback(url, options);
  });
}
async function click(part: string) { await act(async () => button(part)!.click()); }
async function mount(initialRunId = "film-1", open = true) {
  await act(async () => root.render(<KlingFilmPanel open={open} onOpenChange={onOpenChange} projectId="project" initialRunId={initialRunId} onAssetsChanged={onAssetsChanged} onOpenJob={onOpenJob} />));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", fetchMock);
  preview = structuredClone(plan); onAssetsChanged.mockReset(); onOpenJob.mockReset(); onOpenChange.mockReset(); fetchMock.mockReset();
  api.request.mockReset().mockImplementation(async (url: string) => {
    if (url.includes("?projectId=")) return json({ runs: [preview] });
    if (url.endsWith("/film-1")) return json(preview);
    throw new Error("Unexpected request: " + url);
  });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Kling historical full-film records", () => {
  it("renders nothing and makes no requests without an explicit historical run", async () => {
    await act(async () => root.render(<KlingFilmPanel open onOpenChange={onOpenChange} projectId="project" onAssetsChanged={onAssetsChanged} onOpenJob={onOpenJob} />));
    expect(container.textContent).toBe("");
    expect(api.request).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await mount("film-1", false);
    expect(api.request).not.toHaveBeenCalled();
  });

  it.each(["draft", "running", "paused", "needs_attention", "composing", "completed", "cancelled"] as const)("only queries the original %s record and exposes no generation controls", async (status) => {
    preview = { ...preview, status, allowedActions: ["resume", "retry-shot", "retry-compose", "cancel"], missingKeyframes: [2], shots: [{ ...preview.shots[1], allowedActions: ["retry-shot"] }] };
    delete preview.promptSettings;
    await mount();
    expect(container.querySelector("h2")?.textContent).toBe("Kling 历史整片记录");
    expect(container.textContent).toContain("Account Model");
    expect(container.textContent).toContain("整片生成已下线");
    expect(container.querySelector("input, select, textarea")).toBeNull();
    for (const name of ["新建整片计划", "预览整片计划", "确认生成整片", "补齐关键帧", "恢复", "重试", "提示词"]) expect(button(name)).toBeUndefined();
    expect(api.request.mock.calls.map(([url]) => url)).toEqual(["/api/integrations/kling/films?projectId=project", "/api/integrations/kling/films/film-1"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens an existing child job and preserves completed playback and download", async () => {
    preview = { ...preview, status: "completed", videoUrl: "/api/files/film.mp4", thumbnailUrl: "/api/files/thumb.jpg", shots: [{ ...preview.shots[0], jobId: "paid-original" }] };
    await mount();
    await click("查看镜头 1 原任务");
    expect(onOpenJob).toHaveBeenCalledExactlyOnceWith("paid-original");
    expect(container.querySelector("video")?.getAttribute("src")).toBe("/api/files/film.mp4");
    expect(container.querySelector("video")?.getAttribute("poster")).toBe("/api/files/thumb.jpg");
    expect(container.querySelector("a[download]")?.getAttribute("href")).toBe("/api/files/film.mp4");
    expect(container.querySelector('a[target="_blank"]')?.getAttribute("href")).toBe("/api/files/existing.mp4");
  });

  it.each(["pause", "cancel"] as const)("allows %s without dispatching further generation", async (action) => {
    preview = { ...preview, status: "running", allowedActions: ["pause", "cancel"] };
    mockFilmRecords([preview], (url, options) => options?.method === "POST" && url.endsWith("/" + action)
      ? Promise.resolve(json({ run: { ...preview, status: action === "pause" ? "paused" : "cancelled", allowedActions: ["delete"] } })) : undefined);
    await mount();
    await click(action === "pause" ? "暂停后续镜头" : "停止此整片计划");
    const mutations = api.request.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toEqual([`/api/integrations/kling/films/film-1/${action}`, { method: "POST", body: "{}" }]);
    expect(deleteButton("film-1").disabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes saved results and notifies the assets page", async () => {
    await mount();
    preview = { ...preview, status: "completed", videoUrl: "/api/files/new-film.mp4" };
    await click("查询原整片进度");
    expect(container.querySelector("video")?.getAttribute("src")).toBe("/api/files/new-film.mp4");
    expect(onAssetsChanged).toHaveBeenCalledTimes(1);
  });

  it("surfaces a missing record and allows another historical record to be opened", async () => {
    const other = { ...preview, runId: "other", status: "completed" as const, videoUrl: "/api/files/other.mp4" };
    mockFilmRecords([other], (url) => url.endsWith("/film-1") ? Promise.resolve(json({ error: "记录不存在" }, 404)) : undefined);
    await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("记录不存在");
    await click("Account Model");
    expect(container.querySelector("video")?.getAttribute("src")).toBe("/api/files/other.mp4");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks before deleting and allows cancellation without opening or deleting the record", async () => {
    preview.allowedActions = ["delete"];
    mockFilmRecords([preview]);
    await mount();
    const requestsBefore = api.request.mock.calls.length;
    await act(async () => deleteButton("film-1").click());
    expect(container.querySelector('[aria-label="删除整片记录确认"]')?.textContent).toContain("删除后无法恢复此整片计划记录。已生成的镜头素材和成片视频会保留。");
    expect(api.request.mock.calls).toHaveLength(requestsBefore);
    expect(container.querySelector("button button")).toBeNull();
    await click("取消删除");
    expect(container.querySelector('[aria-label="删除整片记录确认"]')).toBeNull();
    expect(deleteButton("film-1")).not.toBeNull();
    expect(container.querySelector('[aria-label="历史整片详情"]')).not.toBeNull();
    expect(deleteRequests()).toHaveLength(0);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("deletes the originally opened record, closes history and refreshes the task feed", async () => {
    preview.allowedActions = ["delete"];
    const taskFeedChanged = vi.fn();
    window.addEventListener("clipforge:task-feed-refresh", taskFeedChanged);
    try {
      mockFilmRecords([preview], (_url, options) => options?.method === "DELETE" ? Promise.resolve(json({ deleted: true })) : undefined);
      await mount();
      await act(async () => deleteButton("film-1").click());
      await click("确认删除记录");
      expect(deleteRequests()).toHaveLength(1);
      expect(deleteRequests()[0][0]).toBe("/api/integrations/kling/films/film-1");
      expect(deleteButton("film-1")).toBeNull();
      expect(container.querySelector('[aria-label="历史整片详情"]')).toBeNull();
      expect(button("预览整片计划")).toBeUndefined();
      expect(taskFeedChanged).toHaveBeenCalledTimes(1);
      expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    } finally { window.removeEventListener("clipforge:task-feed-refresh", taskFeedChanged); }
  });

  it("deletes another record with an encoded id while preserving the open plan and playback", async () => {
    const current: KlingFilmView = { ...preview, status: "completed", videoUrl: "/api/files/keep.mp4", allowedActions: ["delete"] };
    const other: KlingFilmView = { ...preview, runId: "film/other", allowedActions: ["delete"] };
    mockFilmRecords([current, other], (_url, options) => options?.method === "DELETE" ? Promise.resolve(json({ deleted: true })) : undefined);
    await mount("film-1");
    const readsBefore = api.request.mock.calls.filter(([url, options]) => url.includes("/films/") && !options?.method).length;
    await act(async () => deleteButton(other.runId).click());
    await click("确认删除记录");
    expect(deleteRequests()).toHaveLength(1);
    expect(deleteRequests()[0][0]).toBe("/api/integrations/kling/films/film%2Fother");
    expect(api.request.mock.calls.filter(([url, options]) => url.includes("/films/") && !options?.method)).toHaveLength(readsBefore);
    expect(deleteButton(other.runId)).toBeNull();
    expect(deleteButton(current.runId)).not.toBeNull();
    expect(container.querySelector("video")?.getAttribute("src")).toBe("/api/files/keep.mp4");
    expect(container.querySelector('[aria-label="历史整片详情"]')).not.toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it.each(["current", "other"] as const)("preserves the %s record and open plan on deletion failure, then allows retry", async (target) => {
    const current: KlingFilmView = { ...preview, status: "completed", videoUrl: "/api/files/keep.mp4", allowedActions: ["delete"] };
    const other: KlingFilmView = { ...preview, runId: "film-other", allowedActions: ["delete"] };
    let attempts = 0;
    mockFilmRecords([current, other], (_url, options) => options?.method === "DELETE"
      ? Promise.resolve(++attempts === 1 ? json({ error: "删除记录失败，请重试" }, 500) : json({ deleted: true })) : undefined);
    await mount("film-1");
    const targetRunId = target === "current" ? current.runId : other.runId;
    await act(async () => deleteButton(targetRunId).click());
    await click("确认删除记录");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("删除记录失败，请重试");
    expect(deleteButton(targetRunId)).not.toBeNull();
    expect(container.querySelector("video")?.getAttribute("src")).toBe("/api/files/keep.mp4");
    expect(container.querySelector('[aria-label="历史整片详情"]')).not.toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    if (!button("确认删除记录")) await act(async () => deleteButton(targetRunId).click());
    await click("确认删除记录");
    expect(deleteRequests()).toHaveLength(2);
    expect(deleteButton(targetRunId)).toBeNull();
    expect(Boolean(container.querySelector('[aria-label="历史整片详情"]'))).toBe(target === "other");
    if (target === "current") expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    else expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("submits one deletion on a double click and disables repeated actions until it finishes", async () => {
    preview.allowedActions = ["delete"];
    let finishDelete!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finishDelete = resolve; });
    mockFilmRecords([preview], (_url, options) => options?.method === "DELETE" ? pending : undefined);
    await mount();
    await act(async () => deleteButton("film-1").click());
    const confirm = button("确认删除记录")!;
    await act(async () => { confirm.click(); confirm.click(); });
    expect(deleteRequests()).toHaveLength(1);
    expect(button("正在删除")!.disabled).toBe(true);
    expect(deleteButton("film-1").disabled).toBe(true);
    expect(button("取消删除")!.disabled).toBe(true);
    await act(async () => finishDelete(json({ deleted: true })));
    expect(deleteButton("film-1")).toBeNull();
  });

  it.each(["running", "paused", "needs_attention", "composing"] as const)("requires stopping a %s plan before deleting its record", async (status) => {
    mockFilmRecords([{ ...preview, status, allowedActions: ["cancel"] }]);
    await mount();
    const remove = deleteButton("film-1");
    expect(remove.disabled).toBe(true);
    expect(remove.title).toContain("停止");
    await act(async () => remove.click());
    expect(container.querySelector('[aria-label="删除整片记录确认"]')).toBeNull();
    expect(deleteRequests()).toHaveLength(0);
  });

  it.each(["detail", "list"] as const)("does not resurrect a deleted plan when an earlier %s request returns", async (source) => {
    preview = { ...preview, status: "completed", allowedActions: ["delete"] };
    let finishRead!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finishRead = resolve; });
    let delayRead = false;
    mockFilmRecords([preview], (url, options) => {
      if (options?.method === "DELETE") return Promise.resolve(json({ deleted: true }));
      const matches = source === "detail" ? url.endsWith("/film-1") : url.includes("?projectId=");
      return delayRead && matches ? pending : undefined;
    });
    await mount("film-1");
    delayRead = true;
    await click(source === "detail" ? "查询原整片进度" : "刷新记录");
    await act(async () => deleteButton("film-1").click());
    await click("确认删除记录");
    expect(deleteButton("film-1")).toBeNull();
    expect(container.querySelector('[aria-label="历史整片详情"]')).toBeNull();
    await act(async () => finishRead(json(source === "detail" ? preview : { runs: [preview] })));
    expect(deleteButton("film-1")).toBeNull();
    expect(container.querySelector('[aria-label="历史整片详情"]')).toBeNull();
    expect(button("预览整片计划")).toBeUndefined();
  });
});
