"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { LuCheck, LuCircleCheck, LuFilm, LuDownload, LuLink2, LuPlus, LuHouse, LuLoaderCircle } from "react-icons/lu";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useT, useLocale } from "@/lib/i18n";
import { ProjectHeader } from "@/components/project-header";

// script style → i18n key (resolved to translated text at render time)
const styleLabelKeys: Record<string, string> = {
  pain_point: "stylePainPoint",
  scene: "styleScene",
  comparison: "styleComparison",
  story: "styleStory",
  drama: "styleDrama",
  reversal: "styleReversal",
  interview: "styleInterview",
  unboxing: "styleUnboxing",
  product_pov: "styleProductPov",
  talking_head: "styleTalkingHead",
  auto: "styleAuto",
};

interface Composition {
  url: string | null;
  fileName: string;
  resolution: string | null;
  aspectRatio: string | null;
  status: string;
  createdAt: string | null;
}

interface ScriptInfo {
  styleType: string;
  totalDuration: number;
  shotCount: number;
}

export default function ExportPage() {
  const t = useT("exportPage");
  const locale = useLocale();
  const { id } = useParams<{ id: string }>();
  const [toast, setToast] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [projectName, setProjectName] = useState("");
  const [composition, setComposition] = useState<Composition | null>(null);
  // full output history (variant-matrix renders carry a label) — the latest-only view hid variants
  const [history, setHistory] = useState<Array<{ id: string; url: string | null; label?: string | null; createdAt?: string | number | null }>>([]);
  const [scriptInfo, setScriptInfo] = useState<ScriptInfo | null>(null);
  const [fileSize, setFileSize] = useState<string>("");
  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        // list *successful* compositions (a failed retry on top must not blank this page)
        const [compRes, projRes, scriptsRes] = await Promise.all([
          fetch(`/api/project/${id}/compositions`),
          fetch(`/api/project/${id}`),
          fetch(`/api/project/${id}/scripts`),
        ]);
        if (projRes.ok) {
          const proj = await projRes.json();
          if (!cancelled) {
            setProjectName(proj.name ?? proj.productName ?? "");
          }
        }
        if (compRes.ok) {
          const data = await compRes.json();
          const latestDone = Array.isArray(data.compositions) ? data.compositions[0] : null;
          if (!cancelled && latestDone) setComposition(latestDone);
          if (!cancelled && Array.isArray(data.compositions)) setHistory(data.compositions);
        }
        if (scriptsRes.ok) {
          const arr = await scriptsRes.json();
          const sel = Array.isArray(arr) ? arr.find((s: { selected?: boolean }) => s.selected) : null;
          if (!cancelled && sel) {
            setScriptInfo({
              styleType: sel.styleType,
              totalDuration: sel.totalDuration ?? 0,
              shotCount: Array.isArray(sel.shots) ? sel.shots.length : 0,
            });
          } else if (!cancelled) {
            setScriptInfo(null);
          }
        }
      } catch {
        // ignore, fall through to empty state
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // once the real composed video is available, HEAD-probe for the file size
  useEffect(() => {
    if (!composition?.url) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(composition.url!, { method: "HEAD" });
        const len = res.headers.get("content-length");
        if (len && !cancelled) {
          const mb = Number(len) / 1024 / 1024;
          setFileSize(mb >= 1 ? `${mb.toFixed(1)} MB` : `${(Number(len) / 1024).toFixed(0)} KB`);
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [composition?.url]);

  const handleCopyLink = async () => {
    if (!composition?.url) return;
    const full = `${window.location.origin}${composition.url}`;
    try {
      await navigator.clipboard.writeText(full);
      showToast(t("linkCopied"));
    } catch {
      showToast(t("copyLinkFailed"));
    }
  };

  const dateStr = composition?.createdAt
    ? new Date(composition.createdAt).toLocaleDateString("zh-CN")
    : "";

  // slim context strip (shared by loading, empty and normal states); global chrome lives in AppShell
  const headerBar = <ProjectHeader projectName={projectName || t("projectFallback")} />;

  if (loading) {
    return (
      <div className="min-h-screen grid-bg">
        {headerBar}
        <div className="flex flex-col items-center justify-center py-32 text-muted-foreground">
          <LuLoaderCircle className="w-8 h-8 animate-spin mb-3" />
          <p className="text-sm">{t("loadingComposition")}</p>
        </div>
      </div>
    );
  }

  // empty state: no composed video yet
  if (!composition || !composition.url) {
    return (
      <div className="min-h-screen grid-bg">
        {headerBar}
        <div className="mx-auto max-w-md flex flex-col items-center justify-center py-28 px-6 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/40 mb-5">
            <LuFilm className="w-8 h-8 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-semibold mb-2">{t("emptyTitle")}</h2>
          <p className="text-sm text-muted-foreground mb-6">
            {t("emptyDesc", { name: projectName || t("emptyProjectFallback") })}
          </p>
          <div className="flex items-center gap-3">
            <Link href={`/project/${id}/video`}>
              <Button className="brand-gradient text-white">{t("goCompose")}</Button>
            </Link>
            <Link href="/projects">
              <Button variant="outline">{t("backToProjects")}</Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen grid-bg">
      {/* toast notification */}
      {toast && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[100] animate-in fade-in slide-in-from-top-2">
          <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-600 text-white text-sm shadow-xl">
            <LuCheck className="w-4 h-4" />
            {toast}
          </div>
        </div>
      )}

      {headerBar}

      <main className="mx-auto max-w-3xl px-6 py-10">
        {/* completion banner */}
        <div className="text-center mb-8">
          <div className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10 mb-4">
            <LuCircleCheck className="w-8 h-8 text-emerald-500" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight mb-1">
            {t("doneTitleRest")}<span className="brand-gradient-text">{t("doneTitleAccent")}</span>
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("doneSubtitle")}
          </p>
        </div>

        {/* video preview (real composed output) */}
        <Card className="glass-card neon-glow mb-6 overflow-hidden">
          <CardContent className="p-0">
            <div className="mx-auto max-w-xs">
              <div className="relative aspect-[9/16] bg-black flex items-center justify-center">
                <video
                  src={composition.url}
                  controls
                  playsInline
                  className="w-full h-full object-contain"
                />
              </div>
            </div>

            {/* video info bar */}
            <div className="px-5 py-3 border-t border-border/30 flex items-center justify-between">
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>{composition.resolution ?? "1080p"}</span>
                <span className="w-1 h-1 rounded-full bg-muted-foreground/30" />
                <span>{composition.aspectRatio ?? "9:16"}</span>
                {fileSize && (
                  <>
                    <span className="w-1 h-1 rounded-full bg-muted-foreground/30" />
                    <span>{fileSize}</span>
                  </>
                )}
                <span className="w-1 h-1 rounded-full bg-muted-foreground/30" />
                <span>MP4</span>
              </div>
              {dateStr && <span className="text-xs text-muted-foreground">{dateStr}</span>}
            </div>
          </CardContent>
        </Card>

        {/* action buttons */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-3 mb-8">
          <a href={`${composition.url}?download=1`} download={composition.fileName}>
            <Button className="brand-gradient text-white h-12 px-8 text-base font-semibold w-full">
              <LuDownload className="w-[18px] h-[18px] mr-2" />
              {t("downloadVideo")}
            </Button>
          </a>
          <Button
            variant="outline"
            onClick={handleCopyLink}
            className="h-11 px-6 text-sm"
          >
            <LuLink2 className="w-4 h-4 mr-2" />
            {t("copyShareLink")}
          </Button>
        </div>

        {/* output history: every successful render, newest first — variant-matrix outputs
            show their combo label so A/B takes stay reachable after leaving the video page */}
        {history.length > 1 && (
          <Card className="glass-card mb-6">
            <CardContent className="p-5">
              <h3 className="text-sm font-semibold mb-3">🎞 {t("historyTitle", { n: history.length })}</h3>
              <div className="space-y-1.5">
                {history.map((h, i) => (
                  <div key={h.id} className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground/60 shrink-0 tabular-nums">{String(i + 1).padStart(2, "0")}</span>
                    <span className="truncate flex-1 text-muted-foreground">
                      {h.label || t("historyUnlabeled")}
                    </span>
                    {h.createdAt && (
                      <span className="text-muted-foreground/60 shrink-0">
                        {new Date(h.createdAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    )}
                    {h.url && (
                      <a href={h.url} target="_blank" rel="noreferrer" className="text-primary underline shrink-0">
                        {t("historyView")}
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* video details (real script data) */}
        <Card className="glass-card">
          <CardContent className="p-5">
            <h3 className="text-sm font-semibold mb-4">{t("detailTitle")}</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-3">
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">{t("detailStyle")}</p>
                  <p className="text-sm">{scriptInfo ? (styleLabelKeys[scriptInfo.styleType] ? t(styleLabelKeys[scriptInfo.styleType]) : scriptInfo.styleType) : t("emptyValue")}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">{t("detailShots")}</p>
                  <p className="text-sm">{scriptInfo ? t("shotCount", { n: scriptInfo.shotCount }) : t("emptyValue")}</p>
                </div>
              </div>
              <div className="space-y-3">
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">{t("detailDuration")}</p>
                  <p className="text-sm">{scriptInfo?.totalDuration ? t("durationSeconds", { n: scriptInfo.totalDuration }) : t("emptyValue")}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">{t("detailResolution")}</p>
                  <p className="text-sm">{composition.resolution ?? "1080p"} · {composition.aspectRatio ?? "9:16"}</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* bottom navigation */}
        <div className="mt-8 flex items-center justify-center gap-4">
          <Link href="/project/new">
            <Button className="brand-gradient text-white">
              <LuPlus className="w-4 h-4 mr-1.5" />
              {t("makeAnother")}
            </Button>
          </Link>
          <Link href="/projects">
            <Button variant="outline">
              <LuHouse className="w-4 h-4 mr-1.5" />
              {t("backToProjects")}
            </Button>
          </Link>
        </div>
      </main>
    </div>
  );
}
