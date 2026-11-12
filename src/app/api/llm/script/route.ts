import { NextRequest, NextResponse } from "next/server";
import { getDataDir } from "@/lib/paths";
import { readFile } from "fs/promises";
import { join } from "path";
import { generateScript, type LLMConfig } from "@/lib/script-engine/generator";
import { scriptGenerationMetadata } from "@/lib/script-engine/provenance";
import { getDb } from "@/lib/db";
import { scripts as scriptsTable, projects } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";
import { apiError, errText } from "@/lib/api-error";
import { llmErrorPair } from "@/lib/llm-error";
import { createCreativeProfileSnapshot, isTideweOutdoorProfile, TIDEWE_OUTDOOR_STYLE, resolveCreativeProfile, validateCreativeProfileInput, type ResolvedCreativeProfile } from "@/lib/creative-profiles";
import { scriptRevision } from "@/lib/asset-context";
import { generationContextSnapshot, generationContextCheckpoint, generationCheckpoint, beforeGenerationSubmission } from "@/lib/generation-context";
import { projectGenerationSignature } from "@/lib/generation-source-context";
import { normalizeProductFacts, productFactsFromDescription } from "@/lib/tidewe/facts";
import { assertTideweImportedCopy, assertTideweScriptIntegrity, TideweValidationError } from "@/lib/tidewe/validation";
import { analyzeTideweProductImages, isStaleTideweVisualObservations } from "@/lib/tidewe/image-analysis";

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
  llmConfig?: RequestLlmConfig;
  creativeProfile?: unknown;
  profile?: unknown;
  creationType?: unknown;
  profileId?: unknown;
  creativeProfileId?: unknown;
  targetAudience?: string;
  customRequirements?: string;
  requestId?: string;
  expectedCreativeConfigRevision?: number;
  sourceScriptId?: string;
  expectedScriptHash?: string;
  copyText?: string;
  sceneDescription?: string;
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

