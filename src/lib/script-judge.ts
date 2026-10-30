/**
 * Judge panel — a five-judge adversarial pass over script lines and shot visuals,
 * run BEFORE any money is spent on generation.
 *
 * The UGC methodology this encodes: video models render a bad script exactly as
 * pretty as a good one, so the script must be torn apart first — by narrow,
 * bad-tempered specialists, not one generalist reviewer. Five judges, each
 * owning exactly one axis (retention pacing / spoken-not-written voice /
 * freshness / structure / visible-action visuals), one LLM call for all five,
 * plus rewrites that keep meaning, selling points and — critically — line
 * LENGTH (voiceover duration is pinned to shot duration by TTS).
 *
 * v2 additions:
 *  - visual judge: "who does what in THIS second" — purpose-sentences
 *    ("shows product quality") are not frames; they get rewritten into visible
 *    actions via descriptionRewrites.
 *  - three-tier adoption grades: hands-off chains auto-apply invariant/default
 *    rewrites only; taste-tier stays display-only (protects creative choices
 *    while still catching hard defects). Invalid tiers clamp to "taste" —
 *    when in doubt, show, never auto-change.
 *  - evidence rule: every issue must quote the offending fragment; rewrites
 *    must preserve the original line's numeric fact tokens (price/spec/count),
 *    enforced server-side — a rewrite that loses a number is dropped.
 *
 * Pure functions: prompt building + response parsing/clamping. The route does I/O.
 */
import { SPOKEN_VOICE_RULES } from "@/lib/presenters";
import { extractJSON } from "@/lib/script-engine/generator";
import type { TideweCopyDocument, TideweShotFields } from "@/lib/tidewe/types";
import { getTideweProductCoverageIssues, type TideweProductCoverageIssue } from "@/lib/tidewe/planning-quality";
import { buildTideweCategoryGuidance } from "@/lib/tidewe/category-guidance";
import { TIDEWE_NATIVE_CAMERA_STYLE } from "@/lib/tidewe/visual-policy";

export const JUDGE_IDS = ["pace", "voice", "idea", "structure", "visual"] as const;
export type JudgeId = (typeof JUDGE_IDS)[number];

/** Judge display metadata (zh/en) for the report UI. */
export const JUDGE_META: Record<JudgeId, { zh: string; en: string }> = {
  pace: { zh: "节奏官", en: "Pacing judge" },
  voice: { zh: "口语官", en: "Voice judge" },
  idea: { zh: "创意官", en: "Freshness judge" },
  structure: { zh: "结构官", en: "Structure judge" },
  visual: { zh: "画面官", en: "Visual judge" },
};

/** Adoption tiers: what automation may act on vs. what stays a suggestion. */
export const JUDGE_TIERS = ["invariant", "default", "taste"] as const;
export type JudgeTier = (typeof JUDGE_TIERS)[number];

export interface JudgeIssue {
  shotId?: number;
  issue: string;
  /** Adoption grade (display); invalid model output clamps to "taste" */
  tier: JudgeTier;
}
export interface JudgeVerdict {
  judge: JudgeId;
  issues: JudgeIssue[];
}
export interface JudgeRewrite {
  shotId: number;
  voiceover: string;
  /** Adoption grade: hands-off chains only auto-apply invariant/default */
  tier: JudgeTier;
}
/** Visual judge's shot-description rewrite (function sentence → visible action). */
export interface JudgeDescriptionRewrite {
  shotId: number;
  description: string;
  tier: JudgeTier;
}
export interface JudgeReport {
  verdicts: JudgeVerdict[];
  rewrites: JudgeRewrite[];
  descriptionRewrites: JudgeDescriptionRewrite[];
  summary?: string;
  /** Saved script version reviewed by the panel; used to reject stale follow-up edits. */
  sourceScriptHash?: string;
}

