import { NextResponse } from "next/server";
import { asrRuntimeDescriptor } from "@/lib/asr-runtime";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ asr: asrRuntimeDescriptor() }, { headers: { "Cache-Control": "no-store" } });
}
