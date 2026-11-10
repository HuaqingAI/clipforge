// The desktop renderer and local-web UI share the ordinary Node/Next backend.
// Large runtimes are downloaded by the installer, never embedded in app.asar.
const { app, BrowserWindow, dialog, ipcMain, Menu, Tray, nativeImage, shell, safeStorage, powerMonitor } = require("electron");
const { spawn, execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { prepareRuntime, verifyRuntime } = require("./runtime-manager.cjs");
const { createSettingsStore } = require("./settings.cjs");
const { acquireWorkspaceLock, readLocalJson, readHealth, assertHealthy } = require("./desktop-service.cjs");
const { resolveWorkspaceSelection, loadWorkspace, saveWorkspace } = require("./workspace.cjs");
const { probeRenderer } = require("./renderer-probe.cjs");
const { trustedSetupEvent: isTrustedSetupEvent } = require("./setup-window.cjs");

const installMode = process.argv.includes("--install-runtime");
const probeMode = Boolean(process.env.HEADLESS_SMOKE) || process.argv.includes("--verify-runtime");
const silent = process.argv.includes("--silent") || Boolean(process.env.HEADLESS_SMOKE);
const setupFile = path.join(__dirname, "setup.html");
let temporaryUserData;
if (probeMode) {
  temporaryUserData = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-desktop-probe-"));
  app.setPath("userData", temporaryUserData);
}

let serverChild;
let serverUrl;
let mainWindow;
let setupWindow;
let tray;
let quitting = false;
let exitPromise;
let releaseWorkspace;
let logFilePath;
let runtime;
let settings;
let setupRunning = false;
let setupController;
let setupCancelled = false;
let backendFailure;
let serverStopPromise;
let lastProgressLog = { key: "", time: 0 };
const childPids = new Set();
const temporaryDataDirs = new Set();

// An installer must fail if an existing application owns the profile; returning
// success here would otherwise make NSIS skip all resource preparation.
if (!app.requestSingleInstanceLock()) {
  app.exit(installMode || probeMode ? 2 : 0);
} else {
  app.on("second-instance", (_event, argv) => {
    if (argv.includes("--install-runtime")) {
      void dialog.showMessageBox({ type: "info", title: "ClipForge 安装", message: "请先彻底退出当前 ClipForge，再重新运行安装程序。" });
      return;
    }
    showWindow();
  });
  app.whenReady().then(start).catch(fail);
}

function initLog() {
  const directory = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(directory, { recursive: true });
  logFilePath = path.join(directory, installMode ? "install.log" : "server.log");
  fs.appendFileSync(logFilePath, `\n=== ${new Date().toISOString()} ${process.platform}/${process.arch} ${installMode ? "install" : probeMode ? "probe" : "start"} ===\n`);
}
function log(message) {
  if (logFilePath) { try { fs.appendFileSync(logFilePath, `[main] ${message}\n`); } catch { /* diagnostics must not crash the app */ } }
}
function runtimeOptions() {
  const testMode = installMode || probeMode;
  const manifestPath = testMode && process.env.CLIPFORGE_RUNTIME_MANIFEST || (app.isPackaged
    ? path.join(process.resourcesPath, "desktop-runtime-manifest.json")
    : path.join(__dirname, "..", "artifacts", "runtime", "desktop-runtime-manifest.json"));
  const baseDir = testMode && process.env.CLIPFORGE_RUNTIME_BASE_DIR || (process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || path.join(app.getPath("home"), "AppData", "Local"), "ClipForge")
    : path.join(app.getPath("userData"), "managed-resources"));
  const supportDir = testMode && process.env.CLIPFORGE_RUNTIME_SUPPORT_DIR || (app.isPackaged
    ? path.join(process.resourcesPath, "runtime-support")
    : path.join(__dirname, "..", "artifacts", "runtime", "support"));
  return { manifestPath, baseDir, supportDir, allowHttpForTests: testMode && process.env.CLIPFORGE_RUNTIME_ALLOW_HTTP_TESTS === "1" };
}
function serverEntry() {
  if (app.isPackaged) return path.join(process.resourcesPath, "standalone", "server.js");
  const staged = path.join(__dirname, "..", "artifacts", "desktop", `${process.platform}-${process.arch}`, "standalone", "server.js");
  return fs.existsSync(staged) ? staged : path.join(__dirname, "..", ".next-desktop", "standalone", "server.js");
}
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close((error) => error ? reject(error) : resolve(port)); });
  });
}
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function startServer({ isolated = false } = {}) {
  const entry = serverEntry();
  if (!fs.existsSync(entry)) throw new Error("桌面服务文件缺失，请重新安装 ClipForge。");
  const serverDir = path.dirname(entry);
  const dataDir = isolated ? fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-install-check-")) : loadWorkspace(app.getPath("userData"), { nodePath: runtime.nodePath }) || path.join(app.getPath("userData"), "data");
  if (isolated) temporaryDataDirs.add(dataDir);
  releaseWorkspace = acquireWorkspaceLock(dataDir);
  const port = await freePort();
  const instanceId = randomUUID();
  backendFailure = undefined;
  const env = {
    ...process.env,
    NODE_ENV: "production",
    CLIPFORGE_RUNTIME: "desktop",
    CLIPFORGE_DESKTOP_LOCAL: "1",
    CLIPFORGE_INSTANCE_ID: instanceId,
    CLIPFORGE_PROBE_MODE: isolated ? "1" : "0",
    CLIPFORGE_APP_VERSION: app.getVersion(),
    npm_package_version: app.getVersion(),
    PORT: String(port), HOSTNAME: "127.0.0.1",
    APP_DATA_DIR: dataDir,
    APP_MIGRATIONS_DIR: app.isPackaged ? path.join(serverDir, "drizzle") : path.join(__dirname, "..", "drizzle"),
    APP_RESOURCE_DIR: serverDir,
    CLIPFORGE_NODE_PATH: runtime.nodePath,
    CLIPFORGE_KLING_PACKAGE_PATH: runtime.klingPackagePath,
    CLIPFORGE_ELEVENLABS_PACKAGE_PATH: runtime.elevenLabsPackagePath,
    APP_ALIGNMENT_RUNTIME_DIR: runtime.alignmentRuntimeDir,
    APP_ALIGNMENT_PYTHON: runtime.alignmentPythonPath,
    APP_ALIGNMENT_MODEL_DIR: runtime.alignmentModelDir,
    APP_ASR_MODEL_DIR: runtime.asrModelDir,
    APP_ASR_WASM_DIR: runtime.wasmDir,
    FFMPEG_PATH: runtime.ffmpegPath,
    FFPROBE_PATH: runtime.ffprobePath,
    NEXT_TELEMETRY_DISABLED: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  // A normal Node process must not inherit an Electron/terminal debugging hook.
  delete env.NODE_OPTIONS;
  delete env.NODE_INSPECT_RESUME_ON_START;
  let outFd = "ignore";
  if (logFilePath) outFd = fs.openSync(logFilePath, "a");
  try {
    const supervisorEntry = app.isPackaged ? path.join(process.resourcesPath, "server-entry.cjs") : path.join(__dirname, "server-entry.cjs");
    serverChild = spawn(runtime.nodePath, [supervisorEntry, entry], {
      cwd: serverDir, env, windowsHide: true, shell: false,
      stdio: ["ignore", outFd, outFd, "ipc"],
    });
  } finally { if (typeof outFd === "number") fs.closeSync(outFd); }
  const child = serverChild;
  child.on("message", (message) => {
    if (message?.type === "clipforge:child-start" && Number.isSafeInteger(message.pid) && message.pid > 0) childPids.add(message.pid);
    if (message?.type === "clipforge:child-end") childPids.delete(message.pid);
  });
  child.once("error", (error) => { backendFailure = error.message; log(`后端启动错误：${error.message}`); });
  child.once("exit", (code, signal) => {
    backendFailure = `后端退出 code=${code} signal=${signal}`;
    log(backendFailure);
    if (!quitting && !isolated && mainWindow && !setupRunning) {
      void dialog.showMessageBox(mainWindow, { type: "error", title: "ClipForge 本地服务已停止", message: "后台服务已停止，请彻底退出后重新打开客户端。已登记的云端任务会按原记录恢复查询。", detail: `日志：${logFilePath}` });
    }
  });
  log(`spawn 后端 pid=${child.pid} node=${runtime.nodePath} port=${port}`);
  const url = `http://127.0.0.1:${port}`;
  let lastError;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (backendFailure) throw new Error(backendFailure);
    let health;
    try {
      health = await readHealth(url);
    } catch (error) { lastError = error; }
    // An identified server with a broken DB/resource is a definitive failure,
    // not a startup delay. This also makes packaged smoke return nonzero promptly.
    if (health) {
      assertHealthy(health, instanceId, runtime.nodeAbi);
      serverUrl = url;
      return { url, dataDir };
    }
    await delay(500);
  }
  throw new Error(`本地服务未就绪：${lastError?.message || "超时"}`);
}

