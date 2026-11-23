"use client";

import { useSyncExternalStore } from "react";
import {
  ACCENTS,
  THEMES,
  readAccent,
  readTheme,
  setAccent,
  setTheme,
  subscribeAppearance,
  type AccentId,
  type ThemeId,
} from "@/lib/appearance";

const phoneIsDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
function subscribeAll(cb: () => void) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", cb);
  const off = subscribeAppearance(cb);
  return () => {
    mq.removeEventListener("change", cb);
    off();
  };
}

/** Theme and accent colour. Saved on this device only, so there is nothing to sync or fail. */
export function AppearanceSettings() {
  const theme = useSyncExternalStore<ThemeId>(subscribeAppearance, readTheme, () => "system");
  const accent = useSyncExternalStore<AccentId>(subscribeAppearance, readAccent, () => "indigo");
  const phoneDark = useSyncExternalStore(subscribeAll, phoneIsDark, () => false);
  const dark = theme === "dark" || (theme === "system" && phoneDark);

  return (
    <ul className="ui-list split">
      <li className="ui-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 10, paddingBlock: 12 }}>
        <p className="ui-rt">Theme</p>
        <div className="ui-seg" role="group" aria-label="Theme">
          {THEMES.map((t) => (
            <button key={t.id} type="button" aria-pressed={theme === t.id} onClick={() => setTheme(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </li>
      <li className="ui-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 10, paddingBlock: 12 }}>
        <p className="ui-rt">Accent colour</p>
        <div className="flex items-center gap-3.5" role="group" aria-label="Accent colour">
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              type="button"
              className="ui-dot"
              aria-label={a.label}
              aria-pressed={accent === a.id}
              style={{ background: dark ? a.dark : a.light }}
              onClick={() => setAccent(a.id)}
            />
          ))}
        </div>
      </li>
    </ul>
  );
}
