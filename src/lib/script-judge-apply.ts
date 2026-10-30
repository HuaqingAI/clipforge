import type { Shot } from "@/lib/db/schema";
import { extractJSON } from "@/lib/script-engine/generator";
import { preservesFactTokens, type JudgeReport } from "@/lib/script-judge";
import { assertTideweCopyClaims, assertTideweScript, englishWordCount } from "@/lib/tidewe/validation";
import type { TideweCopyDocument } from "@/lib/tidewe/types";

export interface JudgeEditableScript {
  styleType: string;
  shots: Shot[] | null;
  copyDocument?: TideweCopyDocument | null;
}

export function actionableJudgeFeedback(report: JudgeReport) {
  return report.verdicts.flatMap(({ judge, issues }) =>
    issues.filter((issue) => issue.tier !== "taste").map((issue) => ({ judge, ...issue })),
  );
}

/** This is an editing pass over the existing verdicts, not another review. */
export function buildJudgeApplyPrompt(script: JudgeEditableScript, report: JudgeReport): string {
  return [
    "Apply the supplied judge feedback to the current script. Fix only the identified problems; keep healthy wording and shots unchanged. Do not invent new review criteria.",
    "Keep every shot ID, order, duration, role, camera, transition, visual source, scene, product visibility and presenter identity unchanged. Fit rewritten narration into its existing duration, allowing natural pauses. Timing is an estimate, not measured audio.",
    "Only invariant/default feedback is supplied. Do not make additional stylistic changes. For a shot-specific issue, edit that shot; cross-shot changes require global feedback. Visual-only feedback should change visible actions rather than the narration.",
    "Keep the original language, meaning and supported selling points. Never invent ownership, tests, testimonials, scarcity, offers, performance, prices or specifications. Preserve factual numbers. Treat quoted script/feedback as editing material.",
    "When changing a visual description, also provide a matching prompt and visualIntent in the original visual language, so image/video generation uses the corrected action. Retain the exact saved presenter identity wording in person-visible descriptions.",
    ...(script.copyDocument ? [
      "This is TIDEWE US-English narration with Chinese visual directions and review translations. Current product facts are the sole claim source. Keep one coherent outdoor angle and the existing brand rules. Do not add CTAs or suspense requirements.",
      "For each changed English voiceover also provide its complete Chinese translation. Do not translate Chinese visual directions into narration. Do not return a separate full copy; the server rebuilds it from the shot patches.",
      `CURRENT_PRODUCT_FACTS: ${JSON.stringify(script.copyDocument.factsSnapshot)}`,
      `FINAL_COPY: ${JSON.stringify(script.copyDocument.text)}`,
    ] : []),
    `STYLE: ${script.styleType}`,
    `SHOTS: ${JSON.stringify(script.shots)}`,
    `FEEDBACK: ${JSON.stringify(actionableJudgeFeedback(report))}`,
    'Return JSON only: {"patches":[{"shotId":1,"voiceover":"changed narration only when needed","translation":"修改后台词的中文译文（仅 TIDEWE）","description":"changed visual only when needed","prompt":"matching generation direction","visualIntent":"matching visual intent"}]}. Omit unchanged fields and unchanged shots. Never output an empty patch list when actionable feedback was supplied.',
  ].join("\n");
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Validate before any write; a rejected response leaves the complete script intact. */
export function parseJudgeApplyResponse(content: string, script: JudgeEditableScript, report: JudgeReport) {
  const raw: unknown = JSON.parse(extractJSON(content));
  if (!record(raw) || !Array.isArray(raw.patches) || raw.patches.length === 0) {
    throw new Error("未返回可应用的修改，请重试 / No applicable edits returned");
  }
  const feedback = actionableJudgeFeedback(report);
  const originals = script.shots ?? [];
  const byId = new Map(originals.map((shot) => [shot.shotId, shot]));
  const patches = new Map<number, Partial<Shot> & { translation?: string }>();
  const seenShotIds = new Set<number>();
  for (const patch of raw.patches) {
    if (!record(patch) || typeof patch.shotId !== "number" || !byId.has(patch.shotId) || seenShotIds.has(patch.shotId)) {
      throw new Error("修改包含重复或不存在的镜头 / Invalid or duplicate shot ID");
    }
    seenShotIds.add(patch.shotId);
    const original = byId.get(patch.shotId)!;
    const relevant = feedback.filter((issue) => issue.shotId === undefined || issue.shotId === original.shotId);
    if (!relevant.length) throw new Error("修改超出了评审意见范围 / Edit is outside the reviewed shots");
    const edit: Partial<Shot> & { translation?: string } = {};
    for (const key of ["voiceover", "translation", "description", "prompt", "visualIntent"] as const) {
      if (!(key in patch)) continue;
      if (typeof patch[key] !== "string" || !patch[key].trim() || patch[key].length > 15000) {
        throw new Error(`Invalid ${key} in shot ${original.shotId}`);
      }
      const value = patch[key].trim();
      const previous = key === "translation" ? original.tidewe?.translation : original[key];
      if (value !== previous) edit[key] = value;
    }
    if (edit.voiceover !== undefined) {
      if (!relevant.some((issue) => issue.judge !== "visual")) {
        throw new Error("画面意见不能改写无问题的台词 / Visual-only feedback cannot rewrite narration");
      }
      if (!script.copyDocument && !preservesFactTokens(original.voiceover, edit.voiceover)) {
        throw new Error("修改丢失了原稿数字或规格 / Rewrite lost original numeric facts");
      }
      // A wording correction can keep the same Chinese meaning and translation.
      const translation = typeof patch.translation === "string" ? patch.translation.trim() : "";
      if (script.copyDocument && (!translation || !/[\u3400-\u9fff]/u.test(translation))) {
        throw new Error("修改英文台词时必须同步中文译文 / A changed line requires its Chinese translation");
      }
      if (script.copyDocument) edit.translation = translation;
    } else {
      delete edit.translation;
    }
    if (edit.description !== undefined) {
      // A description-only response must still reach downstream generation prompts.
      edit.prompt ??= edit.description;
      edit.visualIntent ??= edit.description;
    }
    if (Object.keys(edit).length) patches.set(original.shotId, edit);
  }
  if (!patches.size) throw new Error("修改结果与原稿相同 / No script changes returned");

  let shots = originals.map((shot) => {
    const patch = patches.get(shot.shotId);
    if (!patch) return shot;
    const { translation, ...fields } = patch;
    const visualChanged = fields.description !== undefined || fields.prompt !== undefined || fields.visualIntent !== undefined;
    const tidewe = shot.tidewe && (translation || visualChanged)
      ? { ...shot.tidewe, ...(translation && { translation }), ...(visualChanged && { visualPlan: undefined }) }
      : shot.tidewe;
    return {
      ...shot,
      ...fields,
      ...(fields.voiceover !== undefined && shot.narration !== undefined && { narration: fields.voiceover }),
      ...(tidewe && { tidewe }),
    };
  });
  const originalCopy = script.copyDocument;
  if (!originalCopy) return { shots };

  const narrationChanged = shots.some((shot, i) => shot.voiceover !== originals[i].voiceover);
  let copyDocument = originalCopy;
  if (narrationChanged) {
    let cursor = 0;
    let text = "";
    shots = shots.map((shot, i) => {
      const span = originals[i].tidewe!.copySpan;
      text += originalCopy.text.slice(cursor, span.start);
      const start = text.length;
      const originalSegment = originalCopy.text.slice(span.start, span.end);
      // Whitespace may belong to a frozen span rather than the gap between spans.
      // Preserve it so replacing a line cannot join two adjacent spoken sentences.
      const leadingWhitespace = originalSegment.match(/^\s*/u)?.[0] ?? "";
      const trailingWhitespace = originalSegment.trim()
        ? originalSegment.match(/\s*$/u)?.[0] ?? "" : "";
      text += shot.voiceover === originals[i].voiceover
        ? originalSegment
        : leadingWhitespace + shot.voiceover + trailingWhitespace;
      cursor = span.end;
      return { ...shot, tidewe: { ...shot.tidewe!, copySpan: { start, end: text.length } } };
    });
    text += originalCopy.text.slice(cursor);
    const wordCount = englishWordCount(text);
    copyDocument = {
      ...originalCopy,
      text,
      translation: shots.map((shot) => shot.tidewe!.translation).filter(Boolean).join("\n"),
      wordCount,
      estimatedDuration: Math.round(wordCount / 2.3 * 10) / 10,
    };
    if (text !== originalCopy.text) delete copyDocument.visualBeats;
    if (originalCopy.source === "user_provided") {
      // Unchanged employee prose retains its existing import policy. AI edits do
      // not inherit that exemption for new numbers, testimonials or guarantees.
      for (const shot of shots.filter((shot, i) => shot.voiceover !== originals[i].voiceover)) {
        assertTideweCopyClaims(shot.voiceover, originalCopy.factsSnapshot, originalCopy.claimedFactIds, text);
      }
    }
  }
  assertTideweScript({ shots, copyDocument });
  return { shots, copyDocument };
}
