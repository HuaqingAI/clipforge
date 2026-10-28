import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import VideoPage from "@/app/project/[id]/video/page";
import { createTideweOutdoorProfile, createPremiumProductCgProfile } from "@/lib/creative-profiles";
import { AD_TEMPLATES, adTemplateStorageKey, adTemplateAppliedKey } from "@/lib/ad-templates";
import { elevenLabsFetch } from "@/lib/elevenlabs/browser-client";
import { video } from "@/lib/i18n/messages/video";

const settingsState = vi.hoisted(() => ({ paidTts: false, enabled: true, provider: "microsoft", voice: "", model: "" }));
const uiState = vi.hoisted(() => ({ locale: "zh" }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "project-1" }) }));
vi.mock("@/lib/i18n", () => ({ useT: () => (key: string) => key, useLocale: () => uiState.locale }));
vi.mock("@/components/project-header", () => ({ ProjectHeader: () => null }));
vi.mock("@/lib/elevenlabs/browser-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/elevenlabs/browser-client")>(),
  elevenLabsFetch: vi.fn((await importOriginal<typeof import("@/lib/elevenlabs/browser-client")>()).elevenLabsFetch),
}));
vi.mock("@/components/free-voice-preview", () => ({
  FreeVoicePreview: ({ voice, text }: { voice: string; text: string }) => <div data-testid="voice-preview" data-voice={voice}>{text}</div>,
}));
vi.mock("@/lib/stores/settings-store", () => ({
  useSettingsStore: () => ({
    defaultResolution: "1080p", defaultAspectRatio: "9:16", providers: {},
    tts: { enabled: settingsState.enabled, provider: settingsState.paidTts ? "openai" : settingsState.provider, apiKey: settingsState.paidTts ? "test-key" : "", baseUrl: "", model: settingsState.model, voice: settingsState.voice },
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
async function select(label: string, value: string) {
  const control = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  await act(async () => { control.value = value; control.dispatchEvent(new Event("change", { bubbles: true })); });
}
function composeBodies() {
  return fetchMock.mock.calls
    .filter(([url, init]) => url === "/api/project/project-1/compose" && init?.method === "POST")
    .map(([, init]) => JSON.parse(init.body));
}
function previewRequests() {
  return fetchMock.mock.calls.filter(([url, init]) => url === "/api/tts" && init?.method === "POST");
}
function expectNoFreeBgm(body: object) {
  expect(body).not.toHaveProperty("freeBgm");
  expect(body).not.toHaveProperty("bgmMood");
}
async function mount() { await act(async () => root.render(<VideoPage />)); }
function loadTidewe(speechMode: "on_camera" | "voiceover" = "on_camera") {
  const normalFetch = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((url: string, init?: RequestInit) => url === "/api/project/project-1"
    ? Promise.resolve(Response.json({ name: "TIDEWE", creativeProfile: createTideweOutdoorProfile({ speechMode }) }))
    : normalFetch(url, init));
}

beforeEach(() => {
  uiState.locale = "zh";
  Object.assign(settingsState, { paidTts: false, enabled: true, provider: "microsoft", voice: "", model: "" });
  vi.mocked(elevenLabsFetch).mockClear();
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:video-preview");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/integrations/elevenlabs/session") return Response.json({ csrfToken: "signed-local-session" });
    if (url === "/api/project/project-1") return Response.json({ name: "Test project" });
    if (url.endsWith("/scripts")) return Response.json([{ id: "script-1", selected: true, shots: [{ shotId: 1, type: "hook", duration: 5, voiceover: "Test narration", transition: "direct_concat" }] }]);
    if (url.split("?")[0].endsWith("/assets")) return Response.json([]);
    if (url === "/api/tts") return new Response("mock-mp3", { headers: { "content-type": "audio/mpeg" } });
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("settings-owned voice services", () => {
  function connectElevenLabs() {
    settingsState.provider = "elevenlabs-cli";
    const state = {
      authenticated: true, authState: "idle", error: "", errorStatus: 503,
      voices: [{ id: "cloned-voice", name: "My cloned voice", category: "cloned" }],
      models: [{ id: "eleven_multilingual_v2", name: "Eleven Multilingual v2" }],
    };
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/integrations/elevenlabs/status") return Promise.resolve(Response.json({ installed: true, authenticated: state.authenticated, auth: { state: state.authState } }));
      if (url === "/api/integrations/elevenlabs/catalog") return Promise.resolve(state.error
        ? Response.json({ error: { message: state.error } }, { status: state.errorStatus })
        : Response.json({ voices: state.voices, models: state.models }));
      return normalFetch(url, init);
    });
    return state;
  }
  async function chooseElevenLabs() {
    await select("ttsServiceLabel", "elevenlabs-cli");
    await select("elevenLabsVoiceLabel", "cloned-voice");
    await select("elevenLabsModelLabel", "eleven_multilingual_v2");
  }
  async function openMatrix() {
    await click([...container.querySelectorAll("button")].find((item) => item.textContent?.includes("matrixTitle"))!);
  }
  function expectSettingsLink() {
    expect(container.querySelector('a[href="/settings?tab=tts"]')).not.toBeNull();
    expect(button("elevenLabsLogin")).toBeUndefined();
    expect(button("elevenLabsReconnect")).toBeUndefined();
    expect(fetchMock.mock.calls.filter(([url, init]) => url.endsWith("/elevenlabs/auth") && init?.method === "POST")).toHaveLength(0);
  }

  it("offers exactly Microsoft and ElevenLabs, defaults to settings, and keeps automatic defaults out of project overrides", async () => {
    await mount();
    const service = container.querySelector<HTMLSelectElement>('[aria-label="ttsServiceLabel"]')!;
    expect([...service.options].map((option) => [option.value, option.textContent])).toEqual([
      ["microsoft", "ttsServiceMicrosoft"], ["elevenlabs-cli", "ttsServiceElevenLabs"],
    ]);
    expect(video.zh.ttsServiceMicrosoft).toBe("微软 TTS · 免费");
    expect(video.zh.ttsServiceElevenLabs).toBe("ElevenLabs · 克隆声音 / 官方 CLI");
    expect(service.value).toBe("microsoft");
    expect(localStorage.getItem("clipforge:project:project-1:voiceover")).toBeNull();
    connectElevenLabs();
    settingsState.voice = "cloned-voice";
    settingsState.model = "eleven_multilingual_v2";
    await mount();
    expect(service.value).toBe("elevenlabs-cli");
    expect(container.querySelector<HTMLSelectElement>('[aria-label="elevenLabsVoiceLabel"]')!.value).toBe("cloned-voice");
    expect(container.querySelector<HTMLSelectElement>('[aria-label="elevenLabsModelLabel"]')!.value).toBe("eleven_multilingual_v2");
    expect(button("composeStart").disabled).toBe(false);
    expect(localStorage.getItem("clipforge:project:project-1:voiceover")).toBeNull();
    expectSettingsLink();
  });

  it.each(["en-US-GuyNeural", "en-US-AriaNeural"])("uses the Microsoft settings voice %s for preview and compose", async (voice) => {
    settingsState.voice = voice;
    await mount();
    expect(container.querySelector('[data-testid="voice-preview"]')!.getAttribute("data-voice")).toBe(voice);
    await click(button("composeStart"));
    expect(composeBodies().at(-1)).toMatchObject({ freeTts: { enabled: true, voice } });
    expect(composeBodies().at(-1)).not.toHaveProperty("ttsConfig");
  });

  it.each([
    { locale: "zh", voice: "en-US-EricNeural", sample: /Hello! Discover/ },
    { locale: "en", voice: "zh-CN-XiaoxiaoNeural", sample: /你好/ },
  ])("matches $voice preview text to the voice with the $locale interface", async ({ locale, voice, sample }) => {
    uiState.locale = locale;
    settingsState.voice = voice;
    await mount();
    const preview = container.querySelector('[data-testid="voice-preview"]')!;
    expect(preview.getAttribute("data-voice")).toBe(voice);
    expect(preview.textContent).toMatch(sample);
  });

  it("updates the Microsoft default until the project's free voice is explicitly changed", async () => {
    settingsState.voice = "en-US-GuyNeural";
    await mount();
    settingsState.voice = "en-US-AriaNeural";
    await mount();
    expect(container.querySelector('[data-testid="voice-preview"]')!.getAttribute("data-voice")).toBe("en-US-AriaNeural");
    await click(container.querySelector<HTMLButtonElement>('[aria-label="ttsVoiceLabel"]')!);
    const jenny = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.includes("Jenny"))!;
    await act(async () => jenny.focus());
    await click(jenny);
    expect(container.querySelector('[data-testid="voice-preview"]')!.getAttribute("data-voice")).toBe("en-US-JennyNeural");
    settingsState.voice = "en-US-ChristopherNeural";
    await mount();
    expect(container.querySelector('[data-testid="voice-preview"]')!.getAttribute("data-voice")).toBe("en-US-JennyNeural");
  });

  it("uses the global disabled default for ordinary projects while allowing composition without narration", async () => {
    settingsState.enabled = false;
    settingsState.provider = "elevenlabs-cli";
    await mount();
    expect(switchFor("ttsEnableLabel").getAttribute("aria-checked")).toBe("false");
    expect(button("composeStart").disabled).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => url.includes("/elevenlabs/"))).toBe(false);
    await click(button("composeStart"));
    expect(composeBodies().at(-1)).not.toHaveProperty("ttsConfig");
    expect(composeBodies().at(-1)).not.toHaveProperty("freeTts");
    await click(switchFor("ttsEnableLabel"));
    expect(button("composeStart").disabled).toBe(true);
    expectSettingsLink();
  });

  it.each(["disabled", "different-provider"])("blocks both compose paths when ElevenLabs is %s in settings without calling its CLI", async (reason) => {
    settingsState.enabled = reason !== "disabled";
    settingsState.provider = reason === "disabled" ? "elevenlabs-cli" : "microsoft";
    await mount();
    if (!settingsState.enabled) await click(switchFor("ttsEnableLabel"));
    await select("ttsServiceLabel", "elevenlabs-cli");
    expect(button("composeStart").disabled).toBe(true);
    await openMatrix();
    expect(button("matrixRun").disabled).toBe(true);
    expect(container.textContent).toContain("elevenLabsSettingsRequired");
    expectSettingsLink();
    expect(fetchMock.mock.calls.some(([url]) => url.includes("/elevenlabs/"))).toBe(false);
    expect(composeBodies()).toHaveLength(0);
  });

  it("requires an available voice and model, then sends the signed local session on ordinary and matrix compose", async () => {
    connectElevenLabs();
    await mount();
    expect(button("composeStart").disabled).toBe(true);
    expect(container.querySelector('[data-testid="voice-preview"]')).toBeNull();
    expect(container.textContent).toContain("My cloned voice · elevenLabsClonedVoice");
    await select("elevenLabsVoiceLabel", "cloned-voice");
    expect(button("composeStart").disabled).toBe(true);
    await select("elevenLabsModelLabel", "eleven_multilingual_v2");
    expect(button("composeStart").disabled).toBe(false);
    await click(button("composeStart"));
    await openMatrix();
    await click(button("matrixRun"));
    expect(composeBodies()).toHaveLength(2);
    for (const body of composeBodies()) {
      expect(body.ttsConfig).toEqual({ provider: "elevenlabs-cli", baseUrl: "", apiKey: "", voice: "cloned-voice", model: "eleven_multilingual_v2" });
      expect(body).not.toHaveProperty("freeTts");
    }
    const requests = fetchMock.mock.calls.filter(([url, init]) => url.endsWith("/compose") && init?.method === "POST");
    for (const [, init] of requests) expect(new Headers(init.headers).get("x-clipforge-elevenlabs-csrf")).toBe("signed-local-session");
    expect(vi.mocked(elevenLabsFetch).mock.calls.filter(([url, init]) => url.endsWith("/compose") && init?.method === "POST")).toHaveLength(2);
    expectSettingsLink();
  });

  it("previews ElevenLabs only after selecting both voice and model and explicitly clicking, using the signed session", async () => {
    connectElevenLabs();
    await mount();
    expect(button("ttsPreviewCta").disabled).toBe(true);
    await click(button("ttsPreviewCta"));
    expect(previewRequests()).toHaveLength(0);
    await select("elevenLabsVoiceLabel", "cloned-voice");
    expect(button("ttsPreviewCta").disabled).toBe(true);
    await select("elevenLabsModelLabel", "eleven_multilingual_v2");
    expect(button("ttsPreviewCta").disabled).toBe(false);
    expect(previewRequests()).toHaveLength(0);

    await click(button("ttsPreviewCta"));
    expect(previewRequests()).toHaveLength(1);
    const [url, init] = previewRequests()[0];
    expect(url).toBe("/api/tts");
    expect(new Headers(init.headers).get("X-Clipforge-ElevenLabs-CSRF")).toBe("signed-local-session");
    expect(JSON.parse(init.body)).toEqual({
      text: "ttsSample",
      ttsConfig: { provider: "elevenlabs-cli", baseUrl: "", apiKey: "", voice: "cloned-voice", model: "eleven_multilingual_v2" },
    });
    expect(vi.mocked(elevenLabsFetch).mock.calls.filter(([target]) => target === "/api/tts")).toHaveLength(1);
    const audio = container.querySelector<HTMLAudioElement>('audio[aria-label="ttsPreviewPlayer"]');
    expect(audio?.getAttribute("src")).toBe("blob:video-preview");
    expect(audio?.controls).toBe(true);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    expect(composeBodies()).toHaveLength(0);
  });

  it.each([
    { field: "voice", label: "elevenLabsVoiceLabel", value: "second-clone" },
    { field: "model", label: "elevenLabsModelLabel", value: "eleven_v3" },
  ])("clears the previous audio when the ElevenLabs $field changes and waits for another manual preview", async ({ field, label, value }) => {
    const account = connectElevenLabs();
    account.voices.push({ id: "second-clone", name: "Second clone", category: "cloned" });
    account.models.push({ id: "eleven_v3", name: "Eleven v3" });
    await mount();
    await chooseElevenLabs();
    await click(button("ttsPreviewCta"));
    const oldAudio = container.querySelector<HTMLAudioElement>("audio")!;
    expect(oldAudio).not.toBeNull();

    await select(label, value);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
    expect(oldAudio.getAttribute("src")).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:video-preview");
    expect(container.querySelector("audio")).toBeNull();
    expect(previewRequests()).toHaveLength(1);
    expect(button("ttsPreviewCta").disabled).toBe(false);

    await click(button("ttsPreviewCta"));
    expect(previewRequests()).toHaveLength(2);
    expect(JSON.parse(previewRequests()[1][1].body).ttsConfig[field]).toBe(value);
  });

  it("shows an ElevenLabs preview error without starting composition or retrying generation automatically", async () => {
    connectElevenLabs();
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === "/api/tts"
      ? Promise.resolve(Response.json({ error: "Voice preview unavailable" }, { status: 502 }))
      : normalFetch(url, init));
    await mount();
    await chooseElevenLabs();
    await click(button("ttsPreviewCta"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Voice preview unavailable");
    expect(container.querySelector("audio")).toBeNull();
    expect(button("ttsPreviewCta").disabled).toBe(false);
    expect(previewRequests()).toHaveLength(1);
    expect(composeBodies()).toHaveLength(0);
  });

  it("aborts a pending preview when the ElevenLabs model changes and ignores its late audio response", async () => {
    const account = connectElevenLabs();
    account.models.push({ id: "eleven_v3", name: "Eleven v3" });
    const normalFetch = fetchMock.getMockImplementation()!;
    let finishPreview!: (value: Response) => void;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === "/api/tts"
      ? new Promise<Response>((resolve) => { finishPreview = resolve; })
      : normalFetch(url, init));
    await mount();
    await chooseElevenLabs();
    await click(button("ttsPreviewCta"));
    expect(previewRequests()).toHaveLength(1);
    expect(button("ttsPreviewing").disabled).toBe(true);
    const pendingSignal = previewRequests()[0][1].signal as AbortSignal;
    expect(pendingSignal.aborted).toBe(false);

    await select("elevenLabsModelLabel", "eleven_v3");
    expect(pendingSignal.aborted).toBe(true);
    expect(button("ttsPreviewCta").disabled).toBe(false);
    await act(async () => finishPreview(new Response("late-mp3", { headers: { "content-type": "audio/mpeg" } })));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(container.querySelector("audio")).toBeNull();
    expect(previewRequests()).toHaveLength(1);
    expect(composeBodies()).toHaveLength(0);
  });

  it("keeps the TIDEWE English sample for a manual ElevenLabs preview", async () => {
    connectElevenLabs();
    loadTidewe();
    await mount();
    await chooseElevenLabs();
    expect(previewRequests()).toHaveLength(0);
    await click(button("ttsPreviewCta"));
    expect(JSON.parse(previewRequests()[0][1].body).text).toMatch(/cold morning/i);
  });

  it("keeps readiness when settings switch between two available default voices", async () => {
    const account = connectElevenLabs();
    account.voices.push({ id: "second-clone", name: "Second clone", category: "cloned" });
    settingsState.voice = "cloned-voice";
    settingsState.model = "eleven_multilingual_v2";
    await mount();
    expect(button("composeStart").disabled).toBe(false);
    settingsState.voice = "second-clone";
    await mount();
    expect(button("composeStart").disabled).toBe(false);
    await click(button("composeStart"));
    expect(composeBodies().at(-1).ttsConfig.voice).toBe("second-clone");
  });

  it("restores explicit project voice choices and validates them against the account again", async () => {
    connectElevenLabs();
    await mount();
    await chooseElevenLabs();
    const saved = JSON.parse(localStorage.getItem("clipforge:project:project-1:voiceover")!);
    expect(saved).toEqual({ voiceService: "elevenlabs-cli", elevenLabsVoice: "cloned-voice", elevenLabsModel: "eleven_multilingual_v2" });
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount();
    expect(container.querySelector<HTMLSelectElement>('[aria-label="ttsServiceLabel"]')!.value).toBe("elevenlabs-cli");
    expect(container.querySelector<HTMLSelectElement>('[aria-label="elevenLabsVoiceLabel"]')!.value).toBe("cloned-voice");
    expect(button("composeStart").disabled).toBe(false);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/elevenlabs/status"))).toHaveLength(2);
  });

  it("does not compose restored choices before the fresh account catalog loads", async () => {
    localStorage.setItem("clipforge:project:project-1:voiceover", JSON.stringify({ voiceService: "elevenlabs-cli", elevenLabsVoice: "cloned-voice", elevenLabsModel: "eleven_multilingual_v2" }));
    connectElevenLabs();
    const normalFetch = fetchMock.getMockImplementation()!;
    let finishCatalog!: (value: Response) => void;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url.endsWith("/elevenlabs/catalog")
      ? new Promise<Response>((resolve) => { finishCatalog = resolve; }) : normalFetch(url, init));
    await mount();
    expect(button("composeStart").disabled).toBe(true);
    await act(async () => finishCatalog(Response.json({ voices: [{ id: "cloned-voice", name: "Available voice" }], models: [{ id: "eleven_multilingual_v2", name: "Available model" }] })));
    expect(button("composeStart").disabled).toBe(false);
  });

  it("directs signed-out users to settings and blocks normal and matrix compose without starting OAuth", async () => {
    const account = connectElevenLabs();
    account.authenticated = false;
    await mount();
    expect(button("composeStart").disabled).toBe(true);
    await openMatrix();
    expect(button("matrixRun").disabled).toBe(true);
    expect(container.querySelector('[aria-label="elevenLabsVoiceLabel"]')).toBeNull();
    expectSettingsLink();
    expect(composeBodies()).toHaveLength(0);
  });

  it("directs expired credentials to settings and allows a successful account refresh", async () => {
    localStorage.setItem("clipforge:project:project-1:voiceover", JSON.stringify({ voiceService: "elevenlabs-cli", elevenLabsVoice: "cloned-voice", elevenLabsModel: "eleven_multilingual_v2" }));
    const account = connectElevenLabs();
    account.error = "ElevenLabs authorization expired";
    account.errorStatus = 401;
    await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("ElevenLabs authorization expired");
    expect(button("composeStart").disabled).toBe(true);
    expectSettingsLink();
    account.error = "";
    await click(button("elevenLabsRefresh"));
    expect(button("composeStart").disabled).toBe(false);
    expect(composeBodies()).toHaveLength(0);
  });

  it("invalidates unavailable account voices after refresh until selecting a replacement", async () => {
    const account = connectElevenLabs();
    await mount();
    await chooseElevenLabs();
    account.voices = [{ id: "new-account-voice", name: "Another account", category: "professional" }];
    await click(button("elevenLabsRefresh"));
    expect(button("composeStart").disabled).toBe(true);
    await select("elevenLabsVoiceLabel", "new-account-voice");
    expect(button("composeStart").disabled).toBe(false);
    await click(button("composeStart"));
    expect(composeBodies().at(-1).ttsConfig.voice).toBe("new-account-voice");
  });

  it("can choose Microsoft free TTS despite the ElevenLabs default and can disable narration while signed out", async () => {
    const account = connectElevenLabs();
    account.authenticated = false;
    await mount();
    await select("ttsServiceLabel", "microsoft");
    await click(button("composeStart"));
    expect(composeBodies().at(-1)).toMatchObject({ freeTts: { enabled: true, voice: "zh-CN-XiaoxiaoNeural" } });
    expect(composeBodies().at(-1)).not.toHaveProperty("ttsConfig");
    await select("ttsServiceLabel", "elevenlabs-cli");
    expect(button("composeStart").disabled).toBe(true);
    await click(switchFor("ttsEnableLabel"));
    expect(button("composeStart").disabled).toBe(false);
    await click(button("composeStart"));
    expect(composeBodies().at(-1)).not.toHaveProperty("ttsConfig");
    expect(composeBodies().at(-1)).not.toHaveProperty("freeTts");
  });

  it("supports ElevenLabs fallback for native TIDEWE without changing its original audio preference", async () => {
    connectElevenLabs();
    loadTidewe();
    await mount();
    await chooseElevenLabs();
    await click(button("composeStart"));
    expect(composeBodies().at(-1)).toMatchObject({ nativeAudio: true, ttsEnabled: true, voiceoverMode: "auto", ttsConfig: { provider: "elevenlabs-cli", voice: "cloned-voice" } });
    expect(composeBodies().at(-1)).not.toHaveProperty("freeTts");
  });

  it("preserves premium CG's disabled narration without reading ElevenLabs", async () => {
    settingsState.provider = "elevenlabs-cli";
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === "/api/project/project-1"
      ? Promise.resolve(Response.json({ name: "Premium", creativeProfile: createPremiumProductCgProfile() })) : normalFetch(url, init));
    await mount();
    expect(container.querySelector('[aria-label="ttsServiceLabel"]')).toBeNull();
    await click(button("composeStart"));
    expect(composeBodies().at(-1)).not.toHaveProperty("ttsConfig");
    expect(composeBodies().at(-1)).not.toHaveProperty("freeTts");
    expect(fetchMock.mock.calls.some(([url]) => url.includes("/elevenlabs/"))).toBe(false);
  });

  it.each(["auto", "unknown"])("normalizes old %s project selections to the current settings without storing invalid voice fields", async (voiceService) => {
    localStorage.setItem("clipforge:project:project-1:voiceover", JSON.stringify({ voiceService, elevenLabsVoice: { id: "not-a-string" }, elevenLabsModel: 123 }));
    connectElevenLabs();
    settingsState.voice = "cloned-voice";
    settingsState.model = "eleven_multilingual_v2";
    await mount();
    expect(container.querySelector<HTMLSelectElement>('[aria-label="ttsServiceLabel"]')!.value).toBe("elevenlabs-cli");
    expect(button("composeStart").disabled).toBe(false);
  });

  it("normalizes retired paid settings to Microsoft without submitting their API configuration", async () => {
    settingsState.paidTts = true;
    await mount();
    expect(container.querySelector<HTMLSelectElement>('[aria-label="ttsServiceLabel"]')!.value).toBe("microsoft");
    await click(button("composeStart"));
    expect(composeBodies().at(-1)).toMatchObject({ freeTts: { enabled: true } });
    expect(composeBodies().at(-1)).not.toHaveProperty("ttsConfig");
  });
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
    expect(switchFor("ttsEnableLabel").disabled).toBe(false);
    expect(switchFor("ttsReplaceLabel").getAttribute("aria-checked")).toBe("true");
    expect(switchFor("voiceGroundLabel").getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).not.toContain("matrixTitle");
    await click(button("composeStart"));
    const body = composeBodies().at(-1);
    expect(body).toMatchObject({ subtitles: false, ttsEnabled: true, voiceoverMode: "replace", voiceGround: false, freeTts: { enabled: true, voice: "en-US-GuyNeural" }, renderPreset: "fast", aspectRatio: "9:16" });
    expect(body).not.toHaveProperty("ctaText");
    expect(body).not.toHaveProperty("productCard");
    await click(switchFor("subtitleEnableLabel"));
    await click(button("composeStart"));
    expect(composeBodies().at(-1)).toMatchObject({ subtitles: true, captionPreset: "minimal" });
  });
  it.each([false, true])("requests English fallback and prefers native audio even with paid TTS configured: %s", async paidTts => {
    settingsState.paidTts = paidTts;
    loadTidewe();
    await mount();
    expect(switchFor("ttsEnableLabel").disabled).toBe(false);
    expect(switchFor("ttsEnableLabel").getAttribute("aria-checked")).toBe("true");
    expect(switchFor("ttsReplaceLabel").disabled).toBe(false);
    expect(switchFor("ttsReplaceLabel").getAttribute("aria-checked")).toBe("false");
    expect(switchFor("ttsMixLabel").getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("ttsFreeBadge");
    await click(button("composeStart"));
    const body = composeBodies().at(-1);
    expect(body).toMatchObject({ nativeAudio: true, ttsEnabled: true, voiceoverMode: "auto", subtitles: true, freeTts: { enabled: true, voice: "en-US-GuyNeural" } });
    expect(body).not.toHaveProperty("ttsConfig");
  });
  it.each(["on_camera", "voiceover"] as const)("allows all narration modes and disabling TTS for TIDEWE %s", async speechMode => {
    loadTidewe(speechMode);
    await mount();
    const replace = switchFor("ttsReplaceLabel");
    const mix = switchFor("ttsMixLabel");
    expect(replace.getAttribute("aria-checked")).toBe(String(speechMode === "voiceover"));
    if (speechMode === "on_camera") await click(replace);
    await click(button("composeStart"));
    expect(composeBodies().at(-1)).toMatchObject({ ttsEnabled: true, voiceoverMode: "replace", freeTts: { enabled: true } });

    await click(mix);
    expect(replace.getAttribute("aria-checked")).toBe("false");
    expect(mix.getAttribute("aria-checked")).toBe("true");
    await click(button("composeStart"));
    expect(composeBodies().at(-1)).toMatchObject({ ttsEnabled: true, voiceoverMode: "mix", freeTts: { enabled: true } });
    await click(mix);
    await click(button("composeStart"));
    expect(composeBodies().at(-1)).toMatchObject({ ttsEnabled: true, voiceoverMode: "auto", freeTts: { enabled: true } });

    await click(switchFor("ttsEnableLabel"));
    expect(replace.disabled).toBe(true);
    expect(mix.disabled).toBe(true);
    expect(container.querySelector('[data-testid="voice-preview"]')).toBeNull();
    await click(button("composeStart"));
    const disabled = composeBodies().at(-1);
    expect(disabled).toMatchObject({ ttsEnabled: false });
    for (const field of ["ttsConfig", "freeTts", "voiceoverMode"]) expect(disabled).not.toHaveProperty(field);
    await click(switchFor("ttsEnableLabel"));
    expect(replace.disabled).toBe(false);
    expect(mix.disabled).toBe(false);
  });
  it.each([
    { speechMode: "on_camera", paidTts: false },
    { speechMode: "on_camera", paidTts: true },
    { speechMode: "voiceover", paidTts: false },
    { speechMode: "voiceover", paidTts: true },
  ] as const)("uses the chosen English voice for preview and $speechMode composition with paid TTS=$paidTts", async ({ speechMode, paidTts }) => {
    settingsState.paidTts = paidTts;
    loadTidewe(speechMode);
    await mount();
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="ttsVoiceLabel"]')!;
    expect(trigger).not.toBeNull();
    await click(trigger);
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.length).toBeGreaterThan(2);
    expect(options.some(option => option.textContent?.includes("Guy"))).toBe(true);
    expect(options.some(option => option.textContent?.includes("Aria"))).toBe(true);
    const selected = options.find(option => option.textContent?.includes("Jenny"));
    expect(selected).toBeTruthy();
    expect(options.some(option => /晓晓|Xiaoxiao|云希|Yunxi|日本語|한국어|Español/.test(option.textContent ?? ""))).toBe(false);
    await act(async () => selected!.focus());
    await click(selected!);
    expect(trigger.textContent).toContain("Jenny");
    const preview = container.querySelector('[data-testid="voice-preview"]')!;
    expect(preview.getAttribute("data-voice")).toBe("en-US-JennyNeural");
    expect(preview.textContent).toMatch(/cold morning/i);
    await click(button("composeStart"));
    const body = composeBodies().at(-1);
    expect(body).toMatchObject({ ttsEnabled: true, voiceoverMode: speechMode === "on_camera" ? "auto" : "replace", freeTts: { enabled: true, voice: "en-US-JennyNeural" } });
    expect(body).not.toHaveProperty("ttsConfig");
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
    expect(grounding.getAttribute("aria-checked")).toBe("false");
    await click(switchFor("ttsMixLabel"));
    await click(button("composeStart"));
    expect(composeBodies().at(-1)).toMatchObject({ voiceGround: false, voiceoverMode: "mix", freeTts: { enabled: true } });

    await click(grounding);
    expect(grounding.getAttribute("aria-checked")).toBe("true");
    await click(button("composeStart"));
    expect(composeBodies().at(-1)).toMatchObject({ voiceGround: true, voiceoverMode: "mix", freeTts: { enabled: true } });

    await click([...container.querySelectorAll("button")].find((item) => item.textContent?.includes("matrixTitle"))!);
    expect(container.textContent).not.toContain("matrixBgms");
    expect(button("upbeat")).toBeUndefined();
    expect(button("emotional")).toBeUndefined();
    await click(button("matrixRun"));
    expect(composeBodies()).toHaveLength(3);
    expect(composeBodies().at(-1)).toMatchObject({ voiceGround: true, voiceoverMode: "mix", freeTts: { enabled: true } });
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
