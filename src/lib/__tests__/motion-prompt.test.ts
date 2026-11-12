import { describe, it, expect } from "vitest";
import { buildMotionPrompt, hasCameraConflict, pickBehaviorBeats } from "@/lib/motion-prompt";
import { getLookPreset } from "@/lib/look-presets";
import { klingAudioPrompt } from "@/lib/kling/audio-prompt";
import { validateVideoPrompt } from "@/lib/video-prompt";
import { buildShotVideoPrompt, normalizeVideoPromptSettings } from "@/lib/shot-video-prompt";

describe("buildMotionPrompt（i2v 运镜提示词引擎）", () => {
  it("脚本 camera 字段优先，置于提示词开头（运镜是主信息）", () => {
    const p = buildMotionPrompt({ shotType: "hook", camera: "特写 + 缓慢推近", description: "咖啡杯特写" });
    expect(p.startsWith("运镜：特写 + 缓慢推近")).toBe(true);
  });

  it("无 camera 时按分镜类型给默认运镜（product_reveal → 环绕）", () => {
    const p = buildMotionPrompt({ shotType: "product_reveal", description: "商品展示" });
    expect(p).toContain("环绕");
    expect(p).toContain("保持商品原有外观与结构");
  });

  it("未知分镜类型回退通用运镜，不报错", () => {
    const p = buildMotionPrompt({ shotType: "unknown_type", description: "画面" });
    expect(p).toContain("镜头缓慢推近主体");
  });

  it("productShot=true 加商品保真约束（logo/文字不变形）", () => {
    const p = buildMotionPrompt({ shotType: "demo", description: "使用演示", productShot: true });
    expect(p).toContain("标志与文字必须保持完全不变");
  });

  it("productShot=false 不加保真约束", () => {
    const p = buildMotionPrompt({ shotType: "hook", description: "开场画面" });
    expect(p).not.toContain("logo");
  });







  it("英文脚本 → 全英文提示词（海外项目语言一致性）", () => {
    const p = buildMotionPrompt({ shotType: "product_reveal", camera: "slow orbit around the product", description: "a skincare bottle on marble" });
    expect(p.startsWith("Camera: slow orbit around the product")).toBe(true);
    expect(p).toContain("no flicker");
    expect(p).not.toMatch(/[一-鿿]/);
  });

  it("显式中文模板覆盖英文分镜的语言推断，并保留原始内容", () => {
    const camera = "camera pans left";
    const description = "A Model X device rotates on a blue background";
    const p = buildMotionPrompt({ locale: "zh", shotType: "demo", camera, description, productShot: true, look: getLookPreset("warm_life")!.motion });
    expect(p).toContain(`运镜：${camera}`);
    expect(p).toContain(`场景：${description}`);
    expect(p).toContain("画面动态：");
    expect(p).toContain("光线：全程保持温暖的橙黄午后光调");
    expect(p).toContain("标志与文字必须保持完全不变");
    expect(p.replace(camera, "").replace(description, "")).not.toMatch(/[A-Za-z]/);
  });

  it("显式英文模板仍可用于旧版多语言调用，不改写中文事实", () => {
    const p = buildMotionPrompt({ locale: "en", camera: "固定镜头", description: "商品型号甲保持完整" });
    expect(p).toContain("Camera: 固定镜头");
    expect(p).toContain("Scene: 商品型号甲保持完整");
    expect(p).toContain("stable smooth footage");
    expect(p).not.toContain("运镜：");
  });

  it("销售动态编译器使用中文模板及项目标签，原样保留英文商品信息", () => {
    const camera = "camera pans left";
    const description = "A Model X device on a blue background";
    const result = buildShotVideoPrompt({
      locale: "zh", ordinal: 0,
      shot: { type: "demo", camera, description, visualSource: "product_image" },
      settings: { visualLook: "warm_life" },
      creativeIntent: { subject: "完整商品", environment: "蓝色背景", lighting: "自然光", palette: "冷色", composition: "居中", camera: "平稳横移", motion: "自然连贯", continuity: ["同一空间"], productConstraints: ["按键位置不变"], negative: ["不要多余按钮"] },
    });
    expect(result.prompt).toContain(`运镜：${camera}`);
    expect(result.prompt).toContain(`场景：${description}`);
    expect(result.prompt).toContain("项目方向：");
    expect(result.prompt.replace(camera, "").replace(description, "")).not.toMatch(/[A-Za-z]/);
    expect(result.negativePrompt).toBe("不要多余按钮");
  });

  it("空输入默认中文（国内为主）且含稳定性约束尾", () => {
    const p = buildMotionPrompt({});
    expect(p).toContain("运镜：");
    expect(p).toContain("无闪烁、无变形");
  });

  it("保留完整场景描述，包括末尾的限制条件", () => {
    const long = "这是一个非常长的场景描述".repeat(20);
    const p = buildMotionPrompt({ shotType: "hook", description: long });
    expect(p).toContain(`场景：${long}。`);
  });

  it.each([false, true])("运镜、动态、场景与光线分别换行，静音要求空行独立（固定镜头：%s）", (fixed) => {
    const description = "完整商品入画，下方显示“点击下方小黄车”；底部小字为“价格、使用及清洗要求以商品页和说明书为准”。";
    const look = getLookPreset("phone_raw")!;
    const visual = buildMotionPrompt({
      shotType: "product_reveal", productShot: true, description,
      camera: fixed ? "固定镜头。" : "画面缓慢向右上方漂移，保持商品全貌完整。",
      look: look.motion, opener: look.opener, audioMode: "none",
    });
    const prompt = klingAudioPrompt(visual, false);
    const [body, audio, extra] = prompt.split("\n\n");
    const lines = body.split("\n");
    expect(lines.map((line) => line.split("：")[0])).toEqual([
      ...(fixed ? [] : ["内容创作者手机手持实拍。"]), "运镜", "画面动态", "场景", "光线",
    ]);
    expect(lines.find((line) => line.startsWith("场景："))).toBe(`场景：${description}`);
    const lighting = lines.at(-1)!;
    expect(lighting).toContain("全程保持未调色的自然色彩与混合色温。整段为连续单镜头拍摄");
    expect(lighting).toContain("标志与文字必须保持完全不变");
    expect(lighting).toContain("无闪烁、无变形、不出现新物体。");
    expect(audio).toBe("声音要求：视频全程静音，不生成人声、旁白、对白、背景音乐、环境音或音效。");
    expect(extra).toBeUndefined();
    expect(validateVideoPrompt(prompt)).toEqual([]);
  });

  it("英文段落与直接生成的声音要求同样保留独立换行", () => {
    const prompt = buildMotionPrompt({ camera: "camera pans right", description: 'A label reads "Scene: blue. Lighting: soft."', look: getLookPreset("phone_raw")!.motion });
    const [visual, audio] = prompt.split("\n\n");
    expect(visual.split("\n").map((line) => line.split(":")[0])).toEqual(["Camera", "Motion", "Scene", "Lighting"]);
    expect(visual).toContain('Scene: A label reads "Scene: blue. Lighting: soft.".\nLighting:');
    expect(audio).toMatch(/^sound:/);
    expect(audio).not.toContain("no new objects");
    expect(visual).toContain("no new objects");
  });

  it("每种已知分镜类型都有专属运镜与动态语言（不共用一句话）", () => {
    const types = ["hook", "pain_point", "product_reveal", "demo", "social_proof", "cta"] as const;
    const prompts = types.map((t) => buildMotionPrompt({ shotType: t, description: "画面" }));
    expect(new Set(prompts).size).toBe(types.length);
  });
});

