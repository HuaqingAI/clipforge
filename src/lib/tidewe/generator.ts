import type { GeneratedScript, ScriptInput } from "@/lib/script-engine/generator";
import type { Shot } from "@/lib/db/schema";
import { assertSupportedTideweProfile, createTideweOutdoorProfile } from "@/lib/creative-profiles";
import { stripThinkBlocks } from "@/lib/llm-clean";
import { TIDEWE_COMPILER_VERSION, TIDEWE_CORPUS_VERSION, type TideweCopyDocument } from "./types";
import { assertTideweCopyClaims, assertTideweImportedCopy, assertTideweImportedCopyClaims, assertTideweScript, canonicalizeTideweCopy, englishWordCount, mapTideweCopySpans, productFactsHash, TideweValidationError } from "./validation";
import { buildTideweCopyPrompt, buildTideweImportedCopyPrompt, selectTideweExamples, tideweFactsForInput, tideweProfileForInput, TIDEWE_COPY_SYSTEM_PROMPT, TIDEWE_IMPORTED_COPY_SYSTEM_PROMPT, TIDEWE_PLAN_SYSTEM_PROMPT } from "./prompts";
import { tidewePresenterAnchor, tidewePresenterForPrompt, TIDEWE_PRESENTER_PLACEHOLDER } from "./presenter";

