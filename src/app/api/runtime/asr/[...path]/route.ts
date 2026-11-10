import { NextRequest, NextResponse } from "next/server";
import { stat } from "node:fs/promises";
import { resolveAsrAsset } from "@/lib/asr-runtime";
import { fileResponseStream } from "@/lib/file-response-stream";
import { parseRangeHeader } from "@/lib/http-range";

export const dynamic = "force-dynamic";

function localRequest(req: NextRequest): boolean {
  const url = new URL(req.url);
  const rawHost = req.headers.get("host");
  let host: URL;
  try { host = new URL(url.protocol + "//" + rawHost); } catch { return false; }
  const loopback = (hostname: string) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  const origin = req.headers.get("origin");
  const site = req.headers.get("sec-fetch-site");
  return Boolean(rawHost) && host.host.toLowerCase() === rawHost?.toLowerCase() && host.pathname === "/" &&
    !host.username && !host.password && !host.search && !host.hash && loopback(url.hostname) && loopback(host.hostname) && host.port === url.port &&
    (!origin || origin === host.origin) && (!site || site === "same-origin" || site === "none");
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  if (!localRequest(req)) return new NextResponse(null, { status: 403 });
  const file = await resolveAsrAsset((await params).path);
  if (!file) return new NextResponse(null, { status: 404 });
  const { size } = await stat(file);
  const range = parseRangeHeader(req.headers.get("range"), size);
  if (range === "unsatisfiable") return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  const extension = file.split(".").at(-1);
  const headers: Record<string, string> = {
    "Content-Type": extension === "wasm" ? "application/wasm" : extension === "mjs" ? "text/javascript" : extension === "json" ? "application/json" : "application/octet-stream",
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
    "Content-Length": String(range ? range.end - range.start + 1 : size),
  };
  if (range) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
  return new NextResponse(fileResponseStream(file, range || undefined), { status: range ? 206 : 200, headers });
}
