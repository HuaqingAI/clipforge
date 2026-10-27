import type { Shot } from "@/lib/db/schema";
import type { TideweOutdoorProfile } from "@/lib/creative-profiles";
import { tidewePresenterAnchor, tidewePresenterReference } from "./presenter";

export const TIDEWE_VISUAL_NEGATIVE_PROMPT = "新增字幕、营销文字、价格卡、水印、新增Logo、说话口型、夸张叫卖表演、热成像、发光热区、透视剖面、虚构产品结构、独立电池展示";

type VisualShot = Partial<Pick<Shot, "description" | "visualIntent" | "camera" | "tidewe" | "voiceover">>;

/** Bind native speech to the frozen copy, keeping historical offscreen narration explicit. */
export function compileTideweVisualPrompt(shot: VisualShot, kind: "image" | "video" = "video", speechMode: TideweOutdoorProfile["speechMode"] = "voiceover", presenter = shot.tidewe?.presenter, audioMode: "native" | "post" = "native"): { prompt: string; negativePrompt: string } {
  const productVisible = shot.tidewe?.productVisible !== false;
  const native = speechMode === "on_camera";
  const spoken = native && Boolean(shot.voiceover?.trim());
  const personVisible = spoken || shot.tidewe?.personVisible !== false;
  const description = shot.description?.trim();
  const visualIntent = shot.visualIntent?.trim();
  return {
    prompt: [
      `TIDEWE 户外装备${personVisible ? "真人展示与真实使用" : "产品细节与环境"}${kind === "image" ? "关键帧" : "视频素材"}，采用自然的 TikTok 户外产品演示风格。画面服从本镜语义，保持真实场景与动作。`,
      description ? `本镜画面：${description}` : "本镜为自然户外环境建立画面。",
      visualIntent ? `视觉意图补充：${visualIntent}` : "",
      shot.tidewe?.shotGoal ? `画面目标：${shot.tidewe.shotGoal}` : "",
      shot.camera?.trim() ? `运镜/构图：${shot.camera.trim()}` : "",
      personVisible && presenter ? `固定出镜人物：${tidewePresenterAnchor(presenter)}。只使用这位主播，不另行生成其他年龄、性别、发型、胡须或面容设定。${tidewePresenterReference({ presenter }) ? "主播参考图优先锁定身份、脸型、发型和体型；文字描述辅助解释，不将人物参考图中的背景、分格或边框带入场景。商品参考图只锁商品，不能替换主播身份。" : "严格沿用保存的主播外貌描述。"}` : "",
      !personVisible ? "本镜为无人出镜的产品或环境空镜，不加入主播、路人、人脸或手；所选主播参考仅供其他人物镜头使用。" : "",
      shot.tidewe?.sceneId ? `连续场景标识 ${shot.tidewe.sceneId}：同场景${personVisible ? "人物的面容、年龄感、发型、帽子、服装、" : ""}产品状态、天气与光线连续。` : `同一连续场景保持${personVisible ? "人物的面容、年龄感、发型、帽子、服装、" : ""}产品状态、天气与光线一致。`,
      productVisible
        ? "产品可见：使用当前商品参考锁定轮廓、比例、迷彩、颜色、拉链、门窗、按钮、Logo及部件连接；只展示参考支持的结构和简单真实动作，不推断隐藏接口、热区、温度或性能。固定件不移动，运动件保持真实连接。"
        : "产品不出镜：这是环境或相关行动镜头，不植入商品、品牌Logo或相似装备冒充当前产品；商品参考只锁其他产品镜，不改变本镜语义。",
      spoken
        ? "本镜为写实成年户外使用者真人口播，同时自然展示或操作装备。人物面向镜头，嘴部清晰可见；中近景或半身构图同时兼顾人物和本镜产品细节。避免背影、远景、遮嘴的面罩或遮挡口部的商品；动作不能妨碍说话。同场景保持同一人的面容、声线、美式英语口音与语速。"
        : personVisible ? "本镜需要人物时，采用写实真人出镜，允许自然露脸；可面向镜头展示装备，自然穿戴、操作、坐下体验或与产品互动。按本镜构图呈现人物，产品细节与环境空镜不强加人脸。" : "",
      kind === "image"
        ? `画面是动作开始前可独立使用的关键帧。${spoken ? "口播人物正面或轻微侧脸、嘴部清楚可见，适合后续生成开口说话的视频。静态画面不绘制对白或字幕。" : ""}`
        : spoken
          ? audioMode === "post"
            ? `Generate silent video for narration added in post. The visible adult presenter must visibly articulate the following exact US English script once, in order, with no added, omitted or paraphrased words. Their lips, jaw and mouth must move naturally and match the English phonemes, syllables, pauses and timing as closely as possible. Start and finish the entire line within this clip, leaving a brief natural pause at each end. Do not generate an audio track; the exact English narration will be added automatically during composition. Exact spoken text (JSON string): ${JSON.stringify(shot.voiceover!.trim())}`
            : `Generate native synchronized audio and video. The visible adult presenter must speak the following exact US English script once, in order, with no added, omitted or paraphrased words. Their lips, jaw and mouth must move throughout the actual speech and match the English phonemes, syllables, pauses and timing as closely as possible; keep the speech audible and visibly articulated, with accurate lip timing. Start and finish the entire line within this clip, leave a brief natural pause at each end, and do not cut off the last word. Natural conversational delivery with a consistent voice; no music, extra dialogue or other speakers. Exact spoken text (JSON string): ${JSON.stringify(shot.voiceover!.trim())}`
          : native
            ? `本镜没有口播文案：不编造对白或说话口型，无音乐；${audioMode === "post" ? "仅生成静音视觉素材和一个清晰真实动作。" : "只保留轻微自然环境声和一个清晰真实动作。"}`
            : "人物演示与口播音轨分开，不生成说话口型或额外对白。英文画外旁白由后期统一添加。仅生成静音视觉素材，无对白、口播、音乐和音效；一个清晰动作由起点自然发展到终点，避免无目的转头和复杂动作。",
      !native && kind === "image" ? "人物演示与口播音轨分开，不生成说话口型或额外对白。英文画外旁白由后期统一添加。" : "",
      "不新增屏幕文字、字幕、营销字、价格、购买条或水印；只保留参考中真实产品已有标识。不生成热成像、发光热区、透视剖面、浸泡带电系统或无依据效果测试。首版不展示独立电池，尤其不得暗示 HJ006 随附电池。",
    ].filter(Boolean).join("\n"),
    negativePrompt: native ? TIDEWE_VISUAL_NEGATIVE_PROMPT.replace("说话口型、", "") + "、口播时闭嘴、声画错位、口型不匹配、口部遮挡、额外对白、背景音乐" : TIDEWE_VISUAL_NEGATIVE_PROMPT,
  };
}

/** Fail instead of freezing a short video or trimming the last spoken word. */
export function assertTideweMediaDuration(shotId: number, required: number, source: number): void {
  if (!Number.isFinite(required) || required <= 0 || !Number.isFinite(source) || source <= 0) {
    throw new Error(`镜头 ${shotId} 无法取得有效实测时长，请检查音频和视频文件后重试。`);
  }
  if (required > source + 0.01) {
    throw new Error(`镜头 ${shotId} 需要 ${required.toFixed(2)} 秒，视频可用时长仅 ${source.toFixed(2)} 秒；请补长/重生成此镜头，或缩短文案后重新规划。`);
  }
}
