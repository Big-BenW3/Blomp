import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signBody, verifyGithubSignature, verifySignedBody } from "@/lib/security/hmac";

const SECRET = "shared-secret-for-tests";
const NOW = 1_800_000_000;
const nowMs = NOW * 1000;

describe("signed runner posts", () => {
  const body = '{"kind":"scan_end"}';

  it("accepts a fresh, correct signature", () => {
    const sig = signBody(body, SECRET, NOW);
    expect(verifySignedBody({ body, signature: sig, timestampSec: NOW, secret: SECRET, nowMs })).toBe(true);
  });

  it("rejects a tampered body, wrong secret and missing signature", () => {
    const sig = signBody(body, SECRET, NOW);
    expect(verifySignedBody({ body: body + " ", signature: sig, timestampSec: NOW, secret: SECRET, nowMs })).toBe(false);
    expect(verifySignedBody({ body, signature: sig, timestampSec: NOW, secret: "other-secret-value", nowMs })).toBe(false);
    expect(verifySignedBody({ body, signature: null, timestampSec: NOW, secret: SECRET, nowMs })).toBe(false);
  });

  it("rejects replays outside the 5 minute window", () => {
    const sig = signBody(body, SECRET, NOW);
    expect(verifySignedBody({ body, signature: sig, timestampSec: NOW, secret: SECRET, nowMs: nowMs + 301_000 })).toBe(false);
    expect(verifySignedBody({ body, signature: sig, timestampSec: NOW, secret: SECRET, nowMs: nowMs + 299_000 })).toBe(true);
  });

  it("rejects a signature of the wrong length without throwing", () => {
    expect(verifySignedBody({ body, signature: "sha256=abc", timestampSec: NOW, secret: SECRET, nowMs })).toBe(false);
  });

  it("rejects a timestamp that is not a number", () => {
    expect(verifySignedBody({ body, signature: "x", timestampSec: Number("nope"), secret: SECRET, nowMs })).toBe(false);
  });
});

describe("GitHub webhook signature", () => {
  const body = '{"zen":"Keep it logically awesome."}';
  const good = "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");

  it("verifies GitHub's header format", () => {
    expect(verifyGithubSignature(body, good, SECRET)).toBe(true);
  });
  it("rejects bad or missing headers", () => {
    expect(verifyGithubSignature(body, good.replace(/.$/, "0"), SECRET)).toBe(false);
    expect(verifyGithubSignature(body, null, SECRET)).toBe(false);
    expect(verifyGithubSignature(body + "x", good, SECRET)).toBe(false);
  });
});
