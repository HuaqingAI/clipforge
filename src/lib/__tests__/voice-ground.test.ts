import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { VOICE_GROUND_CHAIN, roomToneSource } from "../video-composer/voice-ground";
import { buildComposeCommand, buildComposeInvocation, type ComposeConfig } from "../video-composer/composer";
import { renderAudioStems } from "../audio-stems";

const { execFile } = vi.hoisted(() => ({
  execFile: vi.fn((...args: unknown[]) => {
    (args[3] as (error: null, stdout: string, stderr: string) => void)(null, "", "");
  }),
}));
vi.mock("child_process", () => ({ execFile, default: { execFile } }));

/**
 * Voice grounding is opt-in: explicit true applies the TTS chain and room-tone bed.
 * Default/false leave both out; native model audio never passes through the TTS chain.
 */

const cfg = (over: Partial<ComposeConfig["output"]> = {}, clips?: ComposeConfig["clips"]): ComposeConfig => ({
  projectId: "t",
  clips: clips ?? [
    { type: "image", filePath: "/tmp/a.jpg", duration: 3, transition: "direct_concat", motion: "static", audioPath: "/tmp/tts-1.mp3" },
    { type: "video", filePath: "/tmp/b.mp4", duration: 4, transition: "direct_concat", motion: "static", hasAudio: true },
  ],
  output: { resolution: "720p", aspectRatio: "9:16", ...over },
});

describe("voice grounding（TTS 人声落地）", () => {
  it("默认关闭：不处理 TTS 人声，也不添加房间底噪", () => {
    const cmd = buildComposeCommand(cfg());
    expect(cmd).not.toContain("aexciter");
    expect(cmd).not.toContain("anoisesrc");
    expect(cmd).not.toContain("[voice_grounded]");
    expect(buildComposeInvocation(cfg()).filterComplex).toBe(buildComposeInvocation(cfg({ voiceGround: false })).filterComplex);
  });

  it("显式开启时：TTS 流过去播音腔链 + 全片房间底噪垫底", () => {
    const cmd = buildComposeCommand(cfg({ voiceGround: true }));
    expect(cmd).toContain(VOICE_GROUND_CHAIN);
    expect(cmd).toContain("anoisesrc=colour=brown");
    expect(cmd).toContain("[voice_grounded]");
  });

  it("原生音轨永不过链：链只出现一次（挂在 TTS 输入流上）", () => {
    const cmd = buildComposeCommand(cfg({ voiceGround: true }));
    // 一条 TTS + 一条原生音轨 → 去播音腔链恰好一次
    expect(cmd.split("aexciter").length - 1).toBe(1);
  });

  it("voiceGround:false 不添加人声处理和底噪", () => {
    const off = buildComposeCommand(cfg({ voiceGround: false }));
    expect(off).not.toContain("aexciter");
    expect(off).not.toContain("anoisesrc");
  });

  it("纯原生人声轨：不过去播音腔链，但垫更轻的底噪统一空间感（0.004），切点带 20ms 边缘淡化", () => {
    const cmd = buildComposeCommand(
      cfg({ voiceGround: true }, [
        { type: "video", filePath: "/tmp/b.mp4", duration: 4, transition: "direct_concat", motion: "static", hasAudio: true },
        { type: "video", filePath: "/tmp/c.mp4", duration: 4, transition: "direct_concat", motion: "static", hasAudio: true },
      ])
    );
    expect(cmd).not.toContain("aexciter"); // 原生人声永不过链
    expect(cmd).toContain("amplitude=0.004"); // 更轻的底噪垫（TTS 轨才是 0.008）
    // 相邻原生切点用逐段 20ms 边缘淡化平滑底噪跳变（不用 acrossfade——那会逐接缝吃掉音轨时长造成音画漂移）
    expect(cmd).toContain("afade=t=in:st=0:d=0.02");
    expect(cmd).toContain("afade=t=out:st=3.980:d=0.02");
    expect(cmd).not.toContain("acrossfade");
  });

  it("纯原生人声轨默认不添加人声处理和底噪", () => {
    const cmd = buildComposeCommand(cfg({}, [
      { type: "video", filePath: "/tmp/b.mp4", duration: 4, transition: "direct_concat", hasAudio: true },
    ]));
    expect(cmd).not.toContain("aexciter");
    expect(cmd).not.toContain("anoisesrc");
  });

  it.each([undefined, false, true])("editable stems honor voiceGround=%s with the same opt-in processing", async voiceGround => {
    const directory = await mkdtemp(join(tmpdir(), "clipforge voice ground "));
    try {
      for (const nativeOnly of [false, true]) {
        execFile.mockClear();
        await renderAudioStems({
          clips: nativeOnly
            ? [{ type: "video", filePath: "/tmp/native.mp4", duration: 3, transition: "direct_concat", hasAudio: true }]
            : [{ duration: 3, transition: "direct_concat", audioPath: "/tmp/tts.mp3" }],
          totalDuration: 3,
          outputDir: join(directory, nativeOnly ? "native" : "tts"),
          ...(voiceGround === undefined ? {} : { voiceGround }),
        });
        expect(execFile).toHaveBeenCalledOnce();
        const args = execFile.mock.calls[0][1] as string[];
        const graph = args[args.indexOf("-filter_complex") + 1];
        expect(graph.includes(VOICE_GROUND_CHAIN)).toBe(voiceGround === true && !nativeOnly);
        expect(graph.includes("anoisesrc")).toBe(voiceGround === true);
        if (voiceGround === true && nativeOnly) expect(graph).toContain("amplitude=0.004");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("底噪源是 lavfi 合成（零素材依赖），限幅在察觉不到的量级并锁定 44100/立体声", () => {
    const src = roomToneSource();
    expect(src).toContain("amplitude=0.008");
    expect(src).toContain("lowpass=f=400");
    expect(src).toContain("channel_layouts=stereo");
  });
});
