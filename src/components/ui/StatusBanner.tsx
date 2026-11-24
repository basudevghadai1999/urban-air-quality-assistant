import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type BannerTone = "warning" | "info";

const TONE_CLASSES: Record<BannerTone, string> = {
  warning: "bg-warn-bg text-warn-ink border-warn-ink",
  info: "bg-info-bg text-info-ink border-info-ink",
};

interface StatusBannerProps {
  tone?: BannerTone;
  title: string;
  children: ReactNode;
}

/** Page-level notice. `role="status"` announces it politely to assistive tech. */
export function StatusBanner({
  tone = "warning",
  title,
  children,
}: StatusBannerProps) {
  return (
    <div
      role="status"
      className={cn("rounded-2xl border p-4 sm:p-5", TONE_CLASSES[tone])}
    >
      <p className="font-semibold">{title}</p>
      <p className="mt-1 text-sm">{children}</p>
    </div>
  );
}
