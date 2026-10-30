import type { Shot } from "@/lib/db/schema";
import { claimableFacts, normalizeProductFacts } from "./facts";
import type { ProductFacts, TideweCopyBeat, TideweCopyDocument, TideweVisualPlan, TideweVisualRole } from "./types";
import { englishWordCount, mapTideweCopySpans, TideweValidationError } from "./validation";

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const ROLES = new Set<TideweVisualRole>(["presenter", "demonstration", "detail", "context"]);
const FRAMINGS = new Set<TideweVisualPlan["framing"]>(["wide", "medium", "close_up", "detail"]);

function fail(message: string): never { throw new TideweValidationError(message); }

function chineseText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || !/[\u3400-\u9fff]/u.test(value) || value.trim().length > 240) {
    fail(`${label} must be concise Chinese text (1–240 characters); describe the actual visible state or action.`);
  }
  return value.trim();
}

function visualRole(value: unknown, label: string): TideweVisualRole {
  if (typeof value !== "string" || !ROLES.has(value as TideweVisualRole)) {
    fail(`${label} must be presenter, demonstration, detail or context.`);
  }
  return value as TideweVisualRole;
}

/** Evidence beats belong to the AI copy stage; they never authorize changing frozen narration. */
export function parseTideweCopyBeats(value: unknown, text: string, facts: ProductFacts): TideweCopyBeat[] {
  if (!Array.isArray(value) || !value.length) fail("AI copy requires visualBeats covering its complete English narration in order.");
  const allowedFacts = new Set(claimableFacts(normalizeProductFacts(facts) ?? facts).map(fact => fact.id));
  const beats = value.map((raw: unknown, index): TideweCopyBeat => {
    const label = `Copy visual beat ${index + 1}`;
    if (!record(raw) || typeof raw.text !== "string" || !raw.text.trim()) fail(`${label} requires a nonempty verbatim text segment.`);
    if (!Array.isArray(raw.factRefs) || raw.factRefs.some(id => typeof id !== "string" || !allowedFacts.has(id))) {
      fail(`${label} factRefs must cite only confirmed, nonconflicting current-product fact IDs; use [] for contextual visuals.`);
    }
    return {
      text: raw.text.trim(),
      visualRole: visualRole(raw.visualRole, `${label} visualRole`),
      visualIdea: chineseText(raw.visualIdea, `${label} visualIdea`),
      factRefs: [...new Set(raw.factRefs as string[])],
    };
  });
  try { mapTideweCopySpans(text, beats.map(beat => ({ scriptSegment: beat.text }))); }
  catch (error) {
    fail(`Copy visualBeats must cover the complete frozen narration verbatim and in order: ${error instanceof Error ? error.message : String(error)}`);
  }
  return beats;
}

/** Required only for freshly planned shots; historical scripts need no synthetic metadata. */
export function parseTideweVisualPlan(value: unknown): TideweVisualPlan {
  if (!record(value)) fail("Each new shot requires visualPlan with framing, visualRole, actionStart, action and actionEnd.");
  if (typeof value.framing !== "string" || !FRAMINGS.has(value.framing as TideweVisualPlan["framing"])) {
    fail("Shot visualPlan framing must be wide, medium, close_up or detail.");
  }
  return {
    framing: value.framing as TideweVisualPlan["framing"],
    visualRole: visualRole(value.visualRole, "Shot visualPlan visualRole"),
    actionStart: chineseText(value.actionStart, "Shot visualPlan actionStart"),
    action: chineseText(value.action, "Shot visualPlan action"),
    actionEnd: chineseText(value.actionEnd, "Shot visualPlan actionEnd"),
    ...(value.productFocus !== undefined && { productFocus: chineseText(value.productFocus, "Shot visualPlan productFocus") }),
  };
}

/** Minimal shared input for the generator, grid and review; no prose inference. */
export interface TideweProductCoverageShot {
  shotId: number;
  tidewe?: {
    productVisible?: boolean;
    personVisible?: boolean;
    visualPlan?: TideweVisualPlan;
    copySpan?: { start: number; end: number };
  };
}