function terminatePid(pid) {
  return new Promise((resolve) => {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return resolve();
    if (process.platform === "win32") {
      execFile(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }, () => resolve());
    } else {
      try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ }
      resolve();
    }
  });
}
function stopServer() {
  if (!serverStopPromise) serverStopPromise = stopServerInternal().finally(() => { serverStopPromise = undefined; });
  return serverStopPromise;
}
async function stopServerInternal() {
  const child = serverChild;
  if (child) {
    if (child.connected) { try { child.send({ type: "clipforge:shutdown" }); } catch { /* process already exited */ } }
    // Kill only descendants reported by our own supervisor. A Python child may
    // itself own ffmpeg, so Windows /T is needed before its parent disappears.
    await Promise.all([...childPids].map(terminatePid));
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(4000)]);
    }
    if (child.exitCode === null && child.signalCode === null && child.pid) await terminatePid(child.pid);
    serverChild = undefined;
    childPids.clear();
  }
  if (releaseWorkspace) {
    try { releaseWorkspace(); } catch (error) { log(`工作区锁未能释放：${error.message}`); }
    releaseWorkspace = undefined;
  }
  serverUrl = undefined;
  for (const directory of temporaryDataDirs) {
    try { fs.rmSync(directory, { recursive: true, force: true }); temporaryDataDirs.delete(directory); } catch { /* retry after backend handles close */ }
  }
}

