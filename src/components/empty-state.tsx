export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="mt-16 rounded-2xl border border-dashed border-border px-6 py-12 text-center">
      <p className="text-base font-semibold">{title}</p>
      <p className="mx-auto mt-2 max-w-xs text-sm text-muted">{body}</p>
    </div>
  );
}
