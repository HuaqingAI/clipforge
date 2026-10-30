/** Current TIDEWE SHOP navigation order; an unset value is not a product category. */
export const TIDEWE_SHOP_CATEGORIES = ["hunting_blind", "waders", "heated_gear", "apparel", "boots", "accessories"] as const;
export type TideweShopCategory = (typeof TIDEWE_SHOP_CATEGORIES)[number];

const SHOP_ALIASES: Readonly<Record<string, TideweShopCategory>> = {
  hunting_blind: "hunting_blind", hunting_blinds: "hunting_blind", blind: "hunting_blind", blinds: "hunting_blind", hunting_tent: "hunting_blind", tent: "hunting_blind", "狩猎帐篷": "hunting_blind", "帐篷": "hunting_blind", "猎帐": "hunting_blind",
  waders: "waders", wader: "waders", "涉水服": "waders", "涉水裤": "waders", "水裤": "waders",
  heated_gear: "heated_gear", heated_apparel: "heated_gear", heated_clothing: "heated_gear", "加热装备": "heated_gear", "加热服饰": "heated_gear",
  apparel: "apparel", hunting_apparel: "apparel", clothing: "apparel", "服装": "apparel", "狩猎服饰": "apparel", "迷彩服饰": "apparel",
  boots: "boots", boot: "boots", waterproof_boots: "boots", hunting_boots: "boots", "靴子": "boots", "防水靴": "boots", "狩猎靴": "boots",
  accessories: "accessories", accessory: "accessories", hunting_chair: "accessories", hunting_chairs: "accessories", chair: "accessories", chairs: "accessories", "配件": "accessories", "狩猎椅": "accessories",
};

/** Canonicalize editable UI values without rewriting stored fact snapshots. */
export function resolveTideweShopCategory(value: unknown): TideweShopCategory | undefined {
  if (typeof value !== "string") return undefined;
  const alias = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return Object.hasOwn(SHOP_ALIASES, alias) ? SHOP_ALIASES[alias] : undefined;
}
