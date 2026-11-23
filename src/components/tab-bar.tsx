"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FeedIcon, RepoIcon, UserIcon } from "@/components/icons";

const TABS = [
  { href: "/repos", label: "Repos", Icon: RepoIcon },
  { href: "/feed", label: "Feed", Icon: FeedIcon },
  { href: "/profile", label: "Profile", Icon: UserIcon },
] as const;

export function TabBar() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-20 border-t backdrop-blur-xl backdrop-saturate-150"
      style={{
        background: "var(--glass)",
        borderColor: "var(--sep)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <ul className="mx-auto grid max-w-xl grid-cols-3 pt-1.5 pb-1">
        {TABS.map(({ href, label, Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-[46px] flex-col items-center justify-center gap-0.5 text-[10.5px] font-semibold ${
                  active ? "text-foreground" : "text-muted"
                }`}
              >
                <Icon size={23} />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
