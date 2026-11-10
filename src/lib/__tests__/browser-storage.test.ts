// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appStorage, exportConfiguration, importConfiguration } from "@/lib/browser-storage";

beforeEach(() => { localStorage.clear(); delete window.clipforge; });
afterEach(() => { delete window.clipforge; vi.restoreAllMocks(); });

describe("Web and desktop configuration storage", () => {
  it("uses Web localStorage when no native bridge is present", () => {
    appStorage.setItem("clipforge_nav_collapsed", "1");
    expect(localStorage.getItem("clipforge_nav_collapsed")).toBe("1");
    appStorage.removeItem("clipforge_nav_collapsed");
    expect(appStorage.getItem("clipforge_nav_collapsed")).toBeNull();
  });
  it("uses the native store independently of the browser origin", () => {
    const data = new Map<string, string>();
    window.clipforge = { storage: {
      getItem: key => data.get(key) ?? null,
      setItem: (key, value) => { data.set(key, value); },
      removeItem: key => { data.delete(key); },
      keys: () => [...data.keys()],
    } };
    appStorage.setItem("clipforge:project:fixture:voiceover", "{}");
    localStorage.clear();
    expect(appStorage.getItem("clipforge:project:fixture:voiceover")).toBe("{}");
    expect(appStorage.keys()).toEqual(["clipforge:project:fixture:voiceover"]);
  });
  it("exports only app settings and omits service secrets by default", () => {
    localStorage.setItem("unrelated", "private");
    appStorage.setItem("daihuo-jianshou-settings", JSON.stringify({ state: { llm: { apiKey: "key-fixture", model: "model" } }, version: 8 }));
    const exported = exportConfiguration();
    expect(exported.entries.unrelated).toBeUndefined();
    expect(JSON.parse(exported.entries["daihuo-jianshou-settings"]).state.llm).toEqual({ apiKey: "", model: "model" });
    expect(exportConfiguration(true).entries["daihuo-jianshou-settings"]).toContain("key-fixture");
  });
  it("round-trips project preferences and raw builtin template ids", () => {
    appStorage.setItem("clipforge-ad-template:project", "builtin-template");
    appStorage.setItem("clipforge:project:project:voiceover", '{"voice":"test"}');
    const exported = exportConfiguration();
    localStorage.clear();
    expect(importConfiguration(exported)).toBe(2);
    expect(appStorage.getItem("clipforge-ad-template:project")).toBe("builtin-template");
  });
  it("validates every key before modifying existing state", () => {
    appStorage.setItem("clipforge_nav_collapsed", "0");
    expect(() => importConfiguration({ format: "clipforge-settings", schemaVersion: 1, entries: { clipforge_nav_collapsed: "1", unrelated: "x" } })).toThrow();
    expect(appStorage.getItem("clipforge_nav_collapsed")).toBe("0");
  });
  it("restores earlier values when a native write fails", () => {
    appStorage.setItem("clipforge_nav_collapsed", "0");
    const original = appStorage.setItem;
    vi.spyOn(appStorage, "setItem").mockImplementation((key, value) => {
      if (key === "clipforge_test") throw new Error("disk full");
      original(key, value);
    });
    expect(() => importConfiguration({ format: "clipforge-settings", schemaVersion: 1, entries: { clipforge_nav_collapsed: "1", clipforge_test: "x" } })).toThrow("disk full");
    expect(appStorage.getItem("clipforge_nav_collapsed")).toBe("0");
  });
});
