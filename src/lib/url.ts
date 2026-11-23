/**
 * Normalizes a site URL typed by a user (or read from GitHub) into something Kane can open from GitHub's cloud
 * runners: http(s) only, no credentials, a public-looking host. Returns undefined when it is not usable.
 * Query strings and fragments are dropped; the result has no trailing slash.
 */
export function normalizeSiteUrl(input: string | null | undefined): string | undefined {
  const raw = (input ?? "").trim();
  if (!raw || raw.length > 2048) return undefined;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username || url.password) return undefined;
  if (!isPublicHost(url.hostname)) return undefined;
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

function isPublicHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (h.startsWith("[")) return false; // IPv6 literals are never what a deployed site looks like
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 192 && b === 168)) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    return true;
  }
  return h.includes(".");
}
