/**
 * 3x3 storyboard grid — single-image consistency anchoring for multi-shot videos.
 *
 * Why: chained keyframes and text appearance anchors fight identity drift shot by
 * shot; a storyboard GRID kills it at the source — one generation renders all
 * shots in one image, so the person, outfit, room and light are physically the
 * same pixels-era subject in every cell. Each cell is then cropped out and saved
 * as that shot's keyframe, and the existing i2v pass animates them.
 *
 * Geometry trick: a 3x3 grid at 9:16 overall yields cells that are each exactly
 * 9:16 — the cropped cells drop straight into our vertical pipeline.
 *
 * Pure functions (prompt building + crop geometry); the route does the I/O.
 */
import type { Shot, ScriptCharacter } from "@/lib/db/schema";
import { REAL_FACE_CONSTRAINT, UGC_FIRST_FRAME_RULES } from "@/lib/presenters";
import { isPremiumCgPromptPolicy, sanitizePremiumCgVisualText } from "@/lib/motion-prompt";
import { isTideweOutdoorProfile, type TideweOutdoorProfile } from "@/lib/creative-profiles";
import { TIDEWE_IMAGE_CAPTURE_POLICY } from "@/lib/tidewe/visual-policy";
import { tidewePresenterAnchor } from "@/lib/tidewe/presenter";

export const GRID_ROWS = 3;
export const GRID_COLS = 3;
export const GRID_MAX_SHOTS = GRID_ROWS * GRID_COLS;

/** Shot-type label used in per-cell prompt lines (bilingual not needed: grid prompt is zh-first). */
const SHOT_TYPE_LABELS: Record<string, string> = {
  hook: "钩子镜",
  pain_point: "痛点镜",
  product_reveal: "商品镜",
  demo: "演示镜",
  social_proof: "背书镜",
  cta: "转化镜",
};

const PREMIUM_SHOT_TYPE_LABELS: Record<string, string> = {
  hook: "opening product portrait",
  pain_point: "design context",
  product_reveal: "product form",
  demo: "material or function detail",
  social_proof: "space relationship",
  cta: "closing product portrait",
};

/** Initial creation quality; no edit-stage source image or repair report is required. */
const TIDEWE_GRID_STRUCTURE_POLICY = "画面结构：肩、肘、前臂、手腕与手自然连续；左右手、掌背、拇指侧别与关节符合真实姿态，保留自然遮挡。商品轮廓、比例、材料、已有标识、可见部件数量和连接关系以参考为准；手与商品、商品与支撑面的受力、遮挡和接触成立。脚本明确需要的独立物体保留，固定件与运动件维持真实连接。";

function tideweGridPresence(shot: Shot, speechMode: TideweOutdoorProfile["speechMode"]) {
  const nativeSpeech = speechMode === "on_camera" && Boolean(shot.voiceover?.trim());
  const spoken = nativeSpeech && shot.tidewe?.speechDelivery !== "off_camera";
  return { spoken, offCamera: nativeSpeech && !spoken, personVisible: spoken || shot.tidewe?.personVisible !== false, productVisible: shot.tidewe?.productVisible !== false };
}

