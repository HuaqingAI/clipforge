// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
const state = vi.hoisted(() => ({ directory: "", preview: vi.fn(), start: vi.fn(), action: vi.fn(), list: vi.fn(), get: vi.fn(), runner: vi.fn(), wake: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/paths", () => ({ getDataDir: () => state.directory }));
vi.mock("@/lib/kling/film-plan", () => ({ previewKlingFilm: state.preview }));
vi.mock("@/lib/kling/films", () => ({ startKlingFilm: state.start, klingFilmAction: state.action, startKlingFilmRunner: state.runner, wakeKlingFilmRunner: state.wake }));
vi.mock("@/lib/kling/film-repository", () => ({ listKlingFilms: state.list, getKlingFilm: state.get, klingFilmView: (value: unknown) => value }));
vi.mock("@/lib/kling/delete-film", () => ({ deleteKlingFilm: state.remove }));
import { createKlingLocalSession } from "@/lib/kling/local-access";
import { GET as list, POST as start } from "@/app/api/integrations/kling/films/route";
import { POST as preview } from "@/app/api/integrations/kling/films/preview/route";
import { GET as detail, DELETE as remove } from "@/app/api/integrations/kling/films/[id]/route";
import { POST as action } from "@/app/api/integrations/kling/films/[id]/[action]/route";

let credentials: Record<string, string>;
function request(method: string, headers: Record<string, string> = {}, body: unknown = {}) {
  return new NextRequest("http://127.0.0.1:3000/api/integrations/kling/films", { method,
    headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json", ...headers },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}
const removedRoutes = [
  { name: "preview", method: "POST", call: (req: NextRequest) => preview(req) },
  { name: "start", method: "POST", call: (req: NextRequest) => start(req) },
  ...["resume", "retry-shot", "retry-compose", "continue"].map((name) => ({ name, method: "POST", call: (req: NextRequest) => action(req, { params: Promise.resolve({ id: "run-1", action: name }) }) })),
];
const historicalRoutes = [
  { name: "list", method: "GET", call: (req: NextRequest) => list(req) },
  { name: "detail", method: "GET", call: (req: NextRequest) => detail(req, { params: Promise.resolve({ id: "run-1" }) }) },
  { name: "delete", method: "DELETE", call: (req: NextRequest) => remove(req, { params: Promise.resolve({ id: "run-1" }) }) },
  ...["pause", "cancel"].map((name) => ({ name, method: "POST", call: (req: NextRequest) => action(req, { params: Promise.resolve({ id: "run-1", action: name }) }) })),
];
const routes = [...removedRoutes, ...historicalRoutes];
const downstream = [state.preview, state.start, state.action, state.list, state.get, state.runner, state.wake, state.remove];
beforeAll(async () => {
  state.directory = await mkdtemp(join(tmpdir(), "clipforge-film-routes-"));
  const session = await createKlingLocalSession(request("GET", { "x-clipforge-kling": "1" }));
  credentials = { cookie: session.headers.get("set-cookie")!.split(";")[0], "x-clipforge-kling-csrf": (await session.json()).csrfToken };
});
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("APP_MIGRATIONS_DIR", ""); vi.stubEnv("CLIPFORGE_KLING_DISABLED", ""); vi.stubEnv("CLIPFORGE_RUNTIME", "");
  state.preview.mockResolvedValue({ runId: "draft-1", status: "draft" });
  state.start.mockResolvedValue({ runId: "run-1", status: "running" });
  state.action.mockResolvedValue({ runId: "run-1", status: "paused" });
  state.list.mockReturnValue([{ runId: "run-1" }]); state.get.mockReturnValue({ runId: "run-1" });
  state.remove.mockReturnValue({ deleted: true, runId: "run-1" });
});
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => { await rm(state.directory, { recursive: true, force: true }); });
describe("local film endpoints", () => {
  it.each(routes)("requires a signed session and CSRF for $name", async ({ method, call }) => {
    const result = await call(request(method));
    expect(result.status).toBe(401);
    expect((await result.json()).error.code).toBe("KLING_LOCAL_ACCESS_DENIED");
    for (const spy of downstream) expect(spy).not.toHaveBeenCalled();
  });
  it.each(routes)("blocks cross-origin calls and desktop mode for $name", async ({ method, call }) => {
    expect((await call(request(method, { ...credentials, origin: "https://evil.example" }))).status).toBe(403);
    vi.stubEnv("CLIPFORGE_RUNTIME", "desktop");
    expect((await call(request(method, credentials))).status).toBe(503);
    for (const spy of downstream) expect(spy).not.toHaveBeenCalled();
  });
  it.each(removedRoutes)("rejects removed $name without reading its payload or dispatching downstream work", async ({ method, call }) => {
    const req = request(method, credentials);
    const readBody = vi.spyOn(req, "json");
    const result = await call(req);
    expect(result.status).toBe(410);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toMatchObject({ error: { code: "KLING_FILM_REMOVED", message: expect.stringContaining("Kling 整片生成功能已移除"), retryable: false } });
    expect(readBody).not.toHaveBeenCalled();
    for (const spy of downstream) expect(spy).not.toHaveBeenCalled();
  });
  it.each(historicalRoutes)("keeps authenticated historical $name management available without caching", async ({ name, method, call }) => {
    vi.stubEnv("APP_MIGRATIONS_DIR", "standalone-migrations");
    const body = { test: name };
    const result = await call(request(method, credentials, body));
    expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("no-store");
    if (name === "list") expect(state.list).toHaveBeenCalledWith(undefined);
    else if (name === "detail") expect(state.get).toHaveBeenCalledWith("run-1");
    else if (name === "delete") expect(state.remove).toHaveBeenCalledWith("run-1");
    else if (method === "POST") expect(state.action).toHaveBeenCalledWith("run-1", name, body);
    expect(state.preview).not.toHaveBeenCalled();
    expect(state.start).not.toHaveBeenCalled();
    expect(state.runner).not.toHaveBeenCalled();
    expect(state.wake).not.toHaveBeenCalled();
  });
  it("requires the mutation CSRF token when deleting an existing record", async () => {
    const result = await remove(request("DELETE", { cookie: credentials.cookie }), { params: Promise.resolve({ id: "run-1" }) });
    expect(result.status).toBe(401);
    expect(state.remove).not.toHaveBeenCalled();
  });
});
