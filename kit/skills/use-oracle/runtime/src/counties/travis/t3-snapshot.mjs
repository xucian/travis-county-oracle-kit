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
 * Privacy (a source's `privacy` rule, `t3-sources.mjs`): in a classed row the withheld columns are null in both their
 * printed and trimmed form, `_privacy_class` and `_withheld_columns` say so, and `_row_sha256` hashes the row as captured
 * with the withheld cells emptied (`""`), so neither the value nor a hash that could be searched for it is stored. Its
 * key is `_withheld_record_id`, the keyed record id of decisions.md section 24.2 (HMAC-SHA256 under the record-id key
 * over the printed key, computed before the value is dropped): unique per outlet and stable across captures. The
 * watermark records the key's fingerprint; a load under another key stops. A key that disappears while all of its rows
 * are still in the capture under another key is recorded as `rekeyed`, not as gone.
 *
 * Column sets: a source may map printed headers to snapshot field names (`columnSets` in `t3-sources.mjs`); every
 * file's header is recorded with its digest and the column set version it resolved to, and a header no set knows stops
 * the load before anything is written.
 *
 * Loading verifies each captured file's size and SHA-256 against its receipt and stops on a mismatch. The track
 * watermark (`watermark.json`) holds, per snapshot, the capture path, the artifact hash over the hash index of
 * `(path, artifact hash)` pairs, `merged_count` (artifacts merged), `merged_rows` and `last_merged_at`. A re-load
 * compares every key's row hashes with the snapshot on disk: when the hash index already covers every captured
 * artifact and nothing is new, changed or removed, nothing is rewritten and the watermark stays byte-identical.
 * Keys absent from a later capture of the same source are tombstoned (`<name>.tombstones.jsonl`) in the same merge.
 * A merge that replaces a snapshot moves the replaced Parquet and hash index to `history/` (named by their digest), so
 * no earlier snapshot is lost. A load may take a row filter (for example the Travis rows of a statewide capture): the
 * snapshot then holds only the rows that pass, the watermark names the filter, and the report counts the rest. For keys
 * whose rows changed, the report counts which source columns differ (counts only, never values).
 *
 * The snapshot is internal reconciliation state: never uploaded, never an Atlas or MCP source.
 *
 * @module counties/travis/t3-snapshot
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ParquetReader, ParquetSchema, ParquetWriter } from "@dsnp/parquetjs";

import { buildNameIndex, summarizeNameIndex } from "./name-matcher.mjs";
import { RECORD_ID_VERSION, recordIdKeyFingerprint, withheldRecordIdOf } from "./record-ids.mjs";
import { getT3Source, matchNamesOf, snapshotFieldName } from "./t3-sources.mjs";

export const NORMALIZER_VERSION = "travis-t3-source-snapshot.v1";
export const RUNTIME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TRIMMED_SUFFIX = "__trimmed";
const KEY_SEPARATOR = "\u001f";
const ROW_GROUP_SIZE = 50_000;
const PRIVACY_COLUMNS = Object.freeze([
  ["_privacy_class", "UTF8"],
  ["_withheld_columns", "UTF8"],
  ["_withheld_record_id", "UTF8"],
]);
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

/** @param {string | undefined} character @returns {boolean} Whether a quoted field may close before it. */
const closesField = (character) => character === undefined || character === "," || character === "\n" || character === "\r";

/**
 * RFC 4180 records with their character span, so each row's captured bytes can be hashed exactly.
 *
 * Dialects: `rfc4180` (default, strict: a quote inside a quoted field must be doubled, anything else throws) and
 * `unescaped-quotes` (for writers that wrap values in quotes without escaping the quotes inside them, such as TDLR's
 * license files: a quote closes the field only before a comma, a line end or the end of the text, and is otherwise
 * literal; a doubled quote is still one quote unless it stands right before a comma or line end, where it is a literal
 * quote followed by the closing one). For RFC 4180 input both dialects give the same records; records that needed the
 * lenient rule are marked `lenient: true`.
 *
 * @param {string} text - Whole CSV document.
 * @param {{ dialect?: "rfc4180" | "unescaped-quotes" }} [options] - Parser options.
 * @returns {Generator<{ fields: CsvField[], start: number, end: number, lenient: boolean }>} Records, header first.
 */
export function* parseCsvRecordSpans(text, { dialect = "rfc4180" } = {}) {
  if (dialect !== "rfc4180" && dialect !== "unescaped-quotes") throw new Error(`unknown CSV dialect ${dialect}`);
  const unescapedQuotes = dialect === "unescaped-quotes";
  const length = text.length;
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (index < length) {
    const start = index;
    let lenient = false;
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
          const next = text[quote + 1];
          if (next === '"' && unescapedQuotes && closesField(text[quote + 2])) {
            // A literal quote ending the value, then the closing quote.
            value += text.slice(chunkStart, quote + 1);
            index = quote + 2;
            lenient = true;
            break;
          }
          if (next === '"') {
            value += text.slice(chunkStart, quote + 1);
            index = quote + 2;
            chunkStart = index;
            continue;
          }
          if (unescapedQuotes && !closesField(next)) {
            // A literal quote inside the value (the writer does not escape quotes).
            value += text.slice(chunkStart, quote + 1);
            index = quote + 1;
            chunkStart = index;
            lenient = true;
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
        if (!(fields.length === 1 && !quoted && value === "")) yield { fields, start, end: index, lenient };
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
        if (!(fields.length === 1 && !quoted && value === "")) yield { fields, start, end, lenient };
        break;
      }
      throw new Error(`unexpected character ${JSON.stringify(character)} after a quoted field at character ${index}`);
    }
  }
}

/**
 * The data-file receipts of a capture: the latest receipt of each `.csv` page or file, in offset order. A receipt whose
 * body was HTML (a download link that served a web page) is never a data file: it is set aside and reported.
 *
 * @param {string} captureDir - Capture directory.
 * @returns {Promise<{ receipts: Record<string, any>[], excluded: { file: string, reason: string, sha256: string | null }[] }>} Selection.
 */
export async function selectCaptureReceipts(captureDir) {
  const text = await readFile(path.join(captureDir, "receipts.jsonl"), "utf8");
  const receipts = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
    .filter((receipt) => typeof receipt.file === "string" && /\.csv$/i.test(receipt.file) && (receipt.kind === undefined || receipt.kind === "page" || receipt.kind === "file"));
  /** @type {Map<string, Record<string, any>>} */
  const latest = new Map();
  for (const receipt of receipts) latest.set(receipt.file, receipt);
  const excluded = [];
  const kept = [];
  for (const receipt of latest.values()) {
    if (/text\/html/i.test(String(receipt.content_type ?? ""))) excluded.push({ file: receipt.file, reason: "html_not_csv", sha256: receipt.sha256 ?? null });
    else kept.push(receipt);
  }
  kept.sort((left, right) => requestOffset(left.url) - requestOffset(right.url) || left.file.localeCompare(right.file));
  return { receipts: kept, excluded: excluded.sort((left, right) => left.file.localeCompare(right.file)) };
}

/**
 * @param {string} captureDir - Capture directory.
 * @returns {Promise<Record<string, any>[]>} Data-file receipts (one per captured CSV), in offset order.
 */
