"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { History, Loader2, RotateCcw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLocale, useT } from "@/lib/i18n";
import { abortable, type SavedScript } from "@/lib/script-generation-client";

type HistoryScript = SavedScript & { createdAt?: string | null };

function isHistory(value: unknown): value is HistoryScript[] {
  return Array.isArray(value) && value.every((row) => row && typeof row.id === "string"
    && (row.title == null || typeof row.title === "string")
    && (row.version == null || (Number.isInteger(row.version) && row.version > 0))
    && Array.isArray(row.shots) && row.shots.every((shot: unknown) => {
      if (!shot || typeof shot !== "object") return false;
      const item = shot as Record<string, unknown>;
      return typeof item.description === "string" && typeof item.voiceover === "string"
        && (item.camera == null || typeof item.camera === "string") && typeof item.duration === "number";
    }));
}

interface ScriptHistoryDialogProps {
  projectId: string;
  busy: boolean;
  onClose(): void;
  onRestore(scriptId: string): Promise<void>;
}

export function ScriptHistoryDialog(props: ScriptHistoryDialogProps) {
  return <ScriptHistoryDialogContent key={props.projectId} {...props} />;
}

function ScriptHistoryDialogContent({ projectId, busy, onClose, onRestore }: ScriptHistoryDialogProps) {
  const t = useT("script");
  const locale = useLocale();
  const [rows, setRows] = useState<HistoryScript[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reload, setReload] = useState(0);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const restoreLock = useRef(false);
  const lifecycle = useRef(0);
  const locked = busy || restoring;

  useEffect(() => {
    return () => { lifecycle.current += 1; };
  }, [projectId]);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    void abortable((async () => {
      const response = await fetch(`/api/project/${projectId}/scripts`, {
        cache: "no-store", signal: controller.signal,
      });
      if (!response.ok) throw new Error("history request failed");
      const data: unknown = await response.json();
      if (!isHistory(data)) throw new Error("invalid history response");
      return data;
    })(), controller.signal).then((data) => {
      if (disposed) return;
      setRows(data);
      const newest = [...data].sort((a, b) => (b.version ?? 1) - (a.version ?? 1));
      setPreviewId(data.find((row) => row.selected)?.id ?? newest[0]?.id ?? null);
    }).catch(() => {
      if (!disposed) setLoadError(true);
    }).finally(() => {
      clearTimeout(timeout);
      if (!disposed) setLoading(false);
    });

    return () => {
      disposed = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [projectId, reload]);

  const batches = useMemo(() => {
    const grouped = new Map<number, HistoryScript[]>();
    for (const row of rows) {
      const version = row.version ?? 1;
      const batch = grouped.get(version) ?? [];
      batch.push(row);
      grouped.set(version, batch);
    }
    return [...grouped.entries()].sort(([a], [b]) => b - a);
  }, [rows]);
  const selected = rows.find((row) => row.selected);
  const currentVersion = selected ? selected.version ?? 1 : null;
  const preview = rows.find((row) => row.id === previewId);
  const isCurrentBatch = preview && (preview.version ?? 1) === currentVersion;

  function formatDate(value?: string | null) {
    if (!value) return t("historyUnknownDate");
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? t("historyUnknownDate") : date.toLocaleString(locale === "zh" ? "zh-CN" : "en-US");
  }

  async function restore() {
    if (!preview || isCurrentBatch || locked || restoreLock.current || !confirming) return;
    restoreLock.current = true;
    const attempt = lifecycle.current;
    setRestoring(true);
    setRestoreError(null);
    try {
      await onRestore(preview.id);
      // The parent applies the new batch and unmounts this dialog after success.
    } catch (error) {
      if (attempt !== lifecycle.current) return;
      setRestoreError(error instanceof Error && error.message ? error.message : t("historyRestoreFailed"));
      restoreLock.current = false;
      setRestoring(false);
    }
  }

  return <Dialog open onOpenChange={(open) => { if (!open && !locked && !restoreLock.current) onClose(); }}>
    <DialogContent className="flex max-h-[90dvh] flex-col gap-4 overflow-hidden sm:max-w-5xl" showCloseButton={false} aria-busy={locked} aria-modal="true">
      <DialogHeader className="pr-10">
        <DialogTitle className="flex items-center gap-2"><History className="size-4" />{t("historyTitle")}</DialogTitle>
        <DialogDescription>{t("historyPreviewHint")}</DialogDescription>
      </DialogHeader>
      <Button variant="ghost" size="icon-sm" className="absolute right-3 top-3" aria-label={t("historyClose")} disabled={locked} onClick={() => { if (!restoreLock.current) onClose(); }}><X /></Button>
      {loading ? <p role="status" className="flex items-center justify-center gap-2 py-10 text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("historyLoading")}</p>
        : loadError ? <div role="alert" className="space-y-3 py-8 text-center"><p>{t("historyLoadFailed")}</p><Button variant="outline" disabled={locked} onClick={() => { setLoading(true); setLoadError(false); setReload((value) => value + 1); }}>{t("historyRetry")}</Button></div>
          : rows.length === 0 ? <p className="py-10 text-center text-muted-foreground">{t("historyEmpty")}</p>
            : <div className="min-h-0 overflow-y-auto overscroll-contain">
              <div className="grid items-start gap-4 md:grid-cols-[minmax(12rem,1fr)_minmax(0,2fr)]">
                <div className="max-h-[30dvh] space-y-3 overflow-y-auto md:max-h-none md:overflow-visible" aria-label={t("historyTitle")}>
                  {batches.map(([version, scripts]) => <Card key={version} size="sm" data-history-version={version}>
                    <CardHeader className="gap-2">
                      <CardTitle className="flex flex-wrap items-center gap-2">{t("historyBatch", { n: version })}{version === currentVersion && <Badge variant="secondary">{t("historyCurrentBatch")}</Badge>}</CardTitle>
                      <p className="text-xs text-muted-foreground">{t("historyOptionCount", { n: scripts.length })}</p>
                      <p className="text-xs text-muted-foreground">{t("historyCreatedAt", { date: formatDate(scripts.find((row) => row.createdAt)?.createdAt) })}</p>
                    </CardHeader>
                    <CardContent className="space-y-1">
                      {scripts.map((row, index) => <Button key={row.id} variant={previewId === row.id ? "secondary" : "ghost"} className="h-auto min-h-8 w-full justify-start whitespace-normal text-left" disabled={locked} aria-pressed={previewId === row.id} onClick={() => { setPreviewId(row.id); setConfirming(false); setRestoreError(null); }}>
                        <span className="break-words">{row.title || t("historyOption", { n: index + 1 })}</span>
                      </Button>)}
                    </CardContent>
                  </Card>)}
                </div>
                {preview && <Card size="sm" className="min-w-0" aria-label={t("historyView")}>
                  <CardHeader className="gap-2">
                    <CardTitle className="break-words">{preview.title || t("untitledScript")}</CardTitle>
                    <p className="text-xs text-muted-foreground">{t("shotCount", { n: preview.shots.length })}{preview.totalDuration != null && <> · {t("historyDuration", { n: preview.totalDuration })}</>}</p>
                    {isCurrentBatch ? <Badge variant="secondary">{t("historyCurrentBatch")}</Badge> : !confirming && <Button variant="outline" className="w-fit" disabled={locked} onClick={() => { setConfirming(true); setRestoreError(null); }}><RotateCcw />{t("historyRestore")}</Button>}
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {confirming && <section role="alertdialog" aria-labelledby="history-restore-title" aria-describedby="history-restore-description" className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
                      <h3 id="history-restore-title" className="font-medium">{t("historyRestoreConfirmTitle")}</h3>
                      <p id="history-restore-description" className="text-sm text-muted-foreground">{t("historyRestoreConfirmDesc")}</p>
                      {restoreError && <p role="alert" className="text-sm text-destructive">{restoreError}</p>}
                      <div className="flex flex-wrap gap-2">
                        <Button disabled={locked} onClick={() => void restore()}>{restoring && <Loader2 className="size-4 animate-spin" />}{t(restoring ? "historyRestoring" : "historyRestoreConfirmOk")}</Button>
                        <Button variant="outline" disabled={locked} onClick={() => { setConfirming(false); setRestoreError(null); }}>{t("historyCancel")}</Button>
                      </div>
                    </section>}
                    {preview.shots.map((shot, index) => <section key={`${shot.shotId}-${index}`} className="space-y-2 rounded-lg border p-3">
                      <h3 className="flex flex-wrap items-center justify-between gap-2 font-medium"><span>{t("historyShot", { n: index + 1 })}</span><span className="text-xs font-normal text-muted-foreground">{t("historyDuration", { n: shot.duration })}</span></h3>
                      <dl className="space-y-2 text-sm">
                        {[["historyDescription", shot.description], ["historyCamera", shot.camera], ["historyVoiceover", shot.voiceover]].map(([label, content]) => <div key={label}><dt className="mb-0.5 text-xs text-muted-foreground">{t(label)}</dt><dd className="whitespace-pre-wrap break-words leading-relaxed">{content || "—"}</dd></div>)}
                      </dl>
                    </section>)}
                  </CardContent>
                </Card>}
              </div>
            </div>}
    </DialogContent>
  </Dialog>;
}