/** A grid cell describes its one frozen image; shared policies belong to the sheet. */
function tideweGridCellBrief(shot: Shot, profile: TideweOutdoorProfile, presenterAnchor?: string): string {
  const { spoken, offCamera, personVisible, productVisible } = tideweGridPresence(shot, profile.speechMode);
  const text = (value?: string) => {
    const trimmed = value?.trim();
    // Saved descriptions can contain the full frozen identity. Refer to the global
    // anchor without repeating its appearance paragraph in every cell.
    return presenterAnchor && trimmed ? trimmed.replaceAll(presenterAnchor, "主播") : trimmed;
  };
  const plan = shot.tidewe?.visualPlan;
  return [
    shot.tidewe?.sceneId ? `场景 ${shot.tidewe.sceneId}` : "",
    text(shot.description) ? `本镜画面：${text(shot.description)}` : "本镜画面：自然户外环境",
    text(shot.visualIntent) ? `视觉意图：${text(shot.visualIntent)}` : "",
    text(shot.tidewe?.shotGoal) ? `画面目标：${text(shot.tidewe?.shotGoal)}` : "",
    text(shot.camera) ? `运镜/构图：${text(shot.camera)}` : "",
    plan ? `已确认景别：${({ wide: "全景／使用空间", medium: "中景／人物与装备交流", close_up: "近景／较大操作区域", detail: "特写／局部部件与接触" })[plan.framing]}；画面任务：${({ presenter: "人物交流", demonstration: "真实使用演示", detail: "可见细节观察", context: "使用情境与空间关系" })[plan.visualRole]}` : "",
    productVisible ? `产品可见${plan?.productFocus ? `；本镜商品观察对象：${text(plan.productFocus)}` : ""}` : "产品不出镜：保持原有环境或行动，不植入商品及品牌标识",
    plan ? `首帧已有状态：${text(plan.actionStart)}；为后续单次动作「${text(plan.action)}」保留空间` : "",
    !personVisible ? "无人出镜，不加入人脸、路人或手" : spoken ? "真人口播：回应镜头，嘴部清晰可见，手与商品不遮嘴，保留本镜景别" : offCamera ? "画外讲解：安静操作，按本镜构图，不要求脸部或嘴部入画" : "人物按本镜构图自然互动，细节镜不强加人脸",
    productVisible ? "合焦目标：近前景—接触处—商品共同合焦，仅限本格已有表面" : "合焦目标：本格已有近前景与行动位置清楚可读",
  ].filter(Boolean).join("；");
}

export interface StoryboardGridPolicyInput {
  creativeProfile?: unknown;
  outputPolicy?: unknown;
}

interface StoryboardGridReferences extends StoryboardGridPolicyInput {
  characterSheet?: boolean;
  productImage?: boolean;
  productImageCount?: number;
  aspectRatio?: string;
}

/** Only a numeric ratio may enter the layout instructions; provider-specific values fall back to portrait. */
function promptAspectRatio(value?: string): { ratio: string; zh: string; en: string } {
  const match = typeof value === "string" ? value.match(/^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/) : null;
  let width = match ? Number(match[1]) : 9;
  let height = match ? Number(match[2]) : 16;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    width = 9;
    height = 16;
  }
  return {
    ratio: `${width}:${height}`,
    zh: width === height ? "正方形" : width > height ? "横版" : "竖版",
    en: width === height ? "square" : width > height ? "landscape" : "portrait",
  };
}

/**
 * Build the one-shot 3x3 storyboard-grid image prompt: global consistency block
 * (same person / outfit / room / light) + one numbered line per cell + realism
 * rules + hard grid-layout constraints (equal cells, thin gutters, no text —
 * cells get cropped into keyframes, so any text or borders would poison them).
 */