/** Minimal shot view the judges need (id + spoken line + what the frame shows). */
export interface JudgeShotInput {
  shotId: number;
  voiceover: string;
  /** Shot visual description — feeds the visual judge; optional for line-only callers */
  description?: string;
  /** Framing and movement context for brand-specific visual review. */
  camera?: string;
  tidewe?: Partial<Pick<TideweShotFields, "visualPlan" | "speechDelivery" | "personVisible" | "productVisible" | "copySpan" | "factRefs" | "shotGoal">>;
  /** Allocated storyboard seconds, including shots without narration; not measured audio. */
  duration?: number;
}

export interface JudgeTimingOptions {
  plannedTotalDuration?: number;
  /** Complete storyboard for timing only; does not add shots to the review scope. */
  timelineShots?: JudgeShotInput[];
}

export interface TideweJudgeOptions extends JudgeTimingOptions {
  speechMode?: "on_camera" | "voiceover";
  videoMode?: "scene_demo" | "product_closeup";
  /** The route computes this once from the complete saved storyboard. */
  productCoverageIssues?: TideweProductCoverageIssue[];
}

function validDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Keep silent shots on the timeline; missing durations must never become invented seconds. */
export function buildJudgeTimingContext(shots: JudgeShotInput[], opts: JudgeTimingOptions = {}) {
  let cursor: number | null = 0;
  const seconds = (value: number) => Math.round(value * 1000) / 1000;
  const timeline = shots.map((shot) => {
    const duration = validDuration(shot.duration) ? shot.duration : null;
    const start = cursor;
    const end: number | null = start !== null && duration !== null ? start + duration : null;
    cursor = end;
    return { shotId: shot.shotId, start: start === null ? null : seconds(start),
      end: end === null ? null : seconds(end), duration, hasNarration: Boolean(shot.voiceover.trim()) };
  });
  return {
    unit: "seconds",
    actualTotalDuration: shots.length > 0 && cursor !== null ? seconds(cursor) : null,
    plannedTotalDuration: validDuration(opts.plannedTotalDuration) ? opts.plannedTotalDuration : null,
    shots: timeline,
  };
}

const TIMING_REVIEW_RULES = [
  "时长依据：TIMING_CONTEXT 的 start/end/duration 是分镜安排的秒数；actualTotalDuration 是全部分镜（包括无旁白镜头）的合计，plannedTotalDuration 是创作计划目标，二者不是实测音频或成片时长。",
  "节奏判断必须结合每镜时长、台词密度和完整时间线。按原口播语言粗估语速：英语约 2–3 词/秒，中文约 3–5 字/秒；其他语言或混合语言按其实际语言保守估算，不要把英文按中文字数计算。停顿与动作会占时间，估算必须明确标为估算，不能声称已测配音时长或口型同步。",
  "null 表示未知：缺少或无效的分镜秒数会使总时长及后续时间点无法确定，不得补造秒数或断言超时；可以指出需要试听核对。若该创作类型适用中段钩子规则，仅在已知 actualTotalDuration 时按实际秒数判断超过 20 秒和 40%–60% 的位置，不能用目标时长代替实际分镜合计。",
].join("\n");

const TIDEWE_TIMING_REVIEW_RULES = [
  "时长依据：TIMING_CONTEXT 的 start/end/duration 是分镜安排的秒数；actualTotalDuration 是全部分镜（包括无旁白镜头）的合计，plannedTotalDuration 是创作计划目标，二者不是实测音频或成片时长。",
  "TIDEWE 美式英语口播以 2.3 词/秒为目标，2.6 词/秒为上限；每个有台词镜头另留至少 0.3 秒自然停顿。最低分镜时长估算为英文词数 / 2.6 + 0.3 秒，舒适时长估算为英文词数 / 2.3 + 0.3 秒；动作还会占时间。估算必须明确标为估算，不能声称已测配音时长或口型同步。过密时建议延长或按原文拆镜，不改写冻结文案。",
  "null 表示未知：缺少或无效的分镜秒数会使总时长及后续时间点无法确定，不得补造秒数或断言超时；可以指出需要试听核对。",
].join("\n");

