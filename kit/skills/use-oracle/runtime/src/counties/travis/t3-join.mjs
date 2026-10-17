/**
 * T3 joins between official business snapshots (assignment decisions.md section 23): offline, from snapshots only.
 *
 * Veteran-owned to franchise: every row of the SOS Veteran Owned Business snapshot is joined to the Comptroller
 * franchise rows (statewide snapshot) that carry the same SOS file number (`sosFileNumberJoinKey`, versioned). The
 * veteran file's own `taxid` is compared with the joined taxpayer numbers as an independent check of the join. The
 * Travis subset is the veteran rows joined to a franchise row of Travis (taxpayer_county_code 227). A join row records
 * an official-to-official key match; it is not a candidate and asserts nothing about any permit or owner.
 *
 * The join is a deterministic private Parquet (sorted by filing number) with its input snapshot digests in the
 * metadata; a re-run with the same inputs gives the same bytes and rewrites nothing.
 *
 * @module counties/travis/t3-join
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ParquetReader, ParquetSchema, ParquetWriter } from "@dsnp/parquetjs";

import { SOS_JOIN_VERSION, TRAVIS_COMPTROLLER_COUNTY_CODE, sosFileNumberJoinKey } from "./t3-sources.mjs";

export const JOIN_VERSION = "travis-t3-veteran-franchise-join.v1";
const RUNTIME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const relative = (target) => path.relative(RUNTIME_ROOT, path.resolve(target)).split(path.sep).join("/");

/**
 * @param {string} parquetPath - Snapshot.
 * @param {string[]} columns - Columns to read.
 * @param {(record: Record<string, any>) => void} onRecord - Callback.
 */
async function scan(parquetPath, columns, onRecord) {
  const reader = await ParquetReader.openFile(parquetPath);
  try {
    const cursor = reader.getCursor(columns.map((column) => [column]));
    let record = await cursor.next();
    while (record) {
      onRecord(record);
      record = await cursor.next();
    }
  } finally {
    await reader.close();
  }
}

/**
 * Join the veteran-owned snapshot to the franchise statewide snapshot.
 *
 * @param {object} params - Parameters.
 * @param {string} params.veteranParquet - `tx-sos-veteran-owned-business` snapshot.
 * @param {string} params.franchiseParquet - `tx-comptroller-franchise-tax-statewide` snapshot.
 * @param {string} params.outputPath - Join Parquet to write.
 * @returns {Promise<Record<string, any>>} Report (counts and digests only).
 */
