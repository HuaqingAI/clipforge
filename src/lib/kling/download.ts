import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { KlingError } from "./errors";

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    if (!/^[23][0-9a-f]{3}:/.test(value) || value.includes("%")) return false;
    const [first, rawSecond] = value.split(":");
    const second = parseInt(rawSecond || "0", 16);
    // Reject protocol/special assignments, documentation, obsolete 6bone and 6to4.
    // Numeric hextets also cover compressed and zero-padded spellings of these ranges.
    return !(first === "2001" && (second <= 0x1ff || second === 0xdb8)) &&
      first !== "2002" && first !== "3ffe" && !(first === "3fff" && second <= 0x0fff);
  }
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

export async function publicDownloadResponse(source: string, redirects = 0): Promise<import("node:http").IncomingMessage> {
  const url = new URL(source);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || redirects > 5) {
    throw new KlingError("KLING_DOWNLOAD_FAILED", "下载地址或重定向不受支持", 422);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new KlingError("KLING_DOWNLOAD_ADDRESS_BLOCKED", "素材地址必须是可访问的公网地址", 422);
  }
  const address = addresses[0];
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      // Pin the checked DNS result so redirects/rebinding cannot target local services.
      lookup: (_hostname, options, callback) => {
        if (typeof options === "object" && options.all) {
          callback(null, [{ address: address.address, family: address.family }]);
        } else callback(null, address.address, address.family);
      },
      headers: { "User-Agent": "ClipForge-Kling/1", Accept: "*/*" },
      timeout: 30_000,
    }, resolve);
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("DOWNLOAD_TIMEOUT")));
    request.end();
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
    const target = new URL(response.headers.location, url).toString();
    response.destroy();
    return publicDownloadResponse(target, redirects + 1);
  }
  if (response.statusCode !== 200) {
    const status = response.statusCode;
    response.destroy();
    throw new KlingError("KLING_DOWNLOAD_FAILED", "下载素材失败（HTTP " + status + "），可查询原任务更新链接后重试", 502);
  }
  return response;
}

/** Bounded streaming download. Caller owns temporary-file cleanup and validation. */
export async function downloadPublicFile(source: string, destination: string, maxBytes: number): Promise<number> {
  const response = await publicDownloadResponse(source);
  const declared = Number(response.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.destroy();
    throw new KlingError("KLING_DOWNLOAD_TOO_LARGE", "素材体积超过本地下载上限", 422);
  }
  let count = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      count += chunk.length;
      callback(count > maxBytes ? new KlingError("KLING_DOWNLOAD_TOO_LARGE", "素材体积超过本地下载上限", 422) : null, chunk);
    },
  });
  const timer = setTimeout(() => response.destroy(new Error("DOWNLOAD_TIMEOUT")), 180_000);
  timer.unref();
  try {
    await pipeline(response, limiter, createWriteStream(destination, { mode: 0o600 }));
    if (!count) throw new KlingError("KLING_MEDIA_INVALID", "下载结果为空，请恢复原任务的保存", 502);
    return count;
  } finally { clearTimeout(timer); }
}
