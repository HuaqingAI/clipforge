/**
 * Motion-prompt engine for image-to-video (i2v) generation — the quality lever of the i2v main path.
 *
 * Why this exists: the script engine already writes a per-shot `camera` movement description
 * (推拉摇移 language), but the i2v call used to send the shot's STATIC image prompt instead —
 * scene wording with zero motion language, which yields bland or unpredictable movement.
 * i2v models (Seedance 2.0 family) take composition/subject from the first frame; the text
 * prompt's job is to direct MOTION: camera path + subject micro-action + stability constraints.
 *
 * Rules encoded here (commerce-specific):
 *  - Camera: prefer the script's own `camera` field; fall back to a per-shot-type default move.
 *  - Subject micro-action per shot type: bring the frame alive WITHOUT re-imagining the scene.
 *  - Product shots get hard fidelity constraints (i2v models notoriously warp printed text/logos).
 *  - Always close with stability/artifact constraints — cheap wins against flicker & morphing.
 *  - Bilingual: follows the script language (CJK → Chinese prompt, otherwise English), because
 *    overseas projects generate English scripts and mixing languages degrades model adherence.
 *
 * Pure functions, unit-testable, no I/O.
 */
import type { Shot } from "@/lib/db/schema";
import { REAL_FACE_CONSTRAINT } from "@/lib/presenters";
import { emotionActingLine, shotEmotion } from "@/lib/emotion-acting";
import type { ProductCategory } from "@/lib/script-engine/templates";
import { joinVideoPromptParts } from "@/lib/video-prompt";
import { VIDEO_AUDIO_DIRECTIONS, type VideoAudioMode } from "@/lib/video-audio";
import { isPremiumProductCgProfile } from "@/lib/creative-profiles";

/** Camera-movement amplitude tier (Kling-style enumerated intensity instead of free text). */
export type MotionIntensity = "subtle" | "normal" | "strong";

export interface MotionPromptInput {
  /** Shot type drives the default camera move + subject micro-action */
  shotType?: Shot["type"] | string;
  /** The script engine's camera movement description (e.g. "特写 + 缓慢推近"); preferred over defaults */
  camera?: string;
  /** Complete scene direction, including exact display text and qualifications. Never truncate it. */
  description?: string;
  /** Select one consistent sound direction; "none" leaves audio to the caller. */
  audioMode?: VideoAudioMode;
  /** Apply product-fidelity constraints (product visible in frame — logo/text must not warp) */
  productShot?: boolean;
  /**
   * Keyframe-chained generation: the clip's last
   * frame is pinned to the NEXT shot's keyframe, so the shot ends by flowing into the next scene —
   * the transition is generated inside the clip and the composer's hard concat becomes seamless.
   */
  chainToNext?: boolean;
  /** Camera amplitude tier; "normal" (default) keeps the baseline wording unchanged */
  intensity?: MotionIntensity;
  /**
   * A cast character is on camera in this shot: append the anti-"AI face" realism
   * constraint so the model renders an ordinary person, not a polished influencer face.
   */
  personShot?: boolean;
  /**
   * The on-camera character is SPEAKING this shot (has a voiceover line): replace the
   * generic micro-action with talking direction (mouth movement, blinks, one micro-pause)
   * plus two behavior beats. Beats rotate per shot via `beatSeed` — repeating the same
   * gestures across a batch is the biggest AI tell.
   */
  talking?: boolean;
  /** Deterministic seed (e.g. shot index) picking which two behavior beats this shot gets */
  beatSeed?: number;
  /**
   * Global visual-look lighting anchor (see look-presets.ts): a SHORT bilingual line that
   * pins the lighting/palette through the i2v pass — i2v models drift lighting when
   * unspecified, which breaks look consistency across chained shots.
   */
  look?: { zh: string; en: string };
  /**
   * Camera-identity opener from a "real"-family look preset — PREPENDED as the prompt's
   * first phrase (front tokens weigh most: "UGC creator, handheld phone footage" up front
   * biases the whole generation toward the phone-shot distribution).
   */
  opener?: { zh: string; en: string };
  /**
   * Project product category (free string from the DB; unknown values are ignored).
   * Unlocks the category physical-realism layers:
   *  - category fidelity constraint (productShot): what "intact" means for THIS material
   *  - physical-interaction phrase (demo/product_reveal): action + material reaction
   *  - only phrases grounded in the script are eligible for deterministic beatSeed rotation
   */
  category?: string;
  /**
   * Physical-realism layer tier (user-selectable, single choice):
   *  - "auto" (default): all layers — category constraint + interaction phrase +
   *    living background + hair/fabric inertia + emotion process
   *  - "constraints": category fidelity constraint only (no added motion phrases)
   *  - "off": none of the realism layers (legacy prompt shape)
   * Defaults to "auto" so every hands-off chain gets the quality layers without wiring.
   */
  realism?: MotionRealismTier;
  /**
   * Optional project creative profile. The motion compiler only needs the premium-CG
   * identity here, so callers may pass the persisted profile or the compatibility
   * shape used by older clients (`profileId`).
   */
  creativeProfile?: unknown;
  /**
   * Compatibility policy for callers that have not loaded the persisted profile yet.
   * `generatedFrameText: "forbid-added"` opts into the same no-added-text motion path.
   */
  outputPolicy?: MotionPromptOutputPolicy;
}

