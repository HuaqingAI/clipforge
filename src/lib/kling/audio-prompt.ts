import { VIDEO_AUDIO_DIRECTIONS, withVideoAudioMode } from "@/lib/video-audio";

export const KLING_SILENT_PROMPT_SUFFIX = `${VIDEO_AUDIO_DIRECTIONS.silent.zh}。`;

/** Apply the selected sound mode, including after manual edits and legacy draft loads. */
export function klingAudioPrompt(prompt: string, generateAudio: boolean): string {
  // Native sound may include explicit manual dialogue; never inject an ambient-only speech ban.
  return withVideoAudioMode(prompt, generateAudio ? "native" : "silent");
}