export async function readCaptureReceipts(captureDir) {
  return (await selectCaptureReceipts(captureDir)).receipts;
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
 * @param {{ privacy?: boolean }} [options] - Whether the source has a privacy rule (adds the privacy columns).
 * @returns {Record<string, { type: string, optional: boolean, compression: string }>} Snapshot Parquet schema fields.
 */
export function snapshotSchemaFields(columns, { privacy = false } = {}) {
  /** @type {Record<string, { type: string, optional: boolean, compression: string }>} */
  const fields = {};
  const reserved = new Set([...PROVENANCE_COLUMNS, ...PRIVACY_COLUMNS].map(([name]) => name));
  for (const column of columns) {
    if (reserved.has(column) || column.endsWith(TRIMMED_SUFFIX)) throw new Error(`source column ${column} collides with a snapshot column`);
    fields[column] = { type: "UTF8", optional: true, compression: "SNAPPY" };
    fields[`${column}${TRIMMED_SUFFIX}`] = { type: "UTF8", optional: true, compression: "SNAPPY" };
  }
  for (const [name, type] of PROVENANCE_COLUMNS) fields[name] = { type, optional: true, compression: "SNAPPY" };
  if (privacy) for (const [name, type] of PRIVACY_COLUMNS) fields[name] = { type, optional: true, compression: "SNAPPY" };
  return fields;
}

/**
 * One CSV field as a canonical writer prints it (quoted values with doubled quotes).
 *
 * @param {CsvField} field - Field.
 * @returns {string} Its text.
 */
const printField = (field) => (field.quoted ? `"${field.value.replace(/"/g, '""')}"` : field.value);

/**
 * The captured row text with some cells emptied; refuses a row the canonical form would not reproduce byte for byte.
 *
 * @param {string} original - The row as captured.
 * @param {CsvField[]} fields - Its fields.
 * @param {Set<number>} emptied - Indexes of the cells to empty.
 * @returns {string} Redacted row text.
 */
export function redactedRowText(original, fields, emptied) {
  if (fields.map(printField).join(",") !== original) throw new Error("a withheld row is not in canonical CSV form; its redacted hash cannot be derived");
  return fields.map((field, index) => (emptied.has(index) ? (field.quoted ? '""' : "") : printField(field))).join(",");
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
  if (row._withheld_record_id) return `withheld:${row._withheld_record_id}`;
  if (!source.keyColumns) return `row:${row._row_sha256}`;
  const nullable = new Set(source.nullableKeyColumns ?? []);
  const parts = source.keyColumns.map((column) => row[`${column}${TRIMMED_SUFFIX}`] ?? (nullable.has(column) ? "" : null));
  if (parts.some((part) => part === null || part === undefined)) return `row:${row._row_sha256}`;
  return parts.join(KEY_SEPARATOR);
}

/**
 * The column set a printed header resolves to for a source.
 *
 * @param {import("./t3-sources.mjs").T3Source} source - Source definition.
 * @param {string[]} printed - Header as printed.
 * @returns {{ version: string, header_sha256: string, printed: string[], fields: string[] }} Column set.
 */
export function resolveColumnSet(source, printed) {
  const headerSha256 = sha256Hex(JSON.stringify(printed));
  if (!source.columnSets) return { version: "printed", header_sha256: headerSha256, printed: [...printed], fields: [...printed] };
  let version;
  if (source.columnSets === "derive") version = `derived:${headerSha256.slice(0, 12)}`;
  else {
    const set = source.columnSets.find((candidate) => JSON.stringify(candidate.printed) === JSON.stringify(printed));
    if (!set) throw new Error(`header matches no column set of ${source.key} (header sha256 ${headerSha256}, ${printed.length} columns: ${JSON.stringify(printed)}); add a column set version to t3-sources.mjs`);
    version = set.version;
  }
  const fields = printed.map(snapshotFieldName);
  const duplicates = fields.filter((field, index) => fields.indexOf(field) !== index);
  if (duplicates.length > 0) throw new Error(`${source.key}: printed headers collide as snapshot fields: ${[...new Set(duplicates)].join(", ")}`);
  return { version, header_sha256: headerSha256, printed: [...printed], fields };
}

/**
 * The header of a CSV file (read from its first 1 MB).
 *
 * @param {string} file - CSV path.
 * @param {"rfc4180" | "unescaped-quotes"} dialect - Dialect.
 * @returns {Promise<string[]>} Header names as printed.
 */
export async function readCsvHeader(file, dialect) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(1 << 20);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lineEnd = text.search(/\r?\n/);
    const first = parseCsvRecordSpans(lineEnd >= 0 ? text.slice(0, lineEnd + 1) : text, { dialect }).next();
    if (first.done) throw new Error(`${file}: no header`);
    return first.value.fields.map((field) => field.value);
  } finally {
    await handle.close();
  }
}

/**
 * Stream every captured file of a capture as normalized snapshot rows.
 *
 * @param {string} captureDir - Capture directory.
 * @param {Record<string, any>[]} receipts - Verified receipts.
 * @param {(row: Record<string, any>, header: string[]) => Promise<void> | void} onRow - Row callback, in capture order.
 * @param {{ dialect?: "rfc4180" | "unescaped-quotes", privacy?: import("./t3-sources.mjs").PrivacyRule, fieldsOf?: (printed: string[]) => string[], withheldIdOf?: (row: Record<string, any>) => string }} [options] - CSV
 *   dialect, privacy rule, header-to-field mapping (column set) and the keyed record id of a classed row.
 * @returns {Promise<{ columns: string[], rows: number, rowsByFile: Record<string, number>, lenientRows: number, withheld: Record<string, number> }>} Header and counts.
 */
