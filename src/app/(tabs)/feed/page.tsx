import { EmptyState } from "@/components/empty-state";

export default function FeedPage() {
  return (
    <main>
      <h1 className="text-2xl font-bold tracking-tight">Feed</h1>
      <p className="mt-1 text-sm text-muted">Every scan, failure, fix and verification, newest first.</p>
      <EmptyState title="Nothing yet" body="Run a scan on one of your repos and its history will appear here." />
    </main>
  );
}
