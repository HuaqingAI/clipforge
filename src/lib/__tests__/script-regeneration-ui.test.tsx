import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ScriptPage from "@/app/project/[id]/script/page";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { createCreativeProfileSnapshot, createPremiumProductCgProfile, createShortVideoSalesProfile } from "@/lib/creative-profiles";

const navigation = vi.hoisted(() => ({ projectId: "project-1" }));
const historyDialog = vi.hoisted(() => ({
  props: null as null | {
    projectId: string;
    busy: boolean;
    onClose(): void;
    onRestore(scriptId: string): Promise<void>;
  },
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: navigation.projectId }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/components/project-header", () => ({ ProjectHeader: () => null }));
vi.mock("@/components/generation-runs-panel", () => ({ GenerationRunsPanel: () => null }));
vi.mock("@/lib/hooks/use-generation-runs", async (original) => ({ ...await original<typeof import("@/lib/hooks/use-generation-runs")>(), useGenerationRuns: () => ({ runs: [], loading: false, error: null }) }));
// The dialog has its own preview/confirmation coverage; these tests verify the page's restore lifecycle.
vi.mock("@/components/script-history-dialog", () => ({
  ScriptHistoryDialog: (props: NonNullable<typeof historyDialog.props>) => {
    historyDialog.props = props;
    return createElement("div", {
      "data-history-project": props.projectId,
      "data-history-busy": String(props.busy),
    }, "History preview");
  },
}));
vi.mock("@/lib/i18n", () => {
  const t = (key: string) => key;
  return { useT: () => t, useLocale: () => "zh" };
});

const scriptsUrl = "/api/project/project-1/scripts";
const projectUrl = "/api/project/project-1";
const generationUrl = "/api/generation-runs";
const settingsInitial = useSettingsStore.getInitialState();
const fetchMock = vi.fn();
let root: Root | undefined;
let container: HTMLDivElement;

function script(id: string, title: string, selected = true, version?: number) {
  return {
    id,
    title,
    styleType: "scene",
    totalDuration: 5,
    selected,
    version,
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

const oldScript = script("script-old", "Original script", true, 1);
const archivedOldScript = script("script-old", "Original script", false, 1);
const newScript = script("script-new", "Regenerated result", true, 2);
const judgeReport = {
  verdicts: [], descriptionRewrites: [], summary: "Review of the original script",
  rewrites: [{ shotId: 1, voiceover: "Suggested original-script rewrite", tier: "default" }],
};

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
  historyDialog.props = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const response = await fetchMock(url, init);
    if (url !== generationUrl || !response.ok) return response;
    const body = await response.json();
    return Response.json({ id: "script-run", projectId: navigation.projectId, kind: "script", status: "completed", total: 1, done: 1, failed: 0,
      items: [{ id: "script-item", kind: "script", status: "completed", result: body }] });
  });
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

describe("CG script product references", () => {
  const productImages = [
    "/uploads/chair-front.webp",
    "/uploads/chair-seat.webp",
    "/uploads/chair-side.webp",
    "/uploads/chair-headrest.webp",
  ];

  function useProductFixture({
    images = productImages,
    premiumCg = true,
    scripts = [oldScript],
  }: {
    images?: string[];
    premiumCg?: boolean;
    scripts?: ReturnType<typeof script>[];
  } = {}) {
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === scriptsUrl) return Promise.resolve(Response.json(scripts));
      if (url === projectUrl) return Promise.resolve(Response.json({
        name: "SwanSing chair",
        productName: "SwanSing chair",
        productImages: images,
        videoMode: "product_closeup",
        ...(premiumCg ? { creativeProfile: createPremiumProductCgProfile() } : {}),
      }));
      return normalFetch(url, init);
    });
  }

  it.each(["simple", "pro", "empty"] as const)("shows all four original references on the %s CG page", async (mode) => {
    useProductFixture({ scripts: mode === "empty" ? [] : [oldScript] });
    if (mode === "empty") {
      await act(async () => root!.render(createElement(ScriptPage)));
      expect(container.textContent).toContain("emptyTitle");
    } else {
      await mount(mode);
    }

    const references = container.querySelector('section[aria-label="productReferencesTitle"]');
    expect(references).not.toBeNull();
    expect(references!.textContent).toContain("productReferencesCount");
    const images = [...references!.querySelectorAll("img")];
    expect(images.map((image) => image.getAttribute("src"))).toEqual(productImages);
    for (const image of images) {
      expect(image.alt).toBe("productReferenceAlt");
      const preview = image.closest("a");
      expect(preview?.getAttribute("href")).toBe(image.getAttribute("src"));
      expect(preview?.getAttribute("target")).toBe("_blank");
      expect(preview?.getAttribute("rel")).toContain("noopener");
    }
  });

  it("shows a labelled original reference on every CG shot while preserving AI generation as its source", async () => {
    const cgScript = {
      ...oldScript,
      shots: [oldScript.shots[0], { ...oldScript.shots[0], shotId: 2, visualSource: "product_image" }],
    };
    useProductFixture({ scripts: [cgScript] });
    await mount();

    const shotReferences = [...container.querySelectorAll('img[alt="productReferenceAlt"]')]
      .filter((image) => !image.closest('section[aria-label="productReferencesTitle"]'));
    expect(shotReferences).toHaveLength(2);
    for (const image of shotReferences) expect(image.getAttribute("src")).toBe(productImages[0]);
    expect(container.textContent?.match(/productReferenceShort/g)).toHaveLength(2);
    expect(container.textContent).toContain("visualAiGenerate");
    expect(container.textContent).toContain("visualProductImage");
  });

  it("keeps CG scripts usable when no product references were uploaded", async () => {
    useProductFixture({ images: [] });
    await mount();

    expect(container.querySelector('section[aria-label="productReferencesTitle"]')).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).not.toContain("productReferenceShort");
    expect(container.textContent).toContain("visualAiGenerate");
    expectReady();
  });

  it("keeps sales AI shots as placeholders and product-image shots as original photos", async () => {
    const salesScript = {
      ...oldScript,
      shots: [oldScript.shots[0], { ...oldScript.shots[0], shotId: 2, visualSource: "product_image" }],
    };
    useProductFixture({ premiumCg: false, scripts: [salesScript] });
    await mount();

    expect(container.querySelector('section[aria-label="productReferencesTitle"]')).toBeNull();
    expect(container.textContent).not.toContain("productReferenceShort");
    const images = [...container.querySelectorAll("img")];
    expect(images).toHaveLength(1);
    expect(images[0].getAttribute("src")).toBe(productImages[0]);
    expect(container.textContent).toContain("visualAiGenerate");
    expect(container.textContent).toContain("visualProductImage");
  });
});

