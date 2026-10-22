import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FreeVoicePreview } from "@/components/free-voice-preview";

const { translate } = vi.hoisted(() => ({ translate: (key: string) => key }));
vi.mock("@/lib/i18n", () => ({ useT: () => translate }));

const fetchMock = vi.fn();
const createUrl = vi.fn();
const revokeUrl = vi.fn();
const OriginalURL = URL;
let root: Root | null;
let container: HTMLDivElement;
let play: ReturnType<typeof vi.spyOn>;
let pause: ReturnType<typeof vi.spyOn>;

function audioResponse() {
  return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "audio/mpeg" } });
}

async function render(voice = "zh-CN-XiaoxiaoNeural", locale = "zh") {
  await act(async () => root!.render(createElement(FreeVoicePreview, {
    key: `${voice}:${locale}`,
    voice,
    text: locale === "zh" ? "中文试听" : "English preview",
  })));
}

async function preview() {
  await act(async () => container.querySelector("button")!.click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("URL", Object.assign(class extends OriginalURL {}, {
    createObjectURL: createUrl,
    revokeObjectURL: revokeUrl,
  }));
  fetchMock.mockReset();
  createUrl.mockReset().mockReturnValueOnce("blob:preview-1").mockReturnValueOnce("blob:preview-2");
  revokeUrl.mockReset();
  play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("免费配音试听", () => {
  it("显示后端 502 的真实原因，重试成功后提供播放器并清除错误", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Edge TTS connection timed out" }), { status: 502 }));
    await render();
    await preview();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Edge TTS connection timed out");
    expect(container.querySelector("audio")).toBeNull();
    expect(play).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(audioResponse());
    await preview();
    const audio = container.querySelector("audio")!;
    expect(audio.controls).toBe(true);
    expect(audio.getAttribute("src")).toBe("blob:preview-1");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(play).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/tts/free", expect.objectContaining({
      body: JSON.stringify({ voice: "zh-CN-XiaoxiaoNeural", text: "中文试听" }),
      signal: expect.any(AbortSignal),
    }));
  });

  it("自动播放受限时保留音频控件并提示手动播放，开始播放后移除提示", async () => {
    play.mockRejectedValueOnce(new DOMException("Autoplay blocked", "NotAllowedError"));
    fetchMock.mockResolvedValueOnce(audioResponse());
    await render();
    await preview();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("ttsPreviewManualPlay");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    const audio = container.querySelector("audio")!;
    expect(audio.controls).toBe(true);
    expect(revokeUrl).not.toHaveBeenCalled();
    await act(async () => audio.dispatchEvent(new Event("playing")));
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("再次试听停止旧音频并释放 URL，解码失败释放新音频且显示错误", async () => {
    fetchMock.mockResolvedValue(audioResponse());
    await render();
    await preview();
    const firstAudio = container.querySelector("audio")!;
    fetchMock.mockResolvedValueOnce(audioResponse());
    await preview();
    expect(pause.mock.instances).toContain(firstAudio);
    expect(revokeUrl).toHaveBeenCalledWith("blob:preview-1");
    expect(container.querySelector("audio")!.getAttribute("src")).toBe("blob:preview-2");
    await act(async () => container.querySelector("audio")!.dispatchEvent(new Event("error")));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("errorPreviewPlayback");
    expect(container.querySelector("audio")).toBeNull();
    expect(revokeUrl).toHaveBeenCalledWith("blob:preview-2");
  });

  it("切换音色或语言取消旧请求，迟到的响应不能覆盖新试听", async () => {
    let finishOld!: (response: Response) => void;
    let oldSignal!: AbortSignal;
    fetchMock.mockImplementationOnce((_url, options) => {
      oldSignal = options.signal;
      return new Promise<Response>((resolve) => { finishOld = resolve; });
    });
    await render();
    await preview();
    expect(container.querySelector("button")!.disabled).toBe(true);
    await render("zh-CN-YunxiNeural", "en");
    expect(oldSignal.aborted).toBe(true);
    fetchMock.mockResolvedValueOnce(audioResponse());
    await preview();
    expect(fetchMock).toHaveBeenLastCalledWith("/api/tts/free", expect.objectContaining({
      body: JSON.stringify({ voice: "zh-CN-YunxiNeural", text: "English preview" }),
    }));
    await act(async () => finishOld(audioResponse()));
    expect(createUrl).toHaveBeenCalledTimes(1);
    expect(container.querySelector("audio")!.getAttribute("src")).toBe("blob:preview-1");
  });

  it("卸载时停止播放并释放 Blob URL", async () => {
    fetchMock.mockResolvedValueOnce(audioResponse());
    await render();
    await preview();
    const audio = container.querySelector("audio")!;
    await act(async () => root!.unmount());
    root = null;
    expect(pause.mock.instances).toContain(audio);
    expect(audio.getAttribute("src")).toBeNull();
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:preview-1");
  });
});
