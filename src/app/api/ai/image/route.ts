import { NextRequest, NextResponse } from "next/server";
import { createProvider } from "@/lib/providers";
import { toRemoteUsableImage } from "@/lib/remote-image";
import { apiError, errText } from "@/lib/api-error";
import { getDb } from "@/lib/db";
import { projects, scripts, type Shot } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import {
  checkCreativeProfileContext,
  isPremiumProductCgProfile,
  resolveCreativeProfile,
} from "@/lib/creative-profiles";
import { lintCreativeProfileShot } from "@/lib/creative-policy-lint";
import {
  compilePremiumCgImagePrompt,
  PREMIUM_CG_IMAGE_NEGATIVE_PROMPT,
} from "@/lib/premium-cg-prompt";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function controlledImageOptionKeys(value: unknown, discardExtra = false): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const result = { ...value };
  // These values are derived from the request and the project policy. Allowing an
  // arbitrary options object to replace them makes the policy client-controlled.
  for (const key of ["modelId", "mode", "prompt", "referenceImageUrl", "referenceImageUrls"]) {
    delete result[key];
  }
  // Providers spread `extra` after their compiled request body. Premium CG owns the prompt,
  // model inputs, and no-text policy, so an opaque nested object cannot be forwarded.
  if (discardExtra) {
    delete result.extra;
    delete result.negativePrompt;
    delete result.negative_prompt;
  }
  return result;
}

function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function imageMode(value: unknown): "text-to-image" | "image-to-image" {
  return value === "image-to-image" ? "image-to-image" : "text-to-image";
}

