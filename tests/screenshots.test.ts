import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import AdmZip from "adm-zip";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb, setDbForTesting, type Db } from "@/db";
import * as schema from "@/db/schema";
import { decodeImage, type UploadImage } from "@/lib/evidence/image";
import { applyIngest } from "@/lib/ingest/apply";
import type { IngestEvent } from "@/lib/ingest/schema";
import { readEvidence } from "../runner/evidence";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(40, 3)]);

describe("decodeImage", () => {
  it("accepts real JPEG and PNG bytes only", () => {
    expect(decodeImage(JPEG.toString("base64"))?.contentType).toBe("image/jpeg");
    expect(decodeImage(PNG.toString("base64"))?.contentType).toBe("image/png");
    expect(decodeImage(Buffer.from("<script>alert(1)</script>").toString("base64"))).toBeUndefined();
    expect(decodeImage("")).toBeUndefined();
  });
});

describe("readEvidence screenshot", () => {
  function pack(files: Record<string, Buffer>) {
    const zip = new AdmZip();
    for (const [name, data] of Object.entries(files)) zip.addFile(name, data);
    const dir = mkdtempSync(join(tmpdir(), "shots-"));
    const file = join(dir, "x.evidence");
    writeFileSync(file, zip.toBuffer());
    return file;
  }
  const t = "tests/blomp-1/steps";

  it("takes the screenshot of the step that failed", () => {
    const file = pack({
      [`${t}/1-0-1/screenshot.jpg`]: Buffer.from("first"),
      [`${t}/2-0-2/screenshot.jpg`]: Buffer.from("failing"),
      [`${t}/2-0-2/failure.yaml`]: Buffer.from("title: x\n"),
      [`${t}/10-0-10/screenshot.jpg`]: Buffer.from("last"),
    });
    expect(readEvidence(file).screenshot?.toString()).toBe("failing");
  });

  it("falls back to the last step, ordered by step number not by name", () => {
    const file = pack({
      [`${t}/2-0-2/screenshot.jpg`]: Buffer.from("two"),
      [`${t}/10-0-10/screenshot.jpg`]: Buffer.from("ten"),
    });
    expect(readEvidence(file).screenshot?.toString()).toBe("ten");
  });

  it("returns nothing when there is no screenshot or it is too big", () => {
    expect(readEvidence(pack({ "run.yaml": Buffer.from("a") })).screenshot).toBeUndefined();
    expect(readEvidence(pack({ [`${t}/1-0-1/screenshot.jpg`]: Buffer.alloc(800_000) })).screenshot).toBeUndefined();
  });
});

describe("run_end with a screenshot", () => {
  let client: PGlite;
  let scanId: string;
  let flowId: string;
  const ev = (e: Record<string, unknown>) => e as unknown as IngestEvent;

  beforeAll(async () => {
    client = new PGlite();
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "src/db/migrations" });
    setDbForTesting(db as unknown as Db);
    const d = getDb();
    const [u] = await d.insert(schema.users).values({ githubId: 5, login: "s", accessTokenEnc: "x" }).returning({ id: schema.users.id });
    const [r] = await d.insert(schema.repos).values({ userId: u.id, fullName: "s/shop" }).returning({ id: schema.repos.id });
    [{ id: flowId }] = await d.insert(schema.flows).values({ repoId: r.id, name: "Checkout", objective: "check out" }).returning({ id: schema.flows.id });
    [{ id: scanId }] = await d.insert(schema.scans).values({ repoId: r.id, trigger: "manual", targetUrl: "https://s.test" }).returning({ id: schema.scans.id });
  });
  afterAll(async () => {
    setDbForTesting(undefined);
    await client.close();
  });

  const run = () => getDb().select().from(schema.runs).where(eq(schema.runs.flowId, flowId)).then((r) => r[0]);

  it("stores a failing run's screenshot and saves its URL", async () => {
    const upload = vi.fn<UploadImage>(async () => "https://blob.test/evidence/shot.jpg");
    await applyIngest(ev({ kind: "run_end", scanId, flowId, exitCode: 1, end: { status: "failed" }, screenshot: JPEG.toString("base64") }), { uploadImage: upload });
    expect(upload).toHaveBeenCalledOnce();
    expect(upload.mock.calls[0][0]).toBe(`evidence/${scanId}/${flowId}.jpg`);
    expect((await run()).evidenceUrl).toBe("https://blob.test/evidence/shot.jpg");
  });

  it("still records the verdict when the upload fails, and ignores non-images", async () => {
    await getDb().update(schema.runs).set({ evidenceUrl: null, verdict: "pending" }).where(eq(schema.runs.flowId, flowId));
    const boom = vi.fn<UploadImage>(async () => {
      throw new Error("blob down");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await applyIngest(ev({ kind: "run_end", scanId, flowId, exitCode: 1, end: { status: "failed" }, screenshot: JPEG.toString("base64") }), { uploadImage: boom });
    expect(await run()).toMatchObject({ verdict: "fail", evidenceUrl: null });

    const notCalled = vi.fn<UploadImage>(async () => "https://blob.test/x");
    await applyIngest(ev({ kind: "run_end", scanId, flowId, exitCode: 1, end: { status: "failed" }, screenshot: Buffer.from("not an image").toString("base64") }), { uploadImage: notCalled });
    expect(notCalled).not.toHaveBeenCalled();
  });

  it("never uploads for a passing run", async () => {
    const upload = vi.fn<UploadImage>(async () => "https://blob.test/p");
    await applyIngest(ev({ kind: "run_end", scanId, flowId, exitCode: 0, end: { status: "passed" }, screenshot: JPEG.toString("base64") }), { uploadImage: upload });
    expect(upload).not.toHaveBeenCalled();
  });
});
