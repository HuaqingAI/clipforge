/** Client-safe input validation shared by previews, composition and the CLI. */
export type ElevenLabsSpeechConfig = {
  provider: "elevenlabs-cli";
  baseUrl: "";
  apiKey: "";
  model: string;
  voice: string;
  speed?: number;
};

export type ElevenLabsConfigResult =
  | { ok: true; config: ElevenLabsSpeechConfig }
  | { ok: false; error: string };

export function validateElevenLabsConfig(value: unknown): ElevenLabsConfigResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "ElevenLabs 配音配置无效，请重新选择声音和模型" };
  }
  const input = value as Record<string, unknown>;
  if (input.provider !== undefined && input.provider !== "elevenlabs-cli") {
    return { ok: false, error: "ElevenLabs 配音提供方无效" };
  }
  if ((input.baseUrl !== undefined && input.baseUrl !== "") || (input.apiKey !== undefined && input.apiKey !== "")) {
    return { ok: false, error: "ElevenLabs CLI 使用本机 OAuth 登录，请勿设置 API 地址或 API Key" };
  }
  const voice = typeof input.voice === "string" ? input.voice.trim() : "";
  const model = typeof input.model === "string" ? input.model.trim() : "";
  const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
  if (!id.test(voice)) return { ok: false, error: "请选择有效的 ElevenLabs 声音" };
  if (!id.test(model)) return { ok: false, error: "请选择有效的 ElevenLabs 语音模型" };
  if (input.speed !== undefined && (typeof input.speed !== "number" || !Number.isFinite(input.speed) || input.speed < 0.7 || input.speed > 1.2)) {
    return { ok: false, error: "ElevenLabs 语速必须在 0.7–1.2 之间" };
  }
  return {
    ok: true,
    config: { provider: "elevenlabs-cli", baseUrl: "", apiKey: "", voice, model, ...(input.speed !== undefined ? { speed: input.speed as number } : {}) },
  };
}