describe("提示词工程包（单镜头声明 / 音效 / 冲突消解）", () => {
  it("非链式片段声明连续单镜头（防模型中途切镜）；链式片段用尾帧过渡引导，二者互斥", () => {
    const plain = buildMotionPrompt({ shotType: "demo", description: "演示" });
    expect(plain).toContain("连续单镜头");
    expect(plain).not.toContain("尾帧");
    const chained = buildMotionPrompt({ shotType: "demo", description: "演示", chainToNext: true });
    expect(chained).toContain("尾帧");
    expect(chained).not.toContain("不转场"); // 链式结尾就是要转场，不能自相矛盾
  });

  it("音效行始终存在且禁人声（配音全部来自 TTS，防无配音分镜冒出乱说话）", () => {
    expect(buildMotionPrompt({ shotType: "hook", description: "开场" })).toContain("无人声说话");
    expect(buildMotionPrompt({ shotType: "hook", description: "opening" })).toContain("no speech");
  });

  it("hasCameraConflict：静止+运动并存且无先后词 → 冲突；有先后词/单独出现 → 不冲突", () => {
    expect(hasCameraConflict("固定镜头，环绕拍摄")).toBe(true);
    expect(hasCameraConflict("static camera with a slow orbit")).toBe(true);
    expect(hasCameraConflict("镜头先推近，最后固定")).toBe(false);
    expect(hasCameraConflict("push in, then locked off")).toBe(false);
    expect(hasCameraConflict("固定镜头")).toBe(false);
    expect(hasCameraConflict("缓慢环绕")).toBe(false);
  });

  it("冲突的脚本 camera 被丢弃，回退到分镜类型默认运镜（单一明确指令）", () => {
    const p = buildMotionPrompt({ shotType: "product_reveal", camera: "固定镜头，环绕拍摄", description: "商品" });
    expect(p).not.toContain("固定镜头，环绕拍摄");
    expect(p).toContain("运镜：镜头围绕商品缓慢环绕移动");
  });

  it("talking 分镜换成对镜说话动作 + 两个行为节拍（UGC 反重复方法论）", () => {
    const zh = buildMotionPrompt({ shotType: "hook", description: "小美对镜头说话", talking: true, beatSeed: 0 });
    expect(zh).toContain("对着镜头自然说话");
    expect(zh).toContain("极短的停顿");
    const en = buildMotionPrompt({ shotType: "hook", description: "a woman talks", talking: true, beatSeed: 0 });
    expect(en).toContain("talks naturally to camera");
    // 非 talking 走原有分镜类型动作，完全不变
    expect(buildMotionPrompt({ shotType: "hook", description: "开场" })).toContain("画面主体动态醒目");
  });

  it("行为节拍确定性轮换：同 seed 稳定、不同 seed 组合不同、两条不重复", () => {
    expect(pickBehaviorBeats(3, "zh")).toEqual(pickBehaviorBeats(3, "zh"));
    const a = pickBehaviorBeats(0, "zh");
    const b = pickBehaviorBeats(1, "zh");
    expect(a).not.toEqual(b);
    for (const seed of [0, 1, 2, 3, 7, 12, 25]) {
      const [x, y] = pickBehaviorBeats(seed, "en");
      expect(x).not.toBe(y);
    }
  });

  it("talking 与 personShot/音效互不干扰：肤质由 REAL_FACE 管、音效仍禁人声（TTS 管配音）", () => {
    const p = buildMotionPrompt({ shotType: "hook", description: "小美说话", talking: true, personShot: true, beatSeed: 2 });
    expect(p).toContain("网红脸"); // REAL_FACE 仍在
    expect(p).toContain("无人声说话"); // clip 原生音频仍只要环境音
  });
});

