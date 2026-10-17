import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ParquetReader } from "@dsnp/parquetjs";

import { NORMALIZER_VERSION, loadSnapshot, normalizeRecord, parseCsvRecordSpans, readCaptureReceipts, verifyCapture } from "../src/counties/travis/t3-snapshot.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const HEADER = '"taxpayer_number","taxpayer_name","taxpayer_county_code","sos_status_code","sos_status_date","exempt_begin_date","_621111"';

/**
 * Write a capture: CSV pages plus receipts in the shape the Comptroller cache and t3-fetch write.
 *
 * @param {string} dir - Capture directory.
 * @param {string[][]} pages - Data lines per page (header added).
 * @param {number} pageSize - Rows per page (for `$offset`).
 */
async function writeCapture(dir, pages, pageSize = 3) {
  await mkdir(dir, { recursive: true });
  const receipts = [];
  for (const [index, lines] of pages.entries()) {
    const file = `page-${String(index).padStart(3, "0")}.csv`;
    const text = `${HEADER}\n${lines.join("\n")}\n`;
    await writeFile(path.join(dir, file), text);
    receipts.push({
      file,
      method: "GET",
      url: `https://data.texas.gov/resource/9cir-efmm.csv?%24where=taxpayer_county_code%3D%27227%27&%24order=%3Aid&%24limit=${pageSize}&%24offset=${index * pageSize}`,
      fetched_at: "2026-10-16T18:16:14Z",
      status: 200,
      bytes: Buffer.byteLength(text),
      sha256: sha256(text),
      rows: lines.length,
      egress: "US",
    });
  }
  await writeFile(path.join(dir, "receipts.jsonl"), receipts.map((receipt) => JSON.stringify(receipt)).join("\n") + "\n");
}

const ROWS = [
  '"10000000001 ","ACME ROOFING, L.L.C. ","227","A ","2001-12-07T00:00:00.000",,"238160 "',
  '"10000000002 ","LONE STAR ROOFING INC ","227","  ","2002-01-10T00:00:00.000",,"  "',
  '"10000000003 ","Quote ""Inc"" Holdings\nSecond line ","227","A ","2003-01-01T00:00:00.000","2003-02-01T00:00:00.000","  "',
  '"10000000004 ","TWIN ROW HOLDINGS LP ","227","A ","2001-03-30T00:00:00.000",,"531190 "',
  '"10000000004 ","TWIN ROW HOLDINGS LP ","227","R ","2003-10-13T00:00:00.000",,"531190 "',
];

