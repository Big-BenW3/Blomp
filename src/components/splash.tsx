"use client";

import { useEffect, useState } from "react";
import { Logo } from "@/components/logo";

const KEY = "blomp-splash-seen";

/** Logo-only splash, once per browser session. Rendered on the server so it covers the page from the first paint. */
export function Splash() {
  const [phase, setPhase] = useState<"show" | "leaving" | "gone">("show");

  useEffect(() => {
    let seen = false;
    try {
      seen = sessionStorage.getItem(KEY) === "1";
      sessionStorage.setItem(KEY, "1");
    } catch {
      // storage can be blocked; just show the splash
    }
    // Already shown this session: remove it straight away. Otherwise hold the logo, then fade.
    const leave = seen ? undefined : setTimeout(() => setPhase("leaving"), 900);
    const gone = setTimeout(() => setPhase("gone"), seen ? 0 : 1300);
    return () => {
      if (leave) clearTimeout(leave);
      clearTimeout(gone);
    };
  }, []);

  if (phase === "gone") return null;
  return (
    <div className="splash" data-leaving={phase === "leaving"} aria-hidden="true">
      <Logo size={104} />
    </div>
  );
}
