const { test } = require("node:test");
const assert = require("node:assert/strict");
const { sameSetupFile, trustedSetupEvent } = require("../setup-window.cjs");

test("accepts Chromium's uppercase Windows drive for a lowercase installed asar path", () => {
  assert.equal(sameSetupFile("file:///D:/ClipForge/resources/app.asar/electron/setup.html", "d:\\ClipForge\\resources\\app.asar\\electron\\setup.html", "win32"), true);
  assert.equal(sameSetupFile("file:///D:/ClipForge/resources/app.asar/electron/setup.html", "d:\\clipforge\\resources\\APP.ASAR\\electron\\setup.html", "win32"), true);
  assert.equal(sameSetupFile("file:///D:/%E5%AE%89%E8%A3%85%20ClipForge/resources/app.asar/electron/setup.html", "d:\\安装 ClipForge\\resources\\app.asar\\electron\\setup.html", "win32"), true);
});

test("rejects another local file, remote URL, query, relative path and case differences on POSIX", () => {
  const expected = "d:\\ClipForge\\resources\\app.asar\\electron\\setup.html";
  for (const url of ["file:///D:/other/setup.html", "file:///D:/ClipForge/resources/app.asar/electron/setup-renderer.js", "https://example.test/setup.html", "file:///D:/ClipForge/resources/app.asar/electron/setup.html?foreign=1", "file:///D:/ClipForge/resources/app.asar/electron/setup.html#foreign", "not a URL"]) assert.equal(sameSetupFile(url, expected, "win32"), false);
  assert.equal(sameSetupFile("file:///D:/ClipForge/setup.html", "setup.html", "win32"), false);
  assert.equal(sameSetupFile("file:///opt/ClipForge/setup.html", "/opt/ClipForge/setup.html", "linux"), true);
  assert.equal(sameSetupFile("file:///opt/clipforge/setup.html", "/opt/ClipForge/setup.html", "linux"), false);
});

test("requires the exact setup window and main frame before trusting its canonical file path", () => {
  const mainFrame = { url: "file:///D:/ClipForge/resources/app.asar/electron/setup.html" };
  const webContents = { mainFrame };
  const window = { webContents, isDestroyed: () => false };
  const expected = "d:\\ClipForge\\resources\\app.asar\\electron\\setup.html";
  assert.equal(trustedSetupEvent({ sender: webContents, senderFrame: mainFrame }, window, expected, "win32"), true);
  assert.equal(trustedSetupEvent({ sender: {}, senderFrame: mainFrame }, window, expected, "win32"), false);
  assert.equal(trustedSetupEvent({ sender: webContents, senderFrame: { ...mainFrame } }, window, expected, "win32"), false);
  assert.equal(trustedSetupEvent({ sender: webContents, senderFrame: mainFrame }, { ...window, isDestroyed: () => true }, expected, "win32"), false);
});
