"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/lib/i18n";
import type { TideweCopyDocument } from "@/lib/tidewe/types";

export function TideweCopyEditor({ document, busy, onSave }: {
  document: TideweCopyDocument;
  busy: boolean;
  onSave: (text: string) => Promise<void>;
}) {
  const t = useT("tidewe");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(document.text);
  const [error, setError] = useState("");
  return <section aria-label={t("copyTitle")} className="mb-5 rounded-xl border border-border/50 bg-card p-5">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">{t("copyTitle")}</h2>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t(document.source === "user_provided" ? "copySourceUserBadge" : "copySourceAiBadge")}</span>
      </div>
      {!editing && <Button variant="outline" size="sm" disabled={busy} onClick={() => { setDraft(document.text); setError(""); setEditing(true); }}>{t("editCopy")}</Button>}
    </div>
    {editing ? <div className="space-y-3">
      <label htmlFor="tidewe-copy-text" className="text-xs text-muted-foreground">{t("english")}</label>
      <Textarea id="tidewe-copy-text" lang="en-US" rows={9} value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} />
      <p className="text-xs text-muted-foreground">{t("replanHint")}</p>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setEditing(false)}>{t("cancel")}</Button>
        <Button size="sm" disabled={busy || !draft.trim() || draft.trim() === document.text.trim()} onClick={async () => {
          setError("");
          try { await onSave(draft); setEditing(false); } catch (cause) { setError(cause instanceof Error ? cause.message : t("saveFailed")); }
        }}>{busy ? t("saving") : t("saveAndReplan")}</Button>
      </div>
    </div> : <p lang="en-US" className="whitespace-pre-wrap text-sm leading-relaxed">{document.text}</p>}
    <details className="mt-4 border-t border-border/40 pt-3" open>
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground">{t("translation")}</summary>
      <p lang="zh-CN" className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{document.translation}</p>
    </details>
  </section>;
}
