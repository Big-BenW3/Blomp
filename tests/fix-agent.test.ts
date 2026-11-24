import { describe, expect, it, vi } from "vitest";
import { checkEdits, cleanPath, evidenceTerms, FixError, generateFix, pickRelevantFiles, scoreFile, type FixEvidence } from "@/lib/agent/fix";
import { LlmError } from "@/lib/agent/llm";

const evidence: FixEvidence = {
  flowName: "Checkout",
  objective: "Add a product, fill in the form and place the order, then see the order confirmation",
  oneLiner: 'The page showed "Enter a valid 16-digit card number" for a valid card',
  failingStep: "Place order click",
  rootCause: "Card validation rejects 16 digit numbers",
  consoleErrors: [],
  networkErrors: [],
};

const FILES: Record<string, string> = {
  "src/lib/validation.ts": "export function isValidCard(card: string) {\n  const digits = card.replace(/\\s/g, '');\n  return digits.length > 16;\n}\n",
  "src/app/checkout/page.tsx": "export default function Checkout() {\n  if (!isValidCard(card)) return setError('Enter a valid 16-digit card number');\n  return null;\n}\n",
  "src/app/cart/page.tsx": "export default function Cart() { return <p>Your cart</p>; }\n",
  "src/components/header.tsx": "export function Header() { return <header>Shop</header>; }\n",
  "package-lock.json": "{}",
  ".github/workflows/ci.yml": "name: ci",
  "README.md": "# shop",
};
const paths = Object.keys(FILES);
const readFile = async (p: string) => FILES[p];

describe("finding the code behind a failure", () => {
  it("pulls quoted messages and distinctive words out of the evidence", () => {
    const t = evidenceTerms(evidence);
    expect(t.phrases).toContain("enter a valid 16-digit card number");
    expect(t.words).toContain("checkout");
    expect(t.words).not.toContain("that");
  });

  it("ranks files that contain the quoted message highest", () => {
    const t = evidenceTerms(evidence);
    const checkout = scoreFile("src/app/checkout/page.tsx", FILES["src/app/checkout/page.tsx"], t);
    const cart = scoreFile("src/app/cart/page.tsx", FILES["src/app/cart/page.tsx"], t);
    expect(checkout).toBeGreaterThan(cart);
  });

  it("shows the model the checkout page and the validation file, never lockfiles or workflows", async () => {
    const picked = await pickRelevantFiles({ paths, readFile, evidence });
    const names = picked.map((f) => f.path);
    expect(names).toContain("src/app/checkout/page.tsx");
    expect(names).toContain("src/lib/validation.ts");
    expect(names).not.toContain("package-lock.json");
    expect(names).not.toContain(".github/workflows/ci.yml");
  });
});

describe("cleanPath", () => {
  it("accepts normal paths and tidies a leading ./", () => {
    expect(cleanPath("./src/a.ts")).toBe("src/a.ts");
    expect(cleanPath("src/a.ts")).toBe("src/a.ts");
  });
  it("refuses paths that could leave the repo", () => {
    for (const bad of ["../x.ts", "src/../../x.ts", "/etc/passwd", "", "a//b.ts"]) expect(cleanPath(bad)).toBeUndefined();
  });
});

describe("checkEdits", () => {
  const originals = new Map(Object.entries(FILES));
  const edit = (path: string, content: string) => ({ summary: "A fix that changes things", files: [{ path, content }] });

  it("passes a real change to a file the model was shown", () => {
    const out = checkEdits(edit("src/lib/validation.ts", "export const ok = 1;\n"), originals);
    expect(out).toEqual([{ path: "src/lib/validation.ts", content: "export const ok = 1;\n" }]);
  });

  it.each([
    ["a file it was not given", "src/other.ts", "x"],
    ["CI workflows", ".github/workflows/ci.yml", "name: hacked"],
    ["lockfiles", "package-lock.json", "{ }"],
    ["environment files", ".env", "SECRET=1"],
    ["a path outside the repo", "../escape.ts", "x"],
  ])("refuses %s", (_label, path, content) => {
    expect(() => checkEdits(edit(path, content), originals)).toThrow(FixError);
  });

  it("refuses a change that changes nothing", () => {
    expect(() => checkEdits(edit("src/lib/validation.ts", FILES["src/lib/validation.ts"]), originals)).toThrow(/unchanged/);
  });

  it("refuses a file cut down to a fragment", () => {
    const big = new Map([["src/big.ts", "x".repeat(2000)]]);
    expect(() => checkEdits(edit("src/big.ts", "x".repeat(100)), big)).toThrow(/fragment/);
  });

  it("refuses the same file twice", () => {
    const twice = { summary: "A fix that changes things", files: [{ path: "src/lib/validation.ts", content: "a" }, { path: "src/lib/validation.ts", content: "b" }] };
    expect(() => checkEdits(twice, originals)).toThrow(/twice/);
  });
});

describe("generateFix", () => {
  const good = JSON.stringify({
    summary: "The card check rejected 16 digit numbers; it now accepts exactly 16 digits.",
    files: [{ path: "src/lib/validation.ts", content: "export function isValidCard(card: string) {\n  const digits = card.replace(/\\s/g, '');\n  return digits.length === 16;\n}\n" }],
  });
  const input = (chat: (m: unknown) => Promise<string>) => ({ fullName: "a/shop", paths, readFile, evidence, chat: chat as never });

  it("returns checked edits from a good answer, even in a code fence", async () => {
    const chat = vi.fn(async () => "Here you go:\n```json\n" + good + "\n```");
    const out = await generateFix(input(chat));
    expect(out.edits).toHaveLength(1);
    expect(out.summary).toMatch(/16 digits/);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("asks again once when the first answer is not JSON", async () => {
    const chat = vi.fn().mockResolvedValueOnce("I would change the validation.").mockResolvedValueOnce(good);
    await expect(generateFix(input(chat))).resolves.toBeTruthy();
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("tells the model what the guard refused, then gives up with a clear error", async () => {
    const bad = JSON.stringify({ summary: "Edits the CI workflow to fix it.", files: [{ path: ".github/workflows/ci.yml", content: "name: x" }] });
    const chat = vi.fn(async () => bad);
    await expect(generateFix(input(chat))).rejects.toMatchObject({ kind: "bad_output" });
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("turns a model failure into a FixError", async () => {
    const chat = vi.fn(async () => {
      throw new LlmError("The model took too long to answer", "timeout");
    });
    await expect(generateFix(input(chat))).rejects.toMatchObject({ kind: "llm", message: "The model took too long to answer" });
  });

  it("says so when no file in the repo matches the failure", async () => {
    const empty = { fullName: "a/shop", paths: ["README.md"], readFile, evidence, chat: vi.fn() as never };
    await expect(generateFix(empty)).rejects.toMatchObject({ kind: "no_files" });
  });
});
