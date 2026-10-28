import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TTSSettings } from "@/components/settings/tts-settings";
import { ElevenLabsVoiceSelector } from "@/components/elevenlabs-voice-selector";
import { useSettingsStore } from "@/lib/stores/settings-store";
import type { ElevenLabsStatus } from "@/lib/elevenlabs/types";

const initial = useSettingsStore.getInitialState();
const fetchMock = vi.fn();
const catalog = {
  voices: [{ id: "clone_1", name: "我的克隆声音", category: "cloned" }, { id: "official_2", name: "Official voice" }],
  models: [{ id: "eleven_multilingual_v2", name: "Multilingual v2", languages: [] }],
};
let root: Root;
let container: HTMLDivElement;
let status: ElevenLabsStatus;

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function select(id: string, value: string) {
  await act(async () => {
    const element = container.querySelector(`#${id}`) as HTMLSelectElement;
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function render() { await act(async () => root.render(createElement(TTSSettings))); }
function enableCli(enabled = true) {
  useSettingsStore.getState().setTTS({ enabled, provider: "elevenlabs-cli", baseUrl: "", apiKey: "", voice: "", model: "" });
}
function postedCalls() { return fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"); }

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:settings-preview");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  fetchMock.mockReset();
  status = { installed: true, authenticated: false, auth: { state: "idle" } };
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith("/session")) return Response.json({ csrfToken: "settings-test-session" });
    if (url.endsWith("/status")) return Response.json(status);
    if (url.endsWith("/catalog")) return Response.json(catalog);
    if (url.endsWith("/auth")) { status = { ...status, auth: { state: "pending" } }; return Response.json({ accepted: true }); }
    if (url === "/api/tts" || url === "/api/tts/free") return new Response("mock-mp3", { headers: { "content-type": "audio/mpeg" } });
    throw new Error(`Unexpected fetch: ${url}`);
  });
  localStorage.clear();
  useSettingsStore.setState({ ...initial, locale: "zh", localeSource: "user" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useSettingsStore.setState(initial);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("voiceover settings", () => {
  it("offers exactly Microsoft and ElevenLabs, with no retired provider fields or automatic requests", async () => {
    await render();
    const provider = container.querySelector("#tts-provider") as HTMLSelectElement;
    expect([...provider.options].map((option) => option.textContent)).toEqual(["微软 TTS · 免费", "ElevenLabs · 克隆声音 / 官方 CLI"]);
    expect(provider.value).toBe("microsoft");
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.textContent).not.toMatch(/Atlas|MiniMax|fal\.ai|OpenAI|baseUrl|GroupId|API Key/);
    expect(container.querySelector("#tts-microsoft-voice")).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps provider visible while off and invokes no CLI calls until explicitly enabled", async () => {
    useSettingsStore.getState().setTTS({ enabled: false, provider: "microsoft", baseUrl: "", apiKey: "", voice: "", model: "" });
    await render();
    await select("tts-provider", "elevenlabs-cli");
    expect(container.textContent).toContain("ElevenLabs 已关闭");
    expect(container.querySelector("#tts-provider")).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().tts).toMatchObject({ enabled: false, provider: "elevenlabs-cli", apiKey: "", baseUrl: "" });
    await act(async () => (container.querySelector('[role="switch"]') as HTMLButtonElement).click());
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/status"))).toBe(true);
    expect(postedCalls()).toEqual([]);
    expect(button("连接 ElevenLabs")).toBeTruthy();
  });

  it("starts OAuth only on click, polls completion, then persists chosen voice and model", async () => {
    enableCli();
    await render();
    expect(postedCalls()).toEqual([]);
    expect(button("▶ 试听这个音色").disabled).toBe(true);
    vi.useFakeTimers();
    await act(async () => button("连接 ElevenLabs").click());
    expect(container.textContent).toContain("请在打开的浏览器中完成 ElevenLabs 授权");
    expect(postedCalls()).toHaveLength(1);
    expect(postedCalls()[0][0]).toBe("/api/integrations/elevenlabs/auth");
    expect(new Headers(postedCalls()[0][1].headers).get("X-Clipforge-ElevenLabs-CSRF")).toBe("settings-test-session");
    status = { installed: true, authenticated: true, auth: { state: "success" } };
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(container.textContent).toContain("ElevenLabs 已连接");
    expect(button("▶ 试听这个音色").disabled).toBe(true);
    await select("elevenlabs-voice", "clone_1");
    await select("elevenlabs-model", "eleven_multilingual_v2");
    expect(useSettingsStore.getState().tts).toMatchObject({ provider: "elevenlabs-cli", enabled: true, voice: "clone_1", model: "eleven_multilingual_v2", apiKey: "", baseUrl: "" });
    expect(JSON.parse(localStorage.getItem("daihuo-jianshou-settings")!).state.tts.voice).toBe("clone_1");
    expect(button("▶ 试听这个音色").disabled).toBe(false);
    expect(postedCalls()).toHaveLength(1);
  });

  it("uses the signed helper for an explicit ElevenLabs preview and releases audio when disabled", async () => {
    status = { installed: true, authenticated: true, auth: { state: "success" } };
    enableCli();
    await render();
    await select("elevenlabs-voice", "clone_1");
    await select("elevenlabs-model", "eleven_multilingual_v2");
    expect(postedCalls()).toEqual([]);
    await act(async () => button("▶ 试听这个音色").click());
    const [url, options] = postedCalls()[0];
    expect(url).toBe("/api/tts");
    expect(new Headers(options.headers).get("X-Clipforge-ElevenLabs-CSRF")).toBe("settings-test-session");
    expect(JSON.parse(options.body).ttsConfig).toEqual({ provider: "elevenlabs-cli", baseUrl: "", apiKey: "", model: "eleven_multilingual_v2", voice: "clone_1", speed: 1 });
    expect(container.querySelector("audio")?.getAttribute("src")).toBe("blob:settings-preview");
    await act(async () => (container.querySelector('[role="switch"]') as HTMLButtonElement).click());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:settings-preview");
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(container.querySelector("audio")).toBeNull();
  });

  it("supports explicit reconnect and keeps preview disabled after an expired login", async () => {
    status = { installed: true, authenticated: true, auth: { state: "success" } };
    enableCli();
    await render();
    await select("elevenlabs-voice", "clone_1");
    await select("elevenlabs-model", "eleven_multilingual_v2");
    vi.useFakeTimers();
    await act(async () => button("重新连接 ElevenLabs").click());
    expect(postedCalls().map(([url]) => url)).toEqual(["/api/integrations/elevenlabs/auth"]);
    expect(button("▶ 试听这个音色").disabled).toBe(true);
    status = { installed: true, authenticated: false, auth: { state: "error", message: "授权已过期" } };
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(container.textContent).toContain("授权已过期");
    expect(button("连接 ElevenLabs")).toBeTruthy();
    expect(button("▶ 试听这个音色").disabled).toBe(true);
    expect(postedCalls()).toHaveLength(1);
  });

  it("blocks previews for saved IDs absent from the current account", async () => {
    status = { installed: true, authenticated: true, auth: { state: "success" } };
    useSettingsStore.getState().setTTS({ enabled: true, provider: "elevenlabs-cli", baseUrl: "", apiKey: "", voice: "old_account_clone", model: "eleven_multilingual_v2" });
    await render();
    expect((container.querySelector("#elevenlabs-voice") as HTMLSelectElement).value).toBe("");
    expect(button("▶ 试听这个音色").disabled).toBe(true);
    expect(postedCalls()).toEqual([]);
  });

  it("localizes both provider labels in English", async () => {
    useSettingsStore.setState({ locale: "en" });
    await render();
    const provider = container.querySelector("#tts-provider") as HTMLSelectElement;
    expect([...provider.options].map((option) => option.textContent)).toEqual(["Microsoft TTS · Free", "ElevenLabs · Voice cloning / Official CLI"]);
  });

  it("previews Microsoft's selected voice through the free route only after a click", async () => {
    await render();
    await select("tts-microsoft-voice", "en-US-JennyNeural");
    expect(useSettingsStore.getState().tts.voice).toBe("en-US-JennyNeural");
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => button("▶ 试听这个音色").click());
    expect(postedCalls()[0][0]).toBe("/api/tts/free");
    expect(JSON.parse(postedCalls()[0][1].body).voice).toBe("en-US-JennyNeural");
  });

  it.each([
    { locale: "zh" as const, voice: "en-US-EricNeural", sample: /Hello! Discover/, buttonText: "▶ 试听这个音色" },
    { locale: "en" as const, voice: "zh-CN-XiaoxiaoNeural", sample: /你好/, buttonText: "▶ Preview this voice" },
  ])("previews $voice in its own language with the $locale interface", async ({ locale, voice, sample, buttonText }) => {
    useSettingsStore.setState({ locale });
    useSettingsStore.getState().setTTS({ enabled: true, provider: "microsoft", baseUrl: "", apiKey: "", model: "", voice });
    await render();
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => button(buttonText).click());
    const [url, init] = postedCalls()[0];
    expect(url).toBe("/api/tts/free");
    expect(JSON.parse(init.body)).toMatchObject({ voice, text: expect.stringMatching(sample) });
    expect(container.querySelector("audio")).not.toBeNull();
  });

  it("renders the read-only video selector with a settings link and no OAuth control", async () => {
    await act(async () => root.render(createElement(ElevenLabsVoiceSelector, { voice: "", model: "", allowLogin: false, onVoiceChange: vi.fn(), onModelChange: vi.fn(), onReadyChange: vi.fn() })));
    expect(container.querySelector('a[href="/settings?tab=tts"]')).not.toBeNull();
    expect(container.textContent).toContain("前往设置 → 配音");
    expect([...container.querySelectorAll("button")].some((item) => item.textContent === "连接 ElevenLabs")).toBe(false);
    expect(postedCalls()).toEqual([]);
  });
});
