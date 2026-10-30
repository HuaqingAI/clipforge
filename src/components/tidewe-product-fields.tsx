"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/lib/i18n";
import type { ProductFacts } from "@/lib/tidewe/types";
import { resolveTideweShopCategory, TIDEWE_SHOP_CATEGORIES } from "@/lib/tidewe/categories";

export interface TideweProductInput {
  category: ProductFacts["category"];
  sku: string;
  specifications: string;
  source: string;
}

export function tideweProductInputFromFacts(facts?: ProductFacts | null): TideweProductInput {
  return {
    category: resolveTideweShopCategory(facts?.category) ?? "other",
    sku: facts?.sku ?? "",
    specifications: facts?.items.filter((item) => item.status === "confirmed").map((item) => item.value).join("\n") ?? "",
    source: facts?.items.find((item) => item.status === "confirmed")?.source.ref ?? "",
  };
}

/** Only the specifications explicitly entered here become confirmed claims. */
export function buildTideweProductFacts(input: TideweProductInput, existing?: ProductFacts | null): ProductFacts {
  const retained = existing?.items.filter((item) => item.status !== "confirmed") ?? [];
  const ids = new Set(existing?.items.map((item) => item.id) ?? []);
  const matchedOriginalIds = new Set<string>();
  const keys = new Set(existing?.items.map((item) => item.key.toLowerCase()) ?? []);
  const specifications = input.specifications.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).map((value, index) => {
    const original = existing?.items.find((item) => item.status === "confirmed" && item.value === value && !matchedOriginalIds.has(item.id));
    if (original) { matchedOriginalIds.add(original.id); return original; }
    let id = `manual-${index + 1}`;
    while (ids.has(id)) id += "-new";
    ids.add(id);
    let key = `specification-${index + 1}`;
    while (keys.has(key.toLowerCase())) key += "-new";
    keys.add(key.toLowerCase());
    return { id, key, value, status: "confirmed" as const,
      source: { kind: "manual" as const, ref: input.source.trim() || "user-entered", excerpt: value } };
  });
  return {
    version: 1,
    brand: "TIDEWE",
    category: resolveTideweShopCategory(input.category) ?? "other",
    ...(input.sku.trim() && { sku: input.sku.trim() }),
    ...(existing?.variant && { variant: existing.variant }),
    ...(existing?.blockedClaims && { blockedClaims: existing.blockedClaims }),
    items: [...retained, ...specifications],
  };
}

export function TideweProductFields({ value, onChange, disabled = false, prefix = "tidewe" }: {
  value: TideweProductInput;
  onChange: (value: TideweProductInput) => void;
  disabled?: boolean;
  prefix?: string;
}) {
  const t = useT("tidewe");
  const normalizedValue: TideweProductInput = { ...value, category: resolveTideweShopCategory(value.category) ?? "other" };
  return <fieldset disabled={disabled} className="space-y-4">
    <p className="text-xs leading-relaxed text-muted-foreground">{t("factsHint")}</p>
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-category`}>{t("category")}</Label>
        <select id={`${prefix}-category`} value={normalizedValue.category === "other" ? "" : normalizedValue.category} onChange={(event) => onChange({ ...normalizedValue, category: resolveTideweShopCategory(event.target.value) ?? "other" })} className="h-10 w-full rounded-md border border-border/50 bg-background px-3 text-sm">
          <option value="" disabled>{t("categoryPlaceholder")}</option>
          {TIDEWE_SHOP_CATEGORIES.map((category) => <option value={category} key={category}>{t(`category_${category}`)}</option>)}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-sku`}>{t("sku")}</Label>
        <Input id={`${prefix}-sku`} value={value.sku} placeholder={t("skuPlaceholder")} onChange={(event) => onChange({ ...normalizedValue, sku: event.target.value })} />
      </div>
    </div>
    <div className="space-y-2">
      <Label htmlFor={`${prefix}-specifications`}>{t("specifications")}</Label>
      <Textarea id={`${prefix}-specifications`} rows={4} value={value.specifications} placeholder={t("specificationsPlaceholder")} onChange={(event) => onChange({ ...normalizedValue, specifications: event.target.value })} />
    </div>
    <div className="space-y-2">
      <Label htmlFor={`${prefix}-source`}>{t("source")}</Label>
      <Input id={`${prefix}-source`} value={value.source} placeholder={t("sourcePlaceholder")} onChange={(event) => onChange({ ...normalizedValue, source: event.target.value })} />
    </div>
  </fieldset>;
}
