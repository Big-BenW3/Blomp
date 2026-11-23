import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "sha256=";

function hex(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Signature for runner -> app posts. Signs `${timestamp}.${body}` so a captured request cannot be replayed later. */
export function signBody(body: string, secret: string, timestampSec: number): string {
  return PREFIX + hex(`${timestampSec}.${body}`, secret);
}

export function verifySignedBody(opts: {
  body: string;
  signature: string | null;
  timestampSec: number;
  secret: string;
  nowMs?: number;
  toleranceSec?: number;
}): boolean {
  const { body, signature, timestampSec, secret } = opts;
  if (!signature || !Number.isFinite(timestampSec) || !secret) return false;
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSec - timestampSec) > (opts.toleranceSec ?? 300)) return false;
  return safeEqual(signature, signBody(body, secret, timestampSec));
}

/** GitHub webhooks: header `X-Hub-Signature-256: sha256=<hmac of the raw body>`. */
export function verifyGithubSignature(body: string, header: string | null, secret: string): boolean {
  if (!header || !secret) return false;
  return safeEqual(header, PREFIX + hex(body, secret));
}
