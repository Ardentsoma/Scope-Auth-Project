import { redirect } from "next/navigation";
import { ToastProvider } from "@/components/toast";
import { getSessionUser } from "@/lib/auth/session";
import { isAuthConfigured } from "@/lib/auth/config";

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Signed-in users have no business on the auth screens. This uses the same
  // DB-backed session check as the protected pages so it can never disagree
  // with the render layer the way a cookie-only proxy check did (which caused
  // a /signin <-> /dashboard redirect loop for stale sessions).
  if (isAuthConfigured() && (await getSessionUser())) {
    redirect("/dashboard");
  }

  return (
    <ToastProvider>
      <main className="flex min-h-screen w-full">{children}</main>
    </ToastProvider>
  );
}