import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import VideoPage from "@/app/project/[id]/video/page";
import { createTideweOutdoorProfile } from "@/lib/creative-profiles";
import { AD_TEMPLATES, adTemplateStorageKey, adTemplateAppliedKey } from "@/lib/ad-templates";

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "project-1" }) }));
vi.mock("@/lib/i18n", () => ({ useT: () => (key: string) => key, useLocale: () => "zh" }));
vi.mock("@/components/project-header", () => ({ ProjectHeader: () => null }));
vi.mock("@/components/free-voice-preview", () => ({ FreeVoicePreview: () => null }));
vi.mock("@/lib/stores/settings-store", () => ({
  useSettingsStore: () => ({
    defaultResolution: "1080p", defaultAspectRatio: "9:16", providers: {},
    tts: { enabled: false, provider: "openai", apiKey: "", baseUrl: "", model: "", voice: "" },
  }),
}));

const fetchMock = vi.fn();
let root: Root;
let container: HTMLDivElement;

function switchFor(label: string) {
  return container.querySelector(`[role="switch"][aria-label="${label}"]`) as HTMLButtonElement;
}
function button(label: string) {
  return [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;
}
async function click(control: HTMLElement) { await act(async () => control.click()); }
function composeBodies() {
  return fetchMock.mock.calls
    .filter(([url, init]) => url === "/api/project/project-1/compose" && init?.method === "POST")
    .map(([, init]) => JSON.parse(init.body));
}
function expectNoFreeBgm(body: object) {
  expect(body).not.toHaveProperty("freeBgm");
  expect(body).not.toHaveProperty("bgmMood");
}
async function mount() { await act(async () => root.render(<VideoPage />)); }

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/project/project-1") return Response.json({ name: "Test project" });
    if (url.endsWith("/scripts")) return Response.json([{ id: "script-1", selected: true, shots: [{ shotId: 1, type: "hook", duration: 5, voiceover: "Test narration", transition: "direct_concat" }] }]);
    if (url.split("?")[0].endsWith("/assets")) return Response.json([]);
    // End compose immediately so tests can inspect another request without polling timers.
    if (url.endsWith("/compose") && init?.method === "POST") return Response.json({ error: "Test response" }, { status: 400 });
    throw new Error(`Unexpected request: ${url}`);
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("composition voiceover modes", () => {
  it("waits for the loaded profile before consuming a template and restores the TIDEWE compose snapshot", async () => {
    const template = AD_TEMPLATES.find((item) => item.compose.captionPreset === "karaoke" || item.compose.captionPreset === "bold")!;
    expect(template).toBeTruthy();
    localStorage.setItem(adTemplateStorageKey("project-1"), template.id);
    const normalFetch = fetchMock.getMockImplementation()!;
    let resolveProject!: (response: Response) => void;
    const projectResponse = new Promise<Response>((resolve) => { resolveProject = resolve; });
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === "/api/project/project-1" ? projectResponse : normalFetch(url, init));
    await mount();
    expect(localStorage.getItem(adTemplateStorageKey("project-1"))).toBe(template.id);
    expect(localStorage.getItem(adTemplateAppliedKey("project-1"))).toBeNull();
    await act(async () => resolveProject(Response.json({ name: "TIDEWE", creativeProfile: createTideweOutdoorProfile({ speechMode: "voiceover", composeSnapshot: { subtitles: false, captionPreset: "minimal", quality: "fast", bgmVolume: 0.1 } }) })));
    expect(localStorage.getItem(adTemplateStorageKey("project-1"))).toBeNull();
    expect(localStorage.getItem(adTemplateAppliedKey("project-1"))).toBeNull();
    expect(switchFor("subtitleEnableLabel").getAttribute("aria-checked")).toBe("false");
    expect(switchFor("ttsEnableLabel").disabled).toBe(true);
    expect(container.textContent).not.toContain("matrixTitle");
    await click(button("composeStart"));
    const body = composeBodies().at(-1);
    expect(body).toMatchObject({ subtitles: false, voiceoverMode: "replace", freeTts: { enabled: true, voice: "en-US-GuyNeural" }, renderPreset: "fast", aspectRatio: "9:16" });
    expect(body).not.toHaveProperty("ctaText");
    expect(body).not.toHaveProperty("productCard");
    await click(switchFor("subtitleEnableLabel"));
    await click(button("composeStart"));
    expect(composeBodies().at(-1)).toMatchObject({ subtitles: true, captionPreset: "minimal" });
  });
  it("keeps on-camera TIDEWE speech as native audio without TTS controls or a duplicate narration request", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === "/api/project/project-1"
      ? Promise.resolve(Response.json({ name: "TIDEWE", creativeProfile: createTideweOutdoorProfile() }))
      : normalFetch(url, init));
    await mount();
    expect(container.textContent).toContain("nativeSpeechHint");
    expect(switchFor("ttsEnableLabel")).toBeNull();
    expect(switchFor("ttsReplaceLabel")).toBeNull();
    expect(container.textContent).not.toContain("ttsFreeBadge");
    await click(button("composeStart"));
    const body = composeBodies().at(-1);
    expect(body).toMatchObject({ nativeAudio: true, ttsEnabled: false, subtitles: true });
    for (const field of ["freeTts", "ttsConfig", "voiceoverMode"]) expect(body).not.toHaveProperty(field);
  });
  it("starts with both modes off and keeps switches mutually exclusive", async () => {
    await mount();
    const replace = switchFor("ttsReplaceLabel");
    const mix = switchFor("ttsMixLabel");
    expect(replace.getAttribute("aria-checked")).toBe("false");
    expect(mix.getAttribute("aria-checked")).toBe("false");
    await click(replace);
    expect(replace.getAttribute("aria-checked")).toBe("true");
    expect(mix.getAttribute("aria-checked")).toBe("false");
    await click(mix);
    expect(replace.getAttribute("aria-checked")).toBe("false");
    expect(mix.getAttribute("aria-checked")).toBe("true");
    await click(mix);
    expect(replace.getAttribute("aria-checked")).toBe("false");
    expect(mix.getAttribute("aria-checked")).toBe("false");
  });

  it.each([
    { mode: "replace", label: "ttsReplaceLabel" },
    { mode: "mix", label: "ttsMixLabel" },
  ])("sends $mode for ordinary and matrix compositions, and omits it when off", async ({ mode, label }) => {
    await mount();
    await click(button("composeStart"));
    expect(composeBodies().at(-1)).not.toHaveProperty("voiceoverMode");
    await click(switchFor(label));
    await click(button("composeStart"));
    expect(composeBodies().at(-1)).toMatchObject({ voiceoverMode: mode, freeTts: { enabled: true } });

    await click([...container.querySelectorAll("button")].find((item) => item.textContent?.includes("matrixTitle"))!);
    await click(button("matrixRun"));
    expect(composeBodies().at(-1)).toMatchObject({ voiceoverMode: mode, label: expect.any(String), freeTts: { enabled: true } });

    await click(switchFor("ttsEnableLabel"));
    expect(switchFor("ttsReplaceLabel").disabled).toBe(true);
    expect(switchFor("ttsMixLabel").disabled).toBe(true);
    expect(switchFor(label).getAttribute("aria-checked")).toBe("true");
    await click(button("composeStart"));
    expect(composeBodies().at(-1)).not.toHaveProperty("voiceoverMode");
    expect(composeBodies().at(-1)).not.toHaveProperty("freeTts");
    await click(button("matrixRun"));
    expect(composeBodies().at(-1)).not.toHaveProperty("voiceoverMode");
    expect(composeBodies().at(-1)).not.toHaveProperty("freeTts");

    await click(switchFor("ttsEnableLabel"));
    expect(switchFor(label).disabled).toBe(false);
    expect(switchFor(label).getAttribute("aria-checked")).toBe("true");
    await click(switchFor(label));
    await click(button("composeStart"));
    expect(composeBodies().at(-1)).not.toHaveProperty("voiceoverMode");
  });
});

