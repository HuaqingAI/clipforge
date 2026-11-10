// Read-only release check: use the same anonymous URLs available to installers.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import runtimeSources from "../electron/runtime-sources.cjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { resourceDownloadUrls, validateResourceMirrors } = runtimeSources;

function publicUrl(value, allowHttpForTests) {
  const url = new URL(value);
  if (url.username || url.password || url.hash || !(url.protocol === "https:" || allowHttpForTests && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
    throw new Error("资源及重定向地址必须使用无凭据的 HTTPS URL");
  }
  return url;
}

export async function verifyDesktopDownload(resource, { verifyHash = false, allowHttpForTests = false, connectTimeoutMs = 30_000, idleTimeoutMs = 60_000 } = {}) {
  if (!resource?.id || !Number.isSafeInteger(resource.size) || resource.size <= 0 || !/^[a-f0-9]{64}$/.test(resource.sha256 || "")) throw new Error("资源清单缺少标识、大小或 SHA256");
  for (const timeout of [connectTimeoutMs, idleTimeoutMs]) if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("下载验证超时设置无效");
  const initialUrl = publicUrl(resource.url, allowHttpForTests);
  const controller = new AbortController();
  let timer;
  const deadline = (milliseconds, message) => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(message)), milliseconds);
  };
  let response;
  try {
    deadline(connectTimeoutMs, "连接资源服务器超时");
    const request = async useRange => {
      let current = initialUrl;
      for (let redirects = 0; redirects <= 8; redirects++) {
        const result = await fetch(current, {
          method: "GET", redirect: "manual", credentials: "omit", signal: controller.signal,
          headers: { "Accept-Encoding": "identity", ...(useRange ? { Range: "bytes=0-0" } : {}) },
        });
        if (![301, 302, 303, 307, 308].includes(result.status)) return result;
        const location = result.headers.get("location");
        await result.body?.cancel();
        if (!location || redirects === 8) throw new Error(location ? "资源重定向过多" : "资源重定向缺少地址");
        current = publicUrl(new URL(location, current).href, allowHttpForTests);
      }
    };
    let rangeRequested = !verifyHash;
    response = await request(rangeRequested);
    const firstLength = response.headers.get("content-length");
    if (rangeRequested && response.status === 200 && (firstLength === null || !/^\d+$/.test(firstLength) || Number(firstLength) !== resource.size)) {
      // Some model hosts return a partial Range body with status 200. Verify
      // the full response headers separately instead of accepting that body.
      await response.body?.cancel();
      rangeRequested = false;
      response = await request(false);
    }
    clearTimeout(timer);
    if (![200, 206].includes(response.status) || !response.body) {
      const detail = response.status === 404 ? "资源尚未公开发布或地址不存在" : [401, 403].includes(response.status) ? "资源不允许匿名下载" : "资源下载不可用";
      throw new Error(`${detail}（HTTP ${response.status}）`);
    }
    const length = response.headers.get("content-length");
    if (response.status === 206) {
      if (!rangeRequested || response.headers.get("content-range") !== `bytes 0-0/${resource.size}` || length !== null && length !== "1") throw new Error("资源 Range 响应与清单大小不匹配");
    } else if (length === null || !/^\d+$/.test(length) || Number(length) !== resource.size) {
      throw new Error(`资源大小不匹配：清单 ${resource.size}，服务器 ${length ?? "未提供"}`);
    }
    if (!verifyHash && response.status === 200) {
      // The server ignored Range; don't download a potentially large model.
      await response.body.cancel();
      return { id: resource.id, url: resource.url, size: resource.size, status: 200, rangeSupported: false };
    }
    const hash = verifyHash ? createHash("sha256") : null;
    let received = 0;
    const expected = verifyHash ? resource.size : 1;
    deadline(idleTimeoutMs, "等待资源下载数据超时");
    for await (const chunk of response.body) {
      deadline(idleTimeoutMs, "资源下载连续无数据超时");
      received += chunk.length;
      if (received > expected) throw new Error("资源实际大小超出清单");
      hash?.update(chunk);
    }
    if (received !== expected) throw new Error(`资源下载不完整：预期 ${expected}，实际 ${received}`);
    const digest = hash?.digest("hex");
    if (verifyHash && digest !== resource.sha256) throw new Error("资源 SHA256 与安装器清单不匹配");
    return { id: resource.id, url: resource.url, size: resource.size, status: response.status, rangeSupported: response.status === 206, ...(digest ? { sha256: digest } : {}) };
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function verifyDesktopDownloads(manifest, options = {}) {
  if (![1, 2].includes(manifest?.schemaVersion) || !Array.isArray(manifest.resources) || !manifest.resources.length) throw new Error("桌面资源清单为空或版本无效");
  const ids = new Set();
  for (const resource of manifest.resources) {
    if (ids.has(resource.id)) throw new Error(`资源标识重复：${resource.id}`);
    ids.add(resource.id);
    validateResourceMirrors(resource, { allowHttpForTests: options.allowHttpForTests });
  }
  // Check every configured address independently. Installer fallback must not
  // conceal an unavailable or corrupted mirror during release validation.
  const downloads = manifest.resources.flatMap(resource => resourceDownloadUrls(resource).map((url, index, urls) => ({
    resource: { ...resource, url }, source: index < urls.length - 1 ? "mirror" : "upstream",
  })));
  const results = []; const errors = [];
  for (const { resource, source } of downloads) {
    try {
      const result = { ...await verifyDesktopDownload(resource, options), source };
      results.push(result); options.onResult?.({ ok: true, ...result });
    } catch (cause) {
      const error = new Error(`${resource.id}: ${cause.message} — ${resource.url}`, { cause });
      errors.push(error); options.onResult?.({ ok: false, id: resource.id, url: resource.url, source, message: cause.message });
    }
  }
  if (errors.length) throw new AggregateError(errors, `${errors.length}/${downloads.length} 个下载地址未通过匿名下载验证`);
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { manifest: { type: "string" }, hash: { type: "boolean" }, help: { type: "boolean" } } });
    if (values.help) {
      console.log("Usage: node scripts/verify-desktop-downloads.mjs [--manifest artifacts/runtime/desktop-runtime-manifest.json] [--hash]\n逐一匿名检查所有镜像及上游地址的 HTTP 状态、Range 和大小；--hash 流式下载每个地址并校验固定 SHA256，不保存文件。");
    } else {
      const manifest = JSON.parse(await readFile(resolve(values.manifest || join(root, "artifacts/runtime/desktop-runtime-manifest.json")), "utf8"));
      const results = await verifyDesktopDownloads(manifest, { verifyHash: Boolean(values.hash), onResult: result => console.log(`${result.ok ? "PASS" : "FAIL"} ${result.id} [${result.source === "mirror" ? "镜像" : "上游"}]: ${result.ok ? `${result.size} bytes${result.sha256 ? ` SHA256 ${result.sha256}` : result.rangeSupported ? " Range OK" : " Range unsupported"}` : result.message}\n  ${result.url}`) });
      console.log(`全部 ${manifest.resources.length} 个资源的 ${results.length} 个地址已通过匿名下载${values.hash ? "及 SHA256 " : ""}验证。`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
