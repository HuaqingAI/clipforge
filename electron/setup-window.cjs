const path = require("node:path");
const { fileURLToPath } = require("node:url");

function sameSetupFile(url, expectedFile, platform = process.platform) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:" || parsed.search || parsed.hash) return false;
    const localFile = fileURLToPath(parsed, { windows: platform === "win32" });
    const paths = platform === "win32" ? path.win32 : path.posix;
    if (!paths.isAbsolute(expectedFile)) return false;
    const actual = paths.normalize(localFile);
    const expected = paths.normalize(expectedFile);
    // Chromium canonicalizes file:///d:/ to file:///D:/, while an asar
    // module's __dirname retains the spelling of the installed executable.
    return platform === "win32" ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
  } catch { return false; }
}

function trustedSetupEvent(event, window, expectedFile, platform = process.platform) {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame && sameSetupFile(event.senderFrame.url, expectedFile, platform));
}

module.exports = { sameSetupFile, trustedSetupEvent };
