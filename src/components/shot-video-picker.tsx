"use client";

import { useState } from "react";
import { LuCheck, LuChevronDown, LuLoaderCircle } from "react-icons/lu";

export interface ShotVideoAsset {
  id: string;
  shotId: number;
  filePath: string | null;
  thumbnailPath?: string | null;
  status: string;
  selected?: boolean;
  model?: string | null;
  provider?: string | null;
  createdAt?: Date | string | number | null;
}

const isVideo = (path: string) => /\.(mp4|webm|mov|m4v)(\?|$)/i.test(path);
const assetTime = (asset: ShotVideoAsset) => new Date(asset.createdAt ?? 0).getTime() || 0;

/** Display and composition must agree on the persisted, explicitly selected take. */
export function selectedShotAsset(assets: ShotVideoAsset[], shotId: number): ShotVideoAsset | undefined {
  return assets.filter((asset) => asset.shotId === shotId && asset.selected === true && asset.status === "done" && asset.filePath)
    .sort((a, b) => assetTime(b) - assetTime(a) || a.id.localeCompare(b.id))[0];
}

/** Pin only asset IDs; media paths remain under the server's control. */
export function buildShotAssetSelections(shots: Array<{ shotId: number }>, assets: ShotVideoAsset[]) {
  return shots.map(({ shotId }) => {
    const asset = selectedShotAsset(assets, shotId);
    return { shotId, assetId: asset?.id ?? null };
  });
}

export function ShotVideoPicker({ shotId, assets, disabled, savingAssetId, error, locale, onSelect }: {
  shotId: number;
  assets: ShotVideoAsset[];
  disabled: boolean;
  savingAssetId: string | null;
  error?: string;
  locale: string;
  onSelect(asset: ShotVideoAsset): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const zh = locale !== "en";
  const selected = selectedShotAsset(assets, shotId);
  const videos = assets.filter((asset) => asset.shotId === shotId && asset.status === "done" && asset.filePath && isVideo(asset.filePath))
    .sort((a, b) => assetTime(a) - assetTime(b) || a.id.localeCompare(b.id));
  const images = assets.filter((asset) => asset.shotId === shotId && asset.status === "done" && asset.filePath && !isVideo(asset.filePath))
    .sort((a, b) => assetTime(a) - assetTime(b) || a.id.localeCompare(b.id));
  const candidates = [...images, ...videos];
  const panelId = `shot-video-versions-${shotId}`;

  if (!videos.length) return <p className="mt-3 text-[11px] text-muted-foreground">{zh ? "此镜头暂无可切换的视频版本" : "No video versions available for this shot"}</p>;

  return (
    <div className="mt-3 border-t border-border/30 pt-3">
      <button type="button" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded((value) => !value)} className="flex items-center gap-1.5 text-xs text-primary">
        <LuChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
        {zh ? `选择视频版本（${videos.length}）` : `Choose video version (${videos.length})`}
      </button>
      {expanded && (
        <div id={panelId} className="mt-3 space-y-3">
          <p className="text-[11px] text-muted-foreground">{zh ? "每个镜头可独立选择，选用后会保存并用于合成。" : "Choose each shot independently. Your selection is saved and used for composition."}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {candidates.map((asset) => {
              const chosen = asset.id === selected?.id;
              const video = isVideo(asset.filePath!);
              const version = videos.findIndex((item) => item.id === asset.id) + 1;
              const imageVersion = images.findIndex((item) => item.id === asset.id) + 1;
              const title = video ? zh ? `视频版本 ${version}` : `Video version ${version}` : zh ? `图片版本 ${imageVersion}` : `Image version ${imageVersion}`;
              const date = assetTime(asset) ? new Intl.DateTimeFormat(zh ? "zh-CN" : "en-US", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(assetTime(asset))) : "";
              return (
                <div key={asset.id} className={`rounded-lg border p-2 space-y-2 ${chosen ? "border-primary bg-primary/5" : "border-border/50"}`}>
                  {video ? (
                    <video key={asset.id} src={asset.filePath!} poster={asset.thumbnailPath ?? undefined} controls muted playsInline preload="metadata" aria-label={title} className="w-full h-40 rounded bg-black object-contain" />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={asset.filePath!} alt={title} className="w-full h-40 rounded bg-black object-contain" />
                  )}
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium">{title}</span>
                    {chosen && <span className="flex items-center gap-1 text-[11px] text-primary"><LuCheck className="h-3 w-3" />{zh ? "当前选用" : "Selected"}</span>}
                  </div>
                  {(asset.model || date) && <p className="text-[10px] text-muted-foreground truncate" title={asset.model ?? undefined}>{[asset.model, date].filter(Boolean).join(" · ")}</p>}
                  <button type="button" disabled={disabled || chosen} onClick={() => onSelect(asset)} aria-label={zh ? `选用镜头 ${shotId} 的${title}` : `Use ${title} for shot ${shotId}`} className="flex w-full items-center justify-center gap-1 rounded border border-border px-2 py-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed hover:bg-muted/30">
                    {savingAssetId === asset.id && <LuLoaderCircle className="h-3 w-3 animate-spin" />}
                    {savingAssetId === asset.id ? zh ? "正在保存…" : "Saving…" : chosen ? zh ? "已选用" : "Selected" : zh ? "选用此版本" : "Use this version"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}
