/** Migration/resource paths do not determine whether the local web integration is available. */
export function isKlingRuntimeEnabled(): boolean {
  return process.env.CLIPFORGE_KLING_DISABLED !== "1" &&
    process.env.CLIPFORGE_RUNTIME !== "desktop" && !process.versions?.electron;
}
