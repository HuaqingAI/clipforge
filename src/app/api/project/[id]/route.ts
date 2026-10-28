import { NextRequest, NextResponse } from "next/server";
import { listKlingJobs, isKlingJobUnresolved } from "@/lib/kling/repository";
import { listKlingFilms, isKlingFilmUnresolved } from "@/lib/kling/film-repository";
import { rm } from "fs/promises";
import { join } from "path";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { getUploadsDir, getOutputDir } from "@/lib/paths";
import { and, eq } from "drizzle-orm";
import { apiError, errText } from "@/lib/api-error";
import {
  createPremiumProductCgProfile,
  createShortVideoSalesProfile,
  createTideweOutdoorProfile,
  isTideweOutdoorProfile,
  resolveCreativeProfile,
  sanitizeCreativeProfileDrafts,
  validateCreativeProfileInput,
  type CreativeProfileFallback,
  type ProjectCreativeProfile,
  type ProjectCreativeProfileDrafts,
} from "@/lib/creative-profiles";
import { normalizeProductFacts } from "@/lib/tidewe/facts";
import { generationItems } from "@/lib/generation-schema";
import { inArray } from "drizzle-orm";

// Project ids are UUIDs; validate before using one in a filesystem path (guards the rm below against traversal)
const SAFE_ID = /^[a-zA-Z0-9-]+$/;

// Allowlist of fields that may be updated via PATCH (id/createdAt etc. are blocked to prevent field injection / primary-key corruption)
const PATCHABLE_FIELDS = [
  "name",
  "productName",
  "productCategory",
  "productDescription",
  "productImages",
  "productAnalysis",
  "shopUrl",
  "affiliateCode",
  "productId",
  "brandId",
  "templateId",
  "videoMode",
  "sourceType",
  "sourceVideoUrl",
  "characterId",
  "status",
] as const;

// Valid enum values for the status field (SQLite does not enforce enums, so we validate manually)
const VALID_STATUS = new Set([
  "draft",
  "scripting",
  "assets",
  "video",
  "composing",
  "done",
]);

const VALID_VIDEO_MODES = new Set([
  "product_closeup",
  "graphic_montage",
  "scene_demo",
  "live_presenter",
]);

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function creativeFallback(value: {
  videoMode?: unknown;
  creativeSettings?: unknown;
  templateId?: unknown;
} | JsonRecord): CreativeProfileFallback {
  return {
    videoMode: value.videoMode,
    creativeSettings: value.creativeSettings,
    recipeSnapshot: value.templateId ? { templateId: value.templateId } : undefined,
  };
}

function requestedCreativeProfile(value: JsonRecord): unknown | undefined {
  if (hasOwn(value, "creativeProfile")) return value.creativeProfile;
  if (hasOwn(value, "profile")) return value.profile;
  if (!hasOwn(value, "creationType") && !hasOwn(value, "profileId") && !hasOwn(value, "creativeProfileId")) {
    return undefined;
  }
  const profile: JsonRecord = {};
  for (const key of [
    "creationType", "profileId", "creativeProfileId", "styleType", "videoMode", "targetDuration",
    "duration", "narrationMode", "soundMode", "textPolicy", "visualDirection", "brandEndCard",
    "composeSnapshot", "compose", "creativeSettings", "recipeSnapshot",
    "narrativeAngle", "language", "reviewLanguage", "market", "platform", "speechMode", "presenter",
  ]) {
    if (hasOwn(value, key)) profile[key] = value[key];
  }
  if (profile.targetDuration === undefined && profile.duration !== undefined) profile.targetDuration = profile.duration;
  if (profile.composeSnapshot === undefined && profile.compose !== undefined) profile.composeSnapshot = profile.compose;
  return profile;
}

function hasProfileSettings(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return [
    "styleType", "videoMode", "targetDuration", "duration", "narrationMode", "soundMode",
    "textPolicy", "visualDirection", "brandEndCard", "composeSnapshot", "compose",
    "creativeSettings", "recipeSnapshot",
    "narrativeAngle", "language", "reviewLanguage", "market", "platform", "speechMode", "presenter",
  ].some((key) => hasOwn(value, key));
}

