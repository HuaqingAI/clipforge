"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { LuPlus, LuFolderOpen, LuLoader, LuTrash2, LuDownload, LuImage, LuPlay } from "react-icons/lu";
import { useT, useLocale } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/relative-time";
import { ShotLibrary } from "./_components/shot-library";

interface ProjectRow {
  id: string;
  name: string;
  productName: string | null;
  productImages?: string[] | null;
  status: string;
  updatedAt: string | null;
}

interface WorkRow {
  id: string;
  projectId: string;
  projectName: string | null;
  productName: string | null;
  label: string | null;
  duration: number | null;
  createdAt: string | null;
  url: string;
  thumbnailUrl: string | null;
}

interface ProjectDeleteIssue {
  message: string;
  blockingTasks: Array<{ kind: "kling_job" | "kling_film"; id: string; href: string }>;
}

function projectDeleteIssue(body: unknown, projectId: string, fallback: string): ProjectDeleteIssue {
  const payload = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const message = typeof payload.error === "string" && payload.error.trim() ? payload.error : fallback;
  const blockingTasks: ProjectDeleteIssue["blockingTasks"] = [];
  if (payload.code === "PROJECT_HAS_UNRESOLVED_KLING_TASKS" && Array.isArray(payload.blockingTasks)) {
    for (const value of payload.blockingTasks) {
      if (!value || typeof value !== "object") continue;
      const task = value as Record<string, unknown>;
      if ((task.kind !== "kling_job" && task.kind !== "kling_film") || typeof task.id !== "string" || !task.id) continue;
      const query = task.kind === "kling_film" ? "klingFilm" : "klingJob";
      const href = `/project/${encodeURIComponent(projectId)}/assets?${query}=${encodeURIComponent(task.id)}`;
      if (task.href === href) blockingTasks.push({ kind: task.kind, id: task.id, href });
    }
  }
  return { message, blockingTasks };
}

// project status → the pipeline step to resume at (done lands on export where the film lives)
function stepFor(status: string): string {
  if (status === "done") return "export";
  if (status === "composing" || status === "video") return "video";
  if (status === "assets") return "assets";
  return "script";
}

// project status → common.status* i18n key
function statusKeyFor(status: string): string {
  switch (status) {
    case "done": return "statusDone";
    case "composing": return "statusComposing";
    case "video": return "statusVideo";
    case "assets": return "statusAssets";
    case "scripting": return "statusScripting";
    default: return "statusDraft";
  }
}

/**
 * Project library with three views:
 * - Projects: every project, searchable, resuming at the right step — now with a poster
 *   (latest render's first frame, falling back to the product photo) and a delete entrance.
 * - Works: the cross-project feed of finished videos, newest first, found by their pictures
 *   instead of by opening N export pages one by one.
 * - Shots: locally saved generated takes, grouped by project and script.
 */
