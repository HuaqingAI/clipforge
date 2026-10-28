import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskCenter } from "@/components/task-center";
import type { TaskFeed } from "@/lib/task-feed";

const state = vi.hoisted(() => ({ locale: "zh", push: vi.fn(), refresh: vi.fn(), feed: { active: [], attention: [], recent: [] } as TaskFeed }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("@/lib/i18n", () => ({ useLocale: () => state.locale, useT: () => (key: string) => key }));
vi.mock("@/lib/hooks/use-task-feed", () => ({ useTaskFeed: () => ({ feed: state.feed, loading: false, error: false, updatedAt: null, refresh: state.refresh }) }));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick(): void }) => <button onClick={onClick}>{children}</button>,
}));

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.push.mockReset(); state.refresh.mockReset(); state.locale = "zh";
  state.feed = { active: [{ id: "single", projectId: "A", projectName: "Project A", kind: "generation", generationKind: "keyframe_refine", status: "queued", total: 1, done: 0 }],
    attention: [{ id: "batch", projectId: "B", projectName: "Project B", kind: "generation", generationKind: "keyframe_refine_batch", status: "needs_attention", total: 3, done: 2 }], recent: [] };
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("refinement task center entries", () => {
  it.each(["zh", "en"])("shows single and batch refinement across projects with restore links in %s", async (locale) => {
    state.locale = locale;
    await act(async () => root.render(<TaskCenter />));
    expect(container.textContent).toContain(`${locale === "en" ? "Keyframe refinement" : "关键帧精修"} · 0/1`);
    expect(container.textContent).toContain(`${locale === "en" ? "Keyframe refinement" : "关键帧精修"} · 2/3`);
    const row = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Project B"))!;
    await act(async () => row.click());
    expect(state.push).toHaveBeenCalledWith("/project/B/assets?runId=batch");
  });
});
