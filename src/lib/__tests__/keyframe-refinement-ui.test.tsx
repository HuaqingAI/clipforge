import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyframeRefinementDialog, type KeyframeRefinementDialogProps } from "@/components/keyframe-refinement-dialog";
import type { KeyframeRefinementCandidate } from "@/lib/keyframe-refinement";
import { GENERATION_RUNS_REFRESH_EVENT, type GenerationRun, type GenerationRunInput } from "@/lib/hooks/use-generation-runs";

const dialog = vi.hoisted(() => ({ close: undefined as undefined | ((open: boolean) => void) }));
vi.mock("@/lib/i18n", () => ({ useLocale: () => "zh", useT: () => (key: string) => key }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children, onOpenChange }: { open: boolean; children: ReactNode; onOpenChange(open: boolean): void }) => {
    if (!open) return null;
    dialog.close = onOpenChange;
    return children;
  },
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

const shots = [
  { assetId: "crop-1", shotId: 1, imageUrl: "/api/files/crop-1.png", description: "坐在唯一的一把椅子上" },
  { assetId: "crop-2", shotId: 2, imageUrl: "/api/files/crop-2.png", description: "右手自然放在扶手上" },
];
function source(shotId: number): KeyframeRefinementCandidate {
  return { id: `crop-${shotId}`, shotId, filePath: `/api/files/crop-${shotId}.png`, selected: true, derivedFromAssetId: "grid-asset", sourceKeyframeUrl: "/api/files/grid.png", prompt: "[storyboard-grid-v1] crop" };
}
function refined(shotId: number): KeyframeRefinementCandidate {
  return { id: `refined-${shotId}`, shotId, filePath: `/api/files/refined-${shotId}.png`, selected: false, derivedFromAssetId: `crop-${shotId}`, sourceKeyframeUrl: `/api/files/crop-${shotId}.png`, prompt: "[keyframe-refine-v1] Repair", model: "openai/gpt-image-2/edit" };
}

