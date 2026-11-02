import type { KlingPublicStatus } from "./types";

// Match the five-minute catalog lifetime used when registering Kling jobs.
const CATALOG_MAX_AGE_MS = 300_000;

export function hasVerifiedKlingCatalog(status: KlingPublicStatus, profileId?: string, selectionKey?: string): boolean {
  const profile = status.profile;
  return Boolean(status.loggedIn && status.configured && profile && (!profileId || profile.id === profileId)
    && !profile.disabledAt && profile.environmentState === "ready" && profile.authState === "authenticated"
    && profile.principalKey && profile.catalogRevision && profile.catalogCheckedAt
    && status.models.some((model) => model.selectionKey === selectionKey && model.profileId === profile.id && model.catalogRevision === profile.catalogRevision));
}

export function hasFreshKlingCatalog(status: KlingPublicStatus, profileId?: string, selectionKey?: string): boolean {
  const age = Date.now() - (status.profile?.catalogCheckedAt ?? 0);
  return hasVerifiedKlingCatalog(status, profileId, selectionKey) && age >= 0 && age <= CATALOG_MAX_AGE_MS;
}
