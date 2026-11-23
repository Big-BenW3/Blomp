"use client";

import { useActionState, useState } from "react";
import { Globe } from "@/components/icons";
import type { ActionState } from "@/lib/repos/action-state";

export function SiteUrlForm({
  initial,
  action,
}: {
  initial: string;
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [value, setValue] = useState(initial);
  const [state, formAction, pending] = useActionState(action, null);
  const dirty = value.trim() !== initial;

  return (
    <form action={formAction} className="flex flex-col gap-1.5">
      <ul className="ui-list">
        <li className="ui-row">
          <Globe size={19} className="shrink-0 text-muted" />
          <input
            name="url"
            type="text"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="ui-input"
            placeholder="my-app.vercel.app"
            aria-label="Live site address"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          {dirty ? (
            <button type="submit" className="ui-text-btn" style={{ minHeight: 32 }} disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </button>
          ) : null}
        </li>
      </ul>
      {state && !state.ok && state.message ? (
        <p className="ui-note error" role="alert">
          {state.message}
        </p>
      ) : !initial && !dirty ? (
        <p className="ui-note">Kane will open this address, so add your live site.</p>
      ) : null}
    </form>
  );
}
