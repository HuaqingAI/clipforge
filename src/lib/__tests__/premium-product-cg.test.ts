import { describe, expect, it } from "vitest";
import {
  PREMIUM_PRODUCT_CG_SYSTEM_PROMPT,
  buildBatchPrompt,
  buildUserPrompt,
  styleFormGroups,
  styleNameMap,
  type ScriptGenerationInput,
} from "@/lib/script-engine/prompts";
import {
  parseScriptResponse,
  sanitizePremiumProductCgShot,
} from "@/lib/script-engine/generator";
import {
  PREMIUM_PRODUCT_CG_STYLE,
  createPremiumProductCgProfile,
} from "@/lib/creative-profiles";
import { lintCreativeProfileShot } from "@/lib/creative-policy-lint";
import type { Shot } from "@/lib/db/schema";

const profile = createPremiumProductCgProfile({
  targetDuration: 30,
  videoMode: "product_closeup",
  narrationMode: "none",
});

const baseInput: ScriptGenerationInput = {
  productName: "Walnut lounge chair",
  category: "home",
  styleType: "pain_point",
  targetDuration: 30,
  productDescription: "Verified walnut frame and woven upholstery; no unverified mechanism claims.",
  creativeProfile: profile,
  platforms: "douyin,xiaohongshu",
  referenceStructure: "REFERENCE_STRUCTURE_SENTINEL",
  performanceHint: "PERFORMANCE_HINT_SENTINEL",
  preferredHookId: "hook-urgency-sentinel",
};

describe("premium product CG prompt compiler", () => {
  it("registers the CG style and emits an isolated prompt branch", () => {
    expect(styleNameMap.premium_product_cg).toBe("高端产品 CG");
    expect(styleFormGroups.flatMap((group) => group.styles)).toContain("premium_product_cg");

    const prompt = buildUserPrompt(baseInput);
    expect(prompt).toContain("premium product CG film");
    expect(prompt).toContain("Generate no added text in any frame");
    expect(prompt).toContain("voiceover: every shot must use an empty string");
    expect(prompt).not.toContain("REFERENCE_STRUCTURE_SENTINEL");
    expect(prompt).not.toContain("PERFORMANCE_HINT_SENTINEL");
    expect(prompt).not.toContain("留人与转化硬规则");
    expect(prompt).not.toContain("参考爆款结构");
    expect(prompt).not.toContain("黄金3秒");
  });

  it("keeps batch generation visual-only and honors restrained narration when selected", () => {
    const batch = buildBatchPrompt(baseInput, 2);
    expect(batch).toContain("CG batch requirement");
    expect(batch).toContain("Generate 2 product-film options");
    expect(batch).toContain("Skip unsupported materials, mechanisms, processes, or interactions in every option");
    expect(batch).not.toContain("REFERENCE_STRUCTURE_SENTINEL");
    expect(batch).not.toContain("PERFORMANCE_HINT_SENTINEL");

    const restrained = buildUserPrompt({
      ...baseInput,
      creativeProfile: createPremiumProductCgProfile({ narrationMode: "restrained" }),
    });
    expect(restrained).toContain("When present, use one short, calm, factual sentence");
    expect(restrained).not.toContain("every shot must use an empty string");
    expect(PREMIUM_PRODUCT_CG_SYSTEM_PROMPT).toContain("Generated frames contain no added text");
    expect(PREMIUM_PRODUCT_CG_SYSTEM_PROMPT).not.toContain("Buy now");
  });

  it.each([
    { productName: "Perfume bottle", category: "beauty" as const },
    { productName: "Wireless headphones", category: "tech" as const },
    { productName: "Leather handbag", category: "fashion" as const },
    { productName: "Artisan chocolate box", category: "food" as const },
  ])("adapts the CG brief to $productName without imposing a furniture setting", ({ productName, category }) => {
    const prompt = buildUserPrompt({
      ...baseInput,
      productName,
      category,
      productDescription: undefined,
      creativeProfile: createPremiumProductCgProfile({
        recipeSnapshot: { recipeId: "living_scale" },
        visualSource: "ai_generate",
      }),
    });

    expect(prompt).toContain(`Product name: ${productName}`);
    expect(prompt).toContain("Product category:");
    expect(prompt).toContain("category-appropriate use context matched to the product brief");
    expect(prompt).toContain("omit the person and interaction when unsupported");
    expect(prompt).toContain("otherwise use observable form, surface, light, and composition");
    expect(prompt).toContain("Generate no added text in any frame");
    expect(prompt).not.toMatch(/furniture|upholstery|residen|living.room|modern_home/i);
    expect(PREMIUM_PRODUCT_CG_SYSTEM_PROMPT).not.toMatch(/furniture|upholstery|residen/i);
  });

  it("keeps inferred image-analysis recommendations separate from verified product facts", () => {
    const prompt = buildUserPrompt({
      ...baseInput,
      productName: "Perfume bottle",
      category: "beauty",
      productDescription: "A bottle with a visible translucent surface.",
      productAnalysis: JSON.stringify({
        visualFeatures: { texture: "translucent" },
        usageScenarios: ["INFERRED_SCENARIO"],
        videoSuggestions: { suggestedStyle: "pain_point" },
      }),
    });

    expect(prompt).toContain("translucent");
    expect(prompt).toContain("Use only directly visible product attributes and legible existing markings as reference evidence");
    expect(prompt).toContain("suggested script styles are not verified product facts");
    expect(prompt).toContain("omit those details unless the product brief independently confirms them");
  });

  it("uses the original digital category for CG after commerce category normalization", () => {
    const prompt = buildUserPrompt({
      ...baseInput,
      productName: "Wireless headphones",
      category: "beauty",
      productCategoryHint: "digital",
    });

    expect(prompt).toContain("Product category: 数码3C");
    expect(prompt).not.toContain("Product category: 美妆护肤");
  });

  it("lets the product brief resolve other or unspecified CG categories", () => {
    for (const productCategoryHint of ["other", "unspecified"]) {
      const prompt = buildUserPrompt({
        ...baseInput,
        productName: "Mechanical wristwatch",
        category: "beauty",
        productCategoryHint,
      });

      expect(prompt).toContain("Product category: unspecified; identify the actual product category from the supplied product brief");
      expect(prompt).not.toContain("Product category: 美妆护肤");
    }
  });

  it("preserves a specific CG category outside the commerce category list", () => {
    const prompt = buildUserPrompt({
      ...baseInput,
      productName: "Grand touring coupe",
      category: "beauty",
      productCategoryHint: "Automotive",
    });

    expect(prompt).toContain("Product category: Automotive");
    expect(prompt).not.toContain("Product category: 美妆护肤");
  });
});

