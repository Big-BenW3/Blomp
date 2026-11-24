import { verifyGithubSignature } from "@/lib/security/hmac";
import { handleGithubEvent } from "@/lib/fixes/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GitHub deployment events. Signed with WEBHOOK_SECRET; unsigned or wrongly signed calls are refused. */
export async function POST(req: Request) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return new Response("Webhooks are not set up", { status: 503 });

  const body = await req.text();
  if (!verifyGithubSignature(body, req.headers.get("x-hub-signature-256"), secret)) {
    return new Response("Bad signature", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  try {
    const outcome = await handleGithubEvent(req.headers.get("x-github-event"), payload);
    return Response.json({ ok: true, outcome });
  } catch (err) {
    console.error("github webhook failed", err);
    return new Response("Could not handle the event", { status: 500 });
  }
}
