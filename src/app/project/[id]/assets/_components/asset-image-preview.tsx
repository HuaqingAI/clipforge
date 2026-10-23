"use client";

import Image from "next/image";
import { useRef, useState, type ReactNode } from "react";
import { LuLoaderCircle, LuX } from "react-icons/lu";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/lib/i18n";

function OriginalImage({ src, alt }: { src: string; alt: string }) {
  const t = useT("assets");
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <div className="relative h-[76dvh] w-full min-w-0 overflow-hidden rounded-md bg-black/70" aria-busy={!loaded && !failed}>
      {!loaded && !failed && (
        <div role="status" className="absolute inset-0 flex items-center justify-center gap-2 text-muted-foreground">
          <LuLoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" />
          {t("imagePreviewLoading")}
        </div>
      )}
      {failed ? (
        <p role="alert" className="absolute inset-0 flex items-center justify-center p-4 text-muted-foreground">
          {t("sourceImageLoadFailed")}
        </p>
      ) : (
        <Image
          src={src}
          alt={alt}
          fill
          unoptimized
          loading="eager"
          sizes="90vw"
          className="object-contain"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}

/** Opens the full source file, preserving its entire frame and aspect ratio. */
export function AssetImagePreview({
  src,
  alt,
  shotId,
  className,
  children,
}: {
  src: string;
  alt: string;
  shotId: number;
  className?: string;
  children: ReactNode;
}) {
  const t = useT("assets");
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={t("viewOriginalImage", { shot: shotId })}
        aria-haspopup="dialog"
        className={`${className ?? ""} cursor-zoom-in focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary`}
        onClick={() => setOpen(true)}
      >
        {children}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="w-[calc(100vw-2rem)] max-w-6xl gap-3 sm:max-w-6xl"
          showCloseButton={false}
          finalFocus={triggerRef}
        >
          <div className="flex items-center justify-between gap-4">
            <DialogTitle>{t("imagePreviewTitle", { shot: shotId })}</DialogTitle>
            <button
              type="button"
              aria-label={t("closeImagePreview")}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
              onClick={() => setOpen(false)}
            >
              <LuX className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
          {open && <OriginalImage key={src} src={src} alt={alt} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
