#!/usr/bin/env node
/**
 * T3 privacy check (assignment decisions.md section 23: no SSN-derived taxpayer number is stored or served): offline,
 * counts only. For a source with a privacy rule it collects, from the receipt-verified window capture, the withheld
 * values of every classed row, the as-captured hashes of those rows and their plain-recipe record ids (SHA-256 of the
 * printed key, the digest decisions.md section 24.2 rules out), then looks for them in every derived file: each value of
 * every snapshot row, the snapshot's row hashes, the name index, and the track's reports, hash index, tombstones and
 * watermark. It also checks the keyed record ids: one per classed row, all distinct, each equal to the HMAC under the
 * record-id key in force, and the key itself in no derived file. Nothing is printed but counts. Exit 0 when all hold.
 *
 *   node src/counties/travis/t3-privacy-check.mjs [--source tx-comptroller-sales-tax] [--window <dir>]
 *
 * @module counties/travis/t3-privacy-check
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ParquetReader } from "@dsnp/parquetjs";

import { readRecordIdKey, recordIdOf, withheldRecordIdOf } from "./record-ids.mjs";
import { DEFAULT_WINDOW, REGISTRY_DIR, latestSocrataCapture } from "./t3-load.mjs";
import { normalizeRecord, parseCsvRecordSpans, readCaptureReceipts } from "./t3-snapshot.mjs";
import { getT3Source } from "./t3-sources.mjs";

/** Snapshot and index names of each source with a privacy rule. */
const TARGETS = Object.freeze({
  "tx-comptroller-sales-tax": { snapshot: "tx-comptroller-sales-tax-travis", index: "tx-comptroller-sales-tax-travis" },
});

/**
 * @param {string} parquetPath - Parquet file.
 * @param {(record: Record<string, unknown>) => void} onRecord - Callback.
 */
async function scanParquet(parquetPath, onRecord) {
  const reader = await ParquetReader.openFile(parquetPath);
  try {
    const cursor = reader.getCursor();
    let record = await cursor.next();
    while (record) {
      onRecord(/** @type {Record<string, unknown>} */ (record));
      record = await cursor.next();
    }
  } finally {
    await reader.close();
  }
}

/**
 * Run the check.
 *
 * @param {object} [options] - Options.
 * @param {string} [options.sourceKey] - Source with a privacy rule.
 * @param {string} [options.windowDir] - Window directory.
 * @param {string} [options.registryDir] - Registry track directory.
 * @param {string} [options.matcherDir] - Name index directory.
 * @param {Buffer | null} [options.recordIdKey] - Record-id key (default: the key file).
 * @returns {Promise<Record<string, any>>} Counts.
 */
