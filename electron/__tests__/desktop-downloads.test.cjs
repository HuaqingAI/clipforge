const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { createHash } = require("node:crypto");

const verifier = import("../../scripts/verify-desktop-downloads.mjs");
const payload = Buffer.from("published immutable runtime archive");
const checksum = createHash("sha256").update(payload).digest("hex");
function resource(url) { return { id: "node", url, size: payload.length, sha256: checksum }; }
async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("release verifier uses anonymous one-byte Range requests and validates a public redirect", async t => {
  const { verifyDesktopDownload } = await verifier; const requests = [];
  const origin = await serve(t, (req, res) => {
    requests.push(req.headers);
    if (req.url === "/redirect") { res.writeHead(302, { Location: "/archive" }); res.end(); }
    else { res.writeHead(206, { "Content-Length": 1, "Content-Range": `bytes 0-0/${payload.length}` }); res.end(payload.subarray(0, 1)); }
  });
  const result = await verifyDesktopDownload(resource(`${origin}/redirect`), { allowHttpForTests: true });
  assert.equal(result.rangeSupported, true); assert.equal(requests.length, 2);
  for (const headers of requests) { assert.equal(headers.range, "bytes=0-0"); assert.equal(headers.authorization, undefined); assert.equal(headers.cookie, undefined); }
});

test("release verifier cancels full bodies when Range is ignored and rejects false lengths/ranges", async t => {
  const { verifyDesktopDownload } = await verifier;
  const origin = await serve(t, (req, res) => {
    if (req.url === "/ignored") { res.writeHead(200, { "Content-Length": payload.length }); res.flushHeaders(); }
    else if (req.url === "/length") { res.writeHead(200, { "Content-Length": payload.length + 1 }); res.end(); }
    else { res.writeHead(206, { "Content-Length": 1, "Content-Range": `bytes 0-0/${payload.length + 1}` }); res.end(payload.subarray(0, 1)); }
  });
  const result = await verifyDesktopDownload(resource(`${origin}/ignored`), { allowHttpForTests: true });
  assert.equal(result.rangeSupported, false);
  await assert.rejects(verifyDesktopDownload(resource(`${origin}/length`), { allowHttpForTests: true }), /大小不匹配/);
  await assert.rejects(verifyDesktopDownload(resource(`${origin}/range`), { allowHttpForTests: true }), /Range 响应/);
});

test("release verifier retries a malformed Range 200 with an anonymous full GET", async t => {
  const { verifyDesktopDownload } = await verifier; const requests = [];
  const origin = await serve(t, (req, res) => {
    requests.push(req.headers);
    if (req.headers.range) { res.writeHead(200, { "Content-Length": 1 }); res.end(payload.subarray(0, 1)); }
    else { res.writeHead(200, { "Content-Length": payload.length }); res.flushHeaders(); }
  });
  const result = await verifyDesktopDownload(resource(origin), { allowHttpForTests: true });
  assert.equal(result.status, 200); assert.equal(result.rangeSupported, false);
  assert.equal(requests.length, 2); assert.equal(requests[0].range, "bytes=0-0"); assert.equal(requests[1].range, undefined);
  for (const headers of requests) { assert.ok(headers["accept-encoding"].split(",").every(value => value.trim() === "identity")); assert.equal(headers.authorization, undefined); assert.equal(headers.cookie, undefined); }
});

test("release verifier rejects a wrong full length after a malformed Range response", async t => {
  const { verifyDesktopDownload } = await verifier; const requests = [];
  const origin = await serve(t, (req, res) => {
    requests.push(req.headers.range); res.writeHead(200, { "Content-Length": 1 }); res.end(payload.subarray(0, 1));
  });
  await assert.rejects(verifyDesktopDownload(resource(origin), { allowHttpForTests: true }), /大小不匹配/);
  assert.deepEqual(requests, ["bytes=0-0", undefined]);
});

test("full GET retry still rejects an insecure redirect", async t => {
  const { verifyDesktopDownload } = await verifier; const requests = [];
  const origin = await serve(t, (req, res) => {
    requests.push(req.headers.range);
    if (req.headers.range) { res.writeHead(200, { "Content-Length": 1 }); res.end(payload.subarray(0, 1)); }
    else { res.writeHead(302, { Location: "http://example.com/insecure-download" }); res.end(); }
  });
  await assert.rejects(verifyDesktopDownload(resource(origin), { allowHttpForTests: true }), /HTTPS/);
  assert.deepEqual(requests, ["bytes=0-0", undefined]);
});