/** True when the text contains CJK characters (rewrite-language pick). */
function hasCjk(s: string): boolean {
  return /[一-鿿぀-ヿ가-힯]/.test(s);
}

/** Style-specific extra criteria appended per script style (keyed by styleType). */
const STYLE_CRITERIA: Record<string, string> = {
  reversal: [
    `反转专项判准（结构官加审）：`,
    `- 反转必须能填进一句话公式：「因为<铺垫过的事实>，原以为<原认知>不成立，被打脸的细节是<具体可感知点>」——填不进=反转不成立，invariant 级点名`,
    `- 揭示必须来自前面铺垫过的事实，凭空冒出的新信息不算反转`,
  ].join("\n"),
  drama: [
    `对话剧专项判准（口语官与结构官加审）：`,
    `- 每句台词必须能标出一个行动动词（怼/试探/炫耀/服软）——标不出行动的台词是解说词，不是对话`,
    `- 交换说话者测试：把这句台词换给对方说也毫无违和=这句没有立场，点名重写`,
    `- 每个角色要有自己的一条隐含议程（想赢什么），台词服务不了任何人议程的，点名`,
  ].join("\n"),
  interview: [
    `采访专项判准（口语官与结构官加审）：`,
    `- 受访者每句话必须能标出行动动词（质疑/惊讶/求证/转粉），纯配合式捧哏台词点名`,
    `- 交换说话者测试：主持人和受访者的台词互换后不违和=两人没有各自立场，点名重写`,
  ].join("\n"),
};

/**
 * Build the single-call judge-panel prompt. All five judges rule in one
 * response; rewrites must keep meaning/claims and stay within ±20% of the
 * original length so TTS timing still fits the shot slots.
 */
