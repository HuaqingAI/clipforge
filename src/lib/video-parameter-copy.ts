/** Display copy only. Provider parameter names and values stay unchanged. */
const PARAMETER_COPY: Record<string, { label: string; description: string }> = {
  duration: {
    label: "时长（秒）",
    description: "选择生成视频的时长，单位为秒。可选时长以当前模型支持的选项为准。",
  },
  resolution: {
    label: "质量",
    description: "选择视频画质，可用档位以当前模型和账号权限为准。",
  },
  aspectRatio: {
    label: "画面比例",
    description: "选择视频的宽高比例，例如 9:16 为竖屏、16:9 为横屏。",
  },
  audioEnabled: {
    label: "生成声音",
    description: "开启后，模型会同时生成画面和声音；关闭后仅生成画面。",
  },
};

const PARAMETER_ALIASES: Record<string, string> = {
  duration: "duration", duration_seconds: "duration", durationSeconds: "duration", duration_sec: "duration",
  resolution: "resolution", video_resolution: "resolution", videoResolution: "resolution", quality: "resolution",
  aspect_ratio: "aspectRatio", aspectRatio: "aspectRatio", ratio: "aspectRatio",
  audio: "audioEnabled", sound: "audioEnabled", enable_audio: "audioEnabled", generate_audio: "audioEnabled",
  native_audio: "audioEnabled", audio_enabled: "audioEnabled", audioEnabled: "audioEnabled",
};

export function videoParameterLabel(name: string): string {
  return PARAMETER_COPY[PARAMETER_ALIASES[name]]?.label ?? name;
}

export function videoParameterDescription(parameter: { name: string; description?: string }): string | undefined {
  return PARAMETER_COPY[PARAMETER_ALIASES[parameter.name]]?.description ?? parameter.description;
}

export function videoParameterValueLabel(name: string, value: unknown): string {
  if (value === true || value === "true") return "开启";
  if (value === false || value === "false") return "关闭";
  if (PARAMETER_ALIASES[name] === "audioEnabled") {
    const normalized = String(value).toLowerCase();
    if (["on", "yes", "1", "enabled", "enable"].includes(normalized)) return "开启";
    if (["off", "no", "0", "disabled", "disable"].includes(normalized)) return "关闭";
  }
  return String(value);
}