describe("已移除运镜强度与真实感设置的兼容", () => {
  it.each([
    { motionIntensity: "strong", motionRealism: "auto" },
    { motionIntensity: "subtle", motionRealism: "constraints" },
    { motionIntensity: "normal", motionRealism: "off" },
    { motionIntensity: { obsolete: true }, motionRealism: "invalid-retired-tier" },
  ])("忽略旧设置且保留画面风格与商品保真（%j）", (retired) => {
    const settings = { visualLook: "warm_life", ...retired };
    expect(normalizeVideoPromptSettings(settings)).toEqual({ visualLook: "warm_life" });
    const input = {
      ordinal: 0,
      shot: { type: "demo" as const, camera: "镜头平稳横移", description: "人物展示食物，背景有窗帘。", visualSource: "product_image" as const, characterId: "presenter" },
    };
    const baseline = buildShotVideoPrompt({ ...input, settings: { visualLook: "warm_life" } });
    expect(buildShotVideoPrompt({ ...input, settings })).toEqual(baseline);
    expect(baseline.prompt).toContain("运镜：镜头平稳横移");
    expect(baseline.prompt).toContain("全程保持温暖的橙黄午后光调");
    expect(baseline.prompt).toContain("标志与文字必须保持完全不变");
    expect(baseline.prompt).not.toMatch(/运镜幅度|随气流轻轻晃动|滞后的摆动|眉心先皱/);
  });

  it("仍校验有效画面风格，不再校验已废弃设置", () => {
    expect(normalizeVideoPromptSettings({ motionIntensity: null, motionRealism: false })).toEqual({ visualLook: "none" });
    expect(() => normalizeVideoPromptSettings({ visualLook: "invalid-look" })).toThrow("视觉风格设置无效");
    expect(() => normalizeVideoPromptSettings(null)).toThrow("必须是对象");
  });
});

