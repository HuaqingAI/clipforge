import { describe, it, expect } from "vitest";
import {
  buildJudgePrompt,
  buildTideweJudgePrompt,
  buildJudgeTimingContext,
  parseJudgeResponse,
  autoApplicableRewrites,
  autoApplicableDescriptionRewrites,
  factTokens,
  preservesFactTokens,
  JUDGE_IDS,
} from "@/lib/script-judge";
import type { TideweCopyDocument } from "@/lib/tidewe/types";

const SHOTS = [
  { shotId: 1, voiceover: "这款纸巾我回购了十次，真的谁用谁知道", description: "女生举着纸巾对镜头说话" },
  { shotId: 2, voiceover: "它的克重是同价位的两倍，一张顶别人三张", description: "展示产品的高品质" },
  { shotId: 3, voiceover: "现在点下方链接就能买到" },
];

describe("buildJudgePrompt（判官团二期）", () => {
  it("五判官各就位 + 口语铁律注入 + 长度约束 + 合规红线 + 证据规则 + 分级判据", () => {
    const p = buildJudgePrompt(SHOTS, { styleLabel: "达人口播" });
    expect(p).toContain("节奏官");
    expect(p).toContain("口语官");
    expect(p).toContain("创意官");
    expect(p).toContain("结构官");
    expect(p).toContain("画面官");
    expect(p).toContain("说出来的"); // SPOKEN_VOICE_RULES 是口语官判准
    expect(p).toContain("±20%"); // TTS 时长钉在分镜槽
    expect(p).toContain("不新增任何功效/价格承诺"); // 广告合规红线
    expect(p).toContain("没有引文的挑刺视为无效"); // 证据式
    expect(p).toContain("invariant"); // 三级分级
    expect(p).toContain("信息密度均匀"); // 结构官全局检查
    expect(p).toContain("不成立的钩子替代品"); // 负例清单
    expect(p).toContain("功能句不是画面"); // 画面官判准
    expect(p).toContain("台词「这款纸巾我回购了十次"); // 有画面的镜头双栏展示
    expect(p).toContain("画面「女生举着纸巾对镜头说话」");
    expect(p).toContain("shotId 3：「现在点下方链接就能买到」"); // 无画面的镜头保持单栏
    expect(p).not.toContain("in English");
  });

  it("风格专项判准按 styleType 注入：reversal 公式 / drama 行动动词 / interview 交换测试", () => {
    expect(buildJudgePrompt(SHOTS, { styleType: "reversal" })).toContain("一句话公式");
    expect(buildJudgePrompt(SHOTS, { styleType: "drama" })).toContain("行动动词");
    expect(buildJudgePrompt(SHOTS, { styleType: "drama" })).toContain("交换说话者测试");
    expect(buildJudgePrompt(SHOTS, { styleType: "interview" })).toContain("交换说话者测试");
    expect(buildJudgePrompt(SHOTS, { styleType: "pain_point" })).not.toContain("交换说话者测试");
  });

  it("全英文台词 → 附加英文输出指令", () => {
    const p = buildJudgePrompt([{ shotId: 1, voiceover: "I bought this ten times." }]);
    expect(p).toContain("in English");
  });
});

