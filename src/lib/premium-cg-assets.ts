import { assetMatchesScript, type ScriptContext } from "@/lib/asset-context";

/** Returned when a CG output path receives an asset without server-verifiable provenance. */
export const PREMIUM_CG_ASSET_PROVENANCE_REQUIRED = "PREMIUM_CG_ASSET_PROVENANCE_REQUIRED";

export interface PremiumCgAssetCandidate {
  shotId: number;
  type?: unknown;
  status?: unknown;
  filePath?: unknown;
  provider?: unknown;
  prompt?: unknown;
  derivedFromAssetId?: unknown;
  sourceKeyframeUrl?: unknown;
  sourceScriptId?: unknown;
  sourceShotKey?: unknown;
  sourceRevision?: unknown;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Premium product CG may only reuse a take produced by a server-owned CG flow.
 * Legacy all-null scopes deliberately remain compatible for sales projects, but are
 * never enough evidence for the no-added-text CG policy.
 */
export function hasTrustedPremiumCgAssetProvenance(
  asset: PremiumCgAssetCandidate,
  projectId: string,
  script: ScriptContext | null | undefined,
): boolean {
  if (
    asset.type !== "ai_generated"
    || asset.status !== "done"
    || typeof asset.filePath !== "string"
    || !asset.filePath
    || typeof asset.sourceScriptId !== "string"
    || typeof asset.sourceShotKey !== "string"
    || typeof asset.sourceRevision !== "string"
    || !assetMatchesScript({
      shotId: asset.shotId,
      sourceScriptId: asset.sourceScriptId,
      sourceShotKey: asset.sourceShotKey,
      sourceRevision: asset.sourceRevision,
    }, script)
  ) {
    return false;
  }

  const projectFiles = `/api/files/${projectId}/`;
  if (asset.provider === "kling-cli" && asset.filePath.startsWith(`${projectFiles}kling/`)) {
    return true;
  }

  const gridPath = new RegExp(
    `^/api/files/${escapeRegex(projectId)}/asset-${asset.shotId}-\\d+-grid\\.(?:png|jpe?g|webp)$`,
    "i",
  );
  if (gridPath.test(asset.filePath)
    && typeof asset.prompt === "string"
    && asset.prompt.startsWith("[storyboard-grid")) return true;

  const refinementPath = new RegExp(
    `^/api/files/${escapeRegex(projectId)}/keyframe-refine-${asset.shotId}-\\d+-[a-f0-9]{8}\\.(?:png|jpe?g|webp)$`,
    "i",
  );
  return refinementPath.test(asset.filePath)
    && typeof asset.prompt === "string"
    && asset.prompt.startsWith("[keyframe-refine-v1]")
    && typeof asset.derivedFromAssetId === "string"
    && Boolean(asset.derivedFromAssetId)
    && typeof asset.sourceKeyframeUrl === "string"
    && asset.sourceKeyframeUrl.startsWith(projectFiles);
}

export function filterTrustedPremiumCgAssets<T extends PremiumCgAssetCandidate>(
  rows: readonly T[],
  projectId: string,
  script: ScriptContext | null | undefined,
): T[] {
  return rows.filter((asset) => hasTrustedPremiumCgAssetProvenance(asset, projectId, script));
}