/** Completion owns its single JSON repair; the two stages share no mutable copy. */
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
  const count = imported !== undefined ? 1 : Math.max(1, Math.min(3, Math.floor(input.count ?? 3)));
  const examples = selectTideweExamples(facts, profile.narrativeAngle);
  const copies = await complete(imported !== undefined ? TIDEWE_IMPORTED_COPY_SYSTEM_PROMPT : TIDEWE_COPY_SYSTEM_PROMPT,
    imported !== undefined ? buildTideweImportedCopyPrompt({ ...input, copyText: imported }) : buildTideweCopyPrompt(input, count), text => {
    const parsed = json(text);
    if (!Array.isArray(parsed.copies) || parsed.copies.length !== count) throw new TideweValidationError(`Expected ${count} full-copy candidates`);
    return parsed.copies.map((raw: unknown) => {
      if (!record(raw)) throw new TideweValidationError("Invalid full-copy candidate");
      // An annotation model never owns imported text, even if it unexpectedly returns a text field.
      const canonical = imported ?? canonicalizeTideweCopy(requireText(raw.text, "English copy"));
      const claimedFactIds = strings(raw.claimedFactIds);
      if (imported !== undefined) assertTideweImportedCopyClaims(canonical, facts, claimedFactIds);
      else assertTideweCopyClaims(canonical, facts, claimedFactIds);
      const wordCount = englishWordCount(canonical);
      const copyDocument: TideweCopyDocument = {
        version: 1, language: "en-US", source: imported !== undefined ? "user_provided" : "ai_generated", text: canonical, translation: requireText(raw.translation, "Chinese translation"),
        angle: requireText(raw.angle, "narrative angle"), hookType: requireText(raw.hookType, "hook type"),
        claimedFactIds, factsSnapshot: facts, factsHash: productFactsHash(facts),
        corpusVersion: TIDEWE_CORPUS_VERSION, compilerVersion: TIDEWE_COMPILER_VERSION,
        exampleIds: imported !== undefined ? [] : examples.map(e => `${e.product}-${e.source.sheet}-${e.source.row}`), wordCount, estimatedDuration: Math.round(wordCount / 2.3 * 10) / 10,
      };
      return { title: requireText(raw.title, "title"), copyDocument };
    });
  });
  return complete(TIDEWE_PLAN_SYSTEM_PROMPT, JSON.stringify({
    task: "Allocate each frozen copy to semantic shots. Return all candidates in their original order.",
    targetDuration: profile.targetDuration, videoMode: profile.videoMode, speechMode: profile.speechMode, facts,
    selectedPresenter: tidewePresenterForPrompt(profile.presenter),
    copies: copies.map((c, copyIndex) => ({ copyIndex, source: c.copyDocument.source, text: c.copyDocument.text, translation: c.copyDocument.translation })),
    outputFormat: { scripts: [{ copyIndex: 0, shots: [{ scriptSegment: "verbatim substring", translation: "该段中文译文", narrativeRole: "hook", duration: 5, description: profile.presenter ? "{{PRESENTER}} 在林边面向镜头自然口播并展示装备" : "中文场景及动作", camera: "中文运镜", shotGoal: "中文画面目标", visualIntent: "中文画面意图", prompt: "中文画面提示", personVisible: true, productVisible: true, factRefs: [], sceneId: "woods-1", visualSource: "ai_generate", transition: "direct_concat" }] }] },
  }), text => {
    const parsed = json(text);
    if (!Array.isArray(parsed.scripts) || parsed.scripts.length !== copies.length) throw new TideweValidationError("Planner must return every frozen copy");
    return parsed.scripts.map((raw: unknown, index: number) => {
      if (!record(raw) || raw.copyIndex !== index || !Array.isArray(raw.shots) || !raw.shots.length || raw.shots.length > 30) throw new TideweValidationError("Invalid semantic plan or candidate order");
      const planned = raw.shots.map((s: unknown) => { if (!record(s)) throw new TideweValidationError("Invalid shot"); return s; });
      const copy = copies[index];
      const spans = mapTideweCopySpans(copy.copyDocument.text, planned.map(s => ({ scriptSegment: typeof s.scriptSegment === "string" ? s.scriptSegment : requireText(s.scriptSegment, "scriptSegment") })));
      const roles = new Set(["hook", "pain_point", "product_reveal", "demo", "social_proof", "cta"]);
      const shots: Shot[] = planned.map((s, i) => {
        if (!roles.has(String(s.narrativeRole)) || typeof s.productVisible !== "boolean" || typeof s.duration !== "number" || s.duration < 1 || s.duration > 15) throw new TideweValidationError("Invalid shot role, visibility or duration");
        if (englishWordCount(String(s.scriptSegment)) / 3 > s.duration) throw new TideweValidationError("Shot is too short for its spoken copy; split semantically or increase its duration");
        const spoken = profile.speechMode === "on_camera" && Boolean(String(s.scriptSegment).trim());
        if (profile.presenter && typeof s.personVisible !== "boolean") throw new TideweValidationError("Selected presenter requires explicit personVisible for every shot");
        if (spoken && s.personVisible === false) throw new TideweValidationError("On-camera speech requires the selected presenter to be visible");
        const personVisible = spoken || s.personVisible !== false;
        if (profile.presenter && personVisible && !String(s.description).includes(TIDEWE_PRESENTER_PLACEHOLDER)) throw new TideweValidationError("Person-visible description must use {{PRESENTER}} instead of inventing a person");
        const visualText = (value: unknown, name: string): string => {
          const raw = requireText(value, name);
          return profile.presenter ? raw.replaceAll(TIDEWE_PRESENTER_PLACEHOLDER, tidewePresenterAnchor(profile.presenter)) : raw;
        };
        return { shotId: i + 1, type: s.narrativeRole as Shot["type"], duration: s.duration,
          description: visualText(s.description, "Chinese scene description"), camera: visualText(s.camera, "Chinese camera direction"),
          visualIntent: visualText(s.visualIntent, "Chinese visual intent"), prompt: visualText(s.prompt, "Chinese visual prompt"),
          visualSource: profile.speechMode === "on_camera" && String(s.scriptSegment).trim() ? "ai_generate" : s.visualSource === "product_image" ? "product_image" : "ai_generate",
          transition: s.transition === "ffmpeg_fade" ? "ffmpeg_fade" : "direct_concat",
          voiceover: copy.copyDocument.text.slice(spans[i].start, spans[i].end).trim(),
          tidewe: { copySpan: spans[i], translation: typeof s.translation === "string" ? s.translation.trim() : "", shotGoal: visualText(s.shotGoal, "shot goal"), productVisible: s.productVisible, personVisible, ...(profile.presenter && { presenter: structuredClone(profile.presenter) }), factRefs: strings(s.factRefs), sceneId: requireText(s.sceneId, "scene ID") },
        };
      });
      const script: GeneratedScript = { ...copy, styleType: "tidewe_outdoor", totalDuration: Math.round(shots.reduce((sum, s) => sum + s.duration, 0)), shots };
      assertTideweScript(script, profile.presenter ?? null);
      return script;
    });
  });
}