export async function streamCaptureRows(captureDir, receipts, onRow, { dialect = "rfc4180", privacy, fieldsOf, withheldIdOf } = {}) {
  /** @type {Record<string, number>} */
  const withheld = {};
  /** @type {string[] | null} */
  let columns = null;
  let total = 0;
  let lenientRows = 0;
  /** @type {Record<string, number>} */
  const rowsByFile = {};
  for (const receipt of receipts) {
    const text = await readFile(path.join(captureDir, receipt.file), "utf8");
    const offset = requestOffset(receipt.url);
    let header = null;
    let rowIndex = 0;
    for (const record of parseCsvRecordSpans(text, { dialect })) {
      if (header === null) {
        const printed = record.fields.map((field) => field.value);
        header = fieldsOf ? fieldsOf(printed) : printed;
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
      const original = text.slice(record.start, record.end);
      const privacyClass = privacy ? privacy.classOf(row) : null;
      if (privacy) {
        row._privacy_class = privacyClass;
        row._withheld_columns = privacyClass ? privacy.withheldColumns.join(",") : null;
        row._withheld_record_id = null;
      }
      if (privacyClass) {
        if (!withheldIdOf) throw new Error(`${receipt.file}: a withheld row needs the record-id key (decisions.md section 24.2)`);
        // The keyed id is computed from the printed key before the withheld value is dropped.
        row._withheld_record_id = withheldIdOf(row);
        const emptied = new Set(privacy.withheldColumns.map((column) => header.indexOf(column)).filter((index) => index >= 0));
        if (emptied.size !== privacy.withheldColumns.length) throw new Error(`${receipt.file}: a withheld column is missing from the header`);
        for (const column of privacy.withheldColumns) {
          row[column] = null;
          row[`${column}${TRIMMED_SUFFIX}`] = null;
        }
        row._row_sha256 = sha256Hex(Buffer.from(redactedRowText(original, record.fields, emptied), "utf8"));
        withheld[privacyClass] = (withheld[privacyClass] ?? 0) + 1;
      } else row._row_sha256 = sha256Hex(Buffer.from(original, "utf8"));
      if (record.lenient) lenientRows += 1;
      await onRow(row, header);
      rowIndex += 1;
    }
    if (typeof receipt.rows === "number" && receipt.rows !== rowIndex) throw new Error(`${receipt.file}: ${rowIndex} rows parsed, receipt says ${receipt.rows}`);
    rowsByFile[receipt.file] = rowIndex;
    total += rowIndex;
  }
  return { columns: columns ?? [], rows: total, rowsByFile, lenientRows, withheld };
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
    const present = new Set(Object.keys(reader.getSchema().fields));
    const projection = [...(source.keyColumns ?? []).map((column) => `${column}${TRIMMED_SUFFIX}`), "_row_sha256", "_withheld_record_id"].filter((column) => present.has(column)).map((column) => [column]);
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
 * Read, from a snapshot, the source columns of the rows under some keys (the changed-column report).
 *
 * @param {import("./t3-sources.mjs").T3Source} source - Source definition.
 * @param {string} parquetPath - Snapshot path.
 * @param {Set<string>} keys - Entity keys wanted.
 * @param {string[]} columns - Source columns to read (raw values).
 * @returns {Promise<Map<string, Record<string, unknown>[]>>} Rows by key.
 */
export async function readSnapshotRows(source, parquetPath, keys, columns) {
  /** @type {Map<string, Record<string, unknown>[]>} */
  const rows = new Map();
  if (keys.size === 0) return rows;
  const reader = await ParquetReader.openFile(parquetPath);
  try {
    const present = new Set(Object.keys(reader.getSchema().fields));
    const projection = [...new Set([...columns, ...(source.keyColumns ?? []).map((column) => `${column}${TRIMMED_SUFFIX}`), "_row_sha256", "_withheld_record_id"])].filter((column) => present.has(column)).map((column) => [column]);
    const cursor = reader.getCursor(projection);
    let record = await cursor.next();
    while (record) {
      const key = entityKeyOf(source, /** @type {Record<string, unknown>} */ (record));
      if (keys.has(key)) rows.set(key, [...(rows.get(key) ?? []), /** @type {Record<string, unknown>} */ (record)]);
      record = await cursor.next();
    }
  } finally {
    await reader.close();
  }
  return rows;
}

/**
 * Which source columns differ between the prior and the new rows of changed keys (counts only).
 *
 * @param {Map<string, Record<string, unknown>[]>} priorRows - Prior rows by key.
 * @param {Map<string, Record<string, unknown>[]>} nextRows - New rows by key.
 * @param {string[]} columns - Source columns.
 * @returns {{ keys: number, single_row_keys: number, multi_row_keys: number, by_column: Record<string, number>, keys_without_value_change: number }} Counts
 *   (`by_column`: how many compared keys differ in each column; a key can differ in several).
 */
export function changedColumnCounts(priorRows, nextRows, columns) {
  /** @type {Record<string, number>} */
  const byColumn = Object.fromEntries(columns.map((column) => [column, 0]));
  let single = 0;
  let multi = 0;
  let withoutValueChange = 0;
  for (const [key, next] of nextRows) {
    const prior = priorRows.get(key) ?? [];
    if (prior.length !== 1 || next.length !== 1) {
      multi += 1;
      continue;
    }
    single += 1;
    let differs = false;
    for (const column of columns) {
      if ((prior[0][column] ?? null) !== (next[0][column] ?? null)) {
        byColumn[column] += 1;
        differs = true;
      }
    }
    if (!differs) withoutValueChange += 1;
  }
  return { keys: nextRows.size, single_row_keys: single, multi_row_keys: multi, by_column: Object.fromEntries(Object.entries(byColumn).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))), keys_without_value_change: withoutValueChange };
}

