// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentScriptOptions, generateProjectScripts, type SavedScript } from "@/lib/script-generation-client";

const queue = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hooks/use-generation-runs", () => ({ submitGenerationRun: queue }));
const request = vi.fn();
function script(id: string, version: number, selected: boolean): SavedScript {
  return { id, version, selected, title: id, styleType: "scene", totalDuration: 30, shots: [] };
}
function completion(scripts: SavedScript[], historical = false) {
  return { id: "completed-run", projectId: "A", status: "completed", items: [{ kind: "script", status: "completed", result: { scripts, historical, warning: historical ? "Saved as history" : undefined } }] };
}
function generate(signal = new AbortController().signal) {
  return generateProjectScripts({ endpoint: "/api/llm/script", projectId: "A", knownScriptIds: ["selected-original"], payload: { productName: "Original product" }, signal, messages: { failed: "Generation failed", reload: "Reload scripts failed", unconfirmed: "Generation unconfirmed" } });
}
beforeEach(() => { queue.mockReset(); request.mockReset(); vi.stubGlobal("fetch", request); });
afterEach(() => vi.unstubAllGlobals());

describe("completed script selection reconciliation", () => {
  it.each([true, false])("reloads canonical selection for a historical=%s result whose generated rows are unselected", async (historical) => {
    const original = script("selected-original", 1, true);
    const generated = script("late-generated", 2, false);
    queue.mockResolvedValue(completion([generated], historical));
    request.mockResolvedValue(Response.json([original, generated]));
    const rows = await generate();
    expect(rows).toEqual([original, generated]);
    expect(currentScriptOptions(rows)).toEqual([original]);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0]).toBe("/api/project/A/scripts");
  });

  it("trusts canonical selection for a historical result even when its snapshot claims selection", async () => {
    const original = script("selected-original", 1, true);
    queue.mockResolvedValue(completion([script("late-generated", 2, true)], true));
    request.mockResolvedValue(Response.json([original, script("late-generated", 2, false)]));
    expect(currentScriptOptions(await generate())).toEqual([original]);
  });

  it("returns a current selected generation immediately without an unnecessary reload", async () => {
    const generated = [script("new-selected", 2, true), script("alternative", 2, false)];
    queue.mockResolvedValue(completion(generated));
    expect(await generate()).toEqual(generated);
    expect(request).not.toHaveBeenCalled();
  });

  it("surfaces a canonical reload failure instead of returning an empty selection", async () => {
    queue.mockResolvedValue(completion([script("historical", 2, false)], true));
    request.mockResolvedValue(Response.json({ error: "Temporary storage failure" }, { status: 503 }));
    await expect(generate()).rejects.toThrow("Reload scripts failed");
  });
});
