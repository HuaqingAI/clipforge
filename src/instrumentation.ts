export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build" || process.env.CLIPFORGE_PROBE_MODE === "1") return;
  const { acquireWorkspaceLock } = await import("@/lib/workspace-lock");
  acquireWorkspaceLock();
  const { recoverInterruptedCompositions } = await import("@/lib/startup-recovery");
  await recoverInterruptedCompositions();
  const { startGenerationRunner, wakeGenerationRunner, stopGenerationRunner } = await import("@/lib/generation-runs");
  startGenerationRunner();
  wakeGenerationRunner();
  const { isKlingRuntimeEnabled } = await import("@/lib/kling/runtime");
  let stopKling: (() => void) | undefined;
  if (isKlingRuntimeEnabled()) {
    const { startKlingJobRunner, wakeKlingJobRunner, stopKlingJobRunner } = await import("@/lib/kling/jobs");
    startKlingJobRunner();
    wakeKlingJobRunner();
    stopKling = stopKlingJobRunner;
  }
  if (process.env.CLIPFORGE_RUNTIME === "desktop") {
    const { attachDesktopShutdown } = await import("@/lib/server/desktop-lifecycle");
    attachDesktopShutdown(() => {
      stopGenerationRunner();
      stopKling?.();
    });
  }
}
