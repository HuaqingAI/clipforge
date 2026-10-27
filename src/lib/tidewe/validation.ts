import { createHash } from "node:crypto";
import type { Shot } from "@/lib/db/schema";
import { claimableFacts, normalizeProductFacts } from "./facts";
import { TIDEWE_COMPILER_VERSION, TIDEWE_CORPUS_VERSION, type ProductFacts, type TideweCopyDocument, type TidewePresenterSnapshot } from "./types";
import { isValidTidewePresenterInput, tidewePresenterAnchor, TIDEWE_PRESENTER_PLACEHOLDER } from "./presenter";

export class TideweValidationError extends Error {
  readonly code = "TIDEWE_VALIDATION_FAILED";
  constructor(message: string) { super(message); this.name = "TideweValidationError"; }
}
export class TideweImportedCopyError extends Error {
  readonly code = "TIDEWE_IMPORTED_COPY_INVALID";
  readonly status = 400;
  constructor(message: string) { super(message); this.name = "TideweImportedCopyError"; }
}
function fail(message: string): never { throw new TideweValidationError(message); }

const PROHIBITED_VISUAL_TERMS = "热成像|发光热区|透视剖面|独立电池|thermal imaging|glowing heat|standalone battery";
const VISUAL_LIST_ITEM = `(?:${PROHIBITED_VISUAL_TERMS})(?:\\s*(?:效果|特效|画面|展示|effects?|visuals?|displays?))?`;
const VISUAL_LIST_SEPARATOR = String.raw`\s*(?:[、，,/](?:\s*\b(?:and|or|nor)\b)?|以及|或|和|与|及|\band\b|\bor\b|\bnor\b)\s*`;
// Only an explicit prohibition immediately before this item (or its noun list) applies.
// An action, contrast or another field between the prohibition and item ends its scope.
const NEGATED_VISUAL_PREFIX = new RegExp(
  String.raw`(?<!不是|并非|不能|不得|不要|不应|不可|并不|没有|禁止|避免|not )(?:` +
  String.raw`(?:禁止|避免|杜绝|不要|不得|不应|不可|不能|不允许|无需|没有|不是|并非|不|无|未)\s*(?:出现|使用|生成|展示|显示|呈现|添加|加入|引入|增加|采用|包含|制作|描绘|拍摄|渲染|提供|设置|表现|带|做|有)?\s*(?:任何|额外的?|新增的?)?` +
  String.raw`|\b(?:no|without|avoid|never|do\s+not|don['’]t|must\s+not|should\s+not|forbid(?:den)?)\s+(?:(?:show(?:ing)?|display(?:ing)?|generat(?:e|ing)|us(?:e|ing)|includ(?:e|ing)|render(?:ing)?|add(?:ing)?)\s+)?(?:any\s+)?` +
  String.raw`)\s*(?:` + VISUAL_LIST_ITEM + VISUAL_LIST_SEPARATOR + String.raw`)*$`, "iu",
);
const NEGATED_VISUAL_SUFFIX = /^\s*(?:均|一律|全部)?(?:禁用|禁止|不允许|不得使用)(?=$|[\s，,。.;；!！?？])/u;

function positiveProhibitedVisual(text: string): string | undefined {
  for (const match of text.matchAll(new RegExp(PROHIBITED_VISUAL_TERMS, "gi"))) {
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + match[0].length);
    if (!NEGATED_VISUAL_PREFIX.test(before) && !NEGATED_VISUAL_SUFFIX.test(after)) return match[0];
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  return value;
}
export function productFactsHash(facts: ProductFacts): string {
  return createHash("sha256").update(JSON.stringify(stable(normalizeProductFacts(facts)))).digest("hex");
}

