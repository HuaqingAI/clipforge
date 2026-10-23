import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir, stat, rename, unlink } from "fs/promises";
import { createHash, randomUUID } from "crypto";
import { join } from "path";
import { getDataDir } from "@/lib/paths";
import { getDb } from "@/lib/db";
import { projects, scripts, assets, compositions, aiTasks } from "@/lib/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { createProvider } from "@/lib/providers";
import { ProviderError } from "@/lib/providers/base";
import { GRID_MAX_SHOTS } from "@/lib/storyboard-grid";
import {
  buildStoryboardFilmPrompt,
  dialogueDensityWarnings,
  filmTotalSeconds,
  filmDurationFit,
  referenceQuotaCheck,
  resolveFilmModel,
  FilmModelSelectionError,
  estimateFilmSpend,
  parseUnitUsd,
  FILM_MAX_SECONDS,
} from "@/lib/storyboard-film";
import { fetchAtlasCatalog, getCachedAtlasEntry } from "@/lib/providers/atlas-catalog";
import { ATLAS_BASE_URL } from "@/lib/atlas-onekey";
import { toRemoteUsableImage } from "@/lib/remote-image";
import { probeMedia } from "@/lib/media-probe";
import { recordAiTask, updateAiTask } from "@/lib/ai-tasks";
import { apiError, errText } from "@/lib/api-error";
import { filterAssetsForScript } from "@/lib/asset-context";
import { isKlingVideoSelection } from "@/lib/assets-view";
import { assertKlingLocalRequest, klingRouteError } from "@/lib/kling/local-access";
import {
  checkCreativeProfileContext,
  isPremiumProductCgProfile,
  isPremiumProductCgProject,
} from "@/lib/creative-profiles";
import { lintCreativeProfileShots } from "@/lib/creative-policy-lint";
import { filterTrustedPremiumCgAssets } from "@/lib/premium-cg-assets";
import { PREMIUM_CG_VIDEO_NEGATIVE_PROMPT } from "@/lib/premium-cg-prompt";

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|bmp|gif)$/i;

