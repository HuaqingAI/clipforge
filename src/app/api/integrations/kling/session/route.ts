import { NextRequest } from "next/server";
import { createKlingLocalSession, klingRouteError } from "@/lib/kling/local-access";

export const runtime = "nodejs";
export async function GET(req: NextRequest) {
  try { return await createKlingLocalSession(req); }
  catch (error) { return klingRouteError(error); }
}
