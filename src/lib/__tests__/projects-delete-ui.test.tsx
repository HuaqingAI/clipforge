import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProjectsPage from "@/app/projects/page";

vi.mock("@/lib/i18n", () => ({ useT: () => (key: string) => key, useLocale: () => "zh" }));

const fetchMock = vi.fn();
const projects = [
  { id: "project-1", name: "Dining table project", productName: "Dining table", status: "assets", updatedAt: "2026-10-20T00:00:00Z" },
  { id: "project-2", name: "Coffee maker project", productName: "Coffee maker", status: "assets", updatedAt: "2026-10-19T00:00:00Z" },
];
const works = [
  { id: "work-1", projectId: "project-1", projectName: "Dining table project", productName: "Dining table", label: "Table film", duration: 10, createdAt: "2026-10-20T00:00:00Z", url: "/api/output/table.mp4", thumbnailUrl: null },
  { id: "work-2", projectId: "project-2", projectName: "Coffee maker project", productName: "Coffee maker", label: "Coffee film", duration: 10, createdAt: "2026-10-19T00:00:00Z", url: "/api/output/coffee.mp4", thumbnailUrl: null },
];
const blockedMessage = "项目仍有待恢复的 Kling 任务，请先处理原任务，避免丢失已生成视频";
let root: Root, container: HTMLDivElement;
let confirmMock: ReturnType<typeof vi.spyOn>;
let alertMock: ReturnType<typeof vi.spyOn>;
let deletion: () => Promise<Response>;

function projectCard(id = "project-1") {
  return (container.querySelector(`a[href="/project/${id}/assets"]`)?.closest('[data-slot="card"]') ?? null) as HTMLDivElement | null;
}
function deleteButton(id = "project-1") { return projectCard(id)!.querySelector('button[title="deleteProject"]') as HTMLButtonElement; }
function workCard(id = "work-1") {
  return (container.querySelector(`a[href="${works.find((work) => work.id === id)!.url}?download=1"]`)?.closest('[data-slot="card"]') ?? null) as HTMLDivElement | null;
}
function deleteWorkButton(id = "work-1") { return workCard(id)!.querySelector('button[title="deleteWork"]') as HTMLButtonElement; }
function button(text: string) { return [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(text))!; }
function deleteCalls() { return fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE"); }
async function mount() { await act(async () => root.render(<ProjectsPage />)); }
async function clickDelete() { await act(async () => deleteButton().click()); }

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", fetchMock);
  confirmMock = vi.spyOn(window, "confirm").mockReturnValue(true);
  alertMock = vi.spyOn(window, "alert").mockImplementation(() => undefined);
  deletion = async () => Response.json({ success: true });
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/project" && !init?.method) return Response.json(projects);
    if (url === "/api/works") return Response.json({ works });
    if (url === "/api/project/project-1" && init?.method === "DELETE") return deletion();
    if (url === "/api/works/work-1" && init?.method === "DELETE") return deletion();
    throw new Error("Unexpected request: " + url);
  });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});

