"use client";

import { useActionState } from "react";
import type { ActionState } from "@/lib/repos/action-state";

/** One row with a switch: Kane scans the live site by itself after each production deploy. */
export function AutoScanToggle({
  initial,
  action,
}: {
  initial: boolean;
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  // While the request is in flight the switch already shows where it is going.
  const on = pending ? !initial : initial;

  return (
    <form action={formAction} className="flex flex-col gap-1.5">
      <ul className="ui-list">
        <li className="ui-row">
          <div className="ui-body">
            <p className="ui-rt">Scan when I push</p>
            <p className="ui-rs">Kane checks your flows after each deploy</p>
          </div>
          <input type="hidden" name="enabled" value={String(!initial)} />
          <button type="submit" role="switch" aria-checked={on} aria-label="Scan when I push" className="ui-toggle" disabled={pending} />
        </li>
      </ul>
      {state && !state.ok && state.message ? (
        <p className="ui-note error" role="alert">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
