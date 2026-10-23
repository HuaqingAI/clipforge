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
  options: Record<string, unknown>;
  klingParameters: Record<string, unknown>;
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
  const mapped = klingModelOptions({ ...model, parameters }, { ...silentBatchMotionOptions(draft.klingParameters), ...(draft.negativePrompt !== undefined && { negativePrompt: draft.negativePrompt }) });
  const prompt = draft.prompt;
  const imageSlots = model.inputSlots.filter((slot) => slot.role === "image");
  const imageChoices = [...new Set([draft.firstFrameUrl, ...draft.referenceImages.filter((url) => url !== draft.lastFrameUrl)].filter(Boolean))];
  const images: string[] = [];
  let imageIndex = 0;
  for (const slot of imageSlots) {
    if (slot.required || imageIndex === 0) images.push(imageChoices[imageIndex++] ?? "");
  }
  const tail = model.inputSlots.find((slot) => slot.role === "tailImage");
  const missingParameter = model.parameters.find((parameter) => parameter.required && (mapped.options[parameter.name] === undefined || mapped.options[parameter.name] === ""));
  const error = !draft.firstFrameUrl || !imageSlots.length || images.some((url) => !url)
    ? "当前模型所需的输入图片不完整"
    : tail?.required && !draft.lastFrameUrl ? "当前模型需要尾帧，请先设置该分镜的尾帧"
      : missingParameter ? `当前模型缺少必填参数 ${missingParameter.name}`
        : mapped.unsupportedSettings.length ? "当前模型不支持所选生成参数"
          : validateVideoPrompt(prompt).map((issue) => issue.message).join(" ");
  return { prompt, images, lastImageUrl: tail ? draft.lastFrameUrl : undefined, options: mapped.options, warnings: mapped.warnings, error };
}
