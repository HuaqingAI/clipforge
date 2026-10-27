import { NextRequest, NextResponse } from "next/server";
import { getDataDir } from "@/lib/paths";
import { readFile } from "fs/promises";
import { join } from "path";
import { generateScript, analyzeProduct, type LLMConfig } from "@/lib/script-engine/generator";
import { scriptGenerationMetadata } from "@/lib/script-engine/provenance";
import { styleNameMap, type ScriptStyleType } from "@/lib/script-engine/prompts";
import { hookPatternName, HOOK_PATTERNS } from "@/lib/script-engine/hook-patterns";
import type { ProductCategory } from "@/lib/script-engine/templates";
import { getDb } from "@/lib/db";
import { scripts as scriptsTable, projects, publishMetrics } from "@/lib/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { apiError, errText } from "@/lib/api-error";
import { llmErrorPair } from "@/lib/llm-error";
import { topConvertingStyle, topConvertingHook, buildPerformanceHint, type MetricInput } from "@/lib/performance-insights";
import {
  createCreativeProfileSnapshot,
  createShortVideoSalesProfile,
  isPremiumProductCgProfile,
  isTideweOutdoorProfile,
  TIDEWE_OUTDOOR_STYLE,
  resolveCreativeProfile,
  validateCreativeProfileInput,
  type ProjectCreativeProfile,
} from "@/lib/creative-profiles";
import { scriptRevision } from "@/lib/asset-context";
import { normalizeProductFacts, productFactsFromDescription } from "@/lib/tidewe/facts";
import { assertTideweScript } from "@/lib/tidewe/validation";
import { analyzeTideweProductImages } from "@/lib/tidewe/image-analysis";

/** Allowed enum values for the styleType column in the scripts table */
const VALID_SCRIPT_STYLE = new Set([
  "pain_point", "scene", "comparison", "story",
  "drama", "reversal", "interview", "unboxing", "product_pov", "talking_head",
  "premium_product_cg", "tidewe_outdoor", "custom",
]);

type RequestLlmConfig = LLMConfig & { provider?: string };

interface ScriptRequestBody {
  projectId?: string;
  productImages?: string[];
  productName?: string;
  productDescription?: string;
  productAnalysis?: string;
  category?: string;
  productCategory?: string;
  styleType?: string;
  videoMode?: string;
  targetDuration?: number;
  duration?: number;
  insightMode?: boolean;
  llmConfig?: RequestLlmConfig;
  creativeProfile?: unknown;
  profile?: unknown;
  creationType?: unknown;
  profileId?: unknown;
  creativeProfileId?: unknown;
  narrationMode?: unknown;
  priceRange?: string;
  platforms?: string;
  usageAdvantage?: string;
  targetAudience?: string;
  referenceStructure?: string;
  customRequirements?: string;
  preferredHookId?: string;
  requestId?: string;
  expectedCreativeConfigRevision?: number;
  sourceScriptId?: string;
  expectedScriptHash?: string;
  copyText?: string;
  count?: number;
}

// Deduplicate simultaneous retries in this process; persisted request IDs cover later retries.
const activeScriptRequests = new Map<string, Promise<NextResponse>>();

/** Convert a local image path to a base64 data URI for use with LLM vision models */
async function imagePathToBase64(imagePath: string): Promise<string> {
  // Already a full URL or base64 data URI, return as-is
  if (imagePath.startsWith("http") || imagePath.startsWith("data:")) {
    return imagePath;
  }

  // Local API path e.g. /api/files/projectId/filename.png
  // Extract the actual file path: data/uploads/projectId/filename.png
  const match = imagePath.match(/\/api\/files\/(.+)/);
  if (!match) return imagePath;

  const relativePath = match[1];
  const filePath = join(getDataDir(), "uploads", relativePath);

  try {
    const buffer = await readFile(filePath);
    const base64 = buffer.toString("base64");
    // Infer MIME type from file extension
    const ext = filePath.split(".").pop()?.toLowerCase() || "png";
    const mimeMap: Record<string, string> = {
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
      webp: "image/webp", gif: "image/gif", svg: "image/svg+xml",
    };
    const mime = mimeMap[ext] || "image/png";
    return `data:${mime};base64,${base64}`;
  } catch {
    console.warn(`无法读取图片文件: ${filePath}`);
    return imagePath;
  }
}

