"use client";

import { useState } from "react";
import { KlingFilmPanel } from "@/components/kling-film-panel";
import { ArkFilmPanel } from "@/components/ark-film-panel";
import { KlingJobDetail } from "@/components/kling-job-detail";
import { isKlingVideoSelection } from "@/lib/assets-view";
import { useSettingsStore } from "@/lib/stores/settings-store";

/** Both entry points share this surface. An opened task keeps its original executor. */
interface FilmPanelProps {
  open: boolean; onOpenChange(open: boolean): void; projectId: string; scriptId: string;
  presenterId?: string; initialRunId?: string; initialTaskId?: string; onAssetsChanged(): Promise<void> | void;
  creativeProfile?: unknown;
}
export function StoryboardFilmPanel(props: FilmPanelProps) {
  return props.open ? <FilmSession key={props.initialRunId ?? props.initialTaskId ?? "new"} {...props} /> : null;
}

function FilmSession({ onOpenChange, projectId, scriptId, presenterId, initialRunId, initialTaskId, onAssetsChanged, creativeProfile }: FilmPanelProps) {
  const defaultModel = useSettingsStore((state) => state.defaultVideoModel);
  const profileId = useSettingsStore((state) => state.providers["kling-cli"]?.profileId);
  const [kling] = useState(() => Boolean(initialRunId) || (!initialTaskId && isKlingVideoSelection(defaultModel)));
  const [jobId, setJobId] = useState<string | null>(null);

  return <>
    {kling
      ? <KlingFilmPanel open onOpenChange={onOpenChange} projectId={projectId} scriptId={scriptId} profileId={profileId} defaultModel={defaultModel} presenterId={presenterId} initialRunId={initialRunId} onAssetsChanged={onAssetsChanged} onOpenJob={setJobId} creativeProfile={creativeProfile} />
      : <ArkFilmPanel open onOpenChange={onOpenChange} projectId={projectId} scriptId={scriptId} presenterId={presenterId} initialTaskId={initialTaskId} onAssetsChanged={onAssetsChanged} />}
    <KlingJobDetail jobId={jobId} open={jobId !== null} onOpenChange={(next) => { if (!next) setJobId(null); }} onChanged={() => { void onAssetsChanged(); }} />
  </>;
}
