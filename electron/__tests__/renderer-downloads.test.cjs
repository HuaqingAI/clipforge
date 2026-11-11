const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { configureRendererDownloads } = require("../renderer-downloads.cjs");

const origin = "http://127.0.0.1:3000";
function setup(session = new EventEmitter()) {
  const window = new EventEmitter();
  window.webContents = { session };
  const failures = [];
  configureRendererDownloads(window, {
    downloadsPath: path.resolve("downloads"),
    isAllowedUrl: url => new URL(url).origin === origin,
    onFailure: filename => failures.push(filename),
  });
  return { window, session, failures };
}
function download(url, filename = "视频.mp4") {
  const item = new EventEmitter();
  item.getURL = () => url;
  item.getFilename = () => filename;
  item.cancel = () => { item.cancelled = true; };
  item.setSaveDialogOptions = options => { item.options = options; };
  item.setSavePath = () => { throw new Error("Downloads must show the Save As dialog"); };
  return item;
}

test("shot clips and composed videos use the native Save As dialog with the original filename", () => {
  const { window, session } = setup();
  for (const route of ["/api/files/project/take.mp4?download=1", "/api/output/project/final.mp4?download=1"]) {
    const item = download(`${origin}${route}`);
    session.emit("will-download", {}, item, window.webContents);
    assert.equal(item.cancelled, undefined);
    assert.deepEqual(item.options, { title: "保存 ClipForge 文件", defaultPath: path.resolve("downloads", "视频.mp4") });
  }
});

test("foreign URLs and other renderers cannot initiate a download", () => {
  const { window, session } = setup();
  for (const [url, sender] of [["https://example.test/video.mp4", window.webContents], [`${origin}/api/files/clip.mp4`, {}]]) {
    const item = download(url);
    session.emit("will-download", {}, item, sender);
    assert.equal(item.cancelled, true);
    assert.equal(item.options, undefined);
  }
});

test("interrupted saves report failure while successful and user-cancelled saves do not", () => {
  const { window, session, failures } = setup();
  for (const state of ["completed", "cancelled", "interrupted"]) {
    const item = download(`${origin}/api/output/final.mp4`);
    session.emit("will-download", {}, item, window.webContents);
    item.emit("done", {}, state);
  }
  assert.deepEqual(failures, ["视频.mp4"]);
});

test("recreating the window releases its previous download handler", () => {
  const first = setup();
  assert.equal(first.session.listenerCount("will-download"), 1);
  first.window.emit("closed");
  assert.equal(first.session.listenerCount("will-download"), 0);
  const second = setup(first.session);
  const item = download(`${origin}/api/files/take.mp4`);
  second.session.emit("will-download", {}, item, second.window.webContents);
  assert.equal(item.cancelled, undefined);
  assert.ok(item.options);
  assert.equal(second.session.listenerCount("will-download"), 1);
});
