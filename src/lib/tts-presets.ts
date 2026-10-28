/** Client-safe voiceover settings. Legacy API providers remain available to backend callers. */
import { validateElevenLabsConfig } from "@/lib/elevenlabs/config";
import { DEFAULT_FREE_VOICE, FREE_TTS_VOICES } from "@/lib/tts-voices";

export type VoiceoverProvider = "microsoft" | "elevenlabs-cli";
export type TTSProvider = "openai" | "atlas" | "minimax" | "falai" | VoiceoverProvider;

export interface TTSVoiceOption {
  value: string;
  label: string;
}

export interface TTSProviderMeta {
  value: VoiceoverProvider;
  label: string;
  baseUrl: string;
  defaultModel: string;
  models: TTSVoiceOption[];
  defaultVoice: string;
  voices: TTSVoiceOption[];
  hint?: string;
}

export const TTS_PROVIDERS: TTSProviderMeta[] = [
  {
    value: "microsoft",
    label: "微软 TTS · 免费",
    baseUrl: "",
    defaultModel: "",
    models: [],
    defaultVoice: DEFAULT_FREE_VOICE,
    voices: FREE_TTS_VOICES,
    hint: "无需账号或 API Key，使用微软免费配音。",
  },
  {
    value: "elevenlabs-cli",
    label: "ElevenLabs · 克隆声音 / 官方 CLI",
    baseUrl: "",
    defaultModel: "",
    models: [],
    defaultVoice: "",
    voices: [],
    hint: "使用官方 CLI 和本机 OAuth 登录，声音与模型从账号读取。",
  },
];

export const DEFAULT_TTS_PROVIDER: VoiceoverProvider = "microsoft";

/** Unknown and retired settings always return to the free provider. */
export function getTTSProviderMeta(provider?: string | null): TTSProviderMeta {
  return TTS_PROVIDERS.find((item) => item.value === provider) ?? TTS_PROVIDERS[0];
}

export interface NormalizedTTSSettings {
  enabled: boolean;
  provider: VoiceoverProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  speed?: number;
  groupId?: string;
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const validId = (value: unknown): string => typeof value === "string" && idPattern.test(value.trim()) ? value.trim() : "";

/** Strip retired paid-provider configuration, including credentials, on every hydration/update. */
export function normalizeTTSSettings(value: unknown): NormalizedTTSSettings {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  if (input.provider !== "microsoft" && input.provider !== "elevenlabs-cli") {
    return {
      enabled: true, provider: DEFAULT_TTS_PROVIDER, baseUrl: "", apiKey: "",
      model: "", voice: DEFAULT_FREE_VOICE, speed: 1,
    };
  }
  const cli = input.provider === "elevenlabs-cli";
  const speed = typeof input.speed === "number" && Number.isFinite(input.speed)
    && input.speed >= (cli ? 0.7 : 0.5) && input.speed <= (cli ? 1.2 : 2)
    ? input.speed : 1;
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : !cli,
    provider: input.provider,
    baseUrl: "",
    apiKey: "",
    model: cli ? validId(input.model) : "",
    voice: cli ? validId(input.voice)
      : FREE_TTS_VOICES.find((item) => item.value === input.voice)?.value ?? DEFAULT_FREE_VOICE,
    speed,
  };
}

type ProvidersLike = Record<string, { apiKey?: string; baseUrl?: string } | undefined>;

/** Fully resolved config. Microsoft is sent through the free-TTS route by callers. */
export interface ResolvedTTSConfig {
  provider: VoiceoverProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  speed?: number;
}

export function resolveTTSConfig(tts: unknown, providers?: ProvidersLike): ResolvedTTSConfig {
  // Keep the legacy call signature while ensuring platform keys cannot enter narration requests.
  void providers;
  const { provider, baseUrl, apiKey, model, voice, speed } = normalizeTTSSettings(tts);
  return { provider, baseUrl, apiKey, model, voice, ...(speed !== undefined ? { speed } : {}) };
}

/** Configuration readiness only: callers must additionally verify the local OAuth session. */
export function isPaidTTSReady(tts: unknown, providers?: ProvidersLike): boolean {
  const normalized = normalizeTTSSettings(tts);
  return normalized.enabled && normalized.provider === "elevenlabs-cli"
    && validateElevenLabsConfig(resolveTTSConfig(normalized, providers)).ok;
}