function sameApplicationOrigin(url) {
  try { return Boolean(serverUrl) && new URL(url).origin === serverUrl; } catch { return false; }
}
function trustedMainEvent(event) {
  return Boolean(mainWindow && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame && sameApplicationOrigin(event.senderFrame.url));
}
function trustedSetupEvent(event) {
  return isTrustedSetupEvent(event, setupWindow, setupFile);
}
function openExternal(url) {
  try {
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) return;
    void shell.openExternal(parsed.href).catch((error) => log(`外链打开失败：${error.message}`));
  } catch { /* an arbitrary scheme never reaches the OS */ }
}
function protectWindow(window, allowNavigation) {
  window.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: "deny" }; });
  window.webContents.on("will-navigate", (event, url) => {
    if (!allowNavigation(url)) { event.preventDefault(); openExternal(url); }
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
}

async function createWindow({ show = true } = {}) {
  if (mainWindow) { if (show) showWindow(); return mainWindow; }
  mainWindow = new BrowserWindow({ show, width: 1280, height: 860, title: "AI 短视频工作台", backgroundColor: "#0a0a0a", webPreferences: {
    preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true,
  } });
  protectWindow(mainWindow, sameApplicationOrigin);
  mainWindow.webContents.session.on("will-download", (_event, item, contents) => {
    if (contents !== mainWindow?.webContents || !sameApplicationOrigin(item.getURL())) { item.cancel(); return; }
    item.setSaveDialogOptions({ title: "保存 ClipForge 文件", defaultPath: path.join(app.getPath("downloads"), path.basename(item.getFilename())) });
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, description) => {
    if (code === -3 || quitting) return;
    log(`页面加载失败 ${code} ${description}`);
    if (!silent && !probeMode) dialog.showErrorBox("ClipForge 页面加载失败", `${description}\n日志：${logFilePath}`);
  });
  mainWindow.on("close", (event) => {
    if (quitting) return;
    if (tray || process.platform === "darwin") {
      event.preventDefault(); mainWindow.hide();
      try {
        if (process.platform === "win32" && settings.getItem("clipforge_desktop_close_notice") !== "1") {
          tray.displayBalloon({ title: "ClipForge 仍在后台运行", content: "任务将继续处理。需要退出时，请在托盘菜单中选择“彻底退出”。" });
          settings.setItem("clipforge_desktop_close_notice", "1");
        }
      } catch (error) { log(`关闭提示未能保存：${error.message}`); }
    }
    else { event.preventDefault(); void requestExit(); }
  });
  mainWindow.on("closed", () => { mainWindow = undefined; });
  await mainWindow.loadURL(serverUrl);
  return mainWindow;
}
function showWindow() {
  if (!mainWindow && serverUrl) void createWindow().catch(fail);
  const window = setupWindow || mainWindow;
  if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
}
function createTray() {
  if (tray) return;
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, "icon.png")).resize({ width: 20, height: 20 });
    tray = new Tray(icon);
    tray.setToolTip("ClipForge · 关闭窗口后继续后台任务");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "打开 ClipForge", click: showWindow },
      { label: "查看日志", click: () => { void shell.openPath(path.dirname(logFilePath)); } },
      { type: "separator" }, { label: "彻底退出", click: () => { void requestExit(); } },
    ]));
    tray.on("double-click", showWindow);
  } catch (error) { log(`托盘不可用：${error.message}`); }
}
async function requestExit() {
  if (quitting) return;
  if (!serverUrl || backendFailure) return finish(0);
  try {
    const tasks = await readLocalJson(serverUrl, "/api/tasks", 2000);
    if (Array.isArray(tasks.active) && tasks.active.length === 0 && childPids.size === 0) return finish(0);
  } catch { /* Unknown work state still deserves the explicit interruption prompt. */ }
  const choice = await dialog.showMessageBox({ type: "question", title: "退出 ClipForge", message: "彻底退出会停止本机后台处理。", detail: "正在合成的内容需要重新操作；已受理的云端生成不会被取消，重新打开后可按原任务查询和保存。关闭窗口可继续在后台运行。", buttons: ["继续运行", "彻底退出"], defaultId: 0, cancelId: 0 });
  if (choice.response === 1) await finish(0);
}

