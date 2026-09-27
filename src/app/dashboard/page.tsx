import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getSessionUser } from "@/lib/auth/session";
import { isAuthConfigured } from "@/lib/auth/config";
import { listBriefs } from "@/lib/briefs/service";
import { listAllAssets } from "@/lib/briefs/assets";
import DashboardWorkspace from "@/components/dashboard/dashboard-workspace";

export const metadata: Metadata = {
  title: "Dashboard | SCOPE",
};

export const dynamic = "force-dynamic";

/**
 * The dashboard is the app's main workspace: create a brief, paste its text,
 * and attach PDF/JPG/PNG files to it. Both reads are owner-scoped inside the
 * service layer, so this page can only ever render the signed-in user's own
 * briefs and files.
 *
 * Files are loaded here rather than fetched from the client so the first paint
 * needs no request and shows the right files immediately.
 *
 * `/dashboard` is also covered by the auth proxy in src/proxy.ts, which
 * redirects unauthenticated visitors to /signin before this component runs.
 */
export default async function DashboardPage() {
  if (!isAuthConfigured()) {
    redirect("/signin");
  }

  const user = await getSessionUser();
  if (!user) {
    redirect("/signin");
  }

  const briefs = await listBriefs(user.id);
  const assets = await listAllAssets(user.id);
  const displayName = user.fullName || user.email.split("@")[0] || "designer";

  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[#fffefa]">
          <div className="text-sm font-semibold text-neutral-300">
            Loading your workspace...
          </div>
        </div>
      }
    >
      <DashboardWorkspace
        initialBriefs={briefs}
        initialAssets={assets}
        displayName={displayName}
      />
    </Suspense>
  );
}
