// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Shot } from "@/lib/db/schema";
import { createTideweOutdoorProfile } from "@/lib/creative-profiles";
import { resolveNarrationVoice } from "@/lib/narration-voice";
import { buildShotVideoPrompt } from "@/lib/shot-video-prompt";
import { buildStoryboardGridPrompt } from "@/lib/storyboard-grid";
import { buildStoryboardFilmPrompt } from "@/lib/storyboard-film";
import { assertTideweMediaDuration, compileTideweVisualPrompt, TIDEWE_IMAGE_CAPTURE_POLICY, TIDEWE_PHOTOGRAPHIC_POLICY } from "@/lib/tidewe/visual-policy";
import { TIDEWE_VIDEO_STYLE } from "@/lib/tidewe/video-prompt";
import type { TideweVideoDirection } from "@/lib/tidewe/video-direction";
import { validateVideoPrompt } from "@/lib/video-prompt";

const profile = createTideweOutdoorProfile({ speechMode: "voiceover" });
const shot: Shot = {
  shotId: 1, type: "hook", duration: 5, description: "清晨林缘，猎人背影沿平稳小径行走。",
  visualIntent: "清晨林缘背影，建立户外行动。", prompt: "林缘自然光与小径。", camera: "固定中景",
  visualSource: "ai_generate", transition: "direct_concat", voiceover: "The walk in is only the start.", characterId: "person",
  tidewe: { copySpan: { start: 0, end: 31 }, translation: "走进去只是开始。", shotGoal: "建立林缘行走场景", productVisible: false, factRefs: [], sceneId: "woods" },
};
const direction: TideweVideoDirection = {
  start: "The hunter stands at the woodland trail.", action: "The hunter takes one steady step along the trail.",
  end: "The hunter pauses with both feet planted.", camera: "Static medium shot.",
};

/** The dormant film builder has no translation I/O; its pure compiler receives English fields. */
function englishShot(source: Shot, translated = direction): Shot {
  return { ...source, description: translated.action, visualIntent: "", camera: translated.camera ?? "",
    tidewe: { ...source.tidewe!, shotGoal: "", visualPlan: source.tidewe?.visualPlan ? {
      ...source.tidewe.visualPlan, actionStart: translated.start ?? "", action: translated.action,
      actionEnd: translated.end ?? "", productFocus: translated.focus,
    } : undefined } };
}