function mergeCreativeProfileDrafts(
  profile: ProjectCreativeProfile,
  existing: unknown,
  incoming: unknown,
  fallback: CreativeProfileFallback,
): ProjectCreativeProfileDrafts {
  const drafts: ProjectCreativeProfileDrafts = {
    ...(sanitizeCreativeProfileDrafts(existing) ?? {}),
    ...(sanitizeCreativeProfileDrafts(incoming) ?? {}),
  };
  if (!drafts.short_video_sales) drafts.short_video_sales = createShortVideoSalesProfile(fallback);
  if (!drafts.premium_product_cg) drafts.premium_product_cg = createPremiumProductCgProfile();
  if (!drafts.tidewe_outdoor) drafts.tidewe_outdoor = createTideweOutdoorProfile();
  if (profile.creationType === "premium_product_cg") drafts.premium_product_cg = profile;
  else if (profile.creationType === "tidewe_outdoor") drafts.tidewe_outdoor = profile;
  else drafts.short_video_sales = profile;
  return drafts;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// Fetch a single project
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    const result = await db.select().from(projects).where(eq(projects.id, id));

    if (result.length === 0) {
      return apiError(req, "项目不存在", "Project not found", 404);
    }

    return NextResponse.json(result[0]);
  } catch (error) {
    console.error("Failed to fetch project:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : errText(req, "获取项目失败", "Failed to fetch project") },
      { status: 500 }
    );
  }
}

