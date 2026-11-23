"use client";

import { useActionState } from "react";
import type { ActionState } from "@/lib/repos/action-state";

export function ScanButton({ action, hint }: { action: () => Promise<ActionState>; hint?: string }) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className="flex flex-col gap-1.5">
      <button type="submit" className="ui-btn" disabled={Boolean(hint) || pending}>
        {pending ? "Starting…" : "Scan now"}
      </button>
      {state && !state.ok && state.message ? (
        <p className="ui-note error text-center" role="alert">
          {state.message}
        </p>
      ) : hint ? (
        <p className="ui-note text-center">{hint}</p>
      ) : null}
    </form>
  );
}