export function buildJudgePrompt(
  shots: JudgeShotInput[],
  opts: { styleLabel?: string; styleType?: string } & JudgeTimingOptions = {}
): string {
  const lines = shots.map((s) => {
    const desc = (s.description ?? "").trim();
    return desc
      ? `- shotId ${s.shotId}：台词「${s.voiceover}」｜画面「${desc}」`
      : `- shotId ${s.shotId}：「${s.voiceover}」`;
  });
  const english = shots.length > 0 && shots.every((s) => !hasCjk(`${s.voiceover}${s.description ?? ""}`));
  const styleExtra = opts.styleType ? STYLE_CRITERIA[opts.styleType] : undefined;
  return [
    `你是一支短视频「判官团」，由五位只管一件事、脾气很差的审稿人组成。任务：把下面这条${opts.styleLabel ? `（${opts.styleLabel}风格）` : ""}视频的逐镜台词与画面撕碎，再给出重写。`,
    ``,
    `五位判官（每位只从自己的角度挑刺，宁狠勿宽）：`,
    `1. 节奏官（pace）：只管留人。第一句钩不住人=死刑；每句必须让人想听下一句；信息密度低、又长又绕的句子全部点名。`,
    `2. 口语官（voice）：只管「说的不是写的」。判准如下（铁律）：`,
    SPOKEN_VOICE_RULES,
    `3. 创意官（idea）：只管新鲜感。套路化开头、用烂的梗、任何同类视频都会说的通用表达，全部点名。`,
    `4. 结构官（structure）：只管递进与收束。铺垫→递进→收束是否成立；结尾落金句/讲道理=违规；行动号召口号化=违规；全片超过 20 秒却没有一句中段续命钩（约 40%–60% 进度处重新开悬念的句子）=点名。另加两条全局检查：`,
    `   - 信息密度均匀=没有一镜是事件：逐镜信息量完全平均说明全片没有高潮，点名密度最低的镜让它让位`,
    `   - 「不成立的钩子替代品」负例清单：无来源的新悬念（前文没铺垫突然抛问题）、藏结果式吊胃口（黑屏/"结果你们猜"却不兑现）、把同一句威胁复读得更大声——这三种都不算钩子，点名`,
    `5. 画面官（visual）：只管「这一秒画面里谁做了什么」。判准：`,
    `   - description 必须是可见事实：谁（角色名/手部）+ 做什么动作 + 对什么对象；镜头拍不出来的写法都点名`,
    `   - 功能句不是画面：「展示产品效果」「建立信任感」「体现品质」这类目的描述=没写画面，invariant 级点名并给出可见动作重写（写进 descriptionRewrites）`,
    `   - 重写保持原镜意图与场景，只把"目的"翻译成"动作"，长度与原句相当`,
    styleExtra ?? "",
    ``,
    `证据规则（对所有判官生效）：每条 issue 必须包含两个要素——①用「」引出原句/原描述里出问题的片段；②一句话说清什么没有成立。没有引文的挑刺视为无效。`,
    ``,
    `采纳分级（每条 issue 与每条重写都必须标 tier）：`,
    `- invariant：硬伤，不改必翻车（事实/合规风险、第一句钩不住、功能句无画面、台词密到口型对不上）`,
    `- default：默认应改（口语铁律违规、套路化表达、结构断裂）`,
    `- taste：品味之争（换个说法也成立）——只提出，不强求；自动化流程不会采纳 taste 级重写`,
    ``,
    `逐镜内容：`,
    ...lines,
    `TIMING_CONTEXT: ${JSON.stringify(buildJudgeTimingContext(opts.timelineShots ?? shots, opts))}`,
    TIMING_REVIEW_RULES,
    ``,
    `只输出 JSON，格式：`,
    `{"verdicts":[{"judge":"pace","issues":[{"shotId":1,"issue":"「原句片段」——什么没有成立","tier":"default"}]},{"judge":"voice","issues":[]},{"judge":"idea","issues":[]},{"judge":"structure","issues":[]},{"judge":"visual","issues":[]}],"rewrites":[{"shotId":1,"voiceover":"重写后的台词","tier":"default"}],"descriptionRewrites":[{"shotId":2,"description":"重写后的画面描述（可见动作）","tier":"invariant"}],"summary":"一句话总评"}`,
    ``,
    `重写规则：`,
    `- 保留原意、卖点与所有事实性说法，只改「怎么说」；不新增任何功效/价格承诺（广告合规红线）`,
    `- 重写句必须原样保留原句里出现的所有数字、价格与规格（服务端会逐个校验数字 token，丢一个整条弃用）`,
    `- 重写后的台词必须像「说出来的」，且长度与原句相当（字数差控制在 ±20%，配音时长钉死在分镜槽里）`,
    `- 没毛病的镜头不要出现在 rewrites/descriptionRewrites 里；判官没意见就各自给空 issues`,
    english ? `- All issues and rewrites in English (the script is English).` : ``,
  ]
    .filter((l) => l !== undefined && l !== "")
    .join("\n");
}

/** Historical copy can use current appearance context without promoting it to confirmed facts. */
export function withTideweJudgeProductContext(copy: TideweCopyDocument, current: { productName?: string | null; productAnalysis?: string | null }): TideweCopyDocument {
  return {
    ...copy,
    productName: copy.productName?.trim() ? copy.productName : current.productName ?? "",
    visualObservations: copy.visualObservations?.trim() ? copy.visualObservations : current.productAnalysis ?? "",
  };
}

