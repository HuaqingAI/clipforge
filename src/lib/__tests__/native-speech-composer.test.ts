// @vitest-environment node
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ffmpegBin, ffprobeBin } from "@/lib/ffmpeg-path";
import { buildClipAudioFilters, buildComposeCommand, buildComposeInvocation, composeVideo, type ClipInput, type ComposeConfig } from "@/lib/video-composer/composer";
import { nativeSpeechSlotDuration } from "@/lib/tidewe/native-speech-edit";
import { renderAudioStems } from "@/lib/audio-stems";

const clip: ClipInput = { type: "video", filePath: "/tmp/native.mp4", duration: 5, sourceDuration: 5,
  transition: "direct_concat", hasAudio: true, strictSourceDuration: true, preserveNativeSpeech: true };
function config(clips: ClipInput[] = [clip]): ComposeConfig {
  return { projectId: "native-speech", clips, output: { resolution: "720p", aspectRatio: "9:16" } };
}

describe("native speech renderer guards", () => {
  it("retimes only the opt-in aligned window, synchronizing visible lips and preserving pitch", () => {
    const edited: ClipInput = { ...clip, preserveNativeSpeech: undefined, duration: 2, sourceDuration: 5,
      nativeSpeechEdit: { startSec: 1, endSec: 3.5, speed: 1.25, syncVideo: true, fadeInSec: 0.005, fadeOutSec: 0.005 } };
    const command = buildComposeCommand(config([edited]));
    expect(command).toContain("trim=start=1:end=3.5,setpts=(PTS-STARTPTS)/1.25");
    expect(command).toContain("atrim=start=1:end=3.5,asetpts=PTS-STARTPTS,atempo=1.25");
    expect(command).toContain("afade=t=in:st=0:d=0.005");
    const offCamera = buildComposeCommand(config([{ ...edited, nativeSpeechEdit: { ...edited.nativeSpeechEdit!, syncVideo: false } }]));
    expect(offCamera).toContain("trim=start=1:end=3,setpts=(PTS-STARTPTS)/1,");
    expect(offCamera).toContain("atempo=1.25");
    expect(() => buildComposeCommand(config([edited, { ...clip, transition: "ffmpeg_fade" }]))).toThrow("重叠语音");
    expect(() => buildComposeCommand(config([{ ...edited, duration: 1.9 }]))).toThrow("词对齐");
    expect(() => buildComposeCommand(config([{ ...edited, preserveNativeSpeech: true }]))).toThrow("词对齐");
  });

  it.each([
    { startSec: 0.1 + 0.2 - 0.3, endSec: 0.72, speed: 1.2, serializedEnd: "0.72" },
    { startSec: 1.3877787807814457e-17, endSec: 3.3964325074219706, speed: 1.0895500494798025, serializedEnd: "3.396433" },
  ])("uses the same decimal trim boundary for audio and visible speech at start=$startSec", ({ startSec, endSec, speed, serializedEnd }) => {
    const nativeSpeechEdit = { startSec, endSec, speed, syncVideo: true, fadeInSec: 0.0000007, fadeOutSec: 0.005 };
    const invocation = buildComposeInvocation(config([{ ...clip, preserveNativeSpeech: undefined,
      duration: nativeSpeechSlotDuration(nativeSpeechEdit), nativeSpeechEdit }]));
    const videoTrim = invocation.filterComplex.match(/\[0:v\]trim=start=([^:]+):end=([^,]+)/);
    const audioTrim = invocation.filterComplex.match(/\[0:a\]atrim=start=([^:]+):end=([^,]+)/);
    expect(videoTrim).not.toBeNull();
    expect(audioTrim?.slice(1)).toEqual(videoTrim?.slice(1));
    expect(videoTrim?.slice(1)).toEqual(["0", serializedEnd]);
    expect(invocation.filterComplex).not.toMatch(/=[+-]?\d+(?:\.\d+)?[eE][+-]?\d+/);
    expect(invocation.filterComplex).toContain("afade=t=in:st=0:d=0.000001");
  });

  it("rounds a residual fade start to zero and omits fades below timestamp precision", () => {
    const base = { duration: 0.005 + 1.3877787807814457e-17, nativeInput: "0", outputLabel: "voice" };
    const edit = { startSec: 0, endSec: 0.005, speed: 1, syncVideo: true };
    const faded = buildClipAudioFilters({ ...base, nativeSpeechEdit: { ...edit, fadeOutSec: 0.005 } }).join(";");
    expect(faded).toContain("afade=t=out:st=0:d=0.005");
    const inaudibleFades = buildClipAudioFilters({ ...base, nativeSpeechEdit: { ...edit, fadeInSec: 1e-17, fadeOutSec: 1e-17 } }).join(";");
    // FFmpeg interprets d=0 as its default sample-count fade, which would attenuate real speech.
    expect(inaudibleFades).not.toContain("afade=");
    expect(inaudibleFades).not.toMatch(/=[+-]?\d+(?:\.\d+)?[eE][+-]?\d+/);
  });

  it("keeps native speech at source speed without edge fades, TTS or fabricated room tone", () => {
    const command = buildComposeCommand(config());
    expect(command).toContain("[0:a]");
    expect(command).not.toContain("setpts=PTS/");
    expect(command).not.toContain("atempo");
    expect(command).not.toContain("afade");
    expect(command).not.toContain("acrossfade");
    expect(command).not.toContain("aexciter");
    expect(command).not.toContain("anoisesrc");
  });

  it.each<Partial<ClipInput>>([
    { duration: 4 }, { duration: 6 }, { sourceDuration: undefined }, { hasAudio: false },
    { audioPath: "/tmp/second-voice.mp3" }, { mixNativeAudio: true },
  ])("rejects native speech mutations: %j", override => {
    expect(() => buildComposeCommand(config([{ ...clip, ...override }]))).toThrow("原生口播");
  });

  it("honors an explicit cross-fade while keeping complete native inputs at source speed", () => {
    const command = buildComposeCommand(config([clip, { ...clip, transition: "ffmpeg_fade" }]));
    expect(command).toContain("xfade=transition=fade:duration=0.5:offset=4.5");
    expect(command).toContain("acrossfade=d=0.5");
    expect(command).toContain("-t 9.5");
    expect(command).not.toContain("setpts=PTS/");
    expect(command).not.toContain("atempo");
    expect(command).not.toContain("afade=t=");
    expect(command).not.toContain("aexciter");
    expect(command).not.toContain("anoisesrc");
  });
});

