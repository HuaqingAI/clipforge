import { NextRequest, NextResponse } from "next/server";
import { stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { assets, characters, projects, scripts } from "@/lib/db/schema";
import { assetMatchesScript, assetScopeForShot, scriptRevision } from "@/lib/asset-context";
import { AssetContextConflictError, persistAssetSource, saveAssetCandidate } from "@/lib/asset-persistence";
import { resolveCurrentScript } from "@/lib/current-script";
import { isPremiumProductCgProfile, isTideweOutdoorProfile } from "@/lib/creative-profiles";
import { checkKeyframeRefinementContext } from "@/lib/keyframe-refinement-context";
import { lintCreativeProfileShots } from "@/lib/creative-policy-lint";
import { assertTideweScript } from "@/lib/tidewe/validation";
import { tidewePresenterReference } from "@/lib/tidewe/presenter";
import { TIDEWE_VISUAL_NEGATIVE_PROMPT } from "@/lib/tidewe/visual-policy";
import { hasTrustedPremiumCgAssetProvenance } from "@/lib/premium-cg-assets";
import { PREMIUM_CG_IMAGE_NEGATIVE_PROMPT } from "@/lib/premium-cg-prompt";
import { resolveCharacterReferenceModel } from "@/lib/character-reference-model";
import { createProvider } from "@/lib/providers";
import { ProviderError } from "@/lib/providers/base";
import { resolveUploadFilePath, toRemoteUsableImage } from "@/lib/remote-image";
import { probeMedia } from "@/lib/media-probe";
import { getDataDir } from "@/lib/paths";
import { errText } from "@/lib/api-error";
import { redactKlingCliText } from "@/lib/kling/cli-diagnostics";
import { storyboardGridTargetDimensions, withStoryboardGridResolution } from "@/lib/storyboard-grid-resolution";
import { buildKeyframeRefinementPrompt } from "@/lib/keyframe-refinement-prompt";
import { KEYFRAME_REPAIR_ISSUES, type KeyframeRefinementCandidate, type KeyframeRepairIssue } from "@/lib/keyframe-refinement";

export const runtime = "nodejs";

type RouteParams = { params: Promise<{ id: string }> };
type Asset = typeof assets.$inferSelect;
const inFlightSources = new Set<string>();
const STATIC_IMAGE = /\.(?:png|jpe?g|webp|avif|bmp)$/i;

class RefinementError extends Error {
  constructor(readonly code: string, readonly zh: string, readonly en: string, readonly status = 400) { super(zh); }
}

function fail(code: string, zh: string, en: string, status = 400): never { throw new RefinementError(code, zh, en, status); }

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function contextFor(projectId: string, scriptId: string, shotId: number) {
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) fail("PROJECT_NOT_FOUND", "项目不存在", "Project not found", 404);
  const script = resolveCurrentScript(db.select().from(scripts).where(eq(scripts.projectId, projectId)).all());
  if (!script || script.id !== scriptId) fail("SCRIPT_CONTEXT_CHANGED", "当前脚本已切换，请刷新后重新选择关键帧", "The selected script changed. Refresh and choose the keyframe again.", 409);
  const shot = script.shots?.find((item) => item.shotId === shotId);
  if (!shot) fail("SHOT_NOT_FOUND", "当前脚本中没有此分镜", "Shot not found in the current script", 404);
  const check = checkKeyframeRefinementContext(project, script);
  if (!check.ok) fail(check.code, "创作设置或商品事实已变化，请按当前配置重新生成脚本后再精修", "The creative settings or product facts changed. Regenerate the script with the current configuration before refining.", 409);
  const profile = check.scriptProfile;
  if (isTideweOutdoorProfile(profile)) {
    try { assertTideweScript(script, profile.presenter ?? null); }
    catch (error) { fail("TIDEWE_SCRIPT_INVALID", error instanceof Error ? error.message : "TIDEWE 脚本校验失败", "The TIDEWE script does not match its frozen presenter or copy.", 409); }
  }
  return { db, project, script, shot, profile };
}

async function readableStaticPath(asset: Asset, projectId: string): Promise<string | undefined> {
  if (asset.status !== "done" || !asset.filePath?.startsWith(`/api/files/${projectId}/`) || !STATIC_IMAGE.test(asset.filePath)) return;
  const local = resolveUploadFilePath(asset.filePath);
  const projectRoot = join(getDataDir(), "uploads", projectId);
  if (!local?.startsWith(projectRoot + sep) || !(await stat(local).catch(() => null))?.isFile()) return;
  return local;
}

