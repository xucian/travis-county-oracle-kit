#!/usr/bin/env node
/**
 * T3 snapshot loader (assignment decisions.md section 23): turns a verified CSV capture (pages or files with a
 * `receipts.jsonl`) into a deterministic, normalized, private Parquet snapshot under the gitignored `data/`, and keeps
 * the loader track's content-aware watermark.
 *
 *   load  node src/counties/travis/t3-snapshot.mjs load --source <key> --capture <dir> --output <dir> --name <name>
 *
 * Normalization (`NORMALIZER_VERSION`):
 *   - every source column is kept under its printed field name (Socrata's `_621111` included) with the value exactly
 *     as printed, and beside it `<column>__trimmed` with surrounding whitespace removed (null when nothing remains);
 *     an unquoted empty CSV cell is Socrata's null and is null in both;
 *   - every row carries its capture provenance: `_capture_file`, `_capture_url` (the request actually made),
 *     `_capture_fetched_at`, `_capture_sha256` (the page or file), `_capture_row_index`, `_capture_offset` (the
 *     request's `$offset` plus the row index) and `_row_sha256` (the row's bytes as captured);
 *   - rows keep the capture order (pages by offset, rows as printed); the Parquet bytes are a function of the capture
 *     alone (SNAPPY, no timestamps), so the same capture gives the same snapshot digest.
 *
 * Loading verifies each captured file's size and SHA-256 against its receipt and stops on a mismatch. The track
 * watermark (`watermark.json`) holds, per snapshot, the capture path, the artifact hash over the hash index of
 * `(path, artifact hash)` pairs, `merged_count` (artifacts merged), `merged_rows` and `last_merged_at`. A re-load
 * compares every key's row hashes with the snapshot on disk: when the hash index already covers every captured
 * artifact and nothing is new, changed or removed, nothing is rewritten and the watermark stays byte-identical.
 * Keys absent from a later capture of the same source are tombstoned (`<name>.tombstones.jsonl`) in the same merge.
 *
 * The snapshot is internal reconciliation state: never uploaded, never an Atlas or MCP source.
 *
 * @module counties/travis/t3-snapshot
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ParquetReader, ParquetSchema, ParquetWriter } from "@dsnp/parquetjs";

import { buildNameIndex, summarizeNameIndex } from "./name-matcher.mjs";
import { getT3Source, matchNamesOf } from "./t3-sources.mjs";

export const NORMALIZER_VERSION = "travis-t3-source-snapshot.v1";
export const RUNTIME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TRIMMED_SUFFIX = "__trimmed";
const KEY_SEPARATOR = "\u001f";
const ROW_GROUP_SIZE = 50_000;
const PROVENANCE_COLUMNS = Object.freeze([
  ["_capture_file", "UTF8"],
  ["_capture_url", "UTF8"],
  ["_capture_fetched_at", "UTF8"],
  ["_capture_sha256", "UTF8"],
  ["_capture_row_index", "INT64"],
  ["_capture_offset", "INT64"],
  ["_row_sha256", "UTF8"],
]);

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const relativeToRuntime = (target) => path.relative(RUNTIME_ROOT, path.resolve(target)).split(path.sep).join("/");

/**
 * @typedef {object} CsvField
 * @property {string} value - Cell text without the enclosing quotes, `""` unescaped.
 * @property {boolean} quoted - Whether the cell was quoted (Socrata quotes every non-null value).
 */

/**
 * RFC 4180 records with their character span, so each row's captured bytes can be hashed exactly.
 *
 * @param {string} text - Whole CSV document.
 * @returns {Generator<{ fields: CsvField[], start: number, end: number }>} Records, header first.
 */
