import { assetScopeForShot, type ScriptContext } from "@/lib/asset-context";
import { persistAssetSource, saveAssetCandidate, type AssetSelectionPolicy } from "@/lib/asset-persistence";
import type { Shot } from "@/lib/db/schema";
import { PRODUCT_ORIGINAL_ASSET_PROVIDER } from "@/lib/premium-cg-assets";

/** Save only an original already owned by this project; browser metadata is never trusted. */
export async function saveProductOriginalAsset(input: {
  projectId: string;
  productImages: readonly string[];
  sourceUrl: string;
  script: ScriptContext;
  shot: Shot;
  selectedPolicy?: AssetSelectionPolicy;
}) {
  if (input.shot.visualSource !== "product_image" || !input.productImages.includes(input.sourceUrl)) {
    throw new Error("商品原图必须使用本项目已保存的商品图片。");
  }
  const filePath = await persistAssetSource(input.projectId, input.sourceUrl, input.shot.shotId);
  return saveAssetCandidate({
    projectId: input.projectId,
    shotId: input.shot.shotId,
    type: "product_image",
    filePath,
    provider: PRODUCT_ORIGINAL_ASSET_PROVIDER,
    scope: assetScopeForShot(input.script, input.shot),
    selectedPolicy: input.selectedPolicy,
  });
}
