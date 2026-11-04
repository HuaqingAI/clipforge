// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildAlignedCaptionsAss, type AlignedCaptionLine } from "@/lib/video-composer/aligned-captions";

function line(text: string, offset = 1, endTime = offset + 4): AlignedCaptionLine {
  return {
    text, startTime: offset - 0.5, endTime,
    words: text.split(" ").map((text, index) => ({ text, startSec: offset + index * 0.3, endSec: offset + index * 0.3 + 0.2 })),
  };
}

function bodyEvents(ass: string): string[] {
  return ass.split("\n").filter(row => row.startsWith("Dialogue: 1,"));
}

function seconds(value: string): number {
  const [h, m, s] = value.split(":").map(Number);
  return h * 3600 + m * 60 + s;
}

function eventText(value: string): string {
  return value.split(",").slice(9).join(",").replace(/\{[^}]+\}/g, "");
}

describe("fixed Komika Axis audio-aligned captions", () => {
  it("uses the approved size, placement and one current yellow word without cumulative karaoke", () => {
    const ass = buildAlignedCaptionsAss([line("A little creek")], { title: "Don't Let A Creek End Your Hunt" });
    expect(ass).toContain("Style: Body,Komika Axis,90,");
    expect(ass).toContain("Style: Title,Komika Axis,72,");
    expect(ass).toContain("\\pos(540,1365)");
    expect(ass).toContain("\\pos(540,178)");
    expect(ass).not.toMatch(/\\k[fFoO]?\d|\\t\(|\\fad\(|\\move\(/);
    const events = bodyEvents(ass);
    expect(events).toHaveLength(3);
    expect(events.map(eventText)).toEqual(["A LITTLE CREEK", "A LITTLE CREEK", "A LITTLE CREEK"]);
    expect(events[0]).toContain("{\\1c&H0DF9FA&}A {\\1c&HFFFFFF&}LITTLE");
    expect(events[1]).toContain("{\\1c&HFFFFFF&}A {\\1c&H0DF9FA&}LITTLE");
    expect(events[2]).toContain("{\\1c&HFFFFFF&}A {\\1c&HFFFFFF&}LITTLE {\\1c&H0DF9FA&}CREEK");
    for (const event of events) expect(event.match(/\\1c&H0DF9FA&/g)).toHaveLength(1);
  });

  it("starts with actual speech rather than the start of the clip and releases after speech", () => {
    const input = line("A little creek", 1.646, 5);
    input.words[0].endSec = 1.666;
    const events = bodyEvents(buildAlignedCaptionsAss([input], { totalDurationSec: 5 }));
    expect(events[0].split(",")[1]).toBe("0:00:01.65");
    expect(seconds(events.at(-1)!.split(",")[2])).toBeCloseTo(2.59, 2);
    for (let index = 0; index < events.length; index++) {
      expect(Math.abs(seconds(events[index].split(",")[1]) - input.words[index].startSec)).toBeLessThanOrEqual(0.0051);
    }
  });

  it("uses short phrases, preserves punctuation and respects pauses and line boundaries", () => {
    const first = line("These TIDEWE rubber boots are waterproof for wet crossings and muddy approaches.");
    const second = line("The tall camo shafts", 5.2, 7);
    first.words[5].endSec = 2.6;
    first.words.slice(6).forEach(word => { word.startSec += 0.7; word.endSec += 0.7; });
    first.endTime = 5.1;
    const events = bodyEvents(buildAlignedCaptionsAss([first, second]));
    const uniquePhrases = [...new Set(events.map(eventText))];
    expect(uniquePhrases.every(text => text.split(" ").length <= 3)).toBe(true);
    expect(uniquePhrases.join(" ")).toBe(`${first.text} ${second.text}`.toUpperCase());
    expect(events).toHaveLength(16);
    const windows = events.map(row => row.split(",").slice(1, 3).map(seconds));
    for (let index = 1; index < windows.length; index++) expect(windows[index - 1][1]).toBeLessThanOrEqual(windows[index][0]);
    expect(windows.some((window, index) => index > 0 && window[0] - windows[index - 1][1] > 0.3)).toBe(true);
  });

  it("prevents double captions where neighbouring shot recordings overlap slightly", () => {
    const first = line("wet leaves,", 0.5, 2);
    first.words[1].endSec = 1.064;
    const second = line("worth a look.", 1.05, 3);
    const events = bodyEvents(buildAlignedCaptionsAss([first, second]));
    expect(events[1].split(",")[2]).toBe("0:00:01.05");
    expect(events[2].split(",")[1]).toBe("0:00:01.05");
  });

  it("scales the same relative placement to landscape and reduces unusually wide text", () => {
    const ass = buildAlignedCaptionsAss([line("WATERPROOFMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM BOOTS")], {
      playResX: 720, playResY: 1280,
      title: "A VERY LONG TITLE ".repeat(15),
    });
    expect(ass).toContain("PlayResX: 720");
    expect(ass).toContain("Style: Body,Komika Axis,60,");
    expect(ass).toContain("\\pos(360,910)");
    expect(bodyEvents(ass)[0]).toMatch(/\\fs\d/);
    expect(ass.split("\n").find(row => row.startsWith("Dialogue: 2,"))).toMatch(/\\fs\d/);
    const landscape = buildAlignedCaptionsAss([line("KEEP FEET DRY")], { playResX: 1920, playResY: 1080 });
    expect(landscape).toContain("\\pos(960,767.81)");
    expect(landscape).toContain("Style: Body,Komika Axis,50.63,");
  });

  it("rejects missing, altered and invalid acoustic timings rather than estimating", () => {
    expect(() => buildAlignedCaptionsAss([{ startTime: 0, endTime: 2, text: "hello", words: [] }])).toThrow(/Real audio word timestamps/);
    const changed = line("hello there");
    changed.text = "a different sentence";
    expect(() => buildAlignedCaptionsAss([changed])).toThrow(/preserve/);
    const backwards = line("hello there");
    backwards.words[1].startSec = 0.6;
    expect(() => buildAlignedCaptionsAss([backwards])).toThrow(/Invalid real audio timestamp/);
    const missing = line("hello");
    missing.words[0].endSec = NaN;
    expect(() => buildAlignedCaptionsAss([missing])).toThrow(/Invalid real audio timestamp/);
  });

  it("gives sub-centisecond neighbouring words positive windows without moving more than one frame", () => {
    const words = [0.101, 0.104, 0.108].map((startSec, index) => ({ text: ["a", "bit", "wet"][index], startSec, endSec: startSec + 0.004 }));
    const events = bodyEvents(buildAlignedCaptionsAss([{ startTime: 0, endTime: 1, words }]));
    expect(events).toHaveLength(3);
    events.forEach((event, index) => {
      const [start, end] = event.split(",").slice(1, 3).map(seconds);
      expect(end).toBeGreaterThan(start);
      expect(Math.abs(start - words[index].startSec)).toBeLessThan(1 / 30);
    });
  });
});