export function canonicalizeTideweCopy(text: string): string {
  return text.replace(/```(?:\w+)?|```/g, "").replace(/\*\*|__/g, "")
    .replace(/^\s*(?:[-*#]+|\d+[.)])\s+/gm, "").replace(/\s+/g, " ").trim();
}
export function englishWordCount(text: string): number {
  return text.match(/[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*/g)?.length ?? 0;
}

/** Validate before vision/annotation calls; keep punctuation, paragraphs and repeated prose intact. */
export function assertTideweImportedCopy(text: unknown): asserts text is string {
  if (typeof text !== "string" || text.trim().length < 2 || text.length > 12000) {
    throw new TideweImportedCopyError("请输入完整英文口播文案（2–12000 个字符）。");
  }
  if (!/[A-Za-z]/.test(text) || /[\u3400-\u9fff]/u.test(text)) {
    throw new TideweImportedCopyError("请仅粘贴完整英文口播正文，中文译文请勿放入此处。");
  }
}

function assertTideweFactCitations(facts: ProductFacts, claimedIds: string[]): void {
  if (!Array.isArray(claimedIds) || claimedIds.some(id => typeof id !== "string")) fail("Copy fact citations must be an array of fact IDs");
  const ids = new Set(claimableFacts(facts).map(f => f.id));
  if (claimedIds.some(id => !ids.has(id))) fail("Copy references unknown, inferred or conflicting product facts");
}

export function assertTideweImportedCopyClaims(text: string, facts: ProductFacts, claimedIds: string[]): void {
  assertTideweImportedCopy(text);
  assertTideweFactCitations(facts, claimedIds);
}

/** Reject deterministic factual/style violations; semantic claim grounding also happens in the compiler. */
export function assertTideweCopyClaims(text: string, facts: ProductFacts, claimedIds: string[], fullTextContext = text): void {
  if (!text.trim() || text.length > 15000 || /[\u3400-\u9fff]/u.test(text)) fail("TIDEWE narration must be complete English copy");
  if (/\[[^\]]+\]|\b(?:shot|scene)\s*\d+\s*:|\b\d{1,2}:\d{2}\b/i.test(text)) fail("Remove stage directions, pause markup and timestamps from spoken copy");
  if (/\b(?:buy now|limited time|hurry|selling out|guaranteed (?:success|kill|hunt)|completely silent|100% silent|lifetime warranty)\b/i.test(text)) fail("Remove unsupported urgency, absolute claims or guarantees");
  if (/\bI(?:'ve| have) (?:used|owned|worn)|\bfor (?:years|\d+ years)\b/i.test(text)) fail("Do not invent ownership or long-term testimonials");
  const available = claimableFacts(facts);
  assertTideweFactCitations(facts, claimedIds);
  const evidence = available.filter(f => claimedIds.includes(f.id)).map(f => f.value).join(" ").toLowerCase();
  // Numeric specifications must occur in the explicitly cited current-product facts.
  for (const token of text.match(/\b\d+(?:[.,]\d+)?(?:°|%|g|kg|mAh|v|h)?/gi) ?? []) {
    if (!evidence.includes(token.toLowerCase())) fail(`Unsupported numeric specification: ${token}`);
  }
  const sku = facts.sku?.toUpperCase() ?? "";
  if (sku.startsWith("HJ006")) {
    if (/battery (?:is )?included|included battery|full[- ]zip|heated (?:front )?(?:pouch|pocket)/i.test(text)) fail("HJ006 must remain half-zip with compatible battery sold separately");
    // Local edits may have the purchase condition in a different, unchanged shot.
    if (/heat|heated|heating/i.test(fullTextContext) && !/battery[^.!?]{0,80}(?:sold separately|not included)|(?:separate|separately)[^.!?]{0,40}battery/i.test(fullTextContext)) fail("HJ006 copy must state the compatible battery purchase condition");
  }
  if (sku.startsWith("JTC001") && /waterproof|\b\d+\s*(?:hour|hr)/i.test(text)) fail("JTC001 waterproofing/runtime claims are not supported by the reference batch");
  if (sku.startsWith("HC001") && /heated|waterproof|silent/i.test(text)) fail("HC001 is nonheated, water resistant and low noise");
  if (sku.startsWith("THC004") && /heated back|back(?:rest)? (?:is )?heated|back heat/i.test(text)) fail("THC004 heats the seat only");
  if (sku.startsWith("BL022") && /360|four[- ]side|side door/i.test(text)) fail("BL022 must not inherit BL025 structure");
  if (sku.startsWith("BL025") && /270|three[- ]side|upward door/i.test(text)) fail("BL025 must not inherit BL022 structure");
}

export function assertTideweScript(script: { shots?: Shot[] | null; copyDocument?: TideweCopyDocument | null }, expectedPresenter?: TidewePresenterSnapshot | null): void {
  const copy = script.copyDocument;
  if (!copy || copy.version !== 1 || copy.language !== "en-US") fail("TIDEWE script requires a frozen English copy document");
  if (copy.corpusVersion !== TIDEWE_CORPUS_VERSION || copy.compilerVersion !== TIDEWE_COMPILER_VERSION) fail("Unsupported TIDEWE corpus/compiler version");
  if (copy.factsHash !== productFactsHash(copy.factsSnapshot)) fail("TIDEWE fact snapshot hash does not match");
  if (!copy.translation?.trim()) fail("TIDEWE copy requires a Chinese review translation");
  if (!/[\u3400-\u9fff]/u.test(copy.translation)) fail("Review translation must be Chinese");
  if (copy.source !== undefined && copy.source !== "ai_generated" && copy.source !== "user_provided") fail("Unsupported TIDEWE copy source");
  if (copy.source === "user_provided") {
    // Staff-written claims remain their prose; they never become confirmed product evidence.
    assertTideweImportedCopyClaims(copy.text, copy.factsSnapshot, copy.claimedFactIds);
  } else {
    assertTideweCopyClaims(copy.text, copy.factsSnapshot, copy.claimedFactIds);
  }
  const facts = new Set(claimableFacts(copy.factsSnapshot).map(f => f.id));
  const shots = script.shots;
  if (!shots?.length) fail("TIDEWE script requires semantic shots");
  let cursor = 0;
  const shotIds = new Set<number>();
  const presenterSnapshot = JSON.stringify(stable(shots[0].tidewe?.presenter ?? null));
  if (expectedPresenter !== undefined && presenterSnapshot !== JSON.stringify(stable(expectedPresenter))) fail("TIDEWE script presenter does not match its frozen creative profile");
  for (const shot of shots) {
    const fields = shot.tidewe;
    if (!fields) fail(`Shot ${shot.shotId} is missing TIDEWE fields`);
    const { start, end } = fields.copySpan;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < cursor || end < start || end > copy.text.length) fail("Copy spans must be ordered, nonoverlapping UTF-16 offsets");
    if (copy.text.slice(cursor, start).trim()) fail("Shot plan omitted or reordered original copy");
    if (shot.voiceover !== copy.text.slice(start, end).trim()) fail("Shot narration changed frozen copy");
    if (!Number.isFinite(shot.duration) || shot.duration <= 0 || shotIds.has(shot.shotId)) fail("Invalid shot duration or duplicate shot ID");
    if (!fields.sceneId?.trim() || !fields.shotGoal?.trim() || typeof fields.productVisible !== "boolean") fail("Shot requires scene, goal and product visibility");
    if (fields.personVisible !== undefined && typeof fields.personVisible !== "boolean") fail("Shot person visibility must be a boolean");
    if (JSON.stringify(stable(fields.presenter ?? null)) !== presenterSnapshot) fail("TIDEWE shots must keep the same frozen presenter");
    if (fields.presenter && (!isValidTidewePresenterInput(fields.presenter) || typeof fields.personVisible !== "boolean")) fail("Selected presenter requires a valid frozen identity and explicit person visibility");
    if (fields.presenter && fields.personVisible && !shot.description.includes(tidewePresenterAnchor(fields.presenter))) fail("Person-visible description must retain the saved presenter identity");
    if (!fields.productVisible && shot.visualSource === "product_image") fail("An environment shot cannot use a raw product photo");
    if (shot.voiceover && !fields.translation?.trim()) fail("Voiced shot requires a Chinese translation");
    if (fields.factRefs.some(id => !facts.has(id))) fail("Shot references unknown or conflicting product facts");
    if (![shot.description, shot.camera, shot.prompt, shot.visualIntent, fields.shotGoal].every(value => typeof value === "string" && /[\u3400-\u9fff]/u.test(value))) fail("TIDEWE visual fields must be Chinese");
    const visualFields = [
      ["画面描述", shot.description], ["画面提示", shot.prompt], ["视觉意图", shot.visualIntent],
      ["运镜", shot.camera], ["画面目标", fields.shotGoal],
    ] as const;
    for (const [label, visual] of visualFields) {
      if (visual?.includes(TIDEWE_PRESENTER_PLACEHOLDER)) fail("Unresolved TIDEWE presenter placeholder");
      const prohibited = positiveProhibitedVisual(visual ?? "");
      if (prohibited) fail(`镜头 ${shot.shotId} 的${label}要求了不支持的视觉「${prohibited}」，请改为真实户外使用画面。禁止说明不会触发此校验。`);
    }
    shotIds.add(shot.shotId);
    cursor = end;
  }
  if (copy.text.slice(cursor).trim()) fail("Shot plan omitted the end of the original copy");
}

export interface TideweCopySegment { scriptSegment: string; }
/** Match at the current cursor, never indexOf across skipped words or repeated phrases. */
export function mapTideweCopySpans(text: string, segments: TideweCopySegment[]): { start: number; end: number }[] {
  let cursor = 0;
  const spans = segments.map(({ scriptSegment }) => {
    if (typeof scriptSegment !== "string") return fail("Shot scriptSegment must be a string");
    const segment = scriptSegment.trim();
    while (/\s/.test(text[cursor] ?? "") && cursor < text.length) cursor++;
    const start = cursor;
    if (!text.startsWith(segment, start)) fail("Semantic planner rewrote, duplicated or reordered frozen English copy");
    cursor += segment.length;
    return { start, end: cursor };
  });
  if (text.slice(cursor).trim()) fail("Semantic planner omitted original English copy");
  return spans;
}