// Update a project
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const parsedBody: unknown = await req.json();
    if (!isRecord(parsedBody)) {
      return NextResponse.json({ error: "Project payload must be a JSON object." }, { status: 400 });
    }
    const body = parsedBody;
    const db = getDb();
    const profileInput = requestedCreativeProfile(body);
    const hasDraftUpdate = hasOwn(body, "creativeProfileDrafts");
    const hasFactsUpdate = hasOwn(body, "productFacts");
    const productContextFields = ["productName", "productCategory", "productDescription", "productImages", "productId", "brandId"] as const;
    const hasProductUpdate = productContextFields.some((field) => hasOwn(body, field));
    const hasCharacterUpdate = hasOwn(body, "characterId");
    const hasContextUpdate = hasProductUpdate || hasCharacterUpdate;
    const [contextProject] = hasContextUpdate
      ? await db.select().from(projects).where(eq(projects.id, id)).limit(1)
      : [];
    const hasTideweContextUpdate = Boolean(contextProject && isTideweOutdoorProfile(contextProject.creativeProfile));
    const hasTideweProductUpdate = hasProductUpdate && hasTideweContextUpdate;
    const hasCreativeConfigUpdate = profileInput !== undefined || hasDraftUpdate || hasFactsUpdate || hasTideweContextUpdate;

    // Only pick allowlisted fields; discard dangerous fields such as id/createdAt
    const updates: Record<string, unknown> = {};
    for (const field of PATCHABLE_FIELDS) {
      if (hasOwn(body, field) && !(hasCreativeConfigUpdate && field === "videoMode")) {
        updates[field] = body[field];
      }
    }
    if (hasFactsUpdate) {
      let facts: ReturnType<typeof normalizeProductFacts> | null;
      try { facts = body.productFacts === null ? null : normalizeProductFacts(body.productFacts); }
      catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid product facts", code: "TIDEWE_FACTS_INVALID" }, { status: 400 }); }
      if (facts === undefined) return NextResponse.json({ error: "Invalid productFacts.", code: "TIDEWE_FACTS_INVALID" }, { status: 400 });
      updates.productFacts = facts;
    }

    // Validate that the status value is a legal enum member
    if ("status" in updates && !VALID_STATUS.has(String(updates.status))) {
      return apiError(req, "非法的项目状态值", "Invalid project status value", 400);
    }

    if ("videoMode" in updates && !VALID_VIDEO_MODES.has(String(updates.videoMode))) {
      return NextResponse.json({ error: "Invalid videoMode value." }, { status: 400 });
    }

    if (hasCreativeConfigUpdate) {
      const expectedRevision = body.expectedCreativeConfigRevision ?? body.creativeConfigRevision;
      if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0) {
        return NextResponse.json(
          { error: "creativeConfigRevision is required for a creative configuration update." },
          { status: 400 },
        );
      }
      if (hasDraftUpdate && !isRecord(body.creativeProfileDrafts)) {
        return NextResponse.json({ error: "creativeProfileDrafts must be a JSON object." }, { status: 400 });
      }
      if (isRecord(body.creativeProfileDrafts) && body.creativeProfileDrafts.tidewe_outdoor !== undefined) {
        const draft = validateCreativeProfileInput(body.creativeProfileDrafts.tidewe_outdoor);
        if (!draft.profile || !isTideweOutdoorProfile(draft.profile)) return NextResponse.json({ error: draft.error ?? "Invalid TIDEWE creative profile draft." }, { status: 400 });
      }

      const [current] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
      if (!current) {
        return NextResponse.json({ error: "Project not found." }, { status: 404 });
      }
      if (current.creativeConfigRevision !== expectedRevision) {
        return NextResponse.json({
          error: "Creative configuration was changed by another session. Refresh before saving.",
          code: "CREATIVE_CONFIG_CONFLICT",
          creativeProfile: current.creativeProfile,
          creativeProfileDrafts: current.creativeProfileDrafts,
          creativeConfigRevision: current.creativeConfigRevision,
        }, { status: 409 });
      }

      const fallback = creativeFallback(current);
      const currentProfile = resolveCreativeProfile(current.creativeProfile, fallback);
      const incomingDrafts = hasDraftUpdate ? body.creativeProfileDrafts : undefined;
      const preliminaryDrafts = mergeCreativeProfileDrafts(
        currentProfile,
        current.creativeProfileDrafts,
        incomingDrafts,
        fallback,
      );
      let nextProfile = currentProfile;

      if (profileInput !== undefined) {
        const profileResult = validateCreativeProfileInput(profileInput);
        if ("error" in profileResult) {
          return NextResponse.json({ error: profileResult.error }, { status: 400 });
        }
        if (profileResult.profile.creationType !== currentProfile.creationType) {
          return NextResponse.json({
            error: errText(req, "创作类型确定后不可修改，请新建项目选择其他类型。", "Creation type cannot be changed after it is selected. Create a new project to use another type."),
            code: "CREATION_TYPE_LOCKED",
            creationType: currentProfile.creationType,
          }, { status: 400 });
        }
        // Identity-only saves retain the saved settings for the project's fixed creation type.
        nextProfile = hasProfileSettings(profileInput)
          ? profileResult.profile
          : profileResult.profile.creationType === "premium_product_cg"
            ? preliminaryDrafts.premium_product_cg ?? profileResult.profile
            : profileResult.profile.creationType === "tidewe_outdoor"
              ? preliminaryDrafts.tidewe_outdoor ?? profileResult.profile
            : preliminaryDrafts.short_video_sales ?? profileResult.profile;
      } else if (hasDraftUpdate) {
        const incoming = sanitizeCreativeProfileDrafts(incomingDrafts);
        const activeDraft = currentProfile.creationType === "premium_product_cg"
          ? incoming?.premium_product_cg
          : currentProfile.creationType === "tidewe_outdoor"
            ? incoming?.tidewe_outdoor
          : incoming?.short_video_sales;
        if (activeDraft) nextProfile = activeDraft;
      }

      if (isTideweOutdoorProfile(nextProfile)) {
        const presenterId = nextProfile.presenter?.id ?? null;
        if (hasCharacterUpdate && (body.characterId ?? null) !== presenterId) {
          return NextResponse.json({ error: "TIDEWE 主播须通过创作配置中的 presenter 完整保存，不能单独修改 characterId。", code: "TIDEWE_PRESENTER_PROFILE_REQUIRED" }, { status: 400 });
        }
        updates.characterId = presenterId;
      }

      const nextDrafts = mergeCreativeProfileDrafts(
        nextProfile,
        current.creativeProfileDrafts,
        incomingDrafts,
        fallback,
      );
      const currentDrafts = mergeCreativeProfileDrafts(
        currentProfile,
        current.creativeProfileDrafts,
        undefined,
        fallback,
      );
      const changed = current.creativeProfile === null
        || !sameJson(currentProfile, nextProfile)
        || !sameJson(currentDrafts, nextDrafts)
        || (hasFactsUpdate && !sameJson(current.productFacts, updates.productFacts))
        || (hasTideweProductUpdate && productContextFields.some((field) => hasOwn(body, field) && !sameJson(current[field], updates[field])))
        || (isTideweOutdoorProfile(nextProfile) && current.characterId !== updates.characterId)
        || current.videoMode !== nextProfile.videoMode;
      const nextRevision = changed ? expectedRevision + 1 : expectedRevision;

      const result = await db
        .update(projects)
        .set({
          ...updates,
          videoMode: nextProfile.videoMode,
          creativeProfile: nextProfile,
          creativeProfileDrafts: nextDrafts,
          creativeConfigRevision: nextRevision,
          updatedAt: new Date(),
        })
        .where(and(eq(projects.id, id), eq(projects.creativeConfigRevision, expectedRevision)))
        .returning();

      if (result.length === 0) {
        const [latest] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
        if (!latest) return NextResponse.json({ error: "Project not found." }, { status: 404 });
        return NextResponse.json({
          error: "Creative configuration was changed by another session. Refresh before saving.",
          code: "CREATIVE_CONFIG_CONFLICT",
          creativeProfile: latest.creativeProfile,
          creativeProfileDrafts: latest.creativeProfileDrafts,
          creativeConfigRevision: latest.creativeConfigRevision,
        }, { status: 409 });
      }
      return NextResponse.json(result[0]);
    }

    if (Object.keys(updates).length === 0) {
      return apiError(req, "没有可更新的字段", "No updatable fields provided", 400);
    }

    // Older projects without a stored profile retain their direct videoMode update path. Once a
    // profile exists, every mode change must go through the revisioned creative configuration.
    if ("videoMode" in updates) {
      const [current] = await db
        .select({ creativeProfile: projects.creativeProfile })
        .from(projects)
        .where(eq(projects.id, id))
        .limit(1);
      if (current?.creativeProfile) {
        return NextResponse.json(
          { error: "Update videoMode through creativeProfile with creativeConfigRevision." },
          { status: 400 },
        );
      }
    }

    const result = await db
      .update(projects)
      .set({ ...updates, updatedAt: new Date() })
      // A profile switch between the product-context read and this write must not
      // let the legacy unrevisioned path mutate a now-TIDEWE project's product.
      .where(and(eq(projects.id, id), ...(hasContextUpdate && contextProject
        ? [eq(projects.creativeConfigRevision, contextProject.creativeConfigRevision)] : [])))
      .returning();

    if (result.length === 0) {
      if (hasContextUpdate && contextProject) {
        const [latest] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
        if (latest) return NextResponse.json({ error: "Creative configuration changed while saving the product. Refresh before saving.", code: "CREATIVE_CONFIG_CONFLICT", creativeConfigRevision: latest.creativeConfigRevision }, { status: 409 });
      }
      return apiError(req, "项目不存在", "Project not found", 404);
    }

    return NextResponse.json(result[0]);
  } catch (error) {
    console.error("Failed to update project:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : errText(req, "更新项目失败", "Failed to update project") },
      { status: 500 }
    );
  }
}