/** Review the canonical brand copy without offering executable per-shot narration rewrites. */
export function buildTideweJudgePrompt(copy: TideweCopyDocument, shots: JudgeShotInput[], opts: TideweJudgeOptions = {}): string {
  const productCoverageIssues = opts.productCoverageIssues ?? getTideweProductCoverageIssues(shots, {
    copyDocument: copy,
    videoMode: opts.videoMode,
    requireEvidence: true,
  });
  return [
    "Review this US-English TIDEWE outdoor product narration. Return feedback only; do not rewrite or translate it.",
    `Mandatory capture style for every first-frame image and its animated shot: ${TIDEWE_NATIVE_CAMERA_STYLE}`,
    "A first frame establishes this style directly; it does not need an existing first frame. Review motion under the same style. Preserve the scene's specified weather, time of day and natural ambient light. Flag added lighting equipment, sharpening, retouching or filter directions that conflict with this shared style; never recommend changing scene conditions or adding light to achieve it.",
    "Judge pace, natural American spoken voice, a specific outdoor use or buying question, one coherent value, and the relationship between the narration and feasible visuals.",
    copy.source === "user_provided"
      ? "This is frozen staff-written copy. Preserve its exact prose, punctuation, repetition, experiences and existing offer; do not apply the AI's writing formula, censor it or provide executable text/description rewrites. A staff anecdote is not confirmed product evidence; flag unsupported product assertions for verification without declaring a personal experience invented merely because it is absent from the fact table."
      : "A first-person preference is allowed. Invented ownership, tests, testimonials, scarcity, offers, and unsupported performance are defects in AI-written copy.",
    "Current confirmed nonconflicting product facts below are the only evidence for functional, numeric or performance claims. Observed facts show appearance only. Neither a touch nor a press proves heat, waterproofing, durability or long-term comfort. Never transfer specifications from a reference product or turn an assertion into a fabricated visual test.",
    "The current product name, appearance observations and reference-supported visible components can support showing the actual product, its appearance, ordinary handling or wearing. They cannot establish performance. Appearance context comes from the saved copy snapshot, with the current project used only when a historical snapshot is missing; it does not add confirmed facts. An empty confirmed fact table does not justify hiding the product throughout a product video; separate visible appearance evidence from unsupported functional claims.",
    "Do not demand dual CTAs, a mid-video suspense hook, a product in every frame, a visible presenter, or one unchanging room.",
    "Product coverage is a minimum production requirement: a product video cannot have zero product-visible shots. For three or more shots, at least ceil(shotCount / 2) must visibly contain the current product and at least one must give a close_up or detail view of an actual product component. For VIDEO_MODE=scene_demo with three or more shots, require at least one reference-supported handling, wearing or ordinary-use shot. Preserve useful context shots; these minimums do not require the product in every frame or authorize invented features or performance tests.",
    "Check that detail and demonstration copy visualBeats map through the real copySpan to actual product-visible evidence. A product detail or demonstration cannot become an unrelated talking-head or environment shot. Inspect productFocus, description and framing together: the named component must actually fit inside the frame. Use CATEGORY_GUIDANCE for the current product's possible observations and contact relationships, subject to its actual references; never import a different category's parts or force an example into every shot. Off-camera narration may cover these close views without forcing a face into the frame.",
    "Review every supplied shot, including silent shots, for its visual contribution. Match each shot's visualPlan.visualRole and described observation to the meaning of its narration: a presenter can explain a question or qualification, a supported action can demonstrate ordinary use, a detail can show the referenced visible component, and context can establish the use situation. Do not demand a separate demonstration for every sentence or literal action for every clause. Chinese descriptions, camera and action fields are visual directions, not narration.",
    "Static context and a maintained product observation are valid. Assess whether the first-frame actionStart is already physically established, the action is one modest feasible action or observation, and actionEnd is a credible supported stable state. Check grips, contact, weight and product continuity; do not force a new person or movement into a valid static shot. Missing visualPlan on a historical shot is not itself a defect: review its actual description and camera.",
    "Across shots check meaningful changes of viewpoint, framing scale and visual role, repeated actions with no new evidence, and consecutive descriptions that merely relabel the same picture. Judge duplication from actual framing, action and purpose, not enum values alone. Variation must serve the narration and current product; do not demand a fixed nine-shot template or invent features to fill a visual quota.",
    "Review five photographic requirements against the saved visual directions: (1) person, product and environment share light direction, color temperature, perspective, occlusion and contact shadows; avoid cutout edges or floating contact; (2) full-body and medium views use ordinary phone main-camera deep focus: nearby ground and midground stay naturally clear. Where already present, midground and farther tree trunks, branches, path layers and scene silhouettes remain recognizable, with at most slight optical softness in the distance. In every framing scale, including close_up and detail, where an existing ground, tabletop or other supporting surface already extends continuously from the image's bottom edge through to the subject's contact point, that whole region must stay naturally readable. Do not recommend adding or extending a supporting surface to satisfy this rule. The main product, contact area, connected supporting surface and its visible lower frame edge are protected from defocus. Flag a blurred foreground strip, tilt-shift top-and-bottom blur bands or vignette-like edge defocus. For close component shots, ALL visible foreground in front of the subject must remain naturally resolved, including isolated near grass, leaves and edge objects disconnected from the product or support. Only distant background BEHIND the subject may have slight natural optical softness; existing surroundings must retain readable structure. No nearer-object defocus exception applies. Preserve intentional empty backgrounds; do not demand new scenery to illustrate these examples or every leaf or distance plane equally sharp. Do not recommend changing the approved aspect ratio, crop, composition, action or product support to satisfy focus requirements. Flag broad creamy blur, bokeh disks, portrait-mode masks or an abrupt blur boundary along the subject's outline; (3) use accurate neutral daylight white balance for daylight scenes so product colors and details remain legible, otherwise respect the scene's explicitly established natural ambient light and color; (4) retain natural skin, fabric and rubber with no sharpening, no HDR processing or oily/painterly texture. If subject edges or textures look too crisp, recommend removing selective or global sharpening and local microcontrast processing; never recommend sharpening the background or blurring the full image. Preserve presenter identity, actual product markings and supported material appearance; never recommend invented fine texture or hidden structure to create clarity; (5) give a filming friend believable interaction through motivated eye contact, practical gestures and real hand/product or foot/ground contact. Assess the proposed frame and action; do not claim to have inspected generated pixels.",
    "Follow SPEECH_MODE: voiceover means post-production narration with no visible speaking requirement, irrespective of per-shot delivery. For on_camera mode, only speechDelivery=on_camera requires a visible unobstructed speaking mouth; omitted historical delivery keeps that default for narrated shots. speechDelivery=off_camera allows the same creator's narration over hands, a rear view, product details or person-free context without adding a talking face or lip synchronization. personVisible=true may mean only hands, sleeves or boots. Silent shots need no speaking mouth in either mode.",
    "Quote the exact offending English copy or Chinese visual phrase in every issue. Write explanations in Chinese for review.",
    `COPY_SOURCE: ${copy.source ?? "ai_generated"}`,
    `SPEECH_MODE: ${opts.speechMode ?? "on_camera"}`,
    `VIDEO_MODE: ${opts.videoMode ?? "scene_demo"}`,
    `CURRENT_PRODUCT_NAME: ${JSON.stringify(copy.productName ?? "")}`,
    `CURRENT_PRODUCT_FACTS: ${JSON.stringify(copy.factsSnapshot)}`,
    `CURRENT_VISUAL_OBSERVATIONS: ${JSON.stringify(copy.visualObservations ?? "")}`,
    `CATEGORY_GUIDANCE: ${JSON.stringify(buildTideweCategoryGuidance(copy.factsSnapshot.category, { productName: copy.productName, visualObservations: copy.visualObservations }))}`,
    `COPY_VISUAL_BEATS: ${JSON.stringify(copy.visualBeats ?? [])}`,
    `DETERMINISTIC_PRODUCT_COVERAGE_ISSUES: ${JSON.stringify(productCoverageIssues)}`,
    "The deterministic coverage issues are objective storyboard defects. Address them in visual feedback even if the narration reads well; they remain in the final report independently of model opinion. Review only: never rewrite the frozen copy or silently repair the storyboard.",
    `FINAL_COPY: ${JSON.stringify(copy.text)}`,
    `SHOTS: ${JSON.stringify(shots)}`,
    `TIMING_CONTEXT: ${JSON.stringify(buildJudgeTimingContext(opts.timelineShots ?? shots, opts))}`,
    TIDEWE_TIMING_REVIEW_RULES,
    'Return JSON only: {"verdicts":[{"judge":"pace","issues":[{"shotId":1,"issue":"quoted evidence and reason","tier":"default"}]},{"judge":"voice","issues":[]},{"judge":"idea","issues":[]},{"judge":"structure","issues":[]},{"judge":"visual","issues":[]}],"rewrites":[],"descriptionRewrites":[],"summary":"中文总评"}.',
    "Use invariant only for factual/structural defects, default for clear writing problems, taste for preferences. Never output rewritten narration.",
  ].join("\n");
}

