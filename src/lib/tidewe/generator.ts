import type { GeneratedScript, ScriptInput } from "@/lib/script-engine/generator";
import type { Shot } from "@/lib/db/schema";
import { assertSupportedTideweProfile, createTideweOutdoorProfile } from "@/lib/creative-profiles";
import { stripThinkBlocks } from "@/lib/llm-clean";
import { TIDEWE_COMPILER_VERSION, TIDEWE_CORPUS_VERSION, TIDEWE_INTERACTION_FIELDS, type TideweCopyDocument, type TideweInteractionPlan, type TideweVisualPlan } from "./types";
import { assertTideweImportedCopy, assertTideweScriptIntegrity, englishWordCount, mapTideweCopySpans, productFactsHash, TideweValidationError } from "./validation";
import { buildTideweScriptPrompt, buildTideweScriptSystemPrompt, selectTideweExamples, tideweFactsForInput, tideweProfileForInput } from "./prompts";
import { tidewePresenterAnchor, TIDEWE_PRESENTER_PLACEHOLDER } from "./presenter";

/** One completion returns the full copy and its storyboard; no review or repair call follows. */
export type TideweCompletion = <T>(system: string, prompt: string, parse: (text: string) => T) => Promise<T>;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const requireText = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new TideweValidationError(`Missing ${name}`);
  return value.trim();
};
const strings = (value: unknown): string[] => Array.isArray(value) && value.every(v => typeof v === "string") ? value : [];
function json(text: string): Record<string, unknown> {
  const cleaned = stripThinkBlocks(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const value: unknown = JSON.parse(cleaned);
  if (!record(value)) throw new TideweValidationError("Expected a JSON object");
  return value;
}

export async function generateTideweScripts(input: ScriptInput, complete: TideweCompletion): Promise<GeneratedScript[]> {
  const profile = tideweProfileForInput(input) ?? createTideweOutdoorProfile(input);
  assertSupportedTideweProfile(profile);
  if (input.copyText !== undefined) assertTideweImportedCopy(input.copyText);
  const facts = tideweFactsForInput(input);
  const imported = input.copyText?.trim();
  const count = 1;
  const examples = selectTideweExamples(facts, profile.narrativeAngle);
  return complete(buildTideweScriptSystemPrompt(input), buildTideweScriptPrompt(input), text => {
    const parsed = json(text);
    if (!Array.isArray(parsed.copies) || parsed.copies.length !== count) throw new TideweValidationError(`Expected ${count} full-copy candidates`);
    const copies = parsed.copies.map((raw: unknown) => {
      if (!record(raw)) throw new TideweValidationError("Invalid full-copy candidate");
      // An annotation model never owns imported text, even if it unexpectedly returns a text field.
      const canonical = imported ?? requireText(raw.text, "English copy");
      const claimedFactIds = strings(raw.claimedFactIds);
      const wordCount = englishWordCount(canonical);
      const copyDocument: TideweCopyDocument = {
        version: 1, language: "en-US", source: imported !== undefined ? "user_provided" : "ai_generated", text: canonical, translation: requireText(raw.translation, "Chinese translation"),
        angle: requireText(raw.angle, "narrative angle"), hookType: requireText(raw.hookType, "hook type"),
        claimedFactIds, factsSnapshot: facts, factsHash: productFactsHash(facts),
        corpusVersion: TIDEWE_CORPUS_VERSION, compilerVersion: TIDEWE_COMPILER_VERSION,
        exampleIds: imported !== undefined ? [] : examples.map(e => `${e.product}-${e.source.sheet}-${e.source.row}`), wordCount, estimatedDuration: Math.round(wordCount / 2.3 * 10) / 10,
        productName: input.productName,
        visualObservations: input.productAnalysis ?? "",
      };
      return { title: requireText(raw.title, "title"), copyDocument };
    });
    if (!Array.isArray(parsed.scripts) || parsed.scripts.length !== copies.length) throw new TideweValidationError("Planner must return every frozen copy");
    return parsed.scripts.map((raw: unknown, index: number) => {
      if (!record(raw) || raw.copyIndex !== index || !Array.isArray(raw.shots) || !raw.shots.length) throw new TideweValidationError("Invalid semantic plan or candidate order");
      const planned = raw.shots.map((s: unknown) => { if (!record(s)) throw new TideweValidationError("Invalid shot"); return s; });
      const copy = copies[index];
      const spans = mapTideweCopySpans(copy.copyDocument.text, planned.map(s => ({ scriptSegment: typeof s.scriptSegment === "string" ? s.scriptSegment : requireText(s.scriptSegment, "scriptSegment") })));
      const roles = new Set(["hook", "pain_point", "product_reveal", "demo", "social_proof", "cta"]);
      const shots: Shot[] = planned.map((s, i) => {
        if (!roles.has(String(s.narrativeRole)) || typeof s.productVisible !== "boolean" || typeof s.duration !== "number" || !Number.isFinite(s.duration) || s.duration <= 0) throw new TideweValidationError("Invalid shot role, visibility or duration");
        if (s.speechDelivery !== undefined && s.speechDelivery !== "on_camera" && s.speechDelivery !== "off_camera") throw new TideweValidationError("Invalid shot speechDelivery; expected on_camera or off_camera");
        const visualPlan = parseVisualPlan(s.visualPlan);
        // Component-only and person-free pictures keep the creator's narration,
        // but cannot show a speaking mouth. Resolve this before visibility checks
        // so a model's delivery label cannot force a face into the approved frame.
        const speechDelivery = profile.speechMode === "on_camera"
          ? visualPlan.framing === "detail" || s.personVisible === false ? "off_camera" : s.speechDelivery ?? "on_camera"
          : undefined;
        const nativeNarration = profile.speechMode === "on_camera" && Boolean(String(s.scriptSegment).trim());
        const spoken = nativeNarration && speechDelivery === "on_camera";
        if (profile.presenter && typeof s.personVisible !== "boolean") throw new TideweValidationError("Selected presenter requires explicit personVisible for every shot");
        if (spoken && s.personVisible === false) throw new TideweValidationError("On-camera speech requires the selected presenter to be visible");
        const personVisible = spoken || s.personVisible !== false;
        if (profile.presenter && personVisible && !String(s.description).includes(TIDEWE_PRESENTER_PLACEHOLDER)) throw new TideweValidationError("Person-visible description must use {{PRESENTER}} instead of inventing a person");
        const visualText = (value: unknown, name: string): string => {
          const raw = requireText(value, name);
          return profile.presenter ? raw.replaceAll(TIDEWE_PRESENTER_PLACEHOLDER, tidewePresenterAnchor(profile.presenter)) : raw;
        };
        // The full frozen identity is already in description/presenter. Keep action
        // metadata concise even when the saved appearance is thousands of characters.
        if (profile.presenter) {
          visualPlan.actionStart = visualPlan.actionStart.replaceAll(TIDEWE_PRESENTER_PLACEHOLDER, "所选主播");
          visualPlan.action = visualPlan.action.replaceAll(TIDEWE_PRESENTER_PLACEHOLDER, "所选主播");
          visualPlan.actionEnd = visualPlan.actionEnd.replaceAll(TIDEWE_PRESENTER_PLACEHOLDER, "所选主播");
          if (visualPlan.productFocus) visualPlan.productFocus = visualPlan.productFocus.replaceAll(TIDEWE_PRESENTER_PLACEHOLDER, "所选主播");
          if (visualPlan.interaction) {
            for (const field of TIDEWE_INTERACTION_FIELDS) {
              visualPlan.interaction[field] = visualPlan.interaction[field].replaceAll(TIDEWE_PRESENTER_PLACEHOLDER, "所选主播");
            }
          }
        }
        return { shotId: i + 1, type: s.narrativeRole as Shot["type"], duration: s.duration,
          description: visualText(s.description, "Chinese scene description"), camera: visualText(s.camera, "Chinese camera direction"),
          visualIntent: visualText(s.visualIntent, "Chinese visual intent"), prompt: visualText(s.prompt, "Chinese visual prompt"),
          visualSource: nativeNarration ? "ai_generate" : s.visualSource === "product_image" ? "product_image" : "ai_generate",
          transition: s.transition === "ffmpeg_fade" ? "ffmpeg_fade" : "direct_concat",
          voiceover: copy.copyDocument.text.slice(spans[i].start, spans[i].end).trim(),
          tidewe: { copySpan: spans[i], translation: typeof s.translation === "string" ? s.translation.trim() : "", shotGoal: visualText(s.shotGoal, "shot goal"), productVisible: s.productVisible, personVisible, visualPlan, ...(speechDelivery && { speechDelivery }), ...(profile.presenter && { presenter: structuredClone(profile.presenter) }), factRefs: strings(s.factRefs), sceneId: requireText(s.sceneId, "scene ID") },
        };
      });
      const script: GeneratedScript = { ...copy, styleType: "tidewe_outdoor", totalDuration: Math.round(shots.reduce((sum, s) => sum + s.duration, 0)), shots };
      assertTideweScriptIntegrity(script, profile.presenter ?? null);
      return script;
    });
  });
}

/** Read production metadata without judging wording, language, pacing or visual variety. */
function parseVisualPlan(value: unknown): TideweVisualPlan {
  if (!record(value) || !["wide", "medium", "close_up", "detail"].includes(String(value.framing))
    || !["presenter", "demonstration", "detail", "context"].includes(String(value.visualRole))) {
    throw new TideweValidationError("Invalid shot visualPlan framing or visualRole");
  }
  let interaction: TideweInteractionPlan | undefined;
  if (value.interaction !== undefined) {
    if (!record(value.interaction)) throw new TideweValidationError("Invalid shot visualPlan interaction");
    const raw = value.interaction;
    interaction = Object.fromEntries(TIDEWE_INTERACTION_FIELDS.map(field => [field, requireText(raw[field], `interaction ${field}`)])) as unknown as TideweInteractionPlan;
  }
  return {
    framing: value.framing as TideweVisualPlan["framing"],
    visualRole: value.visualRole as TideweVisualPlan["visualRole"],
    actionStart: requireText(value.actionStart, "action start"),
    action: requireText(value.action, "action"),
    actionEnd: requireText(value.actionEnd, "action end"),
    ...(typeof value.productFocus === "string" && { productFocus: value.productFocus.trim() }),
    ...(interaction && { interaction }),
  };
}
