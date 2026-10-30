import type { Shot } from "@/lib/db/schema";
import type { TideweOutdoorProfile } from "@/lib/creative-profiles";
import { tidewePresenterAnchor, tidewePresenterReference } from "./presenter";

/** The same native-camera style governs initial frames and subsequent animation. */
export const TIDEWE_NATIVE_CAMERA_STYLE = "iPhone 8原生相机拍摄的随性影像，仅采用现有的自然环境光。保留真实的阴影细节与环境色彩；严禁使用辅助光、补光、闪光灯、反光板、轮廓光、HDR处理、美颜修饰、锐化处理、电影级调色、人工噪点或全局模糊效果。";

const TIDEWE_NATIVE_CAMERA_STYLE_PRIORITY = "分镜文字或参考图中冲突的灯光、滤镜、修饰与虚化效果服从此统一画面风格，保留本镜既定天气、时段、景别、机位、构图与动作。人物身份参考和商品参考分别锁定对应身份与商品外观，不继承其中的影棚布光或后期效果；保留自然暗部，不为提亮阴影增加照明或HDR处理。";

/** A positive rendering target, shared by grids, single frames and focus-only edits. */
export const TIDEWE_IMAGE_FOCUS_TARGET = "成像目标：手机1×主摄的自然记录照片，呈现计算式扩展景深。主体前方所有已有前景均自然合焦，包括不与支撑面相连的独立近物、草叶和画幅边缘；已有表面从底边至接触处连续清楚可读，中景结构可辨。只有主体后方的远背景可轻微自然柔化，仍保留结构。保留自然纹理和正常边缘反差，不靠加锐制造清晰。保持既定景别、机位与构图，原本留空处保持留空。";

export const TIDEWE_IMAGE_CAPTURE_POLICY = [
  TIDEWE_NATIVE_CAMERA_STYLE,
  TIDEWE_NATIVE_CAMERA_STYLE_PRIORITY,
  TIDEWE_IMAGE_FOCUS_TARGET,
  "按当前场景既定天气、时段和现有自然环境光生成首帧，未指定时使用中性自然日光，准确还原商品颜色；人物、商品与环境共享透视、色温、原生成像质感、光向及接触阴影。",
  "近景与特写也沿用共同合焦目标，真实商品、实际接触、全部已有近物和连续支撑面都自然可读；前景不因独立悬空、不承重或靠近镜头而获得失焦例外。不继承参考图的影棚光、抠图边缘或散景风格。分镜中的冲突虚化修饰服从此成像目标，保留原构图与动作。",
  "只呈现当前已有或本镜明确需要的内容，不为满足清晰要求添景、扩大构图；正常皮肤和材料纹理，不新增锐化光晕、HDR微对比或油画质感。",
].join("");

/** Shared photographic direction for initial frames, footage and local repairs. */
export const TIDEWE_PHOTOGRAPHIC_POLICY = [
  TIDEWE_NATIVE_CAMERA_STYLE,
  TIDEWE_NATIVE_CAMERA_STYLE_PRIORITY,
  "摄影基准：同伴用 iPhone 8 的1×主摄原生相机现场拍摄户外装备演示，环境自然可读。按本镜已确认的天气、时段和现有自然环境光成像，未指定时采用中性自然日光，不擅自换成阴天；准确还原商品颜色、皮肤与环境色，不刻意提亮阴影或改变原有色温。",
  "人物、产品与环境共享光线方向、色温、阴影软硬、透视和原生成像质感；本镜已有的人物与商品、商品与地面或支撑面的接触处有自然受力、遮挡与接触阴影。",
  "全身与中景采用较大景深：前景、主体周围和中景自然清楚，中远景中现有树干分叉、灌木轮廓、道路延伸或其他场景结构仍清楚可辨；最远景仅轻微自然失焦，保留空间层次，不能糊成大片色块、奶油散景或明显散景光斑。清晰度随距离平缓变化，不能沿人物或商品轮廓突然变糊，不使用人像模式蒙版虚化、长焦大光圈人像或极浅景深来突出主体。",
  "所有景别（包括低机位近景和细节特写）的近处清晰要求：画幅内已有、从画面下边缘连续延伸至主体接触位置的地面、台面或其他支撑面保持自然清楚，泥土、落叶、石粒、布面等现有纹理在正常观看尺寸下可辨；不能只让主体附近清晰，再把贴近相机的底边糊成一条虚化带。不要用前景散景、上下边缘虚化、移轴效果或渐变模糊来衬托主体。此要求只适用于当前已入画的表面，不补出地面、台面或其他景物；若分镜文字要求前景或边缘虚化，以此清晰标准为准，保留原景别、机位和动作。",
  "细节特写保持主要部件、手部接触处、支撑面及同一焦平面周边清晰；主体前方所有已有前景都自然可读，包括不与商品或支撑面相连的近处草叶、独立物体及画幅边缘。轻微自然柔化只允许出现在主体后方的远背景，现有结构仍可辨，避免微距式极浅景深。不强求远近每片叶子同样锐利，也不通过扩大构图、移动机位或添加景物来满足环境可读性；有意留空的背景保持留空。",
  "主体与环境的边缘、原生成像质感和细节强度协调；不做选择性或全局锐化，不通过局部微对比强化细节，保留身份和真实商品纹理标识，不用全图锐化补偿背景虚化，也不把主体整体糊掉。保留当前场景真实皮肤与商品材料纹理、正常对比度与边缘过渡；避免抠图边缘、橙黄滤镜、HDR微对比、锐化光晕、蜡质皮肤与油画纹理。",
].join("");

