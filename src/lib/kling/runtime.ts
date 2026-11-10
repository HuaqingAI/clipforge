import { isLocalCliRuntimeEnabled } from "@/lib/runtime-capabilities";

/** Runtime availability never replaces the per-request Host, Origin and CSRF checks. */
export function isKlingRuntimeEnabled(): boolean {
  return isLocalCliRuntimeEnabled("kling");
}
