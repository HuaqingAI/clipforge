import { describe, expect, it } from "vitest";
import { resolveCharacterReferenceModel } from "@/lib/character-reference-model";

describe("character reference model contracts", () => {
  it("keeps arbitrary text-only models when no reference was uploaded", () => {
    expect(resolveCharacterReferenceModel("custom", "custom/text-model", 0)).toEqual({ ok: true, modelId: "custom/text-model" });
  });

  it.each([
    ["openai", "gpt-image-2.5-flare", "gpt-image-2.5-flare"],
    ["openai", "gpt-image-2.5-sunburst", "gpt-image-2.5-sunburst"],
    ["openai", "gpt-image-2", "gpt-image-2"],
    ["openai", "gpt-image-1.5", "gpt-image-1.5"],
    ["fal-ai", "openai/gpt-image-2", "openai/gpt-image-2/image-to-image"],
    ["fal-ai", "openai/gpt-image-2/image-to-image", "openai/gpt-image-2/image-to-image"],
    ["fal-ai", "fal-ai/gpt-image-1.5", "fal-ai/gpt-image-1.5/edit"],
    ["fal-ai", "fal-ai/gpt-image-1.5/edit", "fal-ai/gpt-image-1.5/edit"],
    ["fal-ai", "fal-ai/bytedance/seedream/v5/lite/edit", "fal-ai/bytedance/seedream/v5/lite/edit"],
    ["atlas-cloud", "openai/gpt-image-2", "openai/gpt-image-2/edit"],
    ["atlas-cloud", "openai/gpt-image-2/text-to-image", "openai/gpt-image-2/edit"],
    ["atlas-cloud", "openai/gpt-image-2/edit", "openai/gpt-image-2/edit"],
    ["volcengine", "doubao-seedream-5-0-260128", "doubao-seedream-5-0-260128"],
    ["volcengine", "doubao-seedream-4-0-250828", "doubao-seedream-4-0-250828"],
  ])("uses every portrait for %s / %s", (provider, model, expected) => {
    for (const count of [1, 3, 8]) {
      expect(resolveCharacterReferenceModel(provider, model, count)).toEqual({ ok: true, modelId: expected });
    }
  });

  it("allows a single DALL·E 2 reference and explicitly refuses dropping additional images", () => {
    expect(resolveCharacterReferenceModel("openai", "dall-e-2", 1)).toEqual({ ok: true, modelId: "dall-e-2" });
    expect(resolveCharacterReferenceModel("openai", "dall-e-2", 2)).toMatchObject({ ok: false, error: expect.stringContaining("仅支持 1 张参考图") });
  });

  it.each([
    ["openai", "dall-e-3"],
    ["fal-ai", "fal-ai/flux/dev"],
    ["fal-ai", "custom-model/edit"],
    ["atlas-cloud", "bytedance/seedream-v5.0-lite"],
    ["atlas-cloud", "google/nano-banana-2/text-to-image"],
    ["volcengine", "doubao-seedance-2-0-260128"],
    ["volcengine", "ep-unknown-model"],
    ["replicate", "black-forest-labs/flux-kontext-pro"],
    ["alibaba", "wanx2.1-t2i-turbo"],
    ["siliconflow", "black-forest-labs/FLUX.1-schnell"],
    ["custom-provider", "gpt-image-2"],
  ])("rejects an unconfirmed reference contract for %s / %s", (provider, model) => {
    for (const count of [1, 3]) {
      expect(resolveCharacterReferenceModel(provider, model, count)).toMatchObject({
        ok: false, error: expect.stringContaining("更换支持参考图的模型"),
      });
    }
  });
});
