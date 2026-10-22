import { describe, expect, it } from "vitest";
import { getVideoModelCapabilities, preflightVideoGeneration } from "@/lib/model-capabilities";

describe("video model capabilities", () => {
  it("normalizes a schema-backed image-to-video model", () => {
    const caps = getVideoModelCapabilities("google/veo3.1/image-to-video");
    expect(caps).toMatchObject({
      confidence: "known",
      textToVideo: false,
      imageToVideo: true,
      referenceImages: false,
      referenceVideo: false,
      referenceAudio: false,
      lastFrame: true,
      nativeAudio: true,
      durationValues: [4, 6, 8],
    });
  });

  it("finds schema-backed reference siblings and their quotas", () => {
    const caps = getVideoModelCapabilities("bytedance/seedance-2.5/image-to-video", true, "atlas-cloud");
    expect(caps).toMatchObject({
      referenceImages: true,
      referenceVideo: true,
      referenceAudio: true,
      nativeAudio: true,
      videoEdit: false,
      temporalRetake: false,
      regionMask: false,
      multiKeyframes: false,
      performanceReference: true,
    });
    expect(caps.maxReferenceImages).toBeGreaterThan(0);
  });

  it("does not invent a reference sibling for the fast-only family", () => {
    const caps = getVideoModelCapabilities("bytedance/seedance-2.0-fast/image-to-video", false, "atlas-cloud");
    expect(caps.referenceImages).toBe(false);
    expect(caps.referenceVideo).toBe(false);
  });

  it("recognizes Volcengine multimodal reference and audio conditioning", () => {
    const caps = getVideoModelCapabilities("doubao-seedance-2-0-pro-250528", true, "volcengine");
    expect(caps).toMatchObject({
      referenceImages: true,
      referenceVideo: true,
      referenceAudio: true,
      nativeAudio: true,
    });
  });

  it.each([
    "doubao-seedance-2.5",
    "doubao-seedance-2.0",
    "doubao-seedance-2.0-fast",
    "doubao-seedance-2.0-mini",
    "doubao-seedance-2-5-260628",
    "doubao-seedance-2-0-260128",
  ])("recognizes the unified Ark video modes for %s without importing Atlas limits", (modelId) => {
    const caps = getVideoModelCapabilities(modelId, undefined, "volcengine");
    expect(caps).toMatchObject({
      confidence: "inferred",
      textToVideo: true,
      imageToVideo: true,
      referenceImages: true,
      referenceVideo: true,
      referenceAudio: true,
      lastFrame: true,
      nativeAudio: true,
      temporalRetake: false,
      regionMask: false,
      multiKeyframes: false,
      maxReferenceImages: 9,
    });
    expect(caps.durationValues).toBeUndefined();
    expect(caps.resolutionValues).toBeUndefined();
    expect(caps.aspectRatioValues).toBeUndefined();
    expect(caps.videoEdit).toBe(!modelId.includes("2.5") && !modelId.includes("2-5"));
  });

  it("keeps AgentPlan 480p requests unchanged during preflight", () => {
    const result = preflightVideoGeneration({
      modelId: "doubao-seedance-2.5",
      provider: "volcengine",
      duration: 4,
      resolution: "480p",
      aspectRatio: "16:9",
      chainMode: "pin",
      audioEnabled: true,
    });
    expect(result.adjustments).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it.each([
    "doubao-seedance-2.5",
    "doubao-seedance-2.0",
    "doubao-seedance-2.0-fast",
    "doubao-seedance-2.0-mini",
  ])("warns that Ark %s cannot pin an end frame alongside product or presenter references", (modelId) => {
    const result = preflightVideoGeneration({
      modelId,
      provider: "volcengine",
      resolution: "480p",
      aspectRatio: "9:16",
      chainMode: "pin",
      referenceImageCount: 2,
    });
    expect(result.capabilities.lastFrame).toBe(true);
    expect(result.capabilities.referenceImages).toBe(true);
    expect(result.adjustments).toEqual([
      { field: "chainMode", requested: "pin", effective: "off", code: "last-frame-as-reference" },
    ]);
    expect(result.warnings).toEqual(["last-frame-as-reference"]);
  });

  it("also previews the Ark end-frame fallback when using an audio reference", () => {
    const result = preflightVideoGeneration({
      modelId: "doubao-seedance-2.5",
      provider: "volcengine",
      resolution: "480p",
      aspectRatio: "9:16",
      chainMode: "pin",
      referenceAudioCount: 1,
    });
    expect(result.adjustments).toContainEqual({
      field: "chainMode", requested: "pin", effective: "off", code: "last-frame-as-reference",
    });
    expect(result.warnings).toContain("last-frame-as-reference");
  });

  it.each(["tail", "off"] as const)("does not warn about an Ark end frame for %s chaining", (chainMode) => {
    const result = preflightVideoGeneration({
      modelId: "doubao-seedance-2.5",
      provider: "volcengine",
      resolution: "480p",
      aspectRatio: "9:16",
      chainMode,
      referenceImageCount: 2,
    });
    expect(result.adjustments).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("keeps Atlas chaining preflight unchanged when product references are present", () => {
    const result = preflightVideoGeneration({
      modelId: "bytedance/seedance-2.5/image-to-video",
      provider: "atlas-cloud",
      resolution: "720p",
      aspectRatio: "9:16",
      chainMode: "pin",
      referenceImageCount: 2,
    });
    expect(result.adjustments.some((item) => item.code === "last-frame-as-reference")).toBe(false);
    expect(result.warnings).not.toContain("last-frame-as-reference");
  });

  it("keeps unknown custom models permissive", () => {
    const result = preflightVideoGeneration({
      modelId: "my-company/video-v9",
      duration: 5,
      resolution: "1080p",
      aspectRatio: "9:16",
      chainMode: "pin",
    });
    expect(result.capabilities.confidence).toBe("unknown");
    expect(result.capabilities.lastFrame).toBeNull();
    expect(result.adjustments).toEqual([]);
    expect(result.warnings).toEqual(["capabilities-unknown"]);
  });

  it("keeps provider-hosted custom models permissive when their mode is undeclared", () => {
    const result = preflightVideoGeneration({
      modelId: "my-company/video-v9",
      provider: "atlas-cloud",
      resolution: "1080p",
      aspectRatio: "9:16",
      chainMode: "off",
      referenceImageCount: 2,
    });
    expect(result.capabilities.referenceImages).toBeNull();
    expect(result.warnings).toEqual(["capabilities-unknown"]);
  });

  it("previews provider duration, resolution, ratio and tail-frame adaptation", () => {
    const result = preflightVideoGeneration({
      modelId: "minimax/hailuo-2.3/i2v-standard",
      duration: 8,
      resolution: "1080p",
      aspectRatio: "9:16",
      chainMode: "pin",
    });
    expect(result.adjustments).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "duration", requested: 8, effective: 6 }),
      expect.objectContaining({ field: "chainMode", effective: "off" }),
    ]));
  });

  it("shows adaptive framing and tier mapping before generation", () => {
    const result = preflightVideoGeneration({
      modelId: "minimax/h3/image-to-video",
      duration: 5,
      resolution: "1080p",
      aspectRatio: "9:16",
      chainMode: "pin",
    });
    expect(result.adjustments).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "resolution", effective: "2K" }),
      expect.objectContaining({ field: "aspectRatio", effective: "adaptive" }),
    ]));
    expect(result.adjustments.some((item) => item.field === "chainMode")).toBe(false);
  });

  it("warns before dropping unsupported reference conditioning", () => {
    const result = preflightVideoGeneration({
      modelId: "google/veo3.1/image-to-video",
      provider: "atlas-cloud",
      resolution: "1080p",
      aspectRatio: "9:16",
      chainMode: "off",
      referenceImageCount: 2,
      referenceAudioCount: 1,
    });
    expect(result.warnings).toEqual(expect.arrayContaining([
      "reference-conditioning-unavailable",
      "reference-audio-unavailable",
    ]));
  });
});