/** Realism-layer tier for buildMotionPrompt (a user-facing single-select). */
export type MotionRealismTier = "auto" | "constraints" | "off";

/** The small policy surface consumed by the image-to-video prompt compiler. */
export interface MotionPromptOutputPolicy {
  id?: string;
  profileId?: string;
  creationType?: string;
  generatedFrameText?: "forbid-added" | string;
  textPolicy?: "forbid-added" | { generatedFrameText?: "forbid-added" | string };
}

/** True when the text contains CJK characters (used to pick the prompt language). */
function hasCjk(s: string): boolean {
  return /[一-鿿぀-ヿ가-힯]/.test(s);
}

/** Per-shot-type default camera move — used only when the script didn't provide one. */
const CAMERA_DEFAULTS: Record<string, { zh: string; en: string }> = {
  hook: { zh: "镜头快速推近主体，开场抓眼", en: "camera pushes in fast on the subject, punchy opening" },
  pain_point: { zh: "镜头缓慢推近，带轻微手持感", en: "slow push-in with a subtle handheld feel" },
  product_reveal: { zh: "镜头围绕商品缓慢环绕移动，高光沿商品表面流动", en: "camera orbits the product slowly, highlights sweeping across its surface" },
  demo: { zh: "镜头平稳跟随演示动作，适时贴近特写细节", en: "camera smoothly follows the demonstration, moving in for close-up details" },
  social_proof: { zh: "镜头缓慢横移扫过画面", en: "slow lateral tracking shot across the scene" },
  cta: { zh: "镜头缓慢推近，聚焦主体", en: "slow push-in, focusing on the subject" },
};

const CAMERA_FALLBACK = { zh: "镜头缓慢推近主体", en: "slow push-in on the subject" };

/** Per-shot-type subject micro-action — animates the still frame without re-imagining the scene. */
const ACTION_DEFAULTS: Record<string, { zh: string; en: string }> = {
  hook: { zh: "画面主体动态醒目、能量感强", en: "the subject moves eye-catchingly with high energy" },
  pain_point: { zh: "主体已有动作自然连贯，保持原图场景", en: "the subject's existing actions remain natural and coherent within the original scene" },
  product_reveal: { zh: "保持商品原有外观与结构，仅呈现分镜已描述的动作", en: "preserve the product's original appearance and structure, showing only the actions described in the shot" },
  demo: { zh: "保持原图主体与构图，仅呈现分镜已描述的动作", en: "preserve the original subject and composition, showing only the actions described in the shot" },
  social_proof: { zh: "保持画面已有元素，已描述动作自然连贯", en: "preserve existing scene elements, keeping the described actions natural and coherent" },
  cta: { zh: "主体稳定醒目，画面收束聚焦", en: "the subject stays prominent and stable as the frame settles" },
};

const ACTION_FALLBACK = { zh: "画面自然生动，主体动作连贯", en: "the scene comes alive naturally with coherent subject motion" };

/**
 * Talking-shot subject direction — replaces the per-type micro-action when the character
 * speaks. Written as visible speech behavior (mouth movement, blinks, one beat of hesitation),
 * NOT lip-sync to specific words: the voice track is TTS overlaid by the composer, so the clip
 * only needs to read as "a person mid-conversation".
 */
const TALKING_ACTION = {
  zh: "人物对着镜头自然说话：口型自然开合，自然眨眼与头部微动，说到一半有一次极短的停顿、一次视线短暂离开镜头再回来",
  en: "the person talks naturally to camera: natural mouth movement, blinks and small head motions, one brief mid-sentence pause, eyes drift away once and return",
};

/**
 * Behavior-beat pool for talking shots. Each shot gets two, rotated by beatSeed —
 * identical gestures repeated across a batch read as AI immediately.
 */
const BEHAVIOR_BEATS: { zh: string; en: string }[] = [
  { zh: "说话间瞥了一眼旁边", en: "glances off to the side mid-sentence" },
  { zh: "身体略微后移，再回到原来的姿态", en: "leans back briefly, then returns to the original posture" },
  { zh: "轻轻耸了下肩", en: "gives a small shrug" },
  { zh: "双手短暂调整姿势后自然放松", en: "briefly adjusts the hands, then relaxes them naturally" },
  { zh: "视线短暂移向画外再回到镜头", en: "briefly looks off-screen, then returns their gaze to the camera" },
  { zh: "说完自己先半笑了一下", en: "breaks into a half-smile at their own words" },
];

