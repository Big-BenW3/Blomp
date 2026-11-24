import { z } from "zod";
import { auth } from "@/auth";
import { getFixView } from "@/lib/fixes/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The fix's current state, polled by the run screen while a fix is being written or re-checked. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return new Response("Not found", { status: 404 });
  const fix = await getFixView(session.user.id, id.data);
  if (!fix) return new Response("Not found", { status: 404 });
  return Response.json(fix, { headers: { "cache-control": "no-store" } });
}
