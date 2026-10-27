"use client";

import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/lib/i18n";
import { tideweCopyInputError, TIDEWE_COPY_INPUT_MAX_LENGTH, type TideweCopySource } from "@/lib/tidewe/copy-input";

export type { TideweCopySource } from "@/lib/tidewe/copy-input";

export function TideweCopyInput({ source, text, onSourceChange, onTextChange, disabled = false, id = "tidewe-copy-input" }: {
  source: TideweCopySource;
  text: string;
  onSourceChange(source: TideweCopySource): void;
  onTextChange(text: string): void;
  disabled?: boolean;
  id?: string;
}) {
  const t = useT("tidewe");
  const error = text.length ? tideweCopyInputError(text) : undefined;
  return <section aria-label={t("copySource")} className="space-y-3">
    <fieldset disabled={disabled} className="space-y-2">
      <legend className="mb-2 text-sm font-medium">{t("copySource")}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {(["ai", "manual"] as const).map((choice) => <label key={choice} className={`flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm ${source === choice ? "border-primary bg-primary/5" : "border-border/50"} ${disabled ? "cursor-default opacity-60" : ""}`}>
          <input type="radio" name={`${id}-source`} value={choice} checked={source === choice} onChange={() => onSourceChange(choice)} />
          {t(choice === "manual" ? "copySourceManual" : "copySourceAi")}
        </label>)}
      </div>
    </fieldset>
    {source === "manual" && <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium">{t("copyInputLabel")}</label>
      <Textarea id={id} lang="en-US" rows={8} value={text} disabled={disabled} placeholder={t("copyInputPlaceholder")} aria-invalid={Boolean(error)} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`} onChange={(event) => onTextChange(event.target.value)} className="field-sizing-fixed resize-y bg-muted/20" />
      <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">{t("copyInputHint")}</p>
      <p className="text-right text-xs text-muted-foreground">{t("copyInputCharacters", { count: text.length, max: TIDEWE_COPY_INPUT_MAX_LENGTH })}</p>
      {error && <p id={`${id}-error`} role="alert" className="text-xs text-destructive">{t(error)}</p>}
    </div>}
  </section>;
}