describe("first script generation failure recovery", () => {
  it.each(["server diagnostic", "invalid error body", "stalled error body"] as const)(
    "restores the empty CG page and allows retry after a %s",
    async (failure) => {
      const normalFetch = fetchMock.getMockImplementation()!;
      const generation = deferredResponse();
      const diagnostic = "脚本生成失败：模型返回了无效的旁白，请检查模型设置";
      let generationSignal: AbortSignal | null | undefined;
      let resolveBody!: (value: { error: string }) => void;
      const stalledBody = new Promise<{ error: string }>((resolve) => { resolveBody = resolve; });
      let attempts = 0;
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (url === scriptsUrl) return Promise.resolve(Response.json([]));
        if (url === projectUrl) return Promise.resolve(Response.json({
          name: "AeroStretch",
          productName: "AeroStretch",
          productImages: [],
          creativeProfile: createPremiumProductCgProfile({ narrationMode: "restrained" }),
        }));
        if (url === generationUrl) {
          attempts += 1;
          if (attempts > 1) return Promise.resolve(Response.json({ scripts: [newScript] }));
          generationSignal = init?.signal;
          return generation.promise;
        }
        return normalFetch(url, init);
      });
      await act(async () => root!.render(createElement(ScriptPage)));
      expect(container.textContent).toContain("emptyTitle");
      vi.useFakeTimers();
      await act(async () => button("generateScript").click());
      expect(button("generating").disabled).toBe(true);
      expect(button("generating").getAttribute("aria-busy")).toBe("true");

      await act(async () => generation.resolve(
        failure === "server diagnostic"
          ? Response.json({ error: diagnostic }, { status: 500 })
          : failure === "invalid error body"
            ? new Response("Internal server error", { status: 500 })
            : { ok: false, status: 500, json: () => stalledBody } as Response,
      ));
      if (failure === "stalled error body") await advance(15_000);

      expect(button("generateScript").disabled).toBe(false);
      expect(button("generateScript").getAttribute("aria-busy")).toBe("false");
      expect(container.querySelector('[role="alert"]')?.textContent).toBeTruthy();
      if (failure === "server diagnostic") expect(container.querySelector('[role="alert"]')?.textContent).toBe(diagnostic);
      expect(container.textContent).not.toContain("generating");
      expect(generationSignal).toBeDefined();
      const requestsAfterFailure = fetchMock.mock.calls.length;
      await advance(30_000);
      expect(fetchMock).toHaveBeenCalledTimes(requestsAfterFailure);

      await act(async () => button("generateScript").click());
      expect(container.textContent).toContain("Regenerated result");
      expect(container.textContent).not.toContain(diagnostic);
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expectReady();
      expect(attempts).toBe(2);
      // A late body from the failed request must not overwrite the successful retry.
      await act(async () => resolveBody({ error: diagnostic }));
      expect(container.textContent).toContain("Regenerated result");
      expect(container.querySelector('[role="alert"]')).toBeNull();
    },
  );
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
    // The generation API returns just this batch and currently omits stored version numbers.
    await act(async () => generation.resolve(Response.json({ scripts: [{ ...newScript, version: undefined }] })));

    expectReady();
    expect(container.textContent).toContain("Regenerated result");
    expect(container.textContent).toContain("Regenerated result details");
    expect(container.textContent).not.toContain("Original script");
    expect(fetchMock.mock.calls.filter(([url]) => url === projectUrl)).toHaveLength(1);
  });

  it("replaces every option on repeated regeneration instead of accumulating batches", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    const batches = [
      [
        script("batch-2-a", "Second batch selected", true, 2),
        script("batch-2-b", "Second batch alternative", false, 2),
        script("batch-2-c", "Second batch third option", false, 2),
      ],
      [
        script("batch-3-a", "Third batch selected", true, 3),
        script("batch-3-b", "Third batch alternative", false, 3),
      ],
    ];
    let generated = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === generationUrl
      ? Promise.resolve(Response.json({ scripts: batches[generated++] }))
      : normalFetch(url, init));
    await mount();

    await regenerate();
    expectReady();
    for (const option of batches[0]) expect(container.textContent).toContain(option.title);
    expect(container.textContent).not.toContain("Original script");

    await regenerate();
    expectReady();
    for (const option of batches[1]) expect(container.textContent).toContain(option.title);
    for (const option of batches[0]) expect(container.textContent).not.toContain(option.title);
    expect(container.textContent).not.toContain("Original script");
    expect(generated).toBe(2);
  });

  it.each([2, 3])("restores only the selected version %i batch after a remount with saved history", async (selectedVersion) => {
    await mount();
    const normalFetch = fetchMock.getMockImplementation()!;
    const batches = [
      [archivedOldScript],
      [
        script("batch-2-a", "Second batch first option", selectedVersion === 2, 2),
        script("batch-2-b", "Second batch alternative", false, 2),
      ],
      [
        script("batch-3-a", "Third batch first option", selectedVersion === 3, 3),
        script("batch-3-b", "Third batch alternative", false, 3),
        script("batch-3-c", "Third batch third option", false, 3),
      ],
    ];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === scriptsUrl
      ? Promise.resolve(Response.json(batches.flat()))
      : normalFetch(url, init));

    await act(async () => root!.unmount());
    root = createRoot(container);
    await act(async () => root!.render(createElement(ScriptPage)));

    expectReady();
    for (const option of batches[selectedVersion - 1]) expect(container.textContent).toContain(option.title);
    for (const option of batches.flat().filter((row) => row.version !== selectedVersion)) {
      expect(container.textContent).not.toContain(option.title);
    }
    expect(container.textContent).toContain(batches[selectedVersion - 1][0].shots[0].voiceover);
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
    expect(container.textContent).not.toContain("Original script");
    expect(fetchMock.mock.calls.filter(([url]) => url === projectUrl)).toHaveLength(1);
  });

  it("replaces topic history when the durable submit confirms new saved scripts", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    const generation = deferredResponse();
    let started = false;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === projectUrl) return Promise.resolve(Response.json({
        name: "Topic",
        contentType: "topic",
        topic: "A useful topic",
      }));
      if (url === generationUrl) { started = true; return generation.promise; }
      if (started && url === scriptsUrl) return Promise.resolve(Response.json([newScript]));
      return normalFetch(url, init);
    });
    await mount();
    await regenerate();
    expectBusy();
    await act(async () => generation.resolve(Response.json({ scripts: [newScript] })));

    expectReady();
    expect(container.textContent).toContain("Regenerated result details");
    expect(container.textContent).not.toContain("Original script");
    const request = fetchMock.mock.calls.find(([url]) => url === generationUrl);
    expect(JSON.parse(request![1].body)).toMatchObject({ projectId: "project-1", items: [{ request: { generationEndpoint: "/api/topic/script", topic: "A useful topic" } }] });
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/topic/script")).toBe(false);
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








});

