"use client";

import Link from "next/link";
import { Box, Zap } from "lucide-react";
import { useT } from "@/lib/i18n";

type CreationTypeGateProps = {
  onSelectShortVideoSales: () => void;
};

/**
 * Keeps legacy sales-only shortcuts behind the same explicit creation-type
 * decision as the canonical new-project flow.
 */
export function CreationTypeGate({ onSelectShortVideoSales }: CreationTypeGateProps) {
  const t = useT("newProject");

  return (
    <section aria-labelledby="creation-type-gate-title">
      <div className="mb-3">
        <h2 id="creation-type-gate-title" className="text-sm font-semibold text-foreground">
          {t("creationTypeTitle")}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">{t("pageSubtitleGeneral")}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={onSelectShortVideoSales}
          className="flex min-h-28 items-start gap-3 rounded-lg border border-border/50 bg-muted/20 p-3.5 text-left transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
        >
          <Zap className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
          <span>
            <span className="block text-sm font-medium text-foreground">{t("creationTypeSalesLabel")}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">{t("creationTypeSalesDesc")}</span>
          </span>
        </button>
        <Link
          href="/project/new"
          className="flex min-h-28 items-start gap-3 rounded-lg border border-border/50 bg-muted/20 p-3.5 text-left transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
        >
          <Box className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
          <span>
            <span className="block text-sm font-medium text-foreground">{t("creationTypeCgLabel")}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">{t("creationTypeCgDesc")}</span>
          </span>
        </Link>
      </div>
    </section>
  );
}
