import { describe, it, expect } from "vitest";
import { buildCharacterSheetPrompt } from "@/lib/character-sheet";

/**
 * Multi-view sheet prompt contract (v0.8.85): one 2x2 generation = one identical
 * person from four angles. The sheet then anchors identity in the grid/film passes.
 */

describe("多视图定妆 prompt", () => {
  it("中文外观：四视图布局 + 同人硬约束 + 无文字 + 真实人脸约束", () => {
    const p = buildCharacterSheetPrompt("32 岁居家女性，松散低马尾，浅色家居服", "小柔");
    expect(p).toContain("2x2 等分四视图");
    expect(p).toContain("（小柔）");
    expect(p).toContain("左上=正面全身");
    expect(p).toContain("右下=正面肩部以上特写");
    expect(p).toContain("完全是同一个人");
    expect(p).toContain("不出现任何文字");
    expect(p).toContain("清爽耐看的普通人长相"); // REAL_FACE_CONSTRAINT.zh rides along
  });

  it("英文外观整体切英文，且不混入中文", () => {
    const p = buildCharacterSheetPrompt("woman in her 30s, loose low ponytail, light loungewear");
    expect(p).toContain("2x2 four-view character reference sheet");
    expect(p).toContain("front shoulders-up close-up");
    expect(p).toContain("exactly identical in all four cells");
    expect(p).not.toMatch(/[一-鿿]/);
  });

  it("多张人物图联合锁定身份，文字只补充且不套用新脸审美要求", () => {
    const p = buildCharacterSheetPrompt("年轻女性，红色衬衫", "小美", 3);
    expect(p).toContain("全部 3 张人物参考图都属于同一个人");
    expect(p).toContain("联合所有参考图的不同角度");
    expect(p).toContain("不能只使用第一张");
    expect(p).toContain("保留本人五官");
    expect(p).toContain("发型发色、身形和服装");
    expect(p).toContain("参考图身份优先于文字");
    expect(p).toContain("人物补充描述（小美）");
    expect(p).toContain("左上=正面全身");
    expect(p).not.toContain("清爽耐看的普通人长相");
    expect(p).not.toContain("头身比约 1:7");
  });

  it("英文参考图提示保持原身份优先，不用普通人脸替换参考人物", () => {
    const p = buildCharacterSheetPrompt("a woman wearing a red shirt", "Mei", 2);
    expect(p).toContain("All 2 input reference images show the SAME person");
    expect(p).toContain("Jointly study every reference");
    expect(p).toContain("Reference identity takes priority over text");
    expect(p).toContain("hairstyle and hair color, build, clothing");
    expect(p).toContain("2x2 four-view");
    expect(p).not.toContain("pleasant, ordinary-looking");
    expect(p).not.toMatch(/[一-鿿]/);
  });

  it("仅有人物参考图也可以生成四视图，不插入空的外观设定", () => {
    const p = buildCharacterSheetPrompt("", "Mei", 1);
    expect(p).toContain("All 1 input reference images");
    expect(p).toContain("front shoulders-up close-up");
    expect(p).not.toContain("Supplementary character description");
    expect(p).not.toContain("ordinary-looking");
  });
});
