import type { KlingVideoModelDescriptor } from "./types";
import { videoParameterLabel } from "@/lib/video-parameter-copy";

export const KLING_AUDIO_PARAMETER_NAMES = ["audio", "sound", "enable_audio", "generate_audio", "native_audio", "audio_enabled", "audioEnabled"];

const aliases: Record<string, string[]> = {
  duration: ["duration", "duration_seconds", "durationSeconds", "duration_sec"],
  aspectRatio: ["aspect_ratio", "aspectRatio", "ratio"],
  resolution: ["resolution", "video_resolution", "videoResolution", "quality"],
  fps: ["fps", "frame_rate", "frameRate"],
  seed: ["seed"],
  negativePrompt: ["negative_prompt", "negativePrompt"],
  motionStrength: ["motion_strength", "motionStrength"],
  audioEnabled: KLING_AUDIO_PARAMETER_NAMES,
};

/** Map only fields declared by this exact model. Never invent CLI flags. */
export function klingModelOptions(model: KlingVideoModelDescriptor, desired: Record<string, unknown> = {}) {
  const options: Record<string, string | number | boolean> = {};
  const warnings: string[] = [];
  const unsupportedSettings: string[] = [];
  for (const parameter of model.parameters) if (parameter.default !== undefined) options[parameter.name] = parameter.default;
  for (const [setting, names] of Object.entries(aliases)) {
    const value = desired[setting];
    if (value === undefined || value === "") continue;
    const parameter = model.parameters.find((item) => names.includes(item.name));
    if (!parameter) {
      if (["duration", "aspectRatio", "resolution"].includes(setting)) warnings.push(`当前模型未声明 ${videoParameterLabel(setting)} 参数，无法应用设置值 ${String(value)}；实际参数以下方列表为准。`);
      continue;
    }
    let selected: string | number | boolean | undefined;
    if (parameter.allowedValues) {
      selected = parameter.allowedValues.find((candidate) => String(candidate) === String(value));
      if (setting === "duration" && selected === undefined && Number.isFinite(Number(value))) {
        selected = [...parameter.allowedValues].filter((candidate) => Number.isFinite(Number(candidate)) && Number(candidate) >= Number(value)).sort((a, b) => Number(a) - Number(b))[0];
      }
      if (setting === "audioEnabled" && selected === undefined && typeof value === "boolean") {
        const matches = value ? ["true", "on", "yes", "1", "enabled", "enable"] : ["false", "off", "no", "0", "disabled", "disable"];
        selected = parameter.allowedValues.find((candidate) => matches.includes(String(candidate).toLowerCase()));
      }
    } else if (parameter.type === "number" && Number.isFinite(Number(value))) selected = Number(value);
    else if (parameter.type === "boolean" && typeof value === "boolean") selected = value;
    else if (parameter.type === "string" && typeof value === "string") selected = value;
    if (selected === undefined) {
      unsupportedSettings.push(setting);
      warnings.push(`${videoParameterLabel(parameter.name)} 不支持设置值 ${String(value)}，请核对并选择模型支持的参数。`);
    }
    else {
      options[parameter.name] = selected;
      if (setting !== "audioEnabled" && String(selected) !== String(value)) warnings.push(`${videoParameterLabel(parameter.name)} 已按模型支持的值从 ${String(value)} 调整为 ${String(selected)}。`);
    }
  }
  return { options, warnings, unsupportedSettings };
}
