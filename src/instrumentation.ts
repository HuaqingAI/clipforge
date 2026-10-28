export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { startGenerationRunner, wakeGenerationRunner } = await import("@/lib/generation-runs");
  startGenerationRunner();
  wakeGenerationRunner();
  const { isKlingRuntimeEnabled } = await import("@/lib/kling/runtime");
  if (!isKlingRuntimeEnabled()) return;
  const { startKlingJobRunner, wakeKlingJobRunner } = await import("@/lib/kling/jobs");
  startKlingJobRunner();
  wakeKlingJobRunner();
}
