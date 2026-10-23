import { resolveCurrentScript } from "@/lib/current-script";
import { NextRequest, NextResponse } from "next/server";
import { createProvider } from "@/lib/providers";
import { ProviderError } from "@/lib/providers/base";
import { toRemoteUsableImage, resolveUploadFilePath } from "@/lib/remote-image";
import { apiError, errText } from "@/lib/api-error";
import { recordAiTask, updateAiTask } from "@/lib/ai-tasks";
import { sanitizeGenerationControlSummary } from "@/lib/video-repair-plan";
import { assertKlingLocalRequest, klingRouteError } from "@/lib/kling/local-access";
import { createKlingJob } from "@/lib/kling/jobs";
import { klingJobView } from "@/lib/kling/repository";
import { isKlingVideoSelection } from "@/lib/assets-view";
import { validateVideoPrompt } from "@/lib/video-prompt";
import { getDb } from "@/lib/db";
import { assets, projects, scripts } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { checkCreativeProfileContext, isPremiumProductCgProfile } from "@/lib/creative-profiles";
import { lintCreativeProfileShot } from "@/lib/creative-policy-lint";
import { filterAssetsForScript } from "@/lib/asset-context";
import { compilePremiumCgVideoPrompt } from "@/lib/premium-cg-prompt";
import { resolvePremiumCgVideoReferences } from "@/lib/premium-cg-video";
import { filterTrustedPremiumCgAssets } from "@/lib/premium-cg-assets";
import type { VideoOptions } from "@/lib/providers/types";

export const runtime = "nodejs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function supportedMode(value: unknown, hasImage: boolean): "text-to-video" | "image-to-video" | "video-to-video" {
  if (value === "video-to-video" || value === "image-to-video" || value === "text-to-video") return value;
  return hasImage ? "image-to-video" : "text-to-video";
}

type ClientVideoOptions = Omit<VideoOptions, "modelId" | "mode" | "prompt" | "firstFrameUrl" | "lastFrameUrl" | "referenceVideoUrls" | "referenceImageUrls" | "referenceAudioUrls">;

const CONTROLLED_EXTRA_KEYS = new Set([
  "model", "model_id", "prompt", "input", "image", "images", "first_frame", "firstFrameUrl",
  "last_frame", "lastFrameUrl", "reference_image", "reference_images", "referenceImageUrls",
  "reference_video", "reference_videos", "referenceVideoUrls", "reference_audio", "reference_audios",
  "referenceAudioUrls", "voiceover", "audio_prompt", "audioPrompt", "generate_audio", "enable_audio",
  "audio", "sound", "native_audio", "audio_enabled", "audioEnabled",
]);

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Retain only the typed provider controls. Prompt, inputs, model and audio policy are server-owned. */
function clientVideoOptions(raw: unknown): ClientVideoOptions {
  if (!isRecord(raw)) return {};
  const output: ClientVideoOptions = {};
  for (const key of ["width", "height", "duration", "fps", "motionStrength", "guidanceScale", "seed"] as const) {
    const value = finiteNumber(raw[key]);
    if (value !== undefined) output[key] = value;
  }
  for (const key of ["negativePrompt", "voiceover", "audioPrompt"] as const) {
    const value = requiredString(raw[key]);
    if (value) output[key] = value;
  }
  if (typeof raw.audioEnabled === "boolean") output.audioEnabled = raw.audioEnabled;
  if (isRecord(raw.extra)) {
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw.extra)) {
      if (!CONTROLLED_EXTRA_KEYS.has(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
        extra[key] = value;
      }
    }
    if (Object.keys(extra).length) output.extra = extra;
  }
  return output;
}

function stripCgAudioControls(options: ClientVideoOptions): void {
  options.audioEnabled = false;
  delete options.voiceover;
  delete options.audioPrompt;
  if (options.extra) {
    for (const key of CONTROLLED_EXTRA_KEYS) delete options.extra[key];
  }
}

