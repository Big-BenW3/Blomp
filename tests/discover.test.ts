import { describe, expect, it, vi } from "vitest";
import {
  DiscoveryError,
  discoverFlows,
  pickKeyFiles,
  proposalSchema,
} from "@/lib/agent/discover";
import { createNvidiaChat, extractJson, LlmError, type ChatFn } from "@/lib/agent/llm";

const flow = (name: string, path = "/") => ({
  name,
  objective: `Open the page and check that ${name} works and a confirmation is visible`,
  path,
});
const good = { flows: [flow("Sign up", "/signup"), flow("Log in", "/login"), flow("Checkout", "/checkout")] };

describe("proposalSchema", () => {
  it("accepts 3 to 5 flows", () => {
    expect(proposalSchema.safeParse(good).success).toBe(true);
    expect(proposalSchema.safeParse({ flows: [...good.flows, flow("Search"), flow("Profile")] }).success).toBe(true);
  });

  it("rejects too few, too many, duplicates, bad paths and over-long text", () => {
    expect(proposalSchema.safeParse({ flows: good.flows.slice(0, 2) }).success).toBe(false);
    expect(proposalSchema.safeParse({ flows: [...good.flows, flow("A1x"), flow("B2x"), flow("C3x")] }).success).toBe(false);
    expect(proposalSchema.safeParse({ flows: [good.flows[0], good.flows[0], good.flows[1]] }).success).toBe(false);
    expect(proposalSchema.safeParse({ flows: [{ ...good.flows[0], path: "signup" }, ...good.flows.slice(1)] }).success).toBe(false);
    expect(proposalSchema.safeParse({ flows: [{ ...good.flows[0], path: "/a b" }, ...good.flows.slice(1)] }).success).toBe(false);
    expect(
      proposalSchema.safeParse({ flows: [{ ...good.flows[0], objective: "x".repeat(401) }, ...good.flows.slice(1)] }).success,
    ).toBe(false);
  });
});

describe("extractJson", () => {
  it("reads plain JSON, fenced JSON, and JSON after prose or a think block", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here you go:\n{"a":{"b":[1,2]}} hope that helps')).toEqual({ a: { b: [1, 2] } });
    expect(extractJson('<think>maybe {"x":1}?</think>{"a":2}')).toEqual({ a: 2 });
  });

  it("is not fooled by braces inside strings", () => {
    expect(extractJson('{"a":"} not the end {","b":1}')).toEqual({ a: "} not the end {", b: 1 });
  });

  it("throws on answers with no JSON or cut-off JSON", () => {
    expect(() => extractJson("no json here")).toThrow();
    expect(() => extractJson('{"a":[1,2')).toThrow(/cut off/);
  });
});

describe("pickKeyFiles", () => {
  const paths = [
    "package.json",
    "package-lock.json",
    "README.md",
    "node_modules/x/index.js",
    "public/logo.svg",
    ".github/workflows/ci.yml",
    "src/app/layout.tsx",
    "src/app/page.tsx",
    "src/app/signup/page.tsx",
    "src/app/checkout/page.tsx",
    "src/app/api/cart/route.ts",
    "src/app/deep/er/est/page.tsx",
    "tests/a.test.ts",
    "docs/notes.txt",
  ];

  it("keeps manifest, readme and routes; drops locks, build folders and tests", () => {
    const picked = pickKeyFiles(paths);
    expect(picked[0]).toBe("package.json");
    expect(picked).toContain("README.md");
    expect(picked).toContain("src/app/signup/page.tsx");
    expect(picked).toContain("src/app/api/cart/route.ts");
    for (const bad of ["package-lock.json", "node_modules/x/index.js", "public/logo.svg", ".github/workflows/ci.yml", "tests/a.test.ts", "docs/notes.txt"]) {
      expect(picked).not.toContain(bad);
    }
  });

  it("ranks shallow pages ahead of deep ones and never returns more than 14", () => {
    const picked = pickKeyFiles(paths);
    expect(picked.indexOf("src/app/page.tsx")).toBeLessThan(picked.indexOf("src/app/deep/er/est/page.tsx"));
    const many = Array.from({ length: 60 }, (_, i) => `src/app/p${i}/page.tsx`);
    expect(pickKeyFiles(many).length).toBe(14);
  });

  it("returns nothing for a repo with no web files", () => {
    expect(pickKeyFiles(["main.go", "go.mod", "docs/a.md"])).toEqual([]);
  });
});