describe("work deletion feedback", () => {
  it("keeps playback and downloads available and leaves the work unchanged when cancelled", async () => {
    confirmMock.mockReturnValue(false);
    await mount();
    await act(async () => button("tabWorks").click());
    const card = workCard()!;
    expect(card.querySelector('a[href="/project/project-1/export"]')).toBeTruthy();
    expect(card.querySelector('a[title="download"]')).toBeTruthy();
    expect(card.querySelector("a button")).toBeNull();
    await act(async () => deleteWorkButton().click());
    expect(confirmMock).toHaveBeenCalledExactlyOnceWith("deleteWorkConfirm");
    expect(deleteCalls()).toHaveLength(0);
    expect(workCard()).toBeTruthy();
    expect(container.querySelectorAll('button[title="deleteWork"]')).toHaveLength(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("prevents repeat deletion and removes only the chosen work while keeping its project", async () => {
    let finishDelete!: (response: Response) => void;
    deletion = () => new Promise<Response>((resolve) => { finishDelete = resolve; });
    await mount();
    await act(async () => button("tabWorks").click());
    const remove = deleteWorkButton();
    await act(async () => { remove.click(); remove.click(); });
    expect(deleteCalls()).toEqual([["/api/works/work-1", { method: "DELETE", headers: { "Accept-Language": "zh" } }]]);
    expect(confirmMock).toHaveBeenCalledOnce();
    expect(deleteWorkButton().disabled).toBe(true);
    expect(deleteWorkButton().querySelector(".animate-spin")).toBeTruthy();
    expect(deleteWorkButton("work-2").disabled).toBe(false);
    expect(workCard()).toBeTruthy();
    await act(async () => finishDelete(Response.json({ deleted: true, workId: "work-1" })));
    expect(workCard()).toBeNull();
    expect(workCard("work-2")).toBeTruthy();
    expect(button("tabWorks").textContent).toContain("(1)");
    await act(async () => button("tabProjects").click());
    expect(projectCard()).toBeTruthy();
    expect(projectCard("project-2")).toBeTruthy();
    expect(alertMock).not.toHaveBeenCalled();
  });

  it.each(["server", "non-json", "network"])("retains a work and shows an inline error after a %s failure", async (kind) => {
    deletion = async () => {
      if (kind === "network") throw new TypeError("Network unavailable");
      return kind === "server" ? Response.json({ error: "此作品正在导出，请稍后再删除。" }, { status: 409 }) : new Response("upstream failed", { status: 502 });
    };
    await mount();
    await act(async () => button("tabWorks").click());
    await act(async () => deleteWorkButton().click());
    expect(workCard()).toBeTruthy();
    expect(workCard()!.querySelector('[role="alert"]')?.textContent).toContain(kind === "server" ? "此作品正在导出，请稍后再删除。" : "deleteWorkFailed");
    expect(workCard("work-2")!.querySelector('[role="alert"]')).toBeNull();
    expect(button("tabWorks").textContent).toContain("(2)");
    expect(deleteWorkButton().disabled).toBe(false);
    expect(alertMock).not.toHaveBeenCalled();
  });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("project deletion feedback", () => {
  it.each([
    { kind: "kling_film", id: "film-1", parameter: "klingFilm", label: "deleteReviewFilm" },
    { kind: "kling_job", id: "job-1", parameter: "klingJob", label: "deleteReviewJob" },
  ])("shows the server reason and the original $kind recovery link inside its project card", async ({ kind, id, parameter, label }) => {
    const href = `/project/project-1/assets?${parameter}=${id}`;
    deletion = async () => Response.json({ error: blockedMessage, code: "PROJECT_HAS_UNRESOLVED_KLING_TASKS", blockingTasks: [{ kind, id, href }] }, { status: 409 });
    await mount(); await clickDelete();
    expect(confirmMock).toHaveBeenCalledOnce();
    expect(confirmMock).toHaveBeenCalledWith("deleteConfirm");
    expect(deleteCalls()).toHaveLength(1);
    const card = projectCard()!;
    expect(card.querySelector('[role="alert"]')?.textContent).toContain(blockedMessage);
    expect(card.querySelector(`a[href="${href}"]`)?.textContent).toContain(label);
    expect(projectCard("project-2")!.querySelector('[role="alert"]')).toBeNull();
    expect(deleteButton().disabled).toBe(false);
    expect(alertMock).not.toHaveBeenCalled();
    await act(async () => button("tabWorks").click());
    expect(container.querySelector('a[href="/api/output/table.mp4?download=1"]')).toBeTruthy();
    expect(container.querySelector('a[href="/api/output/coffee.mp4?download=1"]')).toBeTruthy();
  });

  it("retains the confirmation step and leaves projects and works unchanged when deletion is cancelled", async () => {
    confirmMock.mockReturnValue(false);
    await mount(); await clickDelete();
    expect(confirmMock).toHaveBeenCalledOnce();
    expect(deleteCalls()).toHaveLength(0);
    expect(projectCard()).toBeTruthy();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => button("tabWorks").click());
    expect(container.querySelectorAll('a[title="download"]')).toHaveLength(2);
    expect(alertMock).not.toHaveBeenCalled();
  });

  it("disables duplicate submission while deleting and removes only the successful project's card and works", async () => {
    let finishDelete!: (response: Response) => void;
    deletion = () => new Promise<Response>((resolve) => { finishDelete = resolve; });
    await mount();
    const remove = deleteButton();
    await act(async () => { remove.click(); remove.click(); });
    expect(deleteCalls()).toHaveLength(1);
    expect(confirmMock).toHaveBeenCalledOnce();
    expect(deleteButton().disabled).toBe(true);
    expect(deleteButton().querySelector(".animate-spin")).toBeTruthy();
    expect(projectCard()).toBeTruthy();
    await act(async () => button("tabWorks").click());
    expect(container.querySelectorAll('a[title="download"]')).toHaveLength(2);
    await act(async () => finishDelete(Response.json({ success: true })));
    expect(container.querySelector('a[href="/api/output/table.mp4?download=1"]')).toBeNull();
    expect(container.querySelector('a[href="/api/output/coffee.mp4?download=1"]')).toBeTruthy();
    await act(async () => button("tabProjects").click());
    expect(projectCard()).toBeNull();
    expect(projectCard("project-2")).toBeTruthy();
    expect(alertMock).not.toHaveBeenCalled();
  });

  it("uses the translated fallback inline when the deletion error is not JSON", async () => {
    deletion = async () => new Response("<html>upstream failed</html>", { status: 502, headers: { "Content-Type": "text/html" } });
    await mount(); await clickDelete();
    expect(projectCard()!.querySelector('[role="alert"]')?.textContent).toContain("deleteFailed");
    expect(projectCard()!.textContent).not.toContain("<html>");
    expect(deleteButton().disabled).toBe(false);
    expect(alertMock).not.toHaveBeenCalled();
  });
});
