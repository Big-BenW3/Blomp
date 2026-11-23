import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { findEvidencePack, readEvidence } from "../runner/evidence";
import { isAppIssue } from "@/lib/ingest/triage";

const fixture = (n: string) => readFileSync(join(__dirname, "fixtures/kane", n), "utf8");

/** Mirrors the layout of a real kane-cli 0.10.8 `.evidence` pack (a zip of tests/<name>/steps/N-0-N/...). */
function pack(failureYaml: string, har: unknown) {
  const zip = new AdmZip();
  const t = "tests/blomp-11111111-f1-d45d91c4";
  zip.addFile("run.yaml", Buffer.from("status: finalized\n"));
  zip.addFile(`${t}/steps/1-0-1/step.json`, Buffer.from("{}"));
  zip.addFile(`${t}/steps/4-0-4/failure.yaml`, Buffer.from(failureYaml));
  zip.addFile(`${t}/logs/0-console.ndjson`, Buffer.from(""));
  zip.addFile(`${t}/logs/0-network.har`, Buffer.from(JSON.stringify(har)));
  const dir = mkdtempSync(join(tmpdir(), "evidence-"));
  const file = join(dir, "abc.evidence");
  writeFileSync(file, zip.toBuffer());
  return { dir, file };
}

const har = (entries: Array<[string, string, number]>) => ({
  log: { entries: entries.map(([method, url, status]) => ({ request: { method, url }, response: { status } })) },
});

describe("readEvidence on a real-shaped pack", () => {
  it("reads Kane's triage and flags an app issue", () => {
    const { file } = pack(fixture("real-failure-app-issue.yaml"), har([["GET", "https://example.com/", 200]]));
    const ev = readEvidence(file);
    expect(ev.triage).toMatchObject({
      title: "Example Domain heading is missing",
      category: "application_issue/ui_data_defect",
      severity: "minor",
      confidence: 0.96,
    });
    expect(ev.triage?.rootCause).toContain("main heading says something different"); // folded YAML collapsed to one line
    expect(ev.triage?.errorMessage).toContain("Final verification failed");
    expect(isAppIssue(ev.triage)).toBe(true);
  });

  it("tells a broken flow apart from an app bug", () => {
    const { file } = pack(fixture("real-failure-config-issue.yaml"), har([]));
    const ev = readEvidence(file);
    expect(ev.triage?.category).toBe("automation_bug/config_issue");
    expect(isAppIssue(ev.triage)).toBe(false);
  });

  it("extracts failed requests from the HAR and ignores good ones", () => {
    const { file } = pack(
      fixture("real-failure-app-issue.yaml"),
      har([
        ["GET", "https://shop.test/", 200],
        ["POST", "https://shop.test/api/checkout", 500],
        ["GET", "https://shop.test/missing.js", 404],
      ]),
    );
    expect(readEvidence(file).networkErrors).toEqual([
      "POST https://shop.test/api/checkout -> 500",
      "GET https://shop.test/missing.js -> 404",
    ]);
  });

  it("finds the pack inside a Kane session folder and survives a pack with no failure file", () => {
    const { dir, file } = pack("", har([]));
    expect(findEvidencePack(dir)).toBe(file);
    expect(readEvidence(file).triage).toBeUndefined();
  });
});