/** Audio controls that providers accept directly or through their pass-through `extra` object. */
const PREMIUM_CG_AUDIO_CONTROL_KEYS = new Set([
  "audio",
  "audioenabled",
  "audioprompt",
  "audioreference",
  "audioreferenceurl",
  "audioreferenceurls",
  "audiourl",
  "enableaudio",
  "generateaudio",
  "nativeaudio",
  "referenceaudio",
  "referenceaudiourl",
  "referenceaudiourls",
  "referenceaudios",
  "sound",
  "texttospeech",
  "tts",
  "ttsenabled",
  "voiceover",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPremiumCgAudioControl(key: string): boolean {
  return PREMIUM_CG_AUDIO_CONTROL_KEYS.has(key.replace(/[_-]/g, "").toLowerCase());
}

/**
 * Preserve the legacy sales request as-is. Premium CG owns every audio input on the
 * server so a client cannot inject copy, a voice reference, or a provider-specific
 * audio toggle after the persisted profile has selected silent or restrained narration.
 */
function controlledFilmOptions(
  raw: unknown,
  premiumNarrationMode?: "none" | "restrained",
): Record<string, unknown> {
  const options = isPlainRecord(raw) ? { ...raw } : {};
  if (premiumNarrationMode === undefined) return options;

  for (const key of Object.keys(options)) {
    if (isPremiumCgAudioControl(key)) delete options[key];
  }

  // Provider adapters apply opaque extras after their typed request body. The CG branch owns
  // the compiled prompt and project references, so no nested value may replace either one.
  delete options.extra;
  delete options.negativePrompt;
  delete options.negative_prompt;

  // Approved restrained narration is embedded by buildStoryboardFilmPrompt. No caller
  // supplied voiceover, prompt, or reference audio is allowed through to a provider.
  options.audioEnabled = premiumNarrationMode === "restrained";
  options.negativePrompt = PREMIUM_CG_VIDEO_NEGATIVE_PROMPT;
  return options;
}

function filmOutputDimensions(options: Record<string, unknown>): { width?: number; height?: number } {
  return {
    ...(typeof options.width === "number" && Number.isFinite(options.width) && { width: options.width }),
    ...(typeof options.height === "number" && Number.isFinite(options.height) && { height: options.height }),
  };
}

/** A shot's usable keyframe IMAGE: an image asset's filePath, or a video asset's preserved keyframe */
function shotKeyframe(asset: { filePath?: string | null; thumbnailPath?: string | null } | undefined): string | undefined {
  if (!asset) return undefined;
  if (asset.filePath && IMAGE_EXT_RE.test(asset.filePath)) return asset.filePath;
  if (asset.thumbnailPath && IMAGE_EXT_RE.test(asset.thumbnailPath)) return asset.thumbnailPath;
  return undefined;
}

/**
 * POST /api/project/[id]/storyboard-film — grid to full film (九宫格→一键整片).
 *
 * Feeds every shot's keyframe (typically the storyboard grid's cropped cells) as
 * reference images into a single reference-to-video generation with a timecoded
 * multi-shot prompt: native cuts between shots, person/product locked across
 * cuts, dialogue spoken verbatim with continuous audio. The result lands in the
 * compositions table, so the export page picks it up like any composed video.
 *
 * body: { scriptId, provider, apiKey, model?, baseUrl?, options? }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let inputReferences: { url: string; kind: "character-sheet" | "shot"; shotId?: number }[] = [];
  try {
    const { id } = await params;
    if (!/^[a-zA-Z0-9-]+$/.test(id)) {
      return apiError(req, "无效的项目ID", "Invalid project id", 400);
    }
    const body = await req.json();
    if (body.action === "recover") {
      const [project] = await getDb().select().from(projects).where(eq(projects.id, id));
      if (!project) return apiError(req, "Project not found", "Project not found", 404);
      if (isPremiumProductCgProject(project)) {
        return NextResponse.json(
          {
            error: "Premium product CG does not recover legacy full-film outputs.",
            code: "PREMIUM_CG_OUTPUT_POLICY",
          },
          { status: 409 },
        );
      }
      return await recoverFilm(req, id, body);
    }
    if (body.provider === "kling-cli" || isKlingVideoSelection(body.model)) {
      try {
        await assertKlingLocalRequest(req);
        if (body.dryRun === true) {
          const { previewKlingFilm } = await import("@/lib/kling/film-plan");
          return NextResponse.json(await previewKlingFilm({ ...body, projectId: id, selectionKey: body.selectionKey ?? body.model }), { headers: { "Cache-Control": "no-store" } });
        }
        const { getKlingFilm } = await import("@/lib/kling/film-repository");
        if (typeof body.planId !== "string" || getKlingFilm(body.planId).projectId !== id) return NextResponse.json({ error: { code: "KLING_FILM_CONFIRMATION_REQUIRED", message: "请先在本项目预览并确认 Kling 整片计划" } }, { status: 422 });
        const { startKlingFilm } = await import("@/lib/kling/films");
        return NextResponse.json({ run: await startKlingFilm(body) }, { headers: { "Cache-Control": "no-store" } });
      } catch (error) { return klingRouteError(error); }
    }
    const { scriptId, provider: providerName, model, apiKey, baseUrl, options, characterSheetUrl, dryRun, spendCapUsd, acknowledgeOverCap, expectedPrompt } = body as {
      scriptId?: string;
      provider?: string;
      model?: string;
      apiKey?: string;
      baseUrl?: string;
      options?: Record<string, unknown>;
      /** Presenter's multi-view sheet — leads reference_images as the identity anchor (@Image1) */
      characterSheetUrl?: string;
      /** Preview only: return the full film prompt + counts + warnings, submit nothing, spend nothing */
      dryRun?: boolean;
      /** Refuse to submit when the estimate exceeds this many USD (0/omitted = no cap) */
      spendCapUsd?: number;
      /** Explicit go-ahead for a generation the cap would otherwise block */
      acknowledgeOverCap?: boolean;
      /** Optional confirmed preview; reject script changes before any video generation is submitted. */
      expectedPrompt?: string;
    };
    if (!scriptId) {
      return apiError(req, "缺少 scriptId", "Missing scriptId", 400);
    }

    const db = getDb();
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, id));
    if (!project) return apiError(req, "项目不存在", "Project not found", 404);

    const [script] = await db
      .select()
      .from(scripts)
      .where(and(eq(scripts.id, scriptId), eq(scripts.projectId, id)));
    if (!script) return apiError(req, "脚本不存在", "Script not found", 404);
    const context = checkCreativeProfileContext(project, script);
    if (!context.ok) {
      return NextResponse.json({
        error: context.code === "CREATIVE_CONFIG_STALE"
          ? "脚本基于旧的创作设置生成，请重新生成脚本后再生成整片。"
          : "当前脚本与项目创作类型不匹配，请切换到匹配类型或重新生成脚本。",
        code: context.code,
        projectCreationType: context.projectProfile.creationType,
        scriptCreationType: context.scriptProfile.creationType,
        projectRevision: context.projectRevision,
        scriptRevision: context.scriptRevision,
      }, { status: 409 });
    }
    const creativeProfile = context.projectProfile;
    const premiumCgProfile = isPremiumProductCgProfile(creativeProfile) ? creativeProfile : undefined;
    const premiumCg = !!premiumCgProfile;
    const filmOptions = controlledFilmOptions(options, premiumCgProfile?.narrationMode);
    const shots = Array.isArray(script.shots) ? script.shots : [];
    if (premiumCg) {
      const issues = lintCreativeProfileShots(creativeProfile, shots);
      if (issues.length) {
        return NextResponse.json({
          error: "Premium product CG scripts cannot request generated text, promotional graphics, or unapproved narration.",
          code: "CREATIVE_POLICY_VIOLATION",
          issues,
        }, { status: 400 });
      }
    }
    // CG products never use a presenter identity reference. A stale client field cannot
    // shift @Image indices or introduce a person into a product-film generation.
    const effectiveCharacterSheetUrl = premiumCg ? undefined : characterSheetUrl;
    if (shots.length < 2) {
      return apiError(req, "分镜太少，一键整片至少需要 2 个分镜", "Too few shots — the film pass needs at least 2", 400);
    }
    if (shots.length > GRID_MAX_SHOTS) {
      return apiError(
        req,
        `一键整片最多 ${GRID_MAX_SHOTS} 个分镜（当前 ${shots.length} 个）——长脚本请用逐镜生成+成片合成`,
        `The film pass holds at most ${GRID_MAX_SHOTS} shots (this script has ${shots.length}) — use per-shot generation + compose for longer scripts`,
        400
      );
    }
    const totalSec = filmTotalSeconds(shots);
    if (totalSec > FILM_MAX_SECONDS) {
      return apiError(
        req,
        `脚本总时长 ${Math.round(totalSec)} 秒超过单次生成上限 ${FILM_MAX_SECONDS} 秒——请缩短脚本，或用逐镜生成+成片合成`,
        `Total script duration ${Math.round(totalSec)}s exceeds the ${FILM_MAX_SECONDS}s single-generation cap — shorten the script or use per-shot generation + compose`,
        400
      );
    }

    // the model that will actually be billed — resolved identically on both branches, so the
    // preview names the same model the paid submit uses (issue #28)
    const choice = resolveFilmModel(model);
    const fit = filmDurationFit(shots, choice.model);
    const prompt = buildStoryboardFilmPrompt(shots, script.characters, {
      characterSheet: !!effectiveCharacterSheetUrl,
      creativeProfile,
    });
    if (expectedPrompt !== undefined && typeof expectedPrompt !== "string") {
      return NextResponse.json({ error: errText(req, "整片确认信息无效，请重新预览后确认生成。", "Invalid film confirmation. Preview the plan again before generating."), errorCode: "FILM_CONFIRMATION_INVALID" }, { status: 422 });
    }
    if (expectedPrompt !== undefined && expectedPrompt !== prompt) {
      return NextResponse.json({ error: errText(req, "脚本或参考素材配置已变化，请重新预览整片计划后确认生成。", "The script or reference configuration changed. Preview and confirm the film plan again before generating."), errorCode: "FILM_PLAN_STALE" }, { status: 409 });
    }

    if (dryRun) {
      const previewOpts = filmOutputDimensions(filmOptions);
      const estimate = estimateFilmSpend(await unitPriceUsd(choice.model, baseUrl), fit.seconds, previewOpts);
      // planned reference count: one keyframe per shot (+ the identity sheet when present) —
      // computable before the grid pass has actually rendered the keyframes
      const plannedRefs = shots.length + (effectiveCharacterSheetUrl ? 1 : 0);
      return NextResponse.json({
        dryRun: true,
        prompt,
        shotCount: shots.length,
        seconds: fit.seconds,
        model: choice.model,
        scriptSeconds: fit.scriptSeconds,
        modelMaxSeconds: fit.cap,
        durationOverflow: fit.overflow,
        referenceImages: plannedRefs,
        referenceQuota: referenceQuotaCheck(plannedRefs, choice.model),
        dialogueWarnings: dialogueDensityWarnings(shots),
        creativeProfile,
        // undefined when the platform publishes no price — the UI must say "unknown", not "free"
        ...(estimate && { estimate }),
      });
    }

    // pre-spend duration gate: a script longer than the chosen model can render comes back
    // silently truncated (the provider snaps the request down to its own ceiling), so refuse
    // rather than bill for a film that loses its tail
    if (fit.overflow) {
      return apiError(
        req,
        `脚本总时长 ${fit.scriptSeconds} 秒超过 ${choice.model} 的单次上限 ${fit.cap} 秒——继续会把后半段截掉。请缩短脚本，或换一个支持更长时长的模型`,
        `The ${fit.scriptSeconds}s script exceeds ${choice.model}'s ${fit.cap}s single-generation ceiling — generating would silently cut the tail. Shorten the script or pick a longer-form model`,
        400
      );
    }

    // past the dryRun branch money moves — provider and key become mandatory
    // (dryRun spends nothing, so it needs neither)
    if (!providerName) {
      return apiError(req, "缺少 provider", "Missing provider", 400);
    }
    if (!apiKey) {
      return apiError(req, "缺少 API Key，请先在设置中配置视频平台", "Missing API key — configure a video provider in settings first", 400);
    }

    // every shot needs a keyframe IMAGE (grid cells or per-shot stills) to cite as @ImageN
    const scopedAssetRows = filterAssetsForScript(
      await db.select().from(assets).where(and(eq(assets.projectId, id), eq(assets.selected, true))),
      script,
    );
    const assetRows = premiumCg
      ? filterTrustedPremiumCgAssets(scopedAssetRows, id, script)
      : scopedAssetRows;
    const byShot = new Map(assetRows.map((a) => [a.shotId, a]));
    const keyframes: string[] = [];
    const missing: number[] = [];
    for (const shot of shots) {
      const kf = shotKeyframe(byShot.get(shot.shotId));
      if (kf) keyframes.push(kf);
      else missing.push(shot.shotId);
    }
    if (missing.length > 0) {
      return apiError(
        req,
        `分镜 ${missing.join("、")} 还没有关键帧图——先跑「九宫格分镜」或逐镜生图`,
        `Shots ${missing.join(", ")} have no keyframe image yet — run the storyboard grid or per-shot generation first`,
        400
      );
    }
    // remote providers can't reach localhost: local /api/files keyframes travel as Base64.
    // With a character sheet it leads the array (@Image1 = identity anchor, shots shift to @Image2..)
    const refInputs = [...(effectiveCharacterSheetUrl ? [effectiveCharacterSheetUrl] : []), ...keyframes];
    inputReferences = [
      ...(effectiveCharacterSheetUrl ? [{ url: effectiveCharacterSheetUrl, kind: "character-sheet" as const }] : []),
      ...keyframes.map((url, index) => ({ url, kind: "shot" as const, shotId: shots[index].shotId })),
    ];
    // pre-spend quota gate: a reference count over the model's schema limit is a guaranteed
    // upstream rejection — block BEFORE the paid submit instead of paying to find out
    const quota = referenceQuotaCheck(refInputs.length, choice.model);
    if (!quota.ok) {
      return apiError(
        req,
        `参考图 ${quota.count} 张超过该模型上限 ${quota.limit} 张——减少分镜数${effectiveCharacterSheetUrl ? "，或去掉定妆照（少一张参考位）" : ""}后再试`,
        `${quota.count} reference images exceed this model's limit of ${quota.limit} — reduce the shot count${effectiveCharacterSheetUrl ? " or drop the presenter sheet (frees one slot)" : ""} and retry`,
        400
      );
    }
    // spend gate: refuse a run whose estimate blows the caller's cap unless they said go anyway.
    // Runs before the submit, so an over-cap generation costs nothing (issue #28).
    const cap = Number(spendCapUsd);
    if (Number.isFinite(cap) && cap > 0 && !acknowledgeOverCap) {
      // compare the HIGH end: a floor-priced estimate is exactly what hid the real bill (issue #28)
      const capOpts = filmOutputDimensions(filmOptions);
      const estimate = estimateFilmSpend(await unitPriceUsd(choice.model, baseUrl), fit.seconds, capOpts);
      if (estimate && estimate.maxUsd > cap) {
        return apiError(
          req,
          `预估花费最高 $${estimate.maxUsd.toFixed(2)}（${choice.model} $${estimate.unitUsd}/秒 × ${estimate.seconds} 秒；当前分辨率档实测约为基准价的 ${estimate.tierMultiplier} 倍）超过你设置的单次上限 $${cap}——请调高上限、调低分辨率、换更便宜的模型，或缩短脚本`,
          `Estimated up to $${estimate.maxUsd.toFixed(2)} (${choice.model} at $${estimate.unitUsd}/s x ${estimate.seconds}s; this resolution tier measured about ${estimate.tierMultiplier}x the base rate) exceeds your per-run cap of $${cap} — raise the cap, lower the resolution, pick a cheaper model, or shorten the script`,
          400
        );
      }
    }

    const referenceImageUrls = (await Promise.all(refInputs.map(toRemoteUsableImage))).filter(
      (u): u is string => !!u
    );

    const duration = fit.seconds;
    // lip-sync guardrail (advisory, never blocks): overstuffed lines drift out of sync near the
    // end of a segment — surfaced so the UI/CLI can suggest trimming before the paid generation
    const dialogueWarnings = dialogueDensityWarnings(shots);
    const provider = createProvider({ name: providerName, apiKey, baseUrl: baseUrl ?? "" });

    const opts = filmOutputDimensions(filmOptions);
    const videoOptions = {
      ...filmOptions,
      modelId: choice.model,
      mode: "video-to-video" as const,
      prompt,
      referenceImageUrls,
      duration,
      // portrait 720p unless the caller asked otherwise — maps to resolution+ratio provider-side
      width: opts.width ?? 720,
      height: opts.height ?? 1280,
      // Sales films retain native dialogue. CG is silent by default; only an approved
      // restrained-narration profile may request generated speech.
      audioEnabled: !premiumCg || premiumCgProfile.narrationMode === "restrained",
    };

    // legacy single-phase path for providers without two-phase task support
    if (!provider.submitVideoTask || !provider.waitForTask) {
      const result = await provider.generateVideo(videoOptions);
      const rowId = result.taskId ? await recordAiTask({ projectId: id, provider: providerName, model: result.modelId || choice.model, mediaType: "video", mode: "video-to-video", prompt, taskId: result.taskId }) : null;
      try {
        const saved = await persistFilm(id, result.videoUrls?.[0], result.modelId || choice.model, providerName, result.taskId, script.id);
        await updateAiTask(rowId, { status: "completed", resultUrls: result.videoUrls, error: null });
        return NextResponse.json({ ...saved, taskId: result.taskId, modelId: result.modelId, seconds: duration, dialogueWarnings });
      } catch (failure) {
        const error = failure instanceof Error ? failure.message : errText(req, "成片保存失败", "Could not save the completed film");
        await updateAiTask(rowId, { status: "unknown", resultUrls: result.videoUrls, error });
        return NextResponse.json({ error, taskId: result.taskId, modelId: result.modelId || choice.model, recoverable: Boolean(result.taskId) }, { status: 502 });
      }
    }

    // Phase 1: submit, then persist the paid task ID before polling (issue #16)
    const { taskId, modelId } = await provider.submitVideoTask(videoOptions);
    const rowId = await recordAiTask({
      projectId: id,
      provider: providerName,
      model: modelId,
      mediaType: "video",
      mode: "video-to-video",
      prompt,
      taskId,
    });

    // Phase 2: wait; a lost poll marks the row "unknown" but never drops the paid task
    try {
      const finalStatus = await provider.waitForTask(taskId, { interval: 5000 });
      const result = finalStatus.result;
      const videoUrl = result && "videoUrls" in result ? result.videoUrls?.[0] : undefined;
      if (!videoUrl) {
        await updateAiTask(rowId, { status: "unknown", error: "任务完成但未返回视频地址" });
        return NextResponse.json(
          { error: errText(req, "任务完成但未返回视频地址", "Task completed but returned no video URL"), taskId, modelId, recoverable: true },
          { status: 502 }
        );
      }
      await updateAiTask(rowId, { status: "processing", resultUrls: [videoUrl], error: null });
      const saved = await persistFilm(id, videoUrl, modelId, providerName, taskId, script.id);
      await updateAiTask(rowId, { status: "completed", resultUrls: [videoUrl], error: null });
      return NextResponse.json({ ...saved, taskId, modelId, seconds: duration, dialogueWarnings });
    } catch (error) {
      const failed = error instanceof ProviderError && error.code === "TASK_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      await updateAiTask(rowId, { status: failed ? "failed" : "unknown", error: message });
      return NextResponse.json(
        {
          error: failed
            ? message
            : errText(
                req,
                `${message}。任务 ID ${taskId} 已保存，请勿重复提交`,
                `${message}. Task ID ${taskId} has been saved — do not resubmit`
              ),
          taskId,
          modelId,
          recoverable: !failed,
        },
        { status: failed ? 500 : 504 }
      );
    }
  } catch (error) {
    if (error instanceof FilmModelSelectionError) {
      return NextResponse.json({ error: errText(req, error.message, error.englishMessage), errorCode: error.code }, { status: 422 });
    }
    console.error("一键整片生成失败:", error);
    if (error instanceof ProviderError && error.code.startsWith("InputImageSensitiveContentDetected")) {
      const number = error.referenceImageNumber;
      const reference = number ? inputReferences[number - 1] : undefined;
      const label = reference?.kind === "character-sheet"
        ? errText(req, "人物定妆照", "the presenter reference sheet")
        : reference?.shotId != null
          ? errText(req, `镜头 ${reference.shotId} 的关键帧`, `the keyframe for shot ${reference.shotId}`)
          : errText(req, "输入图片", "an input image");
      const privacy = error.code.endsWith(".PrivacyInformation");
      return NextResponse.json({
        error: privacy
          ? errText(req,
              `方舟拒绝了${label}：平台判定图片可能包含真人或隐私内容。请在素材页检查该图；产品特写可重新生成纯商品分镜，台词使用画外旁白。直接重复提交相同图片无法解决。`,
              `Ark rejected ${label} because it may contain a real person or private information. Review the image in Assets. For a product close-up, regenerate product-only shots with off-screen narration. Resubmitting the same image will not resolve this rejection.`)
          : errText(req,
              `方舟拒绝了${label}：该图未通过平台内容审核。请按所选模型的素材要求检查并更换图片后再提交。`,
              `Ark rejected ${label} during content review. Check the selected model's input requirements and replace the image before submitting again.`),
        errorCode: error.code,
        ...(error.requestId && { requestId: error.requestId }),
        ...(reference && { rejectedReference: { ...reference, number } }),
      }, { status: error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 400 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : errText(req, "一键整片生成失败", "Storyboard film failed") },
      { status: 500 }
    );
  }
}

