import { describe, it, expect } from "vitest";
import { fingerprintOf, pairSimilarity, homogeneityReport, SIMILARITY_THRESHOLD } from "@/lib/structure-fingerprint";

describe("structure fingerprint + homogeneity report", () => {
  const tpl = (over: Partial<Parameters<typeof fingerprintOf>[0]> = {}) =>
    fingerprintOf({
      styleType: "pain_point",
      shots: [
        { duration: 3, type: "hook" },
        { duration: 5, type: "pain_point" },
        { duration: 5, type: "product_intro" },
        { duration: 4, type: "cta" },
      ],
      ...over,
    });

  it("fingerprints shot structure", () => {
    const f = tpl();
    expect(f).toMatchObject({ styleType: "pain_point", hookType: "hook", shotCount: 4, totalSec: 17 });
    expect(f.avgShotSec).toBeCloseTo(4.25);
  });

  it("identical structures score ~1, different ones score low", () => {
    expect(pairSimilarity(tpl(), tpl())).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
    const different = fingerprintOf({
      styleType: "story",
      shots: [
        { duration: 6, type: "scene" },
        { duration: 12, type: "story" },
      ],
    });
    expect(pairSimilarity(tpl(), different)).toBeLessThan(0.3);
  });

  it("verdicts scale with the share of template-alike pairs", () => {
    const risk = homogeneityReport([tpl(), tpl(), tpl()]);
    expect(risk.verdict).toBe("risk");
    expect(risk.similarPairs.length).toBe(3);
    expect(risk.message.zh).toContain("限流");
    const varied = homogeneityReport([
      tpl(),
      fingerprintOf({ styleType: "story", shots: [{ duration: 6, type: "scene" }, { duration: 12, type: "story" }] }),
      fingerprintOf({ styleType: "comparison", shots: [{ duration: 2, type: "hook" }, { duration: 4, type: "compare" }, { duration: 4, type: "cta" }] }),
    ]);
    expect(varied.verdict).toBe("ok");
    const empty = homogeneityReport([]);
    expect(empty.verdict).toBe("ok");
  });
});
