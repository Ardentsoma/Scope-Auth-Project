"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/toast";
import { verifyEmailSchema, fieldErrors } from "@/lib/validation/auth";
import { useAuthStore } from "@/lib/auth-store";
import {
  labelClass,
  fieldErrorClass,
  buttonClass,
  inputBaseClass,
} from "@/components/form";

const RESEND_COOLDOWN_SECONDS = 60;

export default function VerifyEmailModal() {
  const router = useRouter();
  const { showToast } = useToast();
  const { state, actions } = useAuthStore();
  // The email is carried from signup / sign-in in the shared auth store.
  const email = state.pendingEmail;
  const [code, setCode] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  // Cosmetic countdown only — the server enforces the real 60s cooldown.
  const [secondsLeft, setSecondsLeft] = useState(RESEND_COOLDOWN_SECONDS);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Kick out anyone who lands on this page WITHOUT a pending email — but only
  // on arrival. The pending email is intentionally cleared when verification
  // succeeds, and that clear must not trigger a redirect back to /signin.
  const mountedCheckDone = useRef(false);
  useEffect(() => {
    if (!mountedCheckDone.current) {
      mountedCheckDone.current = true;
      if (!email) {
        router.replace("/signin");
      }
    }
  }, [email, router]);

  useEffect(() => {
    if (secondsLeft <= 0) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
      return;
    }
    if (!intervalRef.current) {
      intervalRef.current = setInterval(() => {
        setSecondsLeft((s) => {
          if (s <= 1 && intervalRef.current) clearInterval(intervalRef.current);
          return Math.max(0, s - 1);
        });
      }, 1000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
  }, [secondsLeft]);

  const handleVerify = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);

    const parsed = verifyEmailSchema.safeParse({ email, code });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error) ?? {});
      setLoading(false);
      return;
    }
    setErrors({});

    try {
      const res = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 429) {
        showToast(data.error ?? "Please wait before trying again.", "error");
        setLoading(false);
        return;
      }

      if (data.alreadyVerified) {
        showToast(
          "This email is already verified. Please sign in.",
          "info"
        );
        actions.clearPendingEmail();
        actions.clearSignup();
        actions.closeModal();
        router.push("/signin");
        return;
      }

      if (!res.ok) {
        setErrors(data.errors ?? {});
        showToast(data.error ?? "Unable to verify that code.", "error");
        setLoading(false);
        return;
      }

      actions.clearPendingEmail();
      actions.clearSignup();
      actions.closeModal();
      showToast("Email verified! Welcome to SCOPE.", "success");
      router.push("/dashboard");
      router.refresh();
    } catch {
      showToast("Network error. Please try again.", "error");
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (!email || secondsLeft > 0 || resending) return;
    setResending(true);

    try {
      const res = await fetch("/api/auth/verify/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 429) {
        const remaining = data.remainingSeconds ?? 0;
        if (remaining > 0) setSecondsLeft(remaining);
        showToast(data.error ?? "Please wait before requesting another code.", "error");
        setResending(false);
        return;
      }

      if (!res.ok) {
        showToast(data.error ?? "Unable to resend the code.", "error");
        setResending(false);
        return;
      }

      setSecondsLeft(data.cooldownSeconds ?? RESEND_COOLDOWN_SECONDS);
      showToast("A new code is on its way to your email.", "success");
    } catch {
      showToast("Network error. Please try again.", "error");
    } finally {
      setResending(false);
    }
  };

  return (
    <form className="flex w-full flex-col gap-4" onSubmit={handleVerify} noValidate>
      <div className="flex w-full flex-col text-left">
        <label htmlFor="verify-email-modal-code" className={labelClass}>
          Verification code
        </label>
        <input
          id="verify-email-modal-code"
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          placeholder="000000"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          required
          aria-invalid={Boolean(errors.code)}
          aria-describedby={errors.code ? "verify-modal-code-error" : undefined}
          className={inputBaseClass}
        />
        {errors.code && (
          <p id="verify-modal-code-error" role="alert" className={fieldErrorClass}>
            {errors.code}
          </p>
        )}
      </div>

      <button type="submit" disabled={loading} className={buttonClass}>
        {loading ? "Verifying..." : "Verify"}
      </button>

      <p className="mt-1 text-center text-[0.8rem] text-neutral-400">
        Didn&apos;t get a code?{" "}
        {secondsLeft > 0 ? (
          <span className="font-semibold text-red-500">Resend in {secondsLeft}s</span>
        ) : (
          <button
            type="button"
            onClick={handleResend}
            disabled={resending || !email}
            className="cursor-pointer border-0 bg-transparent p-0 font-semibold text-red-500 no-underline transition-colors duration-150 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
          >
            {resending ? "Sending..." : "Resend code"}
          </button>
        )}
      </p>
    </form>
  );
}