"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { TideweProductFields, buildTideweProductFacts, tideweProductInputFromFacts } from "@/components/tidewe-product-fields";
import { TidewePresenterPicker } from "@/components/tidewe-presenter-picker";
import { createTideweOutdoorProfile, isTideweNativeSpeech, type TideweOutdoorProfile, type ProjectCreativeProfileDrafts } from "@/lib/creative-profiles";
import { useT } from "@/lib/i18n";
import type { ProductFacts } from "@/lib/tidewe/types";

export const TIDEWE_ANGLES = ["auto", "scene_pain", "choice", "use_demo", "long_wait", "gift"] as const;

export function TideweProjectSettings({ projectId, revision, facts, profile, drafts, disabled, onBusyChange, onSaved }: {
  projectId: string;
  revision: number;
  facts?: ProductFacts | null;
  profile: TideweOutdoorProfile;
  drafts: ProjectCreativeProfileDrafts;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onSaved: (project: unknown) => void;
}) {
  const t = useT("tidewe");
  const [input, setInput] = useState(() => tideweProductInputFromFacts(facts));
  const [duration, setDuration] = useState<number>(profile.targetDuration);
  const [angle, setAngle] = useState(profile.narrativeAngle);
  const [speechMode, setSpeechMode] = useState<TideweOutdoorProfile["speechMode"]>(isTideweNativeSpeech(profile) ? "on_camera" : "voiceover");
  const [presenter, setPresenter] = useState(profile.presenter);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const save = async () => {
    if (saving || disabled) return;
    setSaving(true); onBusyChange(true); setNotice(""); setError("");
    try {
      const nextProfile = createTideweOutdoorProfile({ ...profile, targetDuration: duration, narrativeAngle: angle, speechMode, presenter });
      const response = await fetch(`/api/project/${projectId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedCreativeConfigRevision: revision, productFacts: buildTideweProductFacts(input, facts), productCategory: input.category, productDescription: input.specifications, creativeProfile: nextProfile, creativeProfileDrafts: { ...drafts, tidewe_outdoor: nextProfile } }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || t("saveFailed"));
      onSaved(data); setNotice(t("factsSaved"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("saveFailed")); }
    finally { setSaving(false); onBusyChange(false); }
  };
  return <details className="mt-4 border-t border-border/50 pt-4">
    <summary className="cursor-pointer text-sm font-medium">{t("configuration")}</summary>
    <div className="mt-4 space-y-4">
      <label className="block space-y-2 text-xs">{t("speechMode")}<select aria-label={t("speechMode")} value={speechMode} disabled={disabled || saving} onChange={(event) => setSpeechMode(event.target.value as TideweOutdoorProfile["speechMode"])} className="block h-10 w-full rounded-md border border-border/50 bg-background px-3 text-sm"><option value="on_camera">{t("speechOnCamera")}</option><option value="voiceover">{t("speechVoiceover")}</option></select></label>
      <p className="text-xs text-primary">{t(speechMode === "on_camera" ? "nativeSpeechHint" : "voiceoverHint")}</p>
      {speechMode === "on_camera" && <p className="text-xs text-muted-foreground">{t("speechChangeHint")}</p>}
      <TidewePresenterPicker id="project-tidewe-presenter" value={presenter} onChange={setPresenter} disabled={disabled || saving} />
      <p className="text-xs text-muted-foreground">{t("presenterChangeHint")}</p>
      <TideweProductFields prefix="project-tidewe" value={input} onChange={setInput} disabled={disabled || saving} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-2 text-xs">{t("duration")}<select aria-label={t("duration")} value={duration} disabled={disabled || saving} onChange={(event) => setDuration(Number(event.target.value))} className="block h-10 w-full rounded-md border border-border/50 bg-background px-3 text-sm">{[30, 40, 60].map((seconds) => <option key={seconds} value={seconds}>{seconds}s</option>)}</select></label>
        <label className="space-y-2 text-xs">{t("angle")}<select aria-label={t("angle")} value={angle} disabled={disabled || saving} onChange={(event) => setAngle(event.target.value as TideweOutdoorProfile["narrativeAngle"])} className="block h-10 w-full rounded-md border border-border/50 bg-background px-3 text-sm">{TIDEWE_ANGLES.map((item) => <option key={item} value={item}>{t(`angle_${item}`)}</option>)}</select></label>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {notice && <p role="status" className="text-xs text-primary">{notice}</p>}
      <Button variant="outline" size="sm" disabled={disabled || saving} onClick={() => void save()}>{t("saveFacts")}</Button>
    </div>
  </details>;
}
