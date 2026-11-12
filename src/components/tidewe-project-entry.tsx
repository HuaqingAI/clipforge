"use client";

import Link from "next/link";
import { Trees } from "lucide-react";
import { useT } from "@/lib/i18n";

export function TideweProjectEntry() {
  const t = useT("tidewe");

  return (
    <Link
      href="/project/new"
      className="flex min-h-28 items-start gap-3 rounded-lg border border-border/50 bg-muted/20 p-3.5 text-left transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
    >
      <Trees className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
      <span>
        <span className="block text-sm font-medium text-foreground">{t("label")}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{t("description")}</span>
      </span>
    </Link>
  );
}
