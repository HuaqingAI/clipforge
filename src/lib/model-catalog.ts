import type { Model } from "@/lib/providers/types";
export interface CatalogProvider { name: string; apiKey?: string; baseUrl?: string; profileId?: string }

export interface CatalogProviderSetting {
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
  profileId?: string;
}

/** CLI credentials live on the server; enabled CLI profiles never need a fake API key. */
export function isCatalogProviderEnabled(name: string, setting: CatalogProviderSetting): boolean {
  return Boolean(setting.enabled && (name === "kling-cli" || setting.apiKey?.trim()));
}

export function configuredCatalogProviders(
  providers: Record<string, CatalogProviderSetting>,
  mediaType?: "image" | "video",
): CatalogProvider[] {
  return Object.entries(providers)
    .filter(([name, setting]) => isCatalogProviderEnabled(name, setting) && !(name === "kling-cli" && mediaType === "image"))
    .map(([name, setting]) => name === "kling-cli"
      ? { name, ...(setting.profileId ? { profileId: setting.profileId } : {}) }
      : { name, apiKey: setting.apiKey, baseUrl: setting.baseUrl });
}
export interface ModelCatalogStatus {
  provider: string; mediaType: "image" | "video"; status: "ready" | "empty" | "error" | "fallback";
  checkedAt: string; durationMs: number; count: number; errorCode?: "CATALOG_TIMEOUT" | "CATALOG_UNAVAILABLE";
  source?: "static" | "live" | "cache" | "stale"; catalogUpdatedAt?: string;
}
export interface ModelCatalogResult { models: Model[]; providers: ModelCatalogStatus[] }
