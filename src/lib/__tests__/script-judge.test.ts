import { describe, it, expect } from "vitest";
import {
  buildJudgePrompt,
  buildTideweJudgePrompt,
  buildJudgeTimingContext,
  withTideweJudgeProductContext,
  withTideweProductCoverageIssues,
  parseJudgeResponse,
  autoApplicableRewrites,
  autoApplicableDescriptionRewrites,
  factTokens,
  preservesFactTokens,
  JUDGE_IDS,
  type JudgeShotInput,
} from "@/lib/script-judge";
import type { TideweCopyDocument } from "@/lib/tidewe/types";
import { getTideweProductCoverageIssues } from "@/lib/tidewe/planning-quality";

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
      expect(prompt).toContain("不是实测音频或成片时长");
      expect(prompt).toContain("null 表示未知");
      expect(prompt).not.toContain("清晨林间的湿草");
      expect(prompt).not.toContain("靴子放在车旁");
    }
    expect(prompts[0]).toContain("英语约 2–3 词/秒，中文约 3–5 字/秒");
    expect(prompts[0]).not.toContain("TIDEWE 美式英语口播以 2.3");
    expect(prompts[1]).toContain("TIDEWE 美式英语口播以 2.3 词/秒为目标，2.6 词/秒为上限");
    expect(prompts[1]).toContain("英文词数 / 2.6 + 0.3 秒");
    expect(prompts[1]).toContain("英文词数 / 2.3 + 0.3 秒");
    expect(prompts[1]).toContain("Return feedback only; do not rewrite or translate it.");
    expect(prompts[1]).toContain("Do not demand dual CTAs, a mid-video suspense hook");
  });
});