describe("discoverFlows", () => {
  const base = {
    fullName: "me/shop",
    prodUrl: "https://shop.test",
    paths: ["package.json", "src/app/page.tsx"],
    readFile: async (p: string) => `// contents of ${p}`,
  };

  it("returns validated flows on a good first answer", async () => {
    const chat: ChatFn = vi.fn(async () => JSON.stringify(good));
    const flows = await discoverFlows({ ...base, chat });
    expect(flows.map((f) => f.name)).toEqual(["Sign up", "Log in", "Checkout"]);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("sends the repo's files and the live URL to the model", async () => {
    const chat = vi.fn<ChatFn>(async () => JSON.stringify(good));
    await discoverFlows({ ...base, chat });
    const prompt = chat.mock.calls[0][0].map((m) => m.content).join("\n");
    expect(prompt).toContain("me/shop");
    expect(prompt).toContain("https://shop.test");
    expect(prompt).toContain("// contents of src/app/page.tsx");
  });

  it("retries once with the problem spelled out, then succeeds", async () => {
    const chat = vi
      .fn<ChatFn>()
      .mockResolvedValueOnce("I think you should test login.")
      .mockResolvedValueOnce("```json\n" + JSON.stringify(good) + "\n```");
    const flows = await discoverFlows({ ...base, chat });
    expect(flows).toHaveLength(3);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[1][0].at(-1)?.content).toMatch(/not usable/);
  });

  it("fails loudly after two bad answers", async () => {
    const chat = vi.fn<ChatFn>(async () => JSON.stringify({ flows: [flow("Only one")] }));
    await expect(discoverFlows({ ...base, chat })).rejects.toMatchObject({ name: "DiscoveryError", kind: "bad_output" });
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("turns model outages into a DiscoveryError without retrying", async () => {
    const chat = vi.fn<ChatFn>(async () => {
      throw new LlmError("rate limited", "rate_limit");
    });
    await expect(discoverFlows({ ...base, chat })).rejects.toMatchObject({ kind: "llm", message: "rate limited" });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("refuses repos with no pages instead of asking the model to guess", async () => {
    const chat = vi.fn<ChatFn>();
    await expect(discoverFlows({ ...base, paths: ["main.go"], chat })).rejects.toBeInstanceOf(DiscoveryError);
    expect(chat).not.toHaveBeenCalled();
  });

  it("caps how much source is sent", async () => {
    const chat = vi.fn<ChatFn>(async () => JSON.stringify(good));
    const paths = Array.from({ length: 30 }, (_, i) => `src/app/p${i}/page.tsx`);
    await discoverFlows({ ...base, paths, readFile: async () => "x".repeat(20_000), chat });
    const sent = chat.mock.calls[0][0].map((m) => m.content).join("");
    expect(sent.length).toBeLessThan(60_000);
  });
});

describe("createNvidiaChat", () => {
  const env = { NVIDIA_API_KEY: "k", NVIDIA_MODEL: "moonshotai/kimi-k3.1-pro" };
  const ok = (content: unknown) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

  it("posts to the NIM chat endpoint with the configured model and key", async () => {
    const fetchImpl = vi.fn(async () => ok("hello")) as unknown as typeof fetch;
    const answer = await createNvidiaChat({ env, fetchImpl })([{ role: "user", content: "hi" }]);
    expect(answer).toBe("hello");
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "moonshotai/kimi-k3.1-pro", stream: false });
  });

  it("honours a custom base URL", async () => {
    const fetchImpl = vi.fn(async () => ok("x")) as unknown as typeof fetch;
    await createNvidiaChat({ env: { ...env, NVIDIA_BASE_URL: "https://nim.example.com/v1/" }, fetchImpl })([]);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("https://nim.example.com/v1/chat/completions");
  });

  it("reports missing config, rate limits, server errors, empty answers and timeouts", async () => {
    await expect(createNvidiaChat({ env: {} })([])).rejects.toMatchObject({ kind: "config" });
    const status = (s: number) => createNvidiaChat({ env, fetchImpl: (async () => new Response("nope", { status: s })) as typeof fetch })([]);
    await expect(status(429)).rejects.toMatchObject({ kind: "rate_limit" });
    await expect(status(500)).rejects.toMatchObject({ kind: "http" });
    await expect(createNvidiaChat({ env, fetchImpl: (async () => ok("  ")) as typeof fetch })([])).rejects.toMatchObject({ kind: "empty" });
    await expect(createNvidiaChat({ env, fetchImpl: (async () => ok(null)) as typeof fetch })([])).rejects.toMatchObject({ kind: "empty" });
    const timeout = (async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    await expect(createNvidiaChat({ env, fetchImpl: timeout })([])).rejects.toMatchObject({ kind: "timeout" });
  });
});
