import type { Metadata } from "next";
import { Dela_Gothic_One, JetBrains_Mono, Work_Sans } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-store";

/**
 * Fonts are declared with `next/font` rather than a `<link>` to Google, so they
 * are downloaded and self-hosted at build time. That removes a render-blocking
 * request to a third party on every page load, keeps the fonts working when
 * Google is unreachable, and avoids leaking visitors to Google.
 *
 * Each family exposes a CSS variable; `globals.css` maps those onto the
 * Tailwind `--font-*` theme keys, which is what `font-sans`, `font-display` and
 * `font-mono` resolve to. The original system-font fallbacks are kept in
 * `globals.css` so text still renders if a variable is missing.
 */
const workSans = Work_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800", "900"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-work-sans",
});

const delaGothicOne = Dela_Gothic_One({
  subsets: ["latin"],
  weight: ["400"],
  display: "swap",
  variable: "--font-dela-gothic",
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
  title: "SCOPE - Brief Manager",
  description:
    "Manage freelance project briefs with SCOPE. Attach the documents a brief needs and keep them organised per account.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${workSans.variable} ${delaGothicOne.variable} ${jetBrainsMono.variable}`}
    >
      <body className="min-h-screen antialiased">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
