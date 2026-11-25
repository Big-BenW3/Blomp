import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { AlertMark, Bolt, CheckMark, PullRequest, ShieldCheck, XMark } from "@/components/icons";
import type { FeedIconName, FeedItem } from "@/lib/feed/build";
import { loadFeed } from "@/lib/feed/load";
import { requireUserId } from "@/lib/repos/load";

export const dynamic = "force-dynamic";

const ICONS: Record<FeedIconName, typeof CheckMark> = {
  check: CheckMark,
  x: XMark,
  alert: AlertMark,
  pr: PullRequest,
  bolt: Bolt,
  shield: ShieldCheck,
};

function Row({ item }: { item: FeedItem }) {
  const Icon = ICONS[item.icon];
  const inner = (
    <>
      <span className={`ui-tile ${item.tone}`}>
        <Icon size={18} />
      </span>
      <div className="ui-body">
        <p className="ui-rt">{item.title}</p>
        <p className="ui-rs">{item.detail}</p>
      </div>
      <span className="shrink-0 text-xs text-muted">{item.ago}</span>
    </>
  );
  return item.external ? (
    <a href={item.href} target="_blank" rel="noopener noreferrer" className="ui-row">
      {inner}
    </a>
  ) : (
    <Link href={item.href} className="ui-row">
      {inner}
    </Link>
  );
}

export default async function FeedPage() {
  const userId = await requireUserId();
  const groups = await loadFeed(userId);

  return (
    <main className="flex flex-col gap-3.5">
      <h1 className="ui-title">Feed</h1>
      {groups.length === 0 ? (
        <EmptyState title="Nothing yet" body="Run a scan on one of your repos and its history will appear here." />
      ) : (
        groups.map((g) => (
          <section key={g.label} className="flex flex-col gap-2">
            <p className="ui-eyebrow">{g.label}</p>
            <ul className="ui-list split">
              {g.items.map((item) => (
                <li key={item.id}>
                  <Row item={item} />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </main>
  );
}
