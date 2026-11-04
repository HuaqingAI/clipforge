import { describe, expect, it } from "vitest";
import { englishWordCount, estimateTideweDuration, getTideweGenerationDuration, getTideweWordBudget } from "@/lib/tidewe/pacing";

describe("TIDEWE final-film pacing estimates", () => {
  it("budgets 30/40/60 second films including their pauses", () => {
    expect(getTideweWordBudget(30)).toEqual({ target: 98, min: 95, max: 100 });
    expect(getTideweWordBudget(40)).toEqual({ target: 130, min: 127, max: 133 });
    expect(getTideweWordBudget(60)).toEqual({ target: 195, min: 190, max: 200 });
    // The existing 63-word copy needs about 19.4s, not the previous 27.4s speech estimate.
    expect(estimateTideweDuration(63)).toBe(19.4);
    expect(estimateTideweDuration(130)).toBe(40);
  });

  it("counts the same frozen English tokens across client and server", () => {
    expect(englishWordCount("TIDEWE's full-zip jacket doesn't use 3 separate coats.")).toBe(8);
    expect(englishWordCount("they’re worth a look.")).toBe(4);
    expect(englishWordCount("")).toBe(0);
  });

  it("separates a model's generation slot from the usable speech edit", () => {
    expect(getTideweGenerationDuration(1.2, 4)).toBe(4);
    expect(getTideweGenerationDuration(5.4, 12)).toBe(6);
    // A manually shortened slot must still leave time for the complete line.
    expect(getTideweGenerationDuration(2, 20)).toBe(6);
    expect(getTideweGenerationDuration(2, 60)).toBeGreaterThan(15);
  });

  it("does not turn invalid timings into plausible generation requests", () => {
    for (const invalid of [NaN, Infinity, -1]) {
      expect(() => estimateTideweDuration(invalid)).toThrow();
      expect(() => getTideweWordBudget(invalid)).toThrow();
      expect(() => getTideweGenerationDuration(invalid, 10)).toThrow();
      expect(() => getTideweGenerationDuration(5, invalid)).toThrow();
    }
  });
});
