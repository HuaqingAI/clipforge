// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeTideweProductImages, isStaleTideweVisualObservations, TIDEWE_VISUAL_OBSERVATIONS_PREFIX, TIDEWE_VISUAL_OBSERVATIONS_VERSION } from "@/lib/tidewe/image-analysis";

const model = vi.hoisted(() => ({ create: vi.fn(), client: vi.fn() }));
vi.mock("@/lib/llm-error", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/llm-error")>(),
  createLLMClient: (...args: unknown[]) => {
    model.client(...args);
    return { chat: { completions: { create: model.create } } };
  },
}));

const config = { baseUrl: "https://example.test/v1", apiKey: "test", model: "text-model", visionModel: "vision-model" };
beforeEach(() => {
  model.client.mockReset();
  model.create.mockReset().mockResolvedValue({ choices: [{ message: { content: "图3：observed 不知名的弧形夹片，细纹表面与右侧半透明边缘清楚可见；整件商品上的安装位置未展示。" } }] });
});

describe("TIDEWE reference appearance analysis", () => {
  it("inspects every indexed reference in one vision-model call and retains visible component evidence", async () => {
    const references = Array.from({ length: 6 }, (_, index) => `https://example.test/reference-${index + 1}.png`);
    const observations = await analyzeTideweProductImages(config, references);
    expect(model.create).toHaveBeenCalledOnce();
    const request = model.create.mock.calls[0][0];
    expect(request.model).toBe("vision-model");
    const content = request.messages[0].content;
    expect(content.filter((item: { type: string }) => item.type === "image_url").map((item: { image_url: { url: string } }) => item.image_url.url)).toEqual(references);
    references.forEach((_, index) => expect(content[index * 2 + 1].text).toBe(`图${index + 1}：当前商品参考`));
    const prompt = content[0].text;
    expect(prompt).toContain("逐图用自然语言说明这是整体展示还是局部、细节视图");
    expect(prompt).toContain("图片主要展示哪里，就优先记录哪里");
    expect(prompt).toContain("即使整体图的概述未提到，也要完整保留");
    expect(prompt).toContain("不套预设品类、部件名称或必查清单");
    expect(prompt).toContain("不认识具体名称时，直接用可见形态描述，不省略该细节");
    expect(prompt).toContain("位置只相对于图中可见的上下文说明");
    expect(prompt).toContain("连接、接触或标记只有在图中展示时才记录");
    expect(prompt).not.toMatch(/控制器|按钮|猎帐|涉水服|靴筒|鞋底|光学部件|加热装备/);
    expect(prompt).toContain("配件出现在图中不等于随商品附送");
    expect(prompt).toContain("独立细节图不能证明该主体在整件商品上的安装位置");
    expect(prompt).toContain("这些可见外观足以支持原样呈现和特写，但不能证明性能或功能");
    expect(prompt).toContain("不得从外观推断隐藏操作方式、机制、性能、规格或包装清单");
    expect(TIDEWE_VISUAL_OBSERVATIONS_VERSION).toBe(3);
    expect(observations).toContain(TIDEWE_VISUAL_OBSERVATIONS_PREFIX);
    expect(observations).toContain("不知名的弧形夹片，细纹表面与右侧半透明边缘");
    expect(observations).toContain("整件商品上的安装位置未展示");
  });

  it("falls back to the text model when a separate vision model is not configured", async () => {
    await analyzeTideweProductImages({ ...config, visionModel: undefined }, ["https://example.test/jacket.png"]);
    expect(model.create).toHaveBeenCalledOnce();
    expect(model.create.mock.calls[0][0].model).toBe("text-model");
  });

  it.each(["", " \n\t ", undefined])("returns no cache marker for an empty response: %j", async content => {
    model.create.mockResolvedValueOnce({ choices: [{ message: { content } }] });
    expect(await analyzeTideweProductImages(config, ["https://example.test/jacket.png"])).toBe("");
    expect(model.create).toHaveBeenCalledOnce();
  });

  it("does not call a model when there are no references", async () => {
    expect(await analyzeTideweProductImages(config, [])).toBe("");
    expect(model.create).not.toHaveBeenCalled();
    expect(model.client).not.toHaveBeenCalled();
  });
});

describe("TIDEWE observation cache version detection", () => {
  it.each([
    { value: "UNVERIFIED VISUAL OBSERVATIONS ONLY (not product specifications): green jacket", stale: true },
    { value: "TIDEWE_REFERENCE_APPEARANCE_V2: visible controller", stale: true },
    { value: `${TIDEWE_VISUAL_OBSERVATIONS_PREFIX} visible boot seams`, stale: false },
    { value: "TIDEWE_REFERENCE_APPEARANCE_V4: newer observations", stale: false },
    { value: "TIDEWE_REFERENCE_APPEARANCE_V1: unknown format", stale: false },
    { value: "custom appearance notes", stale: false },
    { value: "", stale: false },
    { value: undefined, stale: false },
    { value: null, stale: false },
  ])("refreshes known legacy formats only: $value", ({ value, stale }) => {
    expect(isStaleTideweVisualObservations(value)).toBe(stale);
  });
});