describe("independent composition subtitles", () => {
  it.each([
    { mode: "replace", label: "ttsReplaceLabel" },
    { mode: "mix", label: "ttsMixLabel" },
  ])("disables captions without changing $mode narration in either compose entry point", async ({ mode, label }) => {
    await mount();
    const subtitles = switchFor("subtitleEnableLabel");
    expect(subtitles.getAttribute("aria-checked")).toBe("true");
    await click(button("subtitleTop"));
    await click(button("captionPreset_minimal"));
    await click(switchFor(label));
    await click(button("composeStart"));
    const withCaptions = composeBodies().at(-1);
    expect(withCaptions).toMatchObject({ subtitles: true, captionPreset: "minimal", voiceoverMode: mode, freeTts: { enabled: true } });
    expectNoFreeBgm(withCaptions);

    await click(subtitles);
    expect(subtitles.getAttribute("aria-checked")).toBe("false");
    expect(switchFor("ttsEnableLabel").getAttribute("aria-checked")).toBe("true");
    expect(switchFor(label).getAttribute("aria-checked")).toBe("true");
    for (const key of ["subtitleBottom", "subtitleCenter", "subtitleTop", "captionPreset_standard", "captionPreset_bold", "captionPreset_minimal", "captionPreset_karaoke"]) {
      expect(button(key).disabled).toBe(true);
    }
    await click(button("composeStart"));
    const withoutCaptions = composeBodies().at(-1);
    expect(withoutCaptions).toMatchObject({ subtitles: false, voiceoverMode: mode, freeTts: withCaptions.freeTts });
    expectNoFreeBgm(withoutCaptions);

    await click([...container.querySelectorAll("button")].find((item) => item.textContent?.includes("matrixTitle"))!);
    await click(button("matrixRun"));
    expect(composeBodies().at(-1)).toMatchObject({ subtitles: false, voiceoverMode: mode, freeTts: withCaptions.freeTts });
    expectNoFreeBgm(composeBodies().at(-1));

    await click(switchFor("ttsEnableLabel"));
    expect(subtitles.getAttribute("aria-checked")).toBe("false");
    await click(subtitles);
    expect(button("subtitleTop").disabled).toBe(false);
    expect(button("captionPreset_minimal").disabled).toBe(false);
    await click(button("composeStart"));
    expect(composeBodies().at(-1)).toMatchObject({ subtitles: true, captionPreset: "minimal" });
    expect(composeBodies().at(-1)).not.toHaveProperty("freeTts");
    expect(composeBodies().at(-1)).not.toHaveProperty("voiceoverMode");
  });

  it("renders one caption-free matrix variant and restores the selected caption variants when enabled again", async () => {
    await mount();
    await click([...container.querySelectorAll("button")].find((item) => item.textContent?.includes("matrixTitle"))!);
    await click(button("bold"));
    await click(button("minimal"));
    await click(switchFor("subtitleEnableLabel"));
    expect(container.textContent).toContain("matrixNoSubtitles");
    await click(button("matrixRun"));
    expect(composeBodies()).toHaveLength(1);
    expect(composeBodies()[0]).toMatchObject({ subtitles: false, label: expect.stringContaining("matrixNoSubtitles") });

    await click(switchFor("subtitleEnableLabel"));
    await click(button("matrixRun"));
    const restored = composeBodies().slice(1);
    expect(restored).toHaveLength(3);
    expect(restored.map((body) => body.captionPreset)).toEqual(["standard", "bold", "minimal"]);
    expect(restored.every((body) => body.subtitles === true)).toBe(true);
  });

  it("keeps subtitles disabled when a style pack changes the caption style", async () => {
    await mount();
    await click(switchFor("ttsMixLabel"));
    await click(switchFor("subtitleEnableLabel"));
    await click(button("卡拉OK爆款"));
    expect(switchFor("subtitleEnableLabel").getAttribute("aria-checked")).toBe("false");
    expect(switchFor("ttsMixLabel").getAttribute("aria-checked")).toBe("true");
    await click(button("composeStart"));
    expect(composeBodies().at(-1)).toMatchObject({ subtitles: false, voiceoverMode: "mix", freeTts: { enabled: true } });
    expectNoFreeBgm(composeBodies().at(-1));

    await click(switchFor("subtitleEnableLabel"));
    await click(button("composeStart"));
    expect(composeBodies().at(-1)).toMatchObject({ subtitles: true, captionPreset: "karaoke", voiceoverMode: "mix" });
  });
});

