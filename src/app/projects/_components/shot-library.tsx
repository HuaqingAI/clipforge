"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { LuChevronDown, LuDownload, LuFilm, LuFolderOpen, LuLoader, LuPlay, LuRefreshCw, LuTrash2 } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLocale, useT } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/relative-time";
import type { LocalShotVideo } from "@/lib/shot-library-types";

const NO_PROJECTS: string[] = [];
const UNASSIGNED = "__unassigned__";
class ShotResponseError extends Error {}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function errorMessage(response: Response, fallback: string) {
  const body: unknown = await response.json().catch(() => null);
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string" && body.error.trim()) return body.error;
  return fallback;
}

export function ShotLibrary({ active, onCountChange, excludedProjectIds = NO_PROJECTS }: {
  active: boolean;
  onCountChange: (count: number) => void;
  excludedProjectIds?: string[];
}) {
  const t = useT("projectsPage");
  const tc = useT("common");
  const locale = useLocale();
  const [rows, setRows] = useState<LocalShotVideo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [scriptFilter, setScriptFilter] = useState("");
  const [checkedIds, setCheckedIds] = useState(new Set<string>());
  const [deletingIds, setDeletingIds] = useState(new Set<string>());
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<LocalShotVideo | null>(null);
  const deleting = useRef(false);
  const removedIds = useRef(new Set<string>());

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const response = await fetch("/api/shots", { signal: controller.signal, headers: { "Accept-Language": locale } });
        if (!response.ok) throw new ShotResponseError(await errorMessage(response, t("shotsLoadError")));
        const data = await response.json();
        if (!Array.isArray(data?.shots)) throw new Error(t("shotsLoadError"));
        if (!controller.signal.aborted) setRows((data.shots as LocalShotVideo[]).filter((row) => !removedIds.current.has(row.id)));
      } catch (error) {
        if (!controller.signal.aborted) setLoadError(error instanceof ShotResponseError ? error.message : t("shotsLoadError"));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [active, refresh, locale, t]);

  const shots = useMemo(() => (rows ?? []).filter((row) => !excludedProjectIds.includes(row.projectId)), [rows, excludedProjectIds]);
  useEffect(() => { if (rows !== null) onCountChange(shots.length); }, [rows, shots.length, onCountChange]);

  const scriptName = (row: LocalShotVideo) => row.scriptTitle || (row.scriptId ? t("shotsUntitledScript") : t("shotsUnassignedScript"));
  const shotName = (row: LocalShotVideo) => `${t("shotsShotNumber", { n: row.shotId })} · ${row.fileName}`;
  const projects = [...new Map(shots.map((row) => [row.projectId, row.projectName || row.productName || t("untitled")])).entries()];
  const currentProjectFilter = projects.some(([id]) => id === projectFilter) ? projectFilter : "";
  const scriptOptions = [...new Map(shots.filter((row) => !currentProjectFilter || row.projectId === currentProjectFilter)
    .map((row) => [row.scriptId || UNASSIGNED, row])).entries()];
  const currentScriptFilter = scriptOptions.some(([id]) => id === scriptFilter) ? scriptFilter : "";
  const filtered = shots.filter((row) => {
    if (currentProjectFilter && row.projectId !== currentProjectFilter) return false;
    if (currentScriptFilter && (row.scriptId || UNASSIGNED) !== currentScriptFilter) return false;
    const search = query.trim().toLocaleLowerCase();
    return !search || [row.projectName, row.productName, scriptName(row), row.shotDescription, row.fileName, row.model, row.provider, t("shotsShotNumber", { n: row.shotId })]
      .some((value) => value?.toLocaleLowerCase().includes(search));
  });
  const groups = new Map<string, { project: LocalShotVideo; scripts: Map<string, { script: LocalShotVideo; shots: Map<number, LocalShotVideo[]> }> }>();
  for (const row of filtered) {
    if (!groups.has(row.projectId)) groups.set(row.projectId, { project: row, scripts: new Map() });
    const project = groups.get(row.projectId)!;
    const scriptId = row.scriptId || UNASSIGNED;
    if (!project.scripts.has(scriptId)) project.scripts.set(scriptId, { script: row, shots: new Map() });
    const script = project.scripts.get(scriptId)!;
    script.shots.set(row.shotId, [...(script.shots.get(row.shotId) ?? []), row]);
  }
  const selected = shots.filter((row) => checkedIds.has(row.id));
  const allChecked = filtered.length > 0 && filtered.every((row) => checkedIds.has(row.id));
  const busy = deletingIds.size > 0;

  function toggleChecked(id: string) {
    setCheckedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function deleteShots(targets: LocalShotVideo[]) {
    if (deleting.current || targets.length === 0) return;
    const confirm = targets.length === 1
      ? t("shotsDeleteConfirm", { name: `${targets[0].projectName || t("untitled")} / ${scriptName(targets[0])} / ${shotName(targets[0])}` })
      : t("shotsDeleteBatchConfirm", { n: targets.length });
    if (!window.confirm(confirm)) return;
    deleting.current = true;
    setDeletingIds(new Set(targets.map((row) => row.id)));
    setNotice(null);
    if (preview && targets.some((row) => row.id === preview.id)) setPreview(null);
    let deletedCount = 0;
    let freedBytes = 0;
    try {
      for (const row of targets) {
        setDeleteErrors((previous) => { const next = { ...previous }; delete next[row.id]; return next; });
        try {
          const response = await fetch(`/api/shots/${encodeURIComponent(row.id)}`, { method: "DELETE", headers: { "Accept-Language": locale } });
          if (!response.ok) throw new ShotResponseError(await errorMessage(response, t("shotsDeleteFailed")));
          const result = await response.json().catch(() => ({}));
          removedIds.current.add(row.id);
          setRows((previous) => previous?.filter((item) => item.id !== row.id) ?? null);
          setCheckedIds((previous) => { const next = new Set(previous); next.delete(row.id); return next; });
          deletedCount++;
          if (typeof result.freedBytes === "number") freedBytes += result.freedBytes;
        } catch (error) {
          setDeleteErrors((previous) => ({ ...previous, [row.id]: error instanceof ShotResponseError ? error.message : t("shotsDeleteFailed") }));
        }
      }
    } finally {
      deleting.current = false;
      setDeletingIds(new Set());
      if (deletedCount > 0) setNotice(t("shotsDeleted", { n: deletedCount, size: formatSize(freedBytes) }));
    }
  }

  if (!active) return null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{t("shotsHeading")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("shotsDescription")}</p>
        </div>
        <Button size="sm" variant="outline" disabled={loading || busy} onClick={() => setRefresh((value) => value + 1)}>
          <LuRefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />{t("shotsRefresh")}
        </Button>
      </div>

      {loadError && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{loadError}</div>}
      {notice && <p role="status" className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-primary">{notice}</p>}

      {rows !== null && shots.length > 0 && <>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input value={query} onChange={(event) => { setQuery(event.target.value); setCheckedIds(new Set()); }} placeholder={t("shotsSearchPlaceholder")} aria-label={t("shotsSearchPlaceholder")} className="flex-1 text-sm" />
          <select aria-label={t("shotsAllProjects")} value={currentProjectFilter} onChange={(event) => { setProjectFilter(event.target.value); setScriptFilter(""); setCheckedIds(new Set()); }} className="h-9 min-w-0 rounded-lg border border-input bg-background px-3 text-xs sm:max-w-52">
            <option value="">{t("shotsAllProjects")}</option>
            {projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <select aria-label={t("shotsAllScripts")} value={currentScriptFilter} onChange={(event) => { setScriptFilter(event.target.value); setCheckedIds(new Set()); }} className="h-9 min-w-0 rounded-lg border border-input bg-background px-3 text-xs sm:max-w-60">
            <option value="">{t("shotsAllScripts")}</option>
            {scriptOptions.map(([id, row]) => <option key={id} value={id}>{scriptName(row)}{row.scriptVersion ? ` · V${row.scriptVersion}` : ""}{!currentProjectFilter ? ` · ${row.projectName || t("untitled")}` : ""}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
          <p className="text-muted-foreground">{t("shotsCount", { n: filtered.length, size: formatSize(filtered.reduce((sum, row) => sum + row.sizeBytes, 0)) })}</p>
          <div className="flex items-center gap-3">
            <label className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" checked={allChecked} disabled={busy || filtered.length === 0} onChange={() => setCheckedIds(allChecked ? new Set() : new Set(filtered.map((row) => row.id)))} className="h-3.5 w-3.5 accent-primary" />
              {t("shotsSelectAll")}
            </label>
            <Button size="sm" variant="outline" disabled={selected.length === 0 || busy || loading} onClick={() => deleteShots(selected)} className="text-destructive hover:text-destructive">
              {busy ? <LuLoader className="h-3.5 w-3.5 animate-spin" /> : <LuTrash2 className="h-3.5 w-3.5" />}
              {t("shotsDeleteSelected", { n: selected.length })}
            </Button>
          </div>
        </div>
      </>}

      {loading && rows === null ? <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"><LuLoader className="h-4 w-4 animate-spin" />{tc("loading")}</div>
        : rows !== null && shots.length === 0 ? <Card className="glass-card"><CardContent className="flex flex-col items-center gap-3 py-14 text-center"><LuFilm className="h-8 w-8 text-muted-foreground/60" /><div><p className="font-medium">{t("shotsEmpty")}</p><p className="mt-1 text-sm text-muted-foreground">{t("shotsEmptyDesc")}</p></div></CardContent></Card>
        : rows !== null && filtered.length === 0 ? <p className="py-10 text-center text-sm text-muted-foreground">{t("shotsNoMatch")}</p>
        : [...groups.entries()].map(([projectId, { project, scripts }]) => <section key={projectId} data-project-id={projectId} className="space-y-3">
          <div className="flex items-center justify-between gap-3 border-b border-border/50 pb-2">
            <h2 className="flex min-w-0 items-center gap-2 text-base font-semibold"><LuFolderOpen className="h-4 w-4 shrink-0 text-primary" /><span className="truncate">{project.projectName || project.productName || t("untitled")}</span></h2>
            <Link href={`/project/${encodeURIComponent(projectId)}/assets`} className="shrink-0 text-xs text-muted-foreground hover:text-primary">{t("shotsOpenProject")} →</Link>
          </div>
          {[...scripts.entries()].map(([scriptId, { script, shots: byShot }]) => <details key={scriptId} open data-script-id={script.scriptId || "unassigned"} className="group/script rounded-xl border border-border/50 bg-card/30">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
              <LuChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-not-open/script:-rotate-90" />
              <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{scriptName(script)}</h3>
              {script.scriptVersion != null && <Badge variant="secondary" className="text-[10px]">V{script.scriptVersion}</Badge>}
              <span className="shrink-0 text-[11px] text-muted-foreground">{t("shotsGroupCount", { n: [...byShot.values()].reduce((sum, takes) => sum + takes.length, 0) })}</span>
            </summary>
            <div className="grid grid-cols-1 gap-5 border-t border-border/40 p-3 sm:grid-cols-2 sm:p-4 lg:grid-cols-3">
              {!script.scriptId && <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-3">{t("shotsUnassignedDesc")}</p>}
              {[...byShot.entries()].sort(([a], [b]) => a - b).map(([shotId, takes]) => <div key={shotId} className="min-w-0">
                <div className="mb-2 flex items-baseline gap-2"><h4 className="shrink-0 text-xs font-semibold text-primary">{t("shotsShotNumber", { n: shotId })}</h4><p className="truncate text-xs text-muted-foreground" title={takes[0].shotDescription || ""}>{takes[0].shotDescription}</p></div>
                <div className="space-y-3">
                  {[...takes].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).map((row, index) => <Card key={row.id} data-shot-id={row.id} className={`glass-card overflow-hidden transition-colors ${checkedIds.has(row.id) ? "ring-1 ring-primary" : ""}`}>
                    <CardContent className="p-0">
                      <div className="group/preview relative aspect-video bg-black/40">
                        <button type="button" aria-label={t("shotsPreview", { name: shotName(row) })} onClick={() => setPreview(row)} className="absolute inset-0 h-full w-full">
                          {row.thumbnailUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element -- local media thumbnail
                            <img src={row.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-contain" />
                          ) : <video src={`${row.url}#t=0.1`} muted playsInline preload="metadata" className="h-full w-full object-contain" />}
                          <span className="absolute inset-0 flex items-center justify-center bg-black/5 transition-colors group-hover/preview:bg-black/20"><span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white"><LuPlay className="h-4 w-4" /></span></span>
                        </button>
                        <input type="checkbox" aria-label={t("shotsSelect", { name: shotName(row) })} checked={checkedIds.has(row.id)} disabled={busy} onChange={() => toggleChecked(row.id)} className="absolute left-2 top-2 h-4 w-4 cursor-pointer accent-primary" />
                        {row.selected && <span className="pointer-events-none absolute right-2 top-2 rounded bg-primary/90 px-1.5 py-0.5 text-[10px] text-white">{t("shotsSelectedTake")}</span>}
                        {row.duration != null && <span className="pointer-events-none absolute bottom-2 right-2 rounded bg-black/65 px-1.5 py-0.5 text-[10px] text-white">{(row.duration / 1000).toFixed(1)}s</span>}
                      </div>
                      <div className="space-y-1.5 p-2.5">
                        <div className="flex items-center justify-between gap-2"><p className="text-xs font-medium">{t("shotsTakeNumber", { n: index + 1 })}</p><span className="text-[11px] text-muted-foreground">{formatSize(row.sizeBytes)}</span></div>
                        <p title={row.fileName} className="truncate text-[11px] text-muted-foreground">{row.fileName}</p>
                        <div className="flex items-center justify-between gap-2">
                          <p className="min-w-0 truncate text-[10px] text-muted-foreground" title={[row.provider, row.model].filter(Boolean).join(" · ")}>{[row.model || row.provider, formatRelativeTime(row.createdAt, locale)].filter(Boolean).join(" · ")}</p>
                          <div className="flex shrink-0 items-center gap-1">
                            <a href={`${row.url}${row.url.includes("?") ? "&" : "?"}download=1`} aria-label={t("download")} title={t("download")} className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/50 hover:text-foreground"><LuDownload className="h-3.5 w-3.5" /></a>
                            <button type="button" title={t("shotsDelete")} aria-label={t("shotsDelete")} disabled={busy || loading} onClick={() => deleteShots([row])} className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/15 hover:text-destructive disabled:opacity-50">{deletingIds.has(row.id) ? <LuLoader className="h-3.5 w-3.5 animate-spin" /> : <LuTrash2 className="h-3.5 w-3.5" />}</button>
                          </div>
                        </div>
                        {deleteErrors[row.id] && <p role="alert" className="rounded border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">{deleteErrors[row.id]}</p>}
                      </div>
                    </CardContent>
                  </Card>)}
                </div>
              </div>)}
            </div>
          </details>)}
        </section>)}

      <Dialog open={!!preview} onOpenChange={(open) => { if (!open) setPreview(null); }}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader><DialogTitle>{preview ? t("shotsShotNumber", { n: preview.shotId }) : t("tabShots")}</DialogTitle><DialogDescription>{preview ? `${preview.projectName || t("untitled")} · ${scriptName(preview)} · ${preview.fileName}` : ""}</DialogDescription></DialogHeader>
          {preview && <video key={preview.id} src={preview.url} poster={preview.thumbnailUrl || undefined} controls autoPlay playsInline className="max-h-[70vh] w-full rounded-md bg-black" />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
