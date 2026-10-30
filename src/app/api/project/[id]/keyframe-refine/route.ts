import { NextRequest, NextResponse } from "next/server";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { assets, characters, projects, scripts } from "@/lib/db/schema";
import { assetMatchesScript, assetScopeForShot, scriptRevision, type AssetScope } from "@/lib/asset-context";
import { AssetContextConflictError, generationAssetId, persistAssetSource, saveAssetCandidate } from "@/lib/asset-persistence";
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
import { DEFAULT_KEYFRAME_REFINEMENT_RESOLUTION, isKeyframeRefinementResolution, keyframeRefinementProviderOptions, keyframeRefinementTargetDimensions, KEYFRAME_REPAIR_ISSUES, supportsKeyframeFocusMask, type KeyframeFocusRegion, type KeyframeRefinementCandidate, type KeyframeRefinementResolutionInfo, type KeyframeRepairIssue } from "@/lib/keyframe-refinement";
import { fitKeyframeRefinementOutput } from "@/lib/keyframe-refinement-output";
import { buildKeyframeFocusMask, validKeyframeFocusRegion } from "@/lib/keyframe-focus-mask";
import { assertKeyframeFocusPatchPrepared, composeKeyframeFocusPatch, prepareKeyframeFocusPatch, type PreparedKeyframeFocusPatch } from "@/lib/keyframe-focus-patch";
import { beforeGenerationSubmission, generationCheckpoint, generationContextCheckpoint, generationContextItemId, generationContextSnapshot, GenerationTaskPending } from "@/lib/generation-context";

export const runtime = "nodejs";

type RouteParams = { params: Promise<{ id: string }> };
type Asset = typeof assets.$inferSelect;
const inFlightSources = new Set<string>();
const STATIC_IMAGE = /\.(?:png|jpe?g|webp|avif|bmp)$/i;

interface RefinementPlan {
  provider: string;
  model: string;
  prompt: string;
  sourceKeyframeUrl: string;
  scope: AssetScope;
  resolution: KeyframeRefinementResolutionInfo["requested"];
  target: { width: number; height: number };
  outputTarget?: { width: number; height: number };
  focusRegion?: KeyframeFocusRegion;
  maskPath?: string;
  maskHash?: string;
  strategy?: "crop_composite_v1";
  focusPatch?: PreparedKeyframeFocusPatch;
  providerTarget?: { width: number; height: number };
  providerOptions?: Record<string, unknown>;
}

function reusableRefinementPlan(value: unknown): RefinementPlan | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("REFINEMENT_PLAN_INVALID", "已保存的精修计划无效，请核对原任务", "The saved refinement plan is invalid. Check the original task.", 409);
  const plan = value as RefinementPlan;
  if (typeof plan.prompt !== "string" || !plan.prompt.trim() || typeof plan.provider !== "string" || typeof plan.model !== "string"
    || typeof plan.sourceKeyframeUrl !== "string" || !plan.scope || typeof plan.scope !== "object"
    || !["720p", "1080p", "2k", "4k"].includes(plan.resolution) || !Number.isSafeInteger(plan.target?.width) || !Number.isSafeInteger(plan.target?.height)
    || plan.target.width <= 0 || plan.target.height <= 0
    || (plan.outputTarget !== undefined && (!plan.outputTarget || !Number.isSafeInteger(plan.outputTarget.width) || !Number.isSafeInteger(plan.outputTarget.height) || plan.outputTarget.width <= 0 || plan.outputTarget.height <= 0))
    || (plan.strategy !== undefined && plan.strategy !== "crop_composite_v1")
    || (plan.focusRegion !== undefined && (!validKeyframeFocusRegion(plan.focusRegion) || (plan.strategy !== "crop_composite_v1" && (typeof plan.maskPath !== "string" || !/^[a-f0-9]{64}$/.test(plan.maskHash ?? "")))))
    || (plan.strategy === "crop_composite_v1" && (!plan.focusRegion || !plan.focusPatch || !plan.providerTarget || !plan.providerOptions
      || JSON.stringify(plan.focusPatch.region) !== JSON.stringify(plan.focusRegion)
      || plan.target.width !== plan.focusPatch.geometry?.width || plan.target.height !== plan.focusPatch.geometry?.height
      || !Number.isSafeInteger(plan.providerTarget.width) || !Number.isSafeInteger(plan.providerTarget.height) || plan.providerTarget.width <= 0 || plan.providerTarget.height <= 0
      || plan.providerOptions.width !== plan.providerTarget.width || plan.providerOptions.height !== plan.providerTarget.height || plan.providerOptions.count !== 1
      || plan.maskPath !== undefined || plan.maskHash !== undefined))
    || ((plan.maskPath !== undefined || plan.maskHash !== undefined) && plan.focusRegion === undefined)) {
    fail("REFINEMENT_PLAN_INVALID", "已保存的精修计划无效，请核对原任务", "The saved refinement plan is invalid. Check the original task.", 409);
  }
  return plan;
}

