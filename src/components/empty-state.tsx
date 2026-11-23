export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="ui-list mt-10 px-6 py-10 text-center">
      <p className="text-base font-semibold">{title}</p>
      <p className="mx-auto mt-1.5 max-w-xs text-sm text-muted">{body}</p>
    </div>
  );
}
