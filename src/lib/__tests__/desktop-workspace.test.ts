// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { resolveWorkspaceSelection, saveWorkspace, loadWorkspace } = createRequire(import.meta.url)("../../../electron/workspace.cjs");
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clipforge-旧工作区 "));
  roots.push(root);
  const data = join(root, "data");
  mkdirSync(data);
  writeFileSync(join(data, "sqlite.db"), "immutable database fixture");
  writeFileSync(join(data, "generation-task.key"), Buffer.alloc(32, 7));
  return { root, data };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("legacy desktop workspace selection", () => {
  it("opens the whole existing workspace without copying a database or replacing the task key", () => {
    const { root, data } = fixture();
    const settings = join(root, "desktop-user");
    expect(resolveWorkspaceSelection(root).dataDir).toBe(data);
    expect(saveWorkspace(settings, data)).toBe(data);
    expect(loadWorkspace(settings)).toBe(data);
    expect(readFileSync(join(data, "sqlite.db"), "utf8")).toBe("immutable database fixture");
    expect(readFileSync(join(data, "generation-task.key"))).toEqual(Buffer.alloc(32, 7));
  });
  it("rejects a running old Web launcher before storing the new workspace", () => {
    const { root, data } = fixture();
    mkdirSync(join(root, ".clipforge"));
    writeFileSync(join(root, ".clipforge/launcher.lock"), JSON.stringify({ pid: process.pid }));
    expect(() => resolveWorkspaceSelection(data)).toThrow(/Web 服务仍在运行/);
  });
  it("rejects an incomplete selection and a corrupt encryption key", () => {
    const { root, data } = fixture();
    mkdirSync(join(root, "empty"));
    expect(() => resolveWorkspaceSelection(join(root, "empty"))).toThrow(/sqlite.db/);
    writeFileSync(join(data, "generation-task.key"), "broken");
    expect(() => resolveWorkspaceSelection(data)).toThrow(/密钥/);
  });
  it("uses the default workspace only when its saved selection is absent", () => {
    const { root } = fixture();
    expect(loadWorkspace(join(root, "new-desktop-user"))).toBeNull();
  });
  it.each([
    "{broken",
    "null",
    "[]",
    "false",
    "42",
    JSON.stringify({ schemaVersion: 2, dataDir: "C:\\old-workspace" }),
    JSON.stringify({ schemaVersion: 1, dataDir: "relative-workspace" }),
    JSON.stringify({ schemaVersion: 1 }),
  ])("rejects a damaged saved selection instead of silently opening an empty workspace: %s", (content) => {
    const { root } = fixture();
    writeFileSync(join(root, "workspace.json"), content);
    expect(() => loadWorkspace(root)).toThrow(/workspace\.json/);
  });
  it("reports an unreadable saved selection instead of silently opening an empty workspace", () => {
    const { root } = fixture();
    mkdirSync(join(root, "workspace.json"));
    expect(() => loadWorkspace(root)).toThrow(/workspace\.json/);
  });
});
