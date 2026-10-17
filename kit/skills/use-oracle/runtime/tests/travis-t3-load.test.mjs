import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runLoad } from "../src/counties/travis/t3-load.mjs";
import { runPrivacyCheck } from "../src/counties/travis/t3-privacy-check.mjs";
import { loadSnapshot } from "../src/counties/travis/t3-snapshot.mjs";
import { TDLR_LICFILE_COLUMNS_V1 } from "../src/counties/travis/t3-sources.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const FRANCHISE_HEADER =
  '"taxpayer_number","taxpayer_name","taxpayer_county_code","taxpayer_organizational_type","secretary_of_state_sos_or_coa_file_number","sos_status_code","right_to_transact_business_code"';

/**
 * Write CSV pages with receipts (and, for a Socrata version directory, its capture.json).
 *
 * @param {string} dir - Capture directory.
 * @param {string} header - CSV header.
 * @param {string[][]} pages - Data lines per page.
 * @param {{ socrata?: boolean, url?: string, contentType?: string, fileName?: (index: number) => string, kind?: string }} [options] - Shape.
 */
export async function writeCsvCapture(dir, header, pages, { socrata = true, url = "https://data.texas.gov/resource/9cir-efmm.csv", contentType = "text/csv; charset=UTF-8", fileName = (index) => `page-${String(index).padStart(5, "0")}.csv`, kind = "page" } = {}) {
  await mkdir(dir, { recursive: true });
  const receipts = [];
  let rows = 0;
  let bytes = 0;
  for (const [index, lines] of pages.entries()) {
    const file = fileName(index);
    const text = `${header}\n${lines.join("\n")}\n`;
    await writeFile(path.join(dir, file), text);
    rows += lines.length;
    bytes += Buffer.byteLength(text);
    receipts.push({ kind, file, url: `${url}?%24order=%3Aid&%24limit=1000&%24offset=${index * 1000}`, fetched_at: "2026-10-17T16:07:20.000Z", status: 200, bytes: Buffer.byteLength(text), sha256: sha256(text), rows: lines.length, content_type: contentType, egress: "US" });
  }
  await writeFile(path.join(dir, "receipts.jsonl"), `${receipts.map((receipt) => JSON.stringify(receipt)).join("\n")}\n`);
  if (socrata) {
    await writeFile(path.join(dir, "capture.json"), JSON.stringify({ consistent: true, expected_rows: rows, rows, bytes, pages: pages.length, page_size: 1000, rows_updated_at: { start: "1792233329", end: "1792233329", start_iso: "2026-10-17T10:35:29.000Z", end_iso: "2026-10-17T10:35:29.000Z" } }));
  }
}

const row = (number, name, county, sos = "0801000001", rtt = "A") => `"${number}","${name}","${county}","CL","${sos}","A","${rtt}"`;

