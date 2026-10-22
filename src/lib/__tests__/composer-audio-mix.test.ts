// @vitest-environment node
import { execFile } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { afterEach, describe, expect, it } from "vitest";
import { ffmpegBin } from "@/lib/ffmpeg-path";
import { renderAudioStems } from "@/lib/audio-stems";
import { buildComposeInvocation, type ClipInput, type ComposeConfig } from "@/lib/video-composer/composer";
import { VOICE_GROUND_CHAIN } from "@/lib/video-composer/voice-ground";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const clip: ClipInput = { type: "video", filePath: "/source.mp4", hasAudio: true, audioPath: "/tts.wav", duration: 1.4, transition: "direct_concat" };
const config = (overrides: Partial<ClipInput> = {}, voiceGround = false): ComposeConfig => ({
  projectId: "audio-mix",
  clips: [{ ...clip, ...overrides }],
  output: { resolution: "720p", aspectRatio: "16:9", voiceGround },
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("native audio with generated narration", () => {
  it("keeps replacement as the default and mixes only when explicitly requested", () => {
    const replacement = buildComposeInvocation(config()).filterComplex;
    expect(replacement).toContain("[1:a]aresample");
    expect(replacement).not.toContain("[0:a]");
    expect(replacement).not.toContain("alimiter");
    const mixed = buildComposeInvocation(config({ mixNativeAudio: true }, true)).filterComplex;
    expect(mixed).toContain("[a0_tts][a0_native]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=0:latency=1[a0]");
    expect(mixed).toContain(`[1:a]aresample=44100,${VOICE_GROUND_CHAIN}`);
    expect(mixed).toContain("[0:a]aresample=44100,apad,atrim=duration=1.4,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.02,afade=t=out:st=1.380:d=0.02[a0_native]");
    expect(mixed.split(VOICE_GROUND_CHAIN)).toHaveLength(2);
  });

  it.each([
    { type: "image" as const },
    { hasAudio: false },
    { audioPath: undefined },
  ])("requires a video with both audio sources (%j)", (overrides) => {
    const graph = buildComposeInvocation(config({ mixNativeAudio: true, ...overrides })).filterComplex;
    expect(graph).not.toContain("alimiter");
    expect(graph).not.toContain("[a0_native]");
  });

  it("renders both frequencies in mix mode and its editable stem, without clipping or changing duration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clipforge audio mix "));
    temporaryDirectories.push(directory);
    const source = join(directory, "source.mp4");
    const tts = join(directory, "tts.wav");
    const generated = await Promise.allSettled([
      execFileAsync(ffmpegBin(), ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=30:d=1.4", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=1.4", "-af", "volume=7", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "pcm_s16le", "-f", "matroska", source]),
      execFileAsync(ffmpegBin(), ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100:duration=0.8", "-af", "volume=7", tts]),
    ]);
    for (const result of generated) {
      if (result.status === "rejected") throw result.reason;
    }

    async function renderAudio(mixNativeAudio: boolean): Promise<string> {
      const invocation = buildComposeInvocation(config({ filePath: source, audioPath: tts, mixNativeAudio }));
      const maps = invocation.outputArgs.flatMap((argument, index) => argument === "-map" ? [invocation.outputArgs[index + 1]] : []);
      const output = join(directory, mixNativeAudio ? "mixed.wav" : "replacement.wav");
      // Execute the actual composition graph; consume picture without spending time encoding it.
      await execFileAsync(ffmpegBin(), [...invocation.inputArgs, "-filter_complex", `${invocation.filterComplex};${maps[0]}nullsink`, "-map", maps[1], "-t", "1.4", "-c:a", "pcm_f32le", output]);
      return output;
    }
    const mixed = await renderAudio(true);
    const replacement = await renderAudio(false);
    const stems = await renderAudioStems({ clips: [{ ...clip, filePath: source, audioPath: tts, mixNativeAudio: true }], totalDuration: 1.4, outputDir: join(directory, "stems"), voiceGround: false });
    expect(stems.voicePath).toBeDefined();

    async function samples(path: string): Promise<Float32Array> {
      const { stdout } = await execFileAsync(ffmpegBin(), ["-v", "error", "-i", path, "-vn", "-af", "pan=mono|c0=c0", "-ar", "16000", "-f", "f32le", "pipe:1"], { encoding: "buffer" });
      return Float32Array.from({ length: stdout.length / 4 }, (_, index) => stdout.readFloatLE(index * 4));
    }
    function amplitude(audio: Float32Array, frequency: number, start = 0.2, end = 0.6): number {
      let sine = 0;
      let cosine = 0;
      const first = Math.round(start * 16000);
      const last = Math.round(end * 16000);
      for (let i = first; i < last; i += 1) {
        const phase = 2 * Math.PI * frequency * i / 16000;
        sine += audio[i] * Math.sin(phase);
        cosine += audio[i] * Math.cos(phase);
      }
      return 2 * Math.hypot(sine, cosine) / (last - first);
    }
    const [mixedSamples, replacementSamples, stemSamples] = await Promise.all([samples(mixed), samples(replacement), samples(stems.voicePath!)]);
    for (const audio of [mixedSamples, replacementSamples, stemSamples]) {
      expect(audio.length / 16000).toBeCloseTo(1.4, 2);
    }
    expect(amplitude(mixedSamples, 440)).toBeGreaterThan(0.04);
    expect(amplitude(mixedSamples, 880)).toBeGreaterThan(0.04);
    expect(amplitude(replacementSamples, 440)).toBeLessThan(amplitude(replacementSamples, 880) * 0.01);
    expect(amplitude(stemSamples, 440)).toBeGreaterThan(0.3);
    expect(amplitude(stemSamples, 880)).toBeGreaterThan(0.3);
    expect(Math.max(...stemSamples.map(Math.abs))).toBeLessThan(0.96);
    // The padded TTS tail stays silent while native audio continues to the end.
    expect(amplitude(stemSamples, 440, 1, 1.3)).toBeGreaterThan(0.6);
    expect(amplitude(stemSamples, 880, 1, 1.3)).toBeLessThan(0.002);
    // Limiter lookahead must not delay the waveform relative to the original source.
    const nativeSamples = await samples(source);
    const channelGain = amplitude(stemSamples, 440, 1, 1.3) / amplitude(nativeSamples, 440, 1, 1.3);
    let error = 0;
    for (let i = 16000; i < 20800; i += 1) error += Math.abs(stemSamples[i] - nativeSamples[i] * channelGain);
    expect(error / 4800).toBeLessThan(0.002);

    const nativeStems = await renderAudioStems({ clips: [{ ...clip, audioPath: undefined, filePath: source }], totalDuration: 1.4, outputDir: join(directory, "native-stem"), voiceGround: false });
    expect(amplitude(await samples(nativeStems.voicePath!), 440)).toBeGreaterThan(0.6);
  }, 30_000);
});
