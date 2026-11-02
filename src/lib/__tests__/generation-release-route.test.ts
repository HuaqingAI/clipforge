// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock("@/lib/generation-runs", () => ({
  generationRunAction: state.action,
  GenerationRunError: class extends Error { constructor(message: string, public status = 400, public code = "INVALID_GENERATION_RUN") { super(message); } },
}));
import { GenerationRunError } from "@/lib/generation-runs";
import { POST } from "@/app/api/generation-runs/[id]/route";

const input = { action: "release_block", itemId: "item-4", projectId: "A", acknowledgePossibleCharge: true };
function request(body: unknown) { return new NextRequest("http://local/api/generation-runs/run-1", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
beforeEach(() => { state.action.mockReset().mockReturnValue({ id: "run-1", items: [{ id: "item-4", status: "cancelled", stage: "released" }] }); });

describe("interrupted generation release route", () => {
  it("forwards the selected run, item, project and explicit acknowledgement", async () => {
    const response = await POST(request(input), { params: Promise.resolve({ id: "run-1" }) });
    expect(state.action).toHaveBeenCalledExactlyOnceWith("run-1", "release_block", input);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [{ id: "item-4", stage: "released" }] });
  });
  it.each([null, [], { itemId: "item-4" }, { action: 123 }])("rejects malformed action data: %j", async (body) => {
    const response = await POST(request(body), { params: Promise.resolve({ id: "run-1" }) });
    expect(response.status).toBe(400);
    expect(state.action).not.toHaveBeenCalled();
  });
  it.each([400, 404, 409, 410])("preserves a %i backend rejection", async (status) => {
    state.action.mockImplementation(() => { throw new GenerationRunError("Cannot release this task", status, "RELEASE_CONFLICT"); });
    const response = await POST(request(input), { params: Promise.resolve({ id: "run-1" }) });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: "Cannot release this task", code: "RELEASE_CONFLICT" });
  });
});