describe("native speech transition rendering", () => {
  const exec = promisify(execFile);
  let directory: string;
  let sources: ClipInput[];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "clipforge-native-transitions-"));
    vi.stubEnv("APP_DATA_DIR", directory);
    sources = [];
    for (const [color, frequency] of [["red", 440], ["blue", 880]] as const) {
      const path = join(directory, `${color}.mp4`);
      await exec(ffmpegBin(), ["-v", "error", "-y",
        "-f", "lavfi", "-i", `color=c=${color}:s=64x64:r=30:d=2`,
        "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=44100:duration=2`,
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", "2", path,
      ], { timeout: 15_000 });
      sources.push({ ...clip, filePath: path, duration: 2, sourceDuration: 2 });
    }
  }, 30_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function pixelAt(path: string, seconds: number): Promise<number[]> {
    const { stdout } = await exec(ffmpegBin(), ["-v", "error", "-ss", String(seconds), "-i", path,
      "-vf", "crop=2:2:(iw-2)/2:(ih-2)/2,format=rgb24", "-frames:v", "1", "-f", "rawvideo", "pipe:1",
    ], { encoding: "buffer", timeout: 15_000 });
    expect(stdout.length).toBe(12);
    return [...stdout.subarray(0, 3)];
  }

  it("renders residual trim starts and sub-microsecond fades without muting speech or shifting A/V cuts", async () => {
    const clips = sources.map((source, index): ClipInput => {
      const nativeSpeechEdit = {
        startSec: index === 0 ? 0.1 + 0.2 - 0.3 : 1.3877787807814457e-17,
        endSec: 0.7, speed: 1, syncVideo: true,
        fadeInSec: index === 0 ? 1e-17 : 0.0000007, fadeOutSec: 1e-17,
      };
      return { ...source, preserveNativeSpeech: undefined, duration: nativeSpeechSlotDuration(nativeSpeechEdit), nativeSpeechEdit };
    });
    const renderConfig = config(clips);
    renderConfig.output = { ...renderConfig.output, aspectRatio: "16:9", videoPreset: "ultrafast" };
    const output = await composeVideo(renderConfig);
    const expectedDuration = 1.4;
    const { stdout } = await exec(ffprobeBin(), ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", output]);
    const { streams } = JSON.parse(stdout) as { streams: { codec_type: string; duration: string }[] };
    expect(streams.map(stream => stream.codec_type)).toEqual(["video", "audio"]);
    for (const stream of streams) expect(Math.abs(Number(stream.duration) - expectedDuration)).toBeLessThan(1 / 30);
    expect(Math.abs(Number(streams[0].duration) - Number(streams[1].duration))).toBeLessThan(1 / 30);
    const beforeCut = await pixelAt(output, 0.5);
    const afterCut = await pixelAt(output, 0.9);
    expect(beforeCut[0]).toBeGreaterThan(220);
    expect(beforeCut[2]).toBeLessThan(20);
    expect(afterCut[0]).toBeLessThan(20);
    expect(afterCut[2]).toBeGreaterThan(220);

    const stems = await renderAudioStems({ clips, totalDuration: expectedDuration, outputDir: join(directory, "residual-time-stems") });
    for (const path of [output, stems.voicePath!]) {
      const { stdout: samples } = await exec(ffmpegBin(), ["-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"],
        { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 });
      expect(samples.length / 4 / 16000).toBeCloseTo(expectedDuration, 1);
      const amplitude = (frequency: number, seconds: number) => {
        const from = Math.round(seconds * 16000);
        const length = 1600;
        let sine = 0; let cosine = 0;
        for (let i = 0; i < length; i++) {
          const sample = samples.readFloatLE((from + i) * 4);
          sine += sample * Math.sin(2 * Math.PI * frequency * i / 16000);
          cosine += sample * Math.cos(2 * Math.PI * frequency * i / 16000);
        }
        return 2 * Math.hypot(sine, cosine) / length;
      };
      // A rounded d=0 would silently introduce FFmpeg's one-second default fade.
      expect(amplitude(440, 0.1)).toBeGreaterThan(0.07);
      expect(amplitude(440, 0.5)).toBeGreaterThan(0.07);
      expect(amplitude(880, 0.9)).toBeGreaterThan(0.07);
      expect(amplitude(880, 0.5)).toBeLessThan(0.01);
      expect(amplitude(440, 0.9)).toBeLessThan(0.01);
    }
  }, 60_000);

  it("renders seven fractional edits without cumulative A/V drift and keeps pitch in both output and stem", async () => {
    const edit = { startSec: 0.15, endSec: 1.74, speed: 1.17, syncVideo: true, fadeInSec: 0.005, fadeOutSec: 0.005 };
    const duration = nativeSpeechSlotDuration(edit);
    const clips = Array.from({ length: 7 }, (_, index): ClipInput => ({ ...sources[0],
      preserveNativeSpeech: undefined, duration, nativeSpeechEdit: { ...edit, syncVideo: index % 2 === 0 } }));
    const renderConfig = config(clips);
    renderConfig.output = { ...renderConfig.output, aspectRatio: "16:9", videoPreset: "ultrafast" };
    const output = await composeVideo(renderConfig);
    const totalDuration = duration * clips.length;
    const { stdout } = await exec(ffprobeBin(), ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", output]);
    const { streams } = JSON.parse(stdout) as { streams: { codec_type: string; duration: string }[] };
    for (const stream of streams) expect(Number(stream.duration)).toBeCloseTo(totalDuration, 2);
    const stems = await renderAudioStems({ clips, totalDuration, outputDir: join(directory, "paced-stems") });
    for (const path of [output, stems.voicePath!]) {
      const { stdout: samples } = await exec(ffmpegBin(), ["-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"],
        { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 });
      expect(samples.length / 4 / 16000).toBeCloseTo(totalDuration, 1);
      const from = Math.round((duration * 6 + 0.3) * 16000);
      const length = 8000;
      const amplitude = (frequency: number) => {
        let sine = 0; let cosine = 0;
        for (let i = 0; i < length; i++) {
          const sample = samples.readFloatLE((from + i) * 4);
          sine += sample * Math.sin(2 * Math.PI * frequency * i / 16000);
          cosine += sample * Math.cos(2 * Math.PI * frequency * i / 16000);
        }
        return 2 * Math.hypot(sine, cosine) / length;
      };
      expect(amplitude(440)).toBeGreaterThan(0.05);
      expect(amplitude(440 * edit.speed)).toBeLessThan(0.01);
    }
  }, 60_000);

  it("renders selected hard cuts and cross-fades with different pixels and matching audio/video durations", async () => {
    for (const transition of ["direct_concat", "ffmpeg_fade"] as const) {
      const renderConfig = config([sources[0], { ...sources[1], transition }]);
      renderConfig.output = { ...renderConfig.output, aspectRatio: "16:9", videoPreset: "ultrafast" };
      const output = await composeVideo(renderConfig);
      const { stdout } = await exec(ffprobeBin(), ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", output]);
      const { streams } = JSON.parse(stdout) as { streams: { codec_type: string; duration: string }[] };
      const expectedDuration = transition === "ffmpeg_fade" ? 3.5 : 4;
      expect(streams.map((stream) => stream.codec_type)).toEqual(["video", "audio"]);
      for (const stream of streams) expect(Number(stream.duration)).toBeCloseTo(expectedDuration, 1);
      const midpoint = await pixelAt(output, 1.75);
      if (transition === "ffmpeg_fade") {
        expect(midpoint[0]).toBeGreaterThan(80);
        expect(midpoint[2]).toBeGreaterThan(80);
        expect(midpoint[1]).toBeLessThan(20);
      } else {
        expect(midpoint[0]).toBeGreaterThan(220);
        expect(midpoint[2]).toBeLessThan(20);
        const afterCut = await pixelAt(output, 2.1);
        expect(afterCut[0]).toBeLessThan(20);
        expect(afterCut[2]).toBeGreaterThan(220);
      }
    }
  }, 60_000);
});
