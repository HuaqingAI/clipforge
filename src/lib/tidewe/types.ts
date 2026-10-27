export const TIDEWE_CORPUS_VERSION = "tidewe-2026-10-26-v1" as const;
export const TIDEWE_COMPILER_VERSION = "tidewe-outdoor-1" as const;

/** Frozen library identity; later library edits must not silently recast a script. */
export interface TidewePresenterSnapshot {
  id: string;
  name: string;
  appearance: string;
  description?: string;
  referenceImages: string[];
  sourceReferenceImages?: string[];
}

export type TideweProductCategory = "hunting_chair" | "hunting_blind" | "waders" | "heated_apparel" | "hunting_apparel" | "waterproof_boots" | "other";
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
}
export interface TideweShotFields {
  presenter?: TidewePresenterSnapshot;
  personVisible?: boolean;
  /** Half-open UTF-16 offsets into the frozen copyDocument.text. */
  copySpan: { start: number; end: number };
  translation: string;
  shotGoal: string;
  productVisible: boolean;
  factRefs: string[];
  sceneId: string;
}