export default function ProjectsPage() {
  const t = useT("projectsPage");
  const tc = useT("common");
  const locale = useLocale();
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [works, setWorks] = useState<WorkRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"projects" | "works" | "shots">("projects");
  const [shotCount, setShotCount] = useState<number | null>(null);
  const [removedProjectIds, setRemovedProjectIds] = useState<string[]>([]);
  const [deleteIssues, setDeleteIssues] = useState<Record<string, ProjectDeleteIssue>>({});
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const deleting = useRef(new Set<string>());
  const [workDeleteErrors, setWorkDeleteErrors] = useState<Record<string, string>>({});
  const [deletingWorkIds, setDeletingWorkIds] = useState<Set<string>>(new Set());
  const deletingWorks = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [projRes, workRes] = await Promise.all([
          fetch("/api/project"),
          fetch("/api/works").catch(() => null),
        ]);
        if (!projRes.ok) throw new Error(String(projRes.status));
        const data = await projRes.json();
        const list: ProjectRow[] = Array.isArray(data) ? data : [];
        const ts = (p: ProjectRow) => {
          if (!p.updatedAt) return 0;
          const time = new Date(p.updatedAt).getTime();
          return Number.isFinite(time) ? time : 0;
        };
        if (!cancelled) setRows([...list].sort((a, b) => ts(b) - ts(a)));
        if (workRes?.ok) {
          const w = await workRes.json().catch(() => ({}));
          if (!cancelled && Array.isArray(w?.works)) setWorks(w.works as WorkRow[]);
        }
      } catch {
        if (!cancelled) setLoadError(t("loadError"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once; t is stable per locale
  }, []);

  // works are newest-first → first occurrence per project = its latest poster
  const posterByProject = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of works) {
      if (w.thumbnailUrl && !m.has(w.projectId)) m.set(w.projectId, w.thumbnailUrl);
    }
    return m;
  }, [works]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((p) =>
      (p.name || "").toLowerCase().includes(q) || (p.productName || "").toLowerCase().includes(q)
    );
  }, [rows, query]);

  // delete = destructive: text-level confirm first; the row disappears only after the API succeeds
  const handleDelete = async (p: ProjectRow) => {
    if (deleting.current.has(p.id)) return;
    if (!window.confirm(t("deleteConfirm", { name: p.name || p.productName || t("untitled") }))) return;
    deleting.current.add(p.id);
    setDeletingIds(new Set(deleting.current));
    setDeleteIssues((prev) => {
      const next = { ...prev }; delete next[p.id]; return next;
    });
    try {
      const res = await fetch(`/api/project/${p.id}`, { method: "DELETE", headers: { "Accept-Language": locale } });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        const issue = projectDeleteIssue(body, p.id, t("deleteFailed"));
        setDeleteIssues((prev) => ({ ...prev, [p.id]: issue }));
        return;
      }
      setRows((prev) => prev.filter((r) => r.id !== p.id));
      setWorks((prev) => prev.filter((w) => w.projectId !== p.id));
      setRemovedProjectIds((prev) => [...prev, p.id]);
    } catch {
      setDeleteIssues((prev) => ({ ...prev, [p.id]: { message: t("deleteFailed"), blockingTasks: [] } }));
    } finally {
      deleting.current.delete(p.id);
      setDeletingIds(new Set(deleting.current));
    }
  };

  const handleDeleteWork = async (work: WorkRow) => {
    if (deletingWorks.current.has(work.id)) return;
    if (!window.confirm(t("deleteWorkConfirm", { name: work.label || work.productName || work.projectName || t("untitled") }))) return;
    deletingWorks.current.add(work.id);
    setDeletingWorkIds(new Set(deletingWorks.current));
    setWorkDeleteErrors((prev) => {
      const next = { ...prev }; delete next[work.id]; return next;
    });
    try {
      const res = await fetch(`/api/works/${encodeURIComponent(work.id)}`, { method: "DELETE", headers: { "Accept-Language": locale } });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        const payload = body && typeof body === "object" ? body as { error?: unknown } : {};
        const message = typeof payload.error === "string" && payload.error.trim() ? payload.error : t("deleteWorkFailed");
        setWorkDeleteErrors((prev) => ({ ...prev, [work.id]: message }));
        return;
      }
      setWorks((prev) => prev.filter((item) => item.id !== work.id));
    } catch {
      setWorkDeleteErrors((prev) => ({ ...prev, [work.id]: t("deleteWorkFailed") }));
    } finally {
      deletingWorks.current.delete(work.id);
      setDeletingWorkIds(new Set(deletingWorks.current));
    }
  };

  return (
    <div className="min-h-screen grid-bg">
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        {/* Page header: title + primary action, same pattern as the other library pages */}
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{t("pageTitle")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("pageSubtitle")}</p>
          </div>
          <Link href="/project/new">
            <Button size="sm" className="brand-gradient text-white">
              <LuPlus className="h-4 w-4" />
              <span className="ml-1.5">{t("newProject")}</span>
            </Button>
          </Link>
        </div>

        {/* projects / works / shots view switch */}
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <div className="flex rounded-lg border border-border/50 p-0.5">
            {(["projects", "works", "shots"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                aria-pressed={view === v}
                className={`rounded-md px-4 py-1.5 text-xs font-medium transition-colors ${
                  view === v ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t(v === "projects" ? "tabProjects" : v === "works" ? "tabWorks" : "tabShots")}
                {v === "works" && works.length > 0 && <span className="ml-1 opacity-70">({works.length})</span>}
                {v === "shots" && shotCount !== null && <span className="ml-1 opacity-70">({shotCount})</span>}
              </button>
            ))}
          </div>
          {view === "projects" && rows.length > 0 && (
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("searchPlaceholder")}
              className="max-w-sm text-sm"
            />
          )}
        </div>

        {view === "shots" ? null : loading ? (
          <div className="flex items-center gap-2 py-16 justify-center text-sm text-muted-foreground">
            <LuLoader className="h-4 w-4 animate-spin" />
            {tc("loading")}
          </div>
        ) : loadError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {loadError}
          </div>
        ) : view === "works" ? (
          works.length === 0 ? (
            <Card className="glass-card">
              <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
                <LuImage className="h-8 w-8 text-muted-foreground/60" />
                <div>
                  <p className="font-medium">{t("worksEmpty")}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{t("worksEmptyDesc")}</p>
                </div>
                <Link href="/start"><Button size="sm" className="mt-2">{t("goStart")}</Button></Link>
              </CardContent>
            </Card>
          ) : (
            <>
              <p className="mb-3 text-xs text-muted-foreground">{t("worksCount", { n: works.length })}</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {works.map((w) => {
                  const rel = formatRelativeTime(w.createdAt, locale);
                  return (
                    <Card key={w.id} className="glass-card card-hover group overflow-hidden">
                      <CardContent className="p-0">
                        <Link href={`/project/${w.projectId}/export`} className="block">
                          <div className="relative aspect-[3/4] bg-muted/30">
                            {w.thumbnailUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element -- local file server, next/image adds nothing
                              <img src={w.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
                            ) : (
                              <div className="absolute inset-0 flex items-center justify-center">
                                <LuPlay className="h-7 w-7 text-muted-foreground/50" />
                              </div>
                            )}
                            {w.label && (
                              <span className="absolute left-1.5 top-1.5 max-w-[85%] truncate rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
                                {w.label}
                              </span>
                            )}
                          </div>
                        </Link>
                        <div className="flex items-center justify-between gap-1 p-2.5">
                          <div className="min-w-0">
                            <p className="truncate text-xs font-medium">{w.productName || w.projectName || t("untitled")}</p>
                            <p className="truncate text-[11px] text-muted-foreground">{rel}</p>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <a
                              href={`${w.url}?download=1`}
                              title={t("download")}
                              className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                            >
                              <LuDownload className="h-3.5 w-3.5" />
                            </a>
                            <button
                              type="button"
                              onClick={() => handleDeleteWork(w)}
                              title={t("deleteWork")}
                              aria-label={t("deleteWork")}
                              disabled={deletingWorkIds.has(w.id)}
                              className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-red-500/15 hover:text-red-400 disabled:cursor-wait disabled:opacity-50"
                            >
                              {deletingWorkIds.has(w.id) ? <LuLoader className="h-3.5 w-3.5 animate-spin" /> : <LuTrash2 className="h-3.5 w-3.5" />}
                            </button>
                          </div>
                        </div>
                        {workDeleteErrors[w.id] && <p role="alert" className="mx-2.5 mb-2.5 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">{workDeleteErrors[w.id]}</p>}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </>
          )
        ) : rows.length === 0 ? (
          <Card className="glass-card">
            <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
              <LuFolderOpen className="h-8 w-8 text-muted-foreground/60" />
              <div>
                <p className="font-medium">{t("empty")}</p>
                <p className="mt-1 text-sm text-muted-foreground">{t("emptyDesc")}</p>
              </div>
              <div className="mt-2 flex gap-2">
                <Link href="/start"><Button size="sm">{t("goStart")}</Button></Link>
                <Link href="/project/new"><Button size="sm" variant="outline">{t("goNew")}</Button></Link>
              </div>
            </CardContent>
          </Card>
        ) : filtered.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{t("noMatch")}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((p) => {
              const rel = formatRelativeTime(p.updatedAt, locale);
              const poster = posterByProject.get(p.id) ?? (p.productImages?.[0] || null);
              return (
                <Card key={p.id} className="glass-card card-hover group h-full overflow-hidden">
                  <CardContent className="p-0">
                    <Link href={`/project/${p.id}/${stepFor(p.status)}`} className="block">
                      {/* poster: latest render's first frame, falling back to the product photo */}
                      <div className="relative aspect-video bg-muted/30">
                        {poster ? (
                          // eslint-disable-next-line @next/next/no-img-element -- local file server, next/image adds nothing
                          <img src={poster} alt="" loading="lazy" className="h-full w-full object-cover" />
                        ) : (
                          <div className="absolute inset-0 flex items-center justify-center">
                            <LuImage className="h-7 w-7 text-muted-foreground/40" />
                          </div>
                        )}
                        <Badge
                          variant={p.status === "done" ? "default" : "secondary"}
                          className="absolute left-2 top-2 text-[11px]"
                        >
                          {tc(statusKeyFor(p.status))}
                        </Badge>
                      </div>
                      <div className="p-4 pb-3">
                        <p className="min-w-0 truncate text-sm font-medium">
                          {p.name || p.productName || t("untitled")}
                        </p>
                        <p className="mt-1.5 truncate text-xs text-muted-foreground">
                          {p.productName || ""}
                          {p.productName && rel ? " · " : ""}
                          {rel || ""}
                        </p>
                      </div>
                    </Link>
                    <div className="flex justify-end px-2 pb-2">
                      <button
                        type="button"
                        onClick={() => handleDelete(p)}
                        title={t("deleteProject")}
                        aria-label={t("deleteProject")}
                        disabled={deletingIds.has(p.id)}
                        className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground/70 opacity-100 transition-colors hover:bg-red-500/15 hover:text-red-400 disabled:cursor-wait disabled:opacity-50 md:opacity-0 md:group-hover:opacity-100"
                      >
                        {deletingIds.has(p.id) ? <LuLoader className="h-3.5 w-3.5 animate-spin" /> : <LuTrash2 className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                    {deleteIssues[p.id] && (
                      <div role="alert" className="mx-3 mb-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs">
                        <p className="text-destructive">{deleteIssues[p.id].message}</p>
                        {deleteIssues[p.id].blockingTasks.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                            {deleteIssues[p.id].blockingTasks.map((task, index) => (
                              <Link key={`${task.kind}:${task.id}`} href={task.href} className="text-primary underline underline-offset-2">
                                {t(task.kind === "kling_film" ? "deleteReviewFilm" : "deleteReviewJob")}
                                {deleteIssues[p.id].blockingTasks.length > 1 ? ` ${index + 1}` : ""}
                              </Link>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
        <ShotLibrary active={view === "shots"} onCountChange={setShotCount} excludedProjectIds={removedProjectIds} />
      </main>
    </div>
  );
}