function candidate(asset: Asset): KeyframeRefinementCandidate {
  return { id: asset.id, shotId: asset.shotId, filePath: asset.filePath!, sourceKeyframeUrl: asset.sourceKeyframeUrl,
    derivedFromAssetId: asset.derivedFromAssetId, selected: asset.selected, prompt: asset.prompt, model: asset.model };
}

function errorResponse(req: NextRequest, error: unknown, apiKey?: string, possiblyCharged = false) {
  const generationInfo = { possiblyCharged, ...(error instanceof ProviderError && error.taskId ? { taskId: error.taskId } : {}) };
  if (error instanceof RefinementError) return NextResponse.json({ error: errText(req, error.zh, error.en), code: error.code, ...generationInfo }, { status: error.status });
  if (error instanceof AssetContextConflictError) return NextResponse.json({ error: errText(req, "生成期间脚本或创作设置已改变，未替换当前素材，请刷新后核对服务商任务记录", "The script or creative configuration changed during generation. The current asset was preserved. Refresh and check the provider's task history."), code: error.code, ...generationInfo }, { status: 409 });
  let detail = error instanceof Error ? error.message : String(error);
  if (apiKey) detail = detail.split(apiKey).join("[已脱敏]");
  detail = redactKlingCliText(detail).replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/gi, "[image data]").slice(0, 3000);
  console.error("Keyframe refinement failed:", detail);
  return NextResponse.json({ error: detail || errText(req, "关键帧精修失败", "Keyframe refinement failed"), code: error instanceof ProviderError ? error.code : "KEYFRAME_REFINEMENT_FAILED", ...generationInfo }, { status: error instanceof ProviderError ? 502 : 500 });
}

/** Reopening the dialog restores all usable still candidates, including the original crop. */
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const scriptId = text(req.nextUrl.searchParams.get("scriptId"));
    const shotId = Number(req.nextUrl.searchParams.get("shotId"));
    if (!/^[a-zA-Z0-9-]+$/.test(id) || !scriptId || !Number.isSafeInteger(shotId) || shotId <= 0) fail("INVALID_REQUEST", "缺少有效的项目、脚本或分镜信息", "A valid project, script and shot are required.");
    const { db, script, profile } = contextFor(id, scriptId, shotId);
    const rows = db.select().from(assets).where(and(eq(assets.projectId, id), eq(assets.shotId, shotId))).all()
      .filter((asset) => assetMatchesScript(asset, script))
      .filter((asset) => !isPremiumProductCgProfile(profile) || hasTrustedPremiumCgAssetProvenance(asset, id, script));
    const available = await Promise.all(rows.map(async (asset) => await readableStaticPath(asset, id) ? candidate(asset) : undefined));
    return NextResponse.json({ candidates: available.filter((asset): asset is KeyframeRefinementCandidate => Boolean(asset)) });
  } catch (error) { return errorResponse(req, error); }
}

