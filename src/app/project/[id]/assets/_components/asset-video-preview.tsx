"use client";

import { useRef, useState } from "react";
import { LuPlay } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { AssetItem } from "@/lib/assets-view";
import { useT } from "@/lib/i18n";

export function AssetVideoPreview({ asset, projectName }: {
  asset: Pick<AssetItem, "shotId" | "videoUrl" | "thumbnailUrl" | "description">;
  projectName: string;
}) {
  const t = useT("assets");
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <Button
        ref={triggerRef}
        variant="outline"
        size="sm"
        className="text-xs w-24"
        aria-label={t("playShotVideo", { shot: asset.shotId })}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <LuPlay className="w-3 h-3 mr-1" aria-hidden="true" />{t("btnPlayVideo")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-3xl" finalFocus={triggerRef}>
          <DialogHeader>
            <DialogTitle>{t("playShotVideo", { shot: asset.shotId })}</DialogTitle>
            <DialogDescription>{[projectName, asset.description].filter(Boolean).join(" · ")}</DialogDescription>
          </DialogHeader>
          {open && <video
            src={asset.videoUrl}
            poster={asset.thumbnailUrl || undefined}
            controls
            autoPlay
            playsInline
            preload="metadata"
            className="max-h-[70vh] w-full rounded-md bg-black object-contain"
          />}
        </DialogContent>
      </Dialog>
    </>
  );
}
