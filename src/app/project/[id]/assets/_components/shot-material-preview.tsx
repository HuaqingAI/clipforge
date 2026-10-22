"use client";

import Image from "next/image";
import { useState } from "react";
import type { AssetItem } from "@/lib/assets-view";
import { useT } from "@/lib/i18n";

const VIDEO_URL = /\.(?:mp4|webm|mov|m4v)(?:[?#]|$)/i;
const STATIC_IMAGE_URL = /\.(?:avif|gif|ico|jpe?g|png|svg|webp)(?:[?#]|$)/i;

function MaterialImage({ url, shotId, source }: { url: string; shotId: number; source: boolean }) {
  const t = useT("assets");
  const [failed, setFailed] = useState(false);

  return (
    <figure className="w-full max-w-64 min-w-0">
      <figcaption className="mb-1.5 text-xs text-muted-foreground">
        {t(source ? "sourceImageLabel" : "currentImageLabel")}
      </figcaption>
      {failed ? (
        <p role="status" className="rounded-md border border-border/50 p-3 text-xs text-muted-foreground">
          {t("sourceImageLoadFailed")}
        </p>
      ) : (
        <div className="relative h-36 w-full overflow-hidden rounded-md border border-border/50 bg-muted/20">
          <Image
            src={url}
            alt={t("sourceImageAlt", { shot: shotId })}
            fill
            unoptimized
            sizes="256px"
            className="object-contain object-left"
            onError={() => setFailed(true)}
          />
        </div>
      )}
    </figure>
  );
}

/** Shows the actual still in use, or the recorded input of an animated shot. */
export function ShotMaterialPreview({ asset }: { asset: AssetItem }) {
  const t = useT("assets");
  const candidateImage = asset.isVideo ? asset.sourceImageUrl : asset.thumbnailUrl;
  const imageUrl = candidateImage && !VIDEO_URL.test(candidateImage) ? candidateImage : undefined;
  const videoUrl = asset.isVideo ? asset.videoUrl : undefined;
  const externalMaterial = ["local", "user_upload", "stock"].includes(asset.assetProvider ?? "")
    || ["user_upload", "stock_footage"].includes(asset.assetType ?? "");
  const missingSource = asset.isVideo && !imageUrl && !externalMaterial;
  const poster = asset.thumbnailUrl && STATIC_IMAGE_URL.test(asset.thumbnailUrl)
    ? asset.thumbnailUrl
    : undefined;

  if (!imageUrl && !videoUrl && (asset.status !== "done" || !missingSource)) return null;

  return (
    <div data-testid="shot-material-preview" data-shot-id={asset.shotId} className="mt-3 w-full min-w-0">
      {imageUrl ? (
        <MaterialImage key={imageUrl} url={imageUrl} shotId={asset.shotId} source={Boolean(asset.isVideo)} />
      ) : videoUrl ? (
        <figure className="w-full max-w-64 min-w-0">
          <figcaption className="mb-1.5 text-xs text-muted-foreground">{t("currentVideoLabel")}</figcaption>
          <video
            key={videoUrl}
            src={videoUrl}
            poster={poster}
            controls
            playsInline
            preload="metadata"
            aria-label={t("sourceVideoAlt", { shot: asset.shotId })}
            className="h-36 w-full rounded-md border border-border/50 bg-muted/20 object-contain"
          />
        </figure>
      ) : null}
      {missingSource && <p className="mt-1.5 text-xs text-muted-foreground">{t("sourceImageMissing")}</p>}
    </div>
  );
}
