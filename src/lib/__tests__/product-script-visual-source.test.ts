// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPremiumProductCgProfile,
  createShortVideoSalesProfile,
  type ProductVisualSource,
} from "@/lib/creative-profiles";
import { buildBatchPrompt, buildTopicBatchPrompt, buildUserPrompt } from "@/lib/script-engine/prompts";
import { generateScript, generateScriptStream, generateSingleScript, generateTopicScript, parseScriptResponse, type GeneratedScript } from "@/lib/script-engine/generator";

const { complete } = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("@/lib/llm-error", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/llm-error")>(),
  createLLMClient: () => ({ chat: { completions: { create: complete } } }),
}));

const input = { productName: "休闲椅", category: "home" as const, styleType: "pain_point" as const };
const shot = (visualSource: string) => ({
  duration: 4,
  type: "demo",
  description: "商品照片中可见的扶手细节。",
  camera: "在原图内缓慢推近。",
  voiceover: "细节尽在眼前。",
  visualSource,
});
const response = JSON.stringify({ title: "细节", shots: [shot("ai_generate"), shot("product_image"), shot("user_upload")] });
const profileFactories = [createShortVideoSalesProfile, createPremiumProductCgProfile];

describe("product script source selection", () => {
  it.each(["pain_point", "premium_product_cg"] as const)("defaults every %s shot to original photos in single and batch prompts", (styleType) => {
    for (const prompt of [buildUserPrompt({ ...input, styleType }), buildBatchPrompt({ ...input, styleType }, 2)]) {
      expect(prompt).toContain('"visualSource": "product_image"');
      expect(prompt).toContain('每个分镜 visualSource 必须为 "product_image"');
      expect(prompt).toContain("原图范围内的二维裁切、平移、推近、拉远或静止");
      expect(prompt).toContain("不新增拍摄角度、背面、场景、背景");
    }
  });

  it("uses existing photo settings instead of the CG recipe's generated environment", () => {
    const prompt = buildUserPrompt({ ...input, creativeProfile: createPremiumProductCgProfile({ recipeSnapshot: { recipeId: "living_scale" } }) });
    expect(prompt).toContain("preserve the existing backgrounds in the supplied product photos");
    expect(prompt).toContain("preserve the existing light, finish, and colors");
    expect(prompt).not.toContain("Choose a restrained use environment");
    expect(prompt).not.toContain("【CG visual recipe:");
  });

  it.each(profileFactories)("requires AI generation of every shot from product references when selected", (create) => {
    const creativeProfile = create({ visualSource: "ai_generate" });
    for (const prompt of [buildUserPrompt({ ...input, creativeProfile }), buildBatchPrompt({ ...input, creativeProfile }, 2)]) {
      expect(prompt).toContain('"visualSource": "ai_generate"');
      expect(prompt).toContain('每个分镜 visualSource 必须为 "ai_generate"');
      expect(prompt).toContain("以用户上传的商品图作为生成参考");
      expect(prompt).toContain("所有方案、所有分镜统一使用所选来源");
    }
  });

  it.each(profileFactories)("overrides model-selected and missing sources with the user's persisted selection", (create) => {
    for (const visualSource of ["product_image", "ai_generate"] satisfies ProductVisualSource[]) {
      const creativeProfile = create({ visualSource });
      const scripts = parseScriptResponse(response, "pain_point", creativeProfile);
      expect(scripts[0].shots.map((s) => s.visualSource)).toEqual([visualSource, visualSource, visualSource]);
      const missing = parseScriptResponse(JSON.stringify({ shots: [{ voiceover: "细节尽在眼前。" }] }), "custom", creativeProfile);
      expect(missing[0].shots[0].visualSource).toBe(visualSource);
    }
  });

  it("leaves topic prompts and profile-free imported scripts source-compatible", () => {
    const topic = buildTopicBatchPrompt({ topic: "如何冲泡咖啡" }, 2);
    expect(topic).toContain('visualSource: 固定为 "ai_generate"');
    expect(topic).not.toContain("画面来源：用户选择");
    for (const style of ["custom", "pain_point"]) {
      expect(parseScriptResponse(response, style)[0].shots.map((s) => s.visualSource)).toEqual(["ai_generate", "product_image", "user_upload"]);
    }
  });
});

describe("product generation passes its source policy to validation", () => {
  beforeEach(() => {
    complete.mockReset();
    complete.mockResolvedValue({ choices: [{ message: { content: response } }] });
  });

  const llmConfig = { baseUrl: "https://example.com/v1", apiKey: "test", model: "test" };

  it.each([generateScript, generateSingleScript])("defaults product generation without a profile to original photos, including custom style", async (generate) => {
    const generated = await generate({ ...input, styleType: "custom", llmConfig });
    const scripts = Array.isArray(generated) ? generated : [generated];
    expect(scripts[0].shots.every((s) => s.visualSource === "product_image")).toBe(true);
  });

  it.each([generateScript, generateSingleScript])("enforces the AI selection after generation", async (generate) => {
    const generated = await generate({ ...input, llmConfig, creativeProfile: createShortVideoSalesProfile({ visualSource: "ai_generate" }) });
    const scripts = Array.isArray(generated) ? generated : [generated];
    expect(scripts[0].shots.every((s) => s.visualSource === "ai_generate")).toBe(true);
  });

  it("applies the selection when streaming generation finishes", async () => {
    complete.mockResolvedValueOnce((async function* () {
      yield { choices: [{ delta: { content: response } }] };
    })());
    const scripts = await new Promise<GeneratedScript[]>((resolve, reject) => {
      generateScriptStream({ ...input, llmConfig }, { onComplete: resolve, onError: reject });
    });
    expect(scripts[0].shots.every((s) => s.visualSource === "product_image")).toBe(true);
  });

  it("keeps the product-free topic generation path unchanged", async () => {
    const scripts = await generateTopicScript({ topic: "如何冲泡咖啡", llmConfig });
    expect(scripts[0].shots.map((s) => s.visualSource)).toEqual(["ai_generate", "product_image", "user_upload"]);
  });
});
