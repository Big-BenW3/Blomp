/** Appearance choices live on the device: they only change how this phone or browser looks. */
export const THEMES = [
  { id: "system", label: "Auto" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
] as const;

/** `light` / `dark` are the shades used on each canvas, so the swatch shows what the user will get. */
export const ACCENTS = [
  { id: "indigo", label: "Indigo", light: "#4f46e5", dark: "#8e91ff" },
  { id: "blue", label: "Blue", light: "#0a6cff", dark: "#6cb2ff" },
  { id: "teal", label: "Teal", light: "#0f766e", dark: "#2dd4bf" },
  { id: "pink", label: "Pink", light: "#c81e6a", dark: "#f472b6" },
  { id: "orange", label: "Orange", light: "#c2410c", dark: "#fb923c" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];
export type AccentId = (typeof ACCENTS)[number]["id"];

const THEME_KEY = "blomp-theme";
const ACCENT_KEY = "blomp-accent";
const EVENT = "blomp-appearance";

/** Runs in the page head before first paint, so a saved choice never flashes the wrong colours. */
export const APPEARANCE_BOOT_SCRIPT = `try{var d=document.documentElement,t=localStorage.getItem("${THEME_KEY}"),a=localStorage.getItem("${ACCENT_KEY}");if(t==="light"||t==="dark")d.dataset.theme=t;if(a&&a!=="indigo")d.dataset.accent=a}catch(e){}`;

export function readTheme(): ThemeId {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : "system";
}

export function readAccent(): AccentId {
  const a = document.documentElement.dataset.accent as AccentId | undefined;
  return ACCENTS.some((x) => x.id === a) ? (a as AccentId) : "indigo";
}

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode: the choice still applies until the tab closes
  }
}

/** Keeps the browser bar in step when the user overrides the phone's own setting. */
function syncThemeColor() {
  requestAnimationFrame(() => {
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    if (!bg) return;
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", bg));
  });
}

export function setTheme(theme: ThemeId) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  save(THEME_KEY, theme);
  syncThemeColor();
  window.dispatchEvent(new Event(EVENT));
}

export function setAccent(accent: AccentId) {
  const root = document.documentElement;
  if (accent === "indigo") delete root.dataset.accent;
  else root.dataset.accent = accent;
  save(ACCENT_KEY, accent);
  window.dispatchEvent(new Event(EVENT));
}

export function subscribeAppearance(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}
