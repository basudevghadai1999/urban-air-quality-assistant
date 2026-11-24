import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface CardProps {
  className?: string;
  children: ReactNode;
}

/** Bordered surface container. */
export function Card({ className, children }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-line bg-surface p-5 shadow-sm",
        className,
      )}
    >
      {children}
    </div>
  );
}