export function* parseCsvRecordSpans(text) {
  const length = text.length;
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (index < length) {
    const start = index;
    /** @type {CsvField[]} */
    const fields = [];
    for (;;) {
      let value = "";
      let quoted = false;
      if (text[index] === '"') {
        quoted = true;
        index += 1;
        let chunkStart = index;
        for (;;) {
          const quote = text.indexOf('"', index);
          if (quote < 0) throw new Error(`unterminated quoted field in the record starting at character ${start}`);
          if (text[quote + 1] === '"') {
            value += text.slice(chunkStart, quote + 1);
            index = quote + 2;
            chunkStart = index;
            continue;
          }
          value += text.slice(chunkStart, quote);
          index = quote + 1;
          break;
        }
      } else {
        let cursor = index;
        while (cursor < length && text[cursor] !== "," && text[cursor] !== "\n" && text[cursor] !== "\r") cursor += 1;
        value = text.slice(index, cursor);
        index = cursor;
      }
      fields.push({ value, quoted });
      if (index >= length) {
        if (!(fields.length === 1 && !quoted && value === "")) yield { fields, start, end: index };
        return;
      }
      const character = text[index];
      if (character === ",") {
        index += 1;
        continue;
      }
      if (character === "\r" || character === "\n") {
        const end = index;
        index += character === "\r" && text[index + 1] === "\n" ? 2 : 1;
        if (!(fields.length === 1 && !quoted && value === "")) yield { fields, start, end };
        break;
      }
      throw new Error(`unexpected character ${JSON.stringify(character)} after a quoted field at character ${index}`);
    }
  }
}

/**
 * @param {string} captureDir - Capture directory.
 * @returns {Promise<Record<string, any>[]>} Data-file receipts (one per captured CSV), in offset order.
 */
export async function readCaptureReceipts(captureDir) {
  const text = await readFile(path.join(captureDir, "receipts.jsonl"), "utf8");
  const receipts = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
    .filter((receipt) => typeof receipt.file === "string" && /\.csv$/i.test(receipt.file) && (receipt.kind === undefined || receipt.kind === "page" || receipt.kind === "file"));
  /** @type {Map<string, Record<string, any>>} */
  const latest = new Map();
  for (const receipt of receipts) latest.set(receipt.file, receipt);
  return [...latest.values()].sort((left, right) => requestOffset(left.url) - requestOffset(right.url) || left.file.localeCompare(right.file));
}

/**
 * @param {string} url - Request URL as sent.
 * @returns {number} Its `$offset` (0 when absent).
 */
export function requestOffset(url) {
  const value = new URL(url).searchParams.get("$offset");
  return value === null ? 0 : Number.parseInt(value, 10);
}

/**
 * Verify every captured file against its receipt (size and SHA-256); throws on the first mismatch.
 *
 * @param {string} captureDir - Capture directory.
 * @param {Record<string, any>[]} receipts - Receipts from {@link readCaptureReceipts}.
 * @returns {Promise<{ file: string, bytes: number, sha256: string, rows: number | null, verified: true }[]>} Verified files.
 */
export async function verifyCapture(captureDir, receipts) {
  const verified = [];
  for (const receipt of receipts) {
    if (receipt.status !== 200) throw new Error(`${receipt.file}: receipt status ${receipt.status}, not a capture`);
    const bytes = await readFile(path.join(captureDir, receipt.file));
    const digest = sha256Hex(bytes);
    if (bytes.length !== receipt.bytes || digest !== receipt.sha256) {
      throw new Error(`${receipt.file}: capture does not match its receipt (bytes ${bytes.length} vs ${receipt.bytes}, sha256 ${digest} vs ${receipt.sha256})`);
    }
    verified.push({ file: receipt.file, bytes: bytes.length, sha256: digest, rows: receipt.rows ?? null, verified: /** @type {const} */ (true) });
  }
  return verified;
}

/**
 * @param {string[]} columns - Source columns as printed in the header.
 * @returns {Record<string, { type: string, optional: boolean, compression: string }>} Snapshot Parquet schema fields.
 */
