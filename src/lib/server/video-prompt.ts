import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { assets, projects, scripts } from "@/lib/db/schema";
import { filterAssetsForScript } from "@/lib/asset-context";
import { resolveCurrentScript } from "@/lib/current-script";
import { checkCreativeProfileContext, isPremiumProductCgProfile, isTideweOutdoorProfile, isTideweNativeSpeech } from "@/lib/creative-profiles";
import { getVideoModelCapabilities } from "@/lib/model-capabilities";
import { assertTideweScript } from "@/lib/tidewe/validation";
import { tidewePresenterReference } from "@/lib/tidewe/presenter";
import { lintCreativeProfileShot } from "@/lib/creative-policy-lint";
import { compilePremiumCgVideoPrompt } from "@/lib/premium-cg-prompt";
import { buildShotVideoPrompt, normalizeVideoPromptSettings } from "@/lib/shot-video-prompt";
import { buildVideoControlPlan } from "@/lib/video-control-plan";
import { applyRetakePatch, RETAKE_SYMPTOMS } from "@/lib/retake-patch";
import { withVideoAudioMode } from "@/lib/video-audio";
import { joinVideoPromptParts, validateVideoPrompt, VIDEO_PROMPT_MAX_LENGTH } from "@/lib/video-prompt";
import { checkPromptConsistency, sanitizeVisualBible } from "@/lib/production-system";
import type { VideoPromptContext, VideoPromptPreview, VideoPromptRequest } from "@/lib/video-prompt-request";

export class VideoPromptError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = "VideoPromptError";
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VideoPromptError("VIDEO_PROMPT_INPUT_INVALID", "视频提示词参数必须是对象。");
  return value as Record<string, unknown>;
}

export function normalizeVideoPromptRequest(raw: unknown): VideoPromptRequest {
  const value = record(raw);
  if (typeof value.scriptId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.scriptId)
    || !Number.isSafeInteger(value.shotId) || Number(value.shotId) < 0
    || typeof value.provider !== "string" || !value.provider.trim() || value.provider.length > 128
    || typeof value.model !== "string" || !value.model.trim() || value.model.length > 1024) {
    throw new VideoPromptError("VIDEO_PROMPT_INPUT_INVALID", "脚本、镜头、平台或模型参数无效。");
  }
  for (const key of ["chainToNext", "batch", "generateAudio"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") throw new VideoPromptError("VIDEO_PROMPT_INPUT_INVALID", "视频提示词开关参数无效。");
  }
  if (value.locale !== undefined && value.locale !== "zh" && value.locale !== "en") throw new VideoPromptError("VIDEO_PROMPT_INPUT_INVALID", "视频提示词语言无效。");
  if (value.retake !== undefined && !RETAKE_SYMPTOMS.some((item) => item.id === value.retake)) throw new VideoPromptError("VIDEO_PROMPT_INPUT_INVALID", "重拍诊断参数无效。");
  if (value.negativePrompt !== undefined && (typeof value.negativePrompt !== "string" || value.negativePrompt.length > VIDEO_PROMPT_MAX_LENGTH || value.negativePrompt.includes("\0"))) {
    throw new VideoPromptError("VIDEO_PROMPT_INPUT_INVALID", "负面提示词必须是有效的文本且不超过 12000 字符。");
  }
  let settings;
  try { settings = normalizeVideoPromptSettings(value.settings); }
  catch (error) { throw new VideoPromptError("VIDEO_PROMPT_INPUT_INVALID", error instanceof Error ? error.message : "视频提示词设置无效。"); }
  let controlInputs: VideoPromptRequest["controlInputs"];
  if (value.controlInputs !== undefined) {
    const input = record(value.controlInputs);
    controlInputs = {};
    for (const key of ["firstFrameUrl", "lastFrameUrl", "characterReferenceUrl", "productReferenceUrl", "continuityReferenceUrl", "motionReferenceUrl", "audioReferenceUrl"] as const) {
      if (input[key] !== undefined && (typeof input[key] !== "string" || input[key].length > 28 * 1024 * 1024)) throw new VideoPromptError("VIDEO_PROMPT_INPUT_INVALID", "视频参考素材地址无效。");
      if (typeof input[key] === "string") controlInputs[key] = input[key];
    }
    if (input.supportsAudio !== undefined && typeof input.supportsAudio !== "boolean") throw new VideoPromptError("VIDEO_PROMPT_INPUT_INVALID", "模型声音能力参数无效。");
    if (typeof input.supportsAudio === "boolean") controlInputs.supportsAudio = input.supportsAudio;
    // The browser's Kling motion workflow submits only the selected start/end frames.
    // Ignore legacy reference fields rather than turning them into hidden inputs.
    if (value.provider === "kling-cli") {
      controlInputs = {
        ...(controlInputs.firstFrameUrl !== undefined && { firstFrameUrl: controlInputs.firstFrameUrl }),
        ...(controlInputs.lastFrameUrl !== undefined && { lastFrameUrl: controlInputs.lastFrameUrl }),
        ...(controlInputs.supportsAudio !== undefined && { supportsAudio: controlInputs.supportsAudio }),
      };
    }
  }
  return {
    scriptId: value.scriptId,
    shotId: Number(value.shotId),
    provider: value.provider,
    model: value.model,
    settings,
    ...(value.negativePrompt !== undefined ? { negativePrompt: value.negativePrompt as string } : {}),
    ...(value.locale !== undefined ? { locale: value.locale as "zh" | "en" } : {}),
    ...(value.chainToNext !== undefined ? { chainToNext: value.chainToNext as boolean } : {}),
    ...(value.batch !== undefined ? { batch: value.batch as boolean } : {}),
    ...(value.generateAudio !== undefined ? { generateAudio: value.generateAudio as boolean } : {}),
    ...(value.retake !== undefined ? { retake: value.retake as VideoPromptRequest["retake"] } : {}),
    ...(controlInputs ? { controlInputs } : {}),
  };
}