/**
 * @typedef {object} RowFilter
 * @property {string} label - What the filter keeps (recorded in the watermark and the Parquet metadata).
 * @property {(row: Record<string, any>) => boolean} test - Whether a normalized row is kept.
 */

/**
 * Load one capture into its snapshot, idempotently.
 *
 * @param {object} params - Load parameters.
 * @param {string} params.sourceKey - Source key from `t3-sources.mjs`.
 * @param {string} params.captureDir - Capture directory with `receipts.jsonl`.
 * @param {string} params.outputDir - Track directory (snapshot, hash index, watermark, reports).
 * @param {string} params.name - Snapshot name (for example `tx-comptroller-franchise-tax-travis`).
 * @param {string} [params.scopeLabel] - Human description of the capture's scope.
 * @param {RowFilter | null} [params.rowFilter] - Keep only the rows that pass (for example a county subset).
 * @param {boolean} [params.names] - Build the matcher's collision summary in the report (default true).
 * @param {number} [params.duplicateDetailLimit] - Describe duplicate keys only up to this many (default 50).
 * @param {Buffer | null} [params.recordIdKey] - Record-id key (required by a source with a privacy rule).
 * @param {boolean} [params.allowRekey] - Accept a record-id key other than the one the watermark names (a re-key).
 * @param {string} [params.now] - Merge time (ISO); defaults to the current time.
 * @returns {Promise<Record<string, any>>} The load report (counts and digests only; no rows).
 */