export function snapshotSchemaFields(columns) {
  /** @type {Record<string, { type: string, optional: boolean, compression: string }>} */
  const fields = {};
  const reserved = new Set(PROVENANCE_COLUMNS.map(([name]) => name));
  for (const column of columns) {
    if (reserved.has(column) || column.endsWith(TRIMMED_SUFFIX)) throw new Error(`source column ${column} collides with a snapshot column`);
    fields[column] = { type: "UTF8", optional: true, compression: "SNAPPY" };
    fields[`${column}${TRIMMED_SUFFIX}`] = { type: "UTF8", optional: true, compression: "SNAPPY" };
  }
  for (const [name, type] of PROVENANCE_COLUMNS) fields[name] = { type, optional: true, compression: "SNAPPY" };
  return fields;
}

/**
 * Normalize one record into a snapshot row.
 *
 * @param {string[]} columns - Header columns.
 * @param {CsvField[]} fields - Record fields.
 * @returns {Record<string, string | null>} Raw and trimmed values.
 */
export function normalizeRecord(columns, fields) {
  /** @type {Record<string, string | null>} */
  const row = {};
  columns.forEach((column, index) => {
    const field = fields[index];
    const raw = field.quoted ? field.value : field.value === "" ? null : field.value;
    const trimmed = raw === null ? null : raw.trim();
    row[column] = raw;
    row[`${column}${TRIMMED_SUFFIX}`] = trimmed === null || trimmed === "" ? null : trimmed;
  });
  return row;
}

/**
 * @param {import("./t3-sources.mjs").T3Source} source - Source definition.
 * @param {Record<string, unknown>} row - Snapshot row.
 * @returns {string} Entity key (trimmed key columns), or the row hash when the source has none or a key part is null.
 */
export function entityKeyOf(source, row) {
  if (!source.keyColumns) return `row:${row._row_sha256}`;
  const parts = source.keyColumns.map((column) => row[`${column}${TRIMMED_SUFFIX}`]);
  if (parts.some((part) => part === null || part === undefined)) return `row:${row._row_sha256}`;
  return parts.join(KEY_SEPARATOR);
}

/**
 * Stream every captured file of a capture as normalized snapshot rows.
 *
 * @param {string} captureDir - Capture directory.
 * @param {Record<string, any>[]} receipts - Verified receipts.
 * @param {(row: Record<string, any>, header: string[]) => Promise<void> | void} onRow - Row callback, in capture order.
 * @returns {Promise<{ columns: string[], rows: number, rowsByFile: Record<string, number> }>} Header and counts.
 */
export async function streamCaptureRows(captureDir, receipts, onRow) {
  /** @type {string[] | null} */
  let columns = null;
  let total = 0;
  /** @type {Record<string, number>} */
  const rowsByFile = {};
  for (const receipt of receipts) {
    const text = await readFile(path.join(captureDir, receipt.file), "utf8");
    const offset = requestOffset(receipt.url);
    let header = null;
    let rowIndex = 0;
    for (const record of parseCsvRecordSpans(text)) {
      if (header === null) {
        header = record.fields.map((field) => field.value);
        if (columns === null) columns = header;
        else if (JSON.stringify(columns) !== JSON.stringify(header)) throw new Error(`${receipt.file}: header differs from the first file's`);
        continue;
      }
      if (record.fields.length !== header.length) throw new Error(`${receipt.file}: row ${rowIndex} has ${record.fields.length} fields, header has ${header.length}`);
      const row = normalizeRecord(header, record.fields);
      row._capture_file = receipt.file;
      row._capture_url = receipt.url;
      row._capture_fetched_at = receipt.fetched_at;
      row._capture_sha256 = receipt.sha256;
      row._capture_row_index = rowIndex;
      row._capture_offset = offset + rowIndex;
      row._row_sha256 = sha256Hex(Buffer.from(text.slice(record.start, record.end), "utf8"));
      await onRow(row, header);
      rowIndex += 1;
    }
    if (typeof receipt.rows === "number" && receipt.rows !== rowIndex) throw new Error(`${receipt.file}: ${rowIndex} rows parsed, receipt says ${receipt.rows}`);
    rowsByFile[receipt.file] = rowIndex;
    total += rowIndex;
  }
  return { columns: columns ?? [], rows: total, rowsByFile };
}