export async function joinVeteranToFranchise({ veteranParquet, franchiseParquet, outputPath }) {
  const started = Date.now();
  /** @type {Map<string, { taxpayers: Set<string>, travis: boolean }>} */
  const franchise = new Map();
  let franchiseRows = 0;
  let franchiseWithoutKey = 0;
  /** Printed franchise SOS numbers (to count how many veteran numbers would match without the padding). */
  /** @type {Set<string>} */
  const printedFranchise = new Set();
  await scan(franchiseParquet, ["secretary_of_state_sos_or_coa_file_number__trimmed", "taxpayer_number__trimmed", "taxpayer_county_code__trimmed"], (record) => {
    franchiseRows += 1;
    if (record.secretary_of_state_sos_or_coa_file_number__trimmed) printedFranchise.add(String(record.secretary_of_state_sos_or_coa_file_number__trimmed));
    const key = sosFileNumberJoinKey(record.secretary_of_state_sos_or_coa_file_number__trimmed);
    if (key === null) {
      franchiseWithoutKey += 1;
      return;
    }
    const entry = franchise.get(key) ?? { taxpayers: new Set(), travis: false };
    entry.taxpayers.add(String(record.taxpayer_number__trimmed));
    if (record.taxpayer_county_code__trimmed === TRAVIS_COMPTROLLER_COUNTY_CODE) entry.travis = true;
    franchise.set(key, entry);
  });

  const rows = [];
  /** @type {Record<string, number>} */
  const counts = { veteran_rows: 0, without_key: 0, matched: 0, matched_travis: 0, matched_out_of_county_only: 0, matched_several_taxpayers: 0, unmatched: 0, printed_values_equal: 0, taxid_agrees: 0, taxid_differs: 0, taxid_blank: 0 };
  /** @type {Record<string, number>} */
  const unmatchedByStatus = {};
  /** @type {Record<string, number>} */
  const matchedByStatus = {};
  await scan(veteranParquet, ["filing_number__trimmed", "taxid__trimmed", "status_description__trimmed", "_row_sha256"], (record) => {
    counts.veteran_rows += 1;
    const filing = record.filing_number__trimmed ?? null;
    const status = record.status_description__trimmed ?? "(null)";
    if (filing !== null && printedFranchise.has(String(filing))) counts.printed_values_equal += 1;
    const key = sosFileNumberJoinKey(filing);
    if (key === null) {
      counts.without_key += 1;
      rows.push({ filing_number: filing, join_key: null, match: "no_key", taxpayer_numbers: null, taxid_check: null, veteran_row_sha256: record._row_sha256 });
      return;
    }
    const entry = franchise.get(key);
    if (!entry) {
      counts.unmatched += 1;
      unmatchedByStatus[status] = (unmatchedByStatus[status] ?? 0) + 1;
      rows.push({ filing_number: filing, join_key: key, match: "none", taxpayer_numbers: null, taxid_check: null, veteran_row_sha256: record._row_sha256 });
      return;
    }
    counts.matched += 1;
    matchedByStatus[status] = (matchedByStatus[status] ?? 0) + 1;
    if (entry.travis) counts.matched_travis += 1;
    else counts.matched_out_of_county_only += 1;
    if (entry.taxpayers.size > 1) counts.matched_several_taxpayers += 1;
    const taxid = record.taxid__trimmed ?? null;
    const taxidCheck = taxid === null ? "blank" : entry.taxpayers.has(String(taxid)) ? "agrees" : "differs";
    counts[`taxid_${taxidCheck}`] += 1;
    rows.push({ filing_number: filing, join_key: key, match: entry.travis ? "travis" : "out_of_county", taxpayer_numbers: [...entry.taxpayers].sort().join(","), taxid_check: taxidCheck, veteran_row_sha256: record._row_sha256 });
  });
  rows.sort((left, right) => String(left.filing_number).localeCompare(String(right.filing_number)) || String(left.veteran_row_sha256).localeCompare(String(right.veteran_row_sha256)));

  const inputs = { veteran_snapshot_sha256: sha256Hex(await readFile(veteranParquet)), franchise_snapshot_sha256: sha256Hex(await readFile(franchiseParquet)) };
  const schema = new ParquetSchema({
    filing_number: { type: "UTF8", optional: true, compression: "SNAPPY" },
    join_key: { type: "UTF8", optional: true, compression: "SNAPPY" },
    match: { type: "UTF8", compression: "SNAPPY" },
    taxpayer_numbers: { type: "UTF8", optional: true, compression: "SNAPPY" },
    taxid_check: { type: "UTF8", optional: true, compression: "SNAPPY" },
    veteran_row_sha256: { type: "UTF8", compression: "SNAPPY" },
  });
  const temporary = `${outputPath}.tmp-${process.pid}`;
  const writer = await ParquetWriter.openFile(schema, temporary, { rowGroupSize: 50_000 });
  writer.setMetadata("t3.join_version", JOIN_VERSION);
  writer.setMetadata("t3.sos_join_version", SOS_JOIN_VERSION);
  writer.setMetadata("t3.veteran_snapshot_sha256", inputs.veteran_snapshot_sha256);
  writer.setMetadata("t3.franchise_snapshot_sha256", inputs.franchise_snapshot_sha256);
  for (const row of rows) {
    /** @type {Record<string, string>} */
    const record = {};
    for (const [key, value] of Object.entries(row)) if (value !== null && value !== undefined) record[key] = String(value);
    await writer.appendRow(record);
  }
  await writer.close();
  const rebuilt = sha256Hex(await readFile(temporary));
  const existing = existsSync(outputPath) ? sha256Hex(await readFile(outputPath)) : null;
  let written = false;
  if (existing === rebuilt) await rm(temporary, { force: true });
  else {
    if (existing !== null) await rename(outputPath, `${outputPath.replace(/\.parquet$/, "")}.${existing.slice(0, 16)}.replaced.parquet`);
    await rename(temporary, outputPath);
    written = true;
  }
  const sorted = (object) => Object.fromEntries(Object.entries(object).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  return {
    kind: "travis-t3-veteran-franchise-join",
    join_version: JOIN_VERSION,
    sos_join_version: SOS_JOIN_VERSION,
    inputs,
    franchise: { rows: franchiseRows, rows_without_sos_file_number: franchiseWithoutKey, distinct_join_keys: franchise.size, join_keys_with_several_taxpayers: [...franchise.values()].filter((entry) => entry.taxpayers.size > 1).length },
    counts,
    travis_subset: counts.matched_travis,
    matched_by_status: sorted(matchedByStatus),
    unmatched_by_status: sorted(unmatchedByStatus),
    output: { path: relative(outputPath), sha256: rebuilt, rows: rows.length, written, unchanged: !written },
    duration_seconds: Math.round((Date.now() - started) / 100) / 10,
  };
}