async function chooseWorkspace() {
  if (quitting || setupRunning) return;
  const selected = await dialog.showOpenDialog(mainWindow, { title: "打开已有 ClipForge 工作目录", properties: ["openDirectory"], message: "选择旧源码目录或其中的 data 目录。请先停止旧 Web 服务。" });
  if (selected.canceled || !selected.filePaths[0]) return;
  let previous;
  let switched = false;
  try {
    const chosen = resolveWorkspaceSelection(selected.filePaths[0], { ownedPid: serverChild?.pid, nodePath: runtime?.nodePath });
    previous = loadWorkspace(app.getPath("userData"), { ownedPid: serverChild?.pid, nodePath: runtime?.nodePath }) || path.join(app.getPath("userData"), "data");
    if (chosen.dataDir === previous) return;
    const choice = await dialog.showMessageBox(mainWindow, { type: "question", title: "切换工作目录", message: "切换会停止当前本机处理，并重新打开所选工作区。", detail: `所选数据：${chosen.dataDir}\n原数据保留在原目录，任务密钥和素材不会被替换。请确认当前合成已结束。`, buttons: ["取消", "切换"], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return;
    mainWindow?.destroy(); mainWindow = undefined;
    await stopServer();
    switched = true;
    saveWorkspace(app.getPath("userData"), chosen.dataDir);
    await boot();
  } catch (error) {
    log(`切换工作区失败：${error.message}`);
    if (previous && switched) {
      try { await stopServer(); saveWorkspace(app.getPath("userData"), previous); await boot(); }
      catch (restoreError) { log(`原工作区恢复失败：${restoreError.message}`); }
    }
    dialog.showErrorBox("无法打开所选工作目录", error.message);
  }
}
function createMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ label: "ClipForge", submenu: [{ role: "about" }, { type: "separator" }, { label: "彻底退出", accelerator: "Cmd+Q", click: () => { void requestExit(); } }] }] : []),
    { label: "文件", submenu: [
      { label: "打开已有工作目录…", click: () => { void chooseWorkspace(); } },
      { label: "打开当前数据目录", click: () => {
        try { void shell.openPath(loadWorkspace(app.getPath("userData"), { ownedPid: serverChild?.pid, nodePath: runtime?.nodePath }) || path.join(app.getPath("userData"), "data")); }
        catch (error) { dialog.showErrorBox("无法打开数据目录", error.message); }
      } },
      { type: "separator" }, { label: "彻底退出", click: () => { void requestExit(); } },
    ] },
    { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "视图", submenu: [{ role: "reload" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { role: "togglefullscreen" }] },
  ]));
}

