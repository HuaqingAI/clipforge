const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtemp, mkdir, writeFile, rm, utimes } = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const helpers = import("../../scripts/test-desktop-install.mjs");

test("official smoke retains every original upstream URL without a fixture server", async () => {
  const { createSmokeManifest } = await helpers;
  const manifest = {
    schemaVersion: 2, installMode: "official-sources",
    resources: [
      { id: "node", url: "https://nodejs.org/dist/v24.18.0/node-v24.18.0-win-x64.zip" },
      { id: "kling", url: "https://registry.npmjs.org/@klingai/cli-global/-/cli-global-0.2.0.tgz" },
      { id: "model", url: "https://huggingface.co/facebook/wav2vec2-base-960h/resolve/fixed-revision/model.safetensors" },
    ],
  };
  assert.equal(createSmokeManifest(manifest), manifest);
  assert.equal(createSmokeManifest(manifest, "http://127.0.0.1:1234"), manifest);
  assert.equal(manifest.resources[0].url, "https://nodejs.org/dist/v24.18.0/node-v24.18.0-win-x64.zip");
});

test("official smoke rejects loopback overrides and credential-bearing sources", async () => {
  const { createSmokeManifest } = await helpers;
  for (const url of ["http://127.0.0.1:1234/node.zip", "https://user:password@nodejs.org/node.zip", "https://nodejs.org/node.zip#untrusted"]) {
    assert.throws(() => createSmokeManifest({ schemaVersion: 2, installMode: "official-sources", resources: [{ id: "node", url }] }), /original public HTTPS/);
  }
  assert.throws(() => createSmokeManifest({ schemaVersion: 2, resources: [] }), /official-sources/);
});

test("historical schema-1 fixtures retain their explicit loopback archive behavior", async () => {
  const { createSmokeManifest } = await helpers;
  const manifest = { schemaVersion: 1, resources: [{ id: "node", url: "https://example.test/node.tar.gz", sha256: "fixed" }] };
  const fixture = createSmokeManifest(manifest, "http://127.0.0.1:1234");
  assert.equal(fixture.resources[0].url, "http://127.0.0.1:1234/node.tar.gz");
  assert.equal(manifest.resources[0].url, "https://example.test/node.tar.gz");
});

test("official smoke verifies every download hash and detects a cache rewrite during reuse", async t => {
  const { snapshotOfficialDownloads, assertOfficialDownloadReuse } = await helpers;
  const root = await mkdtemp(path.join(os.tmpdir(), "clipforge-official-smoke-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "downloads"));
  const payload = Buffer.from("fixed upstream download");
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const manifest = { resources: [{ id: "node", size: payload.length, sha256 }] };
  const cache = path.join(root, "downloads", `node-${sha256}.download`);
  await assert.rejects(snapshotOfficialDownloads(manifest, root), /ENOENT/);
  await writeFile(cache, payload);
  const before = await snapshotOfficialDownloads(manifest, root);
  const after = await snapshotOfficialDownloads(manifest, root);
  assert.doesNotThrow(() => assertOfficialDownloadReuse(before, after));
  await utimes(cache, new Date(), new Date(before[0].mtimeMs + 3000));
  const rewritten = await snapshotOfficialDownloads(manifest, root);
  assert.throws(() => assertOfficialDownloadReuse(before, rewritten), /changed an official download cache/);
  await writeFile(cache, Buffer.alloc(payload.length, 88));
  await assert.rejects(snapshotOfficialDownloads(manifest, root), /SHA256/);
});
