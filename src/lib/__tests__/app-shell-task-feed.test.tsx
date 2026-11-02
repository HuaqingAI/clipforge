import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/app-shell";
import { TASK_ACTIVE_POLL_MS, TASK_IDLE_POLL_MS } from "@/lib/hooks/use-task-feed";
import type { TaskFeed } from "@/lib/task-feed";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock("@/lib/i18n", () => ({ useLocale: () => "zh", useT: () => (key: string) => key }));
vi.mock("@/components/language-toggle", () => ({ LanguageToggle: () => null }));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children, "aria-label": ariaLabel, title }: { children: ReactNode; "aria-label"?: string; title?: string }) => <button aria-label={ariaLabel} title={title}>{children}</button>,
  DropdownMenuItem: ({ children, onClick, disabled }: { children: ReactNode; onClick(): void; disabled?: boolean }) => <button onClick={onClick} disabled={disabled}>{children}</button>,
}));

let root: Root;
let container: HTMLDivElement;
let feed: TaskFeed;
const fetchMock = vi.fn();
const tick = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const taskButtons = () => [...container.querySelectorAll<HTMLButtonElement>('button[title="taskCenter"]')];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  feed = { active: [], attention: [], recent: [] };
  fetchMock.mockReset().mockImplementation(async () => new Response(JSON.stringify(feed), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AppShell task feed", () => {
  it("shares one initial request, polling schedule and manual refresh across both responsive task centers", async () => {
    await act(async () => root.render(<AppShell>Page</AppShell>));
    await tick();
    expect(taskButtons()).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/tasks", expect.any(Object));

    feed = { ...feed, active: [{ kind: "compose", id: "active", projectId: "project-a" }] };
    await tick(TASK_IDLE_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(taskButtons().map((button) => button.getAttribute("aria-label"))).toEqual(["taskCenter · 1", "taskCenter · 1"]);

    await tick(TASK_ACTIVE_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    feed = { active: [], attention: [], recent: [] };
    const refreshButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "taskRefresh")!;
    await act(async () => refreshButton.click());
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(taskButtons().map((button) => button.getAttribute("aria-label"))).toEqual(["taskCenter", "taskCenter"]);
  });
});