describe("T3 offline load", () => {
  it("loads the statewide universe and the Travis subset derived from it, then re-loads as a no-op", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-load-"));
    try {
      const registryDir = path.join(root, "registry");
      // The 2026-10-16 Travis snapshot: three Travis taxpayers.
      const cache = path.join(root, "comptroller");
      await writeCsvCapture(cache, FRANCHISE_HEADER, [[row("32000000001", "ACME ROOFING LLC", "227"), row("32000000002", "MOVED AWAY LLC", "227"), row("32000000003", "ENDED LLC", "227")]], { socrata: false });
      await loadSnapshot({ sourceKey: "tx-comptroller-franchise-tax", captureDir: cache, outputDir: registryDir, name: "tx-comptroller-franchise-tax-travis", now: "2026-10-16T18:17:09.000Z" });

      // The statewide window capture: one Travis taxpayer changed, one moved county, one ended, one new; plus another county.
      const windowDir = path.join(root, "t3-window");
      await writeCsvCapture(path.join(windowDir, "tx-comptroller-franchise-tax", "v1792233329"), FRANCHISE_HEADER, [
        [row("32000000001", "ACME ROOFING LLC", "227", "0801000001", "N"), row("32000000002", "MOVED AWAY LLC", "101")],
        [row("32000000004", "NEW TRAVIS LLC", "227"), row("32000000005", "ACME ROOFING LLC", "101")],
      ]);
      const options = { windowDir, registryDir, licensingDir: path.join(root, "licensing"), loadsDir: path.join(root, "loads"), only: ["franchise-statewide", "franchise-travis"], log: () => {} };
      const first = await runLoad({ ...options, now: "2026-10-17T17:00:00.000Z" });
      const statewide = first.steps["franchise-statewide"].report;
      expect(statewide.counts).toMatchObject({ rows: 4, distinct_keys: 4, by_scope: { out_of_county: 2, travis: 2 } });
      expect(statewide.names).toMatchObject({ non_unique_names: 1, keys_under_non_unique_names: 2 });
      const travis = first.steps["franchise-travis"];
      expect(travis.report.counts).toMatchObject({ rows: 2, rows_filtered_out: 2 });
      expect(travis.report.diff).toMatchObject({ new: 1, changed: 1, unchanged: 0, removed: 2, tombstoned: 2 });
      expect(travis.report.changed_columns.by_column).toEqual({ right_to_transact_business_code: 1 });
      expect(travis.tombstoned_where).toEqual({ tombstoned: 2, in_statewide_file_other_county: 1, in_statewide_file_travis: 0, not_in_statewide_file: 1 });
      expect(first.all_no_op).toBe(false);

      const watermark = await readFile(path.join(registryDir, "watermark.json"));
      const second = await runLoad({ ...options, now: "2026-10-17T18:00:00.000Z" });
      expect(second.all_no_op).toBe(true);
      expect(await readFile(path.join(registryDir, "watermark.json"))).toEqual(watermark);
      expect(second.steps["franchise-travis"].report.snapshot.sha256).toBe(travis.report.snapshot.sha256);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("joins veteran-owned rows to franchise rows by the padded SOS file number and checks taxid", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-vet-"));
    try {
      const windowDir = path.join(root, "t3-window");
      await writeCsvCapture(path.join(windowDir, "tx-comptroller-franchise-tax", "v1792233329"), FRANCHISE_HEADER, [
        [row("32000000001", "VET ROOFING LLC", "227", "0801000001"), row("32000000002", "VET ELSEWHERE LLC", "101", "0801000002"), row("32000000003", "NO SOS LLC", "227", "")],
      ]);
      const vetHeader = '"filing_number","name","status_description","corp_type","taxid"';
      await writeCsvCapture(path.join(windowDir, "tx-sos-veteran-owned-business", "v1790848849"), vetHeader, [
        ['"801000001","VET ROOFING LLC","In existence","Domestic Limited Liability Company (LLC)","32000000001"', '"801000002","VET ELSEWHERE LLC","In existence","Domestic Limited Liability Company (LLC)","32099999999"', '"801000009","DISSOLVED LLC","Voluntarily dissolved","Domestic Limited Liability Company (LLC)",""'],
      ], { url: "https://data.texas.gov/resource/2vfr-72e4.csv" });
      const options = { windowDir, registryDir: path.join(root, "registry"), licensingDir: path.join(root, "licensing"), loadsDir: null, only: ["franchise-statewide", "veteran", "veteran-join"], log: () => {} };
      const first = await runLoad({ ...options, now: "2026-10-17T17:00:00.000Z" });
      const join = first.steps["veteran-join"].join;
      expect(join.counts).toMatchObject({ veteran_rows: 3, matched: 2, matched_travis: 1, matched_out_of_county_only: 1, unmatched: 1, printed_values_equal: 0, taxid_agrees: 1, taxid_differs: 1, taxid_blank: 0 });
      expect(join.unmatched_by_status).toEqual({ "Voluntarily dissolved": 1 });
      expect(join.franchise).toMatchObject({ rows: 3, rows_without_sos_file_number: 1, distinct_join_keys: 2 });
      expect(join.output.written).toBe(true);
      const second = await runLoad({ ...options, now: "2026-10-17T18:00:00.000Z" });
      expect(second.steps["veteran-join"].join.output).toMatchObject({ written: false, unchanged: true, sha256: join.output.sha256 });
      expect(second.all_no_op).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads the TDLR files under their column set with permit roles, and waits for a TSBPE CSV", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-lic-"));
    try {
      const windowDir = path.join(root, "t3-window");
      const header = TDLR_LICFILE_COLUMNS_V1.map((column) => `"${column}"`).join(",");
      const blank = (count) => Array.from({ length: count }, () => '""').join(",");
      const tdlrRow = (type, number, subtype, name, business, county) => `"${type}",${number}, 12/31/2027,"${county}","${name}",${blank(4)},"${business}",${blank(3)},"0227","${county}",${blank(2)},"${subtype}","N",${blank(4)}`;
      const tdlrDir = path.join(windowDir, "tdlr-license-files", "d20261017");
      const contractors = [tdlrRow("Electrical Contractor", 101, "EC", "SPARK CO", "SPARK CO", "TRAVIS"), tdlrRow("A/C Contractor", 201, "AC", "COOL, PAT", 'PAT "COOL" AIR', "HAYS")];
      await writeCsvCapture(tdlrDir, header, [contractors], { socrata: false, url: "https://www.tdlr.texas.gov/dbproduction2/Lteecele.csv", fileName: () => "Lteecele.csv", kind: "file", contentType: "application/octet-stream" });
      const all = path.join(root, "all");
      await writeCsvCapture(all, header, [[contractors[0], tdlrRow("Apprentice Electrician", 301, "AE", "APP, ALEX", "SPARK CO", "TRAVIS")]], { socrata: false, url: "https://www.tdlr.texas.gov/dbproduction2/Ltelcall.csv", fileName: () => "Ltelcall.csv", kind: "file", contentType: "application/octet-stream" });
      // Two files in one capture directory: merge their receipts.
      await writeFile(path.join(tdlrDir, "Ltelcall.csv"), await readFile(path.join(all, "Ltelcall.csv")));
      await writeFile(path.join(tdlrDir, "receipts.jsonl"), `${(await readFile(path.join(tdlrDir, "receipts.jsonl"), "utf8")).trim()}\n${(await readFile(path.join(all, "receipts.jsonl"), "utf8")).trim()}\n`);

      // TSBPE: the 2026-10-17 run saved an HTML page under a .csv name.
      const tsbpeDir = path.join(windowDir, "tsbpe-responsible-master-plumber", "d20261017");
      await writeCsvCapture(tsbpeDir, "<html>", [["<body>Responsible Master Plumber</body></html>"]], { socrata: false, url: "https://tsbpe.texas.gov/license-types/responsible-master-plumber/", fileName: () => "responsible-master-plumber-responsible-master-plumber.csv", kind: "file", contentType: "text/html; charset=UTF-8" });

      const options = { windowDir, registryDir: path.join(root, "registry"), licensingDir: path.join(root, "licensing"), loadsDir: null, only: ["tdlr", "tsbpe"], log: () => {} };
      const first = await runLoad({ ...options, now: "2026-10-17T17:00:00.000Z" });
      const tdlr = first.steps.tdlr;
      expect(tdlr.report.column_sets).toEqual([expect.objectContaining({ version: "tdlr-licfile-columns.v1", files: ["Lteecele.csv", "Ltelcall.csv"] })]);
      expect(tdlr.report.capture.lenient_rows).toBe(1);
      expect(tdlr.report.counts).toMatchObject({ rows: 4, distinct_keys: 3, duplicate_keys: 1, by_scope: { out_of_county: 1, travis: 3 } });
      expect(tdlr.licenses).toMatchObject({ licenses: 3, licenses_in_several_lists: 1, licenses_with_differing_rows_between_lists: 0, by_role: { contractor: { licenses: 2, travis_business_county: 1 }, works_under_a_contractor: { licenses: 1, travis_business_county: 1 } } });
      expect(first.steps.tsbpe).toMatchObject({ status: "awaiting_capture", set_aside: [expect.objectContaining({ file: "responsible-master-plumber-responsible-master-plumber.csv", reason: "html_not_csv" })] });

      // The re-run lands the CSV in the same dated directory, beside the HTML page.
      const rmp = path.join(root, "rmp");
      await writeCsvCapture(rmp, '"License Number","Name","Company","County"', [['"RMP-1","PAT PLUMBER","PIPES LLC","TRAVIS"', '"RMP-2","LEE PIPER","","HAYS"']], { socrata: false, url: "https://tsbpe.texas.gov/download-csv/RMP/", fileName: () => "responsible-master-plumber-RMP.csv", kind: "file", contentType: "text/csv" });
      await writeFile(path.join(tsbpeDir, "responsible-master-plumber-RMP.csv"), await readFile(path.join(rmp, "responsible-master-plumber-RMP.csv")));
      await writeFile(path.join(tsbpeDir, "receipts.jsonl"), `${(await readFile(path.join(tsbpeDir, "receipts.jsonl"), "utf8")).trim()}\n${(await readFile(path.join(rmp, "receipts.jsonl"), "utf8")).trim()}\n`);
      const second = await runLoad({ ...options, now: "2026-10-18T17:00:00.000Z" });
      const tsbpe = second.steps.tsbpe.report;
      expect(tsbpe.capture.set_aside).toEqual([expect.objectContaining({ file: "responsible-master-plumber-responsible-master-plumber.csv" })]);
      expect(tsbpe.resolved_columns).toMatchObject({ key_columns: ["license_number"], roles: { holder_name: "name", company: "company", county: "county" } });
      expect(tsbpe.counts).toMatchObject({ rows: 2, distinct_keys: 2, by_scope: { out_of_county: 1, travis: 1 } });
      expect(tsbpe.names).toMatchObject({ non_unique_names: 0, rows_indexed: 2 });
      expect(second.steps.tdlr.report.merged).toBe(false);
      const third = await runLoad({ ...options, now: "2026-10-19T17:00:00.000Z" });
      expect(third.all_no_op).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("finds no sole owner's taxpayer number in any derived file of the sales-tax load", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-privacy-check-"));
    try {
      const windowDir = path.join(root, "t3-window");
      const header = '"taxpayer_number","taxpayer_name","taxpayer_organization_type","outlet_number","outlet_name","outlet_county_code"';
      await writeCsvCapture(path.join(windowDir, "tx-comptroller-sales-tax", "v1792233070"), header, [['"32055555555","PAT SMITH","IS","00001","PAT SMITH LAWN","227"', '"32055555555","PAT SMITH","IS","00002","PAT SMITH LAWN 2","227"', '"32011111111","ACME ROOFING LLC","CL","00001","ACME ROOFING","227"']], { url: "https://data.texas.gov/resource/jrea-zgmq.csv" });
      const registryDir = path.join(root, "registry");
      await runLoad({ windowDir, registryDir, licensingDir: path.join(root, "licensing"), loadsDir: null, only: ["sales-tax", "name-index"], recordIdKey: Buffer.alloc(32, 9), now: "2026-10-17T17:00:00.000Z", log: () => {} });
      const result = await runPrivacyCheck({ windowDir, registryDir, recordIdKey: Buffer.alloc(32, 9) });
      expect(result).toMatchObject({ classed_rows_in_capture: 2, withheld_values_in_capture: 1, snapshot_rows: 3, snapshot_rows_classed: 2, snapshot_classed_rows_with_a_value: 0, withheld_values_in_snapshot: 0, captured_row_hashes_in_snapshot: 0, keyed_record_ids_in_snapshot: 2, keyed_record_ids_distinct: 2, keyed_record_ids_not_matching_the_key: 0, plain_record_ids_found: 0, withheld_values_in_index: 0, withheld_values_in_track_files: 0, key_material_in_track_files: 0, ok: true });
      // Under another key the stored ids do not match: the check fails.
      expect((await runPrivacyCheck({ windowDir, registryDir, recordIdKey: Buffer.alloc(32, 3) })).ok).toBe(false);
      // Two outlets of one sole owner: two records, two ids, no collapse.
      const ids = await runLoad({ windowDir, registryDir, licensingDir: path.join(root, "licensing"), loadsDir: null, only: ["record-ids"], log: () => {} });
      expect(ids.steps["record-ids"].checks["tx-comptroller-sales-tax-travis"]).toMatchObject({ rows: 3, distinct_records: 3, distinct_ids: 3, keyed_ids_of_withheld_rows: 2, ids_shared_by_different_records: 0, rows_without_id: 0 });
      expect(result.track_files_checked).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
