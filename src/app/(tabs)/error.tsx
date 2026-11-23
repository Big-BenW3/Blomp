"use client";

export default function TabsError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="flex flex-col gap-3.5">
      <div className="ui-list mt-10 px-6 py-8 text-center">
        <p className="text-base font-semibold">Something went wrong</p>
        <p className="mx-auto mt-1.5 max-w-xs text-sm text-muted">Blomp could not load this screen. Try again.</p>
        <button type="button" className="ui-btn mt-5" onClick={() => reset()}>
          Try again
        </button>
      </div>
    </main>
  );
}