/**
 * Published per-second price for a model, or undefined when the platform doesn't publish one.
 * The catalog endpoint is public (no key needed), so the free dryRun can price a run too.
 */
async function unitPriceUsd(modelId: string, baseUrl?: string): Promise<number | undefined> {
  try {
    await fetchAtlasCatalog(baseUrl?.trim() || ATLAS_BASE_URL);
    return parseUnitUsd(getCachedAtlasEntry(modelId)?.priceBase);
  } catch {
    return undefined; // pricing is advisory — never block a run because the catalog was unreachable
  }
}

function filmIdentity(projectId: string, provider: string, taskId: string) {
  const hash = createHash("sha256").update(JSON.stringify([projectId, provider, taskId])).digest("hex");
  const fileName = `film_${hash}.mp4`;
  return { compositionId: `film-${hash}`, fileName, outputPath: join(getDataDir(), "output", projectId, fileName) };
}

/** Returning an existing local output avoids duplicate downloads and composition rows on repeated recovery. */
async function savedFilm(projectId: string, provider: string, taskId: string) {
  const identity = filmIdentity(projectId, provider, taskId);
  const row = getDb().select().from(compositions).where(and(eq(compositions.id, identity.compositionId), eq(compositions.projectId, projectId))).get();
  if (!row || row.status !== "done" || row.outputPath !== identity.outputPath || !(await stat(identity.outputPath).catch(() => null))?.size) return null;
  return { url: `/api/output/${projectId}/${identity.fileName}`, compositionId: row.id, fileName: identity.fileName };
}

