import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { getDataDir } from "@/lib/paths";
import { redactKlingCliText } from "./cli-diagnostics";
import { isKlingRuntimeEnabled } from "./runtime";

const COOKIE = "clipforge-kling-session";
const MAX_AGE = 12 * 60 * 60;
let secretPromise: Promise<Buffer> | undefined;

export class KlingAccessError extends Error {
  readonly code = "KLING_LOCAL_ACCESS_DENIED";
  constructor(message: string, public readonly status = 403) { super(message); }
}

function localHost(value: string): boolean {
  return value === "localhost" || value === "127.0.0.1" || value === "[::1]" || value === "::1";
}

/** Local web only. Forwarded headers never establish trust. */
export function assertLocalKlingOrigin(req: NextRequest): void {
  if (!isKlingRuntimeEnabled()) {
    throw new KlingAccessError("Kling CLI 当前仅支持本机运行的网页版", 503);
  }
  const url = new URL(req.url);
  const host = req.headers.get("host");
  let hostUrl: URL | undefined;
  try { if (host) hostUrl = new URL(url.protocol + "//" + host); } catch { /* invalid Host */ }
  // NextURL canonicalizes loopback IPs to localhost; retain the real Host for Origin checks.
  if (!localHost(url.hostname) || !host || !hostUrl || !localHost(hostUrl.hostname) ||
    hostUrl.host.toLowerCase() !== host.toLowerCase() || hostUrl.port !== url.port ||
    hostUrl.pathname !== "/" || hostUrl.username || hostUrl.password || hostUrl.search || hostUrl.hash) {
    throw new KlingAccessError("Kling CLI 仅允许通过本机 localhost / 127.0.0.1 访问");
  }
  const origin = req.headers.get("origin");
  if (origin && origin !== hostUrl.origin) throw new KlingAccessError("不允许其他网站调用本机 Kling CLI");
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new KlingAccessError("不允许跨站调用本机 Kling CLI");
}

async function sessionSecret(): Promise<Buffer> {
  secretPromise ??= (async () => {
    const directory = join(getDataDir(), "integrations", "kling");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, "web-session.key");
    try {
      await writeFile(file, randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const bytes = await readFile(file);
    if (bytes.length !== 32) throw new KlingAccessError("本地会话密钥不可用，请检查数据目录", 503);
    return bytes;
  })();
  return secretPromise;
}

function mac(secret: Buffer, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function verifyCookie(req: NextRequest): Promise<{ value: string; csrf: string } | null> {
  const cookie = req.cookies.get(COOKIE)?.value ?? "";
  const [nonce, expires, signature, extra] = cookie.split(".");
  if (extra || !nonce || !expires || !signature || !/^[\w-]{32}$/.test(nonce)) return null;
  const expiry = Number(expires);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(expiry) || expiry <= now || expiry > now + MAX_AGE + 30) return null;
  const secret = await sessionSecret();
  if (!equal(signature, mac(secret, nonce + "." + expires))) return null;
  return { value: cookie, csrf: mac(secret, "csrf:" + cookie) };
}

export async function assertKlingLocalRequest(req: NextRequest, mutation = true): Promise<void> {
  assertLocalKlingOrigin(req);
  const session = await verifyCookie(req);
  if (!session || !equal(req.headers.get("x-clipforge-kling-csrf") ?? "", session.csrf)) {
    throw new KlingAccessError("本机会话已失效，请刷新后重试", 401);
  }
  if (mutation && !req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new KlingAccessError("请求必须使用 JSON", 415);
  }
}

export async function createKlingLocalSession(req: NextRequest): Promise<NextResponse> {
  assertLocalKlingOrigin(req);
  // Cross-origin pages cannot add this header without a denied CORS preflight.
  if (req.headers.get("x-clipforge-kling") !== "1") throw new KlingAccessError("缺少本机会话请求标识");
  const secret = await sessionSecret();
  const current = await verifyCookie(req);
  const payload = randomBytes(24).toString("base64url") + "." + (Math.floor(Date.now() / 1000) + MAX_AGE);
  const cookie = current?.value ?? payload + "." + mac(secret, payload);
  const response = NextResponse.json({ csrfToken: mac(secret, "csrf:" + cookie) }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(COOKIE, cookie, { httpOnly: true, sameSite: "strict", secure: new URL(req.url).protocol === "https:", path: "/", maxAge: MAX_AGE });
  return response;
}

export function klingRouteError(error: unknown): NextResponse {
  const problem = (error && typeof error === "object" ? error : {}) as { code?: string; status?: number; message?: string; retryable?: boolean; jobId?: string };
  // Creative-profile validation runs before a job exists, so its actionable reason
  // must reach the submitting shot instead of being replaced by an environment error.
  const known = typeof problem.code === "string" && /^(?:KLING|CREATIVE|TIDEWE|PREMIUM_CG)_[A-Z][A-Z0-9_]*$/.test(problem.code) &&
    typeof problem.message === "string" && Boolean(problem.message.trim());
  if (!known) {
    const detail = error instanceof Error ? error.stack ?? error.message : typeof problem.message === "string" ? problem.message : String(error);
    console.error("Kling local operation failed:", redactKlingCliText(detail).slice(0, 32_768));
  }
  return NextResponse.json({
    error: { code: known ? problem.code : "KLING_INTERNAL_ERROR", message: known ? problem.message : "Kling 本地操作失败，请查看服务日志中的具体原因", retryable: problem.retryable ?? false },
    ...(problem.jobId && { jobId: problem.jobId }),
  }, { status: problem.status && problem.status >= 400 && problem.status <= 599 ? problem.status : 500, headers: { "Cache-Control": "no-store" } });
}
