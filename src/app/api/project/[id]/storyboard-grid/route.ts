import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, mkdir, stat } from "fs/promises";
import { join } from "path";
import { getDataDir } from "@/lib/paths";
import { getDb } from "@/lib/db";
import { scripts, assets, projects } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { createProvider } from "@/lib/providers";
import { toRemoteUsableImage, resolveUploadFilePath } from "@/lib/remote-image";
import { buildStoryboardGridPrompt, GRID_MAX_SHOTS } from "@/lib/storyboard-grid";
import { readStoryboardGridCells, StoryboardGridLayoutError } from "@/lib/storyboard-grid-crop";
import { ffmpegBin } from "@/lib/ffmpeg-path";
import { probeMedia } from "@/lib/media-probe";
import { apiError, errText } from "@/lib/api-error";
import { normalizeOpenAIBaseUrl } from "@/lib/openai-config";
import { reusableStoryboardGrid, saveStoryboardGridManifest, storyboardGridSignature, STORYBOARD_GRID_CROP_VERSION } from "@/lib/storyboard-grid-cache";
import { filterAssetsForScript, assetScopeForShot, scriptRevision } from "@/lib/asset-context";
import { saveAssetCandidate } from "@/lib/asset-persistence";
import { lintCreativeProfileShots } from "@/lib/creative-policy-lint";
import { checkCreativeProfileContext, isPremiumProductCgProfile } from "@/lib/creative-profiles";
import { filterTrustedPremiumCgAssets } from "@/lib/premium-cg-assets";
import { PREMIUM_CG_IMAGE_NEGATIVE_PROMPT } from "@/lib/premium-cg-prompt";
import {
  normalizeStoryboardGridResolution,
  storyboardGridTargetDimensions,
  withStoryboardGridResolution,
  type StoryboardGridResolutionInfo,
} from "@/lib/storyboard-grid-resolution";

const execFileAsync = promisify(execFile);

/**
 * Premium CG owns the prompt and all visual reference inputs. Providers merge their
 * opaque `extra` object after those fields, so it cannot cross the CG boundary.
 */
function gridGenerationOptions(value: unknown, premiumCg: boolean): Record<string, unknown> {
  const options = value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
  // UI image options carry dimensions, not an aspectRatio field. Keep both the
  // canvas and the layout prompt portrait by default, including direct API calls.
  if (typeof options.width !== "number" || !Number.isSafeInteger(options.width) || options.width <= 0
    || typeof options.height !== "number" || !Number.isSafeInteger(options.height) || options.height <= 0) {
    options.width = 1080;
    options.height = 1920;
  }
  if (!premiumCg) return options;
  for (const key of ["modelId", "mode", "prompt", "referenceImageUrl", "referenceImageUrls", "negativePrompt", "negative_prompt", "extra"]) {
    delete options[key];
  }
  options.negativePrompt = PREMIUM_CG_IMAGE_NEGATIVE_PROMPT;
  return options;
}

