import { NextRequest, NextResponse } from "next/server";
import { generateSpeech, type TTSConfig } from "@/lib/tts";
import { apiError, errText } from "@/lib/api-error";
import { validateElevenLabsConfig } from "@/lib/elevenlabs/config";
import { assertElevenLabsLocalRequest, elevenLabsRouteError } from "@/lib/elevenlabs/local-access";

// TTS voice preview: return mp3 audio bytes for the frontend to preview a voice
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { text } = body as { text?: string };
    let ttsConfig = body.ttsConfig as TTSConfig | undefined;

    if (typeof text !== "string" || !text.trim()) {
      return apiError(req, "缺少配音文本", "Missing voiceover text");
    }
    if (ttsConfig?.provider === "elevenlabs-cli") {
      const validation = validateElevenLabsConfig(ttsConfig);
      if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });
      try { await assertElevenLabsLocalRequest(req); }
      catch (error) { return elevenLabsRouteError(error); }
      ttsConfig = validation.config;
    } else if (!ttsConfig?.baseUrl || !ttsConfig?.apiKey || !ttsConfig?.model || !ttsConfig?.voice) {
      return apiError(
        req,
        "请先在设置中配置 TTS（baseUrl、apiKey、model、voice）",
        "Please configure TTS in settings first (baseUrl, apiKey, model, voice)"
      );
    }

    const audio = await generateSpeech(text, ttsConfig);
    return new NextResponse(new Uint8Array(audio), {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("TTS failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : errText(req, "TTS 失败", "TTS failed") },
      { status: 500 }
    );
  }
}
