import { describe, expect, it } from "vitest";
import { buildTideweCategoryGuidance } from "@/lib/tidewe/category-guidance";

const categories = [
  { category: "hunting_blind", label: "狩猎帐篷", detail: /接缝|开口|连接/ },
  { category: "waders", label: "涉水服", detail: /接缝|胸前|脚部连接/ },
    { category: "heated_gear", label: "加热装备", detail: /当前装备|局部参考图/ },
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
    { category: "hunting_blind", details: [/门/, /窗/, /开口/, /支架|框架/] },
    { category: "waders", details: [/背带/, /扣/, /接缝/, /脚部连接|靴脚连接/] },
    { category: "heated_gear", details: [/局部参考图实际展示的部位/, /面料/, /连接/] },
    { category: "apparel", details: [/拉链/, /口袋/, /袖口/, /调节|扣件/] },
    { category: "boots", details: [/靴筒/, /扣带|扣件/, /外底|鞋底/, /接触|接地/] },
    { category: "accessories", details: [/镜筒|镜片|光学/, /调节/, /背带|绑带/, /连接/] },
  ])("offers reference-dependent detail targets for $category", ({ category, details }) => {
    const guidance = buildTideweCategoryGuidance(category);
    for (const detail of details) expect(guidance.visualExamples.detail).toMatch(detail);
    expect(guidance.visualExamples.detail).toMatch(/参考|可见/);
    expect(guidance.scope).toMatch(/不是当前商品事实或固定镜头模板/);
  });

  it.each([
    ...categories.map(({ category }) => category),
    "heated_apparel", "hunting_apparel", "waterproof_boots", "hunting_chair",
    "other", "unknown-category", undefined,
  ])("keeps a common appearance policy for %s without requiring performance confirmation", category => {
    const guidance = buildTideweCategoryGuidance(category);
    expect(guidance.referenceAppearancePolicy).toBe(buildTideweCategoryGuidance("other").referenceAppearancePolicy);
    expect(guidance.referenceAppearancePolicy).toMatch(/外观|形状/);
    expect(guidance.referenceAppearancePolicy).toMatch(/已确认.*性能|性能.*已确认/);
    expect(guidance.referenceAppearancePolicy).toMatch(/特写/);
    expect(guidance.referenceAppearancePolicy).toContain("不是部件清单或允许拍摄的范围");
    expect(guidance.referenceAppearancePolicy).toContain("不证明商品具备示例中的部件");
    expect(guidance.referenceAppearancePolicy).toContain("局部参考图重点展示的部位优先");
    expect(guidance.referenceAppearancePolicy).toContain("不按固定部件清单筛选");
    expect(guidance.referenceAppearancePolicy).toMatch(/未经确认|待核实|不特写/);
    expect(guidance.referenceAppearancePolicy).toMatch(/功能|操作|性能/);
    expect(guidance.evidenceLimits.trim()).not.toBe("");
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
    expect(guidance.evidenceLimits).toContain("不推断商品类型");
    expect(guidance.evidenceLimits).toContain("当前参考可见的结构与位置可直接展示");
    expect(guidance.evidenceLimits).toContain("隐藏结构、功能和性能不由外观推断");
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

  it.each([
    { category: "accessories", productName: "TIDEWE Hunting Chair" },
    { category: "heated_gear", productName: "TIDEWE Heated Chair" },
    { category: "hunting_chair", productName: undefined },
  ])("prioritizes any actual local reference detail for $category chairs", ({ category, productName }) => {
    const guidance = buildTideweCategoryGuidance(category, {
      productName,
      visualObservations: "椅面右侧的侧袋上方可见控制面板，按钮和固定位置清楚。",
    });
    expect(guidance.visualExamples.detail).toContain("参考中已有");
    expect(guidance.visualExamples.detail).toContain("侧袋");
    expect(guidance.visualExamples.detail).toContain("优先特写当前局部参考图实际展示的任一部位");
    expect(guidance.visualExamples.detail).toContain("保留其位置、连接和接触关系");
    expect(guidance.productFocusExample).toContain("局部图实际展示的部位");
    expect(guidance.productFocusExample).toContain("真实布局与位置");
    expect(guidance.evidenceLimits).toContain("不默认可折叠、旋转或调节");
    expect(guidance.evidenceLimits).toContain("不由坐下或按压证明承重、舒适、静音或加热性能");
    expect(JSON.stringify(guidance.visualExamples)).not.toMatch(/未经确认|待核实|不特写/);
  });

  it("does not impose a control checklist on chair detail references", () => {
    const guidance = buildTideweCategoryGuidance("accessories", { productName: "TIDEWE Hunting Chair" });
    expect(guidance.visualExamples.detail).toContain("当前局部参考图实际展示的任一部位");
    expect(guidance.referenceAppearancePolicy).toContain("不按固定部件清单筛选");
    expect(guidance.productFocusExample).toContain("局部图实际展示的部位");
    expect(guidance.visualExamples.detail).not.toMatch(/控制面板|按钮/);
    expect(guidance.productFocusExample).not.toMatch(/控制面板|按钮/);
    expect(guidance.visualExamples.context).not.toMatch(/控制面板|按钮|侧袋/);
    expect(guidance.visualExamples.ordinaryUse).not.toMatch(/控制面板|按钮|侧袋/);
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
