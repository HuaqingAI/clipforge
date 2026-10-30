import { describe, expect, it } from "vitest";
import { supportsKeyframeFocusMask } from "@/lib/keyframe-refinement";
import { OPENAI_MASK_IMAGE_MODELS } from "@/lib/openai-image-capabilities";

describe("keyframe focus mask model availability", () => {
  it.each([
    "gpt-image-2", "gpt-image-2-2026-04-21",
    "gpt-image-2.5-sunburst", "gpt-image-2.5-sunburst-2026-09-08",
    "gpt-image-2.5-flare", "gpt-image-2.5-flare-2026-09-08",
  ])("offers real supported %s snapshots also accepted by the provider", (model) => {
    expect(supportsKeyframeFocusMask("openai", model)).toBe(true);
    expect(OPENAI_MASK_IMAGE_MODELS).toContain(model);
  });

  it.each([
    "gpt-image-2-2026-09-08", "gpt-image-2.5-sunburst-2026-04-21",
    "gpt-image-2.5-flare-2099-12-31", "gpt-image-2-2026-99-99",
    "gpt-image-2.5", "gpt-image-2.5-other", "gpt-image-1.5", "chatgpt-image-latest",
  ])("rejects unlisted or unexposed %s model names", (model) => {
    expect(supportsKeyframeFocusMask("openai", model)).toBe(false);
  });

  it.each(["atlas-cloud", "fal-ai", "volcengine", "replicate"])("does not infer a mask contract for the %s adapter", (provider) => {
    expect(supportsKeyframeFocusMask(provider, "gpt-image-2.5-sunburst")).toBe(false);
  });
});