// AI image generation
export async function POST(req: NextRequest) {
  const rawBody: unknown = await req.json();
  if (!isRecord(rawBody)) {
    return apiError(req, "请求体必须是 JSON 对象", "Request body must be a JSON object", 400);
  }
  const body = rawBody;
  const providerName = requiredString(body.provider);
  const model = requiredString(body.model);
  const requestedPrompt = requiredString(body.prompt);
  const apiKey = requiredString(body.apiKey);
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl : "";
  let imageUrl = typeof body.imageUrl === "string" && body.imageUrl.trim() ? body.imageUrl.trim() : undefined;
  const imageUrls = Array.isArray(body.imageUrls)
    ? body.imageUrls
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim())
    : undefined;
  let mode = imageMode(body.mode);
  const options = body.options;

  if (!providerName || !model) {
    return apiError(req, "缺少必要参数", "Missing required parameters");
  }

  if (!apiKey) {
    return apiError(req, "缺少 API Key，请先在设置中配置对应平台", "Missing API Key, please configure the corresponding platform in settings first");
  }

  try {
    let creativeProfile: unknown = body.creativeProfile;
    let projectId: string | undefined;
    const scriptId = typeof body.scriptId === "string" ? body.scriptId : undefined;
    let shotId: number | undefined;
    let approvedPremiumShot: Shot | undefined;
    if (body.projectId !== undefined && typeof body.projectId !== "string") {
      return apiError(req, "项目ID格式无效", "Invalid project id", 400);
    }
    if (body.scriptId !== undefined && (!scriptId || !/^[a-zA-Z0-9-]+$/.test(scriptId))) {
      return apiError(req, "脚本ID格式无效", "Invalid script id", 400);
    }
    if (body.shotId !== undefined && !Number.isSafeInteger(body.shotId)) {
      return apiError(req, "镜头ID格式无效", "Invalid shot id", 400);
    }
    if (typeof body.projectId === "string") {
      if (!/^[a-zA-Z0-9-]+$/.test(body.projectId)) {
        return apiError(req, "项目ID格式无效", "Invalid project id", 400);
      }
      projectId = body.projectId;
      const db = getDb();
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) return apiError(req, "项目不存在", "Project not found", 404);
      const profile = resolveCreativeProfile(project.creativeProfile, { videoMode: project.videoMode });
      // Existing sales integrations can still generate project images before or outside a script
      // selection. The assets page supplies scriptId; premium CG always requires one.
      const requiresScriptContext = Boolean(scriptId) || isPremiumProductCgProfile(profile);
      const selectedRows = requiresScriptContext
        ? db.select().from(scripts).where(and(eq(scripts.projectId, projectId), eq(scripts.selected, true))).all()
        : [];
      const selected = requiresScriptContext
        ? selectedRows[0] ?? db.select().from(scripts).where(eq(scripts.projectId, projectId)).get()
        : undefined;
      if (scriptId && !selected) {
        return apiError(req, "项目没有可用脚本", "Project has no usable script", 409);
      }
      if (scriptId && selected?.id !== scriptId) {
        return NextResponse.json({ error: "当前脚本已切换，请刷新后重新生成图片。", code: "SCRIPT_CONTEXT_CHANGED" }, { status: 409 });
      }
      if (selected) {
        const context = checkCreativeProfileContext(project, selected);
        if (!context.ok) {
          return NextResponse.json({
            error: context.code === "CREATIVE_CONFIG_STALE"
              ? "脚本基于旧的创作设置生成，请重新生成脚本后再生成图片。"
              : "当前脚本与项目创作类型不匹配，请切换到匹配类型或重新生成脚本。",
            code: context.code,
            projectCreationType: context.projectProfile.creationType,
            scriptCreationType: context.scriptProfile.creationType,
            projectRevision: context.projectRevision,
            scriptRevision: context.scriptRevision,
          }, { status: 409 });
        }
        creativeProfile = context.projectProfile;
      } else {
        // Retain pre-script legacy image creation, but never accept a client-supplied profile
        // in place of a persisted project profile.
        creativeProfile = profile;
      }
      if (isPremiumProductCgProfile(profile)) {
        if (!selected) return apiError(req, "高端家具 CG 生图必须指定当前脚本", "Premium product CG image generation requires a current script", 400);
        if (!scriptId) return apiError(req, "高端家具 CG 生图必须指定当前脚本", "Premium product CG image generation requires a script id", 400);
        const productImageUrls = Array.isArray(project.productImages)
          ? project.productImages
            .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
            .map((value) => value.trim())
          : [];
        if (productImageUrls.length === 0) {
          return NextResponse.json({
            error: "高端家具 CG 生图至少需要一张已保存的产品参考图。",
            code: "PREMIUM_CG_PRODUCT_REFERENCE_REQUIRED",
          }, { status: 400 });
        }
        const projectProductImages = new Set(productImageUrls);
        const requestedReferences = [imageUrl, ...(imageUrls ?? [])].filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        );
        if (requestedReferences.some((value) => !projectProductImages.has(value))) {
          return NextResponse.json({
            error: "高端家具 CG 只能使用本项目已保存的产品参考图。",
            code: "PREMIUM_CG_PRODUCT_REFERENCE_INVALID",
          }, { status: 400 });
        }
        // Product CG cannot fall back to unanchored text-to-image generation. When the
        // browser omits a reference (for example after productSafe was toggled off), bind
        // the request to the persisted product image instead.
        if (requestedReferences.length === 0) imageUrl = productImageUrls[0];
        // Several providers only implement the legacy singular input. Keep that input
        // anchored even when a caller supplies its saved product views as an array.
        else if (!imageUrl) imageUrl = requestedReferences[0];
        mode = "image-to-image";
        if (Number.isSafeInteger(body.shotId)) shotId = body.shotId as number;
        if (shotId === undefined) return apiError(req, "高端家具 CG 生图必须指定当前镜头", "Premium product CG image generation requires a shot id", 400);
        const shot = selected.shots?.find((item) => item.shotId === shotId);
        if (!shot) return apiError(req, "镜头不存在", "Shot not found", 404);
        const issues = lintCreativeProfileShot(profile, { ...shot, shotId });
        if (issues.length) {
          return NextResponse.json({
            error: "Premium product CG image prompt violates the no-added-text or restrained-narration policy.",
            code: "CREATIVE_POLICY_VIOLATION",
            issues,
          }, { status: 400 });
        }
        approvedPremiumShot = shot;
        creativeProfile = profile;
      }
    }

    const profileIsPremium = isPremiumProductCgProfile(creativeProfile);
    if (profileIsPremium && !projectId) {
      return NextResponse.json({
        error: "高端家具 CG 生图必须关联包含产品参考图的项目。",
        code: "PREMIUM_CG_PROJECT_CONTEXT_REQUIRED",
      }, { status: 400 });
    }
    if (!profileIsPremium && !requestedPrompt) {
      return apiError(req, "Missing required parameters", "Missing required parameters");
    }
    if (profileIsPremium && !approvedPremiumShot) {
      return NextResponse.json({ error: "Premium product CG image generation requires an approved current shot.", code: "PREMIUM_CG_PROJECT_CONTEXT_REQUIRED" }, { status: 400 });
    }
    const compiled = profileIsPremium
      ? compilePremiumCgImagePrompt(approvedPremiumShot!, creativeProfile)
      : { prompt: requestedPrompt!, negativePrompt: undefined as string | undefined };
    const providerOptions = controlledImageOptionKeys(options, profileIsPremium);
    if (profileIsPremium) {
      providerOptions.negativePrompt = compiled.negativePrompt ?? PREMIUM_CG_IMAGE_NEGATIVE_PROMPT;
    }

    // For image-to-image mode, convert local reference images to data URIs.
    // imageUrls (plural) feeds multi-reference edits (e.g. character sheet + product photo);
    // the array order is preserved so prompts can cite references by position.
    const referenceImageUrl = await toRemoteUsableImage(imageUrl);
    const referenceImageUrls = imageUrls && imageUrls.length > 0
      ? (await Promise.all(imageUrls.map(toRemoteUsableImage))).filter((u): u is string => !!u)
      : undefined;
    if (profileIsPremium && !referenceImageUrl && !referenceImageUrls?.length) {
      return NextResponse.json({
        error: "高端家具 CG 的产品参考图不可用，请重新上传或选择项目中可访问的产品图。",
        code: "PREMIUM_CG_PRODUCT_REFERENCE_UNAVAILABLE",
      }, { status: 400 });
    }

    const provider = createProvider({ name: providerName, apiKey, baseUrl });

    const result = await provider.generateImage({
      ...providerOptions,
      modelId: model,
      mode,
      prompt: compiled.prompt,
      referenceImageUrl,
      ...(referenceImageUrls?.length && { referenceImageUrls }),
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("生图失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : errText(req, "生图失败", "Image generation failed") },
      { status: 500 }
    );
  }
}