// AI video generation.
//
// Two-phase flow (issue #16): submit the paid task, persist the provider task ID to
// ai_tasks IMMEDIATELY, then poll. A poll timeout/crash no longer loses the task —
// the error response carries the task ID and the row stays recoverable ("unknown"),
// so the client can resume via /api/ai/video/task instead of paying again.
export async function POST(req: NextRequest) {
  const rawBody: unknown = await req.json().catch(() => null);
  if (!isRecord(rawBody)) return apiError(req, "请求体必须是 JSON 对象", "Request body must be a JSON object", 400);
  const body = rawBody;
  if (body.provider === "kling-cli") {
    try {
      await assertKlingLocalRequest(req);
      const job = await createKlingJob(body);
      return NextResponse.json({ ...klingJobView(job), recoverable: true, pollAfterMs: 5000,
        statusUrl: "/api/integrations/kling/jobs/" + job.id }, { status: 202, headers: { "Cache-Control": "no-store" } });
    } catch (error) { return klingRouteError(error); }
  }
  if ((typeof body.model === "string" && isKlingVideoSelection(body.model)) || (typeof body.selectionKey === "string" && isKlingVideoSelection(body.selectionKey))) {
    return NextResponse.json({ error: "Kling CLI 请使用素材页的单镜头生成入口", code: "KLING_SCOPE_UNSUPPORTED" }, { status: 400 });
  }
  const providerName = requiredString(body.provider);
  const model = requiredString(body.model);
  const clientPrompt = requiredString(body.prompt) ?? "";
  const apiKey = requiredString(body.apiKey);
  let imageUrl = typeof body.imageUrl === "string" ? body.imageUrl : undefined;
  let lastImageUrl = typeof body.lastImageUrl === "string" ? body.lastImageUrl : undefined;
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl : "";
  let mode = supportedMode(body.mode, Boolean(imageUrl));
  let prompt = clientPrompt;
  const rawOptions = isRecord(body.options) ? body.options : {};
  const options = clientVideoOptions(rawOptions);
  const projectId = typeof body.projectId === "string" ? body.projectId : undefined;
  const scriptId = typeof body.scriptId === "string" ? body.scriptId : undefined;
  const shotId = typeof body.shotId === "number" && Number.isSafeInteger(body.shotId) ? body.shotId : undefined;
  let referenceVideoUrls = body.referenceVideoUrls;
  let referenceImageUrls = body.referenceImageUrls;
  let referenceAudioUrls = body.referenceAudioUrls;
  const controlPlan = sanitizeGenerationControlSummary(body.controlPlan);
  let premiumCg = false;

  if (!providerName || !model) {
    return apiError(req, "缺少必要参数", "Missing required parameters");
  }

  if (!apiKey) {
    return apiError(req, "缺少 API Key，请先在设置中配置对应平台", "Missing API Key, please configure the corresponding platform in settings first");
  }

  if (body.projectId !== undefined && (!projectId || !/^[a-zA-Z0-9-]+$/.test(projectId))) {
    return apiError(req, "项目ID格式无效", "Invalid project id", 400);
  }
  if (body.scriptId !== undefined && (!scriptId || !/^[a-zA-Z0-9-]+$/.test(scriptId))) {
    return apiError(req, "脚本ID格式无效", "Invalid script id", 400);
  }
  if (body.shotId !== undefined && shotId === undefined) {
    return apiError(req, "镜头ID格式无效", "Invalid shot id", 400);
  }

  const promptIssues = validateVideoPrompt(prompt);
  if (promptIssues.length) return NextResponse.json({ error: promptIssues.map((issue) => issue.message).join(" "), code: "VIDEO_PROMPT_INVALID", issues: promptIssues }, { status: 400 });
  if (Object.hasOwn(rawOptions, "prompt") && rawOptions.prompt !== prompt) {
    return apiError(req, "生成参数不能替换已确认的提示词", "Generation options cannot replace the confirmed prompt", 400);
  }

  try {
    if (projectId) {
      const db = getDb();
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) return apiError(req, "项目不存在", "Project not found", 404);
      const selectedRows = db.select().from(scripts).where(and(eq(scripts.projectId, projectId), eq(scripts.selected, true))).all();
      const selected = resolveCurrentScript(selectedRows);
      if (!selected) return apiError(req, "项目没有可用脚本", "Project has no usable script", 409);
      if (scriptId && selected.id !== scriptId) {
        return NextResponse.json({ error: "当前脚本已切换，请刷新后重新生成视频。", code: "SCRIPT_CONTEXT_CHANGED" }, { status: 409 });
      }
      const context = checkCreativeProfileContext(project, selected);
      if (!context.ok) {
        return NextResponse.json({
          error: context.code === "CREATIVE_CONFIG_STALE"
            ? "脚本基于旧的创作设置生成，请重新生成脚本后再生成视频。"
            : "当前脚本与项目创作类型不匹配，请切换到匹配类型或重新生成脚本。",
          code: context.code,
          projectCreationType: context.projectProfile.creationType,
          scriptCreationType: context.scriptProfile.creationType,
          projectRevision: context.projectRevision,
          scriptRevision: context.scriptRevision,
        }, { status: 409 });
      }
      const profile = context.projectProfile;
      if (isPremiumProductCgProfile(profile)) {
        premiumCg = true;
        // Providers apply `extra` after their typed request body. Premium CG owns every
        // prompt and media input, so no opaque provider override can accompany the request.
        delete options.extra;
        if (!scriptId) {
          return apiError(req, "Missing selected script", "Premium product CG video generation requires a script id", 400);
        }
        if (shotId === undefined) {
          return apiError(req, "高端产品 CG 视频生成必须指定当前镜头", "Premium product CG video generation requires a shot id", 400);
        }
        const shot = selected.shots?.find((item) => item.shotId === shotId);
        if (!shot) return apiError(req, "镜头不存在", "Shot not found", 404);
        const issues = lintCreativeProfileShot(profile, { ...shot, shotId });
        if (issues.length) {
          return NextResponse.json({
            error: "Premium product CG video prompt violates the no-added-text or narration policy.",
            code: "CREATIVE_POLICY_VIOLATION",
            issues,
          }, { status: 400 });
        }
        const selectedAssets = filterTrustedPremiumCgAssets(filterAssetsForScript(
          db.select().from(assets).where(and(
            eq(assets.projectId, projectId),
            eq(assets.selected, true),
            eq(assets.status, "done"),
          )).all(),
          selected,
        ), projectId, selected);
        const references = resolvePremiumCgVideoReferences({
          productImages: project.productImages,
          selectedAssets,
          shotIds: selected.shots?.map((item) => item.shotId) ?? [],
          shotId,
          // Client media URLs are not part of the CG trust boundary. The resolver derives
          // the first frame from saved product images or selected project keyframes, so a
          // copied sales card or a remote reference cannot become a paid model input.
        });
        if (!references.ok) {
          return NextResponse.json({
            error: references.code === "PREMIUM_CG_PRODUCT_REFERENCE_REQUIRED"
              ? "Premium product CG video generation requires a saved product reference image."
              : "Premium product CG can use only saved product images and selected project keyframes.",
            code: references.code,
          }, { status: 400 });
        }
        const compiled = compilePremiumCgVideoPrompt(shot, profile);
        prompt = compiled.prompt;
        mode = "image-to-video";
        imageUrl = references.imageUrl;
        lastImageUrl = references.lastImageUrl;
        referenceImageUrls = references.referenceImageUrls;
        options.negativePrompt = compiled.negativePrompt;
        // Product CG uses the approved keyframe/reference-image chain only. A browser-supplied
        // reference video can import a legacy sales treatment or uncontrolled on-screen copy.
        referenceVideoUrls = undefined;
        if (profile.narrationMode === "none") {
          stripCgAudioControls(options);
          referenceAudioUrls = undefined;
        } else {
          const approvedNarration = shot.narration?.trim() || shot.voiceover?.trim() || "";
          if (options.voiceover && options.voiceover !== approvedNarration) {
            return apiError(req, "克制旁白必须与已批准的脚本文案一致", "Restrained narration must match the approved script", 400);
          }
          // The script snapshot is the only allowed narration source. Ambient/music choices
          // are composed later rather than being injected as unreviewed provider prompts.
          delete options.audioPrompt;
          referenceAudioUrls = undefined;
          if (options.audioEnabled) {
            if (!approvedNarration) return apiError(req, "当前脚本没有可用的克制旁白", "The approved script has no restrained narration", 400);
            options.voiceover = approvedNarration;
          } else {
            delete options.voiceover;
          }
        }
      }
    }

    const provider = createProvider({ name: providerName, apiKey, baseUrl });

    const firstFrameUrl = await toRemoteUsableImage(imageUrl);
    if (premiumCg && !firstFrameUrl) {
      return NextResponse.json({
        error: "Premium product CG product or approved keyframe reference is unavailable.",
        code: "PREMIUM_CG_PRODUCT_REFERENCE_UNAVAILABLE",
      }, { status: 400 });
    }
    // Keyframe chaining: pin the clip's last frame to the next
    // shot's keyframe so the transition is generated inside the clip (seamless on hard concat)
    const lastFrameUrl = lastImageUrl ? await toRemoteUsableImage(lastImageUrl) : undefined;

    // Reference-to-video inputs (viral replication): reference IMAGES may travel as Base64
    // like first frames, but reference VIDEOS must be real URLs — local /api/files paths
    // are uploaded to the provider's temporary hosting first (Atlas /model/uploadMedia)
    let refVideos: string[] | undefined;
    let refImages: string[] | undefined;
    let refAudios: string[] | undefined;
    if (Array.isArray(referenceVideoUrls) && referenceVideoUrls.length > 0) {
      refVideos = [];
      for (const ref of (referenceVideoUrls as unknown[]).slice(0, 3)) {
        if (typeof ref !== "string" || !ref) continue;
        if (ref.startsWith("http")) {
          refVideos.push(ref);
          continue;
        }
        const localPath = resolveUploadFilePath(ref);
        if (!localPath || !provider.uploadLocalMedia) {
          return apiError(req, "参考视频不可用：需要可访问的视频地址", "Reference video unavailable: a reachable video URL is required");
        }
        refVideos.push(await provider.uploadLocalMedia(localPath));
      }
    }
    if (Array.isArray(referenceImageUrls) && referenceImageUrls.length > 0) {
      const imageRefs = (referenceImageUrls as unknown[]).filter((ref): ref is string => typeof ref === "string" && Boolean(ref)).slice(0, 9);
      refImages = (await Promise.all(imageRefs.map(toRemoteUsableImage))).filter(
        (u): u is string => !!u
      );
    }
    if (Array.isArray(referenceAudioUrls) && referenceAudioUrls.length > 0) {
      refAudios = [];
      for (const ref of (referenceAudioUrls as unknown[]).slice(0, 3)) {
        if (typeof ref !== "string" || !ref) continue;
        if (ref.startsWith("http")) {
          refAudios.push(ref);
          continue;
        }
        const localPath = resolveUploadFilePath(ref);
        if (!localPath || !provider.uploadLocalMedia) {
          return apiError(req, "参考音频不可用：需要可访问的音频地址", "Reference audio unavailable: a reachable audio URL is required");
        }
        refAudios.push(await provider.uploadLocalMedia(localPath));
      }
    }

    const videoOptions: VideoOptions = {
      ...options,
      modelId: model,
      mode,
      prompt,
      firstFrameUrl,
      ...(lastFrameUrl && { lastFrameUrl }),
      ...(refVideos?.length && { referenceVideoUrls: refVideos }),
      ...(refImages?.length && { referenceImageUrls: refImages }),
      ...(refAudios?.length && { referenceAudioUrls: refAudios }),
    };

    // legacy single-phase path for providers without two-phase task support
    if (!provider.submitVideoTask || !provider.waitForTask) {
      const result = await provider.generateVideo(videoOptions);
      return NextResponse.json(result);
    }

    // Phase 1: submit. Mode/model capability is validated inside the provider BEFORE any
    // billable call; base.request() never auto-retries this POST on timeout (money safety).
    const startTime = Date.now();
    const { taskId, modelId } = await provider.submitVideoTask(videoOptions);

    // Persist the paid task before polling starts — this row is the recovery handle.
    const rowId = await recordAiTask({
      projectId,
      shotId,
      provider: providerName,
      model: modelId,
      mediaType: "video",
      mode: videoOptions.mode,
      prompt: videoOptions.prompt,
      taskId,
      ...(controlPlan && { controlPlan }),
    });

    // Phase 2: wait. Transient status-query failures are tolerated inside waitForTask;
    // if it still fails, the task is marked "unknown"/"failed" but never dropped.
    try {
      const finalStatus = await provider.waitForTask(taskId, { interval: 5000 });
      const result = finalStatus.result;
      const videoUrls = result && "videoUrls" in result ? result.videoUrls : undefined;
      if (!videoUrls || videoUrls.length === 0) {
        await updateAiTask(rowId, { status: "unknown", error: "任务完成但未返回视频地址" });
        return NextResponse.json(
          { error: errText(req, "任务完成但未返回视频地址", "Task completed but returned no video URL"), taskId, modelId, recoverable: true },
          { status: 502 }
        );
      }
      await updateAiTask(rowId, { status: "completed", resultUrls: videoUrls, error: null });
      return NextResponse.json({
        taskId,
        videoUrls,
        modelId,
        duration: videoOptions.duration,
        processingTime: Date.now() - startTime,
        hasAudio: videoOptions.audioEnabled ?? false,
      });
    } catch (error) {
      // definitive provider-side failure vs. lost contact (task may still be running & billed)
      const failed = error instanceof ProviderError && error.code === "TASK_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      await updateAiTask(rowId, { status: failed ? "failed" : "unknown", error: message });
      return NextResponse.json(
        {
          error: failed
            ? message
            : errText(
                req,
                `${message}。任务 ID ${taskId} 已保存，可在素材页恢复查询，请勿重复提交`,
                `${message}. Task ID ${taskId} has been saved and can be recovered from the assets page — do not resubmit`
              ),
          taskId,
          modelId,
          recoverable: !failed,
        },
        { status: failed ? 500 : 504 }
      );
    }
  } catch (error) {
    console.error("生视频失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : errText(req, "生视频失败", "Video generation failed") },
      { status: 500 }
    );
  }
}
