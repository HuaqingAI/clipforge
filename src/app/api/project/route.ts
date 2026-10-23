import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { desc } from "drizzle-orm";
import {
  createPremiumProductCgProfile,
  createShortVideoSalesProfile,
  creativeProfileDraftsInputError,
  sanitizeCreativeProfileDrafts,
  validateCreativeProfileInput,
  type CreativeProfileFallback,
  type ProjectCreativeProfile,
  type ProjectCreativeProfileDrafts,
} from "@/lib/creative-profiles";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function creativeFallback(value: JsonRecord): CreativeProfileFallback {
  return {
    styleType: value.styleType,
    videoMode: value.videoMode,
    visualSource: value.visualSource,
    targetDuration: value.targetDuration ?? value.duration,
    composeSnapshot: value.composeSnapshot ?? value.compose,
    creativeSettings: value.creativeSettings,
    recipeSnapshot: value.recipeSnapshot,
  };
}

/** Read only deliberate creative-profile fields. Legacy style/video payloads remain readable on existing projects. */
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
    "composeSnapshot", "compose", "creativeSettings", "recipeSnapshot", "visualSource",
  ]) {
    if (hasOwn(value, key)) profile[key] = value[key];
  }
  if (profile.targetDuration === undefined && profile.duration !== undefined) profile.targetDuration = profile.duration;
  if (profile.composeSnapshot === undefined && profile.compose !== undefined) profile.composeSnapshot = profile.compose;
  return profile;
}

function createProfileDrafts(
  profile: ProjectCreativeProfile,
  rawDrafts: unknown,
  fallback: CreativeProfileFallback,
): ProjectCreativeProfileDrafts {
  const drafts: ProjectCreativeProfileDrafts = { ...(sanitizeCreativeProfileDrafts(rawDrafts) ?? {}) };
  if (!drafts.short_video_sales) drafts.short_video_sales = createShortVideoSalesProfile(fallback);
  if (!drafts.premium_product_cg) drafts.premium_product_cg = createPremiumProductCgProfile();
  if (profile.creationType === "premium_product_cg") drafts.premium_product_cg = profile;
  else drafts.short_video_sales = profile;
  return drafts;
}

// fetch project list, most recently edited first (the /start "continue" cards rely on this order)
export async function GET() {
  try {
    const db = getDb();
    const result = await db.select().from(projects).orderBy(desc(projects.updatedAt));
    return NextResponse.json(result);
  } catch (error) {
    console.error("获取项目列表失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "获取项目列表失败" },
      { status: 500 }
    );
  }
}

// create a new project
export async function POST(req: NextRequest) {
  try {
    const parsedBody: unknown = await req.json();
    if (!isRecord(parsedBody)) {
      return NextResponse.json({ error: "Project payload must be a JSON object." }, { status: 400 });
    }
    const body = parsedBody;
    const db = getDb();

    const requestedProfile = requestedCreativeProfile(body);
    if (requestedProfile === undefined) {
      return NextResponse.json({
        error: "Choose a creation type before creating a project.",
        code: "CREATIVE_PROFILE_REQUIRED",
      }, { status: 400 });
    }
    const fallback = creativeFallback(body);
    const profileResult = validateCreativeProfileInput(requestedProfile);
    if ("error" in profileResult) {
      return NextResponse.json({ error: profileResult.error }, { status: 400 });
    }
    const draftError = creativeProfileDraftsInputError(body.creativeProfileDrafts);
    if (draftError) return NextResponse.json({ error: draftError }, { status: 400 });
    const creativeProfile = profileResult.profile;
    const creativeProfileDrafts = createProfileDrafts(creativeProfile, body.creativeProfileDrafts, fallback);
    const sourceType = body.sourceType === "clone" ? "clone" : undefined;

    const projectValues: typeof projects.$inferInsert = {
      name: optionalString(body.name) ?? "未命名项目",
      ...(optionalString(body.productName) && { productName: optionalString(body.productName) }),
      ...(optionalString(body.productCategory) && { productCategory: optionalString(body.productCategory) }),
      ...(optionalString(body.productDescription) && { productDescription: optionalString(body.productDescription) }),
      productImages: stringList(body.productImages),
      videoMode: creativeProfile.videoMode,
      creativeProfile,
      creativeProfileDrafts,
      creativeConfigRevision: 1,
      ...(sourceType && { sourceType }),
      ...(optionalString(body.sourceVideoUrl) && { sourceVideoUrl: optionalString(body.sourceVideoUrl) }),
    };

    const newProject = await db
      .insert(projects)
      .values(projectValues)
      .returning();

    return NextResponse.json(newProject[0], { status: 201 });
  } catch (error) {
    console.error("创建项目失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "创建项目失败" },
      { status: 500 }
    );
  }
}
