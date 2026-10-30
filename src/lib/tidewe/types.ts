import type { TideweShopCategory } from "./categories";

export const TIDEWE_CORPUS_VERSION = "tidewe-2026-10-26-v1" as const;
export const TIDEWE_COMPILER_VERSION = "tidewe-outdoor-1" as const;
export const TIDEWE_MIN_SHOTS = 7;
export const TIDEWE_MAX_SHOTS = 9;

/** Frozen library identity; later library edits must not silently recast a script. */
export interface TidewePresenterSnapshot {
  id: string;
  name: string;
  appearance: string;
  description?: string;
  referenceImages: string[];
  sourceReferenceImages?: string[];
}

/**
 * Stored aliases stay valid for frozen factsSnapshot/factsHash values:
 * hunting_chair→accessories, heated_apparel→heated_gear,
 * hunting_apparel→apparel, waterproof_boots→boots. `other` means unset only.
 */
export type TideweProductCategory = TideweShopCategory | "hunting_chair" | "heated_apparel" | "hunting_apparel" | "waterproof_boots" | "other";
export interface ProductFact {
  id: string;
  key: string;
  value: string;
  scope?: string;
  status: "confirmed" | "observed" | "inferred" | "unknown";
  source: { kind: "manual" | "product_page" | "uploaded_image"; ref: string; excerpt?: string };
}
export interface ProductFacts {
  version: 1;
  brand: string;
  sku?: string;
  variant?: string;
  category: TideweProductCategory;
  items: ProductFact[];
  blockedClaims?: { key: string; reason: string; sourceRefs: string[] }[];
}
export type TideweVisualRole = "presenter" | "demonstration" | "detail" | "context";
/** A meaning block in AI-written copy, before it is allocated to actual shots. */
export interface TideweCopyBeat {
  text: string;
  visualRole: TideweVisualRole;
  visualIdea: string;
  factRefs: string[];
}
/** Explicit production intent; optional on historical and manually edited shots. */
export interface TideweVisualPlan {
  framing: "wide" | "medium" | "close_up" | "detail";
  visualRole: TideweVisualRole;
  /** Concrete visible product or component; required on newly planned product shots. */
  productFocus?: string;
  actionStart: string;
  action: string;
  actionEnd: string;
}
export interface TideweCopyDocument {
  version: 1;
  language: "en-US";
  /** Missing on historical AI copy. User prose is frozen, never treated as product evidence. */
  source?: "ai_generated" | "user_provided";
  text: string;
  translation: string;
  angle: string;
  hookType: string;
  claimedFactIds: string[];
  factsSnapshot: ProductFacts;
  factsHash: string;
  corpusVersion: string;
  compilerVersion: string;
  exampleIds: string[];
  wordCount: number;
  estimatedDuration: number;
  /** Appearance evidence remains separate from confirmed functional facts. */
  productName?: string;
  visualObservations?: string;
  visualBeats?: TideweCopyBeat[];
}
export interface TideweShotFields {
  presenter?: TidewePresenterSnapshot;
  personVisible?: boolean;
  /** Native-audio delivery per shot; omitted historical shots keep global on-camera behavior. */
  speechDelivery?: "on_camera" | "off_camera";
  visualPlan?: TideweVisualPlan;
  /** Half-open UTF-16 offsets into the frozen copyDocument.text. */
  copySpan: { start: number; end: number };
  translation: string;
  shotGoal: string;
  productVisible: boolean;
  factRefs: string[];
  sceneId: string;
}