test("malformed Range and full GET retries share one connection deadline", async t => {
  const { verifyDesktopDownload } = await verifier; const requests = [];
  const origin = await serve(t, (req, res) => {
    requests.push(req.headers.range);
    setTimeout(() => {
      res.writeHead(200, { "Content-Length": req.headers.range ? 1 : payload.length });
      res.end(req.headers.range ? payload.subarray(0, 1) : payload);
    }, 70);
  });
  await assert.rejects(verifyDesktopDownload(resource(origin), { allowHttpForTests: true, connectTimeoutMs: 110 }), /连接资源服务器超时/);
  assert.deepEqual(requests, ["bytes=0-0", undefined]);
});

test("release verifier streams complete archives only for hash verification", async t => {
  const { verifyDesktopDownload } = await verifier; let range;
  const origin = await serve(t, (req, res) => { range = req.headers.range; res.writeHead(200, { "Content-Length": payload.length }); res.end(payload); });
  const result = await verifyDesktopDownload(resource(origin), { allowHttpForTests: true, verifyHash: true });
  assert.equal(result.sha256, checksum); assert.equal(range, undefined);
  await assert.rejects(verifyDesktopDownload({ ...resource(origin), sha256: "0".repeat(64) }, { allowHttpForTests: true, verifyHash: true }), /SHA256/);
});

test("release verifier reports every unavailable asset with its real URL", async t => {
  const { verifyDesktopDownloads } = await verifier; const events = [];
  const origin = await serve(t, (req, res) => { res.writeHead(req.url === "/missing" ? 404 : 403); res.end(); });
  const manifest = { schemaVersion: 1, resources: [resource(`${origin}/missing`), { ...resource(`${origin}/private`), id: "alignment" }] };
  await assert.rejects(verifyDesktopDownloads(manifest, { allowHttpForTests: true, onResult: event => events.push(event) }), error => {
    assert.equal(error.errors.length, 2);
    assert.match(error.errors[0].message, /node:.*尚未公开发布.*\/missing/);
    assert.match(error.errors[1].message, /alignment:.*匿名下载.*\/private/);
    return true;
  });
  assert.equal(events.length, 2); assert.ok(events.every(event => !event.ok));
});

test("release verifier checks every mirror and the upstream independently", async t => {
  const { verifyDesktopDownloads } = await verifier; const requests = []; const events = [];
  const origin = await serve(t, (req, res) => {
    requests.push(req.url);
    assert.equal(req.headers.range, "bytes=0-0");
    assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.cookie, undefined);
    res.writeHead(206, { "Content-Length": 1, "Content-Range": `bytes 0-0/${payload.length}` }); res.end(payload.subarray(0, 1));
  });
  const urls = ["/mirror-one", "/mirror-two", "/upstream"].map(route => `${origin}${route}`);
  const manifest = { schemaVersion: 2, resources: [{ ...resource(urls[2]), mirrors: urls.slice(0, 2) }] };
  const results = await verifyDesktopDownloads(manifest, { allowHttpForTests: true, onResult: event => events.push(event) });
  assert.deepEqual(requests, ["/mirror-one", "/mirror-two", "/upstream"]);
  assert.deepEqual(results.map(result => result.url), urls);
  assert.deepEqual(results.map(result => result.source), ["mirror", "mirror", "upstream"]);
  assert.deepEqual(events.map(event => ({ ok: event.ok, url: event.url, source: event.source })), urls.map((url, index) => ({ ok: true, url, source: index < 2 ? "mirror" : "upstream" })));
});

test("batch verification rejects an unreviewed mirror before requesting any source", async t => {
  const { verifyDesktopDownloads } = await verifier; let requests = 0;
  const origin = await serve(t, (_req, res) => { requests++; res.writeHead(200, { "Content-Length": payload.length }); res.end(payload); });
  const manifest = { schemaVersion: 2, resources: [{ ...resource(`${origin}/upstream`), mirrors: ["https://unreviewed.invalid/mirror"] }] };
  await assert.rejects(verifyDesktopDownloads(manifest, { allowHttpForTests: true }), /已审核/);
  assert.equal(requests, 0);
});

