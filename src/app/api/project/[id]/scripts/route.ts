import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { projects, scripts } from "@/lib/db/schema";
import { apiError, errText } from "@/lib/api-error";
import { lintCreativeProfileShots } from "@/lib/creative-policy-lint";
import {
  checkCreativeProfileContext,
  isPremiumProductCgProfile,
} from "@/lib/creative-profiles";

// Historical variants remain readable after regeneration or a profile switch. Selection and edits
// are limited to scripts whose frozen creative context matches the current project configuration.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const rows = await getDb()
      .select()
      .from(scripts)
      .where(eq(scripts.projectId, id))
      .orderBy(desc(scripts.createdAt));
    return NextResponse.json(rows);
  } catch (error) {
    console.error("Failed to fetch scripts:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : errText(req, "Failed to fetch scripts", "Failed to fetch scripts") },
      { status: 500 },
    );
  }
}

interface ShotTextPatch {
  shotId: number;
  voiceover?: string;
  description?: string;
  camera?: string;
}

const CAMERA_MAX_LEN = 200;

function contextConflict(context: Exclude<ReturnType<typeof checkCreativeProfileContext>, { ok: true }>) {
  return {
    error: context.code === "CREATIVE_CONFIG_STALE"
      ? "The script was created with an outdated creative configuration. Regenerate a current script before using it."
      : "The script does not match the project's current creative type. Generate a current script before using it.",
    code: context.code,
    currentCreationType: context.projectProfile.creationType,
    scriptCreationType: context.scriptProfile.creationType,
    projectRevision: context.projectRevision,
    scriptRevision: context.scriptRevision,
  };
}

/** PATCH accepts either a script selection or narrowly scoped shot-text edits. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const scriptId = body.scriptId as string | undefined;
    const shotTexts = body.shotTexts as ShotTextPatch[] | undefined;

    if (scriptId && Array.isArray(shotTexts)) {
      const db = getDb();
      const [script] = await db.select().from(scripts).where(eq(scripts.id, scriptId)).limit(1);
      if (!script || script.projectId !== id) {
        return apiError(req, "Script not found", "Script not found", 404);
      }
      const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
      if (!project) return apiError(req, "Project not found", "Project not found", 404);

      const context = checkCreativeProfileContext(project, script);
      if (!context.ok) return NextResponse.json(contextConflict(context), { status: 409 });

      const patchByShot = new Map<number, ShotTextPatch>();
      for (const patch of shotTexts) {
        if (patch && typeof patch.shotId === "number") patchByShot.set(patch.shotId, patch);
      }
      const shots = (script.shots ?? []).map((shot) => {
        const patch = patchByShot.get(shot.shotId);
        if (!patch) return shot;
        return {
          ...shot,
          ...(typeof patch.voiceover === "string" && { voiceover: patch.voiceover.trim() }),
          ...(typeof patch.description === "string" && { description: patch.description.trim() }),
          ...(typeof patch.camera === "string" && { camera: patch.camera.trim().slice(0, CAMERA_MAX_LEN) }),
        };
      });

      const profile = context.scriptProfile;
      if (isPremiumProductCgProfile(profile)) {
        if (profile.narrationMode === "none" && shots.some((shot) => shot.voiceover.trim() || shot.narration?.trim())) {
          return NextResponse.json({
            error: "Visual-only premium product CG scripts cannot contain narration.",
            code: "CG_NARRATION_DISABLED",
          }, { status: 400 });
        }
        const issues = lintCreativeProfileShots(profile, shots);
        if (issues.length > 0) {
          return NextResponse.json({
            error: "Premium product CG script edits violate the no-added-text or restrained-narration policy.",
            code: "CREATIVE_POLICY_VIOLATION",
            issues,
          }, { status: 400 });
        }
      }

      const [updated] = await db.update(scripts).set({ shots }).where(eq(scripts.id, scriptId)).returning();
      return NextResponse.json({ success: true, script: updated });
    }

    const selectedId = body.selectedScriptId as string | undefined;
    if (!selectedId) {
      return apiError(req, "Missing selectedScriptId or scriptId+shotTexts", "Missing selectedScriptId or scriptId+shotTexts", 400);
    }

    const db = getDb();
    const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (!project) return apiError(req, "Project not found", "Project not found", 404);
    const [target] = await db.select().from(scripts).where(eq(scripts.id, selectedId)).limit(1);
    if (!target || target.projectId !== id) {
      return apiError(req, "Script not found", "Script not found", 404);
    }

    const context = checkCreativeProfileContext(project, target);
    if (!context.ok) return NextResponse.json(contextConflict(context), { status: 409 });

    const [updated] = db.transaction((tx) => {
      tx.update(scripts).set({ selected: false }).where(eq(scripts.projectId, id)).run();
      return tx.update(scripts).set({ selected: true }).where(eq(scripts.id, selectedId)).returning().all();
    });
    return NextResponse.json({ success: true, script: updated });
  } catch (error) {
    console.error("Failed to update script:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : errText(req, "Update failed", "Update failed") },
      { status: 500 },
    );
  }
}
