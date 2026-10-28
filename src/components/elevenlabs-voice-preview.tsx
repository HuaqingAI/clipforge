"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { elevenLabsErrorMessage, elevenLabsFetch } from "@/lib/elevenlabs/browser-client";
import { useT } from "@/lib/i18n";

/** The parent keys this component by selection and readiness to stop stale previews. */
export function ElevenLabsVoicePreview({ voice, model, speed, ready, text }: {
  voice: string;
  model: string;
  speed?: number;
  ready: boolean;
  text?: string;
}) {
  const t = useT("settings");
  const videoT = useT("video");
  const [loading, setLoading] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const attachAudio = useCallback((audio: HTMLAudioElement | null) => {
    // Keep the element available for cleanup after React detaches its ref.
    if (audio) audioRef.current = audio;
  }, []);
  const resources = useRef<{ request?: AbortController; url?: string }>({});
  const release = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    if (resources.current.url) {
      URL.revokeObjectURL(resources.current.url);
      resources.current.url = undefined;
    }
  }, []);

  useEffect(() => () => {
    resources.current.request?.abort();
    release();
  }, [release]);

  useEffect(() => {
    if (!audioUrl) return;
    let active = true;
    void audioRef.current?.play().catch((failure: unknown) => {
      if (!active || resources.current.url !== audioUrl) return;
      // Autoplay restrictions still allow playback through the native controls.
      if (failure && typeof failure === "object" && "name" in failure && failure.name === "NotAllowedError") return;
      release();
      setAudioUrl(null);
      setError(t("ttsPreviewPlaybackFailed"));
    });
    return () => { active = false; };
  }, [audioUrl, release, t]);

  async function preview() {
    if (!ready || loading) return;
    resources.current.request?.abort();
    release();
    setAudioUrl(null);
    setError("");
    setLoading(true);
    const controller = new AbortController();
    resources.current.request = controller;
    try {
      const response = await elevenLabsFetch("/api/tts", {
        method: "POST",
        body: JSON.stringify({
          text: text ?? t("ttsSample"),
          ttsConfig: { provider: "elevenlabs-cli", baseUrl: "", apiKey: "", voice, model, ...(speed === undefined ? {} : { speed }) },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(elevenLabsErrorMessage(await response.json().catch(() => null), t("ttsTestError")));
      }
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      if (!blob.size) throw new Error(t("ttsPreviewEmpty"));
      const url = URL.createObjectURL(blob);
      resources.current.url = url;
      setAudioUrl(url);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t("ttsTestError"));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (resources.current.request === controller) resources.current.request = undefined;
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => void preview()}
        disabled={!ready || loading}
        className="text-[11px] text-primary hover:underline disabled:opacity-50"
      >
        {loading ? videoT("ttsPreviewing") : videoT("ttsPreviewCta")}
      </button>
      {!ready && <p className="text-[11px] text-muted-foreground">{t("ttsLoginAndSelectFirst")}</p>}
      {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
      {audioUrl && <audio ref={attachAudio} controls src={audioUrl} aria-label={t("ttsPreviewPlayer")} className="h-10 w-full" onError={() => { release(); setAudioUrl(null); setError(t("ttsPreviewPlaybackFailed")); }} />}
    </div>
  );
}
