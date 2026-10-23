import type { RetakeSymptom } from "@/lib/retake-patch";
import type { VideoPromptSettings } from "@/lib/shot-video-prompt";
import type { VideoControlPlan } from "@/lib/video-control-plan";

/** Browser-safe inputs to the authoritative server compiler; no client-generated motion prose. */
export interface VideoPromptRequest {
  scriptId: string;
  shotId: number;
  settings: VideoPromptSettings;
  provider: string;
  model: string;
  /** Saved user exclusions; the server combines these with sales policy only. */
  negativePrompt?: string;
  chainToNext?: boolean;
  locale?: "zh" | "en";
  batch?: boolean;
  generateAudio?: boolean;
  retake?: RetakeSymptom;
  controlInputs?: {
    firstFrameUrl?: string;
    lastFrameUrl?: string;
    characterReferenceUrl?: string;
    productReferenceUrl?: string;
    continuityReferenceUrl?: string;
    motionReferenceUrl?: string;
    audioReferenceUrl?: string;
    supportsAudio?: boolean;
  };
}

export interface VideoPromptPreview {
  prompt: string;
  negativePrompt: string;
  scriptId: string;
  shotId: number;
  contextKey: string;
  settings: VideoPromptSettings;
  controlPlan: VideoControlPlan;
}

/** Echo the reviewed compiler inputs and server fingerprint on submission. */
export type VideoPromptContext = VideoPromptRequest & { contextKey: string };