const imageUrls = (value: unknown): string[] => Array.isArray(value) ? value.filter((url): url is string => typeof url === "string" && Boolean(url)) : [];

async function checkedFocusPatch(projectId: string, patch: PreparedKeyframeFocusPatch | undefined) {
  const root = join(getDataDir(), "uploads", projectId) + sep;
  if (!patch || typeof patch.sourcePath !== "string" || typeof patch.cropPath !== "string" || !resolve(patch.sourcePath).startsWith(root) || !resolve(patch.cropPath).startsWith(root)) {
    fail("FOCUS_PATCH_UNAVAILABLE", "已保存的区域裁块信息无效，请核对原任务", "The saved region snapshot is invalid. Check the original task.", 422);
  }
  try { await assertKeyframeFocusPatchPrepared(patch); }
  catch { fail("FOCUS_PATCH_UNAVAILABLE", "已保存的区域源图或裁块缺失、变化，请核对原任务", "The saved region source or crop is missing or changed. Check the original task.", 422); }
  return patch;
}

async function composeRefinementPatch(projectId: string, plan: RefinementPlan, patchFilePath: string, outputName: string) {
  const prepared = await checkedFocusPatch(projectId, plan.focusPatch);
  const patchPath = resolveUploadFilePath(patchFilePath);
  if (!patchPath?.startsWith(join(getDataDir(), "uploads", projectId) + sep)) fail("KEYFRAME_OUTPUT_INVALID", "局部结果不是有效本地图片", "The local region output is invalid.", 502);
  const outputPath = join(getDataDir(), "uploads", projectId, outputName);
  await composeKeyframeFocusPatch({ prepared, patchPath, outputPath });
  return `/api/files/${projectId}/${outputName}`;
}

/** Preserve paid legacy plans; new HD results are fitted after native-size composition. */
async function fitRefinementOutput(projectId: string, plan: RefinementPlan, filePath: string) {
  if (!isKeyframeRefinementResolution(plan.resolution)) return filePath;
  const sourcePath = resolveUploadFilePath(filePath);
  if (!sourcePath?.startsWith(join(getDataDir(), "uploads", projectId) + sep) || !STATIC_IMAGE.test(filePath)) fail("KEYFRAME_OUTPUT_INVALID", "精修结果不是有效本地图片", "The repaired output is not a valid local image.", 502);
  const target = plan.outputTarget ?? keyframeRefinementTargetDimensions(plan.target.width, plan.target.height, plan.resolution);
  const outputName = `keyframe-refine-output-${randomUUID()}.png`;
  const fittedPath = await fitKeyframeRefinementOutput({ sourcePath, outputPath: join(getDataDir(), "uploads", projectId, outputName), target });
  return fittedPath === sourcePath ? filePath : `/api/files/${projectId}/${outputName}`;
}

function refinementResolutionInfo(plan: RefinementPlan, actual: { width: number; height: number }, patch?: { width?: number; height?: number }): KeyframeRefinementResolutionInfo {
  const cropComposite = plan.strategy === "crop_composite_v1";
  const target = plan.outputTarget ?? plan.target;
  const preservesSourceDimensions = cropComposite && actual.width === plan.target.width && actual.height === plan.target.height;
  return { requested: plan.resolution, width: actual.width, height: actual.height,
    limited: cropComposite && preservesSourceDimensions ? false : actual.width + 16 < target.width || actual.height + 16 < target.height,
    ...(cropComposite && { processingMode: plan.strategy, preservesSourceDimensions, requestedPatchTarget: plan.providerTarget,
      actualPatchWidth: patch?.width, actualPatchHeight: patch?.height }) };
}

