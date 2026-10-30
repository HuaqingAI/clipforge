import { describe, expect, it } from "vitest";
import { buildTideweCategoryGuidance } from "@/lib/tidewe/category-guidance";

const categories = [
  { category: "hunting_blind", label: "狩猎帐篷", detail: /接缝|开口|连接/ },
  { category: "waders", label: "涉水服", detail: /接缝|胸前|脚部连接/ },
  { category: "heated_gear", label: "加热装备", detail: /当前装备|可见控制/ },
  { category: "apparel", label: "服装", detail: /面料|接缝|扣件/ },
  { category: "boots", label: "靴子", detail: /靴筒|筒口|外底/ },
  { category: "accessories", label: "配件", detail: /当前配件|接触面/ },
] as const;

function visualExamples(category: unknown, productName?: string) {
  const guidance = buildTideweCategoryGuidance(category, { productName });
  return JSON.stringify({ visualExamples: guidance.visualExamples, productFocusExample: guidance.productFocusExample });
}

describe("TIDEWE category-specific production guidance", () => {
  it.each(categories)("uses relevant examples for $label without a global boot template", ({ category, label, detail }) => {
    const guidance = buildTideweCategoryGuidance(category);
    expect(guidance.category).toBe(category);
    expect(guidance.label).toBe(label);
    expect(guidance.visualExamples.detail).toMatch(detail);
    expect(guidance.copyAngles.length).toBeGreaterThan(0);
    expect(guidance.productFocusExample.trim()).not.toBe("");
    if (category !== "boots") expect(visualExamples(category)).not.toMatch(/靴筒|筒口|外底|鞋底|\bboots?\b|outsole/i);
  });

  it("gives the six classes distinct detail observations", () => {
    const details = categories.map(({ category }) => buildTideweCategoryGuidance(category).visualExamples.detail);
    expect(new Set(details).size).toBe(categories.length);
  });

  it.each([
    ...categories.map(({ category }) => ({ category, productName: undefined })),
    { category: "hunting_chair", productName: undefined },
    { category: "heated_gear", productName: "TIDEWE Heated Chair" },
    { category: "other", productName: undefined },
    { category: "unknown-category", productName: undefined },
  ])("keeps existing environment and continuous foreground support readable for $category / $productName", ({ category, productName }) => {
    const focus = buildTideweCategoryGuidance(category, { productName }).contactAndFocus;
    expect(focus).toContain("近处与中景清楚可辨");
    expect(focus).toContain("轻微柔化只允许用于主体后方的远背景，其原有结构仍可读");
    expect(focus).toContain("不添加原场景没有的景物");
    expect(focus).toContain("所有景别（包括近景和特写）");
    expect(focus).toContain("原画面已有近处地面、台面或支撑面从画面下边缘延伸至可见接触处时");
    expect(focus).toContain("该段连续区域自然清楚可读，不允许画面底边模糊带");
    expect(focus).toContain("主体前方全部已有前景均清楚可读");
    expect(focus).toContain("不与商品或支撑面相连的独立近物及画幅边缘，没有近物失焦例外");
    expect(focus).toContain("不新增原画面不存在的支撑或场景");
    expect(focus).toContain("不要求所有距离同等锐利");
    expect(focus).not.toMatch(/远处植被渐柔|远处树林逐渐柔化/);
  });

  it("preserves an empty existing backdrop instead of requiring scenery to fill it", () => {
    const focus = buildTideweCategoryGuidance("other", { productName: "Equipment against an empty backdrop", visualObservations: "背景空旷，没有树木或草丛。" }).contactAndFocus;
    expect(focus).toContain("保留现有环境");
    expect(focus).toContain("不添加原场景没有的景物");
    expect(focus).toContain("原画面已有近处地面、台面或支撑面");
    expect(focus).toContain("不新增原画面不存在的支撑或场景");
    expect(focus).not.toMatch(/树|草|落叶|植被/);
  });

  it.each([undefined, null, "", "other", "unknown-category"])("keeps an unset or unknown category generic: %s", (category) => {
    const guidance = buildTideweCategoryGuidance(category, { productName: "TIDEWE outdoor equipment" });
    expect(guidance.category).toBe("unspecified");
    expect(guidance.label).not.toBe("配件");
    expect(guidance).not.toHaveProperty("subtype");
    expect(visualExamples(category)).not.toMatch(/靴筒|筒口|外底|椅脚|座面|袖口|帐篷/);
    expect(guidance.evidenceLimits).toMatch(/不推断商品类型、结构或功能/);
  });

  it("uses chair examples only when an accessory is identified as a chair", () => {
    const chair = buildTideweCategoryGuidance("accessories", { productName: "TIDEWE Hunting Chair" });
    expect(chair.category).toBe("accessories");
    expect(chair.label).toBe("配件");
    expect(chair).toHaveProperty("subtype", "chair");
    expect(chair.visualExamples.context).toMatch(/椅子/);
    expect(chair.productFocusExample).toMatch(/座面|椅脚/);
    expect(chair.evidenceLimits).toMatch(/不能坐着调整椅脚/);
    expect(visualExamples("accessories", "TIDEWE Hunting Chair")).not.toMatch(/靴筒|筒口|外底/);

    const unnamed = buildTideweCategoryGuidance("accessories");
    expect(unnamed).not.toHaveProperty("subtype");
    expect(visualExamples("accessories")).not.toMatch(/椅脚|座面|椅子/);
    expect(unnamed.evidenceLimits).toMatch(/不能仅因属于配件就默认是椅子/);
  });

  it("retains heating limitations when a heated product is explicitly a chair", () => {
    const guidance = buildTideweCategoryGuidance("heated_gear", { productName: "TIDEWE Heated Chair" });
    expect(guidance.category).toBe("heated_gear");
    expect(guidance.label).toBe("加热装备");
    expect(guidance).toHaveProperty("subtype", "chair");
    expect(guidance.visualExamples.detail).toMatch(/座面|椅脚/);
    expect(guidance.evidenceLimits).toMatch(/不默认加热区、温度、档位、续航或附送电池/);
    expect(guidance.evidenceLimits).toMatch(/不由坐下或按压证明承重、舒适、静音或加热性能/);
  });

  it("retains the known chair subtype from a legacy category without a product name", () => {
    const guidance = buildTideweCategoryGuidance("hunting_chair");
    expect(guidance.category).toBe("accessories");
    expect(guidance).toHaveProperty("subtype", "chair");
    expect(guidance.visualExamples.context).toMatch(/椅子/);
    expect(guidance.evidenceLimits).toMatch(/不默认可折叠、旋转或调节/);
  });

  it.each(["TIDEWE Heated Seat Cushion", "TIDEWE 加热坐垫"])("does not invent a chair frame for %s", (productName) => {
    const guidance = buildTideweCategoryGuidance("heated_gear", { productName });
    expect(guidance).not.toHaveProperty("subtype", "chair");
    expect(visualExamples("heated_gear", productName)).not.toMatch(/椅子|椅脚|支撑连接/);
    expect(guidance.evidenceLimits).toMatch(/不默认加热区、温度、档位、续航或附送电池/);
  });

  it.each([
    ["heated_apparel", "heated_gear"],
    ["hunting_apparel", "apparel"],
    ["waterproof_boots", "boots"],
    ["hunting_chair", "accessories"],
  ])("selects current class guidance for legacy category %s", (legacy, canonical) => {
    expect(buildTideweCategoryGuidance(legacy).category).toBe(canonical);
  });

  it.each([...categories.map(({ category }) => category), "other"])("keeps %s examples optional and separate from product evidence", (category) => {
    const guidance = buildTideweCategoryGuidance(category);
    expect(guidance.scope).toMatch(/可选文案角度与画面示例/);
    expect(guidance.scope).toMatch(/不是当前商品事实或固定镜头模板/);
    expect(guidance.scope).toMatch(/仅采用商品资料和参考支持/);
    expect(guidance.evidenceLimits.trim()).not.toBe("");
  });
});
