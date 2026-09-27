"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import BrandArtCard from "@/components/brand-art-card";
import { useAuthStore, type AuthModal as AuthFlowModal } from "@/lib/auth-store";
import AuthModal from "./auth-modal";
import SignInForm from "./sign-in-form";
import ForgotPasswordModal from "./forgot-password-modal";
import VerifyEmailModal from "./verify-email-modal";
import ResetPasswordModal from "./reset-password-modal";

export type Preload = AuthFlowModal;

/** "jane.d@studio.com" -> "jan******om" — never expose the full address. */
function maskEmail(email: string): string {
  if (email.length <= 5) return `${email.slice(0, 3)}******`;
  return `${email.slice(0, 3)}******${email.slice(-2)}`;
}

/**
 * The sign-in screen. Also hosts the forgot-password / verify-email /
 * reset-password modals; the dedicated routes below render this screen with
 * the relevant modal pre-opened (deep links, e.g. the emailed reset link).
 * Modal open/close + shared form values live in the central auth store.
 */
export default function SignInScreen({
  preload,
  token,
}: {
  preload?: Preload;
  token?: string | null;
}) {
  const router = useRouter();
  const { state, actions } = useAuthStore();
  const { pendingEmail, modal } = state;

  // Deep links (e.g. /reset-password?token=...) open their modal on mount.
  useEffect(() => {
    if (preload) actions.openModal(preload);
  }, [preload, actions]);

  // When opened via a deep link, closing drops back to the plain sign-in page.
  const close = () => {
    actions.closeModal();
    if (preload) {
      router.replace("/signin");
    }
  };

  return (
    <div className="flex min-h-screen w-full flex-col items-center gap-8 px-6 py-12 md:grid md:grid-cols-2 md:items-stretch md:gap-[72px] md:py-8">
      <BrandArtCard />

      <div className="flex w-full items-center justify-center">
        <div className="flex w-full max-w-[440px] flex-col items-stretch">
          <div className="mb-6 text-center">
            <h1 className="mb-1.5 text-[2.15rem] font-display leading-tight tracking-tight text-neutral-500">
              Welcome back
            </h1>
            <p className="text-[0.95rem] font-normal text-neutral-300">
              Sign in to your projects.
            </p>
          </div>

          <SignInForm onForgot={() => actions.openModal("forgot")} />

          <p className="mt-4 text-center text-[0.8rem] text-neutral-400">
            Don&apos;t have an account?{" "}
            <Link
              href="/create-account"
              className="font-bold text-red-500 no-underline hover:underline"
            >
              Create one
            </Link>
          </p>
        </div>
      </div>

      {modal === "forgot" && (
        <AuthModal
          title="Forgot password?"
          subtitle="Enter your email and we'll send you a reset link."
          onClose={close}
        >
          <ForgotPasswordModal onDone={close} />
        </AuthModal>
      )}

      {modal === "verify" && (
        <AuthModal
          title="Verify your email"
          subtitle={
  pendingEmail ? (
    <>
      We sent a 6-digit code to{" "}
      <span className="font-semibold text-neutral-500">
        {maskEmail(pendingEmail)}
      </span>
      .
    </>
  ) : (
    "We sent a 6-digit code to your email."
  )
}
          onClose={close}
        >
          <VerifyEmailModal />
        </AuthModal>
      )}

      {modal === "reset" && (
        <AuthModal
          title="Choose a new password"
          subtitle="Make it something you haven't used before."
          onClose={close}
        >
          <ResetPasswordModal token={token ?? null} onDone={close} />
        </AuthModal>
      )}
    </div>
  );
}