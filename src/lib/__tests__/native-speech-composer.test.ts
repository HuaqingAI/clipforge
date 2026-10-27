import { describe, expect, it } from "vitest";
import { buildComposeCommand, type ClipInput, type ComposeConfig } from "@/lib/video-composer/composer";

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
    { audioPath: "/tmp/second-voice.mp3" }, { mixNativeAudio: true }, { transition: "ffmpeg_fade" },
  ])("rejects native speech mutations: %j", override => {
    expect(() => buildComposeCommand(config([{ ...clip, ...override }]))).toThrow("原生口播");
  });

  it("rejects a following fade that would consume the end of native dialogue", () => {
    expect(() => buildComposeCommand(config([clip, { ...clip, transition: "ffmpeg_fade", preserveNativeSpeech: false }]))).toThrow("原生口播");
  });
});
