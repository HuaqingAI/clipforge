"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";

interface PreviewResources {
  request: AbortController | null;
  audio: HTMLAudioElement | null;
  url: string | null;
}

function releaseAudio(resources: PreviewResources) {
  if (resources.audio) {
    resources.audio.pause();
    resources.audio.removeAttribute("src");
    resources.audio.load();
  }
  if (resources.url) {
    URL.revokeObjectURL(resources.url);
    resources.url = null;
  }
}

/** The parent keys this component by voice and locale so changing either cancels the preview. */
export function FreeVoicePreview({ voice, text }: { voice: string; text: string }) {
  const t = useT("video");
  const resourcesRef = useRef<PreviewResources>({ request: null, audio: null, url: null });
  const [loading, setLoading] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualPlay, setManualPlay] = useState(false);
  const attachAudio = useCallback((audio: HTMLAudioElement | null) => {
    // Retain the element until cleanup, including after React detaches its ref on unmount.
    if (audio) resourcesRef.current.audio = audio;
  }, []);

  useEffect(() => {
    const resources = resourcesRef.current;
    return () => {
      resources.request?.abort();
      resources.request = null;
      releaseAudio(resources);
    };
  }, []);

  useEffect(() => {
    if (!audioUrl) return;
    const resources = resourcesRef.current;
    const audio = resources.audio;
    if (!audio) return;
    let active = true;
    void audio.play().catch((cause: unknown) => {
      if (!active || resources.url !== audioUrl) return;
      if (cause && typeof cause === "object" && "name" in cause && cause.name === "NotAllowedError") {
        setManualPlay(true);
      } else {
        releaseAudio(resources);
        setAudioUrl(null);
        setError(t("errorPreviewPlayback"));
      }
    });
    return () => {
      active = false;
      audio.pause();
    };
  }, [audioUrl, t]);

  async function preview() {
    const resources = resourcesRef.current;
    resources.request?.abort();
    releaseAudio(resources);
    const controller = new AbortController();
    resources.request = controller;
    setLoading(true);
    setAudioUrl(null);
    setError(null);
    setManualPlay(false);
    try {
      const response = await fetch("/api/tts/free", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice, text }),
        signal: controller.signal,
      });
      if (!response.ok) {
        let detail = `${response.status} ${response.statusText}`.trim();
        try {
          const body: unknown = await response.json();
          if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
            detail = body.error;
          }
        } catch { /* Non-JSON errors still expose the HTTP status. */ }
        throw new Error(detail);
      }
      const blob = await response.blob();
      if (controller.signal.aborted || resources.request !== controller) return;
      if (!blob.size) throw new Error(t("errorPreviewEmpty"));
      const url = URL.createObjectURL(blob);
      resources.url = url;
      setAudioUrl(url);
    } catch (cause) {
      if (controller.signal.aborted || resources.request !== controller) return;
      releaseAudio(resources);
      setError(cause instanceof Error ? cause.message : t("errorPreviewFailed"));
    } finally {
      if (resources.request === controller) {
        resources.request = null;
        setLoading(false);
      }
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => void preview()}
        disabled={loading}
        className="text-[11px] text-primary hover:underline disabled:opacity-50"
      >
        {loading ? t("ttsPreviewing") : t("ttsPreviewCta")}
      </button>
      {error && <p role="alert" className="text-xs text-destructive break-words">{t("errorPreviewFailed")}: {error}</p>}
      {manualPlay && <p role="status" className="text-xs text-muted-foreground">{t("ttsPreviewManualPlay")}</p>}
      {audioUrl && (
        <audio
          ref={attachAudio}
          controls
          src={audioUrl}
          aria-label={t("ttsPreviewPlayer")}
          className="h-10 w-full"
          onPlaying={() => setManualPlay(false)}
          onError={() => {
            const resources = resourcesRef.current;
            if (resources.url !== audioUrl) return;
            releaseAudio(resources);
            setAudioUrl(null);
            setManualPlay(false);
            setError(t("errorPreviewPlayback"));
          }}
        />
      )}
    </div>
  );
}