describe("composition without automatic background music", () => {
  it("removes automatic music controls and matrix music variants while retaining narration grounding", async () => {
    await mount();
    expect(container.textContent).not.toContain("bgmSectionLabel");
    expect(container.textContent).not.toContain("bgmUpbeat");
    expect(container.querySelector('[aria-label="bgmVolumeLabel"]')).toBeNull();
    const grounding = switchFor("voiceGroundLabel");
    expect(grounding.getAttribute("aria-checked")).toBe("true");
    await click(grounding);
    await click(switchFor("ttsMixLabel"));
    await click(button("composeStart"));
    expect(composeBodies().at(-1)).toMatchObject({ voiceGround: false, voiceoverMode: "mix", freeTts: { enabled: true } });

    await click([...container.querySelectorAll("button")].find((item) => item.textContent?.includes("matrixTitle"))!);
    expect(container.textContent).not.toContain("matrixBgms");
    expect(button("upbeat")).toBeUndefined();
    expect(button("emotional")).toBeUndefined();
    await click(button("matrixRun"));
    expect(composeBodies()).toHaveLength(2);
    expect(composeBodies().at(-1)).toMatchObject({ voiceGround: false, voiceoverMode: "mix", freeTts: { enabled: true } });
    for (const body of composeBodies()) {
      expectNoFreeBgm(body);
      expect(body).not.toHaveProperty("bgmPath");
    }
    expect(composeBodies().at(-1).label).not.toMatch(/upbeat|emotional|energetic|chill/);
  });

  it("ignores legacy style-pack music mood in ordinary and matrix compositions", async () => {
    await mount();
    const legacyPack = new File([""], "legacy-style.json", { type: "application/json" });
    Object.defineProperty(legacyPack, "text", { value: async () => JSON.stringify({
      format: "clipforge-style-pack@1", name: "Legacy pack",
      compose: { captionPreset: "minimal", bgm: "emotional", bgmVolume: 0.3, bgmDuck: false },
    }) });
    const input = container.querySelector<HTMLInputElement>('input[type="file"][accept="application/json,.json"]')!;
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [legacyPack] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(button("composeStart"));
    await click([...container.querySelectorAll("button")].find((item) => item.textContent?.includes("matrixTitle"))!);
    await click(button("matrixRun"));
    expect(composeBodies()).toHaveLength(2);
    for (const body of composeBodies()) {
      expect(body).toMatchObject({ captionPreset: "minimal" });
      expectNoFreeBgm(body);
      expect(body).not.toHaveProperty("bgmPath");
    }
  });

  it("keeps uploaded music available for ordinary and matrix compositions", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url.endsWith("/bgm") && init?.method === "POST"
      ? Promise.resolve(Response.json({ path: "uploads/music.mp3", name: "My music.mp3" }))
      : normalFetch(url, init));
    await mount();
    const input = container.querySelector<HTMLInputElement>('input[type="file"][accept="audio/*"]')!;
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [new File(["music"], "My music.mp3", { type: "audio/mpeg" })] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector('[aria-label="bgmVolumeLabel"]')).not.toBeNull();
    await click(button("composeStart"));
    await click([...container.querySelectorAll("button")].find((item) => item.textContent?.includes("matrixTitle"))!);
    await click(button("matrixRun"));
    expect(composeBodies()).toHaveLength(2);
    for (const body of composeBodies()) {
      expect(body).toMatchObject({ bgmPath: "uploads/music.mp3", bgmVolume: 0.18, bgmDuck: true });
      expectNoFreeBgm(body);
    }
  });
});
