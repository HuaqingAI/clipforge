// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createTideweOutdoorProfile } from "@/lib/creative-profiles";
import type { ScriptGenerationInput } from "@/lib/script-engine/prompts";
import { productFactsFromDescription } from "@/lib/tidewe/facts";
import { buildTideweCategoryGuidance } from "@/lib/tidewe/category-guidance";
import type { ProductFacts } from "@/lib/tidewe/types";
import {
  buildTideweCopyPrompt,
  buildTideweImportedCopyPrompt,
  selectTideweExamples,
  tideweFactsForInput,
  TIDEWE_APPROVED_KLING_PATTERNS,
  TIDEWE_COPY_SYSTEM_PROMPT,
  TIDEWE_IMPORTED_COPY_SYSTEM_PROMPT,
  TIDEWE_PLAN_SYSTEM_PROMPT,
} from "@/lib/tidewe/prompts";

const facts = productFactsFromDescription("An adjustable shoulder strap", "other");
const input: ScriptGenerationInput = {
  productName: "Current field bag",
  category: "fashion",
  styleType: "tidewe_outdoor",
  productFacts: facts,
  creativeProfile: createTideweOutdoorProfile(),
};

describe("TIDEWE copy and planning prompt boundaries", () => {
  it("requires 7-9 shots independently for initial generation, regeneration and supplied-copy planning", () => {
    const payload = JSON.parse(buildTideweCopyPrompt(input, 3));
    expect(payload.shotCount).toEqual({ min: 7, max: 9 });
    expect(TIDEWE_COPY_SYSTEM_PROMPT).toContain("Each complete copy must support 7-9 semantic shots");
    expect(TIDEWE_COPY_SYSTEM_PROMPT).toContain("every candidate on initial generation and regeneration");
    expect(TIDEWE_COPY_SYSTEM_PROMPT).toContain("visualBeats are meaning blocks, not the shot count");
    expect(TIDEWE_COPY_SYSTEM_PROMPT).toContain("wordCount / 2.6 + 7 * 0.3 must fit targetDuration");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("Every copy MUST have 7-9 shots inclusive");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("Never return fewer than 7 or more than 9 shots for any copy");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("regardless of target duration, copy source, initial generation or regeneration");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("Apply this count to each candidate independently");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("extend the total duration within that shot-count range");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).not.toContain("fewer/more when meaning and duration require");
  });

  it("grounds AI copy in the current facts while supplying attributed visual patterns instead of borrowed product specifications", () => {
    const payload = JSON.parse(buildTideweCopyPrompt(input, 2));
    expect(payload.task).toContain("2 distinct complete spoken pieces");
    expect(payload.product.facts).toEqual(facts);
    expect(payload.copyBrief).toMatchObject({
      progression: expect.stringContaining("one supported value"),
      filmability: expect.stringContaining("unsupported test"),
      evidence: expect.stringContaining("observed appearance supports appearance only"),
    });
    expect(payload.approvedKlingPatterns).toEqual(TIDEWE_APPROVED_KLING_PATTERNS);
    expect(payload.approvedKlingPatterns.scope).toContain("original first-frame image prompts are unavailable");
    expect(payload.approvedKlingPatterns.scope).toContain("not a complete script sequence");
    expect(payload.approvedKlingPatterns.applicability).toContain("current product facts and references");
    for (const pattern of payload.approvedKlingPatterns.patterns) {
      expect(pattern.recordIds.length).toBeGreaterThan(0);
      expect(pattern.recordIds.every((id: number) => Number.isInteger(id) && id >= 1 && id <= 50)).toBe(true);
      expect(pattern).not.toHaveProperty("scriptSegment");
      expect(pattern).not.toHaveProperty("claimedFactIds");
    }
    expect(TIDEWE_COPY_SYSTEM_PROMPT).toContain("observable detail or simple use action");
    expect(TIDEWE_COPY_SYSTEM_PROMPT).toContain("bounded user benefit");
    expect(TIDEWE_COPY_SYSTEM_PROMPT).toContain("must not be promoted into confirmed fact citations");
    expect(TIDEWE_COPY_SYSTEM_PROMPT).toContain("Not every sentence needs a demonstration");
    expect(payload.outputFormat.copies[0].visualBeats[0]).toMatchObject({
      text: payload.outputFormat.copies[0].text,
      visualRole: "presenter",
      visualIdea: expect.stringMatching(/[\u3400-\u9fff]/u),
      factRefs: [],
    });
    expect(TIDEWE_COPY_SYSTEM_PROMPT).toContain("cover the full text exactly once");
  });

  it("writes speakable native copy that can continue over narrated details without turning the text into shot directions", () => {
    const native = JSON.parse(buildTideweCopyPrompt(input));
    expect(native.speechMode).toContain("speaks directly to camera");
    expect(native.speechMode).toContain("without requiring a visible face for every line");
    expect(TIDEWE_COPY_SYSTEM_PROMPT).toContain("short speakable clauses");
    expect(TIDEWE_COPY_SYSTEM_PROMPT).toContain("camera directions, gestures in brackets");
    const post = JSON.parse(buildTideweCopyPrompt({ ...input, creativeProfile: createTideweOutdoorProfile({ speechMode: "voiceover" }) }));
    expect(post.speechMode).toContain("offscreen voiceover");
    expect(post.speechMode).not.toContain("speaks directly to camera");
  });

  it("keeps staff copy annotation isolated from the new AI writing brief and pattern guidance", () => {
    const original = "“I've used this for 3 seasons.”\r\n\r\nWait.  Wait. Buy now if it fits.";
    const imported = { ...input, copyText: original };
    const payload = JSON.parse(buildTideweCopyPrompt(imported, 3));
    expect(payload).toEqual(JSON.parse(buildTideweImportedCopyPrompt(imported)));
    expect(payload.frozenImportedCopy).toBe(original);
    for (const key of ["copyBrief", "approvedKlingPatterns", "styleExamples", "targetDuration"]) {
      expect(payload).not.toHaveProperty(key);
    }
    expect(payload.outputFormat.copies).toHaveLength(1);
    expect(payload.outputFormat.copies[0]).not.toHaveProperty("text");
    expect(payload.outputFormat.copies[0]).not.toHaveProperty("visualBeats");
    expect(TIDEWE_IMPORTED_COPY_SYSTEM_PROMPT).toContain("Never paraphrase, polish, shorten, extend or censor");
    expect(TIDEWE_IMPORTED_COPY_SYSTEM_PROMPT).not.toContain("approvedKlingPatterns");
  });

  it("asks for structured shot observations, role and scale variation without forcing a separate demonstration for every clause", () => {
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("visualPlan:{framing,visualRole,actionStart,action,actionEnd,productFocus?}");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("wide|medium|close_up|detail");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("presenter|demonstration|detail|context");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("at least three meaningful framing scales and at least two visual roles");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("Static context does not require a person or fabricated product movement");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("Do not illustrate every clause literally");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("Never squeeze long imported text into the target duration");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("2.6 words per second with at least 0.3 seconds reserved");
  });

  it("keeps near, middle and existing distant scene structure readable without a portrait-style blur layer", () => {
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("full-body and medium views, use ordinary phone main-camera deep focus");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("nearby ground and midground stay naturally clear");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("Where already present, midground and farther tree trunks, branches, path layers and scene silhouettes remain recognizable");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("at most slight optical softness in the distance");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("Avoid broad creamy blur, bokeh disks, portrait-mode masks");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).not.toMatch(/moderate natural depth of field|distant scenery soften gradually with distance/);
  });

  it("allows only slight component-shot softness and corrects overcrisp subjects without inventing background texture", () => {
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("ALL visible foreground in front of the subject must remain naturally resolved");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("isolated near grass, leaves and edge objects disconnected from the product or support");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("Only distant background BEHIND the subject may have slight natural optical softness");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("No nearer-object defocus exception applies");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("When designing a NEW shot, keep vegetation out of the space immediately against the lens");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("Once a shot is approved, focus repair must preserve its camera and framing");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("existing surroundings must retain readable structure");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("do not add scenery to illustrate these examples or require every leaf or distance plane equally sharp");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("remove selective or global sharpening and local microcontrast processing");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("Preserve intentional empty backgrounds; do not add scenery");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("Preserve presenter identity, actual product markings");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("do not invent fine texture or hidden structure to create clarity");
  });

  it("protects a continuous supporting surface through the lower frame edge in all framing scales", () => {
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("In every framing scale, including close_up and detail");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("where an existing ground, tabletop or other supporting surface already extends continuously from the image's bottom edge through to the subject's contact point, keep that whole region naturally readable");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("Do not add or extend a supporting surface to satisfy this rule");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("Protect the main product, contact area, connected supporting surface and its visible lower frame edge from defocus");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("Do not create a blurred foreground strip, tilt-shift top-and-bottom blur bands or vignette-like edge defocus");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("Do not change the approved aspect ratio, crop, composition, action or product support to satisfy focus requirements");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).not.toContain("Close component shots may retain slight physically plausible softness nearer or farther than the focus plane");
  });

  it("keeps observable product evidence filmable when confirmed performance facts are empty", () => {
    const observations = "高筒迷彩靴，筒口侧有扣带，外底有沟槽。";
    const payload = JSON.parse(buildTideweCopyPrompt({ ...input, productName: "男士防蛇狩猎靴", productFacts: productFactsFromDescription("", "waterproof_boots"), productAnalysis: observations }));
    expect(payload.product.visualObservations).toBe(observations);
    expect(payload.product.facts.items).toEqual([]);
    expect(payload.copyBrief.filmability).toContain("actual product central");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("an empty facts.items array does not mean there is nothing visible to film");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("same visualRole must overlap the beat's actual spoken text");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("Every productVisible=true shot MUST include productFocus");
    expect(TIDEWE_PLAN_SYSTEM_PROMPT).toContain("Do not crop the current product or working part out of frame just to show a face");
  });

  it.each([
    { category: "hunting_blind", name: "TIDEWE hunting blind", expected: "hunting_blind", products: ["BL022"] },
    { category: "waders", name: "TIDEWE waders", expected: "waders", products: ["WD012"] },
    { category: "heated_apparel", name: "TIDEWE heated jacket", expected: "heated_gear", products: ["JTC001", "HJ006"] },
    { category: "hunting_apparel", name: "TIDEWE unheated clothing", expected: "apparel", products: [] },
    { category: "waterproof_boots", name: "TIDEWE hunting boots", expected: "boots", products: [] },
    { category: "hunting_chair", name: "TIDEWE hunting chair", expected: "accessories", products: ["THC003", "THC004"] },
  ] as const)("uses only $expected guidance and true category corpus examples for $category", ({ category, name, expected, products }) => {
    const originalFacts: ProductFacts = { version: 1, brand: "TIDEWE", category, items: [] };
    const categoryInput = { ...input, productName: name, productFacts: originalFacts, productAnalysis: "当前参考中真实可见的商品与接触处。" };
    const payload = JSON.parse(buildTideweCopyPrompt(categoryInput));
    expect(payload.categoryGuidance).toEqual(buildTideweCategoryGuidance(expected, { productName: name, visualObservations: categoryInput.productAnalysis }));
    expect(payload.categoryGuidance.category).toBe(expected);
    expect(payload.categoryGuidance.productFocusExample).toMatch(/[\u3400-\u9fff]/u);
    expect(payload.categoryGuidance.contactAndFocus).toMatch(/[\u3400-\u9fff]/u);
    expect(payload.product.facts.category).toBe(expected);
    expect(originalFacts.category).toBe(category);
    const examples = selectTideweExamples(originalFacts, payload.narrativeAngle);
    expect(examples.every(example => (products as readonly string[]).includes(example.product))).toBe(true);
    expect(payload.styleExamples.map((example: { id: string }) => example.id)).toEqual(examples.map(example => `${example.product}-${example.source.sheet}-${example.source.row}`));
    if (products.length) expect(examples.length).toBeGreaterThan(0);
    else expect(payload.styleExamples).toEqual([]);
    if (expected === "accessories") expect(payload.categoryGuidance).toMatchObject({ subtype: "chair", productFocusExample: expect.stringContaining("座面") });
  });

  it("ranks SKU and gift angle only after the current category has filtered the examples", () => {
    const boots: ProductFacts = { ...facts, category: "boots", sku: "WD012" };
    expect(selectTideweExamples(boots, "gift")).toEqual([]);
    const blind: ProductFacts = { ...facts, category: "hunting_blind", sku: "JTC001" };
    expect(selectTideweExamples(blind, "gift").every(example => example.product === "BL022")).toBe(true);
    const heated: ProductFacts = { ...facts, category: "heated_gear", sku: "HJ006" };
    expect(selectTideweExamples(heated)[0].product).toBe("HJ006");
    expect(selectTideweExamples({ ...heated, sku: undefined }, "gift")[0].source.row).toBe(30);
  });

  it.each([
    { category: "配件", hint: "boots", expected: "accessories" },
    { category: "clothing", hint: "boots", expected: "apparel" },
    { category: undefined, hint: "配件", expected: "accessories" },
    { category: "other", hint: "boots", expected: "other" },
    { category: "unknown_category", hint: "boots", expected: "other" },
  ])("resolves fresh facts $category and hint $hint to $expected without overriding explicit facts", ({ category, hint, expected }) => {
    const productFacts = category === undefined ? undefined : { ...facts, category: category as ProductFacts["category"] };
    const original = structuredClone(productFacts);
    const freshInput = { ...input, productFacts, productCategoryHint: hint };
    expect(tideweFactsForInput(freshInput).category).toBe(expected);
    const payload = JSON.parse(buildTideweCopyPrompt(freshInput));
    expect(payload.product.facts.category).toBe(expected);
    expect(payload.categoryGuidance.category).toBe(expected === "other" ? "unspecified" : expected);
    expect(productFacts).toEqual(original);
  });

  it("keeps unknown categories generic without importing a known SKU's style examples", () => {
    const unknown: ProductFacts = { ...facts, category: "future_category" as ProductFacts["category"], sku: "WD012" };
    expect(selectTideweExamples(unknown, "gift")).toEqual([]);
    const payload = JSON.parse(buildTideweCopyPrompt({ ...input, productFacts: unknown }));
    expect(payload.categoryGuidance.category).toBe("unspecified");
    expect(payload.categoryGuidance).not.toHaveProperty("subtype");
    expect(payload.styleExamples).toEqual([]);
    expect(tideweFactsForInput({ ...input, productFacts: unknown }).category).toBe("other");
    expect(unknown.category).toBe("future_category");
  });

  it("passes current category guidance to staff annotation for visual use without rewriting the frozen text", () => {
    const original = "“Check this chair,” I say.\r\n\r\nWait.  Wait.";
    const payload = JSON.parse(buildTideweImportedCopyPrompt({ ...input, productName: "TIDEWE hunting chair", productFacts: { ...facts, category: "hunting_chair" }, copyText: original }));
    expect(payload.categoryGuidance).toMatchObject({ category: "accessories", subtype: "chair" });
    expect(payload.categoryGuidanceUse).toContain("Visual planning only");
    expect(payload.categoryGuidanceUse).toContain("Preserve frozenImportedCopy exactly");
    expect(payload.frozenImportedCopy).toBe(original);
    expect(payload).not.toHaveProperty("styleExamples");
    expect(payload.outputFormat.copies[0]).not.toHaveProperty("text");
    expect(TIDEWE_IMPORTED_COPY_SYSTEM_PROMPT).toContain("not an instruction to rewrite, restyle or change the angle");
  });

  it("keeps SKU exclusions scoped to the explicitly selected product and global systems category neutral", () => {
    const withoutSku = JSON.parse(buildTideweCopyPrompt(input));
    expect(withoutSku.currentProductSafeguards).toEqual([]);
    const selected = JSON.parse(buildTideweCopyPrompt({ ...input, productFacts: { ...facts, category: "heated_gear", sku: "HJ006" } }));
    expect(selected.currentProductSafeguards).toEqual([{ sku: "HJ006", restriction: expect.stringContaining("battery sold separately") }]);
    expect(selected.currentProductSafeguards).toHaveLength(1);
    for (const system of [TIDEWE_COPY_SYSTEM_PROMPT, TIDEWE_PLAN_SYSTEM_PROMPT]) {
      expect(system).toContain("categoryGuidance");
      expect(system).not.toMatch(/HJ006|JTC001|THC00[34]|WD012|BL02[25]/);
      expect(system).not.toMatch(/tall boot shaft|outsole|For boots|worn boot/);
    }
  });
});