export async function loadSnapshot({ sourceKey, captureDir, outputDir, name, scopeLabel = null, rowFilter = null, names = true, duplicateDetailLimit = 50, recordIdKey = null, allowRekey = false, now = new Date().toISOString() }) {
  const baseSource = getT3Source(sourceKey);
  const dialect = baseSource.csvDialect ?? "rfc4180";
  const startedAt = Date.now();
  await mkdir(outputDir, { recursive: true });
  const selection = await selectCaptureReceipts(captureDir);
  const receipts = selection.receipts;
  if (receipts.length === 0) throw new Error(`${captureDir}: no captured CSV receipts${selection.excluded.length > 0 ? ` (set aside: ${selection.excluded.map((entry) => `${entry.file} ${entry.reason}`).join(", ")})` : ""}`);
  const verified = await verifyCapture(captureDir, receipts);

  // Every file's header and the column set it resolves to; a header no set knows stops here, before any write.
  const headers = [];
  for (const receipt of receipts) headers.push({ file: receipt.file, ...resolveColumnSet(baseSource, await readCsvHeader(path.join(captureDir, receipt.file), dialect)) });
  if (headers.some((header) => JSON.stringify(header.fields) !== JSON.stringify(headers[0].fields))) {
    throw new Error(`${captureDir}: files resolve to different snapshot fields (${[...new Set(headers.map((header) => header.version))].join(", ")}); load them as separate snapshots`);
  }
  const fieldsByHeader = new Map(headers.map((header) => [JSON.stringify(header.printed), header.fields]));
  const fieldsOf = (printed) => {
    const fields = fieldsByHeader.get(JSON.stringify(printed));
    if (!fields) throw new Error(`${sourceKey}: a header changed between the header check and the load`);
    return fields;
  };
  const roles = baseSource.resolveColumns ? baseSource.resolveColumns(headers[0].fields, headers[0].printed) : null;
  /** @type {import("./t3-sources.mjs").T3Source} */
  const source = roles ? { ...baseSource, keyColumns: roles.keyColumns, nameColumns: roles.nameColumns, extraMatchNames: roles.extraMatchNames, matchNameVersion: roles.matchNameVersion, scopeOf: roles.scopeOf } : baseSource;
  /** @type {Set<string>} */
  const withheldIds = new Set();
  let withheldRows = 0;
  const withheldIdOf = source.privacy && recordIdKey ? (row) => withheldRecordIdOf(recordIdKey, source.key, source.privacy.recordKeyColumns.map((column) => row[`${column}${TRIMMED_SUFFIX}`])) : undefined;
  /** @type {{ version: string, header_sha256: string, printed: string[], fields: string[], files: string[] }[]} */
  const columnSets = [];
  for (const header of headers) {
    const set = columnSets.find((candidate) => candidate.header_sha256 === header.header_sha256);
    if (set) set.files.push(header.file);
    else columnSets.push({ version: header.version, header_sha256: header.header_sha256, printed: header.printed, fields: header.fields, files: [header.file] });
  }

  const parquetPath = path.join(outputDir, `${name}.parquet`);
  const hashIndexPath = path.join(outputDir, `${name}.hash-index.json`);
  const watermarkPath = path.join(outputDir, "watermark.json");
  const tombstonePath = path.join(outputDir, `${name}.tombstones.jsonl`);
  const historyDir = path.join(outputDir, "history");
  const capturePath = `${relativeToRuntime(captureDir)}/`;
  const currentIndex = receipts.map((receipt) => ({ path: `${capturePath}${receipt.file}`, artifact_hash: receipt.sha256, bytes: receipt.bytes, rows: receipt.rows ?? null, fetched_at: receipt.fetched_at }));
  const filterLabel = rowFilter?.label ?? null;

  /** @type {Record<string, any>} */
  const watermark = existsSync(watermarkPath) ? JSON.parse(await readFile(watermarkPath, "utf8")) : { track: source.track, county: "travis", entries: {} };
  if (watermark.track !== source.track) throw new Error(`${watermarkPath} is the ${watermark.track} track, source ${sourceKey} is ${source.track}`);
  const prior = watermark.entries[name] ?? null;
  // Withheld rows are keyed by the record-id key: a missing key stops, and so does another key than the watermark's.
  const keyFingerprint = baseSource.privacy ? (recordIdKey ? recordIdKeyFingerprint(recordIdKey) : null) : null;
  if (baseSource.privacy && !recordIdKey) throw new Error(`${sourceKey} withholds values and needs the record-id key (node src/counties/travis/t3-record-id-key.mjs init; decisions.md section 24.2)`);
  if (keyFingerprint && prior?.record_id_key_fingerprint && prior.record_id_key_fingerprint !== keyFingerprint && !allowRekey) {
    throw new Error(`${name}: the record-id key changed (watermark ${prior.record_id_key_fingerprint}, now ${keyFingerprint}); restore the key, or re-key on purpose with allowRekey`);
  }
  const priorIndex = existsSync(hashIndexPath) ? JSON.parse(await readFile(hashIndexPath, "utf8")) : [];
  const covered = new Set(priorIndex.map((entry) => `${entry.path}\u0000${entry.artifact_hash}`));
  const uncovered = currentIndex.filter((entry) => !covered.has(`${entry.path}\u0000${entry.artifact_hash}`));
  const filterUnchanged = (prior?.row_filter ?? null) === filterLabel;
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
  /** @type {Record<string, number>} */
  const filteredOutByScope = {};
  /** Source columns of the new rows of keys whose rows differ from the prior snapshot's. */
  /** @type {Map<string, Record<string, unknown>[]>} */
  const changedNextRows = new Map();
  const nameRows = [];
  let rowsKept = 0;
  let columns = null;
  let writer = null;
  const openWriter = async (header) => {
    columns = header;
    writer = await ParquetWriter.openFile(new ParquetSchema(snapshotSchemaFields(header, { privacy: Boolean(source.privacy) })), temporaryPath, { rowGroupSize: ROW_GROUP_SIZE });
    writer.setMetadata("t3.source", source.key);
    writer.setMetadata("t3.dataset", source.dataset);
    writer.setMetadata("t3.normalizer_version", NORMALIZER_VERSION);
    writer.setMetadata("t3.capture_artifact_hash", hashIndexDigest(currentIndex));
    if (filterLabel !== null) writer.setMetadata("t3.row_filter", filterLabel);
    if (source.privacy) writer.setMetadata("t3.privacy_version", source.privacy.version);
    if (source.columnSets) writer.setMetadata("t3.column_sets", JSON.stringify(columnSets.map((set) => ({ version: set.version, header_sha256: set.header_sha256 }))));
  };
  const streamed = await streamCaptureRows(
    captureDir,
    receipts,
    async (row, header) => {
      if (writer === null) await openWriter(header);
      const scope = source.scopeOf(row);
      if (rowFilter && !rowFilter.test(row)) {
        filteredOutByScope[scope] = (filteredOutByScope[scope] ?? 0) + 1;
        return;
      }
      rowsKept += 1;
      if (row._withheld_record_id) {
        withheldRows += 1;
        withheldIds.add(row._withheld_record_id);
      }
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
      const priorHashes = previousKeys.get(key);
      if (priorHashes && !priorHashes.includes(row._row_sha256)) changedNextRows.set(key, [...(changedNextRows.get(key) ?? []), Object.fromEntries(header.map((column) => [column, row[column] ?? null]))]);
      for (const column of source.distributionColumns) {
        const value = row[`${column}${TRIMMED_SUFFIX}`] ?? "(null)";
        distributions[column].set(value, (distributions[column].get(value) ?? 0) + 1);
      }
      scopes[scope] = (scopes[scope] ?? 0) + 1;
      if (names && source.nameColumns.length > 0) nameRows.push({ __key: key, __scope: scope, __names: matchNamesOf(source, row) });
    },
    { dialect, privacy: source.privacy, fieldsOf, withheldIdOf },
  );
  if (writer === null) await openWriter(streamed.columns);
  await writer.close();
  for (const list of nextKeys.values()) list.sort();
  const snapshotColumns = columns ?? streamed.columns;

  const diff = diffKeys(previousKeys, nextKeys);
  // A removed key whose every row is still in the capture under another key was re-keyed, not removed from the source.
  const nextHashes = new Set([...nextKeys.values()].flat());
  const rekeyedKeys = new Set(diff.removedKeys.filter((key) => (previousKeys.get(key) ?? []).every((hash) => nextHashes.has(hash))));
  const unchangedCapture = snapshotIntact && filterUnchanged && uncovered.length === 0 && diff.new === 0 && diff.changed === 0 && diff.removed === 0;
  let merged = false;
  /** Digest of the snapshot this load rebuilt; on a no-op re-load it must equal the snapshot on disk (determinism). */
  const rebuiltSha256 = sha256Hex(await readFile(temporaryPath));
  /** @type {{ path: string, sha256: string, hash_index_path: string | null } | null} */
  let priorSnapshot = null;
  // Changed keys: compare the prior rows column by column before the prior snapshot is moved away. Keys with one row on
  // both sides are compared; keys with several rows on either side are counted only.
  let multiRowChanged = 0;
  for (const key of [...changedNextRows.keys()]) {
    const priorHashes = previousKeys.get(key) ?? [];
    const nextHashes = nextKeys.get(key) ?? [];
    if (priorHashes.join(",") === nextHashes.join(",")) changedNextRows.delete(key);
    else if (priorHashes.length !== 1 || nextHashes.length !== 1) {
      multiRowChanged += 1;
      changedNextRows.delete(key);
    }
  }
  const changedColumns =
    diff.changed > 0
      ? { ...changedColumnCounts(await readSnapshotRows(source, parquetPath, new Set(changedNextRows.keys()), snapshotColumns), changedNextRows, snapshotColumns), multi_row_keys: multiRowChanged }
      : null;
  if (unchangedCapture) {
    await rm(temporaryPath, { force: true });
  } else {
    if (existsSync(parquetPath)) {
      // Keep the replaced snapshot and its hash index (no snapshot is ever lost).
      const replacedSha256 = sha256Hex(await readFile(parquetPath));
      await mkdir(historyDir, { recursive: true });
      const historyParquet = path.join(historyDir, `${name}.${replacedSha256.slice(0, 16)}.parquet`);
      await rename(parquetPath, historyParquet);
      let historyIndex = null;
      if (existsSync(hashIndexPath)) {
        historyIndex = path.join(historyDir, `${name}.${replacedSha256.slice(0, 16)}.hash-index.json`);
        await writeFile(historyIndex, await readFile(hashIndexPath));
      }
      priorSnapshot = { path: relativeToRuntime(historyParquet), sha256: replacedSha256, hash_index_path: historyIndex ? relativeToRuntime(historyIndex) : null };
    }
    await rename(temporaryPath, parquetPath);
    merged = true;
  }
  const snapshotBytes = await readFile(parquetPath);
  const snapshot = { path: relativeToRuntime(parquetPath), sha256: sha256Hex(snapshotBytes), bytes: snapshotBytes.length, rows: rowsKept };

  if (merged) {
    for (const key of diff.removedKeys) {
      await appendFile(tombstonePath, `${JSON.stringify({ key, reason: rekeyedKeys.has(key) ? "rekeyed" : "absent_from_capture", row_sha256: previousKeys.get(key), removed_at: now, capture_artifact_hash: hashIndexDigest(currentIndex) })}\n`);
    }
    const hashIndex = currentIndex.map((entry) => ({ ...entry, merged_at: now }));
    await writeFile(hashIndexPath, `${JSON.stringify(hashIndex, null, 1)}\n`);
    watermark.entries[name] = {
      track: source.track,
      source: source.key,
      dataset: source.dataset,
      scope: scopeLabel,
      ...(filterLabel !== null ? { row_filter: filterLabel } : {}),
      path: capturePath,
      artifact_hash: hashIndexDigest(currentIndex),
      merged_count: currentIndex.length,
      merged_rows: rowsKept,
      last_merged_at: now,
      hash_index_path: relativeToRuntime(hashIndexPath),
      snapshot,
      normalizer_version: NORMALIZER_VERSION,
      ...(keyFingerprint ? { record_id_version: RECORD_ID_VERSION, record_id_key_fingerprint: keyFingerprint } : {}),
    };
    await writeFile(watermarkPath, `${JSON.stringify(watermark, null, 1)}\n`);
  }

  // Duplicate keys: which columns differ between their rows (values only for code and date columns).
  const duplicateKeys = [...nextKeys.entries()].filter(([key, hashes]) => hashes.length > 1 && !key.startsWith("row:"));
  const duplicates = [];
  if (duplicateKeys.length > 0 && duplicateKeys.length <= duplicateDetailLimit) {
    const wanted = new Set(duplicateKeys.map(([key]) => key));
    /** @type {Map<string, Record<string, any>[]>} */
    const rowsByKey = new Map();
    await streamCaptureRows(
      captureDir,
      receipts,
      (row) => {
        if (rowFilter && !rowFilter.test(row)) return;
        const key = entityKeyOf(source, row);
        if (wanted.has(key)) rowsByKey.set(key, [...(rowsByKey.get(key) ?? []), row]);
      },
      { dialect, privacy: source.privacy, fieldsOf, withheldIdOf },
    );
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
    names && source.nameColumns.length > 0
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
    row_filter: filterLabel,
    normalizer_version: NORMALIZER_VERSION,
    csv_dialect: dialect,
    loaded_at: now,
    capture: {
      path: capturePath,
      files: verified.length,
      bytes: verified.reduce((sum, file) => sum + file.bytes, 0),
      verified_against_receipts: true,
      artifact_hash: hashIndexDigest(currentIndex),
      rows: streamed.rows,
      lenient_rows: streamed.lenientRows,
      files_detail: verified.map((file) => ({ ...file, rows_parsed: streamed.rowsByFile[file.file] })),
      set_aside: selection.excluded,
    },
    columns: { source: snapshotColumns, count: snapshotColumns.length, snapshot: Object.keys(snapshotSchemaFields(snapshotColumns, { privacy: Boolean(source.privacy) })).length },
    column_sets: columnSets,
    resolved_columns: roles ? { key_columns: roles.keyColumns, name_columns: roles.nameColumns, match_name_version: roles.matchNameVersion ?? null, roles: roles.roles } : null,
    privacy: source.privacy
      ? {
          version: source.privacy.version,
          withheld_columns: source.privacy.withheldColumns,
          rows_by_class: streamed.withheld,
          row_sha256_basis: "classed rows: the captured row with the withheld cells emptied",
          record_id: `${RECORD_ID_VERSION}: classed rows carry _withheld_record_id = HMAC-SHA256 under the record-id key over the printed key (${source.privacy.recordKeyColumns.join(", ")}), first 32 hex characters`,
          record_id_key_fingerprint: keyFingerprint,
          withheld_record_ids: { rows: withheldRows, distinct: withheldIds.size, shared_by_several_rows: withheldRows - withheldIds.size },
        }
      : null,
    counts: {
      rows: rowsKept,
      rows_filtered_out: streamed.rows - rowsKept,
      filtered_out_by_scope: Object.fromEntries(Object.entries(filteredOutByScope).sort(([a], [b]) => a.localeCompare(b))),
      distinct_keys: [...nextKeys.keys()].filter((key) => !key.startsWith("row:")).length,
      rows_without_key: [...nextKeys.keys()].filter((key) => key.startsWith("row:")).length,
      duplicate_keys: duplicateKeys.length,
      rows_under_duplicate_keys: duplicateKeys.reduce((sum, [, hashes]) => sum + hashes.length, 0),
      present_non_blank: Object.fromEntries(snapshotColumns.map((column) => [column, presence[column] ?? 0])),
      by_scope: Object.fromEntries(Object.entries(scopes).sort(([a], [b]) => a.localeCompare(b))),
      distributions: Object.fromEntries(Object.entries(distributions).map(([column, values]) => [column, Object.fromEntries([...values.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))])),
    },
    duplicates,
    duplicates_described: duplicateKeys.length <= duplicateDetailLimit,
    names: nameSummary,
    diff: { against: snapshotIntact ? "snapshot on disk" : "nothing (first load)", new: diff.new, changed: diff.changed, unchanged: diff.unchanged, removed: diff.removed, rekeyed: rekeyedKeys.size, tombstoned: merged ? diff.removed : 0 },
    changed_columns: changedColumns,
    hash_index: { entries: currentIndex.length, uncovered_before_load: uncovered.length },
    merged,
    merge_reason: merged
      ? !snapshotIntact
        ? prior !== null
          ? "snapshot on disk did not match the watermark"
          : "first load"
        : [
            ...(uncovered.length > 0 ? [`${uncovered.length} capture artifacts not in the hash index`] : []),
            ...(diff.new + diff.changed + diff.removed > 0 ? ["content diff"] : []),
            ...(filterUnchanged ? [] : ["row filter changed"]),
          ].join("; ")
      : "the hash index covers every (path, artifact hash) and the content diff is empty",
    prior_snapshot: priorSnapshot,
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
