import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StartPage from "@/app/start/page";
import BatchPage from "@/app/batch/page";
import ClonePage from "@/app/project/clone/page";
import TopicPage from "@/app/project/topic/page";

const navigation = vi.hoisted(() => ({ redirect: vi.fn(() => { throw new Error("redirect"); }) }));
vi.mock("next/navigation", () => ({ redirect: navigation.redirect }));
vi.mock("@/lib/i18n", () => ({ useT: (namespace: string) => (key: string) => `${namespace}.${key}`, useLocale: () => "zh" }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json([])));
  navigation.redirect.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("shared desktop and Web creation entry points", () => {
  it("offers the TIDEWE form directly from the start page", async () => {
    await act(async () => root.render(createElement(StartPage)));
    const entry = container.querySelector('a[href="/project/new"]');
    expect(entry?.textContent).toContain("tidewe.label");
    expect(entry?.textContent).toContain("tidewe.description");
    expect(container.querySelectorAll('a[href^="/project/new"]')).toHaveLength(1);
    expect(container.textContent).not.toContain("creationTypeSales");
  });

  it.each([BatchPage, ClonePage, TopicPage])("redirects a retired sales shortcut to the TIDEWE form", (Page) => {
    expect(() => Page()).toThrow("redirect");
    expect(navigation.redirect).toHaveBeenCalledWith("/project/new");
    expect(fetch).not.toHaveBeenCalled();
  });
});
