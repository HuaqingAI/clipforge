import { describe, expect, it } from "vitest";
import { klingAudioPrompt, KLING_SILENT_PROMPT_SUFFIX } from "@/lib/kling/audio-prompt";
import { LEGACY_SILENT_PROMPT_SUFFIX, VIDEO_AUDIO_DIRECTIONS, stripManagedVideoAudio, withVideoAudioMode } from "@/lib/video-audio";

describe("Kling audio prompt normalization", () => {
  it("replaces the conflicting generated audio in the reported Chinese prompt with one silence constraint", () => {
    const visual = "完整商品原图静止居中，背景为纯净浅蓝色。底部小字为“价格、使用及清洗要求以商品页和说明书为准”。";
    const input = `${visual}${VIDEO_AUDIO_DIRECTIONS.ambient.zh}。画面稳定流畅，无闪烁。\n\n${LEGACY_SILENT_PROMPT_SUFFIX}`;
    const result = klingAudioPrompt(input, false);
    expect(result).toContain(visual);
    expect(result).toContain("画面稳定流畅，无闪烁。");
    expect(result).not.toContain("音效：自然环境音");
    expect(result).not.toContain("覆盖前文");
    expect(result.split(KLING_SILENT_PROMPT_SUFFIX)).toHaveLength(2);
    expect(klingAudioPrompt(result, false)).toBe(result);
  });

  it("cleans English template audio without touching the following visual instructions", () => {
    const input = `Camera: locked off. ${VIDEO_AUDIO_DIRECTIONS.ambient.en}. Keep the printed text sharp.`;
    const result = klingAudioPrompt(input, false);
    expect(result).not.toContain("sound: natural ambient");
    expect(result).toContain("Camera: locked off.");
    expect(result).toContain("Keep the printed text sharp.");
    expect(result.endsWith(`${VIDEO_AUDIO_DIRECTIONS.silent.en}.`)).toBe(true);
    expect(result).not.toContain(VIDEO_AUDIO_DIRECTIONS.silent.zh);
  });

  it("keeps English audio direction after repeated sound changes and removes old Chinese suffixes", () => {
    const scene = "Camera tracks left. Keep the product label unchanged.";
    const muted = klingAudioPrompt(`${scene}\n\n${LEGACY_SILENT_PROMPT_SUFFIX}`, false);
    expect(muted).toBe(`${scene}\n\n${VIDEO_AUDIO_DIRECTIONS.silent.en}.`);

    const audible = klingAudioPrompt(klingAudioPrompt(muted, true), true);
    expect(audible).toBe(`${scene}\n\n${VIDEO_AUDIO_DIRECTIONS.native.en}.`);
    expect(audible.split(VIDEO_AUDIO_DIRECTIONS.native.en)).toHaveLength(2);
    expect(audible).not.toContain(VIDEO_AUDIO_DIRECTIONS.native.zh);
    expect(audible).not.toContain(VIDEO_AUDIO_DIRECTIONS.silent.en);

    const mutedAgain = klingAudioPrompt(klingAudioPrompt(audible, false), false);
    expect(mutedAgain).toBe(muted);
    expect(mutedAgain.split(VIDEO_AUDIO_DIRECTIONS.silent.en)).toHaveLength(2);
  });

  it("keeps the full audio sentence when it is literal screen copy inside Chinese or English quotes", () => {
    const text = `屏幕显示“${VIDEO_AUDIO_DIRECTIONS.ambient.zh}。”，下方显示 "${LEGACY_SILENT_PROMPT_SUFFIX}"。`;
    expect(klingAudioPrompt(text, false)).toBe(`${text}\n\n${KLING_SILENT_PROMPT_SUFFIX}`);
  });

  it("preserves visual prose after an audio label rather than removing an arbitrary paragraph", () => {
    const manual = "音效：杯壁透明，底座边缘清晰；画面中显示“音效：自然环境音与动作音效贴合画面”。";
    expect(klingAudioPrompt(manual, false)).toContain(manual);
    const extended = "音效：自然环境音与动作音效贴合画面并展示蓝色价签。";
    expect(klingAudioPrompt(extended, false)).toContain(extended);
  });

  it("restores sound after mode toggles without banning manually requested dialogue", () => {
    const manual = "固定镜头，人物说出“现在就试试”。原生音频必须逐字说出以下台词：\"现在就试试\"。";
    const muted = klingAudioPrompt(manual, false);
    const audible = klingAudioPrompt(muted, true);
    expect(audible).toContain(manual);
    expect(audible).toContain(VIDEO_AUDIO_DIRECTIONS.native.zh);
    expect(audible).not.toMatch(/全程静音|无人声说话|no speech/i);
    expect(klingAudioPrompt(audible, true)).toBe(audible);
    expect(klingAudioPrompt(audible, false)).toBe(muted);
  });

  it("repairs previously saved silent suffixes when switching sound on", () => {
    const result = klingAudioPrompt(`固定镜头。\n\n${LEGACY_SILENT_PROMPT_SUFFIX}\n\n${LEGACY_SILENT_PROMPT_SUFFIX}`, true);
    expect(result).toContain("固定镜头。");
    expect(result).toContain(VIDEO_AUDIO_DIRECTIONS.native.zh);
    expect(result).not.toContain("不生成声音");
    expect(result).not.toContain("覆盖前文");
  });

  it("supports empty draft text and does not create an audio-only scene", () => {
    expect(klingAudioPrompt("   ", false)).toBe("");
    expect(klingAudioPrompt(LEGACY_SILENT_PROMPT_SUFFIX, true)).toBe("");
  });

  it("normalizes both legacy film strategies without losing the shot description", () => {
    const visual = "Product on a table. Keep all labels unchanged.";
    const legacy = "保留与画面匹配的环境声和音效，无口播、无对白；旁白将在后期叠加。Preserve matching ambience and sound effects. No speech or dialogue; narration will be mixed in later.";
    const result = withVideoAudioMode(`${visual}\n${legacy}`, "native");
    expect(result).toContain(visual);
    expect(result).toContain(VIDEO_AUDIO_DIRECTIONS.native.en);
    expect(result).not.toMatch(/No speech|无对白/);
  });

  it("leaves apostrophes in English prose outside literal quote protection", () => {
    expect(stripManagedVideoAudio(`The creator's phone stays still. ${VIDEO_AUDIO_DIRECTIONS.ambient.en}.`)).toBe("The creator's phone stays still.");
  });
});
