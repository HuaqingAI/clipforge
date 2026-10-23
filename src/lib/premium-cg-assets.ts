import { assetMatchesScript, type ScriptContext } from "@/lib/asset-context";

/** Returned when a CG output path receives an asset without server-verifiable provenance. */
export const PREMIUM_CG_ASSET_PROVENANCE_REQUIRED = "PREMIUM_CG_ASSET_PROVENANCE_REQUIRED";
/** Written only after the server matches a source to the project's saved product photos. */
export const PRODUCT_ORIGINAL_ASSET_PROVIDER = "product-original";

export interface PremiumCgAssetCandidate {
  shotId: number;
  type?: unknown;
  status?: unknown;
  filePath?: unknown;
  provider?: unknown;
  prompt?: unknown;
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
    asset.status !== "done"
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

  if (asset.type === "product_image" && asset.provider === PRODUCT_ORIGINAL_ASSET_PROVIDER) {
    return script?.shots?.some((shot) => shot.shotId === asset.shotId && shot.visualSource === "product_image") ?? false;
  }
  if (asset.type !== "ai_generated") return false;

  const projectFiles = `/api/files/${projectId}/`;
  if (asset.provider === "kling-cli" && asset.filePath.startsWith(`${projectFiles}kling/`)) {
    return true;
  }

  const gridPath = new RegExp(
    `^/api/files/${escapeRegex(projectId)}/asset-${asset.shotId}-\\d+-grid\\.(?:png|jpe?g|webp)$`,
    "i",
  );
  return gridPath.test(asset.filePath)
    && typeof asset.prompt === "string"
    && asset.prompt.startsWith("[storyboard-grid");
}

export function filterTrustedPremiumCgAssets<T extends PremiumCgAssetCandidate>(
  rows: readonly T[],
  projectId: string,
  script: ScriptContext | null | undefined,
): T[] {
  return rows.filter((asset) => hasTrustedPremiumCgAssetProvenance(asset, projectId, script));
}
