import type { KlingVideoModelDescriptor } from "./types";
import type { VideoPromptSettings } from "@/lib/shot-video-prompt";

export type KlingFilmStatus = "draft" | "running" | "paused" | "needs_attention" | "composing" | "completed" | "cancelled";
export type KlingFilmShotStatus = "waiting" | "generating" | "ready" | "needs_attention";
export interface KlingFilmOutputSettings {
  resolution: "720p" | "1080p";
  aspectRatio: "9:16" | "16:9" | "1:1";
  audioStrategy: "edge-tts" | "edge-tts-mix" | "native";
  voice: string;
  subtitles: boolean;
}
export interface KlingFilmPreviewRequest {
  projectId: string; scriptId: string; profileId: string; selectionKey: string;
  options?: Record<string, unknown>;
  reuseExistingVideos?: boolean;
  output?: Partial<KlingFilmOutputSettings>;
  promptSettings?: Partial<VideoPromptSettings>;
}
export interface KlingFilmShotView {
  id: string; shotId: number; status: KlingFilmShotStatus;
  source: "reuse" | "generate"; prompt: string; duration: number; generationDuration?: number;
  keyframeUrl?: string; missingKeyframe: boolean; options: Record<string, string | number | boolean>;
  jobId?: string; assetId?: string; videoUrl?: string; error?: string; attempt: number;
  allowedActions?: string[];
}
export interface KlingFilmView {
  runId: string; projectId: string; scriptId: string; profileId: string;
  planHash: string; expiresAt: string; status: KlingFilmStatus; stage: string;
  model: KlingVideoModelDescriptor; output: KlingFilmOutputSettings;
  /** Absent only on plans saved before visual prompt settings were recorded. */
  promptSettings?: VideoPromptSettings;
  shots: KlingFilmShotView[]; totalShots: number; readyShots: number; billableShotCount: number;
  missingKeyframes: number[]; warnings: string[]; error?: string;
  compositionId?: string; videoUrl?: string; thumbnailUrl?: string;
  allowedActions: string[]; createdAt: string; updatedAt: string;
}
export interface KlingFilmStartRequest {
  planId: string; planHash: string; clientRequestId: string;
  explicitConfirmation: true;
  billingAcknowledgement: { policyRevision: "film-credits-v1"; acceptedForPlanHash: string };
}