describe("TIDEWE downstream visual and narration policy", () => {
  const frozenPresenter = { id: "host", name: "Host", appearance: "成年户外主播", referenceImages: ["/api/files/host.png"] };

  it("keeps the Chinese boot observation in still/grid prompts and sends its translated action to video", () => {
    const productFocus = "参考中的高筒迷彩狩猎靴与小腿同框，筒口扣带清楚可见";
    const planned: Shot = { ...shot, description: "所选主播已穿好参考中的狩猎靴，手指搭在现有筒口扣带。", tidewe: { ...shot.tidewe!, productVisible: true, personVisible: true, speechDelivery: "off_camera", visualPlan: { framing: "detail", visualRole: "detail", productFocus, actionStart: "手指已搭住靴筒扣带", action: "沿可见扣带轻触一次", actionEnd: "手停在扣带边缘" } } };
    const still = compileTideweVisualPrompt(planned, "image", "on_camera").prompt;
    expect(still).toContain("本镜商品观察对象：" + productFocus);
    expect(still).toContain("画幅与构图须实际容纳观察对象");
    expect(still).toContain("本镜由同一成年主播画外讲解");
    const grid = buildStoryboardGridPrompt([planned], null, { creativeProfile: createTideweOutdoorProfile() });
    expect(grid).toContain("本镜商品观察对象：" + productFocus);
    expect(grid).toContain("构图容纳指定部件与接触位置");
    expect(grid).toContain("画外讲解：安静操作，按本镜构图，不要求脸部或嘴部入画");
    const translated: TideweVideoDirection = { start: "The finger rests on the boot strap.", action: "The finger touches the visible strap once.", end: "The hand rests beside the strap.", camera: "Static close detail.", focus: "The tall camouflage boot and calf strap remain visible." };
    const before = structuredClone(planned);
    const video = buildShotVideoPrompt({ shot: planned, ordinal: 0, creativeProfile: createTideweOutdoorProfile(), tideweVideoDirection: translated });
    const film = buildStoryboardFilmPrompt([englishShot(planned, translated)], null, { creativeProfile: createTideweOutdoorProfile() }, { tideweVideoDirections: { [planned.shotId]: translated } });
    for (const prompt of [video.prompt, film]) {
      expect(prompt).toContain(translated.action);
      expect(prompt).toContain(translated.focus);
      expect(prompt).toContain(JSON.stringify(planned.voiceover));
      expect(prompt).not.toContain(productFocus);
    }
    expect(video.prompt).toMatch(/off.camera narration/i);
    expect(planned).toEqual(before);
  });

  it("keeps the start state in stills while video receives the complete translated action", () => {
    const visualPlan = { framing: "detail" as const, visualRole: "detail" as const, actionStart: "指腹已经搭在坐垫前缘", action: "轻压现有软垫一次", actionEnd: "压力释放后手掌停在垫边" };
    const planned = { ...shot, tidewe: { ...shot.tidewe!, visualPlan, personVisible: true, speechDelivery: "off_camera" as const } };
    for (const prompt of [compileTideweVisualPrompt(planned, "image", "on_camera").prompt, buildStoryboardGridPrompt([planned], null, { creativeProfile: createTideweOutdoorProfile() })]) {
      expect(prompt).toContain(visualPlan.actionStart);
      expect(prompt).toContain(visualPlan.action);
      expect(prompt).not.toContain(visualPlan.actionEnd);
      expect(prompt).not.toContain(planned.voiceover);
    }
    const translated = { start: "Fingertips rest on the cushion edge.", action: "Press the cushion once.", end: "Release pressure and rest the hand beside the cushion.", camera: "Static close detail." };
    const video = buildShotVideoPrompt({ shot: planned, ordinal: 0, creativeProfile: createTideweOutdoorProfile(), tideweVideoDirection: translated });
    for (const text of [translated.start, translated.action, translated.end, translated.camera]) expect(video.prompt).toContain(text);
    expect(video.prompt).not.toContain(visualPlan.actionEnd);
    expect(video.prompt).toContain(JSON.stringify(planned.voiceover));
  });

  it("preserves the still photographic policy while video uses the compact English style", () => {
    const approved = { ...shot, description: "傍晚林边，主播在树影下检查椅脚。", camera: "低机位产品近景" };
    const image = compileTideweVisualPrompt(approved, "image");
    expect(image.prompt).toContain(TIDEWE_IMAGE_CAPTURE_POLICY);
    expect(image.prompt).toContain(approved.description);
    expect(image.prompt).toContain(approved.camera);
    expect(image.negativePrompt).toMatch(/过度背景虚化.*过度锐化.*油画纹理/);
    const translated = { action: "The presenter checks the chair foot at the woodland edge at dusk.", camera: "Low-angle product close-up." };
    const video = compileTideweVisualPrompt(approved, "video", "voiceover", undefined, "native", { direction: translated });
    expect(video.prompt).toContain(TIDEWE_VIDEO_STYLE);
    expect(video.prompt).toContain(translated.action);
    expect(video.prompt).toContain(translated.camera);
    expect(video.prompt).not.toContain(TIDEWE_PHOTOGRAPHIC_POLICY);
    expect(video.prompt).not.toMatch(/[\u3400-\u9fff]/);
    expect(approved.description).toBe("傍晚林边，主播在树影下检查椅脚。");
  });

  it("allows the grid to own one photographic block while retaining each cell's scene and identity", () => {
    const bound = { ...shot, tidewe: { ...shot.tidewe!, personVisible: true, presenter: frozenPresenter } };
    const cell = compileTideweVisualPrompt(bound, "image", "on_camera", frozenPresenter, "native", { includePhotographicPolicy: false });
    expect(cell.prompt).not.toContain(TIDEWE_PHOTOGRAPHIC_POLICY);
    expect(cell.prompt).not.toContain(TIDEWE_IMAGE_CAPTURE_POLICY);
    expect(cell.prompt).toContain(bound.description);
    expect(cell.prompt).toContain("所选主播 Host（成年户外主播）");
    expect(cell.negativePrompt).toContain("过度锐化");
  });

  it("keeps historical on-camera delivery and the approved wider framing", () => {
    const bound = { ...shot, camera: "膝上中全景展示整把椅子", tidewe: { ...shot.tidewe!, presenter: frozenPresenter } };
    const translated = { ...direction, camera: "Knee-up medium-wide shot including the complete chair." };
    const historical = compileTideweVisualPrompt(bound, "video", "on_camera", undefined, "native", { direction: translated });
    const explicit = compileTideweVisualPrompt({ ...bound, tidewe: { ...bound.tidewe!, speechDelivery: "on_camera" } }, "video", "on_camera", undefined, "native", { direction: translated });
    expect(explicit).toEqual(historical);
    expect(explicit.prompt).toContain(translated.camera);
    expect(explicit.prompt).toMatch(/mouth.*visible/i);
    expect(explicit.prompt).toContain(JSON.stringify(bound.voiceover));
  });

  it.each([true, false])("narrates the exact line off camera without changing framing, personVisible=%s", (personVisible) => {
    const exact = "I'd check this part first. Keep it simple.";
    const bound: Shot = { ...shot, voiceover: exact, camera: "低机位椅脚特写", description: "椅脚与落叶地面自然接触。", tidewe: { ...shot.tidewe!, speechDelivery: "off_camera", presenter: frozenPresenter, personVisible } };
    const before = structuredClone(bound);
    const translated = { action: "The chair foot rests on the leaf-covered ground.", camera: "Low-angle chair-foot detail." };
    const compiled = compileTideweVisualPrompt(bound, "video", "on_camera", undefined, "native", { direction: translated });
    expect(compiled.prompt).toContain(JSON.stringify(exact));
    expect(compiled.prompt.split(exact)).toHaveLength(2);
    expect(compiled.prompt).toMatch(/off.camera narration/i);
    expect(compiled.prompt).toContain(translated.camera);
    expect(compiled.prompt).not.toMatch(/must speak|mouth.*visible/i);
    expect(compiled.negativePrompt).toMatch(/speaking|lip.sync/i);
    const keyframe = compileTideweVisualPrompt(bound, "image", "on_camera");
    expect(keyframe.prompt).not.toContain(exact);
    expect(keyframe.prompt).not.toContain("适合后续生成开口说话的视频");
    expect(bound).toEqual(before);
  });

  it("uses silent visuals for post narration and keeps the frozen line outside the video prompt", () => {
    const exact = "Look at the seam before choosing your size.";
    const bound: Shot = { ...shot, voiceover: exact, tidewe: { ...shot.tidewe!, speechDelivery: "off_camera", personVisible: false } };
    const compiled = compileTideweVisualPrompt(bound, "video", "on_camera", undefined, "post", { direction });
    expect(compiled.prompt).toMatch(/silent (?:video|footage)/i);
    expect(compiled.prompt).toMatch(/post/i);
    expect(compiled.prompt).not.toContain(exact);
    expect(compiled.prompt).not.toMatch(/must visibly articulate/i);
    expect(compiled.negativePrompt).toMatch(/speaking|lip.sync/i);
    expect(bound.voiceover).toBe(exact);
    expect(validateVideoPrompt(compiled.prompt)).toEqual([]);
    const historical = compileTideweVisualPrompt({ ...bound, tidewe: { ...bound.tidewe!, speechDelivery: undefined } }, "video", "voiceover", undefined, "native", { direction });
    expect(compileTideweVisualPrompt(bound, "video", "voiceover", undefined, "native", { direction })).toEqual(historical);
  });

  it("keeps presenter and product references distinct in still/grid generation", () => {
    const presenter = { id: "jerry", name: "Jerry", appearance: "成年女性，黑色短发", referenceImages: ["/api/files/jerry.png"] };
    const selected = createTideweOutdoorProfile({ presenter });
    const bound = { ...shot, tidewe: { ...shot.tidewe!, presenter, personVisible: true } };
    const grid = buildStoryboardGridPrompt([bound], null, { creativeProfile: selected, characterSheet: true, productImageCount: 2 });
    expect(grid).toContain("固定出镜人物：所选主播 Jerry（成年女性，黑色短发）");
    expect(grid).toContain("第 1 张参考图为主播身份参考");
    expect(grid).toContain("第 2 张参考图为当前同一商品的第 1/2 个视角");
    expect(grid).toContain("第 3 张参考图为当前同一商品的第 2/2 个视角");
    const bRoll = compileTideweVisualPrompt({ ...bound, voiceover: "", tidewe: { ...bound.tidewe, personVisible: false } }, "image", "on_camera");
    expect(bRoll.prompt).toContain("本镜为无人出镜");
    expect(bRoll.prompt).not.toContain("Jerry");
  });

  it("forwards exact native speech and post articulation through the single-shot builder", () => {
    const nativeProfile = createTideweOutdoorProfile();
    const exact = "I'd check the fit first. Don't rush it.";
    const presenterShot = { ...shot, voiceover: exact };
    for (const audioMode of ["native", "post"] as const) {
      const compiled = compileTideweVisualPrompt(presenterShot, "video", "on_camera", undefined, audioMode, { direction });
      const video = buildShotVideoPrompt({ shot: presenterShot, ordinal: 0, creativeProfile: nativeProfile, audioMode, tideweVideoDirection: direction });
      expect(video).toEqual(compiled);
      expect(video.prompt).toContain(JSON.stringify(exact));
      expect(video.prompt.split(exact)).toHaveLength(2);
      expect(video.prompt).toMatch(/mouth.*visible/i);
      if (audioMode === "post") {
        expect(video.prompt).toMatch(/visibly articulat|silently articulat/i);
        expect(video.prompt).toMatch(/no audio track|do not generate an audio track/i);
      } else expect(video.prompt).toMatch(/synchroniz|lip.sync/i);
    }
    const keyframe = compileTideweVisualPrompt(presenterShot, "image", "on_camera");
    const grid = buildStoryboardGridPrompt([presenterShot], null, { creativeProfile: nativeProfile });
    expect(keyframe.prompt).toContain("适合后续生成开口说话的视频");
    expect(grid).toContain("真人口播：回应镜头，嘴部清晰可见");
    for (const prompt of [keyframe.prompt, grid]) expect(prompt).not.toContain(exact);
  });

  it("uses a shared English voice default and rejects incompatible explicit Edge voices", () => {
    expect(resolveNarrationVoice(profile)).toBe("en-US-GuyNeural");
    expect(resolveNarrationVoice(profile, "en-US-AriaNeural")).toBe("en-US-AriaNeural");
    expect(() => resolveNarrationVoice(profile, "zh-CN-XiaoxiaoNeural")).toThrow("英语音色");
    expect(resolveNarrationVoice(undefined)).toBe("zh-CN-XiaoxiaoNeural");
  });

  it("sends translated motion without inherited sales direction or the frozen VO", () => {
    const result = buildShotVideoPrompt({ shot, ordinal: 0, creativeProfile: profile, creativeIntent: { subject: "卧室主播卖货" }, tideweVideoDirection: direction });
    expect(result.prompt).toContain(direction.action);
    expect(result.prompt).toContain(direction.camera);
    expect(result.prompt).toContain(TIDEWE_VIDEO_STYLE);
    expect(result.prompt).toMatch(/silent (?:video|footage)/i);
    expect(result.prompt).not.toContain(shot.voiceover);
    expect(result.prompt).not.toContain("卧室主播卖货");
    expect(result.prompt).not.toMatch(/[\u3400-\u9fff]/);
    expect(result.negativePrompt).not.toMatch(/[\u3400-\u9fff]/);
  });

  it("uses a translated manual visual edit without mutating the original shot", () => {
    const edited = { ...shot, description: "猎人在落叶覆盖的小径边停步，低头检查鞋带。" };
    const before = structuredClone(edited);
    const translated = { action: "The hunter stops beside the leaf-covered trail and checks the laces.", camera: "Static medium shot." };
    const result = buildShotVideoPrompt({ shot: edited, ordinal: 0, creativeProfile: profile, tideweVideoDirection: translated });
    expect(result.prompt).toContain(translated.action);
    expect(result.prompt).not.toContain(direction.action);
    expect(edited).toEqual(before);
  });

  it("allows a natural face in still/grid generation without adding narration", () => {
    const presenterShot: Shot = { ...shot, description: "清晨林缘，一位戴棕色帽子的成年猎人自然露脸，面向镜头展示迷彩外套。", visualIntent: "真人正面展示装备，保持亲切自然的户外使用感。", tidewe: { ...shot.tidewe!, productVisible: true } };
    const image = compileTideweVisualPrompt(presenterShot, "image");
    expect(image.prompt).toContain(presenterShot.description);
    expect(image.prompt).toContain("允许自然露脸");
    expect(image.prompt).not.toContain(presenterShot.voiceover);
    const grid = buildStoryboardGridPrompt([presenterShot], null, { creativeProfile: profile });
    expect(grid).toContain(presenterShot.description);
    expect(grid).toContain("人物按本镜构图自然互动，细节镜不强加人脸");
    expect(grid).toContain("同 sceneId 的人物、衣物、产品状态、环境、天气与光线连续");
    expect(grid).not.toMatch(/不露脸|不含人脸|仅背影|只拍手|真人口播/);
    expect(grid).not.toContain(presenterShot.voiceover);
  });

  it("plans grid continuity by scene and refuses silent truncation", () => {
    const prompt = buildStoryboardGridPrompt([shot], null, { creativeProfile: profile });
    expect(prompt).toContain("同 sceneId");
    expect(prompt).toContain("产品不出镜");
    expect(prompt).not.toContain("同一房间、同一光线");
    expect(() => buildStoryboardGridPrompt(Array.from({ length: 10 }, () => shot), null, { creativeProfile: profile })).toThrow("不能截断");
  });

  it("keeps the legacy pure film helper silent for VO and rejects over-cap plans", () => {
    const prompt = buildStoryboardFilmPrompt([englishShot(shot)], null, { creativeProfile: profile }, { tideweVideoDirections: { [shot.shotId]: direction } });
    expect(prompt).toContain("仅生成静音视觉素材");
    expect(prompt).not.toContain(shot.voiceover);
    expect(() => buildStoryboardFilmPrompt([{ ...shot, duration: 40 }], null, { creativeProfile: profile })).toThrow("不能截断");
  });

  it("checks each measured clip including fade/tail budget", () => {
    expect(() => assertTideweMediaDuration(3, 5.45, 5)).toThrow("镜头 3");
    expect(() => assertTideweMediaDuration(3, 2, Number.NaN)).toThrow("实测时长");
    expect(() => assertTideweMediaDuration(3, 4.5, 5)).not.toThrow();
  });
});
