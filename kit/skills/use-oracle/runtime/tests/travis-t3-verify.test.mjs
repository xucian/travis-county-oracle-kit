import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseCsvRecordSpans } from "../src/counties/travis/t3-snapshot.mjs";
import { recountCsv, verifyWindow } from "../src/counties/travis/t3-verify.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const receipt = (fields) => JSON.stringify({ method: "GET", fetched_at: "2026-10-17T16:07:17.000Z", status: 200, egress: "US", ...fields });

/**
 * A miniature window: a Socrata capture (two pages), a TDLR-style file with an unescaped quote, a TSBPE link that
 * served HTML, and the run record that summarizes them.
 *
 * @param {string} root - Window directory.
 * @param {{ tamperPage?: boolean, wrongRows?: boolean }} [options] - Faults to inject.
 */
async function writeWindow(root, { tamperPage = false, wrongRows = false } = {}) {
  const header = '"taxpayer_number","taxpayer_name"';
  const pages = [`${header}\n"1","A"\n"2","B"\n`, `${header}\n"3","C"\n`];
  const version = path.join(root, "tx-comptroller-franchise-tax", "v1792233329");
  const staging = path.join(root, "tx-comptroller-franchise-tax", "_metadata");
  await mkdir(version, { recursive: true });
  await mkdir(staging, { recursive: true });
  const metadata = JSON.stringify({ rowsUpdatedAt: 1792233329 });
  await writeFile(path.join(staging, "metadata-start.json"), metadata);
  await writeFile(path.join(staging, "receipts.jsonl"), `${receipt({ kind: "metadata", file: "metadata-start.json", bytes: metadata.length, sha256: sha256(metadata) })}\n`);
  await writeFile(path.join(version, "metadata-start.json"), metadata);
  await writeFile(path.join(version, "count.json"), JSON.stringify([{ n: "3" }]));
  const lines = [
    receipt({ kind: "metadata", file: "metadata-start.json", bytes: metadata.length, sha256: sha256(metadata), note: "copied from _metadata/metadata-start.json" }),
    receipt({ kind: "count", file: "count.json", bytes: JSON.stringify([{ n: "3" }]).length, sha256: sha256(JSON.stringify([{ n: "3" }])) }),
  ];
  for (const [index, text] of pages.entries()) {
    const file = `page-0000${index}.csv`;
    await writeFile(path.join(version, file), tamperPage && index === 1 ? text.replace('"C"', '"D"') : text);
    lines.push(receipt({ kind: "page", file, bytes: Buffer.byteLength(text), sha256: sha256(text), rows: wrongRows && index === 0 ? 3 : index === 0 ? 2 : 1 }));
  }
  await writeFile(path.join(version, "receipts.jsonl"), `${lines.join("\n")}\n`);
  await writeFile(
    path.join(version, "capture.json"),
    JSON.stringify({ dataset_id: "9cir-efmm", where: null, page_size: 2, expected_rows: 3, rows: 3, pages: 2, bytes: pages.reduce((sum, text) => sum + Buffer.byteLength(text), 0), rows_updated_at: { start: "1792233329", end: "1792233329", start_iso: "2026-10-17T10:35:29.000Z", end_iso: "2026-10-17T10:35:29.000Z" }, consistent: true }),
  );

  const tdlr = path.join(root, "tdlr-license-files", "d20261017");
  await mkdir(tdlr, { recursive: true });
  const tdlrText = '"LICENSE TYPE","LICENSE NUMBER","BUSINESS NAME"\r\n"A/C Contractor",123,"ACME "BIG" AIR"\r\n"A/C Contractor",124,"PLAIN AIR"\r\n';
  await writeFile(path.join(tdlr, "ltairref.csv"), tdlrText);
  await writeFile(path.join(tdlr, "receipts.jsonl"), `${receipt({ kind: "file", file: "ltairref.csv", bytes: Buffer.byteLength(tdlrText), sha256: sha256(tdlrText), rows: 2, content_type: "application/octet-stream" })}\n`);

  const tsbpe = path.join(root, "tsbpe-responsible-master-plumber", "d20261017");
  await mkdir(tsbpe, { recursive: true });
  const html = "<html><body>\nResponsible Master Plumber\n</body></html>\n";
  await writeFile(path.join(tsbpe, "responsible-master-plumber-page.csv"), html);
  await writeFile(path.join(tsbpe, "receipts.jsonl"), `${receipt({ kind: "file", file: "responsible-master-plumber-page.csv", bytes: html.length, sha256: sha256(html), rows: 2, content_type: "text/html; charset=UTF-8" })}\n`);

  await mkdir(path.join(root, "runs"), { recursive: true });
  await writeFile(
    path.join(root, "runs", "20261017T160716Z.json"),
    JSON.stringify({
      started_at: "2026-10-17T16:07:16.568Z",
      finished_at: "2026-10-17T16:10:06.911Z",
      seconds: 170,
      egress: "US at every check",
      egress_checks: 5,
      requests: 5,
      counts: { ok: 2, failed: 1 },
      exit_code: 1,
      sources: [
        { key: "tx-comptroller-franchise-tax", status: "ok", rows: 3, bytes: pages.reduce((sum, text) => sum + Buffer.byteLength(text), 0) },
        { key: "tdlr-license-files", status: "ok", rows: 2, bytes: Buffer.byteLength(tdlrText), detail: { files: [{ file: "ltairref.csv", link_text: "Airconditioning Contractors", rows: 2, bytes: Buffer.byteLength(tdlrText) }] } },
        { key: "tsbpe-responsible-master-plumber", status: "failed", rows: 2, bytes: html.length, detail: { error: "the link returned HTML, not a CSV" } },
      ],
    }),
  );
}

