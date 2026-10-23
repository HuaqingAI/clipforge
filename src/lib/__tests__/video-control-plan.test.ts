import { describe, expect, it } from "vitest";
import { buildVideoControlPlan, sanitizeVideoControlSummary } from "@/lib/video-control-plan";

describe("video control plan", () => {
  it("uses an Atlas reference sibling for a multi-subject pack", () => {
    const plan = buildVideoControlPlan({
      provider: "atlas-cloud",
      modelId: "bytedance/seedance-2.5/image-to-video",
      supportsAudio: true,
      firstFrameUrl: "https://e.com/key.png",
      characterReferenceUrl: "https://e.com/person.png",
      productReferenceUrl: "https://e.com/product.png",
      voiceover: "今天给你看一个细节。",
      locale: "zh",
    });

    expect(plan).toMatchObject({
      strategy: "reference-pack",
      mode: "video-to-video",
      audioMode: "native",
      voiceoverBound: true,
      referenceCount: 3,
      referenceRoles: ["keyframe", "character", "product"],
      warnings: [],
    });
    expect(plan.firstFrameUrl).toBeUndefined();
    expect(plan.referenceInputs.map((item) => item.role)).toEqual(["keyframe", "character", "product"]);
    expect(plan.promptSuffix).toContain("只自然说一遍");
    expect(plan.promptSuffix).toContain("第1张图片=构图关键帧；第2张图片=人物身份；第3张图片=商品外观");
    expect(plan.promptSuffix).not.toMatch(/[A-Za-z]/);
  });

  it("keeps identity references and carries the end frame as a target anchor", () => {
    const plan = buildVideoControlPlan({
      provider: "atlas-cloud",
      modelId: "bytedance/seedance-2.5/image-to-video",
      firstFrameUrl: "https://e.com/key.png",
      lastFrameUrl: "https://e.com/end.png",
      characterReferenceUrl: "https://e.com/person.png",
      voiceover: "hello",
      locale: "en",
    });

    expect(plan).toMatchObject({
      strategy: "reference-pack",
      mode: "video-to-video",
      audioMode: "native",
      referenceCount: 3,
      referenceRoles: ["keyframe", "end-frame", "character"],
      warnings: [],
    });
    expect(plan.referenceInputs.map((item) => item.role)).toEqual(["keyframe", "end-frame", "character"]);
  });

  it("keeps native start/end frames when only a soft continuity reference competes", () => {
    const plan = buildVideoControlPlan({
      provider: "atlas-cloud",
      modelId: "bytedance/seedance-2.5/image-to-video",
      firstFrameUrl: "https://e.com/key.png",
      lastFrameUrl: "https://e.com/end.png",
      continuityReferenceUrl: "https://e.com/previous.png",
      locale: "en",
    });
    expect(plan).toMatchObject({
      strategy: "keyframe",
      mode: "image-to-video",
      firstFrameUrl: "https://e.com/key.png",
      lastFrameUrl: "https://e.com/end.png",
      warnings: ["reference-pack-deferred-for-end-frame"],
    });
  });

  it("uses Volcengine reference mode for a first frame with visual and audio references", () => {
    const plan = buildVideoControlPlan({
      provider: "volcengine",
      modelId: "doubao-seedance-2-0-pro-250528",
      supportsAudio: true,
      firstFrameUrl: "https://e.com/key.png",
      continuityReferenceUrl: "https://e.com/tail.png",
      audioReferenceUrl: "https://e.com/voice.wav",
      description: "a hand opens the box",
      locale: "en",
    });

    expect(plan).toMatchObject({
      strategy: "reference-pack",
      mode: "video-to-video",
      audioMode: "native",
      referenceCount: 3,
      referenceRoles: ["keyframe", "continuity", "audio"],
    });
    expect(plan.firstFrameUrl).toBeUndefined();
    expect(plan.lastFrameUrl).toBeUndefined();
    expect(plan.referenceInputs.map((item) => item.mediaType)).toEqual(["image", "image", "audio"]);
    expect(plan.promptSuffix).toContain("@Image2=previous-shot continuity");
  });

  it.each([
    "doubao-seedance-2.5",
    "doubao-seedance-2.0",
    "doubao-seedance-2.0-fast",
    "doubao-seedance-2.0-mini",
  ])("keeps identity references without mixing native frames for Ark model %s", (modelId) => {
    const plan = buildVideoControlPlan({
      provider: "volcengine",
      modelId,
      firstFrameUrl: "https://e.com/key.png",
      lastFrameUrl: "https://e.com/end.png",
      characterReferenceUrl: "https://e.com/person.png",
      productReferenceUrl: "https://e.com/product.png",
      locale: "en",
    });

    expect(plan).toMatchObject({
      strategy: "reference-pack",
      mode: "video-to-video",
      referenceCount: 4,
      referenceRoles: ["keyframe", "end-frame", "character", "product"],
      warnings: ["last-frame-as-reference"],
    });
    expect(plan.firstFrameUrl).toBeUndefined();
    expect(plan.lastFrameUrl).toBeUndefined();
    expect(plan.referenceInputs).toEqual([
      { url: "https://e.com/key.png", role: "keyframe", mediaType: "image", required: true },
      { url: "https://e.com/end.png", role: "end-frame", mediaType: "image", required: false },
      { url: "https://e.com/person.png", role: "character", mediaType: "image", required: true },
      { url: "https://e.com/product.png", role: "product", mediaType: "image", required: true },
    ]);
    expect(plan.promptSuffix).toContain("@Image2=target ending");
  });

  it("keeps Ark native start/end frames when only a soft continuity reference competes", () => {
    const plan = buildVideoControlPlan({
      provider: "volcengine",
      modelId: "doubao-seedance-2.5",
      firstFrameUrl: "https://e.com/key.png",
      lastFrameUrl: "https://e.com/end.png",
      continuityReferenceUrl: "https://e.com/previous.png",
      locale: "en",
    });

    expect(plan).toMatchObject({
      strategy: "keyframe",
      mode: "image-to-video",
      firstFrameUrl: "https://e.com/key.png",
      lastFrameUrl: "https://e.com/end.png",
      referenceCount: 2,
      referenceRoles: ["keyframe", "end-frame"],
      warnings: ["reference-pack-deferred-for-end-frame"],
      referenceInputs: [],
    });
  });

  it("uses Ark reference mode for audio without mixing native frame conditioning", () => {
    const plan = buildVideoControlPlan({
      provider: "volcengine",
      modelId: "doubao-seedance-2.5",
      firstFrameUrl: "https://e.com/key.png",
      lastFrameUrl: "https://e.com/end.png",
      audioReferenceUrl: "https://e.com/voice.wav",
      locale: "en",
    });

    expect(plan).toMatchObject({
      strategy: "reference-pack",
      mode: "video-to-video",
      referenceCount: 3,
      referenceRoles: ["keyframe", "end-frame", "audio"],
      warnings: ["last-frame-as-reference"],
    });
    expect(plan.firstFrameUrl).toBeUndefined();
    expect(plan.lastFrameUrl).toBeUndefined();
    expect(plan.referenceInputs.map((item) => item.mediaType)).toEqual(["image", "image", "audio"]);
  });

  it("does not label a plain keyframe request as a reference pack", () => {
    const plan = buildVideoControlPlan({
      provider: "volcengine",
      modelId: "doubao-seedance-2-0-pro-250528",
      firstFrameUrl: "https://e.com/key.png",
      locale: "zh",
    });
    expect(plan.strategy).toBe("keyframe");
    expect(plan.referenceCount).toBe(1);
  });

  it("sanitizes persisted summaries and drops unknown fields", () => {
    expect(sanitizeVideoControlSummary({
      version: 1,
      strategy: "reference-pack",
      mode: "video-to-video",
      referenceRoles: ["keyframe", "character", "not-a-role"],
      referenceCount: 999,
      audioMode: "native",
      voiceoverBound: true,
      warnings: ["reference-pack-unsupported", "last-frame-as-reference", "unknown"],
      promptSuffix: "must not persist",
    })).toEqual({
      version: 1,
      strategy: "reference-pack",
      mode: "video-to-video",
      referenceRoles: ["keyframe", "character"],
      referenceCount: 32,
      audioMode: "native",
      voiceoverBound: true,
      warnings: ["reference-pack-unsupported", "last-frame-as-reference"],
    });
  });
});
