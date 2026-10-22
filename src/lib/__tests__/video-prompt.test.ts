import { describe, expect, it } from "vitest";
import { joinVideoPromptParts, validateVideoPrompt, VIDEO_PROMPT_VERSION } from "@/lib/video-prompt";

const codes = (prompt: string) => validateVideoPrompt(prompt).map((issue) => issue.code);

describe("video prompt assembly and final checks", () => {
  it("normalizes section boundaries without changing decimals or display copy", () => {
    expect(VIDEO_PROMPT_VERSION).toBe(2);
    expect(joinVideoPromptParts(["固定镜头。", "。场景：显示“价。。格 2.5 元。”。", "", "保持清晰！"], "zh"))
      .toBe("固定镜头。场景：显示“价。。格 2.5 元。”。保持清晰。");
    expect(joinVideoPromptParts(["Fixed camera.", 'Display "Price 2.5!".', "Don't move.."], "en"))
      .toBe('Fixed camera. Display "Price 2.5!". Don\'t move.');
    expect(joinVideoPromptParts([" ", "。。"], "zh")).toBe("");
  });

  it("joins explicit paragraphs without splitting quoted labels or flattening nested sections", () => {
    const scene = '场景：字幕显示“光线：价。。格 2.5 元。”与 "Camera: fixed. Scene: blue."。';
    const visual = joinVideoPromptParts(["UGC 实拍。", "运镜：向右漂移。", scene], "zh", "\n");
    expect(visual).toBe(`UGC 实拍。\n运镜：向右漂移。\n${scene}`);
    expect(joinVideoPromptParts([visual, "Project direction: keep the label."], "zh", "\n"))
      .toBe(`${visual}\nProject direction: keep the label。`);
    expect(joinVideoPromptParts(["Camera: move right.", 'Scene: display "Price 2.5!".'], "en", "\n"))
      .toBe('Camera: move right.\nScene: display "Price 2.5!".');
  });

  it.each(["底部小字为“价。", "下方小字显示‘*商家标称，非。", 'Display "Price.', "意外的结束引号”", "显示「价。", "显示『价。"])("detects incomplete quotes: %s", (prompt) => {
    expect(codes(prompt)).toContain("unclosed_quote");
  });
  it("accepts paired nested quotes, escaped ASCII quotes and ordinary apostrophes", () => {
    expect(codes('Display "don\'t move". “写着‘价格’。”')).not.toContain("unclosed_quote");
    expect(codes('Display "a \\"quote\\"". Don\'t alter the product.')).not.toContain("unclosed_quote");
    expect(codes("The creator’s camera stays on the product’s screen.")).not.toContain("unclosed_quote");
  });
  it.each([
    ["固定镜头。运镜幅度大胆明显。", "camera_conflict"],
    ["固定机位。镜头平稳向左横移。", "camera_conflict"],
    ["商品与购买引导保持静止。手部演示动作自然连贯，转动机身。", "subject_conflict"],
    ["背景为纯净浅蓝色。背景一盏灯的光斑缓慢呼吸。", "background_conflict"],
    ["视频全程静音。音效：自然环境音与动作音效贴合画面。", "audio_conflict"],
    ["Fixed camera. Camera pans left.", "camera_conflict"],
    ["Camera: static. bold pronounced camera movement.", "camera_conflict"],
    ["Product remains stationary. Rotate the product.", "subject_conflict"],
    ["Plain blue background. A lamp in the background.", "background_conflict"],
    ["Silent video. Add ambient sound.", "audio_conflict"],
    ["视频全程静音，保留环境音。", "audio_conflict"],
  ])("flags explicit incompatible instructions: %s", (prompt, expected) => {
    expect(codes(prompt)).toContain(expected);
  });
  it.each([
    "固定镜头，商品在转盘上缓缓旋转。", // Camera stability does not imply product stillness.
    "镜头平稳向左横移。商品保持静止，金属上一道高光缓缓扫过。",
    "固定镜头。不要移动镜头。商品保持静止，不要转动机身。",
    "固定镜头。屏幕文字保持清晰稳定。",
    "背景为纯净浅蓝色，不出现背景人物、灯的光斑。视频全程保持静音，不生成人声、旁白、环境音或音效。",
    "先固定镜头，再平移镜头。商品先保持静止，然后转动机身。",
    "Fixed camera first, then camera pans left. Don't rotate the product.",
    '固定镜头。显示“镜头平稳横移、转动机身、环境音”。视频全程静音。',
    '商品保持静止，标语为“商品旋转”；背景为纯色，文案为“背景一盏灯”。',
    "Static camera. No camera movement. Product remains still. No sound or voiceover.",
    "Fixed camera. A frying pan is on the table. The product label lists a zoom feature.",
    "商品保持静止不动，不旋转。镜头向左平移。",
    "Audio: keep the entire video silent; do not generate speech, narration, dialogue, music, ambience, or sound effects.",
    "固定镜头，主体保持静止。声音要求：视频全程静音，不生成人声、旁白、对白、背景音乐、环境音或音效。",
    "固定镜头。显示「镜头向左横移」与『手部演示』。",
  ])("does not flag valid instructions or quoted copy: %s", (prompt) => {
    expect(validateVideoPrompt(prompt)).toEqual([]);
  });
  it("reports local submission format limits", () => {
    expect(codes(" ")).toContain("empty");
    expect(codes("a".repeat(12_001))).toContain("too_long");
    expect(codes("test\0")).toContain("nul");
    expect(codes("  --flag")).toContain("invalid_start");
  });
});
