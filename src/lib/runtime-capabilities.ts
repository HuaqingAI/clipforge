import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export function isDesktopRuntime(): boolean {
  return process.env.CLIPFORGE_RUNTIME === "desktop";
}

/** Only the managed, ordinary Node backend is a supported desktop CLI host. */
export function isManagedDesktopRuntime(): boolean {
  return isDesktopRuntime() && process.env.CLIPFORGE_DESKTOP_LOCAL === "1" && !process.versions.electron;
}

function preparedPackage(variable: string): boolean {
  const directory = process.env[variable];
  return Boolean(directory && isAbsolute(directory) && existsSync(join(directory, "package.json")));
}

export function isLocalCliRuntimeEnabled(service: "kling" | "elevenlabs"): boolean {
  if (process.env.CLIPFORGE_PROBE_MODE === "1" || process.versions.electron ||
    process.env[service === "kling" ? "CLIPFORGE_KLING_DISABLED" : "CLIPFORGE_ELEVENLABS_DISABLED"] === "1") return false;
  if (!isDesktopRuntime()) return true;
  return isManagedDesktopRuntime() && preparedPackage(service === "kling"
    ? "CLIPFORGE_KLING_PACKAGE_PATH" : "CLIPFORGE_ELEVENLABS_PACKAGE_PATH");
}
