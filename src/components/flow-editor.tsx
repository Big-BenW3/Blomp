"use client";

import { useActionState, useRef, useState } from "react";
import { ChevronDown, Plus } from "@/components/icons";
import type { ActionState } from "@/lib/repos/action-state";

export interface FlowItem {
  id?: string;
  name: string;
  objective: string;
  path: string;
  enabled: boolean;
}
type Item = FlowItem & { key: string };

const plain = (f: FlowItem): FlowItem => ({ id: f.id, name: f.name, objective: f.objective, path: f.path, enabled: f.enabled });
const strip = (items: FlowItem[]): FlowItem[] => items.map(plain);

export function FlowEditor({
  initial,
  action,
  maxEnabled,
  maxTotal,
}: {
  initial: FlowItem[];
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  maxEnabled: number;
  maxTotal: number;
}) {
  const counter = useRef(0);
  const [items, setItems] = useState<Item[]>(() => initial.map((f, i) => ({ ...f, key: f.id ?? `new-${i}` })));
  const [open, setOpen] = useState<string | null>(null);
  const [state, formAction, pending] = useActionState(action, null);

  const enabledCount = items.filter((f) => f.enabled).length;
  const [baseline] = useState(() => JSON.stringify(strip(initial)));
  const dirty = JSON.stringify(strip(items)) !== baseline;

  function patch(key: string, change: Partial<FlowItem>) {
    setItems((prev) => prev.map((f) => (f.key === key ? { ...f, ...change } : f)));
  }
  function add() {
    const key = `added-${counter.current++}`;
    setItems((prev) => [...prev, { key, name: "", objective: "", path: "/", enabled: enabledCount < maxEnabled }]);
    setOpen(key);
  }
  function remove(key: string) {
    setItems((prev) => prev.filter((f) => f.key !== key));
    setOpen(null);
  }

  return (
    <form action={formAction} className="flex flex-col gap-3.5">
      <input type="hidden" name="flows" value={JSON.stringify(strip(items))} />
      {items.length > 0 ? (
        <p className="ui-eyebrow">
          <span>Flows Kane will check</span>
          <span>
            {enabledCount} of {maxEnabled} on
          </span>
        </p>
      ) : null}
      <ul className="ui-list split" hidden={items.length === 0}>
        {items.map((f) => {
          const isOpen = open === f.key;
          const blocked = !f.enabled && enabledCount >= maxEnabled;
          return (
            <li key={f.key}>
              <div className="ui-row">
                <button
                  type="button"
                  className="ui-body flex items-center gap-2 text-left"
                  style={{ background: "none", border: 0, padding: 0, color: "inherit", font: "inherit" }}
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? null : f.key)}
                >
                  <span className="ui-body">
                    <p className="ui-rt">{f.name || "New flow"}</p>
                    <p className="ui-rs">{f.path}</p>
                  </span>
                  <ChevronDown size={16} className={`shrink-0 text-muted transition-transform ${isOpen ? "rotate-180" : ""}`} />
                </button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={f.enabled}
                  aria-label={`Check ${f.name || "this flow"}`}
                  className="ui-toggle"
                  disabled={blocked}
                  onClick={() => patch(f.key, { enabled: !f.enabled })}
                />
              </div>
              {isOpen ? (
                <div className="flex flex-col gap-2 px-4 pb-4">
                  <input
                    className="ui-field"
                    value={f.name}
                    maxLength={60}
                    placeholder="Name, like Sign up"
                    aria-label="Flow name"
                    onChange={(e) => patch(f.key, { name: e.target.value })}
                  />
                  <textarea
                    className="ui-textarea"
                    rows={3}
                    value={f.objective}
                    maxLength={1000}
                    placeholder="What Kane should do, ending with what must be visible when it works"
                    aria-label="What Kane should do"
                    onChange={(e) => patch(f.key, { objective: e.target.value })}
                  />
                  <input
                    className="ui-field font-mono"
                    value={f.path}
                    maxLength={200}
                    placeholder="/"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-label="Page the flow starts on"
                    onChange={(e) => patch(f.key, { path: e.target.value })}
                  />
                  <button type="button" className="ui-text-btn danger self-start" onClick={() => remove(f.key)}>
                    Remove this flow
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {items.length < maxTotal ? (
        <button type="button" className="ui-text-btn self-start" onClick={add}>
          <Plus size={16} />
          {items.length === 0 ? "Write a flow yourself" : "Add a flow"}
        </button>
      ) : null}
      {state && !state.ok && state.message ? (
        <p className="ui-note error" role="alert">
          {state.message}
        </p>
      ) : null}
      {dirty ? (
        <button type="submit" className="ui-btn" disabled={pending}>
          {pending ? "Saving…" : "Save changes"}
        </button>
      ) : state?.ok ? (
        <p className="ui-note ok">Saved</p>
      ) : null}
    </form>
  );
}
