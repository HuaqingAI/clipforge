import type { ArchivedCreativeProfile } from "@/lib/creative-profiles";

/** Stored non-TIDEWE data used to exercise historical media compatibility. */
export function archivedCreativeProfile(overrides: Partial<ArchivedCreativeProfile> = {}): ArchivedCreativeProfile {
  return {
    version: 1,
    id: "unsupported",
    creationType: "unsupported",
    styleType: "pain_point",
    videoMode: "product_closeup",
    targetDuration: 30,
    composeSnapshot: {},
    ...overrides,
  };
}
