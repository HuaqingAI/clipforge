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
    if (_kind === "image") {
      expect(result.prompt).toContain("actual product category and intended use");
      expect(result.prompt).toContain("use a neutral studio when the context is unspecified");
      expect(result.prompt).toContain("component count");
      expect(result.prompt).toContain("surface finishes");
      expect(result.prompt).toContain("preserve only markings already visible");
      expect(result.prompt).toContain("Do not generate added on-screen text");
      expect(result.prompt).toContain("Do not invent unseen construction");
      expect(result.negativePrompt).toContain("extra product parts");
    } else {
      expect(result.prompt).toContain("真实的产品类别与用途");
      expect(result.prompt).toContain("未指定使用环境时采用中性摄影棚");
      expect(result.prompt).toContain("部件数量");
      expect(result.prompt).toContain("表面处理");
      expect(result.prompt).toContain("仅保留参考资料中已可见的产品标识");
      expect(result.prompt).toContain("不生成新增的画面文字");
      expect(result.prompt).toContain("不虚构产品部件、机构、材质或功能");
      expect(result.negativePrompt).toContain("多余产品部件");
    }
    expect(`${result.prompt} ${result.negativePrompt}`).not.toMatch(/furniture|upholstery|modern.home|contemporary interior|\blegs\b/i);
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
    expect(result.prompt).toContain(_kind === "image" ? "documented use context" : "资料已确认的使用环境");
  });

  it("removes inherited copy instructions while preserving the product direction", () => {
    const result = compile({
      ...productDirections[1],
      description: "Add a BUY NOW title card. Display a price label.",
    }, { creationType: "premium_product_cg" });

    expect(result.prompt).toContain(productDirections[1].detail);
    expect(result.prompt).not.toContain("BUY NOW");
    expect(result.prompt).not.toContain("Display a price label");
    expect(result.prompt).toContain(_kind === "image" ? "Do not generate added on-screen text" : "不生成新增的画面文字");
  });
});

describe("Chinese premium CG dynamic templates", () => {
  const chineseShot = { visualIntent: "完整呈现产品轮廓与真实材质。", description: "产品置于浅灰背景中。", camera: "镜头沿观察轴缓慢前移。" };

  it.each(["form_portrait", "material_craft", "living_scale"])("uses Chinese built-in direction for recipe %s", (recipeId) => {
    const profile = createPremiumProductCgProfile({ recipeSnapshot: { recipeId } });
    const compiled = compilePremiumCgVideoPrompt(chineseShot, profile);
    expect(compiled.prompt).toContain("镜头画面：");
    expect(compiled.prompt).toContain("镜头运动：");
    expect(compiled.prompt).toContain("光线与风格：");
    expect(compiled.prompt).not.toMatch(/[A-Za-z]/);
    expect(compiled.negativePrompt).not.toMatch(/[A-Za-z]/);
  });

  it("upgrades a saved English default without rewriting custom English product facts", () => {
    const compiled = compilePremiumCgVideoPrompt({ ...chineseShot, description: "AeroStretch X1，保留现有型号。" }, createPremiumProductCgProfile({ visualDirection: { look: "controlled neutral studio light, minimal backdrop suited to product scale, measured silhouette and edge highlights" } }));
    expect(compiled.prompt).toContain("受控的中性摄影棚灯光");
    expect(compiled.prompt).not.toContain("controlled neutral studio light");
    expect(compiled.prompt).toContain("AeroStretch X1，保留现有型号。");
  });
});