let root: Root, container: HTMLDivElement;
let saved: Record<number, KeyframeRefinementCandidate[]>;
let runs: GenerationRun[];
let registered: Map<string, GenerationRun>;
const fetchMock = vi.fn();
const onApplied = vi.fn(), onOpenChange = vi.fn(), onBusyChange = vi.fn();
const json = (body: unknown, status = 200) => Response.json(body, { status });
const defaults: KeyframeRefinementDialogProps = { open: true, onOpenChange, projectId: "project", scriptId: "script", shots, modelTarget: { provider: "atlas-cloud", model: "openai/gpt-image-2", apiKey: "fixture-key" }, onApplied, onBusyChange };
function buttons(text: string) { return [...container.querySelectorAll<HTMLButtonElement>("button")].filter((item) => item.textContent?.includes(text)); }
function button(text: string) { const value = buttons(text)[0]; if (!value) throw new Error(`Missing button: ${text}`); return value; }
function checkbox(name: string) { return container.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!; }
async function click(text: string) { await act(async () => button(text).click()); }
async function mount(props: Partial<KeyframeRefinementDialogProps> = {}) { await act(async () => root.render(<KeyframeRefinementDialog {...defaults} {...props} />)); }
function calls(method: string) { return fetchMock.mock.calls.filter(([url, init]) => (init?.method ?? "GET") === method && (method !== "GET" || url.includes("/keyframe-refine?"))); }
function register(input: GenerationRunInput): GenerationRun {
  const existing = registered.get(input.clientRequestId);
  if (existing) return existing;
  const run: GenerationRun = { id: `run-${registered.size + 1}`, projectId: input.projectId, kind: input.kind, label: input.label, status: "queued", total: input.items.length, done: 0, failed: 0,
    items: input.items.map((item, index) => ({ id: `item-${registered.size + 1}-${index}`, kind: item.kind, scriptId: item.scriptId, shotId: item.shotId, status: "queued" })) };
  registered.set(input.clientRequestId, run); runs.unshift(run); return run;
}
async function refreshTasks() { await act(async () => window.dispatchEvent(new Event(GENERATION_RUNS_REFRESH_EVENT))); }
async function complete(runId: string) {
  runs = runs.map((run) => run.id !== runId ? run : { ...run, status: "completed", done: run.total, items: run.items.map((item) => {
    const asset = refined(item.shotId!); saved[item.shotId!].push(asset);
    return { ...item, status: "completed", result: { asset, resolution: { requested: "4k", width: 1024, height: 1824, limited: true } } };
  }) });
  await refreshTasks();
}
async function notes(value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="补充修复说明"]')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  saved = { 1: [source(1)], 2: [source(2)] };
  runs = []; registered = new Map();
  onApplied.mockReset().mockResolvedValue(undefined); onOpenChange.mockReset(); onBusyChange.mockReset();
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/generation-runs?")) return json({ runs: runs.filter((run) => run.projectId === new URL(url, "http://local").searchParams.get("projectId")) });
    if (!init?.method) return json({ candidates: saved[Number(new URL(url, "http://local").searchParams.get("shotId"))] ?? [] });
    const body = JSON.parse(String(init.body));
    if (init.method === "POST" && url === "/api/generation-runs") return json(register(body), 202);
    if (init.method === "PATCH") {
      for (const candidates of Object.values(saved)) if (candidates.some((item) => item.id === body.assetId)) for (const item of candidates) item.selected = item.id === body.assetId;
      return json({ ok: true });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("keyframe refinement review and adoption", () => {
  it("opens a single shot without starting generation and displays the actual editing model and cost", async () => {
    await mount({ initialShotId: 2 });
    expect(checkbox("分镜 1").checked).toBe(false);
    expect(checkbox("分镜 2").checked).toBe(true);
    expect(container.textContent).toContain("atlas-cloud / openai/gpt-image-2/edit");
    expect(container.textContent).toContain("每个所选分镜会新增一次图片生成费用");
    expect(calls("GET")).toHaveLength(2);
    expect(calls("POST")).toHaveLength(0);
    expect(calls("PATCH")).toHaveLength(0);
    await click("全选"); expect(checkbox("分镜 1").checked).toBe(true);
    await click("取消全选"); expect(button("生成高清候选").disabled).toBe(true);
  });

  it("sends the crop id and repair options, preserves the original, and only applies or restores on explicit action", async () => {
    await mount({ initialShotId: 1 });
    await notes("去掉身后的第二把椅子");
    await act(async () => { const select = container.querySelector<HTMLSelectElement>('select[aria-label="目标清晰度"]')!; select.value = "4k"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await click("生成高清候选");
    expect(calls("POST")).toHaveLength(1);
    expect(calls("POST")[0][0]).toBe("/api/generation-runs");
    expect(JSON.parse(calls("POST")[0][1].body)).toMatchObject({ projectId: "project", kind: "keyframe_refine", items: [{ kind: "keyframe_refine", scriptId: "script", shotId: 1, request: { scriptId: "script", shotId: 1, sourceAssetId: "crop-1", sourceImageUrl: "/api/files/crop-1.png", provider: "atlas-cloud", model: "openai/gpt-image-2/edit", resolution: "4k", instructions: "去掉身后的第二把椅子", issues: ["hands", "anatomy", "duplicates", "product"] } }] });
    expect(calls("PATCH")).toHaveLength(0);
    expect(container.querySelector('img[alt="分镜 1 原图"]')?.getAttribute("src")).toBe("/api/files/crop-1.png");
    expect(container.querySelector('img[alt="分镜 1 精修候选"]')).toBeNull();
    expect(container.textContent).toContain("已进入后台任务");
    expect(onBusyChange.mock.calls.at(-1)).toEqual([false]);
    await complete("run-1");
    expect(container.querySelector('img[alt="分镜 1 精修候选"]')?.getAttribute("src")).toBe("/api/files/refined-1.png");
    expect(container.textContent).toContain("实际输出低于所选清晰度目标");
    expect(container.textContent).toContain("1024 × 1824");
    await click("采用为关键帧");
    expect(JSON.parse(calls("PATCH")[0][1].body)).toEqual({ assetId: "refined-1" });
    expect(onApplied).toHaveBeenCalledTimes(1);
    await click("恢复原图为关键帧");
    expect(JSON.parse(calls("PATCH")[1][1].body)).toEqual({ assetId: "crop-1" });
    expect(onApplied).toHaveBeenCalledTimes(2);
  });

  it("keeps source and earlier candidates available after failure and restores history on reopen", async () => {
    saved[1].push(refined(1));
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) => init?.method === "POST" ? Promise.resolve(json({ error: "平台余额不足" }, 422)) : normal(url, init));
    await mount({ initialShotId: 1 }); await click("生成高清候选");
    expect(container.textContent).toContain("平台余额不足");
    expect(container.querySelector('img[alt="分镜 1 原图"]')?.getAttribute("src")).toBe("/api/files/crop-1.png");
    expect(calls("PATCH")).toHaveLength(0);
    await mount({ open: false }); await mount({ initialShotId: 1 });
    expect(container.querySelector('img[alt="分镜 1 精修候选"]')?.getAttribute("src")).toBe("/api/files/refined-1.png");
    expect(calls("POST")).toHaveLength(1);
    expect(button("采用为关键帧").disabled).toBe(false);
  });

  it("queues the entire batch atomically and retries a lost acknowledgement with the identical frozen request", async () => {
    const normal = fetchMock.getMockImplementation()!;
    let loseResponse = true;
    fetchMock.mockImplementation(async (url, init) => {
      if (init?.method === "POST" && loseResponse) { loseResponse = false; register(JSON.parse(init.body)); throw new TypeError("Failed to fetch"); }
      return normal(url, init);
    });
    await mount(); await notes("保留服装和构图"); await click("生成高清候选");
    expect(calls("POST")).toHaveLength(1);
    const original = calls("POST")[0][1].body;
    expect(JSON.parse(original)).toMatchObject({ kind: "keyframe_refine_batch", items: [{ shotId: 1 }, { shotId: 2 }] });
    expect(container.querySelector("fieldset")?.disabled).toBe(true);
    expect(container.textContent).toContain("本批次分镜和参数已锁定");
    await mount({ modelTarget: { provider: "openai", model: "dall-e-3", apiKey: "new-key" } });
    await click("重试核对本批次");
    expect(calls("POST")).toHaveLength(2);
    expect(calls("POST")[1][1].body).toBe(original);
    expect(runs).toHaveLength(1);
    expect(container.textContent).toContain("已进入后台任务");
    expect(calls("PATCH")).toHaveLength(0);
  });

  it("restores active and uncertain task status, blocks duplicate shots and keeps candidates adoptable", async () => {
    saved[1].push(refined(1));
    runs = [{ id: "uncertain", projectId: "project", kind: "keyframe_refine_batch", status: "needs_attention", done: 0, total: 2, failed: 1, items: [{ id: "one", kind: "keyframe_refine", scriptId: "script", shotId: 1, status: "needs_attention", error: "平台提交结果待核对" }, { id: "two", kind: "keyframe_refine", scriptId: "script", shotId: 2, status: "waiting" }] }];
    await mount();
    expect(calls("POST")).toHaveLength(0);
    expect(calls("PATCH")).toHaveLength(0);
    expect(button("生成高清候选").disabled).toBe(true);
    expect(checkbox("分镜 1").disabled).toBe(true);
    expect(checkbox("分镜 2").disabled).toBe(true);
    expect(container.textContent).toContain("平台提交结果待核对");
    expect(container.textContent).toContain("等待平台");
    expect(container.querySelector('a[href="/project/project/assets?runId=uncertain"]')).not.toBeNull();
    expect(container.querySelector('img[alt="分镜 1 原图"]')?.getAttribute("src")).toBe("/api/files/crop-1.png");
    expect(container.querySelector('img[alt="分镜 1 精修候选"]')?.getAttribute("src")).toBe("/api/files/refined-1.png");
    await click("采用为关键帧");
    expect(JSON.parse(calls("PATCH")[0][1].body)).toEqual({ assetId: "refined-1" });
  });

  it("only locks closing during registration and ignores its late response after switching project", async () => {
    let finish!: (value: Response) => void;
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) => {
      if (init?.method === "POST") {
        const run = register(JSON.parse(init.body));
        return new Promise<Response>((resolve) => { finish = () => resolve(json(run, 202)); });
      }
      return normal(url, init);
    });
    await mount();
    await act(async () => { button("生成高清候选").click(); });
    expect(calls("POST")).toHaveLength(1);
    expect(container.querySelector("fieldset")?.disabled).toBe(true);
    await act(async () => dialog.close!(false));
    expect(onOpenChange).not.toHaveBeenCalled();
    const newShots = [{ ...shots[0], assetId: "new-crop", imageUrl: "/api/files/new-crop.png" }, shots[1]];
    await mount({ projectId: "B", scriptId: "new-script", shots: newShots });
    await act(async () => finish(json({})));
    expect(calls("POST")).toHaveLength(1);
    expect(calls("PATCH")).toHaveLength(0);
    expect(container.querySelector('img[alt="分镜 1 精修候选"]')).toBeNull();
    expect(container.querySelector('img[alt="分镜 1 原图"]')?.getAttribute("src")).toBe("/api/files/new-crop.png");
    expect(container.textContent).not.toContain("排队中");
    await mount();
    expect(checkbox("分镜 1").disabled).toBe(true);
    expect(checkbox("分镜 2").disabled).toBe(true);
    expect(container.textContent).toContain("排队中");
    await act(async () => dialog.close!(false));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(calls("POST")).toHaveLength(1);
  });

  it("does not generate until history loads successfully and retry only loads history", async () => {
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) => url.includes("/keyframe-refine?") ? Promise.resolve(json({ error: "历史读取暂不可用" }, 503)) : normal(url, init));
    await mount({ initialShotId: 1 });
    expect(button("生成高清候选").disabled).toBe(true);
    expect(container.textContent).toContain("历史读取暂不可用");
    fetchMock.mockImplementation(normal);
    await click("刷新已保存候选");
    expect(button("生成高清候选").disabled).toBe(false);
    expect(calls("POST")).toHaveLength(0);
  });

  it("shows the selected history failure beside Generate and retries only failed selected reads", async () => {
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) => !init?.method && new URL(url, "http://local").searchParams.get("shotId") === "1"
      ? Promise.resolve(json({ error: "脚本与当前创作设置不一致，请刷新或重新生成脚本", code: "CREATIVE_CONFIG_STALE" }, 409))
      : normal(url, init));
    await mount();
    const generatePanel = button("生成高清候选").parentElement!;
    expect(button("生成高清候选").disabled).toBe(true);
    expect(generatePanel.textContent).toContain("分镜 01：脚本与当前创作设置不一致");
    expect(calls("GET")).toHaveLength(2);
    fetchMock.mockImplementation(normal);
    await click("重试读取候选");
    expect(calls("GET")).toHaveLength(3);
    expect(new URL(calls("GET")[2][0], "http://local").searchParams.get("shotId")).toBe("1");
    expect(button("生成高清候选").disabled).toBe(false);
    expect(buttons("重试读取候选")).toHaveLength(0);
    expect(calls("POST")).toHaveLength(0);
    expect(calls("PATCH")).toHaveLength(0);
  });

  it("does not block selected shots or offer their retry action for an unselected history failure", async () => {
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) => !init?.method && new URL(url, "http://local").searchParams.get("shotId") === "1"
      ? Promise.resolve(json({ error: "历史读取暂不可用" }, 503))
      : normal(url, init));
    await mount({ initialShotId: 2 });
    expect(button("生成高清候选").disabled).toBe(false);
    expect(button("生成高清候选").parentElement!.textContent).not.toContain("历史读取暂不可用");
    expect(buttons("重试读取候选")).toHaveLength(0);
    expect(calls("POST")).toHaveLength(0);
  });

  it("keeps A and B batches independent and restores completed candidates when reopening A", async () => {
    await mount(); await click("生成高清候选");
    await click("完成");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await mount({ open: false });
    await mount({ projectId: "B", scriptId: "B-script", initialShotId: 2 });
    expect(checkbox("分镜 2").disabled).toBe(false);
    await click("生成高清候选");
    expect(runs.map((run) => [run.projectId, run.total])).toEqual([["B", 1], ["project", 2]]);
    expect(JSON.parse(calls("POST")[1][1].body)).toMatchObject({ projectId: "B", kind: "keyframe_refine", items: [{ scriptId: "B-script", shotId: 2 }] });
    await complete("run-1");
    await mount();
    expect(container.querySelector('img[alt="分镜 1 精修候选"]')?.getAttribute("src")).toBe("/api/files/refined-1.png");
    expect(container.querySelector('img[alt="分镜 2 精修候选"]')?.getAttribute("src")).toBe("/api/files/refined-2.png");
    expect(container.textContent).toContain("精修完成，候选已保存");
    const reads = calls("GET").length;
    await refreshTasks();
    expect(calls("GET")).toHaveLength(reads);
    expect(calls("POST")).toHaveLength(2);
    expect(calls("PATCH")).toHaveLength(0);
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("blocks new submissions until the project task list can be checked", async () => {
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) => url.startsWith("/api/generation-runs?") ? Promise.resolve(json({ error: "后台任务暂不可用" }, 503)) : normal(url, init));
    await mount();
    expect(button("生成高清候选").disabled).toBe(true);
    expect(container.textContent).toContain("后台任务暂不可用");
    fetchMock.mockImplementation(normal);
    await click("刷新后台任务");
    expect(button("生成高清候选").disabled).toBe(false);
    expect(calls("POST")).toHaveLength(0);
  });

  it("isolates historical script tasks and allows a fresh request after a definite failure", async () => {
    runs = [{ id: "old", projectId: "project", kind: "keyframe_refine", status: "running", done: 0, total: 1, failed: 0, items: [{ id: "old-shot", kind: "keyframe_refine", scriptId: "old-script", shotId: 1, status: "running" }] },
      { id: "failed", projectId: "project", kind: "keyframe_refine", status: "failed", done: 0, total: 1, failed: 1, items: [{ id: "failed-shot", kind: "keyframe_refine", scriptId: "script", shotId: 2, status: "failed", error: "平台明确拒绝" }] }];
    await mount();
    expect(checkbox("分镜 1").disabled).toBe(false);
    expect(checkbox("分镜 2").disabled).toBe(false);
    expect(container.textContent).toContain("平台明确拒绝");
    expect(container.textContent).not.toContain("正在精修");
    expect(button("生成高清候选").disabled).toBe(false);
    await click("生成高清候选");
    expect(JSON.parse(calls("POST")[0][1].body).items.map((item: { shotId: number }) => item.shotId)).toEqual([1, 2]);
  });

  it("requires a usable source, an image edit model, and at least one repair request", async () => {
    await mount({ shots: [{ ...shots[0], assetId: "", imageUrl: "" }] });
    expect(checkbox("分镜 1").disabled).toBe(true);
    expect(button("生成高清候选").disabled).toBe(true);
    await mount({ modelTarget: { provider: "openai", model: "dall-e-3", apiKey: "fixture-key" } });
    expect(button("生成高清候选").disabled).toBe(true);
    expect(container.textContent).toContain("当前模型不支持图片精修");
    await mount();
    await act(async () => { for (const input of container.querySelectorAll<HTMLInputElement>('fieldset input[type="checkbox"]:not([aria-label])')) if (input.checked) input.click(); });
    expect(button("生成高清候选").disabled).toBe(true);
    await notes("只修复右手");
    expect(button("生成高清候选").disabled).toBe(false);
    expect(calls("POST")).toHaveLength(0);
  });

  it("traces an adopted refined image back to the storyboard crop for rollback", async () => {
    saved[1] = [{ ...source(1), selected: false }, { ...refined(1), selected: true }];
    await mount({ initialShotId: 1, shots: [{ ...shots[0], assetId: "refined-1", imageUrl: "/api/files/refined-1.png" }] });
    expect(container.querySelector('img[alt="分镜 1 原图"]')?.getAttribute("src")).toBe("/api/files/crop-1.png");
    expect(button("恢复原图为关键帧").disabled).toBe(false);
    expect(button("采用为关键帧").disabled).toBe(true);
    await click("恢复原图为关键帧");
    expect(JSON.parse(calls("PATCH")[0][1].body)).toEqual({ assetId: "crop-1" });
  });
});
