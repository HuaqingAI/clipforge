// This file is executed by the downloaded ordinary Node executable, not Electron.
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const { promisify } = require("node:util");
const path = require("node:path");
const originalSpawn = childProcess.spawn;

let stopping = false;
const children = new Map();
function notify(value) { if (process.connected) { try { process.send(value); } catch { /* parent already closed */ } } }
function trackChild(child) {
  if (child.pid && !children.has(child.pid)) {
    children.set(child.pid, child);
    notify({ type: "clipforge:child-start", pid: child.pid });
    child.once("close", () => { children.delete(child.pid); notify({ type: "clipforge:child-end", pid: child.pid }); });
  }
  return child;
}
for (const method of ["spawn", "exec", "execFile"]) {
  const original = childProcess[method];
  const wrapped = function (...args) {
    if (stopping) throw new Error("ClipForge 正在退出，已停止启动新任务。");
    return trackChild(Reflect.apply(original, this, args));
  };
  if (typeof original[promisify.custom] === "function") {
    // Node's exec helpers resolve { stdout, stderr } and expose promise.child.
    // Their native custom implementation bypasses wrapped, so track that child too.
    Object.defineProperty(wrapped, promisify.custom, {
      value: function (...args) {
        if (stopping) throw new Error("ClipForge 正在退出，已停止启动新任务。");
        const promise = Reflect.apply(original[promisify.custom], this, args);
        trackChild(promise.child);
        return promise;
      },
    });
  }
  childProcess[method] = wrapped;
}
syncBuiltinESMExports();

async function shutdown(parentLost = false) {
  if (stopping) return;
  stopping = true;
  notify({ type: "clipforge:stopping", pids: [...children.keys()] });
  if (parentLost) {
    // If Electron crashes, its IPC channel closes. Clean our own subprocesses
    // before Next exits so Python/ffmpeg cannot survive as orphan processes.
    await Promise.all([...children.values()].map((child) => new Promise((resolve) => {
      if (process.platform === "win32" && child.pid) {
        const killer = originalSpawn(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        const timer = setTimeout(() => { killer.kill(); resolve(); }, 5000);
        timer.unref();
        const done = () => { clearTimeout(timer); resolve(); };
        killer.once("error", done);
        killer.once("close", done);
      } else {
        try { child.kill("SIGTERM"); } catch { /* already exited */ }
        resolve();
      }
    })));
  }
  // Next's SIGTERM handler closes its listener. The parent owns final tree cleanup.
  process.emit("SIGTERM");
  const deadline = setTimeout(() => process.exit(0), 8000);
  deadline.unref();
}
// Let instrumentation's listener stop queue acquisition before Next closes.
process.on("message", (message) => { if (message?.type === "clipforge:shutdown") setImmediate(shutdown); });
process.on("disconnect", () => { void shutdown(true); });
const entry = process.argv[2];
if (!entry || !path.isAbsolute(entry)) throw new Error("Missing standalone server entry.");
require(entry);
