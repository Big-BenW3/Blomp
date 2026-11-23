import { NextResponse } from "next/server";
import { z } from "zod";
import { applyIngest, NotFoundError } from "@/lib/ingest/apply";
import { ingestEvent } from "@/lib/ingest/schema";
import { verifySignedBody } from "@/lib/security/hmac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1_500_000; // a run_end may carry one base64 screenshot

export async function POST(req: Request) {
  const secret = process.env.INGEST_SECRET;
  if (!secret) return NextResponse.json({ error: "ingest is not configured" }, { status: 500 });

  const body = await req.text();
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "body too large" }, { status: 413 });
  }

  const ok = verifySignedBody({
    body,
    signature: req.headers.get("x-blomp-signature"),
    timestampSec: Number(req.headers.get("x-blomp-timestamp")),
    secret,
  });
  if (!ok) return NextResponse.json({ error: "invalid signature" }, { status: 401 });

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const parsed = ingestEvent.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid event", issues: z.flattenError(parsed.error) }, { status: 400 });
  }

  try {
    await applyIngest(parsed.data);
  } catch (err) {
    if (err instanceof NotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    console.error("ingest failed", err);
    return NextResponse.json({ error: "ingest failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