describe("saved script configuration versions", () => {
  const profile = createShortVideoSalesProfile();

  function useSavedOptions(options: (ReturnType<typeof script> & {
    creativeProfileSnapshot?: ReturnType<typeof createCreativeProfileSnapshot> | null;
  })[]) {
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === projectUrl) return Promise.resolve(Response.json({
        name: "Product", productName: "Product", productImages: [],
        creativeProfile: profile, creativeConfigRevision: 6,
      }));
      if (url === scriptsUrl && init?.method === "PATCH") {
        // Selection preserves the alternative's frozen configuration.
        return Promise.resolve(Response.json({ success: true, scriptRevision: 6, projectRevision: 6 }));
      }
      if (url === scriptsUrl) return Promise.resolve(Response.json(options));
      return normalFetch(url, init);
    });
  }

  it.each(["simple", "pro"] as const)("keeps an earlier frozen configuration usable on the %s page without a regeneration warning", async (mode) => {
    useSavedOptions([{ ...oldScript, creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 2) }]);
    await mount(mode);

    expect(container.textContent).not.toContain("scriptConfigStaleWarning");
    expect(button("nextStepAssets").disabled).toBe(false);
  });

  it.each([
    { mode: "simple", snapshot: "current" },
    { mode: "pro", snapshot: "current" },
    { mode: "simple", snapshot: "legacy" },
    { mode: "pro", snapshot: "legacy" },
  ] as const)("does not warn on the $mode page for a $snapshot script", async ({ mode, snapshot }) => {
    useSavedOptions([{
      ...oldScript,
      creativeProfileSnapshot: snapshot === "current" ? createCreativeProfileSnapshot(profile, 6) : undefined,
    }]);
    await mount(mode);

    expect(container.textContent).not.toContain("scriptConfigStaleWarning");
  });

  it("switches saved options with different snapshot versions without a regeneration warning", async () => {
    const staleAlternative = {
      ...script("alternative", "Stale alternative", false, 1),
      creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 2),
    };
    const currentAlternative = {
      ...script("current-alternative", "Current alternative", false, 1),
      creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 6),
    };
    useSavedOptions([
      { ...oldScript, creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 2) },
      staleAlternative,
      currentAlternative,
    ]);
    await mount();

    const selectOption = async (title: string) => {
      const remove = container.querySelector(`button[aria-label="deleteScript ${title}"]`)!;
      await act(async () => (remove.closest(".cursor-pointer") as HTMLElement).click());
    };
    await selectOption(staleAlternative.title);
    expect(container.textContent).toContain("Stale alternative details");
    expect(container.textContent).not.toContain("scriptConfigStaleWarning");
    expect(container.textContent).not.toContain("selectionFailed");

    await selectOption(currentAlternative.title);
    expect(container.textContent).toContain("Current alternative details");
    expect(container.textContent).not.toContain("scriptConfigStaleWarning");
  });
});