/** Compile from persisted project/script state. Preview and paid submission use this exact path. */
export function previewProjectVideoPrompt(projectId: string, raw: unknown): VideoPromptPreview {
  const request = normalizeVideoPromptRequest(raw);
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new VideoPromptError("PROJECT_NOT_FOUND", "项目不存在。", 404);
  const script = resolveCurrentScript(db.select().from(scripts).where(and(eq(scripts.projectId, projectId), eq(scripts.selected, true))).all());
  if (!script || script.id !== request.scriptId) throw new VideoPromptError("SCRIPT_CONTEXT_CHANGED", "当前脚本已改变，请刷新后重新预览。", 409);
  const creativeContext = checkCreativeProfileContext(project, script);
  if (!creativeContext.ok) throw new VideoPromptError(creativeContext.code, creativeContext.code === "CREATIVE_CONFIG_STALE"
    ? "脚本基于旧的创作设置，请重新生成脚本。"
    : "当前脚本与项目创作类型不匹配，请刷新后重新生成脚本。", 409);
  const shot = script.shots?.find((item) => item.shotId === request.shotId);
  if (!shot) throw new VideoPromptError("SHOT_NOT_FOUND", "镜头不存在。", 404);
  const profile = creativeContext.projectProfile;
  const premiumCg = isPremiumProductCgProfile(profile);
  const tidewe = isTideweOutdoorProfile(profile);
  const tideweNative = isTideweNativeSpeech(profile);
  const klingFrames = request.provider === "kling-cli";
  // Kling always attempts the requested audio; catalog metadata does not downgrade it.
  const tideweGenerateAudio = tideweNative && request.generateAudio !== false && (request.provider === "kling-cli"
    ? true
    : getVideoModelCapabilities(request.model, undefined, request.provider).nativeAudio === true);
  const frozenPresenter = tidewe && (shot.tidewe?.personVisible !== false || (tideweNative && shot.voiceover?.trim())) ? tidewePresenterReference(profile) : undefined;
  if (tidewe) {
    try { assertTideweScript(script, profile.presenter ?? null); }
    catch (error) { throw new VideoPromptError("TIDEWE_SCRIPT_INVALID", error instanceof Error ? error.message : "TIDEWE 原文覆盖无效。", 409); }
    if (request.controlInputs?.characterReferenceUrl && request.controlInputs.characterReferenceUrl !== frozenPresenter) throw new VideoPromptError("TIDEWE_PRESENTER_REFERENCE_INVALID", "TIDEWE 主播已随脚本冻结，请使用当前主播参考，或回到脚本设置更换并重新规划。");
    if (!tideweNative && request.generateAudio === true) throw new VideoPromptError("TIDEWE_VISUAL_AUDIO_FORBIDDEN", "此 TIDEWE 项目使用画外旁白，分镜保持静音并在合成时添加英语配音。");
  }
  // Prompt templates use Chinese regardless of the UI language. Product facts remain verbatim.
  const locale = "zh" as const;
  const silent = tidewe ? !tideweGenerateAudio : request.batch || request.generateAudio === false || (premiumCg && profile.narrationMode === "none");
  const controlPlan = buildVideoControlPlan({
    ...request.controlInputs,
    ...(tidewe && !klingFrames ? { characterReferenceUrl: frozenPresenter, motionReferenceUrl: undefined, audioReferenceUrl: undefined } : {}),
    provider: request.provider,
    modelId: request.model,
    supportsAudio: tideweNative ? tideweGenerateAudio : silent ? false : request.controlInputs?.supportsAudio,
    generateAudio: !silent,
    voiceover: silent && !tideweNative ? "" : shot.narration?.trim() || shot.voiceover?.trim(),
    speakerVisible: tideweNative || (!silent && !premiumCg && Boolean(shot.characterId)),
    description: shot.description,
    locale,
  });
  if (frozenPresenter && !controlPlan.referenceInputs.some((reference) => reference.role === "character")) {
    const imageAssets = filterAssetsForScript(db.select().from(assets).where(and(eq(assets.projectId, projectId), eq(assets.selected, true), eq(assets.status, "done"))).all(), script);
    const frame = request.controlInputs?.firstFrameUrl;
    const identityFrame = frame && imageAssets.some((asset) => asset.shotId === shot.shotId && asset.type !== "stock_footage" && [asset.filePath, asset.sourceKeyframeUrl, asset.thumbnailPath].includes(frame));
    if (!identityFrame) throw new VideoPromptError("TIDEWE_PRESENTER_KEYFRAME_REQUIRED", "须先生成包含已选主播的当前分镜关键帧，再将它选为首帧，不能仅用商品图替代人物身份。");
  }
  let compiled: { prompt: string; negativePrompt: string };
  if (premiumCg) {
    if (lintCreativeProfileShot(profile, shot).length) throw new VideoPromptError("CREATIVE_POLICY_VIOLATION", "高端产品 CG 镜头不符合画面文字或旁白策略。");
    // Approved native narration must be visible in the server-owned review.
    compiled = compilePremiumCgVideoPrompt(shot, profile);
    if (!silent && controlPlan.audioMode === "native") {
      const approvedNarration = shot.narration?.trim() || shot.voiceover?.trim();
      if (!approvedNarration) throw new VideoPromptError("PREMIUM_CG_NARRATION_REQUIRED", "当前脚本没有可用的克制旁白。");
      if (controlPlan.audioPrompt) compiled.prompt += `\n${controlPlan.audioPrompt}`;
    }
  } else {
    compiled = buildShotVideoPrompt({
      shot: request.batch && !tideweNative ? { ...shot, voiceover: "", narration: "" } : shot,
      ordinal: script.shots?.findIndex((item) => item.shotId === request.shotId) ?? 0,
      settings: request.settings,
      chainToNext: request.chainToNext,
      category: project.productCategory,
      creativeIntent: project.creativeIntent,
      visualBible: project.visualBible,
      creativeProfile: profile,
      audioMode: tideweGenerateAudio ? "native" : "post",
      locale,
    });
    if (!tidewe) {
      compiled.negativePrompt = [request.negativePrompt, compiled.negativePrompt].filter(Boolean).join(", ");
      if (request.retake) compiled.prompt = applyRetakePatch(compiled.prompt, request.retake).prompt;
    }
    // Reference-role labels describe submitted files; they do not import the sales
    // creative direction. Keep these labels for a reviewed TIDEWE reference pack.
    // TIDEWE's compiler already binds the exact English line once. Keep reference
    // labels, without appending a second spoken-copy instruction from the generic plan.
    const controlSuffix = tideweNative && controlPlan.audioPrompt ? controlPlan.promptSuffix.replace(controlPlan.audioPrompt, "").trim().replace(/。$/, "") : controlPlan.promptSuffix;
    if (controlSuffix) compiled.prompt = joinVideoPromptParts([compiled.prompt, controlSuffix], locale, "\n");
    compiled.prompt = withVideoAudioMode(compiled.prompt, tidewe ? tideweGenerateAudio ? "native" : "silent"
      : silent ? "silent" : controlPlan.audioMode === "native" ? "native" : "ambient", locale);
    if (!tidewe) {
      const conflict = checkPromptConsistency(compiled.prompt, sanitizeVisualBible(project.visualBible)).find((issue) => issue.severity === "fail");
      if (conflict) throw new VideoPromptError("VIDEO_PROMPT_CONSISTENCY_FAILED", `提示词违反项目一致性要求：${conflict.anchor}`);
    }
  }
  const issues = validateVideoPrompt(compiled.prompt);
  if (issues.length) throw new VideoPromptError("VIDEO_PROMPT_INVALID", issues.map((issue) => issue.message).join(" "));
  const referenceUrls = new Set(Object.values(request.controlInputs ?? {}).filter((value): value is string => typeof value === "string" && Boolean(value)));
  const selectedAssets = filterAssetsForScript(db.select().from(assets).where(and(eq(assets.projectId, projectId), eq(assets.selected, true), eq(assets.status, "done"))).all(), script)
    // Unrelated shots may complete while a reviewed batch is queued. Only this shot and
    // assets actually used by its reference/continuity chain can invalidate the review.
    .filter((asset) => asset.shotId === request.shotId || [asset.filePath, asset.thumbnailPath, asset.sourceKeyframeUrl].some((url) => url && (referenceUrls.has(url) || [...referenceUrls].some((ref) => ref.startsWith(url + ".")))))
    .map((asset) => ({ id: asset.id, shotId: asset.shotId, filePath: asset.filePath, thumbnailPath: asset.thumbnailPath, sourceKeyframeUrl: asset.sourceKeyframeUrl }))
    .sort((left, right) => left.shotId - right.shotId || left.id.localeCompare(right.id));
  const contextKey = createHash("sha256").update(JSON.stringify({
    request,
    projectId,
    productCategory: project.productCategory,
    productImages: project.productImages,
    creativeIntent: project.creativeIntent,
    visualBible: project.visualBible,
    profile,
    scriptId: script.id,
    shotId: shot.shotId,
    prompt: compiled.prompt,
    negativePrompt: compiled.negativePrompt,
    selectedAssets,
  })).digest("hex");
  return { ...compiled, scriptId: script.id, shotId: shot.shotId, contextKey, settings: request.settings, controlPlan };
}

/** Reject stale reviews before any paid provider call instead of replacing their text invisibly. */
export function assertReviewedVideoPrompt(projectId: string, raw: unknown, prompt: string, expected?: { scriptId?: string; shotId?: number; provider?: string; model?: string }): VideoPromptPreview {
  const context = record(raw) as unknown as VideoPromptContext;
  const preview = previewProjectVideoPrompt(projectId, context);
  if (typeof context.contextKey !== "string" || context.contextKey !== preview.contextKey || prompt !== preview.prompt
    || (expected?.scriptId !== undefined && expected.scriptId !== preview.scriptId)
    || (expected?.shotId !== undefined && expected.shotId !== preview.shotId)
    || (expected?.provider !== undefined && expected.provider !== context.provider)
    || (expected?.model !== undefined && expected.model !== context.model)) {
    throw new VideoPromptError("VIDEO_PROMPT_CONTEXT_CHANGED", "提示词或生成设置已改变，请重新预览并确认后再生成。", 409);
  }
  return preview;
}
