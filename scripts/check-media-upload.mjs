#!/usr/bin/env node
// Run against a built, running server: node scripts/check-media-upload.mjs http://127.0.0.1:3000
// Synthetic multipart requests exercise Proxy buffering without media processing or paid APIs.
import assert from "node:assert/strict";
import { Readable } from "node:stream";

const baseUrl = new URL(process.argv[2] || "http://127.0.0.1:3000");
if (!["127.0.0.1", "localhost", "[::1]"].includes(baseUrl.hostname)) {
  throw new Error("Run this regression check against a local server only.");
}
const endpoint = new URL("/api/media/analyze", baseUrl);
const MiB = 1024 * 1024;
const fakeConfig = JSON.stringify({
  baseUrl: "http://127.0.0.1:1/v1",
  apiKey: "upload-regression-not-a-real-key",
  model: "upload-regression",
});
const unsupported = "Only JPG, PNG, WebP, MP4, WebM, and MOV are supported";

async function check({ name, size, type = "application/octet-stream", config = fakeConfig, error }) {
  const boundary = "clipforge-upload-regression-boundary";
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="regression.bin"\r\nContent-Type: ${type}\r\n\r\n`,
  );
  // Keep llmConfig after the large file: a successful type/size validation proves the tail arrived.
  const suffix = Buffer.from(
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="llmConfig"\r\n\r\n${config}\r\n--${boundary}--\r\n`,
  );
  async function* multipart() {
    yield prefix;
    const chunk = Buffer.alloc(MiB);
    for (let remaining = size; remaining > 0; remaining -= chunk.length) {
      yield chunk.subarray(0, Math.min(remaining, chunk.length));
    }
    yield suffix;
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "accept-language": "en",
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(prefix.length + size + suffix.length),
    },
    body: Readable.from(multipart()),
    duplex: "half",
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.text();
  assert.equal(response.status, 400, `${name}: expected HTTP 400, received ${response.status}: ${body}`);
  let result;
  try {
    result = JSON.parse(body);
  } catch {
    throw new Error(`${name}: expected a JSON validation response, received: ${body.slice(0, 300)}`);
  }
  assert.equal(result.error, error, `${name}: unexpected validation response`);
  console.log(`PASS ${name}`);
}

const checks = [
  { name: "12 MiB upload preserves the trailing model configuration", size: 12 * MiB, error: unsupported },
  { name: "80 MiB file plus multipart overhead reaches route validation", size: 80 * MiB, error: unsupported },
  { name: "video one byte over 80 MiB returns its file-size limit", size: 80 * MiB + 1, type: "video/mp4", error: "Videos must be 80MB or smaller" },
  { name: "15 MiB image body parses before model validation", size: 15 * MiB, type: "image/png", config: "{}", error: "Configure a vision-capable model first" },
  { name: "image one byte over 15 MiB returns its file-size limit", size: 15 * MiB + 1, type: "image/png", error: "Images must be 15MB or smaller" },
];

try {
  for (const options of checks) await check(options);
  console.log(`All ${checks.length} media upload checks passed against ${endpoint.origin}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