/** Pick two distinct behavior beats deterministically from the seed (adjacent picks avoid repeats). */
export function pickBehaviorBeats(seed: number, lang: "zh" | "en"): string[] {
  const n = BEHAVIOR_BEATS.length;
  const i = ((Math.floor(seed) % n) + n) % n;
  const j = (i + 1 + (((Math.floor(seed / n) % (n - 1)) + (n - 1)) % (n - 1))) % n;
  return [BEHAVIOR_BEATS[i][lang], BEHAVIOR_BEATS[j][lang]];
}

/** Product-fidelity constraint (printed text & logos are the first thing i2v models destroy). */
const PRODUCT_CONSTRAINT = {
  zh: "商品的外观、包装、颜色、logo 与文字必须保持完全不变，文字清晰不扭曲变形",
  en: "the product's appearance, packaging, colors, logo and printed text must remain exactly unchanged, text stays sharp and undistorted",
};

/**
 * Category-specific fidelity constraints — what "intact" physically means for THIS
 * material class. The generic PRODUCT_CONSTRAINT protects print/logo; these protect the
 * failure mode each category actually exhibits (cream clumping, food crumbling, fabric
 * stiffening, glare on metal). Positive-phrased state descriptions, not negative lists.
 */
const CATEGORY_CONSTRAINTS: Record<Exclude<ProductCategory, "tech">, { zh: string; en: string }> = {
  beauty: {
    zh: "已有膏体与液体质地保持均匀顺滑，形态稳定不结块",
    en: "existing cream and liquid textures stay smooth and even, holding their shape without clumping",
  },
  food: {
    zh: "食物色泽鲜亮自然、纹理清晰，形态完整不塌不散",
    en: "food keeps vivid natural color and clear texture, holding its shape without collapsing or crumbling",
  },
  home: {
    zh: "已有接缝与结构稳定对齐，部件形态保持完整",
    en: "existing seams and structure stay aligned and stable, with the parts retaining their shape",
  },
  fashion: {
    zh: "已有面料保持自然垂坠与柔软真实的褶皱",
    en: "existing fabric keeps its natural drape and soft believable creases",
  },
};

/**
 * Physical-interaction phrase pool: "action + material reaction" pairs per category.
 * A demo shot that shows the material RESPONDING (spring-back, crumbs, ripple, glide)
 * reads as real footage; an action with no material feedback reads as CG. Rotated by
 * beatSeed — identical interactions across a batch are an instant AI tell.
 */
const PHYSICAL_ACTION_LEXICON: Record<ProductCategory, { zh: string; en: string }[]> = {
  beauty: [
    { zh: "指腹蘸取膏体缓缓推开，质地在皮肤上自然延展服帖", en: "a fingertip spreads the cream slowly, the texture gliding open and settling onto the skin" },
    { zh: "按压泵头挤出一滴，液体落在手背缓缓铺开", en: "one pump releases a drop that lands and spreads slowly on the back of the hand" },
    { zh: "拧开瓶盖，膏体表面平整光洁泛着柔光", en: "the cap twists off to reveal a smooth untouched surface with a soft sheen" },
  ],
  food: [
    { zh: "掰开的瞬间外层酥脆掉渣，断面组织分明", en: "it snaps open with crisp flakes falling, the cross-section clearly layered" },
    { zh: "热气从表面缓缓升起，酱汁沿边缘慢慢流下", en: "steam rises gently from the surface while sauce runs slowly down the edge" },
    { zh: "夹起时微微颤动，质地饱满有弹性", en: "it quivers slightly when lifted, plump and springy" },
  ],
  home: [
    { zh: "开合部件顺滑归位，动作干净利落", en: "the moving part glides shut cleanly and precisely" },
    { zh: "手掌按压表面，材质轻微回弹恢复原状", en: "a palm presses the surface, which flexes slightly and springs back" },
    { zh: "水流冲过表面，水珠顺着材质纹理滑落", en: "water runs over the surface, beading and sliding along the texture" },
  ],
  fashion: [
    { zh: "转身时衣摆自然摆动后垂落回位", en: "the hem swings out on the turn, then settles back naturally" },
    { zh: "手指捏起面料轻轻一放，褶皱缓缓回弹展开", en: "fingers pinch and release the fabric, the crease easing back open slowly" },
    { zh: "行走时面料随步伐轻微起伏", en: "the fabric ripples subtly with each step" },
  ],
  tech: [
    { zh: "手指滑过屏幕，界面跟手流畅响应", en: "a finger swipes across the screen, the interface responding fluidly" },
    { zh: "耳机放入充电仓，磁吸轻轻归位", en: "the earbud drops into the case, snapping gently into place magnetically" },
    { zh: "转动机身，金属边框上一道高光缓缓扫过", en: "the device rotates as a single highlight sweeps along the metal edge" },
  ],
};

