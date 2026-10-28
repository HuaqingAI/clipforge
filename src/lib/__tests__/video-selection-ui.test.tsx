import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import VideoPage from "@/app/project/[id]/video/page";
import { buildShotAssetSelections, type ShotVideoAsset } from "@/components/shot-video-picker";
import { useSettingsStore } from "@/lib/stores/settings-store";

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "project" }) }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: ComponentProps<"a">) => <a {...props}>{children}</a> }));
vi.mock("@/components/project-header", () => ({ ProjectHeader: () => null }));
vi.mock("@/components/free-voice-preview", () => ({ FreeVoicePreview: () => null }));
vi.mock("@/lib/kling/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/kling/client")>(),
  klingFetch: (url: string, init?: RequestInit) => fetch(url, init),
}));
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
}));

const initialSettings = useSettingsStore.getState();
const shots = [
  { shotId: 1, type: "hook", duration: 5, description: "First shot", voiceover: "第一镜台词", visualSource: "ai_generate", transition: "direct_concat" },
  { shotId: 2, type: "demo", duration: 5, description: "Second shot", voiceover: "第二镜台词", visualSource: "ai_generate", transition: "direct_concat" },
];
const asset = (id: string, shotId: number, selected: boolean, createdAt: number, extension = "mp4"): ShotVideoAsset => ({ id, shotId, selected, createdAt, filePath: `/api/files/project/${id}.${extension}`, status: "done", model: "kling3.0" });
let rows: ShotVideoAsset[];
let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  useSettingsStore.setState({ locale: "zh", providers: {}, defaultResolution: "720p", defaultAspectRatio: "9:16" });
  localStorage.clear();
  rows = [asset("new-one", 1, false, 2000), asset("old-one", 1, true, 1000), asset("new-two", 2, false, 2000), asset("old-two", 2, true, 1000)];
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/project/project") return Response.json({ name: "Product", productCategory: "home" });
    if (url.endsWith("/scripts")) return Response.json([{ id: "script", selected: true, shots }]);
    if (url.split("?")[0].endsWith("/assets")) {
      if (init?.method === "PATCH") {
        const { assetId } = JSON.parse(init.body as string);
        const target = rows.find((row) => row.id === assetId)!;
        rows = rows.map((row) => row.shotId === target.shotId ? { ...row, selected: row.id === assetId } : row);
        return Response.json({ ...target, selected: true });
      }
      return Response.json(rows);
    }
    if (url.endsWith("/compose") && init?.method === "POST") return Response.json({ compositionId: "composition" });
    if (url.includes("/compose?")) return Response.json({ composition: { status: "done", url: "/api/output/project/result.mp4" } });
    throw new Error("Unexpected request " + url);
  });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useSettingsStore.setState(initialSettings);
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

