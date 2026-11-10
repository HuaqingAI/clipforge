// Runs only against an isolated probe profile and database, never a user window.
async function inspectRenderer() {
  const until = async (check, message) => {
    const deadline = Date.now() + 15_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(message);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  if (!document.body?.innerText.includes("ClipForge") || !document.querySelector('a[href="/settings"]')) throw new Error("打包页面未呈现 ClipForge 主界面。");
  const storage = window.clipforge?.storage;
  if (!storage) throw new Error("客户端 preload 配置桥接未加载。");
  const key = "clipforge:desktop-smoke";
  const previous = storage.getItem(key);
  try {
    storage.setItem(key, "renderer-ipc-verified");
    if (storage.getItem(key) !== "renderer-ipc-verified" || !storage.keys().includes(key)) throw new Error("客户端配置写入或枚举失败。");
    storage.removeItem(key);
    if (storage.getItem(key) !== null || storage.keys().includes(key)) throw new Error("客户端配置删除失败。");
  } finally {
    if (previous === null) storage.removeItem(key);
    else storage.setItem(key, previous);
  }
  // A real React event proves hydration, not just successful server HTML.
  await until(() => document.querySelector('button[title="Switch to English"],button[title="切换到中文"]'), "语言按钮未加载。");
  const button = document.querySelector('button[title="Switch to English"],button[title="切换到中文"]');
  const expectedLocale = button.title === "Switch to English" ? "en" : "zh";
  button.click();
  await until(() => {
    const persisted = JSON.parse(storage.getItem("daihuo-jianshou-settings") || "{}");
    return persisted.state?.locale === expectedLocale && persisted.state?.localeSource === "user" && document.documentElement.lang === (expectedLocale === "en" ? "en" : "zh-CN");
  }, "打包页面 React 交互未就绪。");
  const urls = [...document.querySelectorAll('script[src],link[rel="stylesheet"][href]')]
    .map((element) => new URL(element.src || element.href, location.href))
    .filter((url) => url.origin === location.origin && url.pathname.startsWith("/_next/"));
  if (!urls.some((url) => url.pathname.endsWith(".js")) || !urls.some((url) => url.pathname.endsWith(".css"))) throw new Error("打包页面缺少 Next JS/CSS 静态资源。");
  await Promise.all(urls.map(async (url) => {
    const response = await fetch(url.href, { cache: "no-store" });
    if (!response.ok || !(await response.arrayBuffer()).byteLength) throw new Error(`打包静态资源加载失败：${url.pathname}`);
  }));
  return { storage: true, hydrated: true, staticResources: urls.length };
}

async function probeRenderer(window, { timeoutMs = 45_000 } = {}) {
  if (window.isVisible()) throw new Error("桌面验证窗口不应显示。");
  let shown = false;
  let timer;
  const onShow = () => { shown = true; };
  window.on("show", onShow);
  try {
    const result = await Promise.race([
      window.webContents.executeJavaScript(`(${inspectRenderer.toString()})()`),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("桌面页面验证超时。")), timeoutMs); }),
    ]);
    if (shown || window.isVisible()) throw new Error("桌面验证期间窗口意外显示。");
    return result;
  } finally {
    clearTimeout(timer);
    window.removeListener("show", onShow);
  }
}

module.exports = { probeRenderer };