/** Shot types that demonstrate the product physically (get a physical-interaction phrase). */
const PHYSICAL_ACTION_TYPES = new Set(["demo", "product_reveal"]);

/**
 * Living-background pool: ONE named background element with its own ongoing state.
 * AI clips die behind the subject — a frozen backdrop reads as a rendered set. One
 * element is enough; more turns the background busy and steals focus.
 */
const LIVING_BG: { zh: string; en: string }[] = [
  { zh: "背景里窗帘随气流轻轻晃动", en: "curtains in the background sway gently in the airflow" },
  { zh: "背景虚化处有人自然走过，不抢主体", en: "someone drifts through the blurred background without pulling focus" },
  { zh: "背景一盏灯的光斑有细微的明暗呼吸", en: "a lamp's glow in the background breathes subtly brighter and dimmer" },
  { zh: "桌上一杯热饮冒着若有若无的热气", en: "a hot drink nearby gives off a faint wisp of steam" },
  { zh: "窗外光线随云层缓慢变化", en: "the light from the window shifts slowly as clouds pass" },
  { zh: "背景绿植的叶片偶尔轻颤", en: "leaves of a background plant tremble now and then" },
];

/** Hair/fabric inertia — secondary motion lag is the cheapest "real physics" signal on a person. */
const FABRIC_HAIR_LAG = {
  zh: "人物移动或转头时，头发与衣料带一点滞后的摆动再自然落回",
  en: "when the person moves or turns, hair and fabric lag slightly then settle back naturally",
};

/** Deterministic pool pick shared by the category/background layers (same contract as pickBehaviorBeats). */
function pickFrom<T>(pool: T[], seed: number): T {
  const n = pool.length;
  return pool[((Math.floor(seed) % n) + n) % n];
}

/** Normalize the free-form DB category string to a known category (undefined otherwise). */
function normalizeCategory(category: string | undefined): ProductCategory | undefined {
  return category && Object.hasOwn(PHYSICAL_ACTION_LEXICON, category) ? (category as ProductCategory) : undefined;
}

/** Universal stability/artifact tail — cheap, consistent win against flicker and morphing. */
const QUALITY_TAIL = {
  zh: "画面稳定流畅，光影自然过渡，无闪烁、无变形、不出现新物体",
  en: "stable smooth footage, natural lighting transitions, no flicker, no morphing, no new objects appearing",
};

/** Chained-clip guidance: direct the in-clip transition toward the pinned last frame. */
const CHAIN_GUIDANCE = {
  zh: "镜头在结尾自然运镜过渡到指定的尾帧画面，过渡连贯流畅、一气呵成，不跳切",
  en: "the camera moves naturally into the specified last frame at the end, one continuous fluent transition, no jump cut",
};

/**
 * Continuous-single-take declaration (Seedance official guidance: without it the model may cut
 * mid-clip, which breaks per-shot semantics — each of our clips must be exactly one take).
 * Mutually exclusive with CHAIN_GUIDANCE: a chained clip ends by transitioning INTO the next
 * scene, so "no scene changes" would contradict the chain instruction.
 */
const SINGLE_SHOT = {
  zh: "整段为连续单镜头拍摄，中途不切镜、不转场",
  en: "one continuous single take throughout, no cuts, no scene changes",
};

/** Camera amplitude wording per intensity tier ("normal" keeps the baseline prompt unchanged). */
const INTENSITY_LINES: Record<Exclude<MotionIntensity, "normal">, { zh: string; en: string }> = {
  subtle: { zh: "运镜幅度轻微克制，移动缓慢平稳", en: "camera movement stays subtle and restrained, slow and steady" },
  strong: { zh: "运镜幅度大胆明显，节奏利落有冲击力", en: "bold pronounced camera movement, brisk impactful pacing" },
};

/** Camera-hold keywords (a locked-off camera instruction). */
const STATIC_CAMERA_RE = /^\s*(?:static|fixed|locked(?:[- ]off)?|固定|静止|锁定)[。.!]?\s*$|(?:固定|静止|锁定)(?:镜头|机位|相机)|(?:镜头|机位|相机)[^，,。;；\n]{0,8}(?:固定|静止|锁定|不动)|(?:fixed|static|locked(?:[- ]off)?)\s+(?:camera|shot)|camera\s+(?:stays?\s+)?(?:fixed|static|locked)|locked[- ]off/i;
/** Continuous camera-movement keywords. */
const MOVING_CAMERA_RE =
  /环绕|环拍|推近|推进|拉远|拉近|横移|平移|摇镜|摇臂|甩镜|跟随|跟拍|升降|俯冲|orbit|push[- ]?in|pull[- ]?back|dolly|pan|tilt|track|crane|zoom|whip/i;