export interface TideweProductCoverageOptions {
  copyDocument?: Pick<TideweCopyDocument, "text" | "visualBeats">;
  videoMode?: "scene_demo" | "product_closeup";
  /** Fresh plans require explicit product evidence; historical metadata stays optional. */
  requireEvidence?: boolean;
}

export interface TideweProductCoverageIssue {
  code: string;
  message: string;
  shotId?: number;
}

/** Structural coverage only: actions and claimed benefits still need semantic review. */
export function getTideweProductCoverageIssues(shots: TideweProductCoverageShot[], options: TideweProductCoverageOptions = {}): TideweProductCoverageIssue[] {
  const issues: TideweProductCoverageIssue[] = [];
  const productShots = shots.filter(shot => shot.tidewe?.productVisible === true);
  if (!productShots.length) {
    issues.push({ code: "PRODUCT_NOT_VISIBLE", message: "The storyboard must show the current product in at least one shot; an entirely person-only or environmental plan cannot demonstrate the item." });
  }
  for (const shot of shots) {
    const fields = shot.tidewe;
    const role = fields?.visualPlan?.visualRole;
    if ((role === "detail" || role === "demonstration") && fields?.productVisible === false) {
      issues.push({ code: "PRODUCT_ROLE_WITHOUT_PRODUCT", shotId: shot.shotId, message: `Shot ${shot.shotId} is a product ${role} but hides the product; show the supported current product or assign an honest presenter/context role.` });
    }
    if (options.requireEvidence && fields?.productVisible === true) {
      const focus = fields.visualPlan?.productFocus;
      if (typeof focus !== "string" || !focus.trim() || focus.trim().length > 240 || !/[\u3400-\u9fff]/u.test(focus)) {
        issues.push({ code: "PRODUCT_FOCUS_MISSING", shotId: shot.shotId, message: `Shot ${shot.shotId} must name the visible current-product area or relationship in concise Chinese productFocus (1–240 characters); do not invent a functional claim.` });
      }
    }
  }
  if (options.requireEvidence && shots.length >= 3) {
    const minimum = Math.ceil(shots.length / 2);
    if (productShots.length < minimum) {
      issues.push({ code: "PRODUCT_COVERAGE_LOW", message: `The ${shots.length}-shot storyboard needs at least ${minimum} product-visible shots; only ${productShots.length} currently show the item.` });
    }
    if (!productShots.some(shot => shot.tidewe?.visualPlan?.visualRole === "detail" && ["close_up", "detail"].includes(shot.tidewe.visualPlan.framing))) {
      issues.push({ code: "PRODUCT_DETAIL_MISSING", message: "Include at least one product-visible detail role in close_up or detail framing so the item's supported visible construction or material can be inspected." });
    }
    if (options.videoMode === "scene_demo" && !productShots.some(shot => shot.tidewe?.personVisible === true && shot.tidewe.visualPlan?.visualRole === "demonstration")) {
      issues.push({ code: "PRODUCT_USE_MISSING", message: "A scene_demo storyboard needs a person-visible, product-visible demonstration of supported use, holding or wearing; review the described action for actual use rather than relying on its role label." });
    }
  }
  const copy = options.copyDocument;
  if (copy?.visualBeats?.length) {
    let spans: { start: number; end: number }[];
    try { spans = mapTideweCopySpans(copy.text, copy.visualBeats.map(beat => ({ scriptSegment: beat.text }))); }
    catch (error) {
      issues.push({ code: "COPY_BEAT_SPANS_INVALID", message: `Copy visualBeats must map to the complete frozen narration before product coverage can be assessed: ${error instanceof Error ? error.message : String(error)}` });
      return issues;
    }
    copy.visualBeats.forEach((beat, index) => {
      if (beat.visualRole !== "detail" && beat.visualRole !== "demonstration") return;
      const span = spans[index];
      const overlapping = shots.filter(shot => {
        const shotSpan = shot.tidewe?.copySpan;
        return shotSpan && Number.isInteger(shotSpan.start) && Number.isInteger(shotSpan.end)
          && shotSpan.start >= 0 && shotSpan.end <= copy.text.length
          && Math.max(shotSpan.start, span.start) < Math.min(shotSpan.end, span.end);
      });
      if (overlapping.some(shot => shot.tidewe?.productVisible === true && shot.tidewe.visualPlan?.visualRole === beat.visualRole)) return;
      // A saved product-visible shot without a plan has no reliable role to compare.
      if (!options.requireEvidence && overlapping.some(shot => shot.tidewe?.productVisible === true && !shot.tidewe.visualPlan)) return;
      issues.push({ code: "COPY_BEAT_PRODUCT_EVIDENCE_MISSING", message: `Copy visual beat ${index + 1} (${beat.visualRole}) needs at least one product-visible shot with the same visual role whose narration span positively overlaps that exact beat; preserve its product observation when splitting or merging shots.` });
    });
  }
  return issues;
}

