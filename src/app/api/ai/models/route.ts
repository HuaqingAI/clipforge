import { NextRequest, NextResponse } from "next/server";
import { createProvider } from "@/lib/providers";
import type { CatalogProvider, ModelCatalogStatus } from "@/lib/model-catalog";
import type { Model } from "@/lib/providers/types";
import { assertKlingLocalRequest, KlingAccessError } from "@/lib/kling/local-access";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const providers = body?.providers ?? [];
  const mediaType = body?.mediaType;
  if (!Array.isArray(providers) || providers.length > 16 || (mediaType !== undefined && mediaType !== "image" && mediaType !== "video") || providers.some((p) => !p || typeof p.name !== "string" || !/^[a-z0-9-]{1,64}$/.test(p.name) || (p.apiKey !== undefined && (typeof p.apiKey !== "string" || p.apiKey.length > 4096)) || (p.baseUrl !== undefined && (typeof p.baseUrl !== "string" || p.baseUrl.length > 2048)) || (p.profileId !== undefined && (typeof p.profileId !== "string" || p.profileId.length > 128)))) {
    return NextResponse.json({ error: "Invalid catalog request" }, { status: 400 });
  }
  if (providers.some((provider: CatalogProvider) => provider.name === "kling-cli")) {
    try { await assertKlingLocalRequest(req); }
    catch (error) {
      const known = error instanceof KlingAccessError;
      return NextResponse.json({ error: { code: known ? error.code : "KLING_LOCAL_ACCESS_REQUIRED", message: known ? error.message : "Kling CLI 仅供本机受保护会话使用" } }, { status: known ? error.status : 403, headers: { "Cache-Control": "no-store" } });
    }
  }
  const types: ("image" | "video")[] = mediaType ? [mediaType] : ["image", "video"];
  const unique = [...new Map((providers as CatalogProvider[]).map((p) => [p.name, p])).values()];
  const results = await Promise.all(unique.flatMap((p) => types.map(async (type) => {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const provider = createProvider({ name: p.name, apiKey: p.apiKey ?? "", baseUrl: p.baseUrl ?? "", profileId: p.profileId, timeout: 10_000 });
      const models = await Promise.race([
        provider.listModels(type, { refresh: body.refresh === true }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("CATALOG_TIMEOUT")), 12_000); }),
      ]);
      const metadata = provider.catalogMetadata;
      const status: ModelCatalogStatus = { provider: p.name, mediaType: type, status: metadata?.fallback ? "fallback" : models.length ? "ready" : "empty", checkedAt: new Date().toISOString(), durationMs: Date.now() - started, count: models.length, source: metadata?.source ?? "static", catalogUpdatedAt: metadata?.updatedAt, ...(metadata?.fallback ? { errorCode: "CATALOG_UNAVAILABLE" as const } : {}) };
      return { models, status };
    } catch (error) {
      // Raw upstream errors can contain request URLs or credentials. Return only a stable code.
      const status: ModelCatalogStatus = { provider: p.name, mediaType: type, status: "error", checkedAt: new Date().toISOString(), durationMs: Date.now() - started, count: 0, errorCode: error instanceof Error && error.message === "CATALOG_TIMEOUT" ? "CATALOG_TIMEOUT" : "CATALOG_UNAVAILABLE" };
      return { models: [] as Model[], status };
    } finally { if (timer) clearTimeout(timer); }
  })));
  return NextResponse.json({ models: results.flatMap((result) => result.models), providers: results.map((result) => result.status) }, { headers: { "Cache-Control": "no-store" } });
}