export const TIDEWE_VISUAL_NEGATIVE_PROMPT = "新增字幕、营销文字、价格卡、水印、新增Logo、说话口型、夸张叫卖表演、热成像、发光热区、透视剖面、虚构产品结构、独立电池展示、抠图白边、人物悬浮、过度背景虚化、人像模式蒙版虚化、主体周围近景糊成色块、底边前景虚化带、连续支撑面失焦、上下边缘移轴虚化、中远景糊成色块、奶油散景、明显散景光斑、极浅景深、主体与环境清晰度断层、橙黄滤镜、过度锐化、HDR光晕、油画纹理、蜡质皮肤、辅助光、补光、闪光灯、反光板、轮廓光、HDR处理、美颜修饰、锐化处理、电影级调色、人工噪点、全局模糊效果";

type VisualShot = Partial<Pick<Shot, "description" | "visualIntent" | "camera" | "tidewe" | "voiceover">>;

/** Bind native speech to the frozen copy, keeping historical offscreen narration explicit. */
export function compileTideweVisualPrompt(shot: VisualShot, kind: "image" | "video" = "video", speechMode: TideweOutdoorProfile["speechMode"] = "voiceover", presenter = shot.tidewe?.presenter, audioMode: "native" | "post" = "native", options: { includePhotographicPolicy?: boolean } = {}): { prompt: string; negativePrompt: string } {
  const productVisible = shot.tidewe?.productVisible !== false;
  const native = speechMode === "on_camera";
  const offCameraSpeech = native && shot.tidewe?.speechDelivery === "off_camera" && Boolean(shot.voiceover?.trim());
  const spoken = native && !offCameraSpeech && Boolean(shot.voiceover?.trim());
  const personVisible = spoken || shot.tidewe?.personVisible !== false;
  const description = shot.description?.trim();
  const visualIntent = shot.visualIntent?.trim();
  const visualPlan = shot.tidewe?.visualPlan;
  return {
    prompt: [
      `TIDEWE 户外装备${personVisible ? "真人展示与真实使用" : "产品细节与环境"}${kind === "image" ? "关键帧" : "视频素材"}，采用自然的 TikTok 户外产品演示风格。画面服从本镜语义，保持真实场景与动作。`,
      options.includePhotographicPolicy !== false ? kind === "image" ? TIDEWE_IMAGE_CAPTURE_POLICY : TIDEWE_PHOTOGRAPHIC_POLICY : "",
      kind === "video" ? "转动态时全程保持上述 iPhone 8 原生相机画面风格，维持已确认首帧的构图、场景、人物与商品既有状态，以及自然光线、环境色彩、真实阴影、曝光与材质细节；按本镜要求发展动作，不在动作或运镜过程中新增照明、滤镜、锐化、人工噪点、全局模糊效果或人为虚化。" : "",
      description ? `本镜画面：${description}` : "本镜为自然户外环境建立画面。",
      visualIntent ? `视觉意图补充：${visualIntent}` : "",
      shot.tidewe?.shotGoal ? `画面目标：${shot.tidewe.shotGoal}` : "",
      shot.camera?.trim() ? `运镜/构图：${shot.camera.trim()}` : "",
      visualPlan ? `已确认景别：${({ wide: "全景／使用空间", medium: "中景／人物与装备交流", close_up: "近景／较大操作区域", detail: "特写／局部部件与接触" })[visualPlan.framing]}；画面任务：${({ presenter: "人物交流", demonstration: "真实使用演示", detail: "可见细节观察", context: "使用情境与空间关系" })[visualPlan.visualRole]}。` : "",
      productVisible && visualPlan?.productFocus ? `本镜商品观察对象：${visualPlan.productFocus}。该商品或部位必须清楚入画，画幅与构图须实际容纳观察对象和所需接触位置；单独的人脸、空手手势或环境不能替代商品画面。只呈现参考支持的外观与普通使用，不把可见外观当作性能测试结论。` : "",
      visualPlan ? kind === "image"
        ? `首帧已有状态：${visualPlan.actionStart}。本格只画这一瞬，不把后续动作或结束状态拼入首帧；为后续「${visualPlan.action}」保留操作空间。`
        : `动作起点：${visualPlan.actionStart}。本镜动作：${visualPlan.action}。自然结束：${visualPlan.actionEnd}。按正常速度完成一次后停稳；静态观察保持既有状态，不编造额外动作。` : "",
      personVisible && presenter ? `固定出镜人物：${tidewePresenterAnchor(presenter)}。只使用这位主播，不另行生成其他年龄、性别、发型、胡须或面容设定。${tidewePresenterReference({ presenter }) ? "主播参考图优先锁定身份、脸型、发型和体型；文字描述辅助解释，不将人物参考图中的背景、分格或边框带入场景。商品参考图只锁商品，不能替换主播身份。" : "严格沿用保存的主播外貌描述。"}` : "",
      !personVisible ? "本镜为无人出镜的产品或环境空镜，不加入主播、路人、人脸或手；所选主播参考仅供其他人物镜头使用。" : "",
      shot.tidewe?.sceneId ? `连续场景标识 ${shot.tidewe.sceneId}：同场景${personVisible ? "人物的面容、年龄感、发型、帽子、服装、" : ""}产品状态、天气与光线连续。` : `同一连续场景保持${personVisible ? "人物的面容、年龄感、发型、帽子、服装、" : ""}产品状态、天气与光线一致。`,
      productVisible
        ? "产品可见：使用当前商品参考锁定轮廓、比例、迷彩、颜色、拉链、门窗、按钮、Logo及部件连接；只展示参考支持的结构和简单真实动作，不推断隐藏接口、热区、温度或性能。固定件不移动，运动件保持真实连接。"
        : "产品不出镜：这是环境或相关行动镜头，不植入商品、品牌Logo或相似装备冒充当前产品；商品参考只锁其他产品镜，不改变本镜语义。",
      spoken
        ? "本镜为写实成年户外使用者真人口播，同时自然展示或操作装备。人物面向镜头，嘴部清晰可见；遵循本镜景别，可用胸上近景、腰上中景、膝上中全景或同时容纳整件装备与清晰面部的全景，不将所有镜头固定成半身。视线自然回应镜头，需要演示时让手指、目光和实际产品部位相互对应，动作不能妨碍说话。商品靠近镜头时保持真实比例与面部可见，不遮嘴。同场景保持同一人的面容、声线、美式英语口音与语速。"
        : offCameraSpeech
          ? "本镜由同一成年主播画外讲解，画面按已保存构图展示实际操作、产品细节或环境，不要求出现脸部或嘴部；有人出镜时自然安静操作，不做可见说话或口型同步。局部手部镜头保持所选主播的衣袖与体型连续，不为露出人脸改变景别。"
          : personVisible ? "本镜需要人物时，采用写实真人出镜，允许自然露脸；可面向镜头展示装备，自然穿戴、操作、坐下体验或与产品互动。按本镜构图呈现人物，产品细节与环境空镜不强加人脸。" : "",
      kind === "image"
        ? `画面是动作开始前可独立使用的关键帧。${spoken ? "口播人物正面或轻微侧脸、嘴部清楚可见，适合后续生成开口说话的视频。静态画面不绘制对白或字幕。" : ""}`
        : offCameraSpeech
          ? audioMode === "post"
            ? "Generate silent video for the exact frozen narration to be added in post. Follow the approved visual action and framing. Any visible person performs silently with no speaking or lip synchronization; do not add a face or mouth to a detail-only shot. No audio track. No dialogue. No music. No sound effects."
            : `Generate native audio and video with off-camera narration. The same established adult presenter voice must narrate the following exact US English script once, in order, with no added, omitted or paraphrased words. Keep that voice, accent and conversational pace consistent with the other shots. Complete the entire line within this clip, with a brief natural pause at each end. Any visible person performs silently; no visible speaking, lip synchronization or additional speakers. Preserve the approved framing, including detail-only or person-free shots. No music or extra dialogue. Exact spoken text (JSON string): ${JSON.stringify(shot.voiceover!.trim())}`
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
    negativePrompt: spoken ? TIDEWE_VISUAL_NEGATIVE_PROMPT.replace("说话口型、", "") + "、口播时闭嘴、声画错位、口型不匹配、口部遮挡、额外对白、背景音乐" : TIDEWE_VISUAL_NEGATIVE_PROMPT,
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