describe("judge timing context", () => {
  const timedShots = [
    { shotId: 1, voiceover: "", duration: 2.5, description: "清晨林间的湿草" },
    { shotId: 2, voiceover: "I would check the fit first.", duration: 5.2 },
    { shotId: 3, voiceover: "", duration: 1.3, description: "靴子放在车旁" },
  ];

  it("includes silent footage when locating narration and comparing the full storyboard with its target", () => {
    expect(buildJudgeTimingContext(timedShots, { plannedTotalDuration: 30 })).toEqual({
      unit: "seconds", actualTotalDuration: 9, plannedTotalDuration: 30,
      shots: [
        { shotId: 1, start: 0, end: 2.5, duration: 2.5, hasNarration: false },
        { shotId: 2, start: 2.5, end: 7.7, duration: 5.2, hasNarration: true },
        { shotId: 3, start: 7.7, end: 9, duration: 1.3, hasNarration: false },
      ],
    });
  });

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])("keeps missing or invalid seconds (%s) unknown without inventing downstream timing", duration => {
    const context = buildJudgeTimingContext([
      { shotId: 1, voiceover: "Hello", duration: 3 },
      { shotId: 2, voiceover: "Unknown", duration },
      { shotId: 3, voiceover: "Later", duration: 5 },
    ]);
    expect(context.actualTotalDuration).toBeNull();
    expect(context.plannedTotalDuration).toBeNull();
    expect(context.shots[1]).toMatchObject({ start: 3, end: null, duration: null });
    expect(context.shots[2]).toMatchObject({ start: null, end: null, duration: 5 });
  });

  it("adds the same seconds and language-aware estimation limits to both review paths without enabling TIDEWE rewrites", () => {
    const copy: TideweCopyDocument = {
      version: 1, language: "en-US", text: timedShots[1].voiceover, translation: "我会先检查合脚程度。",
      angle: "choice", hookType: "question", claimedFactIds: [],
      factsSnapshot: { version: 1, brand: "TIDEWE", category: "waterproof_boots", items: [] },
      factsHash: "test", corpusVersion: "test", compilerVersion: "test", exampleIds: [], wordCount: 6, estimatedDuration: 3,
    };
    const reviewShots = timedShots.filter((shot) => shot.voiceover);
    const prompts = [
      buildJudgePrompt(reviewShots, { plannedTotalDuration: 30, timelineShots: timedShots }),
      buildTideweJudgePrompt(copy, reviewShots, { plannedTotalDuration: 30, timelineShots: timedShots }),
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain('"actualTotalDuration":9,"plannedTotalDuration":30');
      expect(prompt).toContain('"shotId":2,"start":2.5,"end":7.7,"duration":5.2');
      expect(prompt).toContain("英语约 2–3 词/秒，中文约 3–5 字/秒");
      expect(prompt).toContain("不是实测音频或成片时长");
      expect(prompt).toContain("null 表示未知");
      expect(prompt).not.toContain("清晨林间的湿草");
      expect(prompt).not.toContain("靴子放在车旁");
    }
    expect(prompts[1]).toContain("Return feedback only; do not rewrite or translate it.");
    expect(prompts[1]).toContain("Do not demand dual CTAs, a mid-video suspense hook");
  });
});

