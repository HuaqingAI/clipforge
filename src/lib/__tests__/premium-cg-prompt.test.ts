import { describe, expect, it } from "vitest";
import { createPremiumProductCgProfile } from "@/lib/creative-profiles";
import {
  compilePremiumCgImagePrompt,
  compilePremiumCgVideoPrompt,
} from "@/lib/premium-cg-prompt";

const productDirections = [
  {
    category: "fragrance",
    visualIntent: "Observe the supplied perfume bottle's transparent glass and amber liquid on a small vanity plinth.",
    camera: "A restrained close push toward the visible bottle edge.",
    detail: "transparent glass and amber liquid",
    context: "small vanity plinth",
  },
  {
    category: "watches",
    visualIntent: "Observe the supplied wristwatch's closed case and brushed metal bezel in a watchmaker's display.",
    camera: "A slow lateral move along the visible dial.",
    detail: "closed case and brushed metal bezel",
    context: "watchmaker's display",
  },
  {
    category: "consumer electronics",
    visualIntent: "Observe the supplied headphones' matte shell and visible controls on a compact audio display.",
    camera: "A restrained lateral move across the visible earcup.",
    detail: "matte shell and visible controls",
    context: "compact audio display",
  },
];

const compilers = [
  ["image", compilePremiumCgImagePrompt],
  ["video", compilePremiumCgVideoPrompt],
] as const;

describe.each(compilers)("premium product CG %s prompt", (_kind, compile) => {
  it.each(productDirections)("carries $category details and use context without furniture defaults", (product) => {
    const result = compile(product, createPremiumProductCgProfile());

    expect(result.prompt).toContain(product.detail);
    expect(result.prompt).toContain(product.context);
    expect(result.prompt).toContain(product.camera);
    expect(result.prompt).toContain("actual product category and intended use");
    expect(result.prompt).toContain("use a neutral studio when the context is unspecified");
    expect(result.prompt).toContain("component count");
    expect(result.prompt).toContain("surface finishes");
    expect(result.prompt).toContain("preserve only markings already visible");
    expect(result.prompt).toContain("Do not generate added on-screen text");
    expect(result.prompt).toMatch(/(?:Do not invent unseen construction|invented product parts, mechanisms, materials, or functions)/);
    expect(`${result.prompt} ${result.negativePrompt}`).not.toMatch(/furniture|upholstery|modern.home|contemporary interior|\blegs\b/i);
    expect(result.negativePrompt).toContain("extra product parts");
  });

  it("keeps a deliberately supplied furniture setting and material direction", () => {
    const result = compile({
      visualIntent: "A walnut lounge chair with the visible woven upholstery in a quiet living room.",
      camera: "A restrained slow push-in.",
    }, createPremiumProductCgProfile({
      visualDirection: { setting: "modern_home", look: "warm living-room window light" },
    }));

    expect(result.prompt).toContain("walnut lounge chair");
    expect(result.prompt).toContain("visible woven upholstery");
    expect(result.prompt).toContain("warm living-room window light");
  });

  it("normalizes a legacy profile before applying its saved visual look", () => {
    const result = compile(productDirections[0], {
      creationType: "premium_product_cg",
      visualDirection: {
        setting: "modern_home",
        look: "bright quiet contemporary residence, soft natural window light, low-saturation neutral materials and balanced spatial scale",
      },
      recipeSnapshot: { recipeId: "living_scale" },
    });

    expect(result.prompt).toContain(productDirections[0].detail);
    expect(result.prompt).not.toContain("bright quiet contemporary residence");
    expect(result.prompt).toContain("documented use context");
  });

  it("removes inherited copy instructions while preserving the product direction", () => {
    const result = compile({
      ...productDirections[1],
      description: "Add a BUY NOW title card. Display a price label.",
    }, { creationType: "premium_product_cg" });

    expect(result.prompt).toContain(productDirections[1].detail);
    expect(result.prompt).not.toContain("BUY NOW");
    expect(result.prompt).not.toContain("Display a price label");
    expect(result.prompt).toContain("Do not generate added on-screen text");
  });
});
