export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { isKlingRuntimeEnabled } = await import("@/lib/kling/runtime");
  if (!isKlingRuntimeEnabled()) return;
  const { startKlingJobRunner, wakeKlingJobRunner } = await import("@/lib/kling/jobs");
  startKlingJobRunner();
  wakeKlingJobRunner();
  const { startKlingFilmRunner, wakeKlingFilmRunner } = await import("@/lib/kling/films");
  startKlingFilmRunner();
  wakeKlingFilmRunner();
}