// Delete a project
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id || !SAFE_ID.test(id)) {
      return apiError(req, "无效的项目ID", "Invalid project ID", 400);
    }
    const db = getDb();
    // DB rows cascade (scripts/assets/compositions via onDelete:"cascade" + foreign_keys=ON),
    // but the project's on-disk files do not — remove them too so deletes don't leak orphaned
    // uploads/output directories. force:true ignores missing dirs; failures never block the delete.
    const blockingTasks = db.transaction((tx) => {
      const tasks = [
        ...tx.select().from(generationItems).where(and(eq(generationItems.projectId, id), inArray(generationItems.status, ["queued", "running", "waiting", "importing", "needs_attention"]))).all().map((item) => ({
          kind: "generation" as const, id: item.runId,
          href: `/project/${encodeURIComponent(id)}/${item.kind === "script" ? "script" : "assets"}?runId=${encodeURIComponent(item.runId)}`,
        })),
        ...listKlingFilms(id).filter(isKlingFilmUnresolved).map((run) => ({
          kind: "kling_film" as const, id: run.id,
          href: `/project/${encodeURIComponent(id)}/assets?klingFilm=${encodeURIComponent(run.id)}`,
        })),
        ...listKlingJobs(id).filter(isKlingJobUnresolved).map((job) => ({
          kind: "kling_job" as const, id: job.id,
          href: `/project/${encodeURIComponent(id)}/assets?klingJob=${encodeURIComponent(job.id)}`,
        })),
      ];
      if (tasks.length === 0) tx.delete(projects).where(eq(projects.id, id)).run();
      return tasks;
    }, { behavior: "immediate" });
    if (blockingTasks.length > 0) {
      return NextResponse.json({
        error: errText(req, "项目仍有未完成或待恢复的生成任务，请先处理原任务，避免丢失结果", "Resolve this project's generation tasks before deleting it"),
        code: blockingTasks.some((task) => task.kind === "generation") ? "PROJECT_HAS_UNRESOLVED_GENERATION_TASKS" : "PROJECT_HAS_UNRESOLVED_KLING_TASKS",
        blockingTasks,
      }, { status: 409 });
    }
    await Promise.all([
      rm(join(getUploadsDir(), id), { recursive: true, force: true }).catch(() => {}),
      rm(join(getOutputDir(), id), { recursive: true, force: true }).catch(() => {}),
    ]);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete project:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : errText(req, "删除项目失败", "Failed to delete project") },
      { status: 500 }
    );
  }
}
