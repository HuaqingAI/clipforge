import { mkdir } from "fs/promises";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { ffmpegBin } from "@/lib/ffmpeg-path";
import { buildClipAudioFilters, type ClipInput } from "@/lib/video-composer/composer";
import { roomToneSource } from "@/lib/video-composer/voice-ground";

const execFileAsync = promisify(execFile);
const FADE_DURATION = 0.5;

export interface AudioStemClip {
  duration: number;
  transition: string;
  audioPath?: string;
  type?: ClipInput["type"];
  filePath?: string;
  hasAudio?: boolean;
  mixNativeAudio?: boolean;
  preserveNativeSpeech?: boolean;
}

export interface RenderAudioStemsInput {
  clips: AudioStemClip[];
  bgmPath?: string;
  bgmVolume?: number;
  totalDuration: number;
  outputDir: string;
  voiceGround?: boolean;
}

export interface RenderAudioStemsResult {
  voicePath?: string;
  bgmPath?: string;
}

function hasNativeAudio(clip: AudioStemClip): boolean {
  return clip.type === "video" && Boolean(clip.filePath && clip.hasAudio) && (!clip.audioPath || clip.mixNativeAudio === true);
}

function buildVoiceArgs(input: RenderAudioStemsInput, outputPath: string): string[] | null {
  const { clips } = input;
  const hasTtsTrack = clips.some((clip) => clip.audioPath);
  if (!hasTtsTrack && !clips.some(hasNativeAudio)) return null;
  const args = ["-y"];
  const filters: string[] = [];
  let inputIndex = 0;
  clips.forEach((clip, index) => {
    let ttsInput: string | undefined;
    let nativeInput: string | undefined;
    if (clip.audioPath) {
      args.push("-i", clip.audioPath);
      ttsInput = String(inputIndex++);
    }
    if (hasNativeAudio(clip)) {
      args.push("-i", clip.filePath!);
      nativeInput = String(inputIndex++);
    }
    filters.push(...buildClipAudioFilters({
      duration: clip.duration,
      outputLabel: `v${index}`,
      ttsInput,
      nativeInput,
      voiceGround: input.voiceGround === true && hasTtsTrack,
      preserveNativeSpeech: clip.preserveNativeSpeech,
    }));
  });
  let current = "v0";
  for (let i = 1; i < clips.length; i += 1) {
    const next = `mix${i}`;
    const fadeDuration = Math.min(FADE_DURATION, clips[i - 1].duration, clips[i].duration);
    if (clips[i].transition === "ffmpeg_fade" && fadeDuration > 0.01) {
      filters.push(`[${current}][v${i}]acrossfade=d=${fadeDuration.toFixed(3)}[${next}]`);
    } else {
      filters.push(`[${current}][v${i}]concat=n=2:v=0:a=1[${next}]`);
    }
    current = next;
  }
  if (input.voiceGround === true) {
    filters.push(`${roomToneSource(hasTtsTrack ? undefined : 0.004)}[roomtone]`);
    filters.push(`[${current}][roomtone]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[voice_grounded]`);
    current = "voice_grounded";
  }
  args.push("-filter_complex", filters.join(";"), "-map", `[${current}]`, "-t", input.totalDuration.toFixed(3), "-c:a", "pcm_s16le", "-ar", "44100", "-ac", "2", outputPath);
  return args;
}

function buildBgmArgs(input: RenderAudioStemsInput, outputPath: string): string[] | null {
  if (!input.bgmPath || input.totalDuration <= 0) return null;
  const volume = Math.min(0.4, Math.max(0.05, input.bgmVolume ?? 0.18));
  const fadeStart = Math.max(0, input.totalDuration - 3);
  return [
    "-y", "-stream_loop", "-1", "-i", input.bgmPath,
    "-t", input.totalDuration.toFixed(3),
    "-af", `aresample=44100,volume=${volume},afade=t=out:st=${fadeStart.toFixed(3)}:d=3`,
    "-c:a", "pcm_s16le", "-ar", "44100", "-ac", "2", outputPath,
  ];
}

/** Render optional, editable audio stems without exposing absolute source paths. */
export async function renderAudioStems(input: RenderAudioStemsInput): Promise<RenderAudioStemsResult> {
  await mkdir(input.outputDir, { recursive: true });
  const result: RenderAudioStemsResult = {};
  const voicePath = join(input.outputDir, "voice.wav");
  const voiceArgs = buildVoiceArgs(input, voicePath);
  if (voiceArgs) {
    await execFileAsync(ffmpegBin(), voiceArgs, { maxBuffer: 10 * 1024 * 1024 });
    result.voicePath = voicePath;
  }
  const bgmPath = join(input.outputDir, "bgm.wav");
  const bgmArgs = buildBgmArgs(input, bgmPath);
  if (bgmArgs) {
    await execFileAsync(ffmpegBin(), bgmArgs, { maxBuffer: 10 * 1024 * 1024 });
    result.bgmPath = bgmPath;
  }
  return result;
}
