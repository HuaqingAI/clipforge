// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({ remove: vi.fn(), wake: vi.fn() }));
vi.mock("@/lib/generation-runs", () => ({
  deleteGenerationRuns: state.remove, wakeGenerationRunner: state.wake,
  GenerationRunError: class extends Error { constructor(message: string, public status = 400, public code = "INVALID_GENERATION_RUN") { super(message); } },
}));
import { GenerationRunError } from "@/lib/generation-runs";
import { DELETE as bulkDelete } from "@/app/api/generation-runs/route";
import { DELETE as singleDelete } from "@/app/api/generation-runs/[id]/route";

beforeEach(() => { vi.clearAllMocks(); state.remove.mockReturnValue({ deletedIds: ["run-1"], deletedCount: 1 }); });
describe("generation record DELETE routes", () => {
  it("passes the required current-project scope to single and bulk deletion", async () => {
    const req = new NextRequest("http://local/api/generation-runs?projectId=current");
    const single = await singleDelete(req, { params: Promise.resolve({ id: "run-1" }) });
    expect(state.remove).toHaveBeenLastCalledWith("current", "run-1");
    expect(single.status).toBe(200); expect(await single.json()).toEqual({ deletedIds: ["run-1"], deletedCount: 1 });
    const bulk = await bulkDelete(req);
    expect(state.remove).toHaveBeenLastCalledWith("current"); expect(bulk.status).toBe(200);
    expect(state.wake).not.toHaveBeenCalled();
  });
  it("does not silently replace a missing project scope", async () => {
    state.remove.mockImplementation(() => { throw new GenerationRunError("Current project required", 400, "GENERATION_PROJECT_REQUIRED"); });
    const response = await bulkDelete(new NextRequest("http://local/api/generation-runs"));
    expect(state.remove).toHaveBeenCalledWith(null);
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "GENERATION_PROJECT_REQUIRED" });
  });
  it.each([404, 409, 410])("preserves backend conflict status %i", async (status) => {
    state.remove.mockImplementation(() => { throw new GenerationRunError("Cannot delete", status, "DELETE_CONFLICT"); });
    const response = await singleDelete(new NextRequest("http://local/api/generation-runs/run-1?projectId=A"), { params: Promise.resolve({ id: "run-1" }) });
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: "Cannot delete", code: "DELETE_CONFLICT" });
  });
});
