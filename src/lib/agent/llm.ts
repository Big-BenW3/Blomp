export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ChatFn = (messages: ChatMessage[]) => Promise<string>;

export type LlmErrorKind = "config" | "rate_limit" | "timeout" | "http" | "empty";

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: LlmErrorKind,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

interface NvidiaOptions {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  /** Stay under the serverless function limit so we can show an error instead of a platform timeout. */
  timeoutMs?: number;
  maxTokens?: number;
}

/** Chat completions against NVIDIA NIM (OpenAI-compatible). Reads NVIDIA_API_KEY, NVIDIA_MODEL, NVIDIA_BASE_URL. */
export function createNvidiaChat(opts: NvidiaOptions = {}): ChatFn {
  const env = opts.env ?? process.env;
  const doFetch = opts.fetchImpl ?? fetch;
  return async (messages) => {
    const key = env.NVIDIA_API_KEY;
    const model = env.NVIDIA_MODEL;
    if (!key || !model) throw new LlmError("NVIDIA_API_KEY and NVIDIA_MODEL must be set", "config");
    const base = (env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/+$/, "");

    let res: Response;
    try {
      res = await doFetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.2,
          max_tokens: opts.maxTokens ?? 4096,
          stream: false,
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 50_000),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new LlmError("The model took too long to answer", "timeout");
      }
      throw new LlmError(`Could not reach the model: ${(err as Error).message}`, "http");
    }

    if (res.status === 429) throw new LlmError("The model is rate limited right now. Try again in a minute.", "rate_limit");
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new LlmError(`The model returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`, "http");
    }
    const body = (await res.json().catch(() => undefined)) as
      | { choices?: Array<{ message?: { content?: string | null } }> }
      | undefined;
    const content = body?.choices?.[0]?.message?.content;
    if (!content || !content.trim()) throw new LlmError("The model returned an empty answer", "empty");
    return content;
  };
}

/**
 * Pulls the JSON value out of a model answer. Models often wrap it in code fences, add a sentence before it, or
 * (reasoning models) prefix a <think> block, so strip those and take the first balanced object or array.
 */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "");
  const start = cleaned.search(/[{[]/);
  if (start === -1) throw new Error("no JSON found in the answer");
  const open = cleaned[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return JSON.parse(cleaned.slice(start, i + 1));
  }
  throw new Error("the JSON in the answer is cut off");
}