function progress(value) {
  const key = `${value.phase}/${value.resourceId || ""}`;
  if (lastProgressLog.key !== key || Date.now() - lastProgressLog.time > 5000) {
    log(value.message || value.phase || "安装资源");
    lastProgressLog = { key, time: Date.now() };
  }
  if (setupWindow && !setupWindow.isDestroyed()) setupWindow.webContents.send("clipforge:setup-progress", value);
}
async function runSetup() {
  if (setupRunning) return;
  setupRunning = true;
  setupCancelled = false;
  setupController = new AbortController();
  try {
    log("开始准备在线运行资源。");
    runtime = await prepareRuntime({ ...runtimeOptions(), signal: setupController.signal, onProgress: progress });
    if (setupCancelled) throw new Error("安装已取消。");
    progress({ phase: "checking", message: "正在检查本地服务与数据库…", finishing: true });
    await startServer({ isolated: true });
    await stopServer();
    progress({ phase: "complete", message: "安装准备完成，可以使用 ClipForge。", complete: true, finishing: true });
    if (probeMode && !silent && setupWindow) console.log("GUI_SETUP_OK");
    setupRunning = false;
    if (installMode) return finish(0);
    setupWindow?.destroy(); setupWindow = undefined;
    await boot();
  } catch (error) {
    log(`安装准备失败：${error.stack || error.message || error}`);
    await stopServer();
    setupRunning = false;
    if (setupCancelled || silent || probeMode) return fail(error);
    progress({ phase: "failed", message: "安装准备未完成，已下载的内容可在重试时复用。", error: error.message, failed: true });
  }
}
async function openSetup({ begin = false, reason } = {}) {
  if (silent) return runSetup();
  setupWindow = new BrowserWindow({ width: 640, height: 450, resizable: false, title: "ClipForge 安装准备", backgroundColor: "#111318", webPreferences: {
    preload: path.join(__dirname, "setup-preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true,
  } });
  const window = setupWindow;
  log(`打开安装界面：${setupFile}`);
  protectWindow(window, () => false);
  let ready = false;
  let failed = false;
  let readyTimer;
  const abortSetup = (error) => {
    if (failed || quitting) return;
    failed = true;
    clearTimeout(readyTimer);
    log(`安装界面失败：${error.stack || error.message || error}`);
    setupController?.abort();
    void fail(error);
  };
  window.webContents.on("preload-error", (_event, preloadPath, error) => abortSetup(new Error(`安装界面 preload 加载失败：${preloadPath}：${error.message}`)));
  window.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3) abortSetup(new Error(`安装界面加载失败：${code} ${description} (${url})`));
  });
  window.webContents.on("render-process-gone", (_event, detail) => abortSetup(new Error(`安装界面进程已停止：${detail.reason} (${detail.exitCode})`)));
  window.webContents.on("console-message", (detail) => {
    if (detail && typeof detail === "object") log(`安装界面 console[${detail.level}] ${detail.message}`);
  });
  window.webContents.on("did-finish-load", () => log(`安装界面页面已加载：${window.webContents.getURL()}`));
  const onReady = (event) => {
    if (!trustedSetupEvent(event)) {
      log(`拒绝安装界面握手：${event.senderFrame?.url || "无主 frame"}`);
      return;
    }
    if (ready || failed) return;
    ready = true;
    clearTimeout(readyTimer);
    log(`安装界面握手完成：${event.senderFrame.url}`);
    if (probeMode) console.log("GUI_SETUP_READY");
    if (begin) void runSetup();
    else progress({ phase: "repair", message: "运行资源未就绪，请点击重试完成在线修复。", error: reason || "", failed: true });
  };
  const onRendererError = (event, message) => {
    if (trustedSetupEvent(event)) abortSetup(new Error(`安装界面脚本失败：${String(message).slice(0, 2000)}`));
  };
  ipcMain.on("clipforge:setup-ready", onReady);
  ipcMain.on("clipforge:setup-error", onRendererError);
  window.once("closed", () => {
    clearTimeout(readyTimer);
    ipcMain.removeListener("clipforge:setup-ready", onReady);
    ipcMain.removeListener("clipforge:setup-error", onRendererError);
    if (setupWindow === window) setupWindow = undefined;
  });
  window.once("close", (event) => {
    if (quitting) return;
    event.preventDefault(); setupCancelled = true; setupController?.abort(); void finish(1);
  });
  readyTimer = setTimeout(() => abortSetup(new Error("安装界面在 15 秒内未完成初始化，请重新运行安装程序并查看安装日志。")), 15_000);
  try { await window.loadFile(setupFile); }
  catch (error) { abortSetup(error); }
}

