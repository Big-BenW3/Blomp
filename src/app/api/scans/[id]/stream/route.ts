import { z } from "zod";
import { auth } from "@/auth";
import { getScanSnapshot, getSteps, type ScanSnapshot } from "@/lib/scans/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const POLL_MS = 1000;
const KEEPALIVE_MS = 10_000;
/** Close before the platform limit; the browser reconnects by itself and the first message is a full refresh. */
const MAX_OPEN_MS = 52_000;

const finished = (s: ScanSnapshot) => s.status === "done" || s.status === "error";

/** Live scan updates as Server-Sent Events: `init` (full state), `state`, `steps` (new log lines) and `end`. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return new Response("Not found", { status: 404 });
  const userId = session.user.id;

  const first = await getScanSnapshot(userId, id.data);
  if (!first) return new Response("Not found", { status: 404 });

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const started = Date.now();
      let closed = false;
      req.signal.addEventListener("abort", () => (closed = true));

      let snapshot = first;
      let lastStepId = 0;
      const initial = await getSteps(id.data);
      if (initial.length) lastStepId = initial[initial.length - 1].id;
      send("init", { state: snapshot, steps: initial });
      let lastSent = JSON.stringify(snapshot);
      let lastPing = Date.now();

      try {
        while (!closed && !finished(snapshot) && Date.now() - started < MAX_OPEN_MS) {
          await new Promise((r) => setTimeout(r, POLL_MS));
          if (closed) break;
          const next = await getScanSnapshot(userId, id.data);
          if (!next) break;
          snapshot = next;
          const steps = await getSteps(id.data, lastStepId);
          if (steps.length) {
            lastStepId = steps[steps.length - 1].id;
            send("steps", steps);
          }
          const json = JSON.stringify(snapshot);
          if (json !== lastSent) {
            lastSent = json;
            send("state", snapshot);
          }
          if (Date.now() - lastPing > KEEPALIVE_MS) {
            controller.enqueue(enc.encode(": keepalive\n\n"));
            lastPing = Date.now();
          }
        }
        if (finished(snapshot)) send("end", {});
      } catch (err) {
        console.error("scan stream failed", err);
      } finally {
        try {
          controller.close();
        } catch {
          // already closed by the client going away
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
