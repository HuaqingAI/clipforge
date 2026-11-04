import { describe, expect, it } from "vitest";
import { nativeSpeechPacingReport, planNativeSpeechEdits, type NativeSpeechSource } from "@/lib/tidewe/native-speech-edit";

function source(text = "These boots keep the route open through shallow water and muddy approaches."): NativeSpeechSource {
  return { shotId: 1, text, sourceDuration: 7, onCamera: true,
    words: text.split(/\s+/).map((text, index) => ({ text, startSec: 1 + index * 0.4, endSec: 1.3 + index * 0.4, score: 0.9 })) };
}

describe("alignment-derived native speech pacing", () => {
  it("retains every aligned word, allocates existing edge silence and remaps all captions through the edit", () => {
    const input = source();
    const [plan] = planNativeSpeechEdits([input]);
    expect(plan.edit.speed).toBeGreaterThan(1);
    expect(plan.edit.speed).toBeLessThanOrEqual(1.5);
    expect(plan.edit.startSec).toBeLessThan(input.words[0].startSec);
    expect(plan.edit.endSec).toBeGreaterThan(input.words.at(-1)!.endSec);
    expect(plan.edit.endSec).toBeLessThanOrEqual(input.sourceDuration);
    expect(plan.duration - input.words.length * 60 / 195).toBeGreaterThanOrEqual(-0.000001);
    expect(plan.duration - input.words.length * 60 / 195).toBeLessThan(1 / 30);
    expect(plan.duration * 30).toBeCloseTo(Math.round(plan.duration * 30), 8);
    expect(plan.words.map(word => word.text)).toEqual(input.words.map(word => word.text));
    plan.words.forEach((word, index) => {
      expect(word.startSec * plan.edit.speed + plan.edit.startSec).toBeCloseTo(input.words[index].startSec, 8);
      expect(word.endSec * plan.edit.speed + plan.edit.startSec).toBeCloseTo(input.words[index].endSec, 8);
      expect(word.endSec).toBeLessThan(plan.duration);
    });
  });

  it("keeps a fast short CTA at original speed and never creates source footage after the end", () => {
    const input = source("they're worth a look.");
    input.sourceDuration = 1.27;
    input.words = input.words.map((word, index) => ({ ...word, startSec: 0.4 + index * 0.2, endSec: 0.56 + index * 0.2 }));
    const [plan] = planNativeSpeechEdits([input]);
    expect(plan.edit.speed).toBe(1);
    expect(plan.edit.endSec).toBeLessThanOrEqual(1.27);
    expect(plan.words.at(-1)!.endSec).toBeLessThanOrEqual(plan.duration);
  });

  it("caps correction on a slow sentence and reports the real output density without claiming content verification", () => {
    const input = source("These boots fit well on the trail.");
    input.sourceDuration = 15;
    input.words = input.words.map((word, index) => ({ ...word, startSec: 1 + index, endSec: 1.8 + index }));
    const [plan] = planNativeSpeechEdits([input]);
    expect(plan.edit.speed).toBe(1.5);
    expect(plan.correctionLimited).toBe(true);
    const report = nativeSpeechPacingReport([plan], 7, 10);
    expect(report).toMatchObject({ actualDurationSec: 10, averageWpm: 42, status: "outside_target", contentVerification: "not_performed" });
    expect(() => nativeSpeechPacingReport([plan], 7, 0)).toThrow("成片时长");
  });

  it.each([
    (input: NativeSpeechSource) => { input.words = []; },
    (input: NativeSpeechSource) => { input.words.pop(); },
    (input: NativeSpeechSource) => { input.words[0].startSec = -1; },
    (input: NativeSpeechSource) => { input.words[0].score = 0.01; },
    (input: NativeSpeechSource) => { input.words[0].text = "wrong"; },
    (input: NativeSpeechSource) => { input.words[1].startSec = input.words[0].startSec; },
  ])("fails closed on incomplete or unsafe alignment", change => {
    const input = source(); change(input);
    expect(() => planNativeSpeechEdits([input])).toThrow("未裁切口播");
  });
});