async function boot() {
  await startServer();
  settings = createSettingsStore(path.join(app.getPath("userData"), "settings"), safeStorage);
  // Fail visibly before a renderer defaults to empty provider settings.
  settings.keys();
  createMenu();
  createTray();
  await createWindow();
}
async function start() {
  initLog();
  ipcMain.on("clipforge:storage", (event, operation, ...args) => {
    try {
      if (!trustedMainEvent(event) || !settings || !["getItem", "setItem", "removeItem", "keys"].includes(operation)) throw new Error("配置请求来源无效。");
      event.returnValue = { ok: true, value: settings[operation](...args) };
    } catch (error) { event.returnValue = { ok: false, error: error.message }; }
  });
  ipcMain.on("clipforge:setup-retry", (event) => { if (trustedSetupEvent(event)) void runSetup(); });
  ipcMain.on("clipforge:setup-cancel", (event) => {
    if (trustedSetupEvent(event)) { setupCancelled = true; setupController?.abort(); void finish(1); }
  });
  if (installMode) return openSetup({ begin: true });
  try { runtime = await verifyRuntime({ ...runtimeOptions(), deep: probeMode }); }
  catch (error) {
    if (probeMode) throw error;
    return openSetup({ reason: error.message });
  }
  if (probeMode) {
    const checked = await startServer({ isolated: true });
    settings = createSettingsStore(path.join(app.getPath("userData"), "settings"), safeStorage);
    settings.keys();
    const window = await createWindow({ show: false });
    const renderer = await probeRenderer(window);
    console.log("SMOKE_OK", checked.url, `NODE=${runtime.nodeVersion}`, `ABI=${runtime.nodeAbi}`, `RENDERER=${JSON.stringify(renderer)}`);
    await stopServer();
    return finish(0);
  }
  await boot();
  powerMonitor.on("resume", () => {
    if (mainWindow && serverUrl) { mainWindow.webContents.send("clipforge:resume"); log("系统恢复，后台队列继续按原任务查询。"); }
  });
}
async function fail(error) {
  log(`失败：${error.stack || error.message || error}`);
  if (silent || probeMode) {
    console.error("CLIPFORGE_FAILED", error.message || error);
    // Probe/install databases are isolated and have no provider credentials.
    // Preserve useful native-loader diagnostics even when temporary data is removed.
    if (logFilePath) { try { console.error(fs.readFileSync(logFilePath, "utf8").slice(-5000)); } catch { /* log unavailable */ } }
  }
  else dialog.showErrorBox("ClipForge 未能就绪", `${error.message || error}\n\n日志：${logFilePath || "不可用"}`);
  await finish(1);
}
function finish(code) {
  if (exitPromise) return exitPromise;
  quitting = true;
  exitPromise = (async () => {
    setupController?.abort();
    await stopServer();
    tray?.destroy();
    if (temporaryUserData) { try { fs.rmSync(temporaryUserData, { recursive: true, force: true }); } catch { /* Chromium can retain a temporary lock until exit */ } }
    app.exit(code);
  })();
  return exitPromise;
}
app.on("before-quit", (event) => { if (!quitting) { event.preventDefault(); void finish(0); } });
app.on("window-all-closed", () => { if (!tray && !quitting && process.platform !== "darwin") void finish(0); });
app.on("activate", showWindow);
app.on("will-quit", () => { try { releaseWorkspace?.(); } catch { /* best effort on forced OS shutdown */ } });