/** Sequencing markers that legitimise combining hold + move (e.g. "推近后固定" = push in, then hold). */
const SEQUENCE_RE = /先|后|然后|随后|接着|再|最后|结尾|开场|开头|then|after|before|finally|ending|start/i;

/**
 * Conflict lint for scripted camera text (Seedance docs: contradictory instructions like
 * "固定镜头" + "环绕" in one prompt produce jerky, indecisive motion). A hold + move combo is a
 * conflict ONLY without a sequencing marker — "push in then hold" is valid direction.
 */
export function hasCameraConflict(camera: string): boolean {
  const direction = unquoted(camera);
  return STATIC_CAMERA_RE.test(direction) && MOVING_CAMERA_RE.test(positiveEvidence(direction)) && !SEQUENCE_RE.test(direction);
}

/** Display text must not be mistaken for evidence of objects or actions in the scene. */
function unquoted(text: string): string {
  return text.replace(/“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"\n]*"/g, "");
}

/** A prohibition such as "不要添加屏幕" does not establish that a screen is present. */
function positiveEvidence(text: string): string {
  return unquoted(text).split(/[，,。;；!?！？\n]/).filter((clause) =>
    !/(?:不|禁止|避免|无需|没有|未出现)|\b(?:no|not|without|avoid|never|don't)\b/i.test(clause),
  ).join("；");
}

const STILL_SUBJECT_RE = /(?:商品|产品|主体|机身|杯身)[^，,。;；\n]{0,16}(?:静止|静置|不动|不转动|不旋转)|(?:product|subject|device|cup)\b[^,.;\n]{0,35}\b(?:still|stationary|static|motionless)\b/i;
const SOLID_BACKGROUND_RE = /背景[^，,。;；\n]{0,20}(?:纯色|纯净|单色)|(?:纯色|纯净|单色)[^，,。;；\n]{0,12}背景|\b(?:solid|plain|uniform|seamless)\b[^,.;\n]{0,25}\bbackground\b/i;
const HAND_EVIDENCE_RE = /手部|手指|手掌|双手|单手|\bhands?\b|\bfingers?\b/i;
const STATIC_ACTION = {
  zh: "主体保持静止，画面文字清晰稳定",
  en: "the subject remains still, with sharp and stable on-screen text",
};

/**
 * Premium furniture CG intentionally has a different static-shot contract. The
 * legacy line above protects commerce labels in a product shot; using it for CG
 * actively asks a video model to draw new pixels of copy. Keep product markings
 * that are already present in the reference, but never ask for new copy.
 */
const PREMIUM_CG_STATIC_ACTION = {
  zh: "主体保持稳定，材质纹理、自然光影与反射平稳真实",
  en: "the subject remains stable with steady, realistic material texture, natural light, and reflections",
};
const PREMIUM_CG_ACTION = {
  zh: "产品形体与材质细节保持克制稳定，只呈现分镜已描述的动作",
  en: "the product form and material details stay calm and stable, showing only the action already described in the shot",
};
const PREMIUM_CG_CAMERA_DEFAULT = {
  zh: "镜头克制缓慢推进或短距离横移，只展示参考图可支持的产品可见角度",
  en: "a restrained slow push-in or short lateral move, limited to product angles supported by the reference",
};
const PREMIUM_CG_NO_ADDED_TEXT = {
  zh: "不生成新增的画面文字、字幕、数字、价格、图形卡片或水印；只保留参考图中已有的产品标识",
  en: "do not generate added on-screen text, subtitles, numbers, prices, graphic cards, or watermarks; preserve only product markings already present in the reference",
};
const PREMIUM_CG_REFERENCE_LIMIT = {
  zh: "运镜缓慢克制，严格受参考图可见结构和角度限制，不编造未展示的结构或功能",
  en: "keep camera movement slow and restrained, limited to visible reference structure and angles; do not invent unseen construction or functions",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accept both the canonical nested policy and the temporary flat compatibility form. */
function forbidsAddedFrameText(policy: unknown): boolean {
  if (policy === "forbid-added") return true;
  if (!isRecord(policy)) return false;
  if (policy.generatedFrameText === "forbid-added" || policy.textPolicy === "forbid-added") return true;
  return isRecord(policy.textPolicy) && policy.textPolicy.generatedFrameText === "forbid-added";
}

/**
 * Returns true for the canonical premium-CG profile and the flat policy shapes used by
 * older clients. Prompt adapters use this rather than making their own policy guesses.
 */
export function isPremiumCgPromptPolicy(value: unknown): boolean {
  return isPremiumProductCgProfile(value) || forbidsAddedFrameText(value);
}

function usesPremiumCgPolicy(input: MotionPromptInput): boolean {
  return isPremiumCgPromptPolicy(input.creativeProfile) || isPremiumCgPromptPolicy(input.outputPolicy);
}

const CG_TEXT_DIRECTIVE_RE = /文字|字幕|文案|价格|标价|数字标签|图形卡片|购买|下单|二维码|水印|\b(?:on[- ]screen text|subtitles?|copy|price|cta|buy now|qr code|watermark)\b/i;
const NEGATED_CG_TEXT_DIRECTIVE_RE = /不要|禁止|避免|无(?:需|文字|字幕)|不(?:要|生成|添加|显示)|\b(?:no|not|without|avoid|never|do not)\b/i;

/**
 * Existing sales descriptions often contain a whole sentence telling the model
 * where to draw a price, CTA or subtitle. Do not pass those positive directives
 * into a premium-CG motion prompt. Product logos/markings are covered by the
 * dedicated preservation constraint and are not matched here.
 */
function removePremiumCgTextDirectives(description: string): string {
  const kept = description
    .split(/(?<=[。！？.!?])|\n/)
    .filter((clause) => !(CG_TEXT_DIRECTIVE_RE.test(clause) && !NEGATED_CG_TEXT_DIRECTIVE_RE.test(clause)))
    .map((clause) => clause.trim())
    .filter(Boolean);
  return kept.join(" ");
}

/** Remove obvious sales/copy drawing directives before a premium-CG prompt reaches a provider. */
export function sanitizePremiumCgVisualText(value: unknown): string {
  return removePremiumCgTextDirectives(typeof value === "string" ? value.trim() : "");
}

// Each candidate needs both its object/material AND its action in the script. Category or seed
// alone never establishes a screen, an earbud, a lamp, or a new demonstration.
const PHYSICAL_EVIDENCE: Record<ProductCategory, RegExp[][]> = {
  beauty: [[/膏体|面霜|乳霜|cream/i, /涂抹|推开|抹开|spread|appl/i, /指腹|手指|finger/i, /皮肤|skin/i], [/泵头|pump/i, /按压|挤出|press|release/i, /手背|back of the hand/i], [/瓶盖|cap/i, /拧开|打开|twist|open/i, /膏体|cream/i]],
  food: [[/掰开|掰断|snap|break/i, /酥脆|掉渣|crisp|flake/i], [/热气|steam/i, /酱汁|sauce/i], [/夹起|lift/i, /颤动|弹性|quiver|springy/i]],
  home: [[/部件|盖子|moving part|lid/i, /开合|归位|close|shut/i], [/手掌|palm/i, /按压|press/i, /回弹|spring/i], [/水流|water/i, /冲过|冲洗|rinse|runs? over/i]],
  fashion: [[/衣摆|hem/i, /转身|turn/i], [/面料|fabric/i, /捏起|pinch/i, /放|release/i], [/面料|fabric/i, /行走|走路|walk/i]],
  tech: [[/屏幕|screen/i, /手指|finger/i, /滑|swipe/i], [/耳机|earbud/i, /充电仓|case/i, /放入|put|drop/i], [/金属|metal/i, /机身|device/i, /转动|旋转|rotate/i]],
};
const BACKGROUND_EVIDENCE = [
  /窗帘|curtain/i,
  /背景[^。;；\n]{0,20}(?:行人|有人|人物)|(?:person|people|someone)[^.;\n]{0,25}background|background[^.;\n]{0,25}(?:person|people|someone)/i,
  /背景[^。;；\n]{0,20}灯|lamp[^.;\n]{0,25}background|background[^.;\n]{0,25}lamp/i,
  /热饮|hot drink/i,
  /(?:窗外|window).{0,20}(?:云|cloud)|(?:云|cloud).{0,20}(?:窗外|window)/i,
  /背景[^。;；\n]{0,20}(?:绿植|叶片)|background[^.;\n]{0,25}(?:plant|leaves)/i,
];
const CATEGORY_EVIDENCE: Record<ProductCategory, RegExp> = {
  beauty: /膏体|液体|面霜|乳霜|精华|cream|liquid|serum/i,
  food: /食物|食品|饼干|酥脆|面包|蛋糕|food|cookie|bread|cake/i,
  home: /部件|结构|接缝|parts?|structure|seams?/i,
  fashion: /面料|衣料|衣服|衣摆|布料|fabric|cloth|dress|shirt|hem/i,
  tech: /金属|屏幕|metal|screen/i,
};

function categoryConstraint(category: ProductCategory | undefined, evidence: string, lang: "zh" | "en"): string | undefined {
  if (!category || !CATEGORY_EVIDENCE[category].test(evidence)) return;
  if (category !== "tech") return CATEGORY_CONSTRAINTS[category][lang];
  const parts: string[] = [];
  if (/金属|metal/i.test(evidence)) parts.push(lang === "zh" ? "已有金属表面的反光干净克制" : "reflections on existing metal surfaces stay clean and restrained");
  if (/屏幕|screen/i.test(evidence)) parts.push(lang === "zh" ? "已有屏幕内容清晰稳定" : "existing on-screen content stays sharp and stable");
  return parts.join(lang === "zh" ? "，" : ", ");
}

/**
 * Build the i2v motion prompt for a shot. The camera line leads (motion is the message),
 * followed by subject action, the complete scene direction, fidelity constraints for product
 * shots, and the stability tail. Language follows the script (camera/description text).
 */
export function buildMotionPrompt(input: MotionPromptInput): string {
  const rawDescription = (input.description ?? "").trim();
  const premiumCg = usesPremiumCgPolicy(input);
  // Compile the sanitized visual description into the language/evidence probe as
  // well as the final Scene line. This prevents a legacy price/CTA sentence from
  // influencing category or motion heuristics before it is removed from output.
  const description = premiumCg ? removePremiumCgTextDirectives(rawDescription) : rawDescription;
  const probe = `${input.camera ?? ""}\n${description}`.trim();
  // Empty inputs default to Chinese (domestic-first product)
  const lang: "zh" | "en" = probe && !hasCjk(probe) ? "en" : "zh";
  const type = String(input.shotType ?? "");
  const anchor = description;
  const direction = unquoted(probe);
  const evidence = positiveEvidence(probe);
  const stateEvidence = direction.split(/[，,。;；!?！？\n]/).filter((clause) =>
    !/不要|不应|不得|禁止|避免|无需|没有|\b(?:not|never|avoid|don't|do not)\b/i.test(clause),
  ).join("；");

  // Conflict lint: a self-contradictory scripted camera (hold + move, no sequencing) would yield
  // jerky indecisive motion — fall back to the shot type's single known-good instruction instead
  const scripted = input.camera?.trim();
  const camera =
    scripted && !hasCameraConflict(scripted)
      ? scripted
      : premiumCg
        ? PREMIUM_CG_CAMERA_DEFAULT[lang]
        : (CAMERA_DEFAULTS[type] ?? CAMERA_FALLBACK)[lang];
  const fixedCamera = STATIC_CAMERA_RE.test(camera) && !MOVING_CAMERA_RE.test(positiveEvidence(camera));
  const stillSubject = STILL_SUBJECT_RE.test(stateEvidence);
  const solidBackground = SOLID_BACKGROUND_RE.test(evidence);
  const seed = input.beatSeed ?? 0;
  const realism: MotionRealismTier = input.realism ?? "auto";
  const category = realism === "off" ? undefined : normalizeCategory(input.category);
  // motion-phrase layers (interaction/background/inertia/emotion) only at the full tier
  // Premium CG is reference-limited: do not invent secondary action from a
  // category label or a generic person/background rule.
  const fullRealism = realism === "auto" && !premiumCg;
  // a speaking character overrides the per-type micro-action: the shot must read as
  // "mid-conversation", with two rotating behavior beats against batch-level repetition
  let action = (stillSubject || (premiumCg && fixedCamera))
    ? (premiumCg ? PREMIUM_CG_STATIC_ACTION[lang] : STATIC_ACTION[lang])
    : premiumCg
      ? PREMIUM_CG_ACTION[lang]
      : input.talking
    ? `${TALKING_ACTION[lang]}${lang === "zh" ? "；" : "; "}${pickBehaviorBeats(seed, lang).join(lang === "zh" ? "、" : ", ")}`
    : (ACTION_DEFAULTS[type] ?? ACTION_FALLBACK)[lang];
  if (!stillSubject && !input.talking && type === "demo" && HAND_EVIDENCE_RE.test(evidence)) {
    action = lang === "zh" ? "分镜中已有的手部演示动作自然连贯" : "the hand demonstration already described in the shot stays natural and continuous";
  }
  // demonstration shots with a known category get one "action + material reaction" phrase:
  // material feedback (spring-back, crumbs, ripple) is what separates footage from CG
  if (fullRealism && !stillSubject && !input.talking && category && PHYSICAL_ACTION_TYPES.has(type)) {
    const supported = PHYSICAL_ACTION_LEXICON[category].filter((_, index) => PHYSICAL_EVIDENCE[category][index].every((rule) => rule.test(evidence)));
    if (supported.length) {
      action += `${lang === "zh" ? "；" : "; "}${pickFrom(supported, seed)[lang]}`;
    }
  }
  // non-talking person shots get one emotion process phrase (trigger → body-first →
  // restrained face); talking shots already carry their own behavior direction
  const emotion = fullRealism && !stillSubject && !input.talking && input.personShot ? shotEmotion(type) : undefined;
  const explicitSlowMove = /缓慢|慢速|轻微|克制|\bslow(?:ly)?\b|\bsubtle\b|\brestrained\b/i.test(camera);
  const intensity = !premiumCg && !fixedCamera && input.intensity && input.intensity !== "normal" && !(input.intensity === "strong" && explicitSlowMove)
    ? INTENSITY_LINES[input.intensity][lang] : undefined;
  // Only animate a background element that is actually described, never invent one by seed.
  const backgroundEvidence = evidence.split("；").filter((clause) => !/静止|静置|静态|stationary|motionless|\bstill\b/i.test(clause)).join("；");
  const stillBackground = /背景[^。;；\n]{0,12}(?:静止|静态|不动)|\bbackground\b[^.;\n]{0,25}\b(?:static|stationary|still|motionless)\b/i.test(stateEvidence);
  const supportedBackgrounds = LIVING_BG.filter((_, index) => BACKGROUND_EVIDENCE[index].test(backgroundEvidence));
  const livingBg = fullRealism && !stillSubject && !stillBackground && !solidBackground && (input.personShot || type === "demo") && supportedBackgrounds.length
    ? pickFrom(supportedBackgrounds, seed)[lang] : undefined;
  const fabricLag = fullRealism && !stillSubject && input.personShot;
  const materialConstraint = categoryConstraint(category, evidence, lang);
  const audioMode = input.audioMode ?? "ambient";
  const sound = audioMode === "none" ? undefined : VIDEO_AUDIO_DIRECTIONS[audioMode][lang];
  // A look must not override the explicit camera direction (e.g. phone_raw + locked-off CTA).
  const opener = premiumCg ? undefined : input.opener?.[lang];
  const compatibleOpener = opener && !(fixedCamera && /手持|handheld|holding arm/i.test(opener))
    && !(MOVING_CAMERA_RE.test(camera) && /固定|\bstatic\b|\bfixed\b|\bpropped\b/i.test(opener)) ? opener : undefined;
  const look = input.look?.[lang];
  const compatibleLook = look && !(MOVING_CAMERA_RE.test(camera) && /固定[^，,。]{0,12}(?:视角|机位)|\bfixed\b[^,.]{0,20}\b(?:viewpoint|camera|mount)\b/i.test(look)) ? look : undefined;

  const labels = lang === "zh"
    ? { camera: "运镜：", motion: "画面动态：", scene: "场景：", light: "光线：" }
    : { camera: "Camera: ", motion: "Motion: ", scene: "Scene: ", light: "Lighting: " };
  const cameraParts = [`${labels.camera}${camera}`];
  if (intensity) cameraParts.push(intensity);
  const actionParts = [`${labels.motion}${action}`];
  if (emotion) actionParts.push(emotionActingLine(emotion, seed, lang));
  if (livingBg) actionParts.push(livingBg);
  if (fabricLag) actionParts.push(FABRIC_HAIR_LAG[lang]);
  const constraints: string[] = [];
  if (compatibleLook) constraints.push(`${labels.light}${compatibleLook}`);
  if (premiumCg) {
    constraints.push(PREMIUM_CG_REFERENCE_LIMIT[lang]);
    constraints.push(PREMIUM_CG_NO_ADDED_TEXT[lang]);
  }
  // Chained clips end in the next keyframe; other shots retain a continuous single take.
  constraints.push(input.chainToNext ? CHAIN_GUIDANCE[lang] : SINGLE_SHOT[lang]);
  if (input.personShot) constraints.push(REAL_FACE_CONSTRAINT[lang]);
  // The legacy product constraint tells models to preserve printed copy. Premium CG has a
  // stricter rule: preserve only reference markings and never request generated frame text.
  if (input.productShot && !premiumCg) constraints.push(PRODUCT_CONSTRAINT[lang]);
  if (input.productShot && materialConstraint) constraints.push(materialConstraint);
  constraints.push(QUALITY_TAIL[lang]);
  const sections = [
    compatibleOpener ?? "",
    joinVideoPromptParts(cameraParts, lang),
    joinVideoPromptParts(actionParts, lang),
    anchor ? `${labels.scene}${anchor}` : "",
    joinVideoPromptParts(constraints, lang),
  ];
  const visual = joinVideoPromptParts(sections, lang, "\n");
  return sound ? `${visual}\n\n${joinVideoPromptParts([sound], lang)}` : visual;
}
