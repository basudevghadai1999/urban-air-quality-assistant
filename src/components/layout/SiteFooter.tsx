import { APP_NAME } from "@/lib/constants";

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-line bg-surface">
      <div className="mx-auto w-full max-w-7xl space-y-2 px-4 py-6 text-sm text-ink-muted sm:px-6">
        <p>
          <span className="font-semibold text-ink">{APP_NAME}</span> shows
          modelled estimates, not official CPCB station readings. Guidance is
          general information and is not medical advice.
        </p>
      </div>
    </footer>
  );
}
