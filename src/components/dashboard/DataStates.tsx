import type { ReactNode } from "react";

import { Card } from "@/components/ui/Card";
import type { ApiFailure } from "@/lib/client/dashboardApi";

/** Placeholder block while a request is in flight. Announced once through the section's aria-busy. */
export function Skeleton({ lines = 3, label }: { lines?: number; label: string }) {
  return (
    <div aria-busy="true" aria-live="polite" className="space-y-3">
      <p className="sr-only">{label}</p>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} aria-hidden="true" className="h-4 animate-pulse rounded bg-surface-muted" style={{ width: `${95 - i * 12}%` }} />
      ))}
    </div>
  );
}

/** A request failure with a plain message and, where useful, a retry button. */
export function ErrorPanel({ title, failure, onRetry }: { title: string; failure: ApiFailure; onRetry?: () => void }) {
  return (
    <div role="alert" className="space-y-3 rounded-xl border border-warn-ink bg-warn-bg p-4 text-warn-ink">
      <p className="font-semibold">{title}</p>
      <p className="text-sm">{failure.message}</p>
      {failure.retryAfterSeconds === null ? null : <p className="text-sm">Please wait about {failure.retryAfterSeconds} seconds first.</p>}
      {onRetry === undefined ? null : (
        <button type="button" onClick={onRetry} className="min-h-11 rounded-lg border border-warn-ink bg-surface px-4 font-semibold text-ink">
          Try again
        </button>
      )}
    </div>
  );
}

/** Titled section container used by every dashboard panel. */
export function Section({ id, title, children, aside, highlight = false }: { id: string; title: string; children: ReactNode; aside?: ReactNode; highlight?: boolean }) {
  return (
    <section aria-labelledby={`${id}-heading`} className="min-w-0">
      <Card className={highlight ? "h-full space-y-4 border-brand bg-linear-to-br from-info-bg via-surface to-surface p-6 sm:p-7" : "h-full space-y-4 p-5 sm:p-6"}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id={`${id}-heading`} className="flex items-center gap-3 text-xl font-semibold">
            <span aria-hidden="true" className="h-6 w-1.5 shrink-0 rounded-full bg-brand" />
            {title}
          </h2>
          {aside}
        </div>
        {children}
      </Card>
    </section>
  );
}