/** Recover only a persisted full-film task. This path never calls any generation/submit method. */
async function recoverFilm(req: NextRequest, projectId: string, body: Record<string, unknown>) {
  if (typeof body.taskId !== "string" || !body.taskId.trim() || typeof body.provider !== "string") return apiError(req, "恢复缺少原任务编号或平台", "Recovery requires the original task ID and provider", 400);
  const taskId = body.taskId;
  const [task] = await getDb().select().from(aiTasks).where(and(eq(aiTasks.projectId, projectId), eq(aiTasks.taskId, taskId), eq(aiTasks.provider, body.provider), isNull(aiTasks.shotId), eq(aiTasks.mediaType, "video"), eq(aiTasks.mode, "video-to-video")));
  if (!task || task.provider === "kling-cli") return NextResponse.json({ error: errText(req, "原整片任务不存在或不属于此项目，请检查任务记录。", "The original film task does not exist or belongs to another project."), taskId, recoverable: false }, { status: 404 });
  if (body.model !== undefined && body.model !== task.model) return NextResponse.json({ error: errText(req, "恢复模型必须与原任务一致，请使用原任务记录恢复。", "Recovery must use the model saved on the original task."), taskId, recoverable: true }, { status: 409 });
  try {
    const local = await savedFilm(projectId, task.provider, taskId);
    if (local) {
      await updateAiTask(task.id, { status: "completed", error: null });
      return NextResponse.json({ ...local, taskId, modelId: task.model, status: "completed" });
    }
    if (typeof body.apiKey !== "string" || !body.apiKey) return NextResponse.json({ error: errText(req, "请在设置中配置原任务平台的 API Key 后恢复。", "Configure the original provider's API key in Settings before recovering."), taskId, recoverable: true }, { status: 422 });
    const provider = createProvider({ name: task.provider, apiKey: body.apiKey, baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : "" });
    const status = body.wait === true && provider.waitForTask ? await provider.waitForTask(taskId, { interval: 5000 }) : await provider.getTaskStatus(taskId);
    if (status.status === "failed" || status.status === "cancelled") {
      const error = status.error || errText(req, "原整片任务已失败", "The original film task failed");
      await updateAiTask(task.id, { status: "failed", error });
      return NextResponse.json({ error, taskId, modelId: task.model, status: status.status, recoverable: false }, { status: 502 });
    }
    if (status.status !== "completed") {
      await updateAiTask(task.id, { status: "processing", error: null });
      return NextResponse.json({ taskId, modelId: task.model, status: status.status, recoverable: true }, { status: 202 });
    }
    const result = status.result;
    const videoUrl = (result && "videoUrls" in result ? result.videoUrls?.[0] : undefined) ?? task.resultUrls?.[0];
    await updateAiTask(task.id, { status: "processing", ...(videoUrl && { resultUrls: [videoUrl] }), error: null });
    const saved = await persistFilm(projectId, videoUrl, task.model, task.provider, taskId);
    await updateAiTask(task.id, { status: "completed", ...(videoUrl && { resultUrls: [videoUrl] }), error: null });
    return NextResponse.json({ ...saved, taskId, modelId: task.model, status: "completed" });
  } catch (failure) {
    const failed = failure instanceof ProviderError && failure.code === "TASK_FAILED";
    const error = failure instanceof Error ? failure.message : errText(req, "恢复整片失败", "Film recovery failed");
    await updateAiTask(task.id, { status: failed ? "failed" : "unknown", error });
    return NextResponse.json({ error, taskId, modelId: task.model, recoverable: !failed }, { status: failed ? 502 : 504 });
  }
}