/** Keep objective coverage defects visible even when the model returns no visual issues. */
export function withTideweProductCoverageIssues(report: JudgeReport, issues: TideweProductCoverageIssue[]): JudgeReport {
  if (!issues.length) return report;
  const visual = report.verdicts.find(verdict => verdict.judge === "visual");
  const merged = [...(visual?.issues ?? [])];
  for (const issue of issues) {
    const text = `[${issue.code}] ${issue.message}`;
    if (!merged.some(existing => existing.shotId === issue.shotId && existing.issue === text)) {
      merged.push({ ...(issue.shotId !== undefined && { shotId: issue.shotId }), issue: text, tier: "invariant" });
    }
  }
  return {
    ...report,
    verdicts: visual
      ? report.verdicts.map(verdict => verdict.judge === "visual" ? { ...verdict, issues: merged } : verdict)
      : [...report.verdicts, { judge: "visual", issues: merged }],
  };
}

/** Clamp a tier value; anything unrecognized becomes "taste" (show, never auto-change). */
function clampTier(raw: unknown): JudgeTier {
  return typeof raw === "string" && (JUDGE_TIERS as readonly string[]).includes(raw) ? (raw as JudgeTier) : "taste";
}

/**
 * Numeric fact tokens of a line (prices, specs, counts). Matching is
 * boundary-guarded so "3" never matches inside "13" — a rewrite that changed a
 * number must be dropped, not accepted by substring luck.
 */
