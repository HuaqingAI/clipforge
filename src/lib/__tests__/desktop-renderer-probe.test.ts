// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";

const { probeRenderer } = createRequire(import.meta.url)("../../../electron/renderer-probe.cjs");

function fixture({ preload = true, assets = true, visible = false } = {}) {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    keys: () => [...values.keys()],
  };
  const document = {
    body: { innerText: "ClipForge 项目 设置" },
    documentElement: { lang: "zh-CN" },
    querySelector(selector: string): object {
      return selector.startsWith("a[") ? {} : button;
    },
    querySelectorAll: () => [{ src: "/_next/static/app.js" }, { href: "/_next/static/app.css" }],
  };
  const button = {
    title: "Switch to English",
    click() {
      document.documentElement.lang = "en";
      storage.setItem("daihuo-jianshou-settings", JSON.stringify({ state: { locale: "en", localeSource: "user" } }));
    },
  };
  const fetch = async () => ({ ok: assets, arrayBuffer: async () => new Uint8Array([1]).buffer });
  const browser = Object.assign(new EventEmitter(), {
    isVisible: () => visible,
    webContents: {
      executeJavaScript: (code: string) => runInNewContext(code, {
        document, window: { clipforge: preload ? { storage } : undefined },
        location: new URL("http://127.0.0.1:32001/start"), URL, fetch, setTimeout,
      }),
    },
  });
  return { browser, values };
}

describe("packaged renderer probe", () => {
  it("exercises page hydration, every preload storage operation and actual Next asset requests", async () => {
    const { browser, values } = fixture();
    await expect(probeRenderer(browser)).resolves.toMatchObject({ storage: true, hydrated: true, staticResources: 2 });
    expect(values.has("clipforge:desktop-smoke")).toBe(false);
    expect(JSON.parse(values.get("daihuo-jianshou-settings")!).state.localeSource).toBe("user");
    expect(browser.listenerCount("show")).toBe(0);
  });
  it("fails when asar/preload loading leaves the renderer without its storage bridge", async () => {
    await expect(probeRenderer(fixture({ preload: false }).browser)).rejects.toThrow(/preload/);
  });
  it("fails when packaged static resources return an error", async () => {
    await expect(probeRenderer(fixture({ assets: false }).browser)).rejects.toThrow(/静态资源加载失败/);
  });
  it("rejects a visible probe window", async () => {
    await expect(probeRenderer(fixture({ visible: true }).browser)).rejects.toThrow(/不应显示/);
  });
  it("times out if a renderer never returns, removing its event listener", async () => {
    const { browser } = fixture();
    browser.webContents.executeJavaScript = () => new Promise(() => {});
    await expect(probeRenderer(browser, { timeoutMs: 20 })).rejects.toThrow(/验证超时/);
    expect(browser.listenerCount("show")).toBe(0);
  });
});
