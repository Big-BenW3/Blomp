import { auth } from "@/auth";
import { EmptyState } from "@/components/empty-state";

export default async function ReposPage() {
  const session = await auth();
  return (
    <main>
      <h1 className="text-2xl font-bold tracking-tight">Repos</h1>
      <p className="mt-1 text-sm text-muted">
        Signed in as <span className="font-mono text-foreground">{session?.user.login}</span>
      </p>
      <EmptyState
        title="No repos connected yet"
        body="Your GitHub repos will show up here so Kane can check their live sites."
      />
    </main>
  );
}
