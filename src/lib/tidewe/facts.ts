import type { ProductFact, ProductFacts, TideweProductCategory } from "./types";
import { TIDEWE_SHOP_CATEGORIES } from "./categories";

const CATEGORIES = new Set<TideweProductCategory>([...TIDEWE_SHOP_CATEGORIES, "hunting_chair", "heated_apparel", "hunting_apparel", "waterproof_boots", "other"]);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max = 4000) => typeof v === "string" ? v.trim().slice(0, max) : "";

export function normalizeTideweCategory(value: unknown): TideweProductCategory {
  // Preserve recognized stored IDs and the historical fallback behavior. SHOP
  // aliases are canonicalized only in editable UI input, never inside snapshots.
  if (CATEGORIES.has(value as TideweProductCategory)) return value as TideweProductCategory;
  const hint = str(value).toLowerCase();
  if (/chair|椅/.test(hint)) return "hunting_chair";
  if (/blind|tent|帐篷|猎帐/.test(hint)) return "hunting_blind";
  if (/wader|涉水/.test(hint)) return "waders";
  if (/heated|加热/.test(hint)) return "heated_apparel";
  if (/boot|靴/.test(hint)) return "waterproof_boots";
  if (/apparel|jacket|camo|服|衣/.test(hint)) return "hunting_apparel";
  return "other";
}

/** Pure and browser safe. Image observations never become verified specifications. */
export function normalizeProductFacts(value: unknown): ProductFacts | undefined {
  if (!record(value) || Object.keys(value).length === 0) return undefined;
  if (value.version !== undefined && value.version !== 1) throw new Error("Unsupported product facts version");
  const items: ProductFact[] = [];
  const ids = new Set<string>();
  for (const raw of Array.isArray(value.items) ? value.items.slice(0, 100) : []) {
    if (!record(raw) || !record(raw.source)) throw new Error("Invalid product fact source");
    const id = str(raw.id, 100), key = str(raw.key, 100), factValue = str(raw.value);
    if (!id || !key || !factValue || ids.has(id)) throw new Error("Product facts require unique IDs, keys and values");
    const kind = raw.source.kind;
    if (kind !== "manual" && kind !== "product_page" && kind !== "uploaded_image") throw new Error("Invalid product fact source kind");
    const status = raw.status;
    if (status !== "confirmed" && status !== "observed" && status !== "inferred" && status !== "unknown") throw new Error("Invalid product fact status");
    const ref = str(raw.source.ref, 2000);
    if (!ref) throw new Error("Product fact requires a source reference");
    ids.add(id);
    items.push({ id, key, value: factValue, ...(str(raw.scope) && { scope: str(raw.scope, 200) }),
      status: kind === "uploaded_image" && status === "confirmed" ? "observed" : status,
      source: { kind, ref, ...(str(raw.source.excerpt) && { excerpt: str(raw.source.excerpt) }) } });
  }
  const blockedClaims: NonNullable<ProductFacts["blockedClaims"]> = [];
  for (const raw of Array.isArray(value.blockedClaims) ? value.blockedClaims : []) {
    if (record(raw) && str(raw.key)) blockedClaims.push({ key: str(raw.key, 100), reason: str(raw.reason), sourceRefs: Array.isArray(raw.sourceRefs) ? raw.sourceRefs.map(v => str(v)).filter(Boolean) : [] });
  }
  const groups = new Map<string, ProductFact[]>();
  for (const fact of items.filter(f => f.status === "confirmed")) {
    const key = `${fact.key.toLowerCase()}::${fact.scope?.toLowerCase() ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), fact]);
  }
  for (const group of groups.values()) {
    if (new Set(group.map(f => f.value.toLowerCase())).size > 1 && !blockedClaims.some(b => b.key === group[0].key)) {
      blockedClaims.push({ key: group[0].key, reason: "Conflicting sources; omit this claim until resolved", sourceRefs: group.map(f => f.source.ref) });
    }
  }
  return { version: 1, brand: str(value.brand, 100) || "TIDEWE", category: normalizeTideweCategory(value.category),
    ...(str(value.sku) && { sku: str(value.sku, 100) }), ...(str(value.variant) && { variant: str(value.variant, 200) }), items,
    ...(blockedClaims.length && { blockedClaims }) };
}

export function productFactsFromDescription(description: string | null | undefined, category?: string | null, sku?: string): ProductFacts {
  const lines = (description ?? "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return { version: 1, brand: "TIDEWE", category: normalizeTideweCategory(category), ...(sku?.trim() && { sku: sku.trim() }),
    items: lines.map((value, i) => ({ id: `manual-${i + 1}`, key: `description-${i + 1}`, value, status: "confirmed", source: { kind: "manual", ref: "project.productDescription", excerpt: value } })) };
}

export function claimableFacts(facts: ProductFacts): ProductFact[] {
  const blocked = new Set(facts.blockedClaims?.map(b => b.key.toLowerCase()));
  return facts.items.filter(f => f.status === "confirmed" && !blocked.has(f.key.toLowerCase()));
}