export async function runPrivacyCheck({ sourceKey = "tx-comptroller-sales-tax", windowDir = DEFAULT_WINDOW, registryDir = REGISTRY_DIR, matcherDir = path.join(path.dirname(registryDir), "matcher"), recordIdKey = null } = {}) {
  const key = recordIdKey ?? readRecordIdKey();
  const source = getT3Source(sourceKey);
  const target = TARGETS[sourceKey];
  if (!source.privacy || !target) throw new Error(`${sourceKey} has no privacy rule`);
  const { dir } = await latestSocrataCapture(windowDir, sourceKey);
  /** @type {Set<string>} */
  const withheld = new Set();
  /** @type {Set<string>} */
  const capturedHashes = new Set();
  /** @type {Set<string>} */
  const plainIds = new Set();
  /** @type {Set<string>} */
  const keyedIds = new Set();
  let classedRows = 0;
  for (const receipt of await readCaptureReceipts(dir)) {
    const text = await readFile(path.join(dir, receipt.file), "utf8");
    let header = null;
    for (const record of parseCsvRecordSpans(text, { dialect: source.csvDialect ?? "rfc4180" })) {
      if (header === null) {
        header = record.fields.map((field) => field.value);
        continue;
      }
      const row = normalizeRecord(header, record.fields);
      if (!source.privacy.classOf(row)) continue;
      classedRows += 1;
      for (const column of source.privacy.withheldColumns) if (row[`${column}__trimmed`]) withheld.add(String(row[`${column}__trimmed`]));
      capturedHashes.add(createHash("sha256").update(text.slice(record.start, record.end)).digest("hex"));
      const keyParts = source.privacy.recordKeyColumns.map((column) => row[`${column}__trimmed`]);
      plainIds.add(recordIdOf(sourceKey, keyParts));
      keyedIds.add(withheldRecordIdOf(key, sourceKey, keyParts));
    }
  }
  const counts = { source: sourceKey, privacy_version: source.privacy.version, classed_rows_in_capture: classedRows, withheld_values_in_capture: withheld.size, snapshot_rows: 0, snapshot_rows_classed: 0, snapshot_classed_rows_with_a_value: 0, withheld_values_in_snapshot: 0, captured_row_hashes_in_snapshot: 0, keyed_record_ids_in_snapshot: 0, keyed_record_ids_distinct: 0, keyed_record_ids_not_matching_the_key: 0, plain_record_ids_found: 0, withheld_values_in_index: 0, withheld_values_in_track_files: 0, key_material_in_track_files: 0, track_files_checked: 0 };
  const isWithheld = (value) => typeof value === "string" && withheld.has(value.trim());
  const isPlainId = (value) => typeof value === "string" && plainIds.has(value);
  /** @type {Set<string>} */
  const storedIds = new Set();
  await scanParquet(path.join(registryDir, `${target.snapshot}.parquet`), (record) => {
    counts.snapshot_rows += 1;
    if (record._privacy_class) {
      counts.snapshot_rows_classed += 1;
      if (source.privacy.withheldColumns.some((column) => record[column] != null || record[`${column}__trimmed`] != null)) counts.snapshot_classed_rows_with_a_value += 1;
    }
    for (const value of Object.values(record)) {
      if (isWithheld(value)) counts.withheld_values_in_snapshot += 1;
      if (isPlainId(value)) counts.plain_record_ids_found += 1;
    }
    if (capturedHashes.has(String(record._row_sha256))) counts.captured_row_hashes_in_snapshot += 1;
    if (record._withheld_record_id) {
      counts.keyed_record_ids_in_snapshot += 1;
      storedIds.add(String(record._withheld_record_id));
      if (!keyedIds.has(String(record._withheld_record_id))) counts.keyed_record_ids_not_matching_the_key += 1;
    }
  });
  counts.keyed_record_ids_distinct = storedIds.size;
  const indexPath = path.join(matcherDir, `${target.index}.names.parquet`);
  if (existsSync(indexPath)) {
    await scanParquet(indexPath, (record) => {
      for (const value of Object.values(record)) {
        if (isWithheld(value)) counts.withheld_values_in_index += 1;
        if (isPlainId(value)) counts.plain_record_ids_found += 1;
      }
      for (const printed of JSON.parse(String(record.printed_names ?? "[]"))) if (isWithheld(printed)) counts.withheld_values_in_index += 1;
    });
  }
  for (const name of await readdir(registryDir)) {
    if (!(name.startsWith(target.snapshot) || name === "watermark.json") || name.endsWith(".parquet")) continue;
    counts.track_files_checked += 1;
    const text = await readFile(path.join(registryDir, name), "utf8");
    for (const number of withheld) if (text.includes(number)) counts.withheld_values_in_track_files += 1;
    for (const id of plainIds) if (text.includes(id)) counts.plain_record_ids_found += 1;
    if (text.includes(key.toString("hex"))) counts.key_material_in_track_files += 1;
  }
  const ok =
    counts.snapshot_classed_rows_with_a_value === 0 &&
    counts.withheld_values_in_snapshot === 0 &&
    counts.captured_row_hashes_in_snapshot === 0 &&
    counts.keyed_record_ids_in_snapshot === counts.snapshot_rows_classed &&
    counts.keyed_record_ids_distinct === counts.keyed_record_ids_in_snapshot &&
    counts.keyed_record_ids_not_matching_the_key === 0 &&
    counts.plain_record_ids_found === 0 &&
    counts.withheld_values_in_index === 0 &&
    counts.withheld_values_in_track_files === 0 &&
    counts.key_material_in_track_files === 0;
  return { ...counts, ok };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argv = process.argv.slice(2);
  /** @type {Record<string, string>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) flags[argv[index].replace(/^--/, "")] = argv[index + 1];
  runPrivacyCheck({ sourceKey: flags.source, windowDir: flags.window ? path.resolve(flags.window) : undefined })
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(result.ok ? 0 : 1);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