/** Normalize a frontend category value to a ProductCategory supported by the engine */
function normalizeCategory(raw: unknown): ProductCategory {
  const map: Record<string, ProductCategory> = {
    beauty: "beauty",
    food: "food",
    home: "home",
    fashion: "fashion",
    tech: "tech",
    digital: "tech", // frontend uses "digital" for the "Electronics/3C" category
    "3c": "tech",
    other: "beauty", // fallback for uncategorized items
  };
  return map[String(raw ?? "").toLowerCase()] ?? "beauty";
}

/** Normalize a frontend script style value to a ScriptStyleType supported by the engine */
function normalizeStyle(raw: unknown): ScriptStyleType {
  const map: Record<string, ScriptStyleType> = {
    pain_point: "pain_point",
    "pain-point": "pain_point",
    scene: "scene",
    scenario: "scene", // frontend uses "scenario" for the "scene recommendation" style
    comparison: "comparison",
    story: "story",
    // The four commerce-video forms (剧情形/物品形/口播形 additions)
    drama: "drama", // dialogue-driven mini-drama (multi-character conflict)
    reversal: "reversal", // expectation-subverting skit
    interview: "interview", // street-interview (host + interviewee)
    unboxing: "unboxing", // first-person immersive unboxing review
    product_pov: "product_pov", // personified product speaking first-person
    talking_head: "talking_head", // persona-driven direct-to-camera pitch
    custom: "custom",
    auto: "pain_point", // smart-recommend mode defaults to pain-point style
  };
  return map[String(raw ?? "").toLowerCase()] ?? "pain_point";
}

/**
 * Data-flywheel read side: turn the creator's real published-video metrics into a generation hint.
 * Prefers same-category conversion signal, falls back to the global aggregate when a category lacks
 * enough samples, and degrades to an empty hint on cold start or any DB error (never blocks generation).
 * Returns the hint text plus the top-converting style key (used to bias "auto"/smart-recommend mode).
 */
async function loadInsights(category: string): Promise<{ hint: string; topStyle: string | null }> {
  try {
    const db = getDb();
    const rows = await db.select().from(publishMetrics);
    if (rows.length === 0) return { hint: "", topStyle: null };
    const toRec = (r: (typeof rows)[number]): MetricInput => ({
      style: r.style,
      hookId: r.hookId ?? undefined,
      views: r.views,
      likes: r.likes,
      comments: r.comments,
      shares: r.shares,
      orders: r.orders,
    });
    const scoped = rows.filter((r) => r.category === category).map(toRec);
    const all = rows.map(toRec);
    // same-category signal first (topConvertingStyle/Hook require >=2 samples and return null otherwise),
    // then global fallback so a creator with cross-category history still gets a useful prior
    const topStyle = topConvertingStyle(scoped) ?? topConvertingStyle(all);
    const topHook = topConvertingHook(scoped) ?? topConvertingHook(all);
    const hint = buildPerformanceHint(topStyle, topHook, {
      styleLabel: (s) => styleNameMap[s as ScriptStyleType] ?? s,
      hookLabel: hookPatternName,
    });
    return { hint, topStyle: topStyle?.style ?? null };
  } catch (e) {
    // Feedback is best-effort — never let a metrics read failure break script generation
    console.warn("读取历史转化数据失败（已跳过反馈）:", e);
    return { hint: "", topStyle: null };
  }
}

// Generate commerce script
export async function POST(req: NextRequest) {
  let rawBody: unknown;
  try { rawBody = await req.json(); }
  catch { return apiError(req, "请求内容必须是有效的 JSON", "Request body must be valid JSON", 400); }
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return apiError(req, "请求内容必须是对象", "Request body must be a JSON object");
  }
  const body = rawBody as ScriptRequestBody;
  const requestProjectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  const requestKey = requestProjectId && typeof body.requestId === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(body.requestId)
    ? `${requestProjectId}:${body.requestId}` : undefined;
  if (!requestKey) return generateRequestedScripts(req, body);
  const active = activeScriptRequests.get(requestKey);
  if (active) return (await active).clone() as NextResponse;
  const pending = generateRequestedScripts(req, body);
  activeScriptRequests.set(requestKey, pending);
  try { return (await pending).clone() as NextResponse; }
  finally { activeScriptRequests.delete(requestKey); }
}