/**
 * Read the key-to-row-hashes map of an existing snapshot.
 *
 * @param {import("./t3-sources.mjs").T3Source} source - Source definition.
 * @param {string} parquetPath - Snapshot path.
 * @returns {Promise<Map<string, string[]>>} Entity key to its sorted row hashes.
 */
export async function readSnapshotKeys(source, parquetPath) {
  /** @type {Map<string, string[]>} */
  const keys = new Map();
  const reader = await ParquetReader.openFile(parquetPath);
  try {
    const projection = [...(source.keyColumns ?? []).map((column) => [`${column}${TRIMMED_SUFFIX}`]), ["_row_sha256"]];
    const cursor = reader.getCursor(projection);
    let record = await cursor.next();
    while (record) {
      const key = entityKeyOf(source, /** @type {Record<string, unknown>} */ (record));
      const list = keys.get(key) ?? [];
      list.push(String(record._row_sha256));
      keys.set(key, list);
      record = await cursor.next();
    }
  } finally {
    await reader.close();
  }
  for (const list of keys.values()) list.sort();
  return keys;
}

/**
 * Key-level diff of two key-to-row-hashes maps.
 *
 * @param {Map<string, string[]>} previous - Prior snapshot keys.
 * @param {Map<string, string[]>} next - New capture keys.
 * @returns {{ new: number, changed: number, unchanged: number, removed: number, removedKeys: string[] }} Diff.
 */
export function diffKeys(previous, next) {
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  for (const [key, hashes] of next) {
    const prior = previous.get(key);
    if (!prior) added += 1;
    else if (prior.join(",") === hashes.join(",")) unchanged += 1;
    else changed += 1;
  }
  const removedKeys = [...previous.keys()].filter((key) => !next.has(key)).sort();
  return { new: added, changed, unchanged, removed: removedKeys.length, removedKeys };
}

/**
 * @param {{ path: string, artifact_hash: string }[]} hashIndex - Hash index entries.
 * @returns {string} SHA-256 over the sorted `(path, artifact hash)` pairs.
 */
export function hashIndexDigest(hashIndex) {
  const pairs = hashIndex.map((entry) => [entry.path, entry.artifact_hash]).sort(([left], [right]) => left.localeCompare(right));
  return sha256Hex(JSON.stringify(pairs));
}

/**
 * Load one capture into its snapshot, idempotently.
 *
 * @param {object} params - Load parameters.
 * @param {string} params.sourceKey - Source key from `t3-sources.mjs`.
 * @param {string} params.captureDir - Capture directory with `receipts.jsonl`.
 * @param {string} params.outputDir - Track directory (snapshot, hash index, watermark, reports).
 * @param {string} params.name - Snapshot name (for example `tx-comptroller-franchise-tax-travis`).
 * @param {string} [params.scopeLabel] - Human description of the capture's scope.
 * @param {string} [params.now] - Merge time (ISO); defaults to the current time.
 * @returns {Promise<Record<string, any>>} The load report (counts and digests only; no rows).
 */
