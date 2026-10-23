import { describe, expect, it } from "vitest";
import {
  OUTPUT_FORMAT_PROMPT,
  PREMIUM_PRODUCT_CG_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  buildBatchPrompt,
  buildUserPrompt,
  type ScriptGenerationInput,
} from "@/lib/script-engine/prompts";

const englishVisualRequirement = /prompt 字段(?:要)?用英文|英文AI生图|prompt: 英文|English visual-generation prompt|Keep the generation prompt in English|"description"\/"camera" may be concise English/;

describe("product script visual-field language", () => {
  it.each(["pain_point", "premium_product_cg"] as const)("requires Chinese visual fields for %s with either product language", (styleType) => {
    for (const productName of ["便携榨汁杯", "Portable blender"]) {
      const input: ScriptGenerationInput = { productName, category: "home", styleType };
      for (const prompt of [buildUserPrompt(input), buildBatchPrompt(input, 2)]) {
        expect(prompt).toContain("description、visualIntent、camera、prompt 始终使用中文");
        expect(prompt).toMatch(/"prompt": "中文/);
        expect(prompt).toContain("JSON 字段名和枚举值保持原样");
        expect(prompt).not.toMatch(englishVisualRequirement);
      }
    }
  });

  it("does not let system instructions or the commerce schema override Chinese visual fields", () => {
    expect(SYSTEM_PROMPT).toContain("视觉字段统一用中文写");
    expect(PREMIUM_PRODUCT_CG_SYSTEM_PROMPT).toContain("Write description, visualIntent, camera, and prompt in Chinese");
    for (const prompt of [SYSTEM_PROMPT, PREMIUM_PRODUCT_CG_SYSTEM_PROMPT, OUTPUT_FORMAT_PROMPT]) {
      expect(prompt).not.toMatch(englishVisualRequirement);
    }
    expect(OUTPUT_FORMAT_PROMPT).toContain("searchTerms: 1-3 个英文检索词");
  });

  it("preserves the overseas commerce title and narration locale while keeping visual directions Chinese", () => {
    const prompt = buildUserPrompt({ productName: "Portable blender", category: "home", styleType: "pain_point" });
    expect(prompt).toContain("title and voiceover only");
    expect(prompt).toContain('Write every "title" and "voiceover" field in the SAME language as the product');
    expect(prompt).toContain('Keep "searchTerms" in English as usual');
    expect(prompt).toContain('Always write "description", "visualIntent", "camera", and "prompt" in Chinese');
  });

  it("preserves the overseas CG title and restrained narration locale independently of visual directions", () => {
    const prompt = buildUserPrompt({ productName: "Portable blender", category: "home", styleType: "premium_product_cg", narrationMode: "restrained" });
    expect(prompt).toContain("title 和任何克制旁白沿用商品资料的语言");
    expect(prompt).toContain("description、visualIntent、camera、prompt 等视觉字段始终使用中文");
  });
});