/** Resume imports using only the frozen paid plan, even after its script was edited. */
async function importWorkerRefinements(projectId: string, shotId: number, plan: RefinementPlan) {
  const itemId = generationContextItemId()!;
  const checkpoint = generationContextCheckpoint()!;
  const outputs = [...new Set([...imageUrls(checkpoint.imageUrls), ...imageUrls(checkpoint.resultUrls)])];
  const saved = [];
  const resolutions = [];
  const localPaths = { ...(checkpoint.localPaths as Record<string, string> | undefined) };
  const patchPaths = { ...(checkpoint.patchPaths as Record<string, { filePath: string; hash: string; width: number; height: number }> | undefined) };
  const compositeHashes = { ...(checkpoint.compositeHashes as Record<string, string> | undefined) };
  generationCheckpoint({ stage: "importing" });
  for (const [index, output] of outputs.entries()) {
    if (!/^(?:https?:\/\/|data:image\/)/i.test(output)) fail("KEYFRAME_OUTPUT_INVALID", "生图服务未返回可保存的新图片", "The image provider did not return a new image that can be saved.", 502);
    const idempotencyKey = `${itemId}:${index}`;
    const existing = getDb().select().from(assets).where(eq(assets.id, generationAssetId(projectId, idempotencyKey))).get();
    let filePath = existing?.filePath ?? localPaths[String(index)];
    if (!existing && filePath && plan.strategy === "crop_composite_v1") {
      const cachedPath = resolveUploadFilePath(filePath);
      const cached = cachedPath?.startsWith(join(getDataDir(), "uploads", projectId) + sep) ? await readFile(cachedPath).catch(() => null) : null;
      if (!cached || !compositeHashes[String(index)] || createHash("sha256").update(cached).digest("hex") !== compositeHashes[String(index)]) {
        fail("FOCUS_COMPOSITE_UNAVAILABLE", "已保存的合成图缺失或变化，请核对原任务", "The saved composite is missing or changed. Check the original task.", 422);
      }
    }
    if (!filePath && plan.strategy === "crop_composite_v1") {
      let raw = patchPaths[String(index)];
      if (!raw) {
        const rawFilePath = await persistAssetSource(projectId, output, shotId, "keyframe-focus-patch");
        const rawPath = resolveUploadFilePath(rawFilePath);
        if (!rawPath?.startsWith(join(getDataDir(), "uploads", projectId) + sep)) fail("KEYFRAME_OUTPUT_INVALID", "局部结果保存失败", "The region output could not be saved.", 502);
        const actualPatch = await probeMedia(rawPath);
        if (actualPatch.width <= 0 || actualPatch.height <= 0 || actualPatch.duration > 0) fail("KEYFRAME_OUTPUT_INVALID", "局部结果不是有效静态图片", "The region output is not a valid still image.", 502);
        raw = { filePath: rawFilePath, hash: createHash("sha256").update(await readFile(rawPath)).digest("hex"), width: actualPatch.width, height: actualPatch.height };
        patchPaths[String(index)] = raw;
        generationCheckpoint({ patchPaths }); // Paid raw output is durable before local composition.
      }
      const rawPath = resolveUploadFilePath(raw.filePath);
      const rawBytes = rawPath?.startsWith(join(getDataDir(), "uploads", projectId) + sep) ? await readFile(rawPath).catch(() => null) : null;
      if (!rawBytes || createHash("sha256").update(rawBytes).digest("hex") !== raw.hash) fail("FOCUS_PATCH_OUTPUT_UNAVAILABLE", "已付费的局部结果缺失或变化，请恢复原文件后重试导入", "The paid region output is missing or changed. Restore it before retrying import.", 422);
      filePath = await composeRefinementPatch(projectId, plan, raw.filePath, `keyframe-focus-composite-${itemId}-${index}-${randomUUID()}.png`);
      filePath = await fitRefinementOutput(projectId, plan, filePath);
      compositeHashes[String(index)] = createHash("sha256").update(await readFile(resolveUploadFilePath(filePath)!)).digest("hex");
    }
    if (!filePath) filePath = await fitRefinementOutput(projectId, plan, await persistAssetSource(projectId, output, shotId, "keyframe-refine"));
    localPaths[String(index)] = filePath;
    generationCheckpoint({ localPaths, ...(plan.strategy === "crop_composite_v1" && { compositeHashes }) });
    const outputPath = resolveUploadFilePath(filePath);
    if (!outputPath || !STATIC_IMAGE.test(filePath)) fail("KEYFRAME_OUTPUT_INVALID", "生图服务返回的不是有效静态图片", "The provider output is not a valid still image.", 502);
    const actual = await probeMedia(outputPath);
    if (actual.width <= 0 || actual.height <= 0 || actual.duration > 0) fail("KEYFRAME_OUTPUT_INVALID", "无法读取精修图片的实际尺寸", "The repaired image dimensions could not be read.", 502);
    const asset = existing ?? await saveAssetCandidate({ idempotencyKey, projectId, shotId, filePath, provider: plan.provider, model: plan.model, prompt: plan.prompt,
      sourceKeyframeUrl: plan.sourceKeyframeUrl, scope: plan.scope, selectedPolicy: { mode: "alternative" }, allowHistoricalScope: true });
    saved.push(candidate(asset));
    resolutions.push(refinementResolutionInfo(plan, actual, patchPaths[String(index)]));
  }
  if (!saved.length) fail("KEYFRAME_OUTPUT_EMPTY", "生图服务未返回精修图片", "The image provider returned no repaired image.", 502);
  return { asset: saved[0], assets: saved, assetId: saved[0].id, assetIds: saved.map((asset) => asset.id),
    imageUrls: saved.map((asset) => asset.filePath), resolution: resolutions[0] };
}

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
  const rejectedStatus = generationContextItemId() && error instanceof ProviderError && error.submissionRejected ? error.statusCode : undefined;
  return NextResponse.json({ error: detail || errText(req, "关键帧精修失败", "Keyframe refinement failed"), code: error instanceof ProviderError ? error.code : "KEYFRAME_REFINEMENT_FAILED", ...generationInfo }, { status: rejectedStatus ?? (error instanceof ProviderError ? 502 : 500) });
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
    const allowedIssues = new Set(KEYFRAME_REPAIR_ISSUES.map((issue) => issue.id));
    if (!Array.isArray(body.issues) || !body.issues.every((issue) => typeof issue === "string" && allowedIssues.has(issue as KeyframeRepairIssue))) fail("INVALID_REPAIR_ISSUES", "修复项目无效，请重新选择", "Invalid repair issues. Choose the issues again.");
    const issues = [...new Set(body.issues)] as KeyframeRepairIssue[];
    const focusRegion = body.focusRegion;
    if (focusRegion !== undefined && !validKeyframeFocusRegion(focusRegion)) fail("INVALID_FOCUS_REGION", "区域重绘只接受有效的 x、y、width、height 归一化矩形", "Focus region must contain only valid normalized x, y, width and height values.");
    if (focusRegion !== undefined && (body.issues.length !== 1 || issues[0] !== "integration")) fail("FOCUS_REGION_REQUIRES_INTEGRATION", "区域重绘只能单独用于人物环境融合与景深修复", "Region repaint requires only the integration repair issue.");
    const instructions = text(body.instructions);
    if ((body.instructions !== undefined && typeof body.instructions !== "string") || (instructions?.length ?? 0) > 2000) fail("INVALID_INSTRUCTIONS", "补充修复说明不能超过 2000 字", "Repair notes must be text no longer than 2000 characters.");
    if (!issues.length && !instructions) fail("REPAIR_REQUEST_REQUIRED", "请选择需要修复的问题或填写修复说明", "Choose a repair issue or describe the defect.");

    const workerId = generationContextItemId();
    const checkpoint = generationContextCheckpoint();
    if (workerId && checkpoint?.refinementPlan && (imageUrls(checkpoint.imageUrls).length || imageUrls(checkpoint.resultUrls).length)) {
      generationStarted = true;
      return NextResponse.json(await importWorkerRefinements(id, shotId, reusableRefinementPlan(checkpoint.refinementPlan)!));
    }
    if (focusRegion !== undefined && !supportsKeyframeFocusMask(providerName, model)) fail("FOCUS_MASK_UNSUPPORTED", "此模型不支持区域蒙版重绘，请选择支持的 GPT Image 模型或关闭区域重绘", "This model does not support region masks. Choose a supported GPT Image model or disable region repaint.");
    const frozenPlan = workerId ? reusableRefinementPlan(checkpoint?.refinementPlan) : undefined;
    const requestedResolution = body.resolution === undefined ? frozenPlan?.resolution ?? DEFAULT_KEYFRAME_REFINEMENT_RESOLUTION : body.resolution;
    if (!isKeyframeRefinementResolution(requestedResolution) && !(frozenPlan && requestedResolution === frozenPlan.resolution)) fail("INVALID_RESOLUTION", "精修分辨率默认 720p，最高支持 1080p", "Repair resolution defaults to 720p and supports up to 1080p.");
    const resolution = requestedResolution as RefinementPlan["resolution"];
    const cropComposite = focusRegion !== undefined && (!frozenPlan || frozenPlan.strategy === "crop_composite_v1");
    const live = contextFor(id, scriptId, shotId);
    const snapshot = generationContextSnapshot();
    if (workerId && (!snapshot?.project || !snapshot.script || !snapshot.refinement?.source)) fail("GENERATION_SNAPSHOT_INVALID", "后台精修缺少已确认的源图信息", "The confirmed refinement snapshot is missing.", 409);
    const { db } = live;
    const project = workerId ? snapshot!.project as unknown as typeof live.project : live.project;
    const script = workerId ? snapshot!.script as unknown as typeof live.script : live.script;
    const shot = script.shots?.find((item) => item.shotId === shotId);
    if (!shot) fail("SHOT_NOT_FOUND", "已确认脚本中没有此分镜", "Shot not found in the confirmed script", 409);
    const profileCheck = checkKeyframeRefinementContext(project, script);
    if (!profileCheck.ok) fail(profileCheck.code, "已确认的精修上下文无效", "The confirmed refinement context is invalid.", 409);
    const profile = profileCheck.scriptProfile;
    const source = workerId ? snapshot!.refinement!.source as unknown as Asset : db.select().from(assets).where(and(eq(assets.id, sourceAssetId), eq(assets.projectId, id), eq(assets.shotId, shotId))).get();
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
    let presenterRef = workerId ? snapshot!.refinement!.presenterReference : tidewe && shot.tidewe?.personVisible !== false ? tidewePresenterReference(profile) : undefined;
    if (!workerId && !tidewe && !premiumCg) {
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
    const editModel = resolveCharacterReferenceModel(providerName, model, cropComposite ? 1 : referenceInputs.length);
    if (!editModel.ok) fail("KEYFRAME_EDIT_MODEL_UNSUPPORTED", "当前模型不能可靠使用全部参考图精修关键帧。请在设置中选择 GPT Image 或 Seedream 图片编辑模型。", "This model cannot reliably edit the keyframe using all supplied references. Choose a GPT Image or Seedream image-edit model in settings.");
    const requestedLock = `${id}:${sourceAssetId}`;
    if (inFlightSources.has(requestedLock)) fail("KEYFRAME_REFINEMENT_IN_PROGRESS", "此源图正在精修，请等待当前任务完成，避免重复提交", "This image is already being refined. Wait for the current request to finish.", 409);
    inFlightSources.add(requestedLock); lockKey = requestedLock;
    const local = await readableStaticPath(source, id);
    if (!local) fail("SOURCE_IMAGE_UNAVAILABLE", "源图不是可读取的本地静态关键帧，请重新生成或上传图片", "The source is not a readable local still keyframe. Regenerate or upload the image.", 422);
    const sourceDimensions = await probeMedia(local);
    if (sourceDimensions.width <= 0 || sourceDimensions.height <= 0 || sourceDimensions.duration > 0) fail("SOURCE_IMAGE_INVALID", "源图不是有效的静态图片", "The source is not a valid still image.", 422);
    if (focusRegion !== undefined && (!/\.png$/i.test(source.filePath!) || sourceDimensions.videoCodec !== "png")) fail("FOCUS_MASK_PNG_REQUIRED", "区域重绘首版需要 PNG 源关键帧，请先上传或生成 PNG 图片", "Region repaint currently requires a PNG source keyframe. Upload or generate a PNG image first.", 422);
    let focusPatch = frozenPlan?.focusPatch;
    if (cropComposite) {
      if (focusPatch) await checkedFocusPatch(id, focusPatch);
      else {
        const token = randomUUID();
        focusPatch = await prepareKeyframeFocusPatch({ sourcePath: local, region: focusRegion!,
          sourceCopyPath: join(getDataDir(), "uploads", id, `keyframe-focus-source-${token}.png`),
          cropPath: join(getDataDir(), "uploads", id, `keyframe-focus-crop-${token}.png`) });
      }
    }
    const cropUrl = focusPatch ? `/api/files/${id}/${focusPatch.cropPath.split(sep).at(-1)}` : undefined;
    const references = await Promise.all((cropComposite ? [cropUrl!] : referenceInputs).map((ref) => toRemoteUsableImage(ref, { requireReadableLocal: true })));
    if (references.some((ref) => !ref)) fail("REFERENCE_IMAGE_UNAVAILABLE", "源图、主播或商品参考图不可读取，请检查图片后重试", "The source, presenter or product reference is unreadable. Check the images before retrying.", 422);
    const referenceImageUrls = references as string[];
    const hdResolution = isKeyframeRefinementResolution(resolution) ? resolution : undefined;
    const dimensions = (width: number, height: number) => hdResolution ? keyframeRefinementTargetDimensions(width, height, hdResolution) : storyboardGridTargetDimensions(width, height, resolution as "2k" | "4k");
    const providerOptions = (width: number, height: number) => hdResolution ? keyframeRefinementProviderOptions(width, height, hdResolution, providerName, editModel.modelId)
      : withStoryboardGridResolution({ width, height }, resolution as "2k" | "4k", providerName, editModel.modelId);
    const target = frozenPlan?.target ?? (cropComposite ? { width: focusPatch!.geometry.width, height: focusPatch!.geometry.height } : dimensions(sourceDimensions.width, sourceDimensions.height));
    const outputTarget = frozenPlan?.outputTarget ?? (hdResolution ? dimensions(target.width, target.height) : undefined);
    const providerTarget = frozenPlan?.providerTarget ?? (cropComposite ? dimensions(focusPatch!.geometry.context.width, focusPatch!.geometry.context.height) : target);
    const options = frozenPlan?.providerOptions ?? (cropComposite ? { ...providerOptions(focusPatch!.geometry.context.width, focusPatch!.geometry.context.height), quality: /gpt-image-2\.5-(?:sunburst|flare)(?:-|$)/.test(editModel.modelId) ? "xhigh" : "high", outputFormat: "png" }
      : providerOptions(target.width, target.height));
    if (frozenPlan && (frozenPlan.provider !== providerName || frozenPlan.model !== editModel.modelId || frozenPlan.resolution !== resolution
      || frozenPlan.sourceKeyframeUrl !== source.filePath || JSON.stringify(frozenPlan.focusRegion) !== JSON.stringify(focusRegion)
      || JSON.stringify(frozenPlan.scope) !== JSON.stringify(assetScopeForShot(script, shot, source.id)))) {
      fail("REFINEMENT_PLAN_CHANGED", "已保存精修计划与本次请求不一致，请核对原任务", "The saved refinement plan does not match this request. Check the original task.", 409);
    }
    let maskPath = frozenPlan?.maskPath;
    let maskHash = frozenPlan?.maskHash;
    let maskImageUrl: string | undefined;
    if (focusRegion !== undefined && !cropComposite) {
      let maskBytes: Buffer;
      if (frozenPlan) {
        const maskLocal = maskPath?.startsWith(`/api/files/${id}/`) ? resolveUploadFilePath(maskPath) : null;
        const savedMask = maskLocal?.startsWith(join(getDataDir(), "uploads", id) + sep) ? await readFile(maskLocal).catch(() => null) : null;
        if (!savedMask || createHash("sha256").update(savedMask).digest("hex") !== maskHash) fail("FOCUS_MASK_UNAVAILABLE", "已保存的区域蒙版缺失或变化，请核对原任务", "The saved region mask is missing or changed. Check the original task.", 422);
        maskBytes = savedMask;
      } else {
        maskBytes = buildKeyframeFocusMask(sourceDimensions.width, sourceDimensions.height, focusRegion);
        const name = `keyframe-focus-${randomUUID()}.png`;
        await writeFile(join(getDataDir(), "uploads", id, name), maskBytes);
        maskPath = `/api/files/${id}/${name}`;
        maskHash = createHash("sha256").update(maskBytes).digest("hex");
      }
      maskImageUrl = `data:image/png;base64,${maskBytes.toString("base64")}`;
    }
    const prompt = frozenPlan?.prompt ?? buildKeyframeRefinementPrompt({ shot, issues, instructions, profile,
      productCategory: tidewe ? script.copyDocument?.factsSnapshot.category : undefined,
      productName: tidewe ? script.copyDocument?.productName ?? project.productName ?? undefined : undefined,
      hasPresenterReference: !cropComposite && Boolean(presenterRef), productReferenceCount: cropComposite ? 0 : productRefs.length,
      ...(focusRegion && { focusRegion }), ...(cropComposite && { focusPatch: focusPatch!.geometry }) });
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
    const plan: RefinementPlan = frozenPlan ?? { provider: providerName, model: editModel.modelId, prompt, sourceKeyframeUrl: source.filePath!,
      scope: assetScopeForShot(script, shot, source.id), resolution, target: { width: target.width, height: target.height }, ...(outputTarget && { outputTarget }), providerOptions: options,
      ...(focusRegion && { focusRegion }), ...(cropComposite ? { strategy: "crop_composite_v1", focusPatch, providerTarget } : focusRegion ? { maskPath, maskHash } : {}) };
    generationCheckpoint({ refinementPlan: plan, submissionState: "not_submitted" });
    beforeGenerationSubmission();
    generationStarted = true;
    const result = await provider.generateImage({ ...options, modelId: editModel.modelId, mode: "image-to-image", prompt,
      referenceImageUrl: referenceImageUrls[0], referenceImageUrls,
      ...(maskImageUrl && { maskImageUrl }),
      ...(!cropComposite && (premiumCg ? { negativePrompt: PREMIUM_CG_IMAGE_NEGATIVE_PROMPT } : tidewe ? { negativePrompt: TIDEWE_VISUAL_NEGATIVE_PROMPT } : {})) });
    if (workerId) {
      generationCheckpoint({ ...(result.taskId && { taskId: result.taskId }), imageUrls: result.imageUrls, resultUrls: result.imageUrls,
        modelId: editModel.modelId, submissionState: "acknowledged", stage: "importing" });
      return NextResponse.json(await importWorkerRefinements(id, shotId, plan));
    }
    const output = result.imageUrls?.[0];
    if (!output) fail("KEYFRAME_OUTPUT_EMPTY", "生图服务未返回精修图片", "The image provider returned no repaired image.", 502);
    if (!/^(?:https?:\/\/|data:image\/)/i.test(output)) fail("KEYFRAME_OUTPUT_INVALID", "生图服务未返回可保存的新图片", "The image provider did not return a new image that can be saved.", 502);
    const rawFilePath = await persistAssetSource(id, output, shotId, cropComposite ? "keyframe-focus-patch" : "keyframe-refine");
    const rawPath = resolveUploadFilePath(rawFilePath);
    const rawDimensions = rawPath ? await probeMedia(rawPath) : undefined;
    const filePath = await fitRefinementOutput(id, plan, cropComposite ? await composeRefinementPatch(id, plan, rawFilePath, `keyframe-focus-composite-${randomUUID()}.png`) : rawFilePath);
    const outputPath = resolveUploadFilePath(filePath);
    if (!outputPath || !STATIC_IMAGE.test(filePath)) fail("KEYFRAME_OUTPUT_INVALID", "生图服务返回的不是有效静态图片", "The provider output is not a valid still image.", 502);
    const actual = await probeMedia(outputPath);
    if (actual.width <= 0 || actual.height <= 0 || actual.duration > 0) fail("KEYFRAME_OUTPUT_INVALID", "无法读取精修图片的实际尺寸", "The repaired image dimensions could not be read.", 502);
    const saved = await saveAssetCandidate({ projectId: id, shotId, filePath, provider: providerName, model: editModel.modelId, prompt,
      sourceKeyframeUrl: source.filePath, scope: assetScopeForShot(script, shot, source.id), selectedPolicy: { mode: "alternative" },
      expectedCurrentScript: { scriptId: script.id, scriptRevision: revision, creativeConfigRevision: project.creativeConfigRevision } });
    return NextResponse.json({ asset: candidate(saved), resolution: refinementResolutionInfo(plan, actual, rawDimensions) });
  } catch (error) {
    if (generationContextItemId()) {
      if (error instanceof GenerationTaskPending) return NextResponse.json({ pending: true, taskId: error.taskId, stage: "cloud_running" }, { status: 202 });
      if (error instanceof ProviderError && error.taskId) generationCheckpoint({ taskId: error.taskId, submissionState: "acknowledged" });
      else if (error instanceof ProviderError && error.submissionRejected) generationCheckpoint({ submissionState: "not_submitted", stage: "rejected" });
    }
    return errorResponse(req, error, apiKey, generationStarted);
  }
  finally { if (lockKey) inFlightSources.delete(lockKey); }
}