export function buildStoryboardGridPrompt(
  shots: Shot[],
  characters?: ScriptCharacter[] | null,
  refs?: StoryboardGridReferences,
  policy?: StoryboardGridPolicyInput | unknown,
): string {
  const cells = shots.slice(0, GRID_MAX_SHOTS);
  const profileValue = policy && typeof policy === "object" && !Array.isArray(policy)
    ? ((policy as StoryboardGridPolicyInput).creativeProfile ?? (policy as StoryboardGridPolicyInput).outputPolicy ?? policy)
    : policy;
  const premiumCg = isPremiumCgPromptPolicy(profileValue)
    || isPremiumCgPromptPolicy(refs?.creativeProfile)
    || isPremiumCgPromptPolicy(refs?.outputPolicy);
  if (premiumCg) return buildPremiumStoryboardGridPrompt(cells, refs);
  if (isTideweOutdoorProfile(profileValue) || isTideweOutdoorProfile(refs?.creativeProfile)) {
    const tideweProfile = isTideweOutdoorProfile(profileValue) ? profileValue : refs!.creativeProfile as TideweOutdoorProfile;
    if (shots.length > GRID_MAX_SHOTS) throw new Error("TIDEWE 九宫格最多容纳 9 镜，请使用逐镜生成或明确重新规划，不能截断脚本。");
    const aspect = promptAspectRatio(refs?.aspectRatio);
    const productCount = typeof refs?.productImageCount === "number" && Number.isFinite(refs.productImageCount)
      ? Math.max(0, Math.floor(refs.productImageCount)) : refs?.productImage ? 1 : 0;
    const offset = refs?.characterSheet ? 1 : 0;
    const hasPerson = cells.some(shot => tideweGridPresence(shot, tideweProfile.speechMode).personVisible);
    const presenter = tideweProfile.presenter ?? cells.find(shot => tideweGridPresence(shot, tideweProfile.speechMode).personVisible)?.tidewe?.presenter;
    const presenterAnchor = presenter ? tidewePresenterAnchor(presenter) : undefined;
    return [
      `TIDEWE 户外分镜：${GRID_ROWS}x${GRID_COLS} 严格等分九宫格，整图与每格画幅均为 ${aspect.ratio}。两条横/竖分隔线位于1/3和2/3，极细纯白直线，无外边框。按从左到右、从上到下顺序，每格独立可裁切。编号只作说明，不绘制文字。`,
      TIDEWE_IMAGE_CAPTURE_POLICY,
      "上述统一画面风格适用于全部九格，包括全景、中景、近景、特写、人物镜、产品镜、环境空镜及占位格。每格直接生成该镜头动作开始前的首帧画面；按脚本换场景时仍保持同一 iPhone 8 原生相机成像风格。",
      TIDEWE_GRID_STRUCTURE_POLICY,
      "同 sceneId 的人物、衣物、产品状态、环境、天气与光线连续；按脚本换场景。逐格保留景别、机位、视线、人与商品距离及接触位置。只画 actionStart 的一瞬，为一次后续小动作留空间，不拼入动作终点。",
      "本镜指定商品观察对象：该商品或部位必须清楚入画，构图容纳指定部件与接触位置；人物交流不能替代商品展示。只呈现参考支持的外观和普通使用，不由外观推断隐藏结构、性能或无依据效果测试；不展示独立电池。",
      hasPerson && presenterAnchor ? `固定出镜人物：${presenterAnchor}；有人或手的格沿用同一身份、衣袖与体型。` : "",
      refs?.characterSheet ? "第 1 张参考图为主播身份参考，只锁定脸型、发型与体型。人物在各格自身环境中重新成像，光线与焦点服从本格；不复制参考的背景、分格、虚化与影棚效果。" : "",
      ...Array.from({ length: productCount }, (_, i) => `第 ${i + 1 + offset} 张参考图为当前同一商品的第 ${i + 1}/${productCount} 个视角，只锁定商品外观和结构，不能替换主播身份。`),
      productCount ? "商品参考仅用于产品可见的格；商品在本格环境中重新成像，共享自然光、原生成像质感、清晰度和接触阴影，不复制参考的背景、虚化与影棚效果。" : "",
      ...Array.from({ length: GRID_MAX_SHOTS }, (_, index) => cells[index]
        ? `第 ${index + 1} 格（第 ${Math.floor(index / GRID_COLS) + 1} 行第 ${index % GRID_COLS + 1} 列）：${tideweGridCellBrief(cells[index], tideweProfile, presenterAnchor)}`
        : `第 ${index + 1} 格为占位：重复最后一个有效格，不增加叙事，不跨格合并。`),
      "严格九格，仅保留商品原有真实标识，不新增文字、字幕、编号、价格、营销字、Logo或水印。",
    ].filter(Boolean).join("\n");
  }
  const aspect = promptAspectRatio(refs?.aspectRatio);

  const cast = (characters ?? [])
    .map((c) => `${c.name}：${c.appearance}`)
    .filter(Boolean)
    .join("；");

  const cellLines = Array.from({ length: GRID_MAX_SHOTS }, (_, i) => {
    const position = `固定位置：第 ${Math.floor(i / GRID_COLS) + 1} 行第 ${i % GRID_COLS + 1} 列`;
    const s = cells[i];
    if (!s) {
      return `第 ${i + 1} 格（占位复用，不新增分镜）：${cells.length ? `完整重复第 ${cells.length} 格的画面` : "中性干净场景"}，保留独立单格及分隔线，不得将相邻画面扩展到此格。${position}。`;
    }
    const label = SHOT_TYPE_LABELS[String(s.type)] ?? "分镜";
    return `第 ${i + 1} 格（${label}）：${s.description}。${position}。`;
  });

  // reference-image contract: the images array order is [character sheet?, ...product photos],
  // so the prompt cites them by position (field-proven with gpt-image-2/edit)
  const suppliedCount = refs?.productImageCount;
  const productImageCount = typeof suppliedCount === "number" && Number.isFinite(suppliedCount)
    ? Math.max(0, Math.floor(suppliedCount))
    : refs?.productImage ? 1 : 0;
  const refLines: string[] = [];
  if (refs?.characterSheet || productImageCount > 0) {
    let n = 0;
    if (refs?.characterSheet) {
      n += 1;
      refLines.push(
        `第 ${n} 张参考图是出镜人物的四视图定妆照——九格中的人物脸型、发型、体型与服装必须与其完全一致（定妆照只作人物参考，不作为分镜画面）。人物需自然融入各格自身的场景与光线，不得把定妆照的浅灰影棚背景、四格分格或边框带进任何一格。`
      );
    }
    for (let i = 0; i < productImageCount; i++) {
      n += 1;
      refLines.push(productImageCount === 1
        ? `第 ${n} 张参考图是商品实拍图——九格中的商品外观、配色与包装必须与其完全一致。`
        : `第 ${n} 张参考图是商品实拍图（同一商品的不同视角，第 ${i + 1}/${productImageCount} 张商品参考）——结合全部商品参考图锁定同一件商品的外观、结构、配色与包装，不得将不同视角当成不同商品。`);
    }
  }

  return [
    `一张 ${GRID_ROWS}x${GRID_COLS} 等分九宫格分镜图，整图 ${aspect.ratio} ${aspect.zh}，每格画幅同为 ${aspect.ratio}，格与格之间只留极细的白色分隔缝。`,
    "固定布局：必须画满 3 行 3 列九格，按从左到右、从上到下的行主序编号。两条竖直分隔线位于整图宽度的 1/3、2/3，两条水平分隔线位于整图高度的 1/3、2/3；分隔线必须笔直、连续贯穿整图、极细且为纯白色，禁止外边框和装饰边框。",
    `前 ${cells.length} 格按脚本顺序一格一镜，剩余格仅作占位复用；不得重排、合并、跨格、放大某格或减少行列。以下编号和位置仅用于描述，不得画进图片。`,
    `全局一致性（最重要）：九格是同一支视频的分镜——同一人物、同一发型与同一身衣服、同一房间、同一光线方向与色调，道具与商品在各格间保持完全一致。`,
    ...refLines,
    cast ? `人物设定：${cast}。` : "",
    `各格内容（每格是一个独立镜头的画面，构图按 ${aspect.ratio} ${aspect.zh}设计；每格都是该镜动作即将开始前一瞬的定格，姿态里留着正要发生的势能）：`,
    ...cellLines,
    REAL_FACE_CONSTRAINT.zh + "。",
    UGC_FIRST_FRAME_RULES,
    `硬性要求：严格等分九宫格；画面里不出现任何文字、字幕、编号、水印或边框装饰；每格都是完整可独立使用的镜头画面。`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Product-only storyboard contract. It intentionally does not share the UGC/persona block. */
function buildPremiumStoryboardGridPrompt(
  cells: Shot[],
  refs?: StoryboardGridReferences,
): string {
  const aspect = promptAspectRatio(refs?.aspectRatio);
  const suppliedCount = refs?.productImageCount;
  const productImageCount = typeof suppliedCount === "number" && Number.isFinite(suppliedCount)
    ? Math.max(0, Math.floor(suppliedCount))
    : refs?.productImage ? 1 : 0;
  const refLines: string[] = [];
  if (refs?.characterSheet) {
    refLines.push("A presenter or identity reference, if supplied, must not introduce a presenter, talking head, or persona into any cell.");
  }
  for (let i = 0; i < productImageCount; i++) {
    refLines.push(productImageCount === 1
      ? "The product reference image locks the product silhouette, proportions, component count, visible construction, surface finishes, materials, colors, and existing markings in every cell."
      : `Product reference image ${i + 1}/${productImageCount} is another view of the same product; reconcile all supplied views as one product and never invent a new variant.`);
  }
  const cellLines = Array.from({ length: GRID_MAX_SHOTS }, (_, index) => {
    const position = `Fixed position: row ${Math.floor(index / GRID_COLS) + 1}, column ${index % GRID_COLS + 1}.`;
    const shot = cells[index];
    if (!shot) {
      return `Cell ${index + 1} (padding repeat, not an additional shot): ${cells.length ? `repeat the complete image from Cell ${cells.length}` : "a clean neutral scene"}; retain this separate cell and its separators, and do not extend adjacent images into it. ${position}`;
    }
    const label = PREMIUM_SHOT_TYPE_LABELS[String(shot.type)] ?? "product observation";
    const visual = sanitizePremiumCgVisualText(shot.visualIntent || shot.description) || "quiet product observation with stable form and material detail";
    const camera = sanitizePremiumCgVisualText(shot.camera);
    return `Cell ${index + 1} (${label}): ${visual}${camera ? ` Camera: ${camera}.` : ""} ${position}`;
  });
  return [
    `A premium product CG storyboard grid: a ${GRID_ROWS}x${GRID_COLS} equal-cell image in a ${aspect.ratio} ${aspect.en} canvas; every cell also has a ${aspect.ratio} aspect ratio, with hairline white separators only.`,
    "Fixed layout: fill exactly 3 rows and 3 columns, in row-major order from left to right, then top to bottom. Place vertical separators at 1/3 and 2/3 of canvas width, and horizontal separators at 1/3 and 2/3 of canvas height. All separators must be straight, continuous across the entire canvas, very thin, and pure white. No outer frame or decorative borders.",
    `The first ${cells.length} cells follow the script shot order; remaining cells are padding repeats only. Never rearrange, merge, span, enlarge cells, or reduce the row or column count. Cell numbers and positions are instructions only and must not appear in the image.`,
    "All cells depict one identical product with locked category, silhouette, proportions, component count, visible construction, surface finishes, materials, colors, and existing markings as supported by the supplied references. Match scale, framing, lighting, and setting to the actual product and its documented use context in the approved shots; use a neutral studio when the context is unspecified. Keep lighting consistent with restrained, physically plausible reflections.",
    ...refLines,
    "The product remains the subject. A cropped hand or unfaced person may establish scale or demonstrate one simple use only when explicitly required by an approved shot and supported by supplied product facts; otherwise show the product alone. No presenter behavior, talking heads, lifestyle acting, handheld phone texture, UGC framing, or sales narrative. Do not infer unseen backs, interiors, mechanisms, materials, dimensions, or functions. Use only structure and angles supported by the supplied references.",
    "Each cell is an independent keyframe before motion: one clear product observation, stable geometry, clean composition, and no added on-screen text, captions, subtitles, numbers, prices, promotional graphics, CTA, logo, or watermark. Preserve only markings already visible on the product reference.",
    ...cellLines,
    "Hard layout requirements: exactly nine equal cells, no borders inside cells, no labels or writing, and every cell must be crop-safe as a standalone product keyframe.",
  ].filter(Boolean).join("\n");
}

export interface GridCell {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Crop rectangles for the grid cells, inset by `insetRatio` of the cell size on
 * every edge — generated grids never have pixel-perfect gutters, so a small
 * inset (default 2%) trims the seam residue instead of keeping it as a border.
 * Row-major order (left→right, top→bottom) matching the prompt's cell numbering.
 */
export function computeGridCells(
  width: number,
  height: number,
  opts: { rows?: number; cols?: number; insetRatio?: number } = {}
): GridCell[] {
  const rows = opts.rows ?? GRID_ROWS;
  const cols = opts.cols ?? GRID_COLS;
  const inset = opts.insetRatio ?? 0.02;
  const cellW = width / cols;
  const cellH = height / rows;
  const dx = cellW * inset;
  const dy = cellH * inset;
  const cells: GridCell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({
        x: Math.round(c * cellW + dx),
        y: Math.round(r * cellH + dy),
        w: Math.round(cellW - 2 * dx),
        h: Math.round(cellH - 2 * dy),
      });
    }
  }
  return cells;
}