describe("T3 CSV dialects", () => {
  it("reads unescaped quotes inside quoted values only under the unescaped-quotes dialect", () => {
    const text = '"a","b"\r\n"ACME "BIG" AIR","x"\r\n""LEAD" CO","END""\r\n"plain",""\r\n';
    expect(() => [...parseCsvRecordSpans(text)]).toThrow(/unexpected character/);
    const records = [...parseCsvRecordSpans(text, { dialect: "unescaped-quotes" })];
    expect(records.map((record) => record.fields.map((field) => field.value))).toEqual([
      ["a", "b"],
      ['ACME "BIG" AIR', "x"],
      ['"LEAD" CO', 'END"'],
      ["plain", ""],
    ]);
    expect(records.map((record) => record.lenient)).toEqual([false, true, true, false]);
  });

  it("gives the same records as RFC 4180 for valid RFC 4180 input", () => {
    const text = '"x ""q""","line1\nline2"\r\n,"  "\n"""","a"\n';
    const strict = [...parseCsvRecordSpans(text)];
    const lenient = [...parseCsvRecordSpans(text, { dialect: "unescaped-quotes" })];
    expect(lenient.map((record) => record.fields)).toEqual(strict.map((record) => record.fields));
    expect(lenient.every((record) => record.lenient === false)).toBe(true);
  });

  it("recounts rows with the capture counter and the parser", () => {
    expect(recountCsv(Buffer.from('"a"\n"1"\n"2"\n'))).toMatchObject({ counter_rows: 2, parsed_rows: 2, width_mismatches: 0 });
    expect(recountCsv(Buffer.from('"a","b"\n"1"\n'))).toMatchObject({ parsed_rows: 1, width_mismatches: 1 });
  });
});

describe("T3 window verification", () => {
  it("passes an intact window and classes an HTML body under a .csv name as not CSV", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-verify-"));
    try {
      await writeWindow(root);
      const report = await verifyWindow({ windowDir: root, runStamp: "20261017T160716Z" });
      expect(report.mismatches).toEqual([]);
      expect(report.ok).toBe(true);
      const franchise = report.sources.find((source) => source.key === "tx-comptroller-franchise-tax");
      expect(franchise).toMatchObject({ rows_parsed: 3, run_record_matches: true });
      expect(franchise.socrata[0]).toMatchObject({ count_json: 3, expected_rows: 3, captured_rows: 3, version_unchanged: true });
      const tdlr = report.sources.find((source) => source.key === "tdlr-license-files");
      expect(tdlr.files).toEqual([expect.objectContaining({ file: "ltairref.csv", rows: 2, matches_run_record: true })]);
      const tsbpe = report.sources.find((source) => source.key === "tsbpe-responsible-master-plumber");
      expect(tsbpe).toMatchObject({ not_csv_files: ["responsible-master-plumber-page.csv"], rows_parsed: 0, run_record_matches: true });
      const copied = report.receipt_logs.flatMap((log) => log.files).find((file) => file.copied_from);
      expect(copied.copy_matches_staging).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a file whose bytes differ from its receipt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-verify-"));
    try {
      await writeWindow(root, { tamperPage: true });
      const report = await verifyWindow({ windowDir: root, runStamp: "20261017T160716Z" });
      expect(report.ok).toBe(false);
      expect(report.mismatches.some((line) => /page-00001\.csv: sha256/.test(line))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a receipt whose row count differs from the file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-verify-"));
    try {
      await writeWindow(root, { wrongRows: true });
      const report = await verifyWindow({ windowDir: root, runStamp: "20261017T160716Z" });
      expect(report.ok).toBe(false);
      expect(report.mismatches.some((line) => /page-00000\.csv: full parse finds 2 rows, receipt says 3/.test(line))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("verifies a later TSBPE re-run against its own file, with the earlier HTML page beside it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-verify-rerun-"));
    try {
      await writeWindow(root);
      const tsbpe = path.join(root, "tsbpe-responsible-master-plumber", "d20261017");
      const csv = '"License Number","Name","Company"\n"RMP-1","PAT PLUMBER","PIPES LLC"\n';
      await writeFile(path.join(tsbpe, "responsible-master-plumber-RMP.csv"), csv);
      const log = path.join(tsbpe, "receipts.jsonl");
      await appendFile(log, `${receipt({ kind: "file", file: "responsible-master-plumber-RMP.csv", fetched_at: "2026-10-18T10:00:01.000Z", bytes: Buffer.byteLength(csv), sha256: sha256(csv), rows: 1, content_type: "text/csv" })}\n`);
      expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(2);
      await writeFile(
        path.join(root, "runs", "20261018T100000Z.json"),
        JSON.stringify({ started_at: "2026-10-18T10:00:00.000Z", finished_at: "2026-10-18T10:00:03.000Z", seconds: 3, egress: "US at every check", egress_checks: 3, requests: 2, counts: { ok: 1, failed: 0 }, exit_code: 0, sources: [{ key: "tsbpe-responsible-master-plumber", status: "ok", rows: 1, bytes: Buffer.byteLength(csv), detail: { capture: path.relative(path.join(path.dirname(new URL(import.meta.url).pathname), ".."), tsbpe), file: "responsible-master-plumber-RMP.csv" } }] }),
      );
      const report = await verifyWindow({ windowDir: root, runStamp: "20261018T100000Z" });
      expect(report.mismatches).toEqual([]);
      const source = report.sources.find((entry) => entry.key === "tsbpe-responsible-master-plumber");
      expect(source).toMatchObject({ rows_parsed: 1, bytes: Buffer.byteLength(csv), not_csv_files: [], run_record_matches: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