export async function loadSnapshot({ sourceKey, captureDir, outputDir, name, scopeLabel = null, now = new Date().toISOString() }) {
  const source = getT3Source(sourceKey);
  const startedAt = Date.now();
  await mkdir(outputDir, { recursive: true });
  const receipts = await readCaptureReceipts(captureDir);
  if (receipts.length === 0) throw new Error(`${captureDir}: no captured CSV receipts`);
  const verified = await verifyCapture(captureDir, receipts);

  const parquetPath = path.join(outputDir, `${name}.parquet`);
  const hashIndexPath = path.join(outputDir, `${name}.hash-index.json`);
  const watermarkPath = path.join(outputDir, "watermark.json");
  const tombstonePath = path.join(outputDir, `${name}.tombstones.jsonl`);
  const capturePath = `${relativeToRuntime(captureDir)}/`;
  const currentIndex = receipts.map((receipt) => ({ path: `${capturePath}${receipt.file}`, artifact_hash: receipt.sha256, bytes: receipt.bytes, rows: receipt.rows ?? null, fetched_at: receipt.fetched_at }));

  /** @type {Record<string, any>} */
  const watermark = existsSync(watermarkPath) ? JSON.parse(await readFile(watermarkPath, "utf8")) : { track: source.track, county: "travis", entries: {} };
  if (watermark.track !== source.track) throw new Error(`${watermarkPath} is the ${watermark.track} track, source ${sourceKey} is ${source.track}`);
  const prior = watermark.entries[name] ?? null;
  const priorIndex = existsSync(hashIndexPath) ? JSON.parse(await readFile(hashIndexPath, "utf8")) : [];
  const covered = new Set(priorIndex.map((entry) => `${entry.path}\u0000${entry.artifact_hash}`));
  const uncovered = currentIndex.filter((entry) => !covered.has(`${entry.path}\u0000${entry.artifact_hash}`));
  const snapshotIntact = prior !== null && existsSync(parquetPath) && sha256Hex(await readFile(parquetPath)) === prior.snapshot.sha256;
  const previousKeys = snapshotIntact ? await readSnapshotKeys(source, parquetPath) : new Map();

  // One streaming pass: keys and counts always; the Parquet is written to a temporary file and kept only on a merge.
  const temporaryPath = `${parquetPath}.tmp-${process.pid}`;
  /** @type {Map<string, string[]>} */
  const nextKeys = new Map();
  /** @type {Record<string, number>} */
  const presence = {};
  /** @type {Record<string, Map<string, number>>} */
  const distributions = Object.fromEntries(source.distributionColumns.map((column) => [column, new Map()]));
  /** @type {Record<string, number>} */
  const scopes = {};
  const nameRows = [];
  let columns = null;
  let writer = null;
  const openWriter = async (header) => {
    columns = header;
    writer = await ParquetWriter.openFile(new ParquetSchema(snapshotSchemaFields(header)), temporaryPath, { rowGroupSize: ROW_GROUP_SIZE });
    writer.setMetadata("t3.source", source.key);
    writer.setMetadata("t3.dataset", source.dataset);
    writer.setMetadata("t3.normalizer_version", NORMALIZER_VERSION);
    writer.setMetadata("t3.capture_artifact_hash", hashIndexDigest(currentIndex));
  };
  const streamed = await streamCaptureRows(captureDir, receipts, async (row, header) => {
    if (writer === null) await openWriter(header);
    /** @type {Record<string, unknown>} */
    const record = {};
    for (const [key, value] of Object.entries(row)) {
      if (value === null || value === undefined) continue;
      record[key] = key === "_capture_row_index" || key === "_capture_offset" ? BigInt(value) : value;
      if (key.endsWith(TRIMMED_SUFFIX)) presence[key.slice(0, -TRIMMED_SUFFIX.length)] = (presence[key.slice(0, -TRIMMED_SUFFIX.length)] ?? 0) + 1;
    }
    await writer.appendRow(record);
    const key = entityKeyOf(source, row);
    const list = nextKeys.get(key) ?? [];
    list.push(row._row_sha256);
    nextKeys.set(key, list);
    for (const column of source.distributionColumns) {
      const value = row[`${column}${TRIMMED_SUFFIX}`] ?? "(null)";
      distributions[column].set(value, (distributions[column].get(value) ?? 0) + 1);
    }
    const scope = source.scopeOf(row);
    scopes[scope] = (scopes[scope] ?? 0) + 1;
    if (source.nameColumns.length > 0) nameRows.push({ __key: key, __scope: scope, __names: matchNamesOf(source, row) });
  });
  if (writer === null) await openWriter(streamed.columns);
  await writer.close();
  for (const list of nextKeys.values()) list.sort();
  const snapshotColumns = columns ?? streamed.columns;

  const diff = diffKeys(previousKeys, nextKeys);
  const unchangedCapture = snapshotIntact && uncovered.length === 0 && diff.new === 0 && diff.changed === 0 && diff.removed === 0;
  let merged = false;
  /** Digest of the snapshot this load rebuilt; on a no-op re-load it must equal the snapshot on disk (determinism). */
  const rebuiltSha256 = sha256Hex(await readFile(temporaryPath));
  if (unchangedCapture) {
    await rm(temporaryPath, { force: true });
  } else {
    await rename(temporaryPath, parquetPath);
    merged = true;
  }
  const snapshotBytes = await readFile(parquetPath);
  const snapshot = { path: relativeToRuntime(parquetPath), sha256: sha256Hex(snapshotBytes), bytes: snapshotBytes.length, rows: streamed.rows };

  if (merged) {
    for (const key of diff.removedKeys) {
      await appendFile(tombstonePath, `${JSON.stringify({ key, reason: "absent_from_capture", row_sha256: previousKeys.get(key), removed_at: now, capture_artifact_hash: hashIndexDigest(currentIndex) })}\n`);
    }
    const hashIndex = currentIndex.map((entry) => ({ ...entry, merged_at: now }));
    await writeFile(hashIndexPath, `${JSON.stringify(hashIndex, null, 1)}\n`);
    watermark.entries[name] = {
      track: source.track,
      source: source.key,
      dataset: source.dataset,
      scope: scopeLabel,
      path: capturePath,
      artifact_hash: hashIndexDigest(currentIndex),
      merged_count: currentIndex.length,
      merged_rows: streamed.rows,
      last_merged_at: now,
      hash_index_path: relativeToRuntime(hashIndexPath),
      snapshot,
      normalizer_version: NORMALIZER_VERSION,
    };
    await writeFile(watermarkPath, `${JSON.stringify(watermark, null, 1)}\n`);
  }

  // Duplicate keys: which columns differ between their rows (values only for code and date columns).
  const duplicateKeys = [...nextKeys.entries()].filter(([key, hashes]) => hashes.length > 1 && !key.startsWith("row:"));
  const duplicates = [];
  if (duplicateKeys.length > 0 && duplicateKeys.length <= 50) {
    const wanted = new Set(duplicateKeys.map(([key]) => key));
    /** @type {Map<string, Record<string, any>[]>} */
    const rowsByKey = new Map();
    await streamCaptureRows(captureDir, receipts, (row) => {
      const key = entityKeyOf(source, row);
      if (wanted.has(key)) rowsByKey.set(key, [...(rowsByKey.get(key) ?? []), row]);
    });
    const showable = new Set([...source.distributionColumns, ...snapshotColumns.filter((column) => /date/i.test(column))]);
    for (const rows of rowsByKey.values()) {
      const differing = snapshotColumns.filter((column) => new Set(rows.map((row) => row[column])).size > 1);
      duplicates.push({
        rows: rows.length,
        locations: rows.map((row) => ({ file: row._capture_file, row_index: row._capture_row_index, offset: row._capture_offset })),
        differing_columns: differing,
        equal_columns: snapshotColumns.filter((column) => !differing.includes(column)),
        differing_values: rows.map((row) => Object.fromEntries(differing.filter((column) => showable.has(column)).map((column) => [column, row[`${column}${TRIMMED_SUFFIX}`]]))),
      });
    }
  }

  const nameSummary =
    source.nameColumns.length > 0
      ? {
          ...summarizeNameIndex(
            buildNameIndex(
              nameRows.map((row) => ({ ...row, ...Object.fromEntries(row.__names.map((text, index) => [`__name_${index}`, text])) })),
              { source: source.key, nameFields: Array.from({ length: nameRows.reduce((most, row) => Math.max(most, row.__names.length), 0) }, (_, index) => `__name_${index}`), keyOf: (row) => String(row.__key), scopeOf: (row) => String(row.__scope) },
            ),
          ),
          name_columns: source.nameColumns,
          match_name_version: source.matchNameVersion ?? null,
          rows_with_derived_name: nameRows.filter((row) => row.__names.length > source.nameColumns.length).length,
        }
      : null;

  const report = {
    kind: "travis-t3-snapshot-load",
    source: source.key,
    dataset: source.dataset,
    track: source.track,
    name,
    scope: scopeLabel,
    normalizer_version: NORMALIZER_VERSION,
    loaded_at: now,
    capture: { path: capturePath, files: verified.length, bytes: verified.reduce((sum, file) => sum + file.bytes, 0), verified_against_receipts: true, artifact_hash: hashIndexDigest(currentIndex), files_detail: verified.map((file) => ({ ...file, rows_parsed: streamed.rowsByFile[file.file] })) },
    columns: { source: snapshotColumns, count: snapshotColumns.length, snapshot: Object.keys(snapshotSchemaFields(snapshotColumns)).length },
    counts: {
      rows: streamed.rows,
      distinct_keys: [...nextKeys.keys()].filter((key) => !key.startsWith("row:")).length,
      rows_without_key: [...nextKeys.keys()].filter((key) => key.startsWith("row:")).length,
      duplicate_keys: duplicateKeys.length,
      rows_under_duplicate_keys: duplicateKeys.reduce((sum, [, hashes]) => sum + hashes.length, 0),
      present_non_blank: Object.fromEntries(snapshotColumns.map((column) => [column, presence[column] ?? 0])),
      by_scope: Object.fromEntries(Object.entries(scopes).sort(([a], [b]) => a.localeCompare(b))),
      distributions: Object.fromEntries(Object.entries(distributions).map(([column, values]) => [column, Object.fromEntries([...values.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))])),
    },
    duplicates,
    names: nameSummary,
    diff: { against: snapshotIntact ? "snapshot on disk" : "nothing (first load)", new: diff.new, changed: diff.changed, unchanged: diff.unchanged, removed: diff.removed, tombstoned: merged ? diff.removed : 0 },
    hash_index: { entries: currentIndex.length, uncovered_before_load: uncovered.length },
    merged,
    merge_reason: merged ? (snapshotIntact ? "capture changed" : "first load") : "the hash index covers every (path, artifact hash) and the content diff is empty",
    snapshot,
    rebuilt_snapshot_sha256: rebuiltSha256,
    rebuild_matches_snapshot: rebuiltSha256 === snapshot.sha256,
    watermark: watermark.entries[name] ?? null,
    watermark_sha256: existsSync(watermarkPath) ? sha256Hex(await readFile(watermarkPath)) : null,
    duration_seconds: Math.round((Date.now() - startedAt) / 100) / 10,
  };
  await writeFile(path.join(outputDir, `${name}.load-report.json`), `${JSON.stringify(report, null, 1)}\n`);
  await appendFile(path.join(outputDir, `${name}.loads.jsonl`), `${JSON.stringify({ loaded_at: now, merged, diff: report.diff, snapshot_sha256: snapshot.sha256, watermark_sha256: report.watermark_sha256 })}\n`);
  return report;
}