class FilmPersistencePolicyError extends Error {
  readonly code = "PREMIUM_CG_OUTPUT_POLICY";
}

/** A delayed result may only be written while the initiating project/script context remains current. */
async function assertFilmPersistenceContext(projectId: string, scriptId?: string): Promise<void> {
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  if (!scriptId) {
    if (isPremiumProductCgProject(project)) {
      throw new FilmPersistencePolicyError("Premium product CG does not accept a recovered legacy full-film result.");
    }
    return;
  }
  const [script] = await db.select().from(scripts).where(and(eq(scripts.id, scriptId), eq(scripts.projectId, projectId)));
  if (!script) throw new FilmPersistencePolicyError("The initiating script is no longer available.");
  const context = checkCreativeProfileContext(project, script);
  if (!context.ok) throw new FilmPersistencePolicyError("The creative profile changed while the film task was running.");
}

/** Download the generated film and register a stable composition for the original paid task. */
async function persistFilm(
  projectId: string,
  videoUrl: string | undefined,
  model: string,
  provider: string,
  taskId?: string,
  scriptId?: string,
) {
  await assertFilmPersistenceContext(projectId, scriptId);
  const stableTaskId = taskId || randomUUID();
  const existing = await savedFilm(projectId, provider, stableTaskId);
  if (existing) return existing;
  if (!videoUrl) throw new Error("生成完成但未返回视频地址");
  const resp = await fetch(videoUrl);
  if (!resp.ok) throw new Error(`下载成片失败: ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length === 0) throw new Error("下载成片返回了空视频，原任务可继续恢复");
  await assertFilmPersistenceContext(projectId, scriptId);
  const outputDir = join(getDataDir(), "output", projectId);
  await mkdir(outputDir, { recursive: true });
  const { compositionId, fileName, outputPath } = filmIdentity(projectId, provider, stableTaskId);
  const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, buf);
    await rename(temporaryPath, outputPath);
  } finally { await unlink(temporaryPath).catch(() => {}); }

  const probe = await probeMedia(outputPath).catch(() => undefined);
  const db = getDb();
  const [comp] = await db
    .insert(compositions)
    .values({
      id: compositionId,
      projectId,
      outputPath,
      resolution: "720p",
      aspectRatio: "9:16",
      ...(probe?.duration ? { duration: Math.round(probe.duration * 1000) } : {}),
      // one-call native generation: no badge burned in — the release gate reports this honestly
      aigcBadge: false,
      label: `九宫格整片 · ${model.split("/").slice(0, 2).pop() ?? model}`.slice(0, 60),
      status: "done",
    })
    .onConflictDoUpdate({ target: compositions.id, set: { outputPath, status: "done", ...(probe?.duration ? { duration: Math.round(probe.duration * 1000) } : {}) } })
    .returning();
  return { url: `/api/output/${projectId}/${fileName}`, compositionId: comp.id, fileName };
}
