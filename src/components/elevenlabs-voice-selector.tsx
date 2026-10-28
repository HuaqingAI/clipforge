"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/i18n";
import { elevenLabsFetch } from "@/lib/elevenlabs/browser-client";
import type { ElevenLabsStatus, ElevenLabsCatalog } from "@/lib/elevenlabs/types";

async function readResponse<T>(response: Response, fallback: string): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = data?.error;
    throw new Error(typeof error === "string" ? error : error?.message ?? fallback);
  }
  return data as T;
}

/** Only non-secret voice/model IDs leave this component; OAuth credentials stay in the CLI. */
export function ElevenLabsVoiceSelector({ voice, model, onVoiceChange, onModelChange, onReadyChange, allowLogin = true }: {
  voice: string;
  model: string;
  onVoiceChange: (voice: string) => void;
  onModelChange: (model: string) => void;
  onReadyChange: (ready: boolean) => void;
  /** Login is managed in Settings; video pages only consume an existing connection. */
  allowLogin?: boolean;
}) {
  const t = useT("video");
  const settingsT = useT("settings");
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<ElevenLabsStatus | null>(null);
  const [catalog, setCatalog] = useState<ElevenLabsCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [authorizing, setAuthorizing] = useState(false);
  const [error, setError] = useState("");
  const ready = Boolean(!loading && !authorizing && !error && status?.authenticated && status.auth.state !== "pending"
    && catalog?.voices.some((item) => item.id === voice)
    && catalog?.models.some((item) => item.id === model));

  useEffect(() => { onReadyChange(ready); }, [ready, voice, model, onReadyChange]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    setError("");
    setCatalog(null);
    void (async () => {
      try {
        const next = await readResponse<ElevenLabsStatus>(await elevenLabsFetch("/api/integrations/elevenlabs/status", { signal: controller.signal }), t("elevenLabsLoadFailed"));
        if (controller.signal.aborted) return;
        setStatus(next);
        if (next.auth.state === "pending") {
          timer = setTimeout(() => setRevision((current) => current + 1), 2000);
        } else if (next.authenticated) {
          const result = await readResponse<ElevenLabsCatalog>(await elevenLabsFetch("/api/integrations/elevenlabs/catalog", { signal: controller.signal }), t("elevenLabsLoadFailed"));
          if (!controller.signal.aborted) setCatalog(result);
        }
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t("elevenLabsLoadFailed"));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
    // Translation changes should not restart an in-flight local OAuth session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  const refresh = () => {
    onReadyChange(false);
    setLoading(true);
    setRevision((current) => current + 1);
  };
  const login = async () => {
    setAuthorizing(true);
    setError("");
    onReadyChange(false);
    try {
      await readResponse(await elevenLabsFetch("/api/integrations/elevenlabs/auth", { method: "POST", body: "{}" }), t("elevenLabsLoginFailed"));
      refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("elevenLabsLoginFailed"));
    } finally {
      setAuthorizing(false);
    }
  };
  const authPending = status?.auth.state === "pending";
  const selectClass = "h-9 w-full rounded-md border border-border/50 bg-muted/30 px-2 text-xs disabled:opacity-50";

  return (
    <div className="space-y-3 rounded-lg border border-border/50 p-3" aria-busy={loading || authorizing}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs" role="status">
          {loading ? t("elevenLabsLoading") : authPending ? t("elevenLabsLoginPending") : status?.authenticated ? t("elevenLabsConnected") : status?.installed ? t("elevenLabsNotConnected") : status ? t("elevenLabsNotInstalled") : t("elevenLabsLoadFailed")}
        </p>
        <div className="flex gap-2">
          {allowLogin && status?.installed && (
            <Button type="button" variant="outline" size="sm" className="text-xs" disabled={loading || authorizing || authPending} onClick={() => void login()}>
              {t(status.authenticated ? "elevenLabsReconnect" : "elevenLabsLogin")}
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" className="text-xs" disabled={loading || authorizing} onClick={refresh}>
            {t("elevenLabsRefresh")}
          </Button>
        </div>
      </div>
      {!loading && status?.message && (!status.installed || !status.authenticated) && <p className="text-xs text-muted-foreground break-words">{status.message}</p>}
      {!loading && (error || (status?.auth.state === "error" && !status.authenticated)) && <p role="alert" className="text-xs text-destructive break-words">{error || status?.auth.message || t("elevenLabsLoginFailed")}</p>}
      {!allowLogin && <a href="/settings?tab=tts" className="inline-block text-xs text-primary hover:underline">{settingsT("ttsManageConnection")}</a>}
      {status?.authenticated && !authPending && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="elevenlabs-voice" className="text-xs">{t("elevenLabsVoiceLabel")}</Label>
            <select id="elevenlabs-voice" aria-label={t("elevenLabsVoiceLabel")} value={catalog?.voices.some((item) => item.id === voice) ? voice : ""} disabled={loading || !catalog} onChange={(event) => onVoiceChange(event.target.value)} className={selectClass}>
              <option value="">{t("elevenLabsChooseVoice")}</option>
              {catalog?.voices.map((item) => <option key={item.id} value={item.id}>{item.name}{item.category ? ` · ${["cloned", "professional", "high_quality"].includes(item.category) ? t("elevenLabsClonedVoice") : item.category}` : ""}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="elevenlabs-model" className="text-xs">{t("elevenLabsModelLabel")}</Label>
            <select id="elevenlabs-model" aria-label={t("elevenLabsModelLabel")} value={catalog?.models.some((item) => item.id === model) ? model : ""} disabled={loading || !catalog} onChange={(event) => onModelChange(event.target.value)} className={selectClass}>
              <option value="">{t("elevenLabsChooseModel")}</option>
              {catalog?.models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
          {!loading && catalog && (!catalog.voices.length || !catalog.models.length) && <p className="text-xs text-destructive">{t("elevenLabsEmptyCatalog")}</p>}
          {!loading && catalog && !ready && catalog.voices.length > 0 && catalog.models.length > 0 && <p className="text-[11px] text-muted-foreground">{t("elevenLabsSelectRequired")}</p>}
        </>
      )}
      <p className="text-[11px] text-muted-foreground">{t("elevenLabsBillingHint")}</p>
    </div>
  );
}