function gridAspectRatio(options: Record<string, unknown>): string {
  const width = options.width as number, height = options.height as number;
  let a = width, b = height;
  while (b) [a, b] = [b, a % b];
  return `${width / a}:${height / a}`;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function usableSelectedMedia(asset: typeof assets.$inferSelect): Promise<boolean> {
  // Older grid crops were made at fixed thirds and may include another shot.
  // Do not let preserveExisting bypass the new layout validation for those images.
  if (asset.prompt?.startsWith("[storyboard-grid ") && /-grid\.png$/i.test(asset.filePath ?? "")) return false;
  if (asset.status !== "done" || !asset.filePath || !/\.(png|jpe?g|webp|gif|avif|bmp|mp4|webm|mov|m4v)$/i.test(asset.filePath)) return false;
  const local = resolveUploadFilePath(asset.filePath);
  if (!local || !(await stat(local).catch(() => null))?.isFile()) return false;
  try {
    const media = await probeMedia(local);
    return media.width > 0 && media.height > 0;
  } catch { return false; }
}

/** Download or decode the generated grid image into the project uploads dir; returns the physical path + public path. */
async function persistGridImage(projectId: string, sourceUrl: string): Promise<{ absPath: string; publicPath: string }> {
  const dir = join(getDataDir(), "uploads", projectId);
  await mkdir(dir, { recursive: true });
  let buf: Buffer;
  let ext = "png";
  if (sourceUrl.startsWith("data:")) {
    const comma = sourceUrl.indexOf(",");
    if (comma === -1) throw new Error("无法解析 data URI 图片");
    const meta = sourceUrl.slice(5, comma);
    buf = /;base64/i.test(meta)
      ? Buffer.from(sourceUrl.slice(comma + 1), "base64")
      : Buffer.from(decodeURIComponent(sourceUrl.slice(comma + 1)), "utf-8");
    if (meta.includes("webp")) ext = "webp";
    else if (meta.includes("jpeg") || meta.includes("jpg")) ext = "jpg";
  } else if (/^https?:\/\//.test(sourceUrl)) {
    const resp = await fetch(sourceUrl);
    if (!resp.ok) throw new Error(`下载九宫格图失败: ${resp.status}`);
    buf = Buffer.from(await resp.arrayBuffer());
    const ct = resp.headers.get("content-type") || "";
    if (ct.includes("webp")) ext = "webp";
    else if (ct.includes("jpeg") || ct.includes("jpg")) ext = "jpg";
  } else {
    throw new Error("不支持的图片来源");
  }
  const fileName = `storyboard-grid-${Date.now()}.${ext}`;
  const absPath = join(dir, fileName);
  await writeFile(absPath, buf);
  return { absPath, publicPath: `/api/files/${projectId}/${fileName}` };
}

/**
 * POST /api/project/[id]/storyboard-grid — one-image consistency anchoring.
 *
 * Renders ALL shots of a script as a single 3x3 storyboard grid (same person /
 * outfit / room / light physically guaranteed by being one generation), then
 * crops each cell into that shot's keyframe asset. The existing per-shot i2v
 * pass ("animate") picks the keyframes up from there. Scripts with more than 9
 * shots are rejected honestly instead of silently truncated.
 *
 * body: { scriptId, provider, model, apiKey, baseUrl?, options? }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!/^[a-zA-Z0-9-]+$/.test(id)) {
      return apiError(req, "无效的项目ID", "Invalid project id", 400);
    }
    const body = await req.json();
    if (body.provider === "kling-cli") return NextResponse.json({ error: "Kling CLI 首版仅支持素材页单镜头视频生成", code: "KLING_SCOPE_UNSUPPORTED" }, { status: 400 });
    const { scriptId, provider: providerName, model, apiKey, baseUrl, options, gridResolution, characterSheetUrl, productImageUrl, productImageUrls, reuseExisting, preserveExisting } = body as {
      scriptId?: string;
      provider?: string;
      model?: string;
      apiKey?: string;
      baseUrl?: string;
      options?: Record<string, unknown>;
      /** Whole-grid resolution, independent of single-shot image defaults. */
      gridResolution?: unknown;
      /** Presenter's multi-view sheet — locks the person's identity across all nine cells */
      characterSheetUrl?: string;
      /** Product photo — locks the product's appearance across all nine cells */
      productImageUrl?: string;
      /** All uploaded product views, in display order; replaces the legacy single photo when provided. */
      productImageUrls?: string[];
      /** Reuse an unchanged, complete grid after a film-only failure; never resubmit automatically. */
      reuseExisting?: boolean;
      /** Keep usable selected takes and fill only missing keyframes. */
      preserveExisting?: boolean;
    };
    if (!scriptId) {
      return apiError(req, "缺少 scriptId / provider / model", "Missing scriptId / provider / model", 400);
    }

    const db = getDb();
    const [script] = await db
      .select()
      .from(scripts)
      .where(and(eq(scripts.id, scriptId), eq(scripts.projectId, id)));
    if (!script) return apiError(req, "脚本不存在", "Script not found", 404);
    const shots = Array.isArray(script.shots) ? script.shots : [];
    const [project] = await db.select({
      creativeProfile: projects.creativeProfile,
      videoMode: projects.videoMode,
      creativeConfigRevision: projects.creativeConfigRevision,
      productImages: projects.productImages,
    }).from(projects).where(eq(projects.id, id));
    if (!project) return apiError(req, "项目不存在", "Project not found", 404);
    const profileContext = checkCreativeProfileContext(project, script);
    if (!profileContext.ok) {
      return NextResponse.json({
        error: profileContext.code === "CREATIVE_CONFIG_STALE"
          ? "脚本基于旧的创作设置生成，请重新生成脚本后再生成分镜。"
          : "当前脚本与项目创作类型不匹配，请切换到匹配类型或重新生成脚本。",
        code: profileContext.code,
        projectCreationType: profileContext.projectProfile.creationType,
        scriptCreationType: profileContext.scriptProfile.creationType,
        projectRevision: profileContext.projectRevision,
        scriptRevision: profileContext.scriptRevision,
      }, { status: 409 });
    }
    const creativeProfile = profileContext.projectProfile;
    const premiumCg = isPremiumProductCgProfile(creativeProfile);
    const resolution = normalizeStoryboardGridResolution(gridResolution);
    const baseGenerationOptions = gridGenerationOptions(options, premiumCg);
    const targetDimensions = storyboardGridTargetDimensions(baseGenerationOptions.width as number, baseGenerationOptions.height as number, resolution);
    const generationOptions = withStoryboardGridResolution(baseGenerationOptions, resolution, providerName ?? "", model ?? "");
    const requestedProductImageUrl = nonEmptyString(productImageUrl);
    const requestedProductImageUrls = Array.isArray(productImageUrls)
      ? productImageUrls.map(nonEmptyString).filter((u): u is string => Boolean(u))
      : [];
    // Keep the pre-existing array-over-single selection behavior for actual generation,
    // while validating every supplied field for the stricter premium-CG boundary.
    const requestedProductRefs = Array.isArray(productImageUrls)
      ? requestedProductImageUrls
      : requestedProductImageUrl ? [requestedProductImageUrl] : [];
    const allRequestedProductRefs = [
      ...(requestedProductImageUrl ? [requestedProductImageUrl] : []),
      ...requestedProductImageUrls,
    ];
    const projectProductRefs = Array.isArray(project.productImages)
      ? project.productImages.map(nonEmptyString).filter((u): u is string => Boolean(u))
      : [];
    if (premiumCg) {
      // The profile came from a matching, canonical project/script context above.
      // Do not accept a request-level fallback here: an untrusted output policy
      // could otherwise change how premium CG shots are classified.
      const issues = lintCreativeProfileShots(creativeProfile, shots);
      const narrationMode = creativeProfile && typeof creativeProfile === "object" && !Array.isArray(creativeProfile)
        ? (creativeProfile as { narrationMode?: unknown }).narrationMode
        : undefined;
      if (narrationMode === "none") {
        for (const shot of shots) {
          if (typeof shot.voiceover === "string" && shot.voiceover.trim()) {
            issues.push({ code: "promotional_voiceover", field: "voiceover", shotId: shot.shotId, message: "Premium product CG with narrationMode=none must not contain narration." });
          }
          if (typeof shot.narration === "string" && shot.narration.trim()) {
            issues.push({ code: "promotional_voiceover", field: "narration", shotId: shot.shotId, message: "Premium product CG with narrationMode=none must not contain narration." });
          }
        }
      }
      if (issues.length) {
        return NextResponse.json({ error: "Premium product CG shot policy violation.", code: "CREATIVE_POLICY_VIOLATION", issues }, { status: 400 });
      }
      if (projectProductRefs.length === 0) {
        return NextResponse.json({
          error: "高端产品 CG 九宫格至少需要一张已保存的产品参考图。",
          code: "PREMIUM_CG_PRODUCT_REFERENCE_REQUIRED",
        }, { status: 400 });
      }
      const projectProductRefSet = new Set(projectProductRefs);
      if (allRequestedProductRefs.some((reference) => !projectProductRefSet.has(reference))) {
        return NextResponse.json({
          error: "高端产品 CG 九宫格只能使用本项目已保存的产品参考图。",
          code: "PREMIUM_CG_PRODUCT_REFERENCE_INVALID",
        }, { status: 400 });
      }
    }
    const revision = scriptRevision(script);
    const scopedBaselineAssets = filterAssetsForScript(
      await db.select().from(assets).where(and(eq(assets.projectId, id), eq(assets.selected, true))),
      script,
    );
    const baselineAssets = premiumCg
      ? filterTrustedPremiumCgAssets(scopedBaselineAssets, id, script)
      : scopedBaselineAssets;
    const baselineByShot = new Map(shots.map((shot) => [shot.shotId, baselineAssets.find((asset) => asset.shotId === shot.shotId)?.id ?? null]));
    const preserved = new Map<number, { shotId: number; filePath: string }>();
    if (preserveExisting === true) {
      const usable = await Promise.all(baselineAssets.map(async (asset) => await usableSelectedMedia(asset) ? asset : undefined));
      for (const asset of usable) if (asset?.filePath && shots.some((shot) => shot.shotId === asset.shotId)) preserved.set(asset.shotId, { shotId: asset.shotId, filePath: asset.filePath });
      if (shots.length && preserved.size === shots.length) {
        return NextResponse.json({ gridPath: null, cells: shots.map((shot) => preserved.get(shot.shotId)!), count: shots.length, reused: true, preserved: true, generatedCount: 0 });
      }
    }
    if (!providerName || !model) return apiError(req, "缺少 scriptId / provider / model", "Missing scriptId / provider / model", 400);
    if (!apiKey) return apiError(req, "缺少 API Key，请先在设置中配置生图平台", "Missing API key — configure an image provider in settings first", 400);
    if (shots.length < 2) {
      return apiError(req, "分镜太少，九宫格至少需要 2 个分镜", "Too few shots — the grid needs at least 2", 400);
    }
    if (shots.length > GRID_MAX_SHOTS) {
      return apiError(
        req,
        `九宫格最多放 ${GRID_MAX_SHOTS} 个分镜（当前 ${shots.length} 个）——适合短脚本；长脚本请用逐镜生成+链式首尾帧`,
        `The grid holds at most ${GRID_MAX_SHOTS} shots (this script has ${shots.length}) — use per-shot generation with keyframe chaining for longer scripts`,
        400
      );
    }

    // reference images (order matters — the prompt cites them by position):
    // [character sheet?, ...product photos]; local /api/files paths travel as Base64
    // A CG grid always remains tied to the product identity. Explicit valid refs can
    // narrow the view set; a missing/empty request uses the project's persisted images.
    const productRefs = premiumCg
      ? (requestedProductRefs.length > 0 ? requestedProductRefs : projectProductRefs)
      : requestedProductRefs;
    const sheetRef = nonEmptyString(characterSheetUrl) ?? "";
    const useCharacterSheet = !premiumCg && Boolean(sheetRef);
    const refInputs = [...(useCharacterSheet ? [sheetRef] : []), ...productRefs];
    const convertedReferenceInputs = await Promise.all(refInputs.map(toRemoteUsableImage));
    const referenceImageUrls = convertedReferenceInputs.filter(
      (u): u is string => !!u
    );
    // Providers with one-reference-only image APIs need the product rather than a
    // presenter sheet. Multi-reference providers continue to receive the full ordered set.
    const primaryProductReference = convertedReferenceInputs
      .slice(useCharacterSheet ? 1 : 0)
      .find((u): u is string => Boolean(u));
    const primaryReferenceImageUrl = primaryProductReference ?? referenceImageUrls[0];
    if (premiumCg && !primaryProductReference) {
      return NextResponse.json({
        error: "高端产品 CG 的产品参考图不可用，请重新上传或选择项目中可访问的产品图。",
        code: "PREMIUM_CG_PRODUCT_REFERENCE_UNAVAILABLE",
      }, { status: 400 });
    }

    // 1) one generation renders every shot — consistency is physical, not prompted;
    // with references attached the sheet pins the person and the photo pins the product
    const prompt = buildStoryboardGridPrompt(shots, script.characters, {
      characterSheet: useCharacterSheet,
      productImageCount: productRefs.length,
      aspectRatio: gridAspectRatio(generationOptions),
    }, { creativeProfile });
    const signature = storyboardGridSignature({
      scriptId,
      shots,
      characters: script.characters,
      prompt,
      referenceInputs: refInputs,
      referenceContents: referenceImageUrls,
      provider: providerName,
      model,
      baseUrl: providerName === "openai" ? normalizeOpenAIBaseUrl(baseUrl) : (baseUrl ?? "").trim().replace(/\/+$/, ""),
      options: { ...generationOptions, gridResolution: resolution },
    });
    if (reuseExisting === true) {
      const scopedSelectedAssets = filterAssetsForScript(
        await db.select().from(assets).where(and(eq(assets.projectId, id), eq(assets.selected, true))),
        script,
      );
      const selectedAssets = premiumCg
        ? filterTrustedPremiumCgAssets(scopedSelectedAssets, id, script)
        : scopedSelectedAssets;
      const cached = await reusableStoryboardGrid(id, signature, shots.map((shot) => shot.shotId), selectedAssets);
      if (cached) {
        return NextResponse.json({ gridPath: cached.gridPath, cells: cached.cells, count: cached.cells.length, reused: true,
          ...(cached.resolution && { resolution: cached.resolution }) });
      }
    }
    const provider = createProvider({ name: providerName, apiKey, baseUrl: baseUrl ?? "" });
    const result = await provider.generateImage({
      ...generationOptions,
      modelId: model,
      mode: referenceImageUrls.length > 0 ? "image-to-image" : "text-to-image",
      ...(primaryReferenceImageUrl && { referenceImageUrl: primaryReferenceImageUrl }),
      ...(referenceImageUrls.length > 0 && { referenceImageUrls }),
      prompt,
    });
    const gridUrl = result.imageUrls?.[0];
    if (!gridUrl) throw new Error("生图未返回图片");

    // 2) persist the grid, then crop each cell into that shot's keyframe
    const { absPath, publicPath } = await persistGridImage(id, gridUrl);
    const probe = await probeMedia(absPath);
    if (!probe.width || !probe.height) throw new Error("无法读取九宫格图片尺寸");
    // Validate the entire layout before saving/selecting any shot. Generated
    // gutters regularly drift away from exact thirds, even with an equal-grid prompt.
    const cells = await readStoryboardGridCells(absPath, probe.width, probe.height);
    const usedCells = cells.slice(0, shots.length);
    const resolutionInfo: StoryboardGridResolutionInfo = {
      requested: resolution,
      gridWidth: probe.width,
      gridHeight: probe.height,
      minCellWidth: Math.min(...usedCells.map((cell) => cell.w)),
      minCellHeight: Math.min(...usedCells.map((cell) => cell.h)),
      maxCellWidth: Math.max(...usedCells.map((cell) => cell.w)),
      maxCellHeight: Math.max(...usedCells.map((cell) => cell.h)),
      limited: resolution !== "standard" && (probe.width + 16 < targetDimensions.width || probe.height + 16 < targetDimensions.height),
    };

    const dir = join(getDataDir(), "uploads", id);
    const saved: { shotId: number; filePath: string }[] = [];
    let alternatives = 0;
    for (let i = 0; i < shots.length; i++) {
      if (preserved.has(shots[i].shotId)) continue;
      const cell = cells[i];
      const fileName = `asset-${shots[i].shotId}-${Date.now()}-grid.png`;
      const outPath = join(dir, fileName);
      await execFileAsync(ffmpegBin(), [
        "-v", "error",
        "-y",
        "-i", absPath,
        "-vf", `format=rgb24,crop=${cell.w}:${cell.h}:${cell.x}:${cell.y}:exact=1`,
        "-frames:v", "1",
        outPath,
      ]);
      const filePath = `/api/files/${id}/${fileName}`;
      // Keep older takes for review/rollback while making this fresh grid cell active.
      const asset = await saveAssetCandidate({
        projectId: id,
        shotId: shots[i].shotId,
        type: "ai_generated",
        filePath,
        provider: providerName,
        model,
        prompt: `[storyboard-grid-v${STORYBOARD_GRID_CROP_VERSION} 第${i + 1}格] ${shots[i].description ?? ""}`.trim(),
        scope: assetScopeForShot(script, shots[i]),
        selectedPolicy: premiumCg
          ? { mode: "select" }
          : { mode: "select-if-unchanged", baseline: { scriptId, scriptRevision: revision, selectedAssetId: baselineByShot.get(shots[i].shotId) ?? null } },
      });
      if (!asset.selected) alternatives++;
      saved.push({ shotId: shots[i].shotId, filePath });
    }

    // A film rejection should not make the same confirmed inputs buy another grid.
    // A cache-write failure must not hide already-generated and saved paid assets.
    const currentScripts = await db.select().from(scripts).where(eq(scripts.projectId, id));
    const currentScript = currentScripts.find((item) => item.selected) ?? currentScripts[0];
    const scopedCurrentSelected = currentScript
      ? filterAssetsForScript(await db.select().from(assets).where(and(eq(assets.projectId, id), eq(assets.selected, true))), currentScript)
      : [];
    const currentSelected = premiumCg && currentScript
      ? filterTrustedPremiumCgAssets(scopedCurrentSelected, id, currentScript)
      : scopedCurrentSelected;
    const fullMatchingGrid = saved.length === shots.length && !alternatives && currentScript?.id === scriptId && scriptRevision(currentScript) === revision &&
      saved.every((cell) => currentSelected.filter((asset) => asset.shotId === cell.shotId).length === 1 && currentSelected.some((asset) => asset.shotId === cell.shotId && asset.filePath === cell.filePath && asset.status === "done"));
    if (fullMatchingGrid) await saveStoryboardGridManifest(id, { version: STORYBOARD_GRID_CROP_VERSION, signature, gridPath: publicPath, cells: saved, resolution: resolutionInfo })
      .catch((error) => console.error("保存九宫格复用记录失败:", error));
    const responseCells = preserveExisting === true ? shots.map((shot) => preserved.get(shot.shotId) ?? saved.find((cell) => cell.shotId === shot.shotId)!) : saved;
    return NextResponse.json({ gridPath: publicPath, cells: responseCells, count: responseCells.length, reused: false, resolution: resolutionInfo,
      ...(preserveExisting === true ? { preservedCount: preserved.size, generatedCount: saved.length, savedAsAlternatives: alternatives } : {}) });
  } catch (error) {
    if (error instanceof StoryboardGridLayoutError) {
      return NextResponse.json({ error: error.message, code: "STORYBOARD_GRID_LAYOUT_INVALID" }, { status: 422 });
    }
    console.error("九宫格分镜生成失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : errText(req, "九宫格分镜生成失败", "Storyboard grid failed") },
      { status: 500 }
    );
  }
}