describe("script option deletion", () => {
  function deleteButton(title: string) {
    return container.querySelector(`button[aria-label="deleteScript ${title}"]`) as HTMLButtonElement;
  }

  it.each([true, false])("waits for selection changes and restores the old selection on success=%s", async (success) => {
    const normalFetch = fetchMock.getMockImplementation()!;
    const alternative = script("alternative", "Alternative script", false, 1);
    const selection = deferredResponse();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === scriptsUrl && init?.method === "PATCH") return selection.promise;
      if (url === scriptsUrl) return Promise.resolve(Response.json([oldScript, alternative]));
      return normalFetch(url, init);
    });
    await mount();
    await act(async () => (deleteButton(alternative.title).closest(".cursor-pointer") as HTMLElement).click());
    expect(container.textContent).toContain("Alternative script details");
    expect(deleteButton(oldScript.title).disabled).toBe(true);
    expect(button("regenerate").disabled).toBe(true);
    await act(async () => selection.resolve(Response.json({}, { status: success ? 200 : 503 })));
    expect(deleteButton(oldScript.title).disabled).toBe(false);
    expect(button("regenerate").disabled).toBe(false);
    expect(container.textContent).toContain(success ? "Alternative script details" : "Original script details");
    if (!success) expect(container.textContent).toContain("selectionFailed");
  });

  it.each([
    { code: undefined, error: "该方案已被删除，请刷新后重试。", expected: "该方案已被删除，请刷新后重试。" },
    { code: "CREATIVE_PROFILE_MISMATCH", error: "Incompatible creation type", expected: "selectionTypeMismatch" },
    { code: undefined, error: null, expected: "selectionFailed" },
  ])("explains a failed selection as $expected and rolls back the preview", async ({ code, error, expected }) => {
    const normalFetch = fetchMock.getMockImplementation()!;
    const alternative = script("alternative", "Alternative script", false, 1);
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === scriptsUrl && init?.method === "PATCH") {
        return Promise.resolve(error === null
          ? new Response("Invalid response body", { status: 500 })
          : Response.json({ code, error }, { status: 409 }));
      }
      if (url === scriptsUrl) return Promise.resolve(Response.json([oldScript, alternative]));
      return normalFetch(url, init);
    });
    await mount();
    await act(async () => (deleteButton(alternative.title).closest(".cursor-pointer") as HTMLElement).click());

    expect(container.textContent).toContain(expected);
    expect(container.textContent).toContain("Original script details");
    expect(container.textContent).not.toContain("Alternative script details");
    expect(button("regenerate").disabled).toBe(false);
    expect(deleteButton(oldScript.title).disabled).toBe(false);
  });

  it.each(["transport", "response body"] as const)("releases a stalled selection %s on timeout and ignores its late result", async (stage) => {
    vi.useFakeTimers();
    const normalFetch = fetchMock.getMockImplementation()!;
    const alternative = script("alternative", "Alternative script", false, 1);
    const pending = deferredResponse();
    let resolveBody!: (value: unknown) => void;
    let selectionSignal: AbortSignal | null | undefined;
    const pendingBody = new Promise((resolve) => { resolveBody = resolve; });
    const failure = Response.json({}, { status: 409 });
    failure.json = () => pendingBody;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === scriptsUrl && init?.method === "PATCH") {
        selectionSignal = init.signal;
        return stage === "transport" ? pending.promise : Promise.resolve(failure);
      }
      if (url === scriptsUrl) return Promise.resolve(Response.json([oldScript, alternative]));
      return normalFetch(url, init);
    });
    await mount();
    await act(async () => (deleteButton(alternative.title).closest(".cursor-pointer") as HTMLElement).click());
    expect(button("regenerate").disabled).toBe(true);
    await advance(15_000);

    expect(selectionSignal?.aborted).toBe(true);
    expect(container.textContent).toContain("Original script details");
    expect(button("regenerate").disabled).toBe(false);
    expect(deleteButton(oldScript.title).disabled).toBe(false);
    await act(async () => {
      pending.resolve(Response.json({}));
      resolveBody({ error: "Late diagnostic" });
    });
    expect(container.textContent).not.toContain("Alternative script details");
    expect(container.textContent).not.toContain("Late diagnostic");
  });

  it("waits for a judge request before allowing deletion so its report cannot target another script", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    const review = deferredResponse();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url.endsWith("/script-judge")
      ? review.promise : normalFetch(url, init));
    await mount();
    await act(async () => button("judgeButton").click());
    expect(deleteButton(oldScript.title).disabled).toBe(true);
    await act(async () => review.resolve(Response.json({ error: "Review unavailable" }, { status: 503 })));
    expect(deleteButton(oldScript.title).disabled).toBe(false);
  });

  it.each(["generation", "selection", "deletion"] as const)("blocks judge and editing requests while %s changes the active script", async (operation) => {
    const normalFetch = fetchMock.getMockImplementation()!;
    const alternative = script("alternative", "Alternative script", false, 1);
    const pending = deferredResponse();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/script-judge")) return Promise.resolve(Response.json(judgeReport));
      if (url === generationUrl || (url === scriptsUrl && init?.method)) return pending.promise;
      if (url === scriptsUrl) return Promise.resolve(Response.json([oldScript, alternative]));
      return normalFetch(url, init);
    });
    await mount();
    await act(async () => button("judgeButton").click());
    expect(container.textContent).toContain(judgeReport.summary);
    await act(async () => button("editShot").click());

    if (operation === "generation") await regenerate();
    else if (operation === "selection") {
      await act(async () => (deleteButton(alternative.title).closest(".cursor-pointer") as HTMLElement).click());
    } else {
      await act(async () => deleteButton(oldScript.title).click());
      await act(async () => button("deleteConfirmOk").click());
    }

    expect(button("judgeButton").disabled).toBe(true);
    const apply = button("judgeApply");
    if (apply) expect(apply.disabled).toBe(true);
    const save = [...container.querySelectorAll("button")].find((item) => item.textContent === "save");
    if (save) expect(save.disabled).toBe(true);
    const edit = button("editShot");
    if (edit) expect(edit.disabled).toBe(true);
    await act(async () => { button("judgeButton").click(); apply?.click(); save?.click(); edit?.click(); });
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/script-judge"))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(operation === "selection" ? 1 : 0);

    const response = operation === "selection" ? {} : { success: true, scripts: [newScript] };
    await act(async () => pending.resolve(Response.json(response)));
    expect(button("judgeButton").disabled).toBe(false);
    expect(container.textContent).not.toContain(judgeReport.summary);
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("clears the old report and open edit when regeneration replaces the script at the same index", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/script-judge")) return Promise.resolve(Response.json(judgeReport));
      if (url === generationUrl) return Promise.resolve(Response.json({ scripts: [newScript] }));
      return normalFetch(url, init);
    });
    await mount();
    await act(async () => button("judgeButton").click());
    await act(async () => button("editShot").click());
    expect(container.textContent).toContain(judgeReport.summary);
    expect(container.querySelector("textarea")).not.toBeNull();
    await regenerate();
    expectReady();
    expect(container.textContent).toContain("Regenerated result details");
    expect(container.textContent).not.toContain(judgeReport.summary);
    expect(button("judgeApply")).toBeUndefined();
    expect(container.querySelector("textarea")).toBeNull();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("keeps editing locked until an in-flight save finishes", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    const save = deferredResponse();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === scriptsUrl && init?.method === "PATCH"
      ? save.promise : normalFetch(url, init));
    await mount();
    await act(async () => button("editShot").click());
    const saveButton = [...container.querySelectorAll("button")].find((item) => item.textContent === "save")!;
    await act(async () => saveButton.click());
    expect(button("cancel").disabled).toBe(true);
    expect(button("judgeButton").disabled).toBe(true);
    expect(deleteButton(oldScript.title).disabled).toBe(true);
    expect(button("regenerate").disabled).toBe(true);
    await act(async () => button("cancel").click());
    expect(deleteButton(oldScript.title).disabled).toBe(true);
    await act(async () => save.resolve(Response.json({ success: true })));
    expect(deleteButton(oldScript.title).disabled).toBe(false);
    expect(button("judgeButton").disabled).toBe(false);
  });

  it.each(["simple", "pro"] as const)("lets the %s user cancel deletion without changing selection or sending a request", async (uiMode) => {
    await mount(uiMode);
    await act(async () => uiMode === "pro" ? deleteButton(oldScript.title).click() : button("deleteScript").click());
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE" || init?.method === "PATCH")).toBe(false);
    await act(async () => button("cancel").click());
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.textContent).toContain("Original script details");
  });

  it.each([true, false])("deletes a selected=%s option and displays the server's remaining selection", async (deleteSelected) => {
    const alternative = script("alternative", "Alternative script", false, 1);
    const normalFetch = fetchMock.getMockImplementation()!;
    const deletion = deferredResponse();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === scriptsUrl && init?.method === "DELETE") return deletion.promise;
      if (url === scriptsUrl) return Promise.resolve(Response.json([oldScript, alternative]));
      return normalFetch(url, init);
    });
    await mount();
    await act(async () => deleteButton(deleteSelected ? oldScript.title : alternative.title).click());
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    const confirm = button("deleteConfirmOk");
    await act(async () => { confirm.click(); confirm.click(); });
    expect(button("deletingScript").disabled).toBe(true);
    const calls = fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0][1].body)).toEqual({ scriptId: deleteSelected ? oldScript.id : alternative.id });
    const remaining = deleteSelected ? { ...alternative, selected: true } : oldScript;
    await act(async () => deletion.resolve(Response.json({ success: true, scripts: [remaining] })));
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.textContent).toContain(remaining.shots[0].voiceover);
    expect(container.textContent).not.toContain(deleteSelected ? oldScript.title : alternative.title);
  });

  it("keeps an emptied current batch empty after a reload even when older history still exists", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    let deleted = false;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === scriptsUrl && init?.method === "DELETE") {
        deleted = true;
        return Promise.resolve(Response.json({ success: true, scripts: [], selectedScriptId: null }));
      }
      if (url === scriptsUrl) return Promise.resolve(Response.json(deleted ? [archivedOldScript] : [archivedOldScript, newScript]));
      return normalFetch(url, init);
    });
    await act(async () => root!.render(createElement(ScriptPage)));
    await act(async () => deleteButton(newScript.title).click());
    await act(async () => button("deleteConfirmOk").click());
    expect(container.textContent).toContain("emptyTitle");
    expect(container.textContent).not.toContain("Original script");
    await act(async () => root!.unmount());
    root = createRoot(container);
    await act(async () => root!.render(createElement(ScriptPage)));
    expect(container.textContent).toContain("emptyTitle");
    expect(container.textContent).not.toContain("Original script");
    expect(container.textContent).not.toContain("Regenerated result");
  });

  it("preserves the option and shows an actionable error when deletion is refused", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => init?.method === "DELETE"
      ? Promise.resolve(Response.json({ error: "Generation is still running" }, { status: 409 }))
      : normalFetch(url, init));
    await mount();
    await act(async () => deleteButton(oldScript.title).click());
    await act(async () => button("deleteConfirmOk").click());
    expect(container.textContent).toContain("Original script details");
    expect(container.querySelector('[role="alertdialog"] [role="alert"]')?.textContent).toBe("Generation is still running");
    expect(button("deleteConfirmOk").disabled).toBe(false);
  });
});

