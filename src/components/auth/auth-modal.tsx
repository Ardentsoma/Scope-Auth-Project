"use client";

import { useEffect, type ReactNode } from "react";

/**
 * Accessible modal shell used by the auth flows over the sign-in screen.
 * - role="dialog" + aria-modal + labelled by the title
 * - Escape or overlay click closes it
 * - Each modal gets its own section role + id for screen readers
 */
export default function AuthModal({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex min-h-full items-center justify-center px-6 py-8">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
        className="relative z-10 w-full max-w-[560px] rounded-2xl border border-neutral-100 bg-[#fffefb] p-10 shadow-2xl"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          className="absolute right-4 top-4 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-neutral-300 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400/40 hover:bg-neutral-50 hover:text-neutral-500"
        >
          <svg
            viewBox="0 0 20 20"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M5 5l10 10M15 5L5 15" />
          </svg>
        </button>

        <h2
          id="auth-modal-title"
          className="mb-1.5 text-center text-[1.4rem] font-display leading-tight tracking-tight text-neutral-500"
        >
          {title}
        </h2>
        {subtitle && (
          <p className="text-center text-[0.9rem] font-normal text-neutral-300">
            {subtitle}
          </p>
        )}
        <div className="mt-5">{children}</div>

        <button
          type="button"
          onClick={onClose}
          className="mt-6 w-full cursor-pointer border-0 bg-transparent p-0 text-center text-[0.85rem] font-semibold text-neutral-400 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400/40 hover:text-red-500"
        >
          Back to sign in
        </button>
      </div>
    </div>
  );
}