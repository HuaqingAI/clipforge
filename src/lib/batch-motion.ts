import type { AssetItem } from "@/lib/assets-view";
import { KLING_AUDIO_PARAMETER_NAMES, klingModelOptions } from "@/lib/kling/model-options";
import type { KlingVideoModelDescriptor } from "@/lib/kling/types";
import { validateVideoPrompt } from "@/lib/video-prompt";
import type { VideoPromptContext } from "@/lib/video-prompt-request";

/** A snapshot of one shot's own source frame and prepared video request. */
export interface BatchMotionDraft {
  asset: AssetItem;
  prompt: string;
  negativePrompt?: string;
  promptContext?: VideoPromptContext;
  firstFrameUrl: string;
  lastFrameUrl?: string;
  referenceImages: string[];
  frameChoices?: Array<{ label: string; url: string }>;
  refreshFrames?(firstFrameUrl: string, lastFrameUrl?: string): Promise<BatchMotionDraft>;
  options: Record<string, unknown>;
  klingParameters: Record<string, unknown>;
  /** Frozen provider input and asset-import metadata for server execution. */
  request?: Record<string, unknown>;
  assetPayload?: Record<string, unknown>;
  validate?(): boolean;
  generate(): Promise<void>;
}

export interface BatchMotionShot {
  asset: AssetItem;
  draft?: BatchMotionDraft;
  disabledReason?: string;
}

const compositionOrAudioOption = /audio|sound|voice|tts|subtitle|caption|music|narration/i;

/** Batch animation produces visual clips; sound and composition are handled later. */
export function silentBatchMotionOptions(options: Record<string, unknown>): Record<string, unknown> {
  return { ...Object.fromEntries(Object.entries(options).filter(([name]) => !compositionOrAudioOption.test(name))), audioEnabled: false };
}

export function prepareBatchMotionKling(draft: BatchMotionDraft, model: KlingVideoModelDescriptor) {
  const parameters = model.parameters.filter((parameter) => !compositionOrAudioOption.test(parameter.name) || KLING_AUDIO_PARAMETER_NAMES.includes(parameter.name));
  const mapped = klingModelOptions({ ...model, parameters }, {
    ...silentBatchMotionOptions(draft.klingParameters),
    audioEnabled: draft.promptContext?.generateAudio === true,
    ...(draft.negativePrompt !== undefined && { negativePrompt: draft.negativePrompt }),
  });
  const prompt = draft.prompt;
  const images = draft.firstFrameUrl ? [draft.firstFrameUrl] : [];
  const error = !draft.firstFrameUrl
    ? "请先选择当前分镜的图片"
    : validateVideoPrompt(prompt).map((issue) => issue.message).join(" ");
  return { prompt, images, lastImageUrl: draft.lastFrameUrl, options: mapped.options, warnings: mapped.warnings, error };
}