/** A paid edit always creates an unselected candidate. Adoption uses the normal asset PATCH. */
export async function POST(req: NextRequest, { params }: RouteParams) {
  let lockKey: string | undefined;
  let apiKey: string | undefined;
  let generationStarted = false;
  try {
    const { id } = await params;
    let value: unknown;
    try { value = await req.json(); }
    catch { fail("INVALID_REQUEST", "请求内容不是有效 JSON", "The request body must be valid JSON."); }
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_REQUEST", "请求内容无效", "Invalid request body.");
    const body = value as Record<string, unknown>;
    const scriptId = text(body.scriptId), sourceAssetId = text(body.sourceAssetId);
    const providerName = text(body.provider), model = text(body.model);
    apiKey = text(body.apiKey);
    const baseUrl = text(body.baseUrl);
    const shotId = body.shotId;
    if (!/^[a-zA-Z0-9-]+$/.test(id) || !scriptId || !sourceAssetId || !providerName || !model || !apiKey || typeof shotId !== "number" || !Number.isSafeInteger(shotId) || shotId <= 0) fail("INVALID_REQUEST", "缺少有效的项目、脚本、分镜、源图或生图设置", "A valid project, script, shot, source image and image provider settings are required.");
    if (body.resolution !== "2k" && body.resolution !== "4k") fail("INVALID_RESOLUTION", "请选择 2K 或 4K 精修分辨率", "Choose a 2K or 4K repair resolution.");
    const resolution = body.resolution;
    const allowedIssues = new Set(KEYFRAME_REPAIR_ISSUES.map((issue) => issue.id));
    if (!Array.isArray(body.issues) || !body.issues.every((issue) => typeof issue === "string" && allowedIssues.has(issue as KeyframeRepairIssue))) fail("INVALID_REPAIR_ISSUES", "修复项目无效，请重新选择", "Invalid repair issues. Choose the issues again.");
    const issues = [...new Set(body.issues)] as KeyframeRepairIssue[];
    const instructions = text(body.instructions);
    if ((body.instructions !== undefined && typeof body.instructions !== "string") || (instructions?.length ?? 0) > 2000) fail("INVALID_INSTRUCTIONS", "补充修复说明不能超过 2000 字", "Repair notes must be text no longer than 2000 characters.");
    if (!issues.length && !instructions) fail("REPAIR_REQUEST_REQUIRED", "请选择需要修复的问题或填写修复说明", "Choose a repair issue or describe the defect.");

    const { db, project, script, shot, profile } = contextFor(id, scriptId, shotId);
    const source = db.select().from(assets).where(and(eq(assets.id, sourceAssetId), eq(assets.projectId, id), eq(assets.shotId, shotId))).get();
    if (!source || !assetMatchesScript(source, script)) fail("SOURCE_CONTEXT_MISMATCH", "源图不属于当前脚本的此分镜，请刷新后重新选择", "The source image does not belong to this shot in the current script.", 409);
    const premiumCg = isPremiumProductCgProfile(profile), tidewe = isTideweOutdoorProfile(profile);
    if (premiumCg && !hasTrustedPremiumCgAssetProvenance(source, id, script)) fail("PREMIUM_CG_ASSET_PROVENANCE_REQUIRED", "高端产品 CG 只能精修本项目可信流程生成的关键帧", "Premium product CG can only refine keyframes generated by this project's trusted workflow.", 409);
    if (tidewe && source.type === "stock_footage" && shot.tidewe?.productVisible !== false) fail("TIDEWE_PRODUCT_SOURCE_INVALID", "TIDEWE 产品镜不能使用图库素材作为关键帧", "TIDEWE product shots cannot use stock imagery as their keyframe.", 409);
    if (premiumCg) {
      const policyIssues = lintCreativeProfileShots(profile, [shot]);
      if (profile.narrationMode === "none" && (shot.voiceover?.trim() || shot.narration?.trim())) fail("CREATIVE_POLICY_VIOLATION", "高端产品 CG 脚本包含不允许的旁白，请先修正脚本", "This premium CG script contains narration forbidden by its policy.");
      if (policyIssues.length) fail("CREATIVE_POLICY_VIOLATION", "当前分镜不符合高端产品 CG 创作设置，请先修正脚本", "This shot violates the premium product CG policy.");
    }
    const revision = scriptRevision(script);
    let presenterRef = tidewe && shot.tidewe?.personVisible !== false ? tidewePresenterReference(profile) : undefined;
    if (!tidewe && !premiumCg) {
      // Dialogue cast ids are not necessarily library ids. Prefer the shot's
      // saved character, then the project's saved presenter when no image exists.
      for (const characterId of [...new Set([shot.characterId, project.characterId])]) {
        if (!characterId) continue;
        const character = db.select().from(characters).where(eq(characters.id, characterId)).get();
        presenterRef = character?.referenceImages?.find((reference) => typeof reference === "string" && Boolean(reference.trim()));
        if (presenterRef) break;
      }
    }
    const productRefs = (tidewe && shot.tidewe?.productVisible === false ? [] : project.productImages ?? []).filter((ref) => typeof ref === "string" && ref.trim());
    if ((premiumCg || (tidewe && shot.tidewe?.productVisible !== false)) && !productRefs.length) fail("PRODUCT_REFERENCE_REQUIRED", "此商品镜头需要已保存的商品参考图，请先补充商品图片", "This product shot requires saved product reference images.");
    const referenceInputs = [source.filePath!, ...(presenterRef ? [presenterRef] : []), ...productRefs];
    const editModel = resolveCharacterReferenceModel(providerName, model, referenceInputs.length);
    if (!editModel.ok) fail("KEYFRAME_EDIT_MODEL_UNSUPPORTED", "当前模型不能可靠使用全部参考图精修关键帧。请在设置中选择 GPT Image 或 Seedream 图片编辑模型。", "This model cannot reliably edit the keyframe using all supplied references. Choose a GPT Image or Seedream image-edit model in settings.");
    const requestedLock = `${id}:${sourceAssetId}`;
    if (inFlightSources.has(requestedLock)) fail("KEYFRAME_REFINEMENT_IN_PROGRESS", "此源图正在精修，请等待当前任务完成，避免重复提交", "This image is already being refined. Wait for the current request to finish.", 409);
    inFlightSources.add(requestedLock); lockKey = requestedLock;
    const local = await readableStaticPath(source, id);
    if (!local) fail("SOURCE_IMAGE_UNAVAILABLE", "源图不是可读取的本地静态关键帧，请重新生成或上传图片", "The source is not a readable local still keyframe. Regenerate or upload the image.", 422);
    const sourceDimensions = await probeMedia(local);
    if (sourceDimensions.width <= 0 || sourceDimensions.height <= 0 || sourceDimensions.duration > 0) fail("SOURCE_IMAGE_INVALID", "源图不是有效的静态图片", "The source is not a valid still image.", 422);
    const references = await Promise.all(referenceInputs.map((ref) => toRemoteUsableImage(ref, { requireReadableLocal: true })));
    if (references.some((ref) => !ref)) fail("REFERENCE_IMAGE_UNAVAILABLE", "源图、主播或商品参考图不可读取，请检查图片后重试", "The source, presenter or product reference is unreadable. Check the images before retrying.", 422);
    const referenceImageUrls = references as string[];
    const target = storyboardGridTargetDimensions(sourceDimensions.width, sourceDimensions.height, resolution);
    const options = withStoryboardGridResolution({ width: sourceDimensions.width, height: sourceDimensions.height }, resolution, providerName, editModel.modelId);
    const prompt = buildKeyframeRefinementPrompt({ shot, issues, instructions, profile, hasPresenterReference: Boolean(presenterRef), productReferenceCount: productRefs.length });
    // Recheck ownership and the actual source before submitting a paid request.
    // Configuration revisions and edits within this same script option do not block it.
    const latest = contextFor(id, scriptId, shotId);
    const latestSource = latest.db.select().from(assets).where(eq(assets.id, source.id)).get();
    if (!latestSource || latestSource.status !== "done" || latestSource.filePath !== source.filePath
      || latestSource.projectId !== id || latestSource.shotId !== shotId
      || !assetMatchesScript(latestSource, latest.script)) {
      fail("SCRIPT_CONTEXT_CHANGED", "准备精修期间源图已变化，请刷新后重新选择", "The source image changed while preparing the repair. Refresh and choose it again.", 409);
    }
    const provider = createProvider({ name: providerName, apiKey, baseUrl: baseUrl ?? "" });
    generationStarted = true;
    const result = await provider.generateImage({ ...options, modelId: editModel.modelId, mode: "image-to-image", prompt,
      referenceImageUrl: referenceImageUrls[0], referenceImageUrls,
      ...(premiumCg ? { negativePrompt: PREMIUM_CG_IMAGE_NEGATIVE_PROMPT } : tidewe ? { negativePrompt: TIDEWE_VISUAL_NEGATIVE_PROMPT } : {}) });
    const output = result.imageUrls?.[0];
    if (!output) fail("KEYFRAME_OUTPUT_EMPTY", "生图服务未返回精修图片", "The image provider returned no repaired image.", 502);
    if (!/^(?:https?:\/\/|data:image\/)/i.test(output)) fail("KEYFRAME_OUTPUT_INVALID", "生图服务未返回可保存的新图片", "The image provider did not return a new image that can be saved.", 502);
    const filePath = await persistAssetSource(id, output, shotId, "keyframe-refine");
    const outputPath = resolveUploadFilePath(filePath);
    if (!outputPath || !STATIC_IMAGE.test(filePath)) fail("KEYFRAME_OUTPUT_INVALID", "生图服务返回的不是有效静态图片", "The provider output is not a valid still image.", 502);
    const actual = await probeMedia(outputPath);
    if (actual.width <= 0 || actual.height <= 0 || actual.duration > 0) fail("KEYFRAME_OUTPUT_INVALID", "无法读取精修图片的实际尺寸", "The repaired image dimensions could not be read.", 502);
    const saved = await saveAssetCandidate({ projectId: id, shotId, filePath, provider: providerName, model: editModel.modelId, prompt,
      sourceKeyframeUrl: source.filePath, scope: assetScopeForShot(script, shot, source.id), selectedPolicy: { mode: "alternative" },
      expectedCurrentScript: { scriptId: script.id, scriptRevision: revision, creativeConfigRevision: project.creativeConfigRevision } });
    return NextResponse.json({ asset: candidate(saved), resolution: { requested: resolution, width: actual.width, height: actual.height,
      limited: actual.width + 16 < target.width || actual.height + 16 < target.height } });
  } catch (error) { return errorResponse(req, error, apiKey, generationStarted); }
  finally { if (lockKey) inFlightSources.delete(lockKey); }
}