export function factTokens(text: string): string[] {
  return Array.from(new Set(text.match(/\d+(?:\.\d+)?/g) ?? []));
}

/** True when every numeric fact token of the original survives verbatim in the rewrite. */
export function preservesFactTokens(original: string, rewrite: string): boolean {
  for (const tok of factTokens(original)) {
    const re = new RegExp(`(?<![\\d.])${tok.replace(".", "\\.")}(?![\\d.])`);
    if (!re.test(rewrite)) return false;
  }
  return true;
}

/** Clamp one issue list: keep only entries with usable text; shotId must exist when given. */
function clampIssues(raw: unknown, validShots: Set<number>): JudgeIssue[] {
  if (!Array.isArray(raw)) return [];
  const out: JudgeIssue[] = [];
  for (const it of raw) {
    const issue = typeof (it as { issue?: unknown })?.issue === "string" ? (it as { issue: string }).issue.trim() : "";
    if (!issue) continue;
    const sid = (it as { shotId?: unknown }).shotId;
    const shotId = typeof sid === "number" && validShots.has(sid) ? sid : undefined;
    const tier = clampTier((it as { tier?: unknown }).tier);
    out.push(shotId === undefined ? { issue, tier } : { shotId, issue, tier });
  }
  return out;
}

/** Shared clamp for text rewrites: real shot, non-empty, sane length ratio, facts preserved. */
function clampTextRewrites<T>(
  raw: unknown,
  originals: Map<number, string>,
  field: "voiceover" | "description",
  make: (shotId: number, text: string, tier: JudgeTier) => T
): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  const seen = new Set<number>();
  for (const r of raw) {
    const shotId = (r as { shotId?: unknown })?.shotId;
    const text =
      typeof (r as Record<string, unknown>)?.[field] === "string"
        ? ((r as Record<string, string>)[field] as string).trim()
        : "";
    if (typeof shotId !== "number" || !originals.has(shotId) || !text || seen.has(shotId)) continue;
    const original = originals.get(shotId) ?? "";
    const origLen = original.trim().length;
    if (origLen > 0) {
      // 0.4x–2.5x: beyond that the TTS timing breaks (voiceover) or the shot got re-imagined
      const ratio = text.length / origLen;
      if (ratio < 0.4 || ratio > 2.5) continue;
    }
    // evidence discipline: a rewrite that loses a number lost a fact — drop it
    if (!preservesFactTokens(original, text)) continue;
    seen.add(shotId);
    out.push(make(shotId, text, clampTier((r as { tier?: unknown }).tier)));
  }
  return out;
}

