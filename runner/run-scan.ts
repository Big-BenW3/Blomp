/**
 * Entry point for the GitHub Actions job. Reads the scan from env, runs Kane once per flow and
 * posts each event to the Blomp app. With no INGEST_URL it only prints events (dry run), which is
 * how you prove Kane works before the database exists.
 */
import { z } from "zod";
import { signBody } from "../src/lib/security/hmac";
import type { IngestEventInput } from "../src/lib/ingest/schema";
import { runScan } from "./lib";

const flowsSchema = z
  .array(z.object({ id: z.string().min(1), name: z.string(), objective: z.string().min(1).max(1000), path: z.string() }))
  .min(1)
  .max(5);

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

async function postWithRetry(url: string, secret: string, event: IngestEventInput): Promise<void> {
  const body = JSON.stringify(event);
  for (let attempt = 0; ; attempt++) {
    const ts = Math.floor(Date.now() / 1000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-blomp-timestamp": String(ts),
          "x-blomp-signature": signBody(body, secret, ts),
        },
        body,
      });
      if (res.ok) return;
      // 4xx will not fix itself on retry (bad signature, unknown scan); only retry server errors.
      if (res.status < 500 || attempt >= 3) throw new Error(`ingest ${event.kind} failed: HTTP ${res.status}`);
    } catch (err) {
      if (attempt >= 3) throw err;
    }
    await new Promise((r) => setTimeout(r, 500 * 3 ** attempt));
  }
}

async function main() {
  const scanId = required("SCAN_ID");
  const targetUrl = required("TARGET_URL");
  const flows = flowsSchema.parse(JSON.parse(required("FLOWS_JSON")));
  const ingestUrl = process.env.INGEST_URL;
  const secret = process.env.INGEST_SECRET;

  const post = async (event: IngestEventInput) => {
    if (!ingestUrl || !secret) {
      console.log(`[dry-run] ${JSON.stringify(event)}`);
      return;
    }
    await postWithRetry(ingestUrl, secret, event);
  };

  await runScan({
    scanId,
    targetUrl,
    flows,
    post,
    workflowRunId: process.env.GITHUB_RUN_ID ? Number(process.env.GITHUB_RUN_ID) : undefined,
    log: (m) => console.log(`[blomp] ${m}`),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
