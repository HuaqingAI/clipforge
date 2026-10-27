/** Single-shot image repair keeps the storyboard crop as the composition anchor. */
export type KeyframeRepairIssue = "hands" | "anatomy" | "duplicates" | "product" | "details";
export type KeyframeRefinementResolution = "2k" | "4k";

export const KEYFRAME_REPAIR_ISSUES: readonly { id: KeyframeRepairIssue; label: { zh: string; en: string } }[] = [
  { id: "hands", label: { zh: "手部、掌向与手腕", en: "Hands, orientation and wrists" } },
  { id: "anatomy", label: { zh: "肢体与人体结构", en: "Anatomy and limbs" } },
  { id: "duplicates", label: { zh: "重复物体与多余部件", en: "Duplicate objects and extra parts" } },
  { id: "product", label: { zh: "商品结构与细节", en: "Product structure and details" } },
  { id: "details", label: { zh: "清晰度与画面细节", en: "Clarity and image details" } },
];

export interface KeyframeRefinementCandidate {
  id: string;
  shotId: number;
  filePath: string;
  sourceKeyframeUrl: string | null;
  derivedFromAssetId: string | null;
  selected: boolean;
  prompt?: string | null;
  model?: string | null;
}

export interface KeyframeRefinementResolutionInfo {
  requested: KeyframeRefinementResolution;
  width: number;
  height: number;
  limited: boolean;
}
