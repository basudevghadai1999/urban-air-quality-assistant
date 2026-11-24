import Link from "next/link";

import { APP_NAME } from "@/lib/constants";

function LogoMark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 64 64"
      className="size-9 shrink-0 text-brand"
      fill="none"
      stroke="currentColor"
      strokeWidth="5"
      strokeLinecap="round"
    >
      <path d="M10 24h28a8 8 0 1 0-8-8" />
      <path d="M10 36h38a8 8 0 1 1-8 8" />
      <path d="M10 48h16" />
    </svg>
  );
}

export function SiteHeader() {
  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-3 rounded-lg">
          <LogoMark />
          <span className="text-lg font-bold tracking-tight">{APP_NAME}</span>
        </Link>
      </div>
    </header>
  );
}