// Generate a TIDEWE script
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
  const recoveringGenerated = Array.isArray(generationContextCheckpoint()?.generatedScripts);
  const frozenContext = generationContextSnapshot();
  const {
    productImages: requestedProductImages,
    productName: requestedProductName,
    productDescription: requestedProductDescription,
    llmConfig,
  } = body;
  const projectId = typeof body.projectId === "string" && body.projectId.trim() ? body.projectId.trim() : undefined;

  // Persisted identity is authoritative, including an unsupported or absent historical profile.
  let project: typeof projects.$inferSelect | undefined;
  let projectProfile: ResolvedCreativeProfile;
  let projectRevision = 0;
  if (projectId) {
    const db = getDb();
    const [row] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!row) return apiError(req, "项目不存在", "Project not found", 404);
    const frozen = generationContextSnapshot()?.project as typeof row | undefined;
    if (frozen && !recoveringGenerated && (frozen.id !== projectId || projectGenerationSignature(frozen) !== projectGenerationSignature(row))) {
      return NextResponse.json({ error: "项目输入已变化，请重新提交脚本任务。", code: "SCRIPT_CONTEXT_CHANGED" }, { status: 409 });
    }
    project = frozen ?? row;
    projectRevision = project.creativeConfigRevision ?? 0;
    projectProfile = resolveCreativeProfile(project.creativeProfile, {
      videoMode: project.videoMode,
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
      return NextResponse.json({ error: "A TIDEWE creative profile is required.", code: "CREATIVE_PROFILE_REQUIRED" }, { status: 400 });
    }
  }
  if (!isTideweOutdoorProfile(projectProfile)) {
    return NextResponse.json({ error: "This creation workflow is no longer supported. Create a TIDEWE project to continue.", code: "CREATIVE_PROFILE_UNSUPPORTED" }, { status: 400 });
  }
  const tideweProfile = projectProfile;
  let originalSelection: { id: string; hash: string } | undefined;
  let originalSource: { id: string; hash: string } | undefined;
  if (projectId) {
    const existing = getDb().select().from(scriptsTable).where(eq(scriptsTable.projectId, projectId)).all();
    const prior = body.requestId ? existing.filter((row) => row.generationMetadata?.requestId === body.requestId) : [];
    if (prior.length) return NextResponse.json({ scripts: prior.map((row) => ({ ...row, scriptHash: scriptRevision(row) })) });
    const selected = frozenContext ? frozenContext.script as typeof scriptsTable.$inferSelect | undefined : existing.find((row) => row.selected);
    originalSelection = selected ? { id: selected.id, hash: scriptRevision(selected) } : undefined;
    const frozenSource = generationContextSnapshot()?.script as typeof scriptsTable.$inferSelect | undefined;
    const sourceId = body.sourceScriptId ?? frozenSource?.id;
    if (sourceId) {
      const source = recoveringGenerated && frozenSource ? frozenSource : existing.find((row) => row.id === sourceId);
      const expectedHash = body.expectedScriptHash ?? (frozenSource ? scriptRevision(frozenSource) : undefined);
      if (!source || (expectedHash && scriptRevision(source) !== expectedHash)) {
        return NextResponse.json({ error: "源脚本已变化，请重新提交脚本任务。", code: "SCRIPT_CONTEXT_CHANGED" }, { status: 409 });
      }
      originalSource = { id: source.id, hash: scriptRevision(source) };
    }
  }
  if (tideweProfile) {
    if (!projectId || !project) return NextResponse.json({ error: "TIDEWE generation requires a saved project.", code: "TIDEWE_PROJECT_REQUIRED" }, { status: 400 });
    if (typeof body.requestId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(body.requestId)) return NextResponse.json({ error: "A valid requestId is required.", code: "TIDEWE_REQUEST_ID_REQUIRED" }, { status: 400 });
    const existing = getDb().select().from(scriptsTable).where(eq(scriptsTable.projectId, projectId)).all();
    const prior = existing.filter((row) => row.generationMetadata?.requestId === body.requestId);
    if (prior.length) {
      const stale = prior.some((row) => row.creativeProfileSnapshot?.profile.creationType !== "tidewe_outdoor");
      return NextResponse.json({ scripts: prior.map((row) => ({ ...row, scriptHash: scriptRevision(row) })), requestId: body.requestId,
        ...(stale || !prior.some((row) => row.selected) ? { error: "This request was saved as history; refresh the current script.", code: "CREATIVE_CONFIG_STALE" } : {}),
      }, { status: stale || !prior.some((row) => row.selected) ? 409 : 200 });
    }
    if (body.styleType !== undefined && body.styleType !== TIDEWE_OUTDOOR_STYLE) return NextResponse.json({ error: "The requested style does not match the project.", code: "CREATIVE_PROFILE_MISMATCH" }, { status: 400 });
    if (body.creativeProfile !== undefined || body.profile !== undefined) {
      const requested = validateCreativeProfileInput(body.creativeProfile ?? body.profile);
      if (!requested.profile || !isTideweOutdoorProfile(requested.profile)) return NextResponse.json({ error: "The requested profile does not match the project.", code: "CREATIVE_PROFILE_MISMATCH" }, { status: 400 });
    }
    // Accept legacy counts for compatibility; every fresh TIDEWE request generates one copy.
    if (body.count !== undefined && (!Number.isInteger(body.count) || body.count < 1 || body.count > 3)) return apiError(req, "无效的脚本数量参数", "Invalid script count", 400);
    if (body.copyText !== undefined) {
      try { assertTideweImportedCopy(body.copyText); }
      catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : "请输入完整英文口播文案。", code: "TIDEWE_IMPORTED_COPY_INVALID", requestId: body.requestId }, { status: 400 });
      }
    } else if (body.sceneDescription !== undefined && typeof body.sceneDescription !== "string") {
      return NextResponse.json({ error: "请用文字描述想要的场景画面。", code: "TIDEWE_SCENE_DESCRIPTION_INVALID", requestId: body.requestId }, { status: 400 });
    }
    const selected = frozenContext ? frozenContext.script as typeof scriptsTable.$inferSelect | undefined : existing.find((row) => row.selected);
    originalSelection = selected ? { id: selected.id, hash: scriptRevision(selected) } : undefined;
    if (body.sourceScriptId !== undefined || body.expectedScriptHash !== undefined) {
      const source = recoveringGenerated && frozenContext?.script ? frozenContext.script as typeof scriptsTable.$inferSelect : existing.find((row) => row.id === body.sourceScriptId);
      if (!source) return NextResponse.json({ error: "The source script does not belong to this project.", code: "SCRIPT_CONTEXT_CHANGED" }, { status: 409 });
      originalSource = { id: source.id, hash: scriptRevision(source) };
    }
  }
  const productImages = (project?.productImages as string[] | undefined) ?? requestedProductImages;
  const productName = project?.productName ?? requestedProductName;
  const productDescription = project?.productDescription ?? requestedProductDescription;
  const effectiveCategory = project?.productCategory ?? body.category ?? body.productCategory;

  const category = "fashion";
  const styleType = TIDEWE_OUTDOOR_STYLE;
  const duration = tideweProfile.targetDuration;

  if (!productName) {
    return apiError(req, "请填写商品名称", "Please enter the product name");
  }

  if (!llmConfig?.baseUrl || !llmConfig?.apiKey || !llmConfig?.model) {
    return apiError(req, "请配置 LLM 参数（baseUrl、apiKey、model）", "Please configure the LLM parameters (baseUrl, apiKey, model)");
  }

  try {
    // Product image analysis: convert local paths to base64 before passing to the vision model
    const analysisCheckpoint = generationContextCheckpoint();
    const savedAnalysis = analysisCheckpoint?.productAnalysis;
    const analysisComplete = analysisCheckpoint?.analysisComplete === true;
    const recoveringResult = Array.isArray(analysisCheckpoint?.generatedScripts) || Boolean(analysisCheckpoint?.scriptValidationFailure);
    const projectAnalysis = project?.productAnalysis;
    // Older cached summaries omitted detail references or focused on one category. Refresh only a fresh
    // generation's project cache; explicit input and durable attempts keep their own evidence.
    const legacyProjectAnalysis = tideweProfile && typeof savedAnalysis !== "string" && body.productAnalysis === undefined
      && !analysisComplete && !recoveringResult && isStaleTideweVisualObservations(projectAnalysis);
    let analysis = typeof savedAnalysis === "string" ? savedAnalysis : body.productAnalysis ?? (legacyProjectAnalysis ? undefined : projectAnalysis) ?? undefined;
    const imageReferences = productImages ?? [];
    if (tideweProfile && imageReferences.length && !analysis && !analysisComplete && !recoveringResult) {
      try {
        const imageUrls = await Promise.all(imageReferences.map(imagePathToBase64));
        beforeGenerationSubmission();
        analysis = await analyzeTideweProductImages(llmConfig, imageUrls);
      } catch (error) {
        // Vision is optional and never supplies confirmed facts. A conservative copy can still use the product brief.
        console.warn("TIDEWE image observations unavailable:", error);
      }
    }

    generationCheckpoint({ analysisComplete: true, productAnalysis: analysis ?? null, submissionState: "not_submitted" });
    // Generate script (category/styleType/duration already normalized above)
    const savedGenerated = generationContextCheckpoint()?.generatedScripts as Awaited<ReturnType<typeof generateScript>> | undefined;
    if (!savedGenerated) beforeGenerationSubmission();
    const scripts = savedGenerated ?? await generateScript({
      productName,
      category,
      // TIDEWE retains its outdoor category beyond the legacy sales categories.
      ...(tideweProfile && { productCategoryHint: typeof effectiveCategory === "string" && effectiveCategory.trim() ? effectiveCategory.trim() : "unspecified" }),
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
        ...(body.copyText === undefined && body.sceneDescription?.trim() && { sceneDescription: body.sceneDescription.trim() }),
        count: 1,
      }),

      targetAudience: body.targetAudience,
      customRequirements: typeof body.customRequirements === "string" ? body.customRequirements.slice(0, 2000) : undefined,
      llmConfig,
    });
    if (tideweProfile) {
      // Restore previously paid checkpoints without discarding their older three-copy result.
      const maxCopyCount = savedGenerated ? 3 : 1;
      if (!scripts.length || scripts.length > maxCopyCount) throw new TideweValidationError("TIDEWE returned an invalid script count; new generation requires exactly one script.");
      for (const script of scripts) {
        if (!script.copyDocument) throw new TideweValidationError("TIDEWE generation returned no canonical copy document.");
        assertTideweScriptIntegrity(script, tideweProfile.presenter ?? null);
      }
    }
    generationCheckpoint({ generatedScripts: scripts, submissionState: "acknowledged", stage: "saving" });

    // Persist: write generated scripts to the scripts table so the script/assets pages can read them by projectId
    const generationMetadata = { ...scriptGenerationMetadata(
      llmConfig,
      "tidewe-outdoor-script",
    ), ...(body.requestId && { requestId: body.requestId }) };
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
            .select()
            .from(projects)
            .where(eq(projects.id, projectId))
            .limit(1)
            .all();
          creativeConfigChanged = !currentProject || !project || projectGenerationSignature(currentProject) !== projectGenerationSignature(project);
          const allCurrentScripts = tx.select().from(scriptsTable).where(eq(scriptsTable.projectId, projectId)).all();
          const savedByOtherWorker = body.requestId ? allCurrentScripts.filter((row) => row.generationMetadata?.requestId === body.requestId) : [];
          if (savedByOtherWorker.length) {
            replayedDuringSave = true;
            creativeConfigChanged ||= !savedByOtherWorker.some((row) => row.selected);
            return savedByOtherWorker;
          }
          const selectedNow = allCurrentScripts.find((row) => row.selected);
          creativeConfigChanged ||= originalSelection
            ? selectedNow?.id !== originalSelection.id || scriptRevision(selectedNow) !== originalSelection.hash
            : Boolean(selectedNow);
          if (originalSource) {
            const sourceNow = tx.select().from(scriptsTable).where(eq(scriptsTable.id, originalSource.id)).get();
            creativeConfigChanged ||= !sourceNow || scriptRevision(sourceNow) !== originalSource.hash;
          }
          if (tideweProfile) {
            const currentScripts = tx.select().from(scriptsTable).where(eq(scriptsTable.projectId, projectId)).all();
            // Another worker may have finished this request after our initial read.
            // Recheck while holding the write lock so one request ID saves one batch.
            const prior = currentScripts.filter((row) => row.generationMetadata?.requestId === body.requestId);
            if (prior.length) {
              replayedDuringSave = true;
              creativeConfigChanged ||= prior.some((row) => row.creativeProfileSnapshot?.profile.creationType !== "tidewe_outdoor") || !prior.some((row) => row.selected);
              return prior;
            }
            const selected = currentScripts.find((row) => row.selected);
            const selectionUnchanged = originalSelection
              ? selected?.id === originalSelection.id
              : !selected;
            const source = originalSource ? currentScripts.find((row) => row.id === originalSource.id) : undefined;
            creativeConfigChanged ||= !selectionUnchanged || Boolean(originalSource && !source);
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
              styleType: TIDEWE_OUTDOOR_STYLE,
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
            error: "The project or selected script changed while generating. The result was saved as history and was not selected.",
            code: "SCRIPT_CONTEXT_CHANGED",
            requestId: body.requestId,
            scripts: savedScripts,
            analysis,
          }, { status: 409 });
        }
        // Sync project status and analysis result
        if (!replayedDuringSave) await db
          .update(projects)
          .set({ status: "scripting", ...(analysis && { productAnalysis: analysis }), updatedAt: new Date() })
          .where(eq(projects.id, projectId));
      } catch (e) {
        // DB write failure must surface as an error — returning 200 would let the frontend navigate away thinking it succeeded, then read empty scripts from the DB (which may already have had their old scripts deleted)
        console.error("脚本落库失败:", e);
        return NextResponse.json({ error: errText(req, "脚本落库失败，请重试", "Failed to save scripts to the database, please try again"), projectId }, { status: 500 });
      }
    }

    return NextResponse.json({ scripts: savedScripts, analysis, ...(tideweProfile && { requestId: body.requestId }) });
  } catch (error) {
    const checkpoint = generationContextCheckpoint();
    if (tideweProfile && error instanceof TideweValidationError && checkpoint?.submissionState === "submitting"
      && !(Array.isArray(checkpoint.generatedScripts) && checkpoint.generatedScripts.length)) {
      // A completed local validation failure has no script to import. Keep it distinct
      // from a network failure whose paid submission outcome remains unknown.
      generationCheckpoint({ submissionState: "acknowledged", stage: "failed",
        scriptValidationFailure: { code: error.code, message: error.message } });
    }
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