export function assertTideweProductCoverage(shots: TideweProductCoverageShot[], options: TideweProductCoverageOptions = {}): void {
  const issues = getTideweProductCoverageIssues(shots, options);
  if (issues.length) fail(issues.map(issue => issue.message).join("\n"));
}

const normalizedTask = (value: string): string => value.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");

/** Run inside the planner's existing parse/repair boundary, never as a new model call. */
export function assertTidewePlanQuality(shots: Shot[], options: Omit<TideweProductCoverageOptions, "requireEvidence"> & { targetDuration?: number; source?: "ai_generated" | "user_provided" } = {}): void {
  if (!shots.length) fail("The new storyboard requires at least one shot covering the narration.");
  const plans = shots.map(shot => {
    let plan: TideweVisualPlan;
    try { plan = parseTideweVisualPlan(shot.tidewe?.visualPlan); }
    catch (error) { fail(`Shot ${shot.shotId}: ${error instanceof Error ? error.message : String(error)}`); }
    if (!Number.isFinite(shot.duration) || shot.duration <= 0) fail(`Shot ${shot.shotId} requires a positive finite duration.`);
    if (shot.voiceover.trim()) {
      const minimum = englishWordCount(shot.voiceover) / 2.6 + 0.3;
      if (shot.duration + 0.01 < minimum) {
        fail(`Shot ${shot.shotId} needs at least ${(Math.ceil(minimum * 10) / 10).toFixed(1)}s for its ${englishWordCount(shot.voiceover)} spoken words and a brief pause; extend it or split the exact narration without rewriting it.`);
      }
      if (shot.tidewe?.speechDelivery === "on_camera" && plan.framing === "detail") {
        fail(`Shot ${shot.shotId} has on_camera speech in detail framing; use off_camera narration or choose a framing that includes the speaking face.`);
      }
    }
    return plan;
  });
  if (shots.length >= 7) {
    if (new Set(plans.map(plan => plan.framing)).size < 3) {
      fail("A storyboard with seven or more shots needs at least three framing scales; vary useful wide, medium and close details without changing the narration.");
    }
    if (new Set(plans.map(plan => plan.visualRole)).size < 2) {
      fail("A storyboard with seven or more shots needs at least two visual roles; combine presenter, demonstration, detail or context shots with distinct purposes.");
    }
  }
  const tasks = plans.map((plan, index) => [plan.framing, plan.visualRole, normalizedTask(plan.action), normalizedTask(shots[index].tidewe?.shotGoal ?? "")].join("|"));
  for (let index = 2; index < tasks.length; index++) {
    if (tasks[index] === tasks[index - 1] && tasks[index] === tasks[index - 2]) {
      fail(`Shots ${shots[index - 2].shotId}, ${shots[index - 1].shotId} and ${shots[index].shotId} repeat the same framing, visual role, action and goal; give one a distinct visual task while preserving the frozen narration.`);
    }
  }
  if (options.targetDuration !== undefined) {
    if (!Number.isFinite(options.targetDuration) || options.targetDuration <= 0) fail("Storyboard targetDuration must be positive and finite.");
    if (options.source !== "user_provided") {
      const total = shots.reduce((sum, shot) => sum + shot.duration, 0);
      const maximum = options.targetDuration * 1.25 + 2;
      if (total > maximum + 0.01) {
        fail(`AI storyboard totals ${Number(total.toFixed(1))}s, exceeding ${Number(maximum.toFixed(1))}s for the ${options.targetDuration}s target; reduce unnecessary holds or split actions within the speech budget without rewriting the frozen copy.`);
      }
    }
  }
  assertTideweProductCoverage(shots, { ...options, requireEvidence: true });
}