test("release validation fails for an unavailable mirror even when upstream succeeds", async t => {
  const { verifyDesktopDownloads } = await verifier; const requests = []; const events = [];
  const origin = await serve(t, (req, res) => {
    requests.push(req.url);
    if (req.url === "/missing-mirror") { res.writeHead(404); res.end(); return; }
    res.writeHead(206, { "Content-Length": 1, "Content-Range": `bytes 0-0/${payload.length}` }); res.end(payload.subarray(0, 1));
  });
  const manifest = { schemaVersion: 2, resources: [{ ...resource(`${origin}/upstream`), mirrors: [`${origin}/missing-mirror`] }] };
  await assert.rejects(verifyDesktopDownloads(manifest, { allowHttpForTests: true, onResult: event => events.push(event) }), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 1);
    assert.match(error.errors[0].message, /HTTP 404.*\/missing-mirror/);
    assert.match(error.message, /1\/2/); return true;
  });
  assert.deepEqual(requests, ["/missing-mirror", "/upstream"]);
  assert.deepEqual(events.map(event => ({ ok: event.ok, source: event.source })), [{ ok: false, source: "mirror" }, { ok: true, source: "upstream" }]);
});

test("single-address verification never falls back to another configured source", async t => {
  const { verifyDesktopDownload } = await verifier; const requests = [];
  const origin = await serve(t, (req, res) => {
    requests.push(req.url); res.writeHead(req.url === "/missing" ? 404 : 200, { "Content-Length": req.url === "/missing" ? 0 : payload.length }); res.end(req.url === "/missing" ? undefined : payload);
  });
  await assert.rejects(verifyDesktopDownload({ ...resource(`${origin}/missing`), mirrors: [`${origin}/working-mirror`] }, { allowHttpForTests: true }), /HTTP 404/);
  assert.deepEqual(requests, ["/missing"]);
});

test("hash verification rejects corrupted mirror bytes despite a valid upstream", async t => {
  const { verifyDesktopDownloads } = await verifier; const requests = []; const events = [];
  const corrupted = Buffer.from(payload); corrupted[0] ^= 1;
  const origin = await serve(t, (req, res) => {
    requests.push(req.url); assert.equal(req.headers.range, undefined);
    res.writeHead(200, { "Content-Length": payload.length }); res.end(req.url === "/corrupt-mirror" ? corrupted : payload);
  });
  const manifest = { schemaVersion: 2, resources: [{ ...resource(`${origin}/upstream`), mirrors: [`${origin}/corrupt-mirror`] }] };
  await assert.rejects(verifyDesktopDownloads(manifest, { allowHttpForTests: true, verifyHash: true, onResult: event => events.push(event) }), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 1);
    assert.match(error.errors[0].message, /SHA256.*\/corrupt-mirror/); return true;
  });
  assert.deepEqual(requests, ["/corrupt-mirror", "/upstream"]);
  assert.equal(events[0].ok, false); assert.equal(events[0].source, "mirror");
  assert.equal(events[1].ok, true); assert.equal(events[1].sha256, checksum);
});

test("release verifier rejects credential URLs, production HTTP and unsafe redirects", async t => {
  const { verifyDesktopDownload } = await verifier; let insecureRequests = 0;
  const origin = await serve(t, (_req, res) => { insecureRequests++; res.writeHead(302, { Location: "http://example.com/not-https" }); res.end(); });
  await assert.rejects(verifyDesktopDownload(resource(origin)), /HTTPS/);
  await assert.rejects(verifyDesktopDownload(resource("https://user:password@example.com/archive")), /HTTPS/);
  assert.equal(insecureRequests, 0);
  await assert.rejects(verifyDesktopDownload(resource(origin), { allowHttpForTests: true }), /HTTPS/);
  assert.equal(insecureRequests, 1);
});

test("release verifier bounds both handshake and stalled body waits", async t => {
  const { verifyDesktopDownload } = await verifier;
  const origin = await serve(t, (req, res) => {
    if (req.url === "/body") { res.writeHead(206, { "Content-Length": 1, "Content-Range": `bytes 0-0/${payload.length}` }); res.flushHeaders(); }
  });
  await assert.rejects(verifyDesktopDownload(resource(`${origin}/headers`), { allowHttpForTests: true, connectTimeoutMs: 100 }), /连接资源服务器超时/);
  await assert.rejects(verifyDesktopDownload(resource(`${origin}/body`), { allowHttpForTests: true, idleTimeoutMs: 100 }), /等待资源下载数据超时/);
});