async function mount() { await act(async () => root.render(<VideoPage />)); }
function button(text: string) { return Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.includes(text))!; }
async function click(item: HTMLButtonElement) { await act(async () => item.click()); }
async function expand(shotId: number) {
  const toggles = container.querySelectorAll<HTMLButtonElement>('button[aria-controls^="shot-video-versions-"]');
  await click(toggles[shotId - 1]);
}
function useVersion(shotId: number, version: number, kind = "视频") {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="选用镜头 ${shotId} 的${kind}版本 ${version}"]`)!;
}
function composeRequests() { return fetchMock.mock.calls.filter(([url, init]) => url.endsWith("/compose") && init?.method === "POST"); }
function currentThumbnail(path: string) { return container.querySelector(`video:not([controls])[src="${path}"], img[alt=""][src="${path}"]`); }
function transitionSelects() { return [...container.querySelectorAll("select")].filter((item) => item.querySelector('option[value="direct_concat"]')); }
function transitionSelect(index = 0) { return transitionSelects()[index]!; }
async function setTransition(value: "direct_concat" | "ffmpeg_fade", index = 0) {
  await act(async () => { const select = transitionSelect(index); select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
}
function useInitialTransition(transition: "direct_concat" | "ffmpeg_fade") {
  const normalFetch = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((url: string, init?: RequestInit) => url.endsWith("/scripts")
    ? Promise.resolve(Response.json([{ id: "script", selected: true, shots: shots.map((shot) => shot.shotId === 2 ? { ...shot, transition } : shot) }]))
    : normalFetch(url, init));
}

describe("compose-page shot video versions", () => {
  it("retains edited-shot video history and explicitly adopts the server's new binding for composition", async () => {
    vi.useFakeTimers();
    rows = [asset("current-one", 1, true, 1000), {
      ...asset("historical-two", 2, true, 1000),
      matchesCurrentScript: false, previouslySelected: true,
      klingJobId: "original-job", klingOutputId: "original-output",
    }];
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/integrations/kling/jobs/original-job/outputs/original-output/select") {
        expect(JSON.parse(init!.body as string)).toEqual({ adoptCurrentContext: true });
        rows = [rows[0], { ...asset("derived-two", 2, true, 2000), filePath: rows[1].filePath, matchesCurrentScript: true }];
        return Response.json({ job: { jobId: "original-job" } });
      }
      return normalFetch(url, init);
    });
    await mount();
    expect(currentThumbnail("/api/files/project/current-one.mp4")).not.toBeNull();
    expect(currentThumbnail("/api/files/project/historical-two.mp4")).toBeNull();
    expect(buildShotAssetSelections(shots, rows)[1].assetId).toBeNull();
    expect(container.textContent).toContain("原视频仍可预览并重新选用");
    expect(container.textContent).not.toContain("此镜头暂无可切换的视频版本");
    await expand(2);
    expect(container.querySelector('video[controls][src*="historical-two"]')).not.toBeNull();
    expect(container.textContent).toContain("修改前生成的版本");
    expect(useVersion(2, 1).textContent).toContain("采用到当前镜头");
    await click(useVersion(2, 1));
    expect(currentThumbnail("/api/files/project/historical-two.mp4")).not.toBeNull();
    await click(button("开始合成"));
    expect(JSON.parse(composeRequests()[0][1].body as string).shotAssetSelections).toEqual([
      { shotId: 1, assetId: "current-one" }, { shotId: 2, assetId: "derived-two" },
    ]);
    expect(fetchMock.mock.calls.some(([url]) => url.includes("/generate"))).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
  });

  it("keeps the saved current selection and displays recovery failures for edited-shot history", async () => {
    rows.push({ ...asset("historical-one", 1, false, 3000), matchesCurrentScript: false, klingJobId: "job", klingOutputId: "output" });
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url.includes("/outputs/output/select")
      ? Promise.resolve(Response.json({ error: { message: "原任务来源不匹配" } }, { status: 409 }))
      : normalFetch(url, init));
    await mount(); await expand(1);
    await click(useVersion(1, 3));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("原任务来源不匹配");
    expect(currentThumbnail("/api/files/project/old-one.mp4")).not.toBeNull();
    expect(useVersion(1, 3).disabled).toBe(false);
    expect(composeRequests()).toHaveLength(0);
  });

  it("shows selected takes instead of newer alternatives and exposes playable candidates per shot", async () => {
    rows.push({ ...asset("unfinished", 1, false, 3000), status: "generating" });
    await mount();
    expect(currentThumbnail("/api/files/project/old-one.mp4")).not.toBeNull();
    expect(currentThumbnail("/api/files/project/new-one.mp4")).toBeNull();
    await expand(1);
    expect(container.querySelectorAll("video[controls]")).toHaveLength(2);
    expect(useVersion(1, 1).disabled).toBe(true);
    expect(useVersion(1, 2).disabled).toBe(false);
    expect(container.querySelector('video[src*="unfinished"]')).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => url.includes("all=1"))).toBe(false);
  });

  it("saves different versions independently, updates thumbnails, and preserves the mix after reload", async () => {
    await mount(); await expand(1); await expand(2);
    await click(useVersion(1, 2));
    expect(currentThumbnail("/api/files/project/new-one.mp4")).not.toBeNull();
    expect(currentThumbnail("/api/files/project/old-two.mp4")).not.toBeNull();
    expect(useVersion(1, 2).disabled).toBe(true);
    expect(useVersion(2, 1).disabled).toBe(true);
    expect(fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")?.[1]).toMatchObject({ body: JSON.stringify({ assetId: "new-one" }) });
    await act(async () => root.unmount()); root = createRoot(container);
    await mount();
    expect(currentThumbnail("/api/files/project/new-one.mp4")).not.toBeNull();
    expect(currentThumbnail("/api/files/project/old-two.mp4")).not.toBeNull();
  });

  it("blocks switching and composition during a save and retains the original take on failure", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    let finish!: (value: Response) => void;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => init?.method === "PATCH" ? new Promise<Response>((resolve) => { finish = resolve; }) : normalFetch(url, init));
    await mount(); await expand(1); await expand(2);
    await click(useVersion(1, 2));
    expect(useVersion(1, 2).disabled).toBe(true);
    expect(useVersion(2, 2).disabled).toBe(true);
    expect(button("开始合成").disabled).toBe(true);
    await act(async () => finish(Response.json({ error: "此素材属于其他脚本修订，请刷新" }, { status: 409 })));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("此素材属于其他脚本修订");
    expect(currentThumbnail("/api/files/project/old-one.mp4")).not.toBeNull();
    expect(useVersion(1, 2).disabled).toBe(false);
    expect(composeRequests()).toHaveLength(0);
  });

  it("keeps an active image compatible while offering only video versions to choose", async () => {
    rows[1].selected = false;
    rows.push(asset("original-image", 1, true, 500, "png"), asset("alternative-image", 1, false, 2500, "jpg"), asset("newest-image", 1, false, 3000, "png"));
    await mount();
    expect(currentThumbnail("/api/files/project/original-image.png")).not.toBeNull();
    expect(buildShotAssetSelections(shots, rows)[0]).toEqual({ shotId: 1, assetId: "original-image" });
    expect(container.querySelector('button[aria-controls="shot-video-versions-1"]')?.textContent).toContain("选择视频版本（2）");
    await expand(1);
    const picker = container.querySelector("#shot-video-versions-1")!;
    expect(picker.querySelectorAll("video[controls]")).toHaveLength(2);
    expect(picker.querySelectorAll("img")).toHaveLength(0);
    expect(picker.textContent).not.toMatch(/图片版本|Image version/);
    expect(picker.querySelectorAll('button[aria-label*="的视频版本"]')).toHaveLength(2);
    expect(picker.querySelector('button[aria-label*="图片"]')).toBeNull();
    await click(useVersion(1, 2));
    expect(currentThumbnail("/api/files/project/new-one.mp4")).not.toBeNull();
    expect(currentThumbnail("/api/files/project/original-image.png")).toBeNull();
    expect(fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")?.[1]).toMatchObject({ body: JSON.stringify({ assetId: "new-one" }) });
    expect(buildShotAssetSelections(shots, rows)[0]).toEqual({ shotId: 1, assetId: "new-one" });
    expect(picker.querySelector("img")).toBeNull();
    expect(picker.querySelector('button[aria-label*="图片"]')).toBeNull();
  });

  it("pins the mixed selection and script in ordinary composition and locks switching while rendering", async () => {
    vi.useFakeTimers();
    await mount(); await expand(1); await click(useVersion(1, 2));
    await click(button("开始合成"));
    const body = JSON.parse(composeRequests()[0][1].body as string);
    expect(body).toMatchObject({ scriptId: "script", shotAssetSelections: [{ shotId: 1, assetId: "new-one" }, { shotId: 2, assetId: "old-two" }] });
    expect(body.shotAssetSelections.every((item: object) => !("filePath" in item))).toBe(true);
    expect(useVersion(1, 1).disabled).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(useVersion(1, 1).disabled).toBe(false);
  });

  it("pins the same mixed selection in matrix composition", async () => {
    vi.useFakeTimers();
    await mount(); await expand(2); await click(useVersion(2, 2));
    await click(button("变体矩阵"));
    await click(button("批量合成 1 条"));
    expect(JSON.parse(composeRequests()[0][1].body as string)).toMatchObject({ scriptId: "script", shotAssetSelections: [{ shotId: 1, assetId: "old-one" }, { shotId: 2, assetId: "new-two" }] });
    expect(useVersion(2, 1).disabled).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
  });

  it.each([
    { initial: "direct_concat", chosen: "ffmpeg_fade" },
    { initial: "ffmpeg_fade", chosen: "direct_concat" },
  ] as const)("sends a changed $initial to $chosen transition in ordinary composition", async ({ initial, chosen }) => {
    vi.useFakeTimers(); useInitialTransition(initial);
    await mount();
    expect(transitionSelect().value).toBe(initial);
    expect(transitionSelect().getAttribute("aria-label")).toBe("镜头 1 到镜头 2 的转场");
    await setTransition(chosen);
    await click(button("开始合成"));
    expect(JSON.parse(composeRequests()[0][1].body as string).transitionOverrides).toEqual([
      { shotId: 1, transition: "direct_concat" }, { shotId: 2, transition: chosen },
    ]);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
  });

  it.each([
    { initial: "direct_concat", chosen: "ffmpeg_fade" },
    { initial: "ffmpeg_fade", chosen: "direct_concat" },
  ] as const)("pins a changed $initial to $chosen transition for every matrix variant", async ({ initial, chosen }) => {
    vi.useFakeTimers(); useInitialTransition(initial);
    await mount();
    await setTransition(chosen);
    await click(button("变体矩阵"));
    await click([...container.querySelectorAll("button")].find((item) => item.textContent === "bold")!);
    await click(button("批量合成 2 条"));
    expect(composeRequests()).toHaveLength(1);
    await setTransition(initial);
    expect(transitionSelect().value).toBe(initial);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(composeRequests()).toHaveLength(2);
    for (const [, init] of composeRequests()) expect(JSON.parse(init.body as string).transitionOverrides).toEqual([
      { shotId: 1, transition: "direct_concat" }, { shotId: 2, transition: chosen },
    ]);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
  });

  it.each([
    { entry: "ordinary", chosen: "direct_concat", other: "ffmpeg_fade", action: "全部直接拼接" },
    { entry: "ordinary", chosen: "ffmpeg_fade", other: "direct_concat", action: "全部渐变过渡" },
    { entry: "matrix", chosen: "direct_concat", other: "ffmpeg_fade", action: "全部直接拼接" },
    { entry: "matrix", chosen: "ffmpeg_fade", other: "direct_concat", action: "全部渐变过渡" },
  ] as const)("bulk-applies $chosen to actual boundaries and retains individual edits in $entry composition", async ({ entry, chosen, other, action }) => {
    vi.useFakeTimers();
    const shotIds = [17, 4, 29, 8];
    const customShots = shotIds.map((shotId, index) => ({ ...shots[index === 0 ? 0 : 1], shotId, transition: other }));
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url.endsWith("/scripts")
      ? Promise.resolve(Response.json([{ id: "script", selected: true, shots: customShots }]))
      : normalFetch(url, init));
    rows = shotIds.map((shotId) => asset(`take-${shotId}`, shotId, true, 1000));
    await mount();
    expect(transitionSelects()).toHaveLength(3);
    expect(transitionSelects().map((select) => select.value)).toEqual([other, other, other]);

    await click(button(action));
    expect(transitionSelects().map((select) => select.value)).toEqual([chosen, chosen, chosen]);
    await setTransition(other, 1);
    expect(transitionSelects().map((select) => select.value)).toEqual([chosen, other, chosen]);

    if (entry === "matrix") {
      await click(button("变体矩阵"));
      await click(button("批量合成 1 条"));
    } else {
      await click(button("开始合成"));
    }
    expect(JSON.parse(composeRequests()[0][1].body as string).transitionOverrides).toEqual([
      { shotId: 17, transition: other },
      { shotId: 4, transition: chosen },
      { shotId: 29, transition: other },
      { shotId: 8, transition: chosen },
    ]);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
  });

  it("labels the transition between two shots in English and reads the incoming shot's saved transition", async () => {
    useSettingsStore.setState({ locale: "en" }); useInitialTransition("ffmpeg_fade");
    await mount();
    expect(transitionSelect().getAttribute("aria-label")).toBe("Transition from shot 1 to shot 2");
    expect(transitionSelect().value).toBe("ffmpeg_fade");
  });

  it("does not silently pick unselected alternatives and keeps image-only shots usable", async () => {
    rows = [asset("alternative", 1, false, 2000), asset("only-image", 2, true, 1000, "jpg")];
    await mount();
    expect(currentThumbnail("/api/files/project/alternative.mp4")).toBeNull();
    expect(currentThumbnail("/api/files/project/only-image.jpg")).not.toBeNull();
    expect(container.textContent).toContain("此镜头暂无可切换的视频版本");
    expect(buildShotAssetSelections(shots, rows)).toEqual([{ shotId: 1, assetId: null }, { shotId: 2, assetId: "only-image" }]);
  });
});