describe("Kling 实际问题回归", () => {
  const look = getLookPreset("phone_raw")!;
  const shared = { productShot: true, beatSeed: 2, look: look.motion, opener: look.opener };

  it("静态购买引导完整保留价格说明，不追加手持或大幅运镜", () => {
    const description = "完整商品原图静止居中，背景为纯净浅蓝色。商品下方固定显示“点击下方小黄车”，二维向下箭头指向购买入口方向；底部小字为“价格、使用及清洗要求以商品页和说明书为准”。";
    const prompt = klingAudioPrompt(buildMotionPrompt({ ...shared, shotType: "cta", camera: "固定镜头，商品与购买引导保持静止。", description }), false);
    expect(prompt).toContain(description);
    expect(prompt).not.toContain("。。");
    expect(prompt).not.toMatch(/手持|运镜幅度|金属|屏幕|自然环境音/);
    expect(prompt).toContain("视频全程静音");
    expect(validateVideoPrompt(prompt)).toEqual([]);
  });

  it("横移商品近景保留完整标称说明与禁止运转要求，不编造手部或背景灯", () => {
    const description = "裁切商品原图至透明杯身与圆形按键的近景，杯身反光和底座边缘清晰。左上角显示“30秒一杯*”，下方小字显示“*商家标称，非实测；效果依食材与用量而异”。不添加果汁旋涡或运转动画。";
    const prompt = klingAudioPrompt(buildMotionPrompt({ ...shared, shotType: "demo", camera: "镜头平稳向左横移，扫过透明杯身和圆形按键。", description }), false);
    expect(prompt).toContain(description);
    expect(prompt).not.toContain("。。");
    expect(prompt).not.toMatch(/手部演示|金属边框|屏幕内容|背景一盏灯|自然环境音/);
    expect(validateVideoPrompt(prompt)).toEqual([]);
  });

  it("静止商品可以配移动相机，固定相机可以配旋转商品", () => {
    const camera = "镜头缓慢横移，商品保持静止";
    expect(hasCameraConflict(camera)).toBe(false);
    const movingCamera = buildMotionPrompt({ camera, description: "商品静置于纯色背景", shotType: "demo" });
    expect(movingCamera).toContain(`运镜：${camera}`);
    expect(movingCamera).not.toContain("大胆明显");
    const turntable = buildMotionPrompt({ camera: "镜头固定，商品缓缓旋转", description: "商品在已有转台上转动", shotType: "product_reveal" });
    expect(turntable).not.toContain("商品保持静置不动");
    expect(validateVideoPrompt(turntable)).toEqual([]);
  });

  it("展示文字与否定要求不能成为凭空添加物体的依据", () => {
    const prompt = buildMotionPrompt({ shotType: "demo", description: "透明杯身特写，文字显示“金属屏幕”。不要添加背景灯，不要转动金属机身。", productShot: true });
    expect(prompt).not.toContain("已有屏幕内容");
    expect(prompt).not.toContain("已有金属表面");
    expect(prompt).not.toContain("高光缓缓扫过");
    expect(prompt).not.toContain("明暗呼吸");
  });

  it("静止背景不添加摆动，数码类目不会自动补屏幕", () => {
    const background = buildMotionPrompt({ shotType: "demo", description: "背景窗帘保持静止，透明杯身近景", productShot: true });
    expect(background).not.toContain("随气流轻轻晃动");
    expect(background).not.toContain("屏幕");
    const metal = buildMotionPrompt({ shotType: "demo", description: "金属机身特写", productShot: true });
    expect(metal).not.toContain("已有金属表面");
    expect(metal).toContain("标志与文字必须保持完全不变");
    expect(metal).not.toContain("屏幕");
    const globalStillBackground = buildMotionPrompt({ shotType: "demo", description: "商品展示，背景保持静止，窗帘清晰可见" });
    expect(globalStillBackground).not.toContain("随气流轻轻晃动");
  });

  it("显式旋转不会与商品展示默认静止冲突", () => {
    const prompt = buildMotionPrompt({ camera: "镜头平稳横移", description: "商品缓慢旋转展示", shotType: "product_reveal" });
    expect(prompt).not.toContain("商品保持静置不动");
    expect(prompt).toContain("商品缓慢旋转展示");
  });

  it("涂抹在板上的面霜不会引入皮肤或手指", () => {
    const prompt = buildMotionPrompt({ shotType: "demo", description: "面霜在亚克力板上推开，质地均匀" });
    expect(prompt).not.toContain("指腹");
    expect(prompt).not.toContain("皮肤");
  });

  it("不要静止不会被解释为要求主体静止", () => {
    const prompt = buildMotionPrompt({ shotType: "demo", description: "商品不要保持静止，缓慢旋转" });
    expect(prompt).not.toContain("画面动态：主体保持静止");
  });

  it.each(["static", "fixed.", "locked-off"])("简写固定机位 %s 不叠加手持风格", (camera) => {
    const prompt = buildMotionPrompt({ camera, description: "A complete product on a plain blue background", opener: look.opener, look: look.motion });
    expect(prompt).toContain(`Camera: ${camera}`);
    expect(prompt).not.toContain("handheld");
  });

  it("展示镜头拿起商品时不会追加静置要求", () => {
    const prompt = buildMotionPrompt({ camera: "固定镜头", description: "双手拿起商品，向镜头展示完整包装。", shotType: "product_reveal" });
    expect(prompt).not.toContain("商品保持静置不动");
    expect(prompt).toContain("双手拿起商品");
    expect(validateVideoPrompt(prompt)).toEqual([]);
  });

  it("明确移动机位时，不叠加风格中的固定机位要求", () => {
    const propped = getLookPreset("propped_static")!;
    const zh = buildMotionPrompt({ camera: "镜头向左横移", description: "商品特写", opener: propped.opener, look: propped.motion });
    expect(zh).not.toContain("固定");
    const en = buildMotionPrompt({ camera: "camera pans left", description: "A product close-up", opener: propped.opener, look: propped.motion });
    expect(en).not.toMatch(/static|fixed|propped/i);
  });

  it("音频模式只添加与当前选择一致的要求", () => {
    const silent = buildMotionPrompt({ description: "商品展示", audioMode: "silent" });
    expect(silent).toContain("视频全程静音");
    expect(silent).not.toContain("自然环境音");
    const native = buildMotionPrompt({ description: "人物口播", audioMode: "native", personShot: true, talking: true });
    expect(native).not.toContain("无人声说话");
    expect(validateVideoPrompt(silent)).toEqual([]);
    expect(validateVideoPrompt(native)).toEqual([]);
  });
});
