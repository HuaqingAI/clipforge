const path = require("node:path");

function configureRendererDownloads(window, { downloadsPath, isAllowedUrl, onFailure }) {
  const contents = window.webContents;
  const session = contents.session;
  const onDownload = (_event, item, sender) => {
    if (sender !== contents || !isAllowedUrl(item.getURL())) { item.cancel(); return; }
    const filename = path.basename(item.getFilename());
    // Leave the save path unset so Electron always asks where to save the file.
    item.setSaveDialogOptions({ title: "保存 ClipForge 文件", defaultPath: path.join(downloadsPath, filename) });
    item.once("done", (_event, state) => {
      if (state === "interrupted") onFailure(filename);
    });
  };
  session.on("will-download", onDownload);
  // The default session survives window/workspace changes. A stale handler would
  // otherwise cancel a later window's download before its own handler can run.
  window.once("closed", () => session.removeListener("will-download", onDownload));
}

module.exports = { configureRendererDownloads };
