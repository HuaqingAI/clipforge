/** Browser-safe data only. OAuth credentials remain in the CLI's OS keyring. */
export const ELEVENLABS_CLI_VERSION = "1.8.0";

export interface ElevenLabsAuthState {
  state: "idle" | "pending" | "success" | "error";
  message?: string;
}

export interface ElevenLabsStatus {
  installed: boolean;
  authenticated: boolean;
  version?: string;
  message?: string;
  auth: ElevenLabsAuthState;
}

export interface ElevenLabsVoice {
  id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
  previewUrl?: string;
}

export interface ElevenLabsModel {
  id: string;
  name: string;
  description?: string;
  languages: { id: string; name: string }[];
}

export interface ElevenLabsCatalog {
  voices: ElevenLabsVoice[];
  models: ElevenLabsModel[];
}
