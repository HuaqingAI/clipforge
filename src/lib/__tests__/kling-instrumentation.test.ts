// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runners = vi.hoisted(() => ({ jobsStart: vi.fn(), jobsWake: vi.fn(), filmsStart: vi.fn(), filmsWake: vi.fn() }));
vi.mock("@/lib/kling/jobs", () => ({ startKlingJobRunner: runners.jobsStart, wakeKlingJobRunner: runners.jobsWake }));
vi.mock("@/lib/kling/films", () => ({ startKlingFilmRunner: runners.filmsStart, wakeKlingFilmRunner: runners.filmsWake }));
import { register } from "@/instrumentation";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_RUNTIME", "nodejs"); vi.stubEnv("NEXT_PHASE", "");
  vi.stubEnv("CLIPFORGE_RUNTIME", ""); vi.stubEnv("CLIPFORGE_KLING_DISABLED", "");
  vi.stubEnv("APP_MIGRATIONS_DIR", "standalone-migrations");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("Kling startup instrumentation", () => {
  it("starts web background recovery with an explicit migration directory", async () => {
    await register();
    for (const runner of Object.values(runners)) expect(runner).toHaveBeenCalledOnce();
  });
  it.each([
    ["CLIPFORGE_RUNTIME", "desktop"], ["CLIPFORGE_KLING_DISABLED", "1"],
    ["NEXT_PHASE", "phase-production-build"], ["NEXT_RUNTIME", "edge"],
  ])("does not start background recovery when %s is %s", async (name, value) => {
    vi.stubEnv(name, value); await register();
    for (const runner of Object.values(runners)) expect(runner).not.toHaveBeenCalled();
  });
});
