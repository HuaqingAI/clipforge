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
import { isTideweOutdoorProfile } from "@/lib/creative-profiles";
import { compileTideweVisualPrompt } from "@/lib/tidewe/visual-policy";
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
    const tideweProfile = isTideweOutdoorProfile(profileValue) ? profileValue : refs!.creativeProfile as import("@/lib/creative-profiles").TideweOutdoorProfile;
    if (shots.length > GRID_MAX_SHOTS) throw new Error("TIDEWE 九宫格最多容纳 9 镜，请使用逐镜生成或明确重新规划，不能截断脚本。");
    const aspect = promptAspectRatio(refs?.aspectRatio);
    const productCount = typeof refs?.productImageCount === "number" && Number.isFinite(refs.productImageCount)
      ? Math.max(0, Math.floor(refs.productImageCount)) : refs?.productImage ? 1 : 0;
    const offset = refs?.characterSheet ? 1 : 0;
    return [
      `TIDEWE 户外分镜：${GRID_ROWS}x${GRID_COLS} 严格等分九宫格，整图与每格画幅均为 ${aspect.ratio}。两条横/竖分隔线位于1/3和2/3，极细纯白直线，无外边框。按从左到右、从上到下顺序，每格独立可裁切。编号只作说明，不绘制文字。`,
      "同 sceneId 的人物、衣物、产品、环境、天气与光线连续；按脚本允许合理换场景。人物参考只约束有人镜头，商品参考只约束产品出镜镜头；无人空镜不添加人物。",
      tideweProfile.presenter ? `整支视频出镜人物固定为${tidewePresenterAnchor(tideweProfile.presenter)}，所有有人镜头沿用同一主播，不因换景重新选人。` : "",
      refs?.characterSheet ? "第 1 张参考图为所选主播身份参考（可能是定妆照或上传的人像）：锁定脸型、发型、体型；不要将其背景、分格、边框带入各格。该图不是商品图，也不是可直接复用的分镜。" : "",
      ...Array.from({ length: productCount }, (_, i) => `第 ${i + 1 + offset} 张参考图为当前同一商品的第 ${i + 1}/${productCount} 个视角，只锁定商品外观和结构，不能替换主播身份。`),
      ...Array.from({ length: GRID_MAX_SHOTS }, (_, index) => cells[index]
        ? `第 ${index + 1} 格：${compileTideweVisualPrompt(cells[index], "image", tideweProfile.speechMode, tideweProfile.presenter).prompt}`
        : `第 ${index + 1} 格为占位：重复最后一个有效格，不增加叙事，不跨格合并。`),
      "严格九格。产品身份参考不得把背景带入环境空镜；所有新增字幕、价格、营销字与水印均禁止。",
    ].join("\n");
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
