import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { ScanView } from "@/components/scan-view";
import { requireUserId } from "@/lib/repos/load";
import { getScanSnapshot, getSteps } from "@/lib/scans/queries";

export const dynamic = "force-dynamic";

export default async function ScanPage({ params }: { params: Promise<{ owner: string; repo: string; scanId: string }> }) {
  const { owner, repo, scanId } = await params;
  const id = z.uuid().safeParse(scanId);
  if (!id.success) notFound();
  const userId = await requireUserId();

  const state = await getScanSnapshot(userId, id.data);
  if (!state) notFound();
  const [canonicalOwner, canonicalName] = state.repoFullName.split("/");
  if (canonicalOwner !== owner || canonicalName !== repo) redirect(`/repos/${canonicalOwner}/${canonicalName}/scans/${state.id}`);

  const steps = await getSteps(state.id);
  return <ScanView key={state.id} initial={{ state, steps }} owner={canonicalOwner} name={canonicalName} />;
}
