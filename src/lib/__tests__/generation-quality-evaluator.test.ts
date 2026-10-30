// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Shot } from "@/lib/db/schema";

const state = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/llm-error", () => ({
  createLLMClient: () => ({ chat: { completions: { create: state.create } } }),
  jsonModeParams: () => ({}),
  withLLMErrors: (operation: () => Promise<unknown>) => operation(),
}));

import { buildShotQualityContract } from "@/lib/generation-quality";
import { evaluateGenerationQuality } from "@/lib/generation-quality-evaluator";

const shot: Shot = { shotId: 1, type: "demo", duration: 5, description: "Hands rest on the real product in an outdoor scene", camera: "fixed close view",
  voiceover: "", prompt: "Show the existing product contact", visualSource: "ai_generate", transition: "direct_concat" };

beforeEach(() => state.create.mockReset().mockResolvedValue({ choices: [{ message: { content: '{"summary":"fixture review","dimensions":[],"issues":[]}' } }] }));

describe("vision quality request", () => {
  it.each(["image", "video"] as const)("sends the TIDEWE photography checks in the actual %s multimodal request", async (mediaType) => {
    const contract = buildShotQualityContract({ shot, mediaType, tidewePhotography: true, hasCharacterReference: true });
    await evaluateGenerationQuality({ contract, outputImageDataUrl: "data:image/png;base64,fixture", referenceImageUrls: ["https://fixture.invalid/identity.png"], locale: "zh",
      config: { model: "text-fixture", visionModel: "vision-fixture", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-key" } });
    expect(state.create).toHaveBeenCalledOnce();
    const request = state.create.mock.calls[0][0];
    expect(request.model).toBe("vision-fixture");
    const content = request.messages[0].content;
    expect(content[0].type).toBe("text");
    const prompt = content[0].text;
    expect(prompt).toContain("including isolated near grass, leaves, frame-edge objects");
    expect(prompt).toContain("Only distant scenery BEHIND the subject may be slightly soft");
    expect(prompt).toContain("continuous perspective, edge softness, grain");
    expect(prompt).toContain("warm/orange cast");
    expect(prompt).toContain("painted/oil-paint texture");
    expect(prompt).toContain("credible contact, occlusion and weight");
    expect(prompt).toContain("Clothing must follow the approved shot/source, not the identity reference");
    expect(content.slice(1)).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,fixture", detail: "high" } },
      { type: "image_url", image_url: { url: "https://fixture.invalid/identity.png", detail: "high" } },
    ]);
  });

  it("keeps the ordinary style vision request free of TIDEWE photography requirements", async () => {
    const contract = buildShotQualityContract({ shot, mediaType: "image", hasCharacterReference: true });
    await evaluateGenerationQuality({ contract, outputImageDataUrl: "data:image/png;base64,fixture", locale: "en",
      config: { model: "vision-fixture", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-key" } });
    const prompt = state.create.mock.calls[0][0].messages[0].content[0].text;
    expect(prompt).not.toContain("foreground bokeh");
    expect(prompt).not.toContain("warm/orange cast");
    expect(prompt).toContain("build and outfit must match the character reference");
  });
});
