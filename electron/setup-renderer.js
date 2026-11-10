const progress = document.getElementById("progress");
const message = document.getElementById("message");
const detail = document.getElementById("detail");
const error = document.getElementById("error");
const retry = document.getElementById("retry");
const cancel = document.getElementById("cancel");

function reportFailure(cause) {
  const description = cause instanceof Error ? cause.message : String(cause);
  message.textContent = "安装界面初始化失败，请重新运行安装程序。";
  error.textContent = description;
  cancel.disabled = false;
  window.clipforgeSetup?.reportError(description);
}
window.addEventListener("error", (event) => reportFailure(event.error || event.message));
window.addEventListener("unhandledrejection", (event) => reportFailure(event.reason));

function size(bytes) { return `${(bytes / 1024 ** 2).toFixed(1)} MiB`; }
try {
if (!window.clipforgeSetup) throw new Error("安装界面 preload 未加载。");
window.clipforgeSetup.onProgress((state) => {
  message.textContent = state.message || "正在准备运行环境…";
  error.textContent = state.error || "";
  retry.hidden = !state.failed;
  cancel.disabled = Boolean(state.finishing);
  if (state.totalBytes > 0) {
    progress.max = state.totalBytes;
    progress.value = state.receivedBytes || 0;
    detail.textContent = `${size(state.receivedBytes || 0)} / ${size(state.totalBytes)}`;
  } else {
    progress.removeAttribute("value");
    detail.textContent = state.totalResources ? `资源 ${state.completedResources || 0} / ${state.totalResources}` : "";
  }
  if (state.complete) { progress.max = 1; progress.value = 1; }
});
retry.addEventListener("click", () => { retry.hidden = true; window.clipforgeSetup.retry(); });
cancel.addEventListener("click", () => window.clipforgeSetup.cancel());
window.clipforgeSetup.ready();
} catch (cause) {
  cancel.addEventListener("click", () => window.close());
  reportFailure(cause);
}