/**
 * Parse + clamp the LLM's judge response. Unknown judges are dropped, missing
 * judges get empty issue lists (the UI renders all five); voiceover and
 * description rewrites are kept only for real shots with non-empty text within
 * a sane length ratio of the original AND with every numeric fact token intact.
 */
export function parseJudgeResponse(content: string, shots: JudgeShotInput[]): JudgeReport {
  const validShots = new Set(shots.map((s) => s.shotId));
  const voiceoverByShot = new Map(shots.map((s) => [s.shotId, s.voiceover]));
  // description rewrites only apply to shots that HAVE a description
  const descriptionByShot = new Map(
    shots.filter((s) => (s.description ?? "").trim()).map((s) => [s.shotId, (s.description ?? "").trim()])
  );
  let raw: unknown;
  try {
    raw = JSON.parse(extractJSON(content));
  } catch {
    throw new Error("判官团返回的不是合法 JSON");
  }

  const rawVerdicts = Array.isArray((raw as { verdicts?: unknown })?.verdicts)
    ? ((raw as { verdicts: unknown[] }).verdicts as unknown[])
    : [];
  const byJudge = new Map<JudgeId, JudgeIssue[]>();
  for (const v of rawVerdicts) {
    const judge = (v as { judge?: unknown })?.judge;
    if (typeof judge !== "string" || !(JUDGE_IDS as readonly string[]).includes(judge)) continue;
    byJudge.set(judge as JudgeId, clampIssues((v as { issues?: unknown }).issues, validShots));
  }
  const verdicts: JudgeVerdict[] = JUDGE_IDS.map((id) => ({ judge: id, issues: byJudge.get(id) ?? [] }));

  const rewrites = clampTextRewrites(
    (raw as { rewrites?: unknown })?.rewrites,
    voiceoverByShot,
    "voiceover",
    (shotId, voiceover, tier): JudgeRewrite => ({ shotId, voiceover, tier })
  );
  const descriptionRewrites = clampTextRewrites(
    (raw as { descriptionRewrites?: unknown })?.descriptionRewrites,
    descriptionByShot,
    "description",
    (shotId, description, tier): JudgeDescriptionRewrite => ({ shotId, description, tier })
  );

  const summary = typeof (raw as { summary?: unknown })?.summary === "string" ? (raw as { summary: string }).summary.trim() : undefined;
  return { verdicts, rewrites, descriptionRewrites, summary: summary || undefined };
}

/**
 * The rewrites automation may apply without a human in the loop: invariant and
 * default tiers only. Taste-tier rewrites are opinions — every hands-off chain
 * (web free / AI / batch / CLI / MCP) displays them but never auto-applies.
 */
export function autoApplicableRewrites(report: JudgeReport): JudgeRewrite[] {
  return report.rewrites.filter((r) => r.tier !== "taste");
}

/** Same gate for the visual judge's description rewrites. */
export function autoApplicableDescriptionRewrites(report: JudgeReport): JudgeDescriptionRewrite[] {
  return report.descriptionRewrites.filter((r) => r.tier !== "taste");
}
