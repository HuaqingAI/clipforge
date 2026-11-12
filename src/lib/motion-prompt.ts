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
 *  - Bilingual: callers can select the template language explicitly; legacy callers follow
 *    the script language (CJK → Chinese prompt, otherwise English).
 *
 * Pure functions, unit-testable, no I/O.
 */
import type { Shot } from "@/lib/db/schema";
import { REAL_FACE_CONSTRAINT } from "@/lib/presenters";
import { joinVideoPromptParts } from "@/lib/video-prompt";
import { VIDEO_AUDIO_DIRECTIONS, type VideoAudioMode } from "@/lib/video-audio";

export interface MotionPromptInput {
  /** Explicit template language; when absent, follow the camera/description language. */
  locale?: "zh" | "en";
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
  zh: "商品的外观、包装、颜色、标志与文字必须保持完全不变，文字清晰不扭曲变形",
  en: "the product's appearance, packaging, colors, logo and printed text must remain exactly unchanged, text stays sharp and undistorted",
};

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
const HAND_EVIDENCE_RE = /手部|手指|手掌|双手|单手|\bhands?\b|\bfingers?\b/i;
const STATIC_ACTION = {
  zh: "主体保持静止，画面文字清晰稳定",
  en: "the subject remains still, with sharp and stable on-screen text",
};

/**
 * Build the i2v motion prompt for a shot. The camera line leads (motion is the message),
 * followed by subject action, the complete scene direction, fidelity constraints for product
 * shots, and the stability tail. Explicit locale controls template language; otherwise
 * language follows the script (camera/description text).
 */
export function buildMotionPrompt(input: MotionPromptInput): string {
  const description = (input.description ?? "").trim();
  const probe = `${input.camera ?? ""}\n${description}`.trim();
  // Empty inputs default to Chinese (domestic-first product)
  const lang = input.locale ?? (probe && !hasCjk(probe) ? "en" : "zh");
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
      : (CAMERA_DEFAULTS[type] ?? CAMERA_FALLBACK)[lang];
  const fixedCamera = STATIC_CAMERA_RE.test(camera) && !MOVING_CAMERA_RE.test(positiveEvidence(camera));
  const stillSubject = STILL_SUBJECT_RE.test(stateEvidence);
  const seed = input.beatSeed ?? 0;
  // a speaking character overrides the per-type micro-action: the shot must read as
  // "mid-conversation", with two rotating behavior beats against batch-level repetition
  let action = stillSubject
    ? STATIC_ACTION[lang]
    : input.talking
    ? `${TALKING_ACTION[lang]}${lang === "zh" ? "；" : "; "}${pickBehaviorBeats(seed, lang).join(lang === "zh" ? "、" : ", ")}`
    : (ACTION_DEFAULTS[type] ?? ACTION_FALLBACK)[lang];
  if (!stillSubject && !input.talking && type === "demo" && HAND_EVIDENCE_RE.test(evidence)) {
    action = lang === "zh" ? "分镜中已有的手部演示动作自然连贯" : "the hand demonstration already described in the shot stays natural and continuous";
  }
  const audioMode = input.audioMode ?? "ambient";
  const sound = audioMode === "none" ? undefined : VIDEO_AUDIO_DIRECTIONS[audioMode][lang];
  // A look must not override the explicit camera direction (e.g. phone_raw + locked-off CTA).
  const opener = input.opener?.[lang];
  const compatibleOpener = opener && !(fixedCamera && /手持|handheld|holding arm/i.test(opener))
    && !(MOVING_CAMERA_RE.test(camera) && /固定|\bstatic\b|\bfixed\b|\bpropped\b/i.test(opener)) ? opener : undefined;
  const look = input.look?.[lang];
  const compatibleLook = look && !(MOVING_CAMERA_RE.test(camera) && /固定[^，,。]{0,12}(?:视角|机位)|\bfixed\b[^,.]{0,20}\b(?:viewpoint|camera|mount)\b/i.test(look)) ? look : undefined;

  const labels = lang === "zh"
    ? { camera: "运镜：", motion: "画面动态：", scene: "场景：", light: "光线：" }
    : { camera: "Camera: ", motion: "Motion: ", scene: "Scene: ", light: "Lighting: " };
  const cameraParts = [`${labels.camera}${camera}`];
  const actionParts = [`${labels.motion}${action}`];
  const constraints: string[] = [];
  if (compatibleLook) constraints.push(`${labels.light}${compatibleLook}`);
  // Chained clips end in the next keyframe; other shots retain a continuous single take.
  constraints.push(input.chainToNext ? CHAIN_GUIDANCE[lang] : SINGLE_SHOT[lang]);
  if (input.personShot) constraints.push(REAL_FACE_CONSTRAINT[lang]);
  if (input.productShot) constraints.push(PRODUCT_CONSTRAINT[lang]);
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
