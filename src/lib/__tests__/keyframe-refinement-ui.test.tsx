import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyframeRefinementDialog, type KeyframeRefinementDialogProps } from "@/components/keyframe-refinement-dialog";
import type { KeyframeRefinementCandidate } from "@/lib/keyframe-refinement";

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
const fetchMock = vi.fn();
const onApplied = vi.fn(), onOpenChange = vi.fn(), onBusyChange = vi.fn();
const json = (body: unknown, status = 200) => Response.json(body, { status });
const defaults: KeyframeRefinementDialogProps = { open: true, onOpenChange, projectId: "project", scriptId: "script", shots, modelTarget: { provider: "atlas-cloud", model: "openai/gpt-image-2", apiKey: "fixture-key" }, onApplied, onBusyChange };
function buttons(text: string) { return [...container.querySelectorAll<HTMLButtonElement>("button")].filter((item) => item.textContent?.includes(text)); }
function button(text: string) { const value = buttons(text)[0]; if (!value) throw new Error(`Missing button: ${text}`); return value; }
function checkbox(name: string) { return container.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!; }
async function click(text: string) { await act(async () => button(text).click()); }
async function mount(props: Partial<KeyframeRefinementDialogProps> = {}) { await act(async () => root.render(<KeyframeRefinementDialog {...defaults} {...props} />)); }
function calls(method: string) { return fetchMock.mock.calls.filter(([, init]) => (init?.method ?? "GET") === method); }
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
  onApplied.mockReset().mockResolvedValue(undefined); onOpenChange.mockReset(); onBusyChange.mockReset();
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (!init?.method) return json({ candidates: saved[Number(new URL(url, "http://local").searchParams.get("shotId"))] ?? [] });
    const body = JSON.parse(String(init.body));
    if (init.method === "POST") {
      const asset = refined(body.shotId); saved[body.shotId].push(asset);
      return json({ asset, resolution: { requested: body.resolution, width: 1024, height: 1824, limited: true } });
    }
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
    expect(JSON.parse(calls("POST")[0][1].body)).toMatchObject({ scriptId: "script", shotId: 1, sourceAssetId: "crop-1", provider: "atlas-cloud", model: "openai/gpt-image-2/edit", resolution: "4k", instructions: "去掉身后的第二把椅子", issues: ["hands", "anatomy", "duplicates", "product"] });
    expect(calls("PATCH")).toHaveLength(0);
    expect(container.querySelector('img[alt="分镜 1 原图"]')?.getAttribute("src")).toBe("/api/files/crop-1.png");
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

  it("recovers a saved image after a lost response without retrying the paid request", async () => {
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      if (init?.method === "POST") { saved[1].push(refined(1)); throw new TypeError("Failed to fetch"); }
      return normal(url, init);
    });
    await mount(); await click("生成高清候选");
    expect(calls("POST")).toHaveLength(1);
    expect(button("生成高清候选").disabled).toBe(true);
    expect(container.textContent).toContain("剩余分镜尚未提交");
    expect(container.textContent).toContain("先刷新已保存候选并核对结果");
    await click("刷新已保存候选");
    expect(container.querySelector('img[alt="分镜 1 精修候选"]')?.getAttribute("src")).toBe("/api/files/refined-1.png");
    expect(calls("POST")).toHaveLength(1);
    expect(calls("PATCH")).toHaveLength(0);
  });

  it("stops the batch for a possibly charged 409 and keeps the original and saved candidates available", async () => {
    saved[1].push(refined(1));
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) => init?.method === "POST" ? Promise.resolve(json({ error: "生成期间脚本已改变", possiblyCharged: true, taskId: "provider-task-42" }, 409)) : normal(url, init));
    await mount(); await click("生成高清候选");
    expect(calls("POST")).toHaveLength(1);
    expect(calls("PATCH")).toHaveLength(0);
    expect(button("生成高清候选").disabled).toBe(true);
    expect(button("我已核对候选").disabled).toBe(true);
    expect(container.textContent).toContain("剩余分镜尚未提交");
    expect(container.textContent).toContain("先刷新已保存候选并核对结果");
    expect(container.textContent).toContain("任务 ID: provider-task-42");
    expect(container.querySelector('img[alt="分镜 1 原图"]')?.getAttribute("src")).toBe("/api/files/crop-1.png");
    expect(container.querySelector('img[alt="分镜 1 精修候选"]')?.getAttribute("src")).toBe("/api/files/refined-1.png");
    await click("刷新已保存候选");
    expect(button("我已核对候选").disabled).toBe(false);
    expect(calls("POST")).toHaveLength(1);
    await click("采用为关键帧");
    expect(JSON.parse(calls("PATCH")[0][1].body)).toEqual({ assetId: "refined-1" });
  });

  it("submits selected shots serially, locks closing and stops old work when source context changes", async () => {
    let finish!: (value: Response) => void;
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) => init?.method === "POST" ? new Promise<Response>((resolve) => { finish = resolve; }) : normal(url, init));
    await mount();
    await act(async () => { button("生成高清候选").click(); });
    expect(calls("POST")).toHaveLength(1);
    expect(container.querySelector("fieldset")?.disabled).toBe(true);
    await act(async () => dialog.close!(false));
    expect(onOpenChange).not.toHaveBeenCalled();
    const newShots = [{ ...shots[0], assetId: "new-crop", imageUrl: "/api/files/new-crop.png" }, shots[1]];
    await mount({ scriptId: "new-script", shots: newShots });
    await act(async () => finish(json({ asset: refined(1) })));
    expect(calls("POST")).toHaveLength(1);
    expect(calls("PATCH")).toHaveLength(0);
    expect(container.querySelector('img[alt="分镜 1 精修候选"]')).toBeNull();
    expect(container.querySelector('img[alt="分镜 1 原图"]')?.getAttribute("src")).toBe("/api/files/new-crop.png");
  });

  it("does not generate until history loads successfully and retry only loads history", async () => {
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) => !init?.method ? Promise.resolve(json({ error: "历史读取暂不可用" }, 503)) : normal(url, init));
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