async function generateRequestedScripts(req: NextRequest, body: ScriptRequestBody): Promise<NextResponse> {
  const {
    productImages: requestedProductImages,
    productName: requestedProductName,
    productDescription: requestedProductDescription,
    llmConfig,
  } = body;
  const projectId = typeof body.projectId === "string" && body.projectId.trim() ? body.projectId.trim() : undefined;

  // A persisted project profile is authoritative. The request fields remain a compatibility path
  // for callers that generate without a project, and for legacy projects whose profile is null.
  let project: typeof projects.$inferSelect | undefined;
  let projectProfile: ProjectCreativeProfile;
  let projectRevision = 0;
  if (projectId) {
    const db = getDb();
    const [row] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!row) return apiError(req, "项目不存在", "Project not found", 404);
    project = row;
    projectRevision = row.creativeConfigRevision ?? 0;
    projectProfile = resolveCreativeProfile(row.creativeProfile, {
      videoMode: row.videoMode,
      styleType: body.styleType,
      targetDuration: body.targetDuration ?? body.duration,
    });
  } else {
    const requestedProfile = body.creativeProfile ?? body.profile ?? (
      body.creationType || body.profileId || body.creativeProfileId
        ? {
            creationType: body.creationType,
            profileId: body.profileId ?? body.creativeProfileId,
            styleType: body.styleType,
            videoMode: body.videoMode,
            targetDuration: body.targetDuration ?? body.duration,
            narrationMode: body.narrationMode,
          }
        : undefined
    );
    if (requestedProfile !== undefined) {
      const checked = validateCreativeProfileInput(requestedProfile);
      const validatedProfile = checked.profile;
      if (!validatedProfile) {
        const message = checked.error ?? "Invalid creative profile.";
        return apiError(req, message, message, 400);
      }
      projectProfile = validatedProfile;
    } else {
      projectProfile = createShortVideoSalesProfile({
        styleType: body.styleType,
        videoMode: body.videoMode,
        targetDuration: body.targetDuration ?? body.duration,
      });
    }
  }

  const premiumProfile = isPremiumProductCgProfile(projectProfile) ? projectProfile : undefined;
  const tideweProfile = isTideweOutdoorProfile(projectProfile) ? projectProfile : undefined;
  let originalSelection: { id: string; hash: string } | undefined;
  let originalSource: { id: string; hash: string } | undefined;
  if (tideweProfile) {
    if (!projectId || !project) return NextResponse.json({ error: "TIDEWE generation requires a saved project.", code: "TIDEWE_PROJECT_REQUIRED" }, { status: 400 });
    if (typeof body.requestId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(body.requestId)) return NextResponse.json({ error: "A valid requestId is required.", code: "TIDEWE_REQUEST_ID_REQUIRED" }, { status: 400 });
    const existing = getDb().select().from(scriptsTable).where(eq(scriptsTable.projectId, projectId)).all();
    const prior = existing.filter((row) => row.generationMetadata?.requestId === body.requestId);
    if (prior.length) {
      const stale = prior.some((row) => row.creativeProfileSnapshot?.creativeConfigRevision !== projectRevision || row.creativeProfileSnapshot?.profile.creationType !== "tidewe_outdoor");
      return NextResponse.json({ scripts: prior.map((row) => ({ ...row, scriptHash: scriptRevision(row) })), requestId: body.requestId,
        ...(stale || !prior.some((row) => row.selected) ? { error: "This request was saved as history; refresh the current script.", code: "CREATIVE_CONFIG_STALE" } : {}),
      }, { status: stale || !prior.some((row) => row.selected) ? 409 : 200 });
    }
    if (!Number.isSafeInteger(body.expectedCreativeConfigRevision) || body.expectedCreativeConfigRevision !== projectRevision) return NextResponse.json({ error: "The project configuration changed. Refresh before generating.", code: "CREATIVE_CONFIG_STALE", creativeConfigRevision: projectRevision }, { status: 409 });
    if (body.styleType !== undefined && body.styleType !== TIDEWE_OUTDOOR_STYLE) return NextResponse.json({ error: "The requested style does not match the project.", code: "CREATIVE_PROFILE_MISMATCH" }, { status: 400 });
    if (body.creativeProfile !== undefined || body.profile !== undefined) {
      const requested = validateCreativeProfileInput(body.creativeProfile ?? body.profile);
      if (!requested.profile || !isTideweOutdoorProfile(requested.profile)) return NextResponse.json({ error: "The requested profile does not match the project.", code: "CREATIVE_PROFILE_MISMATCH" }, { status: 400 });
    }
    if (body.count !== undefined && (!Number.isInteger(body.count) || body.count < 1 || body.count > 3)) return apiError(req, "候选数量只能为1到3", "count must be between 1 and 3", 400);
    if (body.copyText !== undefined && (typeof body.copyText !== "string" || body.copyText.trim().length < 2 || body.copyText.length > 12000)) return apiError(req, "请提供有效的完整英文文案", "Provide complete English copy (2–12000 characters)", 400);
    const selected = existing.find((row) => row.selected);
    originalSelection = selected ? { id: selected.id, hash: scriptRevision(selected) } : undefined;
    if (body.sourceScriptId !== undefined || body.expectedScriptHash !== undefined) {
      const source = existing.find((row) => row.id === body.sourceScriptId);
      if (!source || typeof body.expectedScriptHash !== "string" || scriptRevision(source) !== body.expectedScriptHash) return NextResponse.json({ error: "The source script changed. Refresh before editing.", code: "SCRIPT_CONTEXT_CHANGED" }, { status: 409 });
      originalSource = { id: source.id, hash: body.expectedScriptHash };
    }
  }
  const productImages = (project?.productImages as string[] | undefined) ?? requestedProductImages;
  const productName = project?.productName ?? requestedProductName;
  const productDescription = project?.productDescription ?? requestedProductDescription;
  const effectiveCategory = project?.productCategory ?? body.category ?? body.productCategory;

  // Support both frontend field naming conventions: category/productCategory, targetDuration/duration
  // TIDEWE's original outdoor category travels in facts/categoryHint, never in the legacy beauty fallback.
  const category = tideweProfile ? "fashion" : normalizeCategory(effectiveCategory);
  // detect smart-recommend ("auto"/unset) BEFORE normalizing, so the flywheel can pick a data-driven
  // default instead of the hardcoded pain_point fallback; an explicit style is always respected
  const rawStyle = String(projectProfile.styleType ?? body.styleType ?? "").toLowerCase();
  const isAutoStyle = rawStyle === "" || rawStyle === "auto";
  let styleType = tideweProfile ? TIDEWE_OUTDOOR_STYLE : premiumProfile ? "premium_product_cg" : normalizeStyle(projectProfile.styleType);
  const duration = projectProfile.targetDuration;
  // data flywheel: performance feedback is on by default; pass insightMode:false to opt out
  const useInsights = !premiumProfile && !tideweProfile && body.insightMode !== false;

  if (!productName) {
    return apiError(req, "请填写商品名称", "Please enter the product name");
  }

  if (!llmConfig?.baseUrl || !llmConfig?.apiKey || !llmConfig?.model) {
    return apiError(req, "请配置 LLM 参数（baseUrl、apiKey、model）", "Please configure the LLM parameters (baseUrl, apiKey, model)");
  }

  try {
    // Product image analysis: convert local paths to base64 before passing to the vision model
    let analysis = body.productAnalysis;
    const imageReferences = productImages ?? [];
    if (tideweProfile && imageReferences.length && !analysis) {
      try {
        const imageUrls = await Promise.all(imageReferences.slice(0, 4).map(imagePathToBase64));
        analysis = await analyzeTideweProductImages(llmConfig, imageUrls);
      } catch (error) {
        // Vision is optional and never supplies confirmed facts. A conservative copy can still use the product brief.
        console.warn("TIDEWE image observations unavailable:", error);
      }
    }
    if (!tideweProfile && !analysis && imageReferences.length > 0 && llmConfig) {
      try {
        const imageUrls = await Promise.all(
          imageReferences.map(imagePathToBase64)
        );
        analysis = await analyzeProduct(imageUrls, llmConfig);
      } catch (e) {
        // Image analysis failure should not block script generation
        console.warn("商品图片分析失败（已跳过）:", e);
      }
    }

    // Data flywheel (read side): pull the creator's real conversion feedback for this category.
    // Used two ways: (1) bias smart-recommend ("auto") mode toward the top-converting style,
    // (2) inject an advisory hint into the prompt so generated variants lean toward what sells.
    const insights = useInsights ? await loadInsights(category) : { hint: "", topStyle: null };
    if (useInsights && isAutoStyle && insights.topStyle) {
      styleType = normalizeStyle(insights.topStyle);
    }

    // Generate script (category/styleType/duration already normalized above)
    const scripts = await generateScript({
      productName,
      category,
      // CG accepts any product category; the legacy sales fallback must not relabel it as beauty.
      ...((premiumProfile || tideweProfile) && { productCategoryHint: typeof effectiveCategory === "string" && effectiveCategory.trim() ? effectiveCategory.trim() : "unspecified" }),
      productDescription,
      productAnalysis: analysis,
      styleType,
      targetDuration: duration,
      videoMode: projectProfile.videoMode,
      creativeProfile: projectProfile,
      ...(tideweProfile?.presenter ? { character: {
        id: tideweProfile.presenter.id, name: tideweProfile.presenter.name, appearance: tideweProfile.presenter.appearance,
      } } : {}),
      ...(tideweProfile && {
        productFacts: normalizeProductFacts(project?.productFacts) ?? productFactsFromDescription(productDescription ?? "", typeof effectiveCategory === "string" ? effectiveCategory : undefined),
        ...(body.copyText !== undefined && { copyText: body.copyText }),
        count: body.copyText !== undefined ? 1 : body.count ?? 3,
      }),
      ...(premiumProfile && { narrationMode: premiumProfile.narrationMode }),
      priceRange: body.priceRange,
      platforms: body.platforms,
      usageAdvantage: body.usageAdvantage,
      targetAudience: body.targetAudience,
      referenceStructure: body.referenceStructure,
      // ad-template creative direction (look + per-shot-type camera plan) and any other
      // caller-supplied requirements — buildUserPrompt already injects this field
      customRequirements: typeof body.customRequirements === "string" ? body.customRequirements.slice(0, 2000) : undefined,
      performanceHint: premiumProfile || tideweProfile ? undefined : insights.hint,
      // anti-homogenization: batch rotation pins a different opening hook mechanism per video (validated against the pattern library)
      preferredHookId:
        typeof body.preferredHookId === "string" && HOOK_PATTERNS.some((p) => p.id === body.preferredHookId)
          ? body.preferredHookId
          : undefined,
      llmConfig,
    });
    if (tideweProfile) {
      if (!scripts.length || scripts.length > 3) throw new Error("TIDEWE returned an invalid candidate count.");
      for (const script of scripts) {
        if (!script.copyDocument) throw new Error("TIDEWE generation returned no canonical copy document.");
        assertTideweScript(script, tideweProfile.presenter ?? null);
      }
    }

    // Persist: write generated scripts to the scripts table so the script/assets pages can read them by projectId
    const generationMetadata = { ...scriptGenerationMetadata(
      llmConfig,
      tideweProfile ? "tidewe-outdoor-script" : premiumProfile ? "premium-product-cg-script" : "commerce-script",
    ), ...(tideweProfile && { requestId: body.requestId }) };
    let savedScripts = scripts;
    if (projectId) {
      const db = getDb();
      // Refuse to overwrite a one-liner topic project with a commerce script (contentType mismatch — would delete its topic scripts)
      const proj = await db
        .select({ contentType: projects.contentType })
        .from(projects)
        .where(eq(projects.id, projectId));
      if (proj.length > 0 && proj[0].contentType === "topic") {
        return NextResponse.json(
          { error: errText(req, "该项目是一句话主题项目，请勿用带货脚本覆盖", "This project is a one-sentence topic project — do not overwrite it with a commerce script"), projectId },
          { status: 409 }
        );
      }
      try {
        // Regeneration appends a new revision and keeps prior scripts inspectable. Deselecting and
        // inserting in one transaction prevents a failed write from leaving no active script.
        let creativeConfigChanged = false;
        let replayedDuringSave = false;
        const rows = db.transaction((tx) => {
          const [currentProject] = tx
            .select({ creativeConfigRevision: projects.creativeConfigRevision })
            .from(projects)
            .where(eq(projects.id, projectId))
            .limit(1)
            .all();
          creativeConfigChanged = !currentProject || currentProject.creativeConfigRevision !== projectRevision;
          if (tideweProfile) {
            const currentScripts = tx.select().from(scriptsTable).where(eq(scriptsTable.projectId, projectId)).all();
            // Another worker may have finished this request after our initial read.
            // Recheck while holding the write lock so one request ID saves one batch.
            const prior = currentScripts.filter((row) => row.generationMetadata?.requestId === body.requestId);
            if (prior.length) {
              replayedDuringSave = true;
              creativeConfigChanged ||= prior.some((row) => row.creativeProfileSnapshot?.creativeConfigRevision !== projectRevision || row.creativeProfileSnapshot?.profile.creationType !== "tidewe_outdoor") || !prior.some((row) => row.selected);
              return prior;
            }
            const selected = currentScripts.find((row) => row.selected);
            const selectionUnchanged = originalSelection
              ? selected?.id === originalSelection.id && scriptRevision(selected) === originalSelection.hash
              : !selected;
            const source = originalSource ? currentScripts.find((row) => row.id === originalSource.id) : undefined;
            creativeConfigChanged ||= !selectionUnchanged || Boolean(originalSource && (!source || scriptRevision(source) !== originalSource.hash));
          }
          const [latest] = tx
            .select({ version: scriptsTable.version })
            .from(scriptsTable)
            .where(eq(scriptsTable.projectId, projectId))
            .orderBy(desc(scriptsTable.version))
            .limit(1)
            .all();
          const nextVersion = (latest?.version ?? 0) + 1;
          if (!creativeConfigChanged) {
            tx.update(scriptsTable)
              .set({ selected: false })
              .where(eq(scriptsTable.projectId, projectId))
              .run();
          }
          return tx
          .insert(scriptsTable)
          .values(
            scripts.map((s, i) => ({
              projectId,
              version: nextVersion,
              styleType: (VALID_SCRIPT_STYLE.has(s.styleType) ? s.styleType : "custom") as
                | "pain_point" | "scene" | "comparison" | "story"
                | "drama" | "reversal" | "interview" | "unboxing" | "product_pov" | "talking_head" | "premium_product_cg" | "tidewe_outdoor"
                | "custom",
              title: s.title,
              totalDuration: s.totalDuration,
              shots: s.shots,
              ...(s.copyDocument && { copyDocument: s.copyDocument }),
              generationMetadata,
              creativeProfileSnapshot: createCreativeProfileSnapshot(
                projectProfile,
                projectRevision,
                { styleType, videoMode: projectProfile.videoMode, targetDuration: duration },
              ),
              // dialogue-script cast (drama style) — read back at compose time for multi-voice TTS
              ...(s.characters?.length && { characters: s.characters }),
                // A profile changed while the LLM was working: archive this output under its
                // original snapshot, but never let it replace the current selected script.
                selected: !creativeConfigChanged && i === 0,
            }))
          )
          .returning()
          .all();
        }, { behavior: "immediate" });
        savedScripts = rows.map((r) => ({
          id: r.id,
          version: r.version,
          title: r.title ?? "",
          styleType: r.styleType,
          totalDuration: r.totalDuration ?? 0,
          shots: r.shots ?? [],
          copyDocument: r.copyDocument,
          creativeProfileSnapshot: r.creativeProfileSnapshot,
          scriptHash: scriptRevision(r),
          generationMetadata: r.generationMetadata,
          selected: r.selected ?? false,
        })) as typeof scripts;
        if (creativeConfigChanged) {
          return NextResponse.json({
            error: "The project creative configuration changed while the script was generating. The result was saved as history and was not selected.",
            code: "CREATIVE_CONFIG_STALE",
            requestId: body.requestId,
            scripts: savedScripts,
            analysis,
          }, { status: 409 });
        }
        // Sync project status and analysis result
        if (!replayedDuringSave) await db
          .update(projects)
          .set({ status: "scripting", ...(analysis && { productAnalysis: analysis }), updatedAt: new Date() })
          .where(and(eq(projects.id, projectId), eq(projects.creativeConfigRevision, projectRevision)));
      } catch (e) {
        // DB write failure must surface as an error — returning 200 would let the frontend navigate away thinking it succeeded, then read empty scripts from the DB (which may already have had their old scripts deleted)
        console.error("脚本落库失败:", e);
        return NextResponse.json({ error: errText(req, "脚本落库失败，请重试", "Failed to save scripts to the database, please try again"), projectId }, { status: 500 });
      }
    }

    return NextResponse.json({ scripts: savedScripts, analysis, ...(tideweProfile && { requestId: body.requestId }) });
  } catch (error) {
    if (tideweProfile && error && typeof error === "object" && "code" in error && String(error.code).startsWith("TIDEWE_")) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "TIDEWE script validation failed.", code: error.code, requestId: body.requestId }, { status: "status" in error ? Number(error.status) || 502 : 502 });
    }
    console.error("脚本生成失败:", error);
    // LLM failures carry an actionable bilingual message (bad key / dead free endpoint / rate limit)
    const { zh, en } = llmErrorPair(error);
    return apiError(
      req,
      `脚本生成失败: ${zh}`,
      `Script generation failed: ${en}`,
      500
    );
  }
}
