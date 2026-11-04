// @vitest-environment node
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ffmpegBin, ffprobeBin } from "@/lib/ffmpeg-path";
import { buildComposeCommand, composeVideo, type ClipInput, type ComposeConfig } from "@/lib/video-composer/composer";

const clip: ClipInput = { type: "video", filePath: "/tmp/native.mp4", duration: 5, sourceDuration: 5,
  transition: "direct_concat", hasAudio: true, strictSourceDuration: true, preserveNativeSpeech: true };
function config(clips: ClipInput[] = [clip]): ComposeConfig {
  return { projectId: "native-speech", clips, output: { resolution: "720p", aspectRatio: "9:16", voiceGround: false } };
}

describe("native speech renderer guards", () => {
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
