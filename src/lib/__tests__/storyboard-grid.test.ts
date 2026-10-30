import { describe, it, expect } from "vitest";
import { buildStoryboardGridPrompt, computeGridCells, GRID_MAX_SHOTS } from "@/lib/storyboard-grid";
import type { Shot, ScriptCharacter } from "@/lib/db/schema";
import { createTideweOutdoorProfile } from "@/lib/creative-profiles";
import { compileTideweVisualPrompt, TIDEWE_IMAGE_FOCUS_TARGET, TIDEWE_PHOTOGRAPHIC_POLICY } from "@/lib/tidewe/visual-policy";
import { tidewePresenterAnchor } from "@/lib/tidewe/presenter";

const shot = (shotId: number, type: string, description: string) =>
  ({ shotId, type, duration: 3, description, voiceover: "词", visualSource: "ai_generate", transition: "cut" }) as unknown as Shot;

describe("buildStoryboardGridPrompt", () => {
  const shots = [shot(1, "hook", "女生对镜头惊讶"), shot(2, "demo", "上手使用产品"), shot(3, "cta", "举起产品推荐")];
  const cast: ScriptCharacter[] = [
    { id: "char_a", name: "小美", gender: "female", persona: "活泼", appearance: "22 岁高马尾白 T 恤" } as ScriptCharacter,
  ];

  it("applies initial TIDEWE anatomy and optical quality once while keeping each approved cell's action and framing", () => {
    const profile = createTideweOutdoorProfile();
    const planned: Shot[] = [
      { ...shots[0], description: "主播在树林边已扶住当前商品边缘。", camera: "全景显示人与商品及中远景小径。", tidewe: { copySpan: { start: 0, end: 0 }, translation: "", shotGoal: "显示商品使用空间", productVisible: true, personVisible: true, factRefs: [], sceneId: "woods", visualPlan: { framing: "wide", visualRole: "demonstration", productFocus: "当前商品外轮廓及手部接触处", actionStart: "手已扶住商品边缘", action: "轻触可见边缘一次", actionEnd: "完成动作后手自然放稳" } } },
      { ...shots[1], description: "无人出镜，商品现有连接处与支撑面局部可见。", camera: "固定局部特写", tidewe: { copySpan: { start: 0, end: 0 }, translation: "", shotGoal: "观察实际连接处", productVisible: true, personVisible: false, factRefs: [], sceneId: "woods", visualPlan: { framing: "detail", visualRole: "detail", productFocus: "商品现有连接处与邻近支撑面", actionStart: "连接处已稳定入画", action: "静态观察已有连接状态", actionEnd: "连接处继续保持稳定" } } },
    ];
    const before = structuredClone(planned);
    const prompt = buildStoryboardGridPrompt(planned, null, { creativeProfile: profile, characterSheet: true, productImageCount: 2 });
    expect(prompt.split(TIDEWE_IMAGE_FOCUS_TARGET)).toHaveLength(2);
    expect(prompt).not.toContain(TIDEWE_PHOTOGRAPHIC_POLICY);
    expect(prompt.split("画面结构：")).toHaveLength(2);
    expect(prompt).toContain("肩、肘、前臂、手腕与手自然连续");
    expect(prompt).toContain("左右手、掌背、拇指侧别与关节符合真实姿态");
    expect(prompt).toContain("保留自然遮挡");
    expect(prompt).toContain("可见部件数量和连接关系以参考为准");
    expect(prompt).toContain("光线与焦点服从本格");
    expect(prompt).toContain("商品在本格环境中重新成像");
    expect(prompt.match(/合焦目标：近前景—接触处—商品共同合焦/g)).toHaveLength(planned.length);
    for (const cell of planned) {
      expect(prompt).toContain(cell.description);
      expect(prompt).toContain(cell.camera!);
      expect(prompt).toContain(cell.tidewe!.visualPlan!.productFocus!);
      expect(prompt).toContain(cell.tidewe!.visualPlan!.actionStart);
      expect(prompt).toContain(cell.tidewe!.visualPlan!.action);
      expect(prompt).not.toContain(cell.tidewe!.visualPlan!.actionEnd);
    }
    expect(prompt).toContain("已确认景别：全景／使用空间");
    expect(prompt).toContain("已确认景别：特写／局部部件与接触");
    expect(prompt).not.toMatch(/reference image 1|source image|repair report|Edit and regenerate|保留源图/i);
    expect(planned).toEqual(before);
    expect(buildStoryboardGridPrompt(shots)).not.toContain(TIDEWE_IMAGE_FOCUS_TARGET);
  });

  it.each(["靴子鞋底", "椅脚"])("keeps the lower-edge support surface readable in a low-angle close-up of %s", productPart => {
    const planned: Shot = { ...shots[0], description: `${productPart}已稳定落在现有落叶地面，画面下沿至接触处为连续地面。`, camera: "固定低机位近景，保留原有局部构图。",
      tidewe: { copySpan: { start: 0, end: 0 }, translation: "", shotGoal: "观察现有支撑与接触关系", productVisible: true, personVisible: false, factRefs: [], sceneId: "woods", visualPlan: {
        framing: "close_up", visualRole: "detail", productFocus: `${productPart}与落叶地面的现有接触位置`, actionStart: `${productPart}已踩稳或放稳在地面`, action: "静态观察当前接地状态", actionEnd: "商品继续保持稳定支撑",
      } } };
    const before = structuredClone(planned);
    const prompt = buildStoryboardGridPrompt([planned], null, { creativeProfile: createTideweOutdoorProfile(), productImageCount: 2 });
    expect(prompt.split(TIDEWE_IMAGE_FOCUS_TARGET)).toHaveLength(2);
    expect(prompt).not.toContain(TIDEWE_PHOTOGRAPHIC_POLICY);
    expect(prompt).toContain("合焦目标：近前景—接触处—商品共同合焦，仅限本格已有表面");
    expect(prompt).toContain("已确认景别：近景／较大操作区域");
    expect(prompt).toContain(planned.description);
    expect(prompt).toContain(planned.camera!);
    expect(prompt).toContain(planned.tidewe!.visualPlan!.productFocus!);
    expect(prompt).toContain(planned.tidewe!.visualPlan!.actionStart);
    expect(prompt).toContain(planned.tidewe!.visualPlan!.action);
    expect(prompt).not.toContain(planned.tidewe!.visualPlan!.actionEnd);
    expect(prompt).toContain("第 1 张参考图为当前同一商品的第 1/2 个视角");
    expect(prompt).toContain("第 2 张参考图为当前同一商品的第 2/2 个视角");
    expect(planned).toEqual(before);
  });

  it.each([5, 9])("uses concise image briefs for %i shots with one identity and no repeated audio or safety template", count => {
    const presenter = { id: "host", name: "Sam", appearance: "成年男性，棕色短发，灰色户外夹克，普通使用者体型", referenceImages: ["/api/files/test/presenter.png"] };
    const profile = createTideweOutdoorProfile({ presenter, speechMode: "voiceover" });
    const anchor = tidewePresenterAnchor(presenter);
    const planned: Shot[] = Array.from({ length: count }, (_, index) => ({ ...shots[0], shotId: index + 1,
      description: `${anchor}在林边稳稳扶住迷彩靴筒，靴底与落叶地面相接。`, visualIntent: `观察商品第${index + 1}处可见表面`, camera: "固定低机位，保留完整靴筒与近前景。",
      tidewe: { copySpan: { start: 0, end: 0 }, translation: "", shotGoal: "观察穿戴后的部件和接地关系", productVisible: true, personVisible: true, sceneId: "woods", presenter, factRefs: [],
        visualPlan: { framing: index % 2 ? "detail" : "wide", visualRole: index % 2 ? "detail" : "demonstration", productFocus: `第${index + 1}处现有靴筒与接触部位`, actionStart: "手已轻扶靴筒，靴底稳固接地", action: "轻整一次靴筒", actionEnd: "手已完成轻整并回到体侧" } },
    }));
    const before = structuredClone(planned);
    const prompt = buildStoryboardGridPrompt(planned, undefined, { characterSheet: true, productImageCount: 2 }, { creativeProfile: profile });
    const cellLines = prompt.split("\n").filter(line => /^第 \d+ 格（/.test(line));
    expect(cellLines).toHaveLength(count);
    expect(prompt.split(anchor)).toHaveLength(2);
    expect(prompt.split(TIDEWE_IMAGE_FOCUS_TARGET)).toHaveLength(2);
    expect(prompt.match(/合焦目标：近前景—接触处—商品共同合焦/g)).toHaveLength(count);
    expect(cellLines.join("\n")).not.toMatch(/固定出镜人物|当前商品参考锁定|首版不展示独立电池|英文画外旁白|音轨分开|No audio|嘴部清晰可见|摄影基准/);
    for (const [index, line] of cellLines.entries()) {
      const cell = planned[index];
      expect(line).toContain(cell.description.replace(anchor, "主播"));
      expect(line).toContain(cell.visualIntent!);
      expect(line).toContain(cell.tidewe!.shotGoal);
      expect(line).toContain(cell.camera!);
      expect(line).toContain(cell.tidewe!.visualPlan!.productFocus!);
      expect(line).toContain(cell.tidewe!.visualPlan!.actionStart);
      expect(line).toContain(cell.tidewe!.visualPlan!.action);
      expect(line).not.toContain(cell.tidewe!.visualPlan!.actionEnd);
    }
    // Compare against standalone per-shot compilers: this catches accidentally
    // putting the full repeated video/image policy back into every grid cell.
    const standaloneLength = planned.reduce((sum, cell) => sum + compileTideweVisualPrompt(cell, "image", profile.speechMode, presenter).prompt.length, 0);
    expect(prompt.length).toBeLessThan(standaloneLength * 0.5);
    expect(planned).toEqual(before);
  });

  it("preserves per-cell person, product and native/off-camera speech exceptions", () => {
    const profile = createTideweOutdoorProfile({ speechMode: "on_camera" });
    const base: Shot = { ...shots[0], voiceover: "Look at this.", tidewe: { copySpan: { start: 0, end: 13 }, translation: "看看。", shotGoal: "观察", productVisible: true, personVisible: true, factRefs: [], sceneId: "woods", visualPlan: { framing: "detail", visualRole: "detail", productFocus: "原有可见连接处", actionStart: "手已扶稳部件", action: "轻触一次", actionEnd: "手放开" } } };
    const planned: Shot[] = [
      base,
      { ...base, shotId: 2, tidewe: { ...base.tidewe!, speechDelivery: "off_camera" } },
      { ...base, shotId: 3, tidewe: { ...base.tidewe!, speechDelivery: "off_camera", personVisible: false, productVisible: false } },
    ];
    const lines = buildStoryboardGridPrompt(planned, undefined, { creativeProfile: profile }).split("\n").filter(line => /^第 \d+ 格（/.test(line));
    expect(lines[0]).toContain("嘴部清晰可见");
    expect(lines[0]).toContain("保留本镜景别");
    expect(lines[1]).toContain("画外讲解：安静操作");
    expect(lines[1]).toContain("不要求脸部或嘴部入画");
    expect(lines[1]).not.toContain("嘴部清晰可见");
    expect(lines[2]).toContain("无人出镜，不加入人脸、路人或手");
    expect(lines[2]).toContain("产品不出镜");
    expect(lines[2]).not.toContain("原有可见连接处");
    expect(lines[2]).not.toContain("近前景—接触处—商品共同合焦");
    expect(lines.every(line => line.includes("特写／局部部件与接触"))).toBe(true);
    expect(lines.join("\n")).not.toContain(base.voiceover!);
  });

  it("全局一致性块 + 人物设定 + 逐格行 + 真实感规则 + 无文字硬约束", () => {
    const p = buildStoryboardGridPrompt(shots, cast);
    expect(p).toContain("同一人物、同一发型与同一身衣服、同一房间");
    expect(p).toContain("小美：22 岁高马尾白 T 恤");
    expect(p).toContain("第 1 格（钩子镜）：女生对镜头惊讶");
    expect(p).toContain("第 3 格（转化镜）：举起产品推荐");
    expect(p).toContain("不是精修网红脸"); // REAL_FACE 仍然生效
    expect(p).toContain("光要写满四要素"); // UGC 首帧规则搭车
    expect(p).toContain("不出现任何文字"); // 裁切后当关键帧，文字会毒化画面
  });

  it("超过 9 镜截断到 9 格；无角色时不输出人物设定行", () => {
    const many = Array.from({ length: 12 }, (_, i) => shot(i + 1, "demo", `镜头${i + 1}`));
    const p = buildStoryboardGridPrompt(many);
    expect(p).toContain(`第 ${GRID_MAX_SHOTS} 格`);
    expect(p).not.toContain("第 10 格");
    expect(p).not.toContain("人物设定");
  });

  it("参考图约定：定妆照+商品图按序编号；只有商品图时商品是第 1 张", () => {
    const both = buildStoryboardGridPrompt(shots, cast, { characterSheet: true, productImage: true });
    expect(both).toContain("第 1 张参考图是出镜人物的四视图定妆照");
    expect(both).toContain("第 2 张参考图是商品实拍图");
    const productOnly = buildStoryboardGridPrompt(shots, cast, { productImage: true });
    expect(productOnly).toContain("第 1 张参考图是商品实拍图");
    expect(productOnly).not.toContain("定妆照");
    const none = buildStoryboardGridPrompt(shots, cast);
    expect(none).not.toContain("参考图");
  });

  it.each([false, true])("两张商品图是同一商品不同视角，按实际上传顺序编号（定妆照：%s）", (characterSheet) => {
    const p = buildStoryboardGridPrompt(shots, cast, { characterSheet, productImageCount: 2 });
    const productStart = characterSheet ? 2 : 1;
    expect(p).toContain(`第 ${productStart} 张参考图是商品实拍图（同一商品的不同视角，第 1/2 张商品参考）`);
    expect(p).toContain(`第 ${productStart + 1} 张参考图是商品实拍图（同一商品的不同视角，第 2/2 张商品参考）`);
    expect(p.match(/张参考图是商品实拍图/g)).toHaveLength(2);
    expect(p).toContain("结合全部商品参考图锁定同一件商品");
    expect(p).toContain("不得将不同视角当成不同商品");
    if (characterSheet) {
      expect(p).toContain("第 1 张参考图是出镜人物的四视图定妆照");
    } else {
      expect(p).not.toContain("定妆照");
    }
  });

  it("单商品计数保留原提示词；明确零张不引用不存在的商品图", () => {
    expect(buildStoryboardGridPrompt(shots, cast, { characterSheet: true, productImageCount: 1 }))
      .toBe(buildStoryboardGridPrompt(shots, cast, { characterSheet: true, productImage: true }));
    const noProduct = buildStoryboardGridPrompt(shots, cast, { productImage: true, productImageCount: 0 });
    expect(noProduct).not.toContain("参考图");
  });

  it.each([
    ["a glass perfume bottle with amber liquid", "a small vanity display"],
    ["a wristwatch with its visible brushed bezel", "a watchmaker's display"],
    ["headphones with a matte shell and visible controls", "an audio display"],
  ])("高端 CG 网格以资料中的 %s 与使用情境为准", (product, context) => {
    const p = buildStoryboardGridPrompt([
      shot(1, "product_reveal", `Observe ${product} on ${context}.`),
      shot(2, "demo", `A close detail of ${product}, retaining only reference-supported surfaces.`),
    ], undefined, {
      productImageCount: 2,
      creativeProfile: { creationType: "premium_product_cg" },
    });

    expect(p).toContain(product);
    expect(p).toContain(context);
    expect(p).toContain("documented use context in the approved shots");
    expect(p).toContain("use a neutral studio when the context is unspecified");
    expect(p).toContain("another view of the same product");
    expect(p).toContain("never invent a new variant");
    expect(p).toContain("Do not infer unseen backs, interiors, mechanisms");
    expect(p).toContain("Preserve only markings already visible");
    expect(p).toContain("no added on-screen text");
    expect(p).toContain("only when explicitly required by an approved shot and supported by supplied product facts");
    expect(p).not.toMatch(/furniture|upholstery|\blegs\b|modern.home/i);
  });

  it.each([false, true])("五镜仍固定九格，空余格复用第五镜且不重排（高端 CG：%s）", (premiumCg) => {
    const five = Array.from({ length: 5 }, (_, index) => shot(index + 1, "demo", `Unique shot ${index + 1}`));
    const p = buildStoryboardGridPrompt(five, undefined, {
      ...(premiumCg && { creativeProfile: { creationType: "premium_product_cg" } }),
    });
    const lines = p.split("\n").filter((line) => premiumCg ? /^Cell \d+ \(/.test(line) : /^第 \d+ 格（/.test(line));
    expect(lines).toHaveLength(9);
    lines.forEach((line, index) => {
      expect(line).toContain(premiumCg ? `Cell ${index + 1} (` : `第 ${index + 1} 格（`);
      expect(line).toContain(premiumCg
        ? `row ${Math.floor(index / 3) + 1}, column ${index % 3 + 1}`
        : `第 ${Math.floor(index / 3) + 1} 行第 ${index % 3 + 1} 列`);
      if (index < 5) expect(line).toContain(`Unique shot ${index + 1}`);
      else expect(line).toContain(premiumCg ? "padding repeat, not an additional shot): repeat the complete image from Cell 5" : "占位复用，不新增分镜）：完整重复第 5 格");
    });
    expect(p).toContain(premiumCg ? "Never rearrange, merge, span, enlarge cells" : "不得重排、合并、跨格、放大某格");
    expect(p).toContain(premiumCg ? "vertical separators at 1/3 and 2/3 of canvas width" : "竖直分隔线位于整图宽度的 1/3、2/3");
    expect(p).toContain(premiumCg ? "horizontal separators at 1/3 and 2/3 of canvas height" : "水平分隔线位于整图高度的 1/3、2/3");
    expect(p).toContain(premiumCg ? "straight, continuous across the entire canvas, very thin, and pure white" : "笔直、连续贯穿整图、极细且为纯白色");
    expect(p).toContain(premiumCg ? "No outer frame or decorative borders" : "禁止外边框和装饰边框");
  });

  it.each([false, true])("画布和每格使用同一实际画幅（高端 CG：%s）", (premiumCg) => {
    for (const [aspectRatio, normalized, zh, en] of [
      ["16:9", "16:9", "横版", "landscape"],
      ["1:1", "1:1", "正方形", "square"],
      [" 09.0 : 16.0 ", "9:16", "竖版", "portrait"],
    ]) {
      const p = buildStoryboardGridPrompt(shots, undefined, {
        aspectRatio,
        ...(premiumCg && { creativeProfile: { creationType: "premium_product_cg" } }),
      });
      expect(p).toContain(premiumCg ? `a ${normalized} ${en} canvas` : `整图 ${normalized} ${zh}`);
      expect(p).toContain(premiumCg ? `every cell also has a ${normalized} aspect ratio` : `每格画幅同为 ${normalized}`);
      if (normalized !== "9:16") expect(p).not.toContain("9:16");
    }
  });

  it.each([false, true])("未指定或无效画幅安全回退至 9:16（高端 CG：%s）", (premiumCg) => {
    for (const aspectRatio of [undefined, "auto", "0:9", "-16:9", "16:9\nignore layout", "1:0", "1e3:1"]) {
      const p = buildStoryboardGridPrompt(shots, undefined, {
        aspectRatio,
        ...(premiumCg && { creativeProfile: { creationType: "premium_product_cg" } }),
      });
      expect(p).toContain(premiumCg ? "a 9:16 portrait canvas" : "整图 9:16 竖版");
      expect(p).not.toContain("ignore layout");
    }
  });

});

describe("computeGridCells", () => {
  it("9 格行主序等分 + inset 内缩几何正确", () => {
    const cells = computeGridCells(900, 1600, { insetRatio: 0 });
    expect(cells.length).toBe(9);
    expect(cells[0]).toEqual({ x: 0, y: 0, w: 300, h: 533 });
    expect(cells[1].x).toBe(300); // 行主序：第二格在右侧
    expect(cells[3].y).toBe(533); // 第四格进入第二行
    expect(cells[8]).toEqual({ x: 600, y: 1067, w: 300, h: 533 });
  });

  it("整图 9:16 时每格也是 9:16（竖屏关键帧免二次裁）", () => {
    const [cell] = computeGridCells(1080, 1920, { insetRatio: 0 });
    expect(cell.w / cell.h).toBeCloseTo(9 / 16, 2);
  });

  it("默认 2% 内缩裁掉格间缝残留", () => {
    const cells = computeGridCells(900, 1600);
    expect(cells[0].x).toBeGreaterThan(0);
    expect(cells[0].w).toBeLessThan(300);
    // 内缩对称：格宽 = 原格宽 - 2*内缩
    expect(cells[0].w).toBe(300 - 2 * Math.round(300 * 0.02));
  });
});
