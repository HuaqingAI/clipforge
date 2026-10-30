// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Shot } from "@/lib/db/schema";
import { createTideweOutdoorProfile } from "@/lib/creative-profiles";
import { resolveNarrationVoice } from "@/lib/narration-voice";
import { buildShotVideoPrompt } from "@/lib/shot-video-prompt";
import { buildStoryboardGridPrompt } from "@/lib/storyboard-grid";
import { buildStoryboardFilmPrompt } from "@/lib/storyboard-film";
import { assertTideweMediaDuration, compileTideweVisualPrompt, TIDEWE_IMAGE_CAPTURE_POLICY, TIDEWE_PHOTOGRAPHIC_POLICY } from "@/lib/tidewe/visual-policy";
import { validateVideoPrompt } from "@/lib/video-prompt";

const profile = createTideweOutdoorProfile({ speechMode: "voiceover" });
const shot: Shot = {
  shotId: 1, type: "hook", duration: 5, description: "清晨林缘，猎人背影沿平稳小径行走。",
  visualIntent: "清晨林缘背影，建立户外行动。", prompt: "林缘自然光与小径。", camera: "固定中景",
  visualSource: "ai_generate", transition: "direct_concat", voiceover: "The walk in is only the start.", characterId: "person",
  tidewe: { copySpan: { start: 0, end: 31 }, translation: "走进去只是开始。", shotGoal: "建立林缘行走场景", productVisible: false, factRefs: [], sceneId: "woods" },
};

