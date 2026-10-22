import { isPremiumProductCgProject } from "@/lib/creative-profiles";

export const PREMIUM_CG_MEDIA_EDIT_FORBIDDEN = "PREMIUM_CG_MEDIA_EDIT_FORBIDDEN";

/** Imported footage can contain baked-in copy that no transcript edit can safely remove. */
export function isPremiumCgMediaEditBlocked(project: {
  creativeProfile?: unknown;
  videoMode?: unknown;
}): boolean {
  return isPremiumProductCgProject(project);
}

/** Shared error marker for routes and background jobs that must not produce edited media for CG. */
export function assertPremiumCgMediaEditAllowed(project: {
  creativeProfile?: unknown;
  videoMode?: unknown;
}): void {
  if (isPremiumCgMediaEditBlocked(project)) throw new Error(PREMIUM_CG_MEDIA_EDIT_FORBIDDEN);
}