/**
 * @param {string[]} argv - CLI arguments after the command.
 * @returns {Record<string, string>} Parsed `--name value` flags.
 */
function parseFlags(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument ${token}`);
    flags[token.slice(2)] = argv[index + 1];
    index += 1;
  }
  return flags;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "load") {
    console.error("usage: t3-snapshot.mjs load --source <key> --capture <dir> --output <dir> --name <name> [--scope <label>] [--now <iso>]");
    process.exit(2);
  }
  const flags = parseFlags(rest);
  for (const required of ["source", "capture", "output", "name"]) if (!flags[required]) throw new Error(`--${required} is required`);
  const report = await loadSnapshot({ sourceKey: flags.source, captureDir: path.resolve(flags.capture), outputDir: path.resolve(flags.output), name: flags.name, scopeLabel: flags.scope ?? null, now: flags.now });
  console.log(
    JSON.stringify({
      travis_t3_snapshot_load: report.name,
      rows: report.counts.rows,
      distinct_keys: report.counts.distinct_keys,
      duplicate_keys: report.counts.duplicate_keys,
      diff: report.diff,
      merged: report.merged,
      snapshot_sha256: report.snapshot.sha256,
      watermark_sha256: report.watermark_sha256,
      seconds: report.duration_seconds,
    }),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