describe("script history restoration", () => {
  const restoredScript = script("archived-selected", "Archived selected option", true, 2);
  const restoredAlternative = script("archived-alternative", "Archived alternative", false, 2);
  const restoredBatch = [restoredAlternative, restoredScript];

  async function openHistory() {
    await act(async () => button("historyButton").click());
    expect(container.querySelector('[data-history-project="project-1"]')).not.toBeNull();
    expect(historyDialog.props?.busy).toBe(false);
  }

  async function beginRestore() {
    let restoration!: Promise<void>;
    await act(async () => {
      restoration = historyDialog.props!.onRestore(restoredScript.id);
      // A deferred response may outlive a render or route transition.
      void restoration.catch(() => {});
    });
    return { restoration };
  }

  it.each(["simple", "pro", "empty"] as const)("offers history from the %s script page", async (mode) => {
    if (mode === "empty") {
      const normalFetch = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((url: string, init?: RequestInit) => url === scriptsUrl
        ? Promise.resolve(Response.json([archivedOldScript]))
        : normalFetch(url, init));
      await act(async () => root!.render(createElement(ScriptPage)));
      expect(container.textContent).toContain("emptyTitle");
    } else {
      await mount(mode);
    }
    await openHistory();
    await act(async () => historyDialog.props!.onClose());
    expect(container.querySelector("[data-history-project]")).toBeNull();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("replaces the visible batch directly from restoration and preserves it after reload", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    let restored = false;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === scriptsUrl && init?.method === "PATCH") {
        restored = true;
        return Promise.resolve(Response.json({ success: true, scripts: restoredBatch }));
      }
      if (url === scriptsUrl && restored) return Promise.resolve(Response.json([archivedOldScript, ...restoredBatch]));
      return normalFetch(url, init);
    });
    await mount();
    await openHistory();
    await act(async () => historyDialog.props!.onRestore(restoredScript.id));

    expect(container.querySelector("[data-history-project]")).toBeNull();
    expect(container.textContent).toContain(restoredScript.shots[0].voiceover);
    expect(container.textContent).toContain(restoredAlternative.title);
    expect(container.textContent).not.toContain(oldScript.title);
    const requests = fetchMock.mock.calls.filter(([url]) => url === scriptsUrl);
    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[1][1].body)).toEqual({ restoreScriptId: restoredScript.id });
    expect(requests[1][1].method).toBe("PATCH");
    expectReady();

    await act(async () => root!.unmount());
    root = createRoot(container);
    await act(async () => root!.render(createElement(ScriptPage)));
    expect(container.textContent).toContain(restoredScript.shots[0].voiceover);
    expect(container.textContent).toContain(restoredAlternative.title);
    expect(container.textContent).not.toContain(oldScript.title);
  });

  it("locks competing actions while restoring and clears the old review and edit on success", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    const response = deferredResponse();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/script-judge")) return Promise.resolve(Response.json(judgeReport));
      if (url === scriptsUrl && init?.method === "PATCH") return response.promise;
      return normalFetch(url, init);
    });
    await mount();
    await act(async () => button("judgeButton").click());
    await act(async () => button("editShot").click());
    expect(container.textContent).toContain(judgeReport.summary);
    expect(container.querySelector("textarea")).not.toBeNull();
    await openHistory();
    const { restoration } = await beginRestore();

    expect(historyDialog.props?.busy).toBe(true);
    expect(button("regenerate").disabled).toBe(true);
    expect(button("judgeButton").disabled).toBe(true);
    expect(button("judgeApply").disabled).toBe(true);
    expect((container.querySelector(`button[aria-label="deleteScript ${oldScript.title}"]`) as HTMLButtonElement).disabled).toBe(true);
    const save = [...container.querySelectorAll("button")].find((item) => item.textContent === "save")!;
    expect(save.disabled).toBe(true);
    await act(async () => {
      await expect(historyDialog.props!.onRestore(restoredScript.id)).rejects.toThrow("historyRestoreBusy");
      button("regenerate").click();
      button("judgeButton").click();
      save.click();
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/script-judge"))).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => url === generationUrl)).toBe(false);

    await act(async () => {
      response.resolve(Response.json({ success: true, scripts: restoredBatch }));
      await restoration;
    });
    expect(container.textContent).toContain(restoredScript.shots[0].voiceover);
    expect(container.textContent).not.toContain(judgeReport.summary);
    expect(button("judgeApply")).toBeUndefined();
    expect(container.querySelector("textarea")).toBeNull();
    expect(button("judgeButton").disabled).toBe(false);
    expectReady();
  });

  it.each(["refused", "invalid"] as const)("keeps the current batch and allows retry after a %s restoration", async (failure) => {
    const normalFetch = fetchMock.getMockImplementation()!;
    let attempts = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === scriptsUrl && init?.method === "PATCH") {
        attempts += 1;
        return Promise.resolve(attempts > 1
          ? Response.json({ success: true, scripts: restoredBatch })
          : failure === "refused"
            ? Response.json({ error: "Generation is still running" }, { status: 409 })
            : Response.json({ success: true, scripts: [{ ...restoredScript, selected: false }] }));
      }
      return normalFetch(url, init);
    });
    await mount();
    await openHistory();
    await act(async () => {
      await expect(historyDialog.props!.onRestore(restoredScript.id)).rejects.toThrow(
        failure === "refused" ? "Generation is still running" : "historyRestoreFailed",
      );
    });
    expect(container.querySelector("[data-history-project]")).not.toBeNull();
    expect(historyDialog.props?.busy).toBe(false);
    expect(container.textContent).toContain(oldScript.shots[0].voiceover);
    expect(container.textContent).not.toContain(restoredScript.title);
    expectReady();

    await act(async () => historyDialog.props!.onRestore(restoredScript.id));
    expect(attempts).toBe(2);
    expect(container.querySelector("[data-history-project]")).toBeNull();
    expect(container.textContent).toContain(restoredScript.shots[0].voiceover);
  });

  it.each(["transport", "response body"] as const)("releases restoration after a stalled %s ignores abort and allows retry", async (stage) => {
    const normalFetch = fetchMock.getMockImplementation()!;
    const lateResponse = deferredResponse();
    let resolveBody!: (value: { success: boolean; scripts: typeof restoredBatch }) => void;
    const stalledBody = new Promise<{ success: boolean; scripts: typeof restoredBatch }>((resolve) => { resolveBody = resolve; });
    let restoreSignal: AbortSignal | null | undefined;
    let attempts = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === scriptsUrl && init?.method === "PATCH") {
        attempts += 1;
        if (attempts > 1) return Promise.resolve(Response.json({ success: true, scripts: restoredBatch }));
        restoreSignal = init.signal;
        return stage === "transport"
          ? lateResponse.promise
          : Promise.resolve({ ok: true, json: () => stalledBody } as Response);
      }
      return normalFetch(url, init);
    });
    await mount();
    await openHistory();
    vi.useFakeTimers();
    const { restoration } = await beginRestore();
    expect(historyDialog.props?.busy).toBe(true);
    await advance(15_000);
    await expect(restoration).rejects.toBeInstanceOf(Error);

    expect(restoreSignal?.aborted).toBe(true);
    expect(restoreSignal?.reason.message).toBe("historyRestoreTimedOut");
    expect(historyDialog.props?.busy).toBe(false);
    expect(container.textContent).toContain(oldScript.shots[0].voiceover);
    expect(container.textContent).not.toContain(restoredScript.title);
    expectReady();
    await act(async () => historyDialog.props!.onClose());
    expect(container.querySelector("[data-history-project]")).toBeNull();

    await act(async () => {
      lateResponse.resolve(Response.json({ success: true, scripts: restoredBatch }));
      resolveBody({ success: true, scripts: restoredBatch });
    });
    expect(container.textContent).toContain(oldScript.shots[0].voiceover);
    expect(container.textContent).not.toContain(restoredScript.title);
    await openHistory();
    await act(async () => historyDialog.props!.onRestore(restoredScript.id));
    expect(attempts).toBe(2);
    expect(container.querySelector("[data-history-project]")).toBeNull();
    expect(container.textContent).toContain(restoredScript.shots[0].voiceover);
  });

  it.each(["route change", "unmount"] as const)("aborts restoration on %s and ignores a late response", async (transition) => {
    const normalFetch = fetchMock.getMockImplementation()!;
    const response = deferredResponse();
    let restoreSignal: AbortSignal | null | undefined;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === scriptsUrl && init?.method === "PATCH") {
        restoreSignal = init.signal;
        return response.promise;
      }
      if (url === "/api/project/project-2/scripts") return Promise.resolve(Response.json([script("other-script", "Other project script")]));
      if (url === "/api/project/project-2") return Promise.resolve(Response.json({ name: "Other product", productName: "Other product", productImages: [] }));
      return normalFetch(url, init);
    });
    await mount();
    await openHistory();
    const { restoration } = await beginRestore();
    if (transition === "route change") {
      navigation.projectId = "project-2";
      await act(async () => root!.render(createElement(ScriptPage)));
      expect(container.textContent).toContain("Other project script");
      expectReady();
    } else {
      await act(async () => root!.unmount());
      root = undefined;
    }
    expect(restoreSignal?.aborted).toBe(true);
    await act(async () => {
      response.resolve(Response.json({ success: true, scripts: restoredBatch }));
      await expect(restoration).rejects.toBeInstanceOf(Error);
    });
    expect(container.querySelector("[data-history-project]")).toBeNull();
    expect(container.textContent).not.toContain(restoredScript.title);
    if (transition === "route change") expect(container.textContent).toContain("Other project script");
  });
});