describe("TIDEWE downstream visual and narration policy", () => {
  const frozenPresenter = { id: "host", name: "Host", appearance: "成年户外主播", referenceImages: ["/api/files/host.png"] };

  it("carries the concrete boot observation through still, grid and video composition", () => {
    const productFocus = "参考中的高筒迷彩狩猎靴与小腿同框，筒口扣带清楚可见";
    const planned: Shot = { ...shot, description: "所选主播已穿好参考中的狩猎靴，手指搭在现有筒口扣带。", tidewe: { ...shot.tidewe!, productVisible: true, personVisible: true, speechDelivery: "off_camera", visualPlan: { framing: "detail", visualRole: "detail", productFocus, actionStart: "手指已搭住靴筒扣带", action: "沿可见扣带轻触一次", actionEnd: "手停在扣带边缘" } } };
    const outputs = [
      compileTideweVisualPrompt(planned, "image", "on_camera").prompt,
      buildShotVideoPrompt({ shot: planned, ordinal: 0, creativeProfile: createTideweOutdoorProfile() }).prompt,
      buildStoryboardFilmPrompt([planned], null, { creativeProfile: createTideweOutdoorProfile() }),
    ];
    for (const prompt of outputs) {
      expect(prompt).toContain(`本镜商品观察对象：${productFocus}`);
      expect(prompt).toContain("画幅与构图须实际容纳观察对象");
      expect(prompt).toContain("本镜由同一成年主播画外讲解");
      expect(prompt).not.toContain("产品不出镜");
    }
    const grid = buildStoryboardGridPrompt([planned], null, { creativeProfile: createTideweOutdoorProfile() });
    expect(grid).toContain(`本镜商品观察对象：${productFocus}`);
    expect(grid).toContain("构图容纳指定部件与接触位置");
    expect(grid).toContain("画外讲解：安静操作，按本镜构图，不要求脸部或嘴部入画");
    expect(grid).not.toContain("产品不出镜");
  });

  it("uses the planned initial contact for stills and the complete action for video without leaking the ending into the first frame", () => {
    const visualPlan = { framing: "detail" as const, visualRole: "detail" as const, actionStart: "指腹已经搭在坐垫前缘", action: "轻压现有软垫一次", actionEnd: "压力释放后手掌停在垫边" };
    const planned = { ...shot, tidewe: { ...shot.tidewe!, visualPlan, personVisible: true, speechDelivery: "off_camera" as const } };
    const before = structuredClone(planned);
    const stills = [compileTideweVisualPrompt(planned, "image", "on_camera").prompt, buildStoryboardGridPrompt([planned], null, { creativeProfile: createTideweOutdoorProfile() })];
    for (const prompt of stills) {
      expect(prompt).toContain(visualPlan.actionStart);
      expect(prompt).toContain(visualPlan.action);
      expect(prompt).not.toContain(visualPlan.actionEnd);
      expect(prompt).not.toContain(planned.voiceover);
    }
    const video = buildShotVideoPrompt({ shot: planned, ordinal: 0, creativeProfile: createTideweOutdoorProfile() });
    expect(video.prompt).toContain(visualPlan.actionStart);
    expect(video.prompt).toContain(visualPlan.action);
    expect(video.prompt).toContain(visualPlan.actionEnd);
    expect(video.prompt).toContain(JSON.stringify(planned.voiceover));
    expect(video.prompt).not.toContain("嘴部清晰可见");
    expect(planned).toEqual(before);
  });

  it.each(["image", "video"] as const)("applies the photographic baseline to %s without overwriting the approved scene", (kind) => {
    const approved = { ...shot, description: "傍晚林边，主播在树影下检查椅脚。", camera: "低机位产品近景" };
    const compiled = compileTideweVisualPrompt(approved, kind);
    expect(compiled.prompt).toContain(kind === "image" ? TIDEWE_IMAGE_CAPTURE_POLICY : TIDEWE_PHOTOGRAPHIC_POLICY);
    expect(compiled.prompt).toContain(approved.description);
    expect(compiled.prompt).toContain(approved.camera);
    expect(compiled.negativePrompt).toMatch(/过度背景虚化.*过度锐化.*油画纹理/);
    expect(approved.description).toBe("傍晚林边，主播在树影下检查椅脚。");
  });

  it("allows the grid to own one shared photographic block while retaining each cell's scene and identity", () => {
    const bound = { ...shot, tidewe: { ...shot.tidewe!, personVisible: true, presenter: frozenPresenter } };
    const cell = compileTideweVisualPrompt(bound, "image", "on_camera", frozenPresenter, "native", { includePhotographicPolicy: false });
    expect(cell.prompt).not.toContain(TIDEWE_PHOTOGRAPHIC_POLICY);
    expect(cell.prompt).not.toContain(TIDEWE_IMAGE_CAPTURE_POLICY);
    expect(cell.prompt).toContain(bound.description);
    expect(cell.prompt).toContain("所选主播 Host（成年户外主播）");
    expect(cell.negativePrompt).toContain("过度锐化");
  });

  it("keeps historical on-camera delivery and permits wider framing with a visible speaking face", () => {
    const bound = { ...shot, camera: "膝上中全景展示整把椅子", tidewe: { ...shot.tidewe!, presenter: frozenPresenter } };
    const historical = compileTideweVisualPrompt(bound, "video", "on_camera");
    const explicit = compileTideweVisualPrompt({ ...bound, tidewe: { ...bound.tidewe!, speechDelivery: "on_camera" } }, "video", "on_camera");
    expect(explicit).toEqual(historical);
    expect(explicit.prompt).toContain(bound.camera);
    expect(explicit.prompt).toContain("嘴部清晰可见");
    expect(explicit.prompt).not.toContain("中近景或半身构图");
    expect(explicit.negativePrompt).not.toMatch(/(?:^|、)说话口型(?:、|$)/);
  });

  it.each([true, false])("narrates the frozen line off camera without forcing a face, personVisible=%s", (personVisible) => {
    const exact = "I'd check this part first. Keep it simple.";
    const bound: Shot = { ...shot, voiceover: exact, camera: "低机位椅脚特写", description: "椅脚与落叶地面自然接触。", tidewe: { ...shot.tidewe!, speechDelivery: "off_camera", presenter: frozenPresenter, personVisible } };
    const before = structuredClone(bound);
    const compiled = compileTideweVisualPrompt(bound, "video", "on_camera");
    expect(compiled.prompt).toContain(JSON.stringify(exact));
    expect(compiled.prompt.split(exact)).toHaveLength(2);
    expect(compiled.prompt).toContain("off-camera narration");
    expect(compiled.prompt).toContain("no visible speaking, lip synchronization");
    expect(compiled.prompt).toContain(bound.camera);
    expect(compiled.prompt).not.toContain("嘴部清晰可见");
    expect(compiled.prompt).not.toContain("must speak the following");
    expect(compiled.negativePrompt).toContain("说话口型");
    if (personVisible) expect(compiled.prompt).toContain("所选主播 Host（成年户外主播）");
    else {
      expect(compiled.prompt).toContain("不加入主播、路人、人脸或手");
      expect(compiled.prompt).not.toContain("所选主播 Host");
    }
    const keyframe = compileTideweVisualPrompt(bound, "image", "on_camera");
    expect(keyframe.prompt).not.toContain(exact);
    expect(keyframe.prompt).not.toContain("适合后续生成开口说话的视频");
    expect(bound).toEqual(before);
  });

  it("uses silent visual footage for off-camera narration added in post while preserving the frozen line", () => {
    const exact = "Look at the seam before choosing your size.";
    const bound: Shot = { ...shot, voiceover: exact, tidewe: { ...shot.tidewe!, speechDelivery: "off_camera", personVisible: false } };
    const compiled = compileTideweVisualPrompt(bound, "video", "on_camera", undefined, "post");
    expect(compiled.prompt).toContain("Generate silent video");
    expect(compiled.prompt).toContain("narration to be added in post");
    expect(compiled.prompt).toContain("no speaking or lip synchronization");
    expect(compiled.prompt).not.toContain("must visibly articulate");
    expect(compiled.prompt).not.toContain(exact);
    expect(compiled.negativePrompt).toContain("说话口型");
    expect(bound.voiceover).toBe(exact);
    expect(validateVideoPrompt(compiled.prompt)).toEqual([]);
    const historical = compileTideweVisualPrompt({ ...bound, tidewe: { ...bound.tidewe!, speechDelivery: undefined } }, "video", "voiceover");
    expect(compileTideweVisualPrompt(bound, "video", "voiceover")).toEqual(historical);
  });

  it("binds the saved presenter and keeps identity/product reference roles distinct", () => {
    const presenter = { id: "jerry", name: "Jerry", appearance: "成年女性，黑色短发", referenceImages: ["/api/files/jerry.png"] };
    const selected = createTideweOutdoorProfile({ presenter });
    const bound = { ...shot, tidewe: { ...shot.tidewe!, presenter, personVisible: true } };
    const grid = buildStoryboardGridPrompt([bound], null, { creativeProfile: selected, characterSheet: true, productImageCount: 2 });
    expect(grid).toContain("固定出镜人物：所选主播 Jerry（成年女性，黑色短发）");
    expect(grid).toContain("第 1 张参考图为主播身份参考");
    expect(grid).toContain("第 2 张参考图为当前同一商品的第 1/2 个视角");
    expect(grid).toContain("第 3 张参考图为当前同一商品的第 2/2 个视角");
    expect(grid).not.toContain("所有镜头同一对镜主播");
    const video = compileTideweVisualPrompt(bound, "video", "on_camera");
    expect(video.prompt).toContain("主播参考图优先锁定身份");
    expect(video.prompt).toContain(JSON.stringify(shot.voiceover));
    const film = buildStoryboardFilmPrompt([bound], null, { creativeProfile: selected, characterSheet: true });
    expect(film).toContain("固定出镜人物为所选主播 Jerry");
    expect(film).toContain("构图参考第2张图片");
    const bRoll = compileTideweVisualPrompt({ ...bound, voiceover: "", tidewe: { ...bound.tidewe, personVisible: false } }, "image", "on_camera");
    expect(bRoll.prompt).toContain("本镜为无人出镜");
    expect(bRoll.prompt).not.toContain("Jerry");
    expect(bRoll.prompt).not.toContain("允许自然露脸");
  });
  it("binds exact English on-camera dialogue, a visible mouth and synchronized lips in native footage", () => {
    const nativeProfile = createTideweOutdoorProfile();
    const exact = "I'd check the fit first. Don't rush it.";
    const presenterShot = { ...shot, voiceover: exact };
    const video = buildShotVideoPrompt({ shot: presenterShot, ordinal: 0, creativeProfile: nativeProfile });
    const film = buildStoryboardFilmPrompt([presenterShot], null, { creativeProfile: nativeProfile });
    for (const prompt of [video.prompt, film]) {
      expect(prompt).toContain(JSON.stringify(exact));
      expect(prompt).toContain("match the English phonemes");
      expect(prompt).toContain("嘴部清晰可见");
      expect(prompt).not.toContain("仅生成静音视觉素材");
      expect(prompt).not.toContain("英文画外旁白由后期统一添加");
    }
    expect(video.negativePrompt).not.toMatch(/(?:^|、)说话口型(?:、|$)/);
    const keyframe = compileTideweVisualPrompt(presenterShot, "image", "on_camera");
    const grid = buildStoryboardGridPrompt([presenterShot], null, { creativeProfile: nativeProfile });
    expect(keyframe.prompt).toContain("适合后续生成开口说话的视频");
    expect(grid).toContain("真人口播：回应镜头，嘴部清晰可见");
    for (const prompt of [keyframe.prompt, grid]) {
      expect(prompt).not.toContain(exact);
      expect(prompt).not.toContain("英文画外旁白由后期统一添加");
    }
    const silent = compileTideweVisualPrompt({ ...shot, voiceover: "" }, "video", "on_camera");
    expect(silent.prompt).toContain("本镜没有口播文案");
    expect(silent.prompt).not.toContain("Exact spoken text");
  });
  it("uses a shared English voice default and rejects incompatible explicit Edge voices", () => {
    expect(resolveNarrationVoice(profile)).toBe("en-US-GuyNeural");
    expect(resolveNarrationVoice(profile, "en-US-AriaNeural")).toBe("en-US-AriaNeural");
    expect(() => resolveNarrationVoice(profile, "zh-CN-XiaoxiaoNeural")).toThrow("英语音色");
    expect(resolveNarrationVoice(undefined)).toBe("zh-CN-XiaoxiaoNeural");
  });
  it("keeps exact visible on-camera articulation when narration will be added in composition", () => {
    const nativeProfile = createTideweOutdoorProfile();
    const exact = "I'd check the fit first. Don't rush it.";
    const presenterShot = { ...shot, voiceover: exact };
    const compiled = compileTideweVisualPrompt(presenterShot, "video", "on_camera", undefined, "post");
    const video = buildShotVideoPrompt({ shot: presenterShot, ordinal: 0, creativeProfile: nativeProfile, audioMode: "post" });
    expect(video).toEqual(compiled);
    expect(video.prompt).toContain(JSON.stringify(exact));
    expect(video.prompt.split(exact)).toHaveLength(2);
    expect(video.prompt).toContain("嘴部清晰可见");
    expect(video.prompt).toContain("must visibly articulate");
    expect(video.prompt).toContain("match the English phonemes");
    expect(video.prompt).toContain("Do not generate an audio track");
    expect(video.prompt).toContain("narration will be added automatically during composition");
    expect(video.prompt).not.toContain("Generate native synchronized audio and video");
    expect(video.prompt).not.toContain("不生成说话口型");
    expect(video.negativePrompt).not.toMatch(/(?:^|、)说话口型(?:、|$)/);
    const withoutSpeech = compileTideweVisualPrompt({ ...shot, voiceover: "" }, "video", "on_camera", undefined, "post");
    expect(withoutSpeech.prompt).toContain("仅生成静音视觉素材");
    expect(withoutSpeech.prompt).not.toContain("Exact spoken text");
  });
  it("keeps outdoor environment shots free of narration and inherited indoor sales direction", () => {
    const result = buildShotVideoPrompt({ shot, ordinal: 0, creativeProfile: profile, creativeIntent: { subject: "卧室主播卖货" } });
    expect(result.prompt).toContain("清晨林缘");
    expect(result.prompt).toContain(`本镜画面：${shot.description}`);
    expect(result.prompt).toContain(`视觉意图补充：${shot.visualIntent}`);
    expect(result.prompt).toContain(`画面目标：${shot.tidewe!.shotGoal}`);
    expect(result.prompt).toContain("产品不出镜");
    expect(result.prompt).toContain("静音视觉素材");
    expect(result.prompt).not.toContain(shot.voiceover);
    expect(result.prompt).not.toContain("卧室主播卖货");
    expect(result.prompt).not.toContain("对着镜头自然说话");
    expect(result.negativePrompt).toContain("独立电池展示");
  });
  it("uses a manually edited description while preserving the separate visual intent", () => {
    const edited = { ...shot, description: "猎人在落叶覆盖的小径边停步，低头检查鞋带。" };
    const result = buildShotVideoPrompt({ shot: edited, ordinal: 0, creativeProfile: profile });
    expect(result.prompt).toContain(`本镜画面：${edited.description}`);
    expect(result.prompt).toContain(shot.visualIntent);
    expect(result.prompt).not.toContain(shot.description);
  });
  it("allows a naturally visible adult face across image, single-shot, grid and film generation without native speech", () => {
    const presenterShot: Shot = {
      ...shot,
      description: "清晨林缘，一位戴棕色帽子的成年猎人自然露脸，面向镜头展示迷彩外套。",
      visualIntent: "真人正面展示装备，保持亲切自然的户外使用感。",
      tidewe: { ...shot.tidewe!, productVisible: true },
    };
    const outputs = [
      compileTideweVisualPrompt(presenterShot, "image"),
      buildShotVideoPrompt({ shot: presenterShot, ordinal: 0, creativeProfile: profile }),
      { prompt: buildStoryboardFilmPrompt([presenterShot], null, { creativeProfile: profile }) },
    ];
    for (const output of outputs) {
      expect(output.prompt).toContain(presenterShot.description);
      expect(output.prompt).toContain("真人展示与真实使用");
      expect(output.prompt).toContain("允许自然露脸");
      expect(output.prompt).toContain("同场景人物的面容、年龄感、发型、帽子、服装");
      expect(output.prompt).toContain("英文画外旁白由后期统一添加");
      expect(output.prompt).not.toMatch(/不露脸|不含人脸|仅背影|只拍手/);
      expect(output.prompt).not.toContain(presenterShot.voiceover);
      if ("negativePrompt" in output) expect(output.negativePrompt).not.toMatch(/人脸|露脸|真人出镜/);
    }
    const grid = buildStoryboardGridPrompt([presenterShot], null, { creativeProfile: profile });
    expect(grid).toContain(presenterShot.description);
    expect(grid).toContain("人物按本镜构图自然互动，细节镜不强加人脸");
    expect(grid).toContain("同 sceneId 的人物、衣物、产品状态、环境、天气与光线连续");
    expect(grid).not.toMatch(/不露脸|不含人脸|仅背影|只拍手|真人口播/);
    expect(grid).not.toContain(presenterShot.voiceover);
    expect(outputs[1].prompt).toContain("静音视觉素材");
    expect(outputs[2].prompt).toContain("仅生成静音视觉素材");
  });
  it("plans continuity by scene and refuses silent grid truncation", () => {
    const prompt = buildStoryboardGridPrompt([shot], null, { creativeProfile: profile });
    expect(prompt).toContain("同 sceneId");
    expect(prompt).toContain("产品不出镜");
    expect(prompt).not.toContain("同一房间、同一光线");
    expect(() => buildStoryboardGridPrompt(Array.from({ length: 10 }, () => shot), null, { creativeProfile: profile })).toThrow("不能截断");
  });
  it("does not turn voiceover into native dialogue and refuses an over-cap whole-film plan", () => {
    const prompt = buildStoryboardFilmPrompt([shot], null, { creativeProfile: profile });
    expect(prompt).toContain("仅生成静音视觉素材");
    expect(prompt).not.toContain(shot.voiceover);
    expect(() => buildStoryboardFilmPrompt([{ ...shot, duration: 40 }], null, { creativeProfile: profile })).toThrow("不能截断");
  });
  it("checks each measured clip, including fade/tail budget, instead of accepting an adequate total", () => {
    expect(() => assertTideweMediaDuration(3, 5.45, 5)).toThrow("镜头 3");
    expect(() => assertTideweMediaDuration(3, 2, Number.NaN)).toThrow("实测时长");
    expect(() => assertTideweMediaDuration(3, 4.5, 5)).not.toThrow();
  });
});
