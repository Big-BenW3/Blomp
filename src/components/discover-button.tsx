"use client";

import { useActionState } from "react";
import { Sparkle } from "@/components/icons";
import type { ActionState } from "@/lib/repos/action-state";

export function DiscoverButton({ action, hasFlows }: { action: () => Promise<ActionState>; hasFlows: boolean }) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className="flex flex-col items-stretch gap-1">
      {hasFlows ? (
        <button type="submit" className="ui-text-btn" disabled={pending}>
          <Sparkle size={16} />
          {pending ? "Reading your code…" : "Find flows again"}
        </button>
      ) : (
        <button type="submit" className="ui-btn" disabled={pending}>
          <Sparkle size={18} />
          {pending ? "Reading your code…" : "Find flows with AI"}
        </button>
      )}
      {state && !state.ok && state.message ? (
        <p className="ui-note error text-center" role="alert">
          {state.message}
        </p>
      ) : hasFlows ? (
        <p className="ui-note text-center">Replaces the AI suggestions. Flows you wrote stay.</p>
      ) : null}
    </form>
  );
}
