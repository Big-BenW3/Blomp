import { DiscoveryError } from "@/lib/agent/discover";
import { LlmError } from "@/lib/agent/llm";

/** GitHub answers 403 both for "no access" and for "too many requests"; the headers and message tell them apart. */
export function isRateLimited(err: unknown): boolean {
  const e = err as { message?: string; response?: { headers?: Record<string, string | undefined> } } | null;
  if (!e || typeof e !== "object") return false;
  const headers = e.response?.headers;
  return headers?.["x-ratelimit-remaining"] === "0" || headers?.["retry-after"] !== undefined || /rate limit|abuse/i.test(e.message ?? "");
}

/** Turns anything thrown while reading a repo or asking the model into one sentence a person can act on. */
export function friendlyError(err: unknown): string {
  if (err instanceof DiscoveryError || err instanceof LlmError) {
    if (/NVIDIA_API_KEY/.test(err.message)) {
      return "The AI model is not set up yet. Add NVIDIA_API_KEY and NVIDIA_MODEL in Vercel, then redeploy.";
    }
    return err.message;
  }
  const status = typeof err === "object" && err !== null ? (err as { status?: number }).status : undefined;
  if (status === 401) return "GitHub says your sign-in expired. Sign out from Profile and sign in again.";
  if (status === 429 || (status === 403 && isRateLimited(err))) return "GitHub is limiting requests right now. Try again in a minute.";
  if (status === 403) return "GitHub would not let Blomp read this repo. If it belongs to an organization, ask an owner to approve the Blomp app, then try again.";
  if (status === 404) return "GitHub cannot see this repo with your sign-in.";
  // GitHub answers 409 "Git Repository is empty" when a repo has no commits yet.
  if (status !== undefined && status >= 500) return "GitHub is having trouble right now. Try again in a minute.";
  if (status === 409) return "This repo is empty. Push your site's code to it first, then try again.";
  return "Something went wrong. Try again.";
}