describe("T3 snapshot normalizer", () => {
  it("parses RFC 4180 records with exact spans, quotes, embedded newlines, CRLF and a BOM", () => {
    const text = `﻿"a","b"\r\n"x ""q""","line1\nline2"\r\n,"  "\n`;
    const records = [...parseCsvRecordSpans(text)];
    expect(records.map((record) => record.fields)).toEqual([
      [
        { value: "a", quoted: true },
        { value: "b", quoted: true },
      ],
      [
        { value: 'x "q"', quoted: true },
        { value: "line1\nline2", quoted: true },
      ],
      [
        { value: "", quoted: false },
        { value: "  ", quoted: true },
      ],
    ]);
    expect(text.slice(records[1].start, records[1].end)).toBe('"x ""q""","line1\nline2"');
    expect(() => [...parseCsvRecordSpans('"open')]).toThrow(/unterminated/);
  });

  it("keeps every value as printed beside its trimmed value; an unquoted empty cell is null", () => {
    const row = normalizeRecord(["a", "b", "c", "_621111"], [
      { value: "A ", quoted: true },
      { value: "  ", quoted: true },
      { value: "", quoted: false },
      { value: "531190 ", quoted: true },
    ]);
    expect(row).toEqual({ a: "A ", a__trimmed: "A", b: "  ", b__trimmed: null, c: null, c__trimmed: null, _621111: "531190 ", _621111__trimmed: "531190" });
  });

  it("refuses a capture whose bytes differ from the receipt", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "t3-capture-"));
    try {
      await writeCapture(path.join(dir, "capture"), [ROWS.slice(0, 2)]);
      await writeFile(path.join(dir, "capture", "page-000.csv"), `${HEADER}\n${ROWS[0]}\n`);
      const receipts = await readCaptureReceipts(path.join(dir, "capture"));
      await expect(verifyCapture(path.join(dir, "capture"), receipts)).rejects.toThrow(/does not match its receipt/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loads deterministically, re-loads as a no-op, and merges a changed capture with tombstones", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "t3-snapshot-"));
    try {
      const capture = path.join(dir, "capture-1");
      await writeCapture(capture, [ROWS.slice(0, 3), ROWS.slice(3)]);
      const output = path.join(dir, "registry");
      const params = { sourceKey: "tx-comptroller-franchise-tax", captureDir: capture, outputDir: output, name: "franchise-travis", scopeLabel: "test", now: "2026-10-17T00:00:00.000Z" };

      const first = await loadSnapshot(params);
      expect(first.counts).toMatchObject({ rows: 5, distinct_keys: 4, duplicate_keys: 1, rows_under_duplicate_keys: 2 });
      expect(first.counts.present_non_blank).toMatchObject({ taxpayer_number: 5, sos_status_code: 4, exempt_begin_date: 1, _621111: 3 });
      expect(first.counts.distributions.sos_status_code).toEqual({ A: 3, "(null)": 1, R: 1 });
      expect(first.duplicates).toHaveLength(1);
      expect(first.duplicates[0]).toMatchObject({ rows: 2, differing_columns: ["sos_status_code", "sos_status_date"], differing_values: [{ sos_status_code: "A", sos_status_date: "2001-03-30T00:00:00.000" }, { sos_status_code: "R", sos_status_date: "2003-10-13T00:00:00.000" }] });
      expect(first.duplicates[0].locations).toEqual([
        { file: "page-001.csv", row_index: 0, offset: 3 },
        { file: "page-001.csv", row_index: 1, offset: 4 },
      ]);
      expect(first).toMatchObject({ merged: true, diff: { new: 4, changed: 0, unchanged: 0, removed: 0 }, normalizer_version: NORMALIZER_VERSION });
      expect(first.watermark).toMatchObject({ track: "registry", merged_count: 2, merged_rows: 5, last_merged_at: "2026-10-17T00:00:00.000Z" });
      expect(first.names).toMatchObject({ non_unique_names: 0, entity_keys: 4 });

      // The Parquet keeps the printed and trimmed values, `_621111` included, and the capture provenance per row.
      const reader = await ParquetReader.openFile(path.join(output, "franchise-travis.parquet"));
      try {
        const fields = Object.keys(reader.getSchema().fields);
        expect(fields).toEqual(expect.arrayContaining(["_621111", "_621111__trimmed", "taxpayer_name", "taxpayer_name__trimmed", "_capture_url", "_capture_offset", "_row_sha256"]));
        const cursor = reader.getCursor();
        const row = await cursor.next();
        expect(row).toMatchObject({ taxpayer_number: "10000000001 ", taxpayer_number__trimmed: "10000000001", taxpayer_name: "ACME ROOFING, L.L.C. ", _621111__trimmed: "238160", _capture_file: "page-000.csv" });
        expect(row.exempt_begin_date ?? null).toBeNull();
        expect(row._row_sha256).toBe(sha256(ROWS[0]));
        const third = (await cursor.next(), await cursor.next());
        expect(third.taxpayer_name).toBe('Quote "Inc" Holdings\nSecond line ');
      } finally {
        await reader.close();
      }

      const watermarkBefore = await readFile(path.join(output, "watermark.json"));
      const second = await loadSnapshot({ ...params, now: "2026-10-18T00:00:00.000Z" });
      expect(second).toMatchObject({ merged: false, diff: { new: 0, changed: 0, unchanged: 4, removed: 0 }, rebuild_matches_snapshot: true });
      expect(second.snapshot.sha256).toBe(first.snapshot.sha256);
      expect(await readFile(path.join(output, "watermark.json"))).toEqual(watermarkBefore);

      // Same capture into another track directory: byte-identical snapshot.
      const elsewhere = await loadSnapshot({ ...params, outputDir: path.join(dir, "elsewhere") });
      expect(elsewhere.snapshot.sha256).toBe(first.snapshot.sha256);

      // Changed capture: one row edited, one key dropped, one key added (same capture path, new bytes).
      const changedRows = [ROWS[0].replace('"A "', '"F "'), ROWS[1], ROWS[3], ROWS[4], '"10000000005 ","NEW CO LLC ","227","A ","2026-10-01T00:00:00.000",,"  "'];
      await rm(capture, { recursive: true });
      await writeCapture(capture, [changedRows.slice(0, 3), changedRows.slice(3)]);
      const third = await loadSnapshot({ ...params, now: "2026-10-19T00:00:00.000Z" });
      expect(third).toMatchObject({ merged: true, diff: { new: 1, changed: 1, unchanged: 2, removed: 1, tombstoned: 1 } });
      expect(third.watermark.last_merged_at).toBe("2026-10-19T00:00:00.000Z");
      const tombstones = (await readFile(path.join(output, "franchise-travis.tombstones.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(tombstones).toEqual([expect.objectContaining({ key: "10000000003", reason: "absent_from_capture", removed_at: "2026-10-19T00:00:00.000Z" })]);
      expect(existsSync(path.join(output, "franchise-travis.loads.jsonl"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("takes the latest receipt per file, so a retried page loads from its successful attempt", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "t3-retry-"));
    try {
      await writeCapture(dir, [ROWS.slice(0, 2)]);
      const [ok] = (await readFile(path.join(dir, "receipts.jsonl"), "utf8")).trim().split("\n");
      const failed = { ...JSON.parse(ok), kind: "page", status: 429, bytes: 10, sha256: "0".repeat(64), rows: null, retried: true };
      await writeFile(path.join(dir, "receipts.jsonl"), `${JSON.stringify(failed)}\n${ok}\n`);
      const receipts = await readCaptureReceipts(dir);
      expect(receipts).toHaveLength(1);
      expect(receipts[0].status).toBe(200);
      await expect(verifyCapture(dir, receipts)).resolves.toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
