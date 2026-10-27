"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useCharacterStore } from "@/lib/stores/project-store";
import { snapshotTidewePresenter } from "@/lib/tidewe/presenter";
import type { TidewePresenterSnapshot } from "@/lib/tidewe/types";
import { useT } from "@/lib/i18n";

/** A project keeps its selected identity until the user explicitly replaces or syncs it. */
export function TidewePresenterPicker({ value, onChange, disabled = false, id = "tidewe-presenter" }: {
  value?: TidewePresenterSnapshot;
  onChange(value: TidewePresenterSnapshot | undefined): void;
  disabled?: boolean;
  id?: string;
}) {
  const t = useT("tidewe");
  const characters = useCharacterStore((state) => state.characters);
  const choices = characters.map((character) => ({ character, snapshot: snapshotTidewePresenter(character) }));
  const current = choices.find(({ character }) => character.id === value?.id);
  const image = value?.referenceImages[0] ?? value?.sourceReferenceImages?.[0];
  return <div className="space-y-3">
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={id} className="block text-sm font-medium">{t("presenterLabel")}</label>
      <Link href="/presenters" target="_blank" rel="noopener noreferrer" className="shrink-0 text-xs text-primary hover:underline">{t("presenterManageLibrary")} ↗</Link>
    </div>
    <select id={id} aria-label={t("presenterLabel")} aria-describedby={`${id}-hint`} value={value?.id ?? ""} disabled={disabled} className="h-10 w-full rounded-md border border-border/50 bg-background px-3 text-sm" onChange={(event) => {
      const selected = choices.find(({ character }) => character.id === event.target.value);
      onChange(selected?.snapshot);
    }}>
      <option value="">{t("presenterDefault")}</option>
      {value && !current && <option value={value.id}>{value.name} · {t("presenterRetained")}</option>}
      {choices.map(({ character, snapshot }) => <option key={character.id} value={character.id} disabled={!snapshot}>{character.id === value?.id ? value.name : character.name}{!snapshot ? ` · ${t("presenterIncomplete")}` : ""}</option>)}
    </select>
    <p id={`${id}-hint`} className="text-xs text-muted-foreground">{t("presenterHint")}</p>
    {choices.length === 0 && !value && <p className="text-xs text-muted-foreground">{t("presenterEmpty")}</p>}
    {value && <div className="flex items-start gap-3 rounded-md border border-border/50 bg-muted/20 p-3">
      {image && <img src={image} alt={t("presenterImageAlt")} className="h-24 w-20 shrink-0 rounded object-cover" />}
      <div className="min-w-0 space-y-2">
        <p className="text-sm font-medium">{value.name}</p>
        {value.appearance ? <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{value.appearance}</p> : <p className="text-xs text-muted-foreground">{t("presenterImageOnly")}</p>}
        {value.description && <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{value.description}</p>}
        {!current && <p className="text-xs text-muted-foreground">{t("presenterDeletedHint")}</p>}
        {current?.snapshot && <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onChange(current.snapshot)}>{t("presenterSync")}</Button>}
      </div>
    </div>}
  </div>;
}
