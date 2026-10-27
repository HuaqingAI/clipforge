"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CreationTypeGate } from "@/components/creation-type-gate";
import { useT, useLocale } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/relative-time";

interface RecentProject {
  id: string;
  name: string;
  productName: string | null;
  status: string;
  updatedAt: string | null;
}

/** Choose a creation type, then continue in the shared new-project form. */
export default function StartPage() {
  const router = useRouter();
  const t = useT("start");
  const locale = useLocale();
  const [recent, setRecent] = useState<RecentProject[]>([]);

  // fetch recent projects to give returning users a "continue" entry point (replaces the old homepage project list so they are not left stranded)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/project");
        const data = res.ok ? await res.json() : [];
        const list: RecentProject[] = Array.isArray(data) ? data : [];
        // sort by updatedAt desc so "recent" truly reflects last-edited order (null/invalid timestamps sink to the end)
        const ts = (p: RecentProject) => {
          if (!p.updatedAt) return 0;
          const time = new Date(p.updatedAt).getTime();
          return Number.isFinite(time) ? time : 0;
        };
        if (!cancelled) setRecent([...list].sort((a, b) => ts(b) - ts(a)).slice(0, 4));
      } catch {
        /* ignore */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const stepFor = (status: string) =>
    status === "done" || status === "composing" || status === "video" ? "video" : status === "assets" ? "assets" : "script";

  const stageKeyFor = (status: string) =>
    status === "done" ? "pjStageDone" : status === "video" || status === "composing" ? "pjStageVideo" : status === "assets" ? "pjStageAssets" : "pjStageScript";

  const startSalesProject = () => {
    const params = new URLSearchParams(window.location.search);
    params.set("creationType", "short_video_sales");
    router.push(`/project/new?${params.toString()}`);
  };

  return (
    <div className="cf-root">
      <style>{`
        .cf-root{--teal:#a78bfa;--ink:#ffffff;--text:#EDEFF4;--dim:#98A2B3;--muted:#5A6473;--surface:rgba(255,255,255,.035);--surface2:rgba(255,255,255,.06);--bd:rgba(255,255,255,.08);--bd2:rgba(255,255,255,.14);
          min-height:100vh;background:#0B0D12;color:var(--text);position:relative;overflow-x:hidden;
          font-family:ui-sans-serif,"PingFang SC","Microsoft YaHei",system-ui,-apple-system,"Segoe UI",sans-serif;}
        .cf-amb{position:absolute;inset:0;pointer-events:none;background:radial-gradient(900px 420px at 50% -8%,rgba(139,92,246,.10),transparent 70%),radial-gradient(700px 500px at 85% 0%,rgba(124,92,255,.07),transparent 65%);}
        .cf-grid{position:absolute;inset:0;pointer-events:none;opacity:.5;background-image:linear-gradient(var(--bd) 1px,transparent 1px),linear-gradient(90deg,var(--bd) 1px,transparent 1px);background-size:64px 64px;-webkit-mask-image:radial-gradient(circle at 50% 22%,#000,transparent 72%);mask-image:radial-gradient(circle at 50% 22%,#000,transparent 72%);}
        .cf-wrap{position:relative;max-width:980px;margin:0 auto;padding:0 24px}
        .cf-hero{padding:52px 0 56px;text-align:center}
        .cf-h1{font-weight:700;font-size:clamp(34px,5.6vw,60px);line-height:1.04;letter-spacing:-.02em;margin-bottom:34px}
        .cf-h1 .hl{color:var(--teal);text-shadow:0 0 34px rgba(139,92,246,.35)}
        .cf-card{max-width:620px;margin:0 auto;background:var(--surface);border:1px solid var(--bd);border-radius:20px;padding:14px;backdrop-filter:blur(14px);box-shadow:0 30px 80px -40px rgba(0,0,0,.8);text-align:left}
        .cf-recent{max-width:620px;margin:22px auto 0;text-align:left}
        .cf-recent .lbl{font-size:12px;color:var(--muted);margin-bottom:8px;letter-spacing:.02em;display:flex;align-items:center;justify-content:space-between}
        .cf-recent .lbl-all{color:var(--muted);text-decoration:none;transition:.18s}
        .cf-recent .lbl-all:hover{color:var(--dim)}
        .cf-recent .row{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
        .cf-pj{display:flex;align-items:center;gap:10px;padding:11px 13px;border:1px solid var(--bd);border-radius:12px;background:var(--surface);text-decoration:none;transition:.18s}
        .cf-pj:hover{border-color:var(--bd2);background:var(--surface2)}
        .cf-pj .dot{width:7px;height:7px;border-radius:999px;background:var(--teal);flex:none;box-shadow:0 0 8px var(--teal)}
        .cf-pj .col{min-width:0;display:flex;flex-direction:column;gap:2px}
        .cf-pj .nm{font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .cf-pj-meta{font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      `}</style>

      <div className="cf-amb" />
      <div className="cf-grid" />
      <div className="cf-wrap">
        <section className="cf-hero">
          <h1 className="cf-h1">{t("h1Lead")}<span className="hl">{t("h1Highlight")}</span></h1>

          <div className="cf-card">
            <CreationTypeGate onSelectShortVideoSales={startSalesProject} />
          </div>

          {recent.length > 0 && (
            <div className="cf-recent">
              <div className="lbl">
                {t("recentLabel")}
                <Link href="/projects" className="lbl-all">{t("recentAll")} →</Link>
              </div>
              <div className="row">
                {recent.map((p) => {
                  const rel = formatRelativeTime(p.updatedAt, locale);
                  return (
                    <Link key={p.id} href={`/project/${p.id}/${stepFor(p.status)}`} className="cf-pj">
                      <span className="dot" />
                      <span className="col">
                        <span className="nm">{p.name || p.productName || t("untitledProject")}</span>
                        <span className="cf-pj-meta">{t(stageKeyFor(p.status))}{rel ? ` · ${rel}` : ""}</span>
                      </span>
                    </Link>
                  );
                })}
              </div>
            </div>
          )}

        </section>
      </div>
    </div>
  );
}
