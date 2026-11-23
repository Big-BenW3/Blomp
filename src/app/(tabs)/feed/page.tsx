import { EmptyState } from "@/components/empty-state";

export default function FeedPage() {
  return (
    <main className="flex flex-col gap-3.5">
      <h1 className="ui-title">Feed</h1>
      <EmptyState title="Nothing yet" body="Run a scan on one of your repos and its history will appear here." />
    </main>
  );
}
