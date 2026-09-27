import type { Metadata } from "next";
import Link from "next/link";
import BrandArtCard from "@/components/brand-art-card";
import CreateAccountForm from "./create-account-form";

export const metadata: Metadata = {
  title: "Create Account | SCOPE",
};

export default function CreateAccountPage() {
  return (
    <div className="flex min-h-screen w-full flex-col items-center gap-8 px-6 py-12 md:grid md:grid-cols-2 md:items-stretch md:gap-[72px] md:py-8">
      <BrandArtCard />

      <div className="flex w-full items-center justify-center">
        <div className="flex w-full max-w-[440px] flex-col items-stretch">
          <div className="mb-6 text-center">
            <h1 className="mb-1.5 text-[2.15rem] font-display leading-tight tracking-tight text-neutral-500">
              Create Account
            </h1>
            <p className="text-[0.95rem] font-normal text-neutral-300">
              Set up your projects in minutes.
            </p>
          </div>

          <CreateAccountForm />

          <p className="mt-4 text-center text-[0.8rem] text-neutral-400">
            Already have an account?{" "}
            <Link
              href="/signin"
              className="font-bold text-red-500 no-underline hover:underline"
            >
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}