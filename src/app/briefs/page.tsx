import { permanentRedirect } from "next/navigation";

/**
 * The briefs workspace now lives at /dashboard, which is where the auth proxy
 * in src/proxy.ts also applies. /briefs is kept as a permanent redirect rather
 * than deleted so existing links, bookmarks and screenshots do not 404.
 */
export default function BriefsRedirect() {
  permanentRedirect("/dashboard");
}
