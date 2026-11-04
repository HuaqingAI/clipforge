"use client";

import { ArkFilmPanel } from "@/components/ark-film-panel";

interface FilmPanelProps {
  open: boolean; onOpenChange(open: boolean): void; projectId: string; scriptId: string;
  presenterId?: string; initialTaskId?: string; onAssetsChanged(): Promise<void> | void;
}

/** Seedance film generation and recovery of its original provider task. */
export function StoryboardFilmPanel(props: FilmPanelProps) {
  return props.open ? <ArkFilmPanel key={`${props.projectId}:${props.initialTaskId ?? "new"}`} {...props} /> : null;
}
