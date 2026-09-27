import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Not Found | SCOPE",
};

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col bg-[#fffefa]">
      <header className="flex items-center justify-between border-b border-neutral-100/60 bg-white px-6 py-4 md:px-8">
        <Link href="/dashboard" className="group flex items-center">
          <span className="relative inline-block text-xl font-extrabold leading-none tracking-[0.04em] text-neutral-500">
            SCOPE
            <span className="absolute -bottom-1 right-0 h-[3px] w-7 rounded-sm bg-red-500" />
          </span>
        </Link>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center">
        <p className="font-mono text-sm tracking-[0.3em] text-neutral-200">404</p>
        <h1 className="text-3xl font-display tracking-tight text-neutral-500 md:text-4xl">
          This page is out of scope.
        </h1>
        <p className="max-w-md leading-relaxed text-neutral-300">
          We couldn&apos;t find anything at this address. It may have moved, or
          the link may be out of date.
        </p>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/dashboard"
            className="rounded-md bg-neutral-500 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-neutral-600"
          >
            Go to Dashboard
          </Link>
        </div>
      </main>
    </div>
  );
}