describe("parseJudgeResponse（二期：五判官/tier钳制/事实token校验/画面重写）", () => {
  it("正常解析：钳制 judge 枚举、补齐缺席判官、rewrite 只收真实分镜、tier 非法值钳为 taste", () => {
    const content = JSON.stringify({
      verdicts: [
        { judge: "pace", issues: [{ shotId: 1, issue: "第一句钩不住", tier: "invariant" }, { shotId: 99, issue: "幽灵镜头" }] },
        { judge: "hallucinated", issues: [{ issue: "不存在的判官" }] },
      ],
      rewrites: [
        { shotId: 3, voiceover: "反正链接我放下面了，你们自己看", tier: "default" },
        { shotId: 99, voiceover: "幽灵重写" },
        { shotId: 3, voiceover: "重复的 shotId 应被去重", tier: "default" },
      ],
      summary: "整体广告腔偏重",
    });
    const r = parseJudgeResponse(content, SHOTS);
    expect(r.verdicts.map((v) => v.judge)).toEqual([...JUDGE_IDS]); // 五判官始终齐全
    const pace = r.verdicts.find((v) => v.judge === "pace")!;
    expect(pace.issues.length).toBe(2);
    expect(pace.issues[0]).toEqual({ shotId: 1, issue: "第一句钩不住", tier: "invariant" });
    expect(pace.issues[1].shotId).toBeUndefined(); // 幽灵 shotId 被剥掉但意见保留
    expect(pace.issues[1].tier).toBe("taste"); // 缺失/非法 tier 钳为 taste（宁展示不自动改）
    expect(r.verdicts.find((v) => v.judge === "voice")!.issues).toEqual([]);
    expect(r.rewrites).toEqual([{ shotId: 3, voiceover: "反正链接我放下面了，你们自己看", tier: "default" }]);
    expect(r.summary).toBe("整体广告腔偏重");
  });

  it("长度比钳制：重写超出 0.4x–2.5x 丢弃（保 TTS 时长与防内容失真）", () => {
    const content = JSON.stringify({
      verdicts: [],
      rewrites: [
        { shotId: 1, voiceover: "短", tier: "default" }, // 远短于原句 → 丢
        { shotId: 2, voiceover: "它" + "特别好用".repeat(30), tier: "default" }, // 远超原句 → 丢
      ],
    });
    expect(parseJudgeResponse(content, SHOTS).rewrites).toEqual([]);
  });

  it("事实 token 校验：重写丢数字即弃用；边界防误配（3 不匹配 13）", () => {
    const shots = [{ shotId: 1, voiceover: "只要9.9元，一提12卷到手" }];
    const keep = JSON.stringify({ verdicts: [], rewrites: [{ shotId: 1, voiceover: "9.9元能拿下12卷，说真的", tier: "default" }] });
    expect(parseJudgeResponse(keep, shots).rewrites.length).toBe(1);
    const lost = JSON.stringify({ verdicts: [], rewrites: [{ shotId: 1, voiceover: "九块九能拿下十二卷，说真的", tier: "default" }] });
    expect(parseJudgeResponse(lost, shots).rewrites).toEqual([]); // 数字被改写成汉字 → 保守弃用
    expect(preservesFactTokens("3秒出效果", "13秒出效果")).toBe(false); // 边界守卫：3 ≠ 13 里的 3
    expect(factTokens("9.9元 12卷 9.9折")).toEqual(["9.9", "12"]);
  });

  it("画面重写：只收有 description 的镜头，长度钳制同样生效", () => {
    const content = JSON.stringify({
      verdicts: [],
      rewrites: [],
      descriptionRewrites: [
        { shotId: 2, description: "女生把两张纸巾叠着提起一壶水，纸巾不破", tier: "invariant" },
        { shotId: 3, description: "无 description 的镜头不收" },
        { shotId: 2, description: "重复去重" },
      ],
    });
    const r = parseJudgeResponse(content, SHOTS);
    expect(r.descriptionRewrites).toEqual([
      { shotId: 2, description: "女生把两张纸巾叠着提起一壶水，纸巾不破", tier: "invariant" },
    ]);
  });

  it("markdown 包裹的 JSON 可解析；彻底非法 JSON 抛可读错误", () => {
    const wrapped = "```json\n" + JSON.stringify({ verdicts: [], rewrites: [] }) + "\n```";
    expect(parseJudgeResponse(wrapped, SHOTS).verdicts.length).toBe(5);
    expect(() => parseJudgeResponse("这不是 JSON", SHOTS)).toThrow("判官团返回的不是合法 JSON");
  });
});

describe("autoApplicableRewrites（采纳分级：全托管链只自动吃 invariant/default）", () => {
  it("taste 级被过滤，invariant/default 保留（台词与画面重写同规）", () => {
    const report = parseJudgeResponse(
      JSON.stringify({
        verdicts: [],
        rewrites: [
          { shotId: 1, voiceover: "这款纸巾我真回购了十次，谁用谁知道啊", tier: "default" },
          { shotId: 3, voiceover: "链接放下面了，要的自己拿", tier: "taste" },
        ],
        descriptionRewrites: [
          { shotId: 2, description: "女生当场把纸巾泡进水里再拎起来，完好不破", tier: "taste" },
        ],
      }),
      SHOTS
    );
    expect(autoApplicableRewrites(report).map((r) => r.shotId)).toEqual([1]);
    expect(autoApplicableDescriptionRewrites(report)).toEqual([]);
    // taste 级仍在报告里（UI 展示）
    expect(report.rewrites.length).toBe(2);
    expect(report.descriptionRewrites.length).toBe(1);
  });
});