describe("TIDEWE visual review", () => {
  const copy: TideweCopyDocument = {
    version: 1, language: "en-US", text: "I'd check the fit first. Then look at the seam.", translation: "我会先检查合身程度，再看接缝。",
    angle: "choice", hookType: "question", claimedFactIds: [],
    factsSnapshot: { version: 1, brand: "TIDEWE", category: "hunting_apparel", items: [] },
    factsHash: "test", corpusVersion: "test", compilerVersion: "test", exampleIds: [], wordCount: 10, estimatedDuration: 5,
  };
  const shots: JudgeShotInput[] = [
    { shotId: 1, voiceover: "", duration: 2, description: "阴天林边的小径，近处湿叶和树干层次可辨。", camera: "平视环境全景",
      tidewe: { personVisible: false, productVisible: false, visualPlan: { framing: "wide", visualRole: "context", actionStart: "小径与落叶保持原位", action: "静态观察林边环境", actionEnd: "视角自然稳定" } } },
    { shotId: 2, voiceover: "I'd check the fit first.", duration: 3, description: "主播面向拍摄同伴自然说明选购问题。", camera: "腰上中景",
      tidewe: { personVisible: true, productVisible: true, speechDelivery: "on_camera", visualPlan: { framing: "medium", visualRole: "presenter", actionStart: "主播已站稳，双手自然放松", action: "朝拍摄同伴作一次小幅手势", actionEnd: "手放下并自然站稳" } } },
    { shotId: 3, voiceover: "Then look at the seam.", duration: 3, description: "主播的手指已经接触衣袖接缝，沿接缝轻划一次。", camera: "斜俯拍衣袖与手指细节",
      tidewe: { personVisible: true, productVisible: true, speechDelivery: "off_camera", visualPlan: { framing: "detail", visualRole: "detail", actionStart: "手指接触现有衣袖接缝", action: "沿可见接缝轻划一次", actionEnd: "手指在接缝旁自然停住" } } },
  ];

  it("reviews silent context and delivery-specific visual plans alongside the full narration", () => {
    const prompt = buildTideweJudgePrompt(copy, shots, { speechMode: "on_camera", timelineShots: shots });
    const reviewed = JSON.parse(prompt.split("SHOTS: ")[1].split("\n")[0]);
    expect(reviewed).toEqual(shots);
    expect(reviewed[0]).toMatchObject({ voiceover: "", camera: "平视环境全景", tidewe: { visualPlan: { visualRole: "context", action: "静态观察林边环境" } } });
    expect(reviewed[2].tidewe).toMatchObject({ personVisible: true, speechDelivery: "off_camera", visualPlan: { framing: "detail", actionStart: "手指接触现有衣袖接缝", actionEnd: "手指在接缝旁自然停住" } });
    expect(prompt).toContain("SPEECH_MODE: on_camera");
    expect(prompt).toContain("Static context and a maintained product observation are valid");
    expect(prompt).toContain("Do not demand a separate demonstration for every sentence");
    expect(prompt).toContain("only speechDelivery=on_camera requires a visible unobstructed speaking mouth");
    expect(prompt).toContain("personVisible=true may mean only hands, sleeves or boots");
    const report = parseJudgeResponse(JSON.stringify({ verdicts: [{ judge: "visual", issues: [{ shotId: 1, issue: "「湿叶」——可核对现有环境连续性", tier: "taste" }] }] }), shots);
    expect(report.verdicts.find(verdict => verdict.judge === "visual")?.issues[0].shotId).toBe(1);
  });

  it("checks actual evidence and repetition while keeping post narration and historical plans valid", () => {
    const prompt = buildTideweJudgePrompt(copy, shots, { speechMode: "voiceover" });
    expect(prompt).toContain("SPEECH_MODE: voiceover");
    expect(prompt).toContain("voiceover means post-production narration with no visible speaking requirement");
    expect(prompt).toContain("Neither a touch nor a press proves heat, waterproofing, durability or long-term comfort");
    expect(prompt).toContain("repeated actions with no new evidence");
    expect(prompt).toContain("Judge duplication from actual framing, action and purpose, not enum values alone");
    expect(prompt).toContain("Missing visualPlan on a historical shot is not itself a defect");
    expect(prompt).toContain("actionEnd is a credible supported stable state");
  });

  it("preserves staff prose and offers feedback without executable narration or picture rewrites", () => {
    const original = "“I've used this for 3 seasons.”\r\nWait.  Wait. Buy now if it fits.";
    const prompt = buildTideweJudgePrompt({ ...copy, source: "user_provided", text: original }, shots);
    expect(JSON.parse(prompt.split("FINAL_COPY: ")[1].split("\n")[0])).toBe(original);
    expect(prompt).toContain("COPY_SOURCE: user_provided");
    expect(prompt).toContain("Preserve its exact prose, punctuation, repetition, experiences and existing offer");
    expect(prompt).toContain("without declaring a personal experience invented merely because it is absent");
    expect(prompt).toContain('"rewrites":[],"descriptionRewrites":[]');
    expect(prompt).not.toContain("defects in AI-written copy");
  });

  it("keeps visible boot evidence separate from performance claims and retains the actual beat/shot mapping", () => {
    const bootCopy: TideweCopyDocument = {
      ...copy, productName: "TIDEWE snake boots", visualObservations: "参考图可见高筒、迷彩、扣带与外底沟槽。",
      factsSnapshot: { ...copy.factsSnapshot, category: "boots" },
      text: "Look at the shaft.",
      visualBeats: [{ text: "Look at the shaft.", visualRole: "detail", visualIdea: "观察参考图中的迷彩靴筒", factRefs: [] }],
    };
    const bootShot: JudgeShotInput = {
      shotId: 8, voiceover: bootCopy.text, description: "手指接触迷彩靴筒，靴筒与裤脚完整入画。", camera: "低机位靴筒近景",
      tidewe: {
        productVisible: true, personVisible: true, speechDelivery: "off_camera", copySpan: { start: 0, end: bootCopy.text.length }, factRefs: [], shotGoal: "看清靴筒与裤脚接触关系",
        visualPlan: { framing: "close_up", visualRole: "detail", productFocus: "迷彩靴筒与裤脚", actionStart: "手指已接触靴筒", action: "沿可见靴筒轻划一次", actionEnd: "手指停稳" },
      },
    };
    const prompt = buildTideweJudgePrompt(bootCopy, [bootShot], { videoMode: "product_closeup" });
    const reviewed = JSON.parse(prompt.split("SHOTS: ")[1].split("\n")[0]);
    expect(reviewed[0].tidewe).toMatchObject({ copySpan: bootShot.tidewe!.copySpan, factRefs: [], shotGoal: bootShot.tidewe!.shotGoal, visualPlan: { productFocus: "迷彩靴筒与裤脚" } });
    expect(JSON.parse(prompt.split("COPY_VISUAL_BEATS: ")[1].split("\n")[0])).toEqual(bootCopy.visualBeats);
    expect(JSON.parse(prompt.split("CURRENT_VISUAL_OBSERVATIONS: ")[1].split("\n")[0])).toBe(bootCopy.visualObservations);
    expect(prompt).toContain('CURRENT_PRODUCT_NAME: "TIDEWE snake boots"');
    expect(prompt).toContain("VIDEO_MODE: product_closeup");
    expect(prompt).toContain("An empty confirmed fact table does not justify hiding the product");
    expect(prompt).toContain("They cannot establish performance");
    expect(prompt).toContain("through the real copySpan");
    const category = JSON.parse(prompt.split("CATEGORY_GUIDANCE: ")[1].split("\n")[0]);
    expect(category).toMatchObject({ category: "boots", productFocusExample: expect.stringContaining("实际靴筒") });
    expect(category.evidenceLimits).toContain("普通踩踏和外底沟纹不证明防蛇咬");
    expect(prompt).toContain("Off-camera narration may cover these close views");
    expect(JSON.parse(prompt.split("DETERMINISTIC_PRODUCT_COVERAGE_ISSUES: ")[1].split("\n")[0])).toEqual([]);
  });

  it.each([
    { category: "hunting_blind" as const, name: "狩猎帐篷", canonical: "hunting_blind", detail: "帐篷入口" },
    { category: "waders" as const, name: "涉水服", canonical: "waders", detail: "背带连接" },
    { category: "heated_gear" as const, name: "加热背心", canonical: "heated_gear", detail: "当前加热装备" },
    { category: "hunting_apparel" as const, name: "户外服装", canonical: "apparel", detail: "参考服装" },
    { category: "accessories" as const, name: "狩猎椅", canonical: "accessories", detail: "参考椅子" },
  ])("reviews $canonical using its saved category without injecting boot framing", ({ category, name, canonical, detail }) => {
    const saved: TideweCopyDocument = { ...copy, productName: name, factsSnapshot: { ...copy.factsSnapshot, category } };
    const before = structuredClone(saved);
    const prompt = buildTideweJudgePrompt(withTideweJudgeProductContext(saved, { productName: "当前项目已换为靴子" }), shots);
    const guidance = JSON.parse(prompt.split("CATEGORY_GUIDANCE: ")[1].split("\n")[0]);
    expect(guidance).toMatchObject({ category: canonical, productFocusExample: expect.stringContaining(detail) });
    expect(prompt).not.toContain("For boots, a shaft");
    expect(prompt).not.toContain("靴筒");
    expect(saved).toEqual(before);
  });

  it("reviews all five photographic defects and states the product minimums without changing generic review", () => {
    const prompt = buildTideweJudgePrompt(copy, shots, { videoMode: "scene_demo" });
    expect(prompt).toContain("a product video cannot have zero product-visible shots");
    expect(prompt).toContain("at least ceil(shotCount / 2) must visibly contain the current product");
    expect(prompt).toContain("at least one must give a close_up or detail view");
    expect(prompt).toContain("reference-supported handling, wearing or ordinary-use shot");
    expect(prompt).toContain("share light direction, color temperature, perspective, occlusion and contact shadows");
    expect(prompt).toContain("full-body and medium views use ordinary phone main-camera deep focus");
    expect(prompt).toContain("nearby ground and midground stay naturally clear");
    expect(prompt).toContain("Where already present, midground and farther tree trunks, branches, path layers and scene silhouettes remain recognizable");
    expect(prompt).toContain("at most slight optical softness in the distance");
    expect(prompt).toContain("Flag broad creamy blur, bokeh disks, portrait-mode masks or an abrupt blur boundary");
    expect(prompt).not.toMatch(/moderate natural depth of field|distant scenery softens gradually with distance/);
    expect(prompt).toContain("accurate neutral daylight white balance");
    expect(prompt).toContain("no sharpening, no HDR processing or oily/painterly texture");
    expect(prompt).toContain("motivated eye contact, practical gestures and real hand/product or foot/ground contact");
    expect(buildJudgePrompt(SHOTS)).not.toContain("Product coverage is a minimum production requirement");
  });

  it("reviews component focus and overcrisp subjects without demanding invented scenery or claiming pixel inspection", () => {
    const prompt = buildTideweJudgePrompt(copy, shots);
    expect(prompt).toContain("ALL visible foreground in front of the subject must remain naturally resolved");
    expect(prompt).toContain("isolated near grass, leaves and edge objects disconnected from the product or support");
    expect(prompt).toContain("Only distant background BEHIND the subject may have slight natural optical softness");
    expect(prompt).toContain("No nearer-object defocus exception applies");
    expect(prompt).toContain("existing surroundings must retain readable structure");
    expect(prompt).toContain("do not demand new scenery to illustrate these examples or every leaf or distance plane equally sharp");
    expect(prompt).toContain("recommend removing selective or global sharpening and local microcontrast processing");
    expect(prompt).toContain("Preserve intentional empty backgrounds; do not demand new scenery");
    expect(prompt).toContain("Preserve presenter identity, actual product markings");
    expect(prompt).toContain("never recommend invented fine texture or hidden structure to create clarity");
    expect(prompt).toContain("against the saved visual directions");
    expect(prompt).toContain("do not claim to have inspected generated pixels");
  });

  it("flags lower-edge foreground blur on continuous support in every scale without changing the approved shot", () => {
    const prompt = buildTideweJudgePrompt(copy, shots);
    expect(prompt).toContain("In every framing scale, including close_up and detail");
    expect(prompt).toContain("where an existing ground, tabletop or other supporting surface already extends continuously from the image's bottom edge through to the subject's contact point, that whole region must stay naturally readable");
    expect(prompt).toContain("Do not recommend adding or extending a supporting surface to satisfy this rule");
    expect(prompt).toContain("The main product, contact area, connected supporting surface and its visible lower frame edge are protected from defocus");
    expect(prompt).toContain("Flag a blurred foreground strip, tilt-shift top-and-bottom blur bands or vignette-like edge defocus");
    expect(prompt).toContain("Do not recommend changing the approved aspect ratio, crop, composition, action or product support to satisfy focus requirements");
    expect(prompt).not.toContain("Close component shots may retain slight physically plausible softness nearer or farther than the focus plane");
  });

  it("retains an all-product-hidden defect even if the model returns empty issues, without changing frozen prose", () => {
    const hidden = shots.map(shot => ({ ...shot, tidewe: { ...shot.tidewe, productVisible: false } }));
    const coverage = getTideweProductCoverageIssues(hidden, { copyDocument: copy, videoMode: "scene_demo", requireEvidence: true });
    const modelReport = parseJudgeResponse('{"verdicts":[],"rewrites":[],"descriptionRewrites":[],"summary":"没有问题"}', hidden);
    const before = JSON.stringify({ copy, hidden, modelReport });
    const report = withTideweProductCoverageIssues(modelReport, coverage);
    expect(report.verdicts.find(verdict => verdict.judge === "visual")!.issues).toContainEqual({ issue: expect.stringContaining("[PRODUCT_NOT_VISIBLE]"), tier: "invariant" });
    expect(report.verdicts.find(verdict => verdict.judge === "visual")!.issues).toContainEqual({ shotId: 3, issue: expect.stringContaining("[PRODUCT_ROLE_WITHOUT_PRODUCT]"), tier: "invariant" });
    expect(report.rewrites).toEqual([]);
    expect(report.descriptionRewrites).toEqual([]);
    expect(JSON.stringify({ copy, hidden, modelReport })).toBe(before);
    expect(withTideweProductCoverageIssues(report, coverage)).toEqual(report);
    const prompt = buildTideweJudgePrompt(copy, hidden, { productCoverageIssues: coverage });
    expect(JSON.parse(prompt.split("DETERMINISTIC_PRODUCT_COVERAGE_ISSUES: ")[1].split("\n")[0])).toEqual(coverage);
  });

  it("uses current appearance for historical copy, prefers saved snapshots and never changes fact evidence or prose", () => {
    const current = { productName: "当前迷彩靴", productAnalysis: "当前参考图可见靴筒与扣带" };
    const before = JSON.stringify(copy);
    const historical = withTideweJudgeProductContext(copy, current);
    expect(historical).toMatchObject({ productName: current.productName, visualObservations: current.productAnalysis, text: copy.text });
    expect(historical.factsSnapshot).toBe(copy.factsSnapshot);
    expect(historical.claimedFactIds).toBe(copy.claimedFactIds);
    expect(JSON.stringify(copy)).toBe(before);
    const saved = { ...copy, productName: "保存的商品", visualObservations: "保存的首帧外观观察" };
    expect(withTideweJudgeProductContext(saved, current)).toEqual(saved);
    expect(withTideweJudgeProductContext({ ...copy, productName: "  ", visualObservations: "" }, current)).toMatchObject({ productName: current.productName, visualObservations: current.productAnalysis });
    const prompt = buildTideweJudgePrompt(historical, shots);
    expect(prompt).toContain("the current project used only when a historical snapshot is missing");
    expect(prompt).toContain("it does not add confirmed facts");
  });

  it("checks product detail and use minimums for a complete visual plan", () => {
    const complete = shots.map(shot => ({ ...shot, tidewe: {
      ...shot.tidewe, productVisible: true, personVisible: true,
      visualPlan: { ...shot.tidewe!.visualPlan!, visualRole: "presenter" as const, framing: "medium" as const, productFocus: "主播身旁的迷彩靴筒" },
    } }));
    const prompt = buildTideweJudgePrompt(copy, complete, { videoMode: "scene_demo" });
    const issues = JSON.parse(prompt.split("DETERMINISTIC_PRODUCT_COVERAGE_ISSUES: ")[1].split("\n")[0]);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "PRODUCT_DETAIL_MISSING" }),
      expect.objectContaining({ code: "PRODUCT_USE_MISSING" }),
    ]));
  });

  it.each(["complete-without-focus", "partial-plan", "copy-beats-only"])("reports missing product evidence for %s", metadata => {
    const reviewCopy: TideweCopyDocument = metadata === "copy-beats-only" ? {
      ...copy, visualBeats: [{ text: copy.text, visualRole: "presenter", visualIdea: "主播说明选购问题", factRefs: [] }],
    } : copy;
    const partial = shots.map((shot, index) => ({ ...shot, tidewe: {
      ...shot.tidewe, productVisible: true, personVisible: true,
      visualPlan: metadata === "complete-without-focus" || metadata === "partial-plan" && index === 0 ? {
        ...shot.tidewe!.visualPlan!, visualRole: "presenter" as const, framing: "medium" as const,
      } : undefined,
    } }));
    const prompt = buildTideweJudgePrompt(reviewCopy, partial, { videoMode: "scene_demo" });
    const issues = JSON.parse(prompt.split("DETERMINISTIC_PRODUCT_COVERAGE_ISSUES: ")[1].split("\n")[0]);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "PRODUCT_FOCUS_MISSING" }),
      expect.objectContaining({ code: "PRODUCT_DETAIL_MISSING" }),
      expect.objectContaining({ code: "PRODUCT_USE_MISSING" }),
    ]));
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
