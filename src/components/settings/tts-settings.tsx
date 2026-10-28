"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { ElevenLabsVoiceSelector } from "@/components/elevenlabs-voice-selector";
import { FreeVoicePreview } from "@/components/free-voice-preview";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { normalizeTTSSettings, TTS_PROVIDERS, type VoiceoverProvider } from "@/lib/tts-presets";
import { DEFAULT_FREE_VOICE, FREE_TTS_VOICES, ttsVoicePreviewText } from "@/lib/tts-voices";
import { ElevenLabsVoicePreview } from "@/components/elevenlabs-voice-preview";
import { useLocale, useT } from "@/lib/i18n";

export function TTSSettings() {
  const t = useT("settings");
  const locale = useLocale();
  const { tts: storedTts, setTTS } = useSettingsStore();
  const tts = normalizeTTSSettings(storedTts);
  const [elevenLabsReady, setElevenLabsReady] = useState(false);
  const selectionKey = `${tts.provider}:${tts.voice}:${tts.model}:${tts.speed ?? 1}`;

  function changeProvider(provider: VoiceoverProvider) {
    if (provider === tts.provider) return;
    setElevenLabsReady(false);
    setTTS({
      enabled: tts.enabled,
      provider,
      baseUrl: "",
      apiKey: "",
      model: "",
      voice: provider === "microsoft" ? DEFAULT_FREE_VOICE : "",
      speed: 1,
    });
  }

  return (
    <Card className="glass-card">
      <CardContent className="space-y-4 p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-rose-500 to-pink-600 text-white" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" /><path d="M12 19v3" />
              </svg>
            </div>
            <div>
              <h3 className="text-sm font-semibold">{t("ttsTitle")}</h3>
              <p className="text-xs text-muted-foreground">{t("ttsSubtitle")}</p>
            </div>
          </div>
          <ToggleSwitch checked={tts.enabled} aria-label={t("ttsEnable")} onChange={(enabled) => { setElevenLabsReady(false); setTTS({ ...tts, enabled }); }} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="tts-provider" className="text-xs text-muted-foreground">{t("ttsProviderLabel")}</Label>
          <select id="tts-provider" aria-label={t("ttsProviderLabel")} value={tts.provider} onChange={(event) => changeProvider(event.target.value as VoiceoverProvider)} className="h-9 w-full rounded-md border border-border/50 bg-muted/30 px-2 text-xs">
            {TTS_PROVIDERS.map((provider) => <option key={provider.value} value={provider.value}>{t(provider.value === "microsoft" ? "ttsMicrosoftService" : "ttsElevenLabsService")}</option>)}
          </select>
        </div>

        {!tts.enabled ? (
          <p role="status" className="text-xs text-muted-foreground">{t(tts.provider === "elevenlabs-cli" ? "ttsElevenLabsDisabled" : "ttsDisabled")}</p>
        ) : tts.provider === "microsoft" ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">{t("ttsMicrosoftHint")}</p>
            <div className="space-y-1.5">
              <Label htmlFor="tts-microsoft-voice" className="text-xs text-muted-foreground">{t("ttsVoiceLabel")}</Label>
              <select id="tts-microsoft-voice" aria-label={t("ttsVoiceLabel")} value={tts.voice} onChange={(event) => setTTS({ ...tts, voice: event.target.value })} className="h-9 w-full rounded-md border border-border/50 bg-muted/30 px-2 text-xs">
                {FREE_TTS_VOICES.map((voice) => <option key={voice.value} value={voice.value}>{locale === "zh" ? voice.labelZh ?? voice.label : voice.label}</option>)}
              </select>
            </div>
            <FreeVoicePreview key={`${tts.voice}:${locale}`} voice={tts.voice} text={ttsVoicePreviewText(tts.voice)} />
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">{t("ttsElevenLabsHint")}</p>
            <ElevenLabsVoiceSelector voice={tts.voice} model={tts.model} onVoiceChange={(voice) => setTTS({ ...tts, voice })} onModelChange={(model) => setTTS({ ...tts, model })} onReadyChange={setElevenLabsReady} />
            <ElevenLabsVoicePreview key={`${selectionKey}:${locale}:${elevenLabsReady}`} voice={tts.voice} model={tts.model} speed={tts.speed} ready={elevenLabsReady} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