describe("premium product CG response policy", () => {
  const safeShot = {
    shotId: 1,
    type: "product_reveal",
    duration: 4,
    description: "A walnut lounge chair on a quiet studio floor.",
    camera: "A slow, level dolly toward the chair.",
    visualSource: "product_image",
    transition: "direct_concat",
    voiceover: "",
    prompt: "Walnut lounge chair, soft studio light, realistic material detail, no added graphics.",
  } satisfies Shot;

  it("strips executable overlay, character, and narration fields from a silent CG shot", () => {
    const result = sanitizePremiumProductCgShot(
      {
        ...safeShot,
        textOverlay: { text: "SALE", style: "title" },
        characterId: "presenter",
        narration: "A calm factual note",
      },
      profile,
    );

    expect(result.shot.voiceover).toBe("");
    expect(result.shot).not.toHaveProperty("textOverlay");
    expect(result.shot).not.toHaveProperty("characterId");
    expect(result.shot).not.toHaveProperty("narration");
    expect(result.issues.map((issue) => issue.code)).toContain("text_overlay");
  });

  it("reports generated text and promotional voiceover while leaving legacy sales lint untouched", () => {
    const unsafe = {
      ...safeShot,
      description: "Show the chair with a BUY NOW title card.",
      voiceover: "Buy now and click the link.",
      narration: "Buy now and click the link.",
    };
    const issues = lintCreativeProfileShot(profile, unsafe);
    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["generated_text", "marketing_visual", "promotional_voiceover"]),
    );
    expect(issues.filter((issue) => issue.field === "narration")).toHaveLength(1);
    expect(lintCreativeProfileShot({ styleType: "pain_point" }, unsafe)).toEqual([]);
  });

  it("accepts the CG compiler's own negative text policy while still rejecting positive copy requests", () => {
    const issues = lintCreativeProfileShot(profile, {
      ...safeShot,
      prompt: "Do not generate added on-screen text, captions, subtitles, numbers, prices, graphic cards, or watermarks; preserve only markings already visible in the reference.",
    });

    expect(issues).toEqual([]);
  });

  it("rejects a copy directive hidden in visualIntent", () => {
    const issues = lintCreativeProfileShot(profile, {
      ...safeShot,
      visualIntent: "Show the chair with a BUY NOW title card.",
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "generated_text", field: "visualIntent" }),
      expect.objectContaining({ code: "marketing_visual", field: "visualIntent" }),
    ]));
  });

  it("accepts a structurally valid silent response and forces the server-selected CG style", () => {
    const response = {
      scripts: [{
        title: "Quiet material study",
        styleType: "talking_head",
        totalDuration: 4,
        characters: [{ id: "host", name: "Host", gender: "male" }],
        shots: [{
          ...safeShot,
          voiceover: "This should be discarded in silent mode.",
          textOverlay: { text: "Walnut", style: "subtitle" },
          characterId: "host",
          narration: "This should also be discarded.",
          beatRole: "material",
          visualIntent: "Show the weave and walnut grain.",
        }],
      }],
    };

    const scripts = parseScriptResponse(JSON.stringify(response), "premium_product_cg");
    expect(scripts).toHaveLength(1);
    expect(scripts[0].styleType).toBe(PREMIUM_PRODUCT_CG_STYLE);
    expect(scripts[0].characters).toBeUndefined();
    expect(scripts[0].shots[0]).toMatchObject({
      voiceover: "",
      beatRole: "material",
      visualIntent: "Show the weave and walnut grain.",
    });
    expect(scripts[0].shots[0]).not.toHaveProperty("textOverlay");
    expect(scripts[0].shots[0]).not.toHaveProperty("characterId");
    expect(scripts[0].shots[0]).not.toHaveProperty("narration");
  });

  it("accepts empty voiceovers in restrained CG mode, as permitted by its prompt", () => {
    const restrainedProfile = createPremiumProductCgProfile({ narrationMode: "restrained" });
    const response = {
      title: "Quiet material study",
      shots: [safeShot, { ...safeShot, shotId: 2, voiceover: "   " }],
    };

    const scripts = parseScriptResponse(JSON.stringify(response), "pain_point", restrainedProfile);

    expect(scripts).toHaveLength(1);
    expect(scripts[0].styleType).toBe(PREMIUM_PRODUCT_CG_STYLE);
    expect(scripts[0].shots.map((shot) => shot.voiceover)).toEqual(["", ""]);
  });

  it("keeps both silent and narrated options in a restrained CG batch", () => {
    const restrainedProfile = createPremiumProductCgProfile({ narrationMode: "restrained" });
    const response = {
      scripts: [
        { title: "Quiet material study", shots: [safeShot] },
        { title: "Narrated material study", shots: [{ ...safeShot, voiceover: "The frame is walnut." }] },
      ],
    };

    const scripts = parseScriptResponse(JSON.stringify(response), PREMIUM_PRODUCT_CG_STYLE, restrainedProfile);

    expect(scripts.map((script) => script.title)).toEqual(["Quiet material study", "Narrated material study"]);
    expect(scripts[1].shots[0].voiceover).toBe("The frame is walnut.");
  });

  it("still rejects echoed placeholder voiceover in restrained CG mode", () => {
    const restrainedProfile = createPremiumProductCgProfile({ narrationMode: "restrained" });
    const response = {
      title: "Invalid material study",
      shots: [{ ...safeShot, voiceover: "english keyword" }],
    };

    expect(() => parseScriptResponse(JSON.stringify(response), PREMIUM_PRODUCT_CG_STYLE, restrainedProfile)).toThrow(/口播/);
  });

  it("rejects a CG response that asks the renderer to add a promotional visual", () => {
    const response = {
      title: "Unsafe film",
      shots: [{
        ...safeShot,
        description: "Show a discount label beside the chair.",
      }],
    };

    expect(() => parseScriptResponse(JSON.stringify(response), "premium_product_cg")).toThrow(/policy violation/);
  });
});
