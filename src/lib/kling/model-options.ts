import type { KlingParameter, KlingVideoModelDescriptor } from "./types";

export const KLING_AUDIO_PARAMETER_NAMES = ["audio", "sound", "enable_audio", "generate_audio", "native_audio", "audio_enabled", "audioEnabled"];

/** Resolve an explicit CLI switch when one is declared; omission uses provider defaults. */
export function klingAudioParameterValue(parameter: KlingParameter, enabled: boolean): string | number | boolean | undefined {
  const choices = parameter.allowedValues ?? (parameter.type === "boolean" ? [true, false] : parameter.default !== undefined ? [parameter.default] : []);
  const matches = enabled ? ["true", "on", "yes", "1", "enabled", "enable"] : ["false", "off", "no", "0", "disabled", "disable"];
  return choices.find((value) => matches.includes(String(value).toLowerCase()));
}

/**
 * All Kling models use provider audio defaults when the catalog supplies no
 * usable enable switch. Catalog omissions never determine model capability.
 */
export function klingHasDefaultNativeAudio(model: Pick<KlingVideoModelDescriptor, "remoteModelId" | "tool" | "parameters">): boolean {
  return !model.parameters.some((parameter) => KLING_AUDIO_PARAMETER_NAMES.includes(parameter.name) && klingAudioParameterValue(parameter, true) !== undefined);
}

export function klingSupportsNativeAudio(model: KlingVideoModelDescriptor): boolean {
  void model;
  return true;
}

/** Leave absent audio switch values to provider defaults; composition owns the final narration. */
export function klingPostNarrationModel(model: KlingVideoModelDescriptor): KlingVideoModelDescriptor {
  return { ...model, parameters: model.parameters.filter((parameter) => !KLING_AUDIO_PARAMETER_NAMES.includes(parameter.name) || klingAudioParameterValue(parameter, false) !== undefined) };
}

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
  for (const parameter of model.parameters) if (parameter.default !== undefined && !KLING_AUDIO_PARAMETER_NAMES.includes(parameter.name)) options[parameter.name] = parameter.default;
  for (const [setting, names] of Object.entries(aliases)) {
    const value = desired[setting];
    if (value === undefined || value === "") continue;
    const parameter = model.parameters.find((item) => names.includes(item.name)
      && (setting !== "audioEnabled" || typeof value !== "boolean" || klingAudioParameterValue(item, value) !== undefined));
    if (!parameter) continue;
    let selected: string | number | boolean | undefined;
    if (parameter.allowedValues) {
      selected = parameter.allowedValues.find((candidate) => String(candidate) === String(value));
      if (setting === "audioEnabled" && selected === undefined && typeof value === "boolean") {
        const matches = value ? ["true", "on", "yes", "1", "enabled", "enable"] : ["false", "off", "no", "0", "disabled", "disable"];
        selected = parameter.allowedValues.find((candidate) => matches.includes(String(candidate).toLowerCase()));
      }
    } else if (parameter.type === "number" && Number.isFinite(Number(value))) selected = Number(value);
    else if (parameter.type === "boolean" && typeof value === "boolean") selected = value;
    else if (parameter.type === "string" && typeof value === "string") selected = value;
    if (selected === undefined && setting === "audioEnabled" && typeof value === "boolean") selected = klingAudioParameterValue(parameter, value);
    if (selected === undefined && setting !== "audioEnabled") {
      if (parameter.type === "number" && Number.isFinite(Number(value))) selected = Number(value);
      else if (parameter.type === "boolean" && typeof value === "boolean") selected = value;
      else if (parameter.type === "string" && ["string", "number", "boolean"].includes(typeof value)) selected = String(value);
    }
    if (selected !== undefined) options[parameter.name] = selected;
    else if (setting === "audioEnabled") delete options[parameter.name];
  }
  return { options, warnings, unsupportedSettings };
}
