// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runners = vi.hoisted(() => ({ jobsStart: vi.fn(), jobsWake: vi.fn() }));
const generation = vi.hoisted(() => ({ start: vi.fn(), wake: vi.fn() }));
const workspace = vi.hoisted(() => ({ lock: vi.fn() }));
const recovery = vi.hoisted(() => ({ compositions: vi.fn() }));
const lifecycle = vi.hoisted(() => ({ attach: vi.fn() }));
vi.mock("@/lib/workspace-lock", () => ({ acquireWorkspaceLock: workspace.lock }));
vi.mock("@/lib/startup-recovery", () => ({ recoverInterruptedCompositions: recovery.compositions }));
vi.mock("@/lib/server/desktop-lifecycle", () => ({ attachDesktopShutdown: lifecycle.attach }));
vi.mock("@/lib/generation-runs", () => ({ startGenerationRunner: generation.start, wakeGenerationRunner: generation.wake, stopGenerationRunner: vi.fn() }));
vi.mock("@/lib/kling/jobs", () => ({ startKlingJobRunner: runners.jobsStart, wakeKlingJobRunner: runners.jobsWake, stopKlingJobRunner: vi.fn() }));
import { register } from "@/instrumentation";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_RUNTIME", "nodejs"); vi.stubEnv("NEXT_PHASE", "");
  vi.stubEnv("CLIPFORGE_RUNTIME", ""); vi.stubEnv("CLIPFORGE_KLING_DISABLED", "");
  vi.stubEnv("APP_MIGRATIONS_DIR", "standalone-migrations");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("Kling startup instrumentation", () => {
  it("starts shot recovery and ordinary generation recovery", async () => {
    await register();
    expect(runners.jobsStart).toHaveBeenCalledOnce();
    expect(runners.jobsWake).toHaveBeenCalledOnce();
    expect(generation.start).toHaveBeenCalledOnce();
    expect(lifecycle.attach).not.toHaveBeenCalled();
    expect(workspace.lock.mock.invocationCallOrder[0]).toBeLessThan(recovery.compositions.mock.invocationCallOrder[0]);
    expect(recovery.compositions.mock.invocationCallOrder[0]).toBeLessThan(generation.start.mock.invocationCallOrder[0]);
  });
  it("does not open the workspace or start any tasks in installation probe mode", async () => {
    vi.stubEnv("CLIPFORGE_PROBE_MODE", "1");
    await register();
    expect(workspace.lock).not.toHaveBeenCalled();
    expect(recovery.compositions).not.toHaveBeenCalled();
    expect(generation.start).not.toHaveBeenCalled();
    expect(generation.wake).not.toHaveBeenCalled();
    expect(runners.jobsStart).not.toHaveBeenCalled();
  });
  it.each([
    ["CLIPFORGE_RUNTIME", "desktop"], ["CLIPFORGE_KLING_DISABLED", "1"],
    ["NEXT_PHASE", "phase-production-build"], ["NEXT_RUNTIME", "edge"],
  ])("does not start background recovery when %s is %s", async (name, value) => {
    vi.stubEnv(name, value); await register();
    for (const runner of Object.values(runners)) expect(runner).not.toHaveBeenCalled();
  });
  it("keeps ordinary generation recovery enabled on desktop without Kling", async () => {
    vi.stubEnv("CLIPFORGE_RUNTIME", "desktop"); await register();
    expect(generation.start).toHaveBeenCalledOnce();
    expect(generation.wake).toHaveBeenCalledOnce();
    expect(runners.jobsStart).not.toHaveBeenCalled();
    expect(lifecycle.attach).toHaveBeenCalledOnce();
  });
});
