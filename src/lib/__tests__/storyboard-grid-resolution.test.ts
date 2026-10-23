import { describe, expect, it } from "vitest";
import { storyboardGridTargetDimensions, withStoryboardGridResolution } from "@/lib/storyboard-grid-resolution";
import { buildImageSizeParams } from "@/lib/providers/atlas-cloud";

describe("storyboard grid resolution", () => {
  it.each([[1080, 1920], [1920, 1080], [1024, 1024], [1080, 1440], [999, 1234]])(
    "keeps high-resolution %i×%i requests within the image pixel budget",
    (width, height) => {
      const target = storyboardGridTargetDimensions(width, height, "4k");
      expect(target.width % 16).toBe(0);
      expect(target.height % 16).toBe(0);
      expect(Math.max(target.width, target.height)).toBeLessThanOrEqual(3840);
      expect(target.width * target.height).toBeLessThanOrEqual(8_294_400);
      expect(Math.abs(target.width / target.height - width / height)).toBeLessThan(0.01);
    },
  );

  it("selects the Atlas GPT Image and Nano Banana 4K size contracts", () => {
    const input = { width: 1080, height: 1920 };
    for (const model of ["openai/gpt-image-2/edit", "google/nano-banana-2/text-to-image"]) {
      const options = withStoryboardGridResolution(input, "4k", "atlas-cloud", model);
      const params = buildImageSizeParams(model, options.width as number, options.height as number);
      expect(params).toEqual(model.includes("gpt-image") ? { size: "2160x3840" } : { aspect_ratio: "9:16", resolution: "4k" });
    }
    expect(input).toEqual({ width: 1080, height: 1920 });
  });

  it("keeps the known Seedream preset when that adapter cannot deliver the requested 4K", () => {
    const model = "bytedance/seedream-v5.0-lite";
    const options = withStoryboardGridResolution({ width: 1080, height: 1920 }, "4k", "atlas-cloud", model);
    expect(buildImageSizeParams(model, options.width as number, options.height as number)).toEqual({ size: "1600*2848" });
  });

  it("keeps existing dimensions for models without a known high-resolution contract", () => {
    for (const [provider, model] of [["openai", "gpt-image-1.5"], ["siliconflow", "Qwen/Qwen-Image"], ["replicate", "custom/model"]]) {
      expect(withStoryboardGridResolution({ width: 1080, height: 1920 }, "4k", provider, model))
        .toEqual({ width: 1080, height: 1920, count: 1 });
    }
  });

  it.each(["standard", "4k"] as const)("limits %s grids to one image even for unsupported models", (resolution) => {
    const options = withStoryboardGridResolution({ width: 1080, height: 1920, count: 4, extra: { n: 4, num_images: 4, size: "1024x1024" } }, resolution, "openai", "gpt-image-1.5");
    expect(options.count).toBe(1);
    expect(options.extra).toEqual({ size: "1024x1024" });
  });
});
