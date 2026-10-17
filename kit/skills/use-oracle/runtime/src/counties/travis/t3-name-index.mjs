/**
 * Persisted normalized-name indexes for the matcher `travis-exact-unique-normalized-name.v1` (assignment
 * decisions.md section 23). Each index is built offline from one private snapshot with the matcher's own
 * `buildNameIndex`, so its uniqueness decisions are the matcher's; it is written as a deterministic private Parquet
 * (one row per normalized name and entity key, sorted) that `readNameIndex` turns back into an index `matchName`
 * accepts. The franchise-tax index is statewide: it is the matching universe, and a Travis name that a taxpayer
 * elsewhere in Texas shares yields no candidate.
 *
 * Collision counts are recorded statewide and for Travis two ways: names shared by several Travis keys (Travis alone)
 * and Travis keys whose name is shared anywhere in the universe (what decides a Travis candidate).
 *
 * The index is internal reconciliation state, like the snapshots: never uploaded, never an Atlas or MCP source.
 *
 * @module counties/travis/t3-name-index
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ParquetReader, ParquetSchema, ParquetWriter } from "@dsnp/parquetjs";

import { MATCHER_VERSION, buildNameIndex, summarizeNameIndex } from "./name-matcher.mjs";
import { entityKeyOf } from "./t3-snapshot.mjs";
import { getT3Source, matchNamesOf } from "./t3-sources.mjs";

export const INDEX_FORMAT_VERSION = "travis-t3-name-index.v1";
const RUNTIME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const relative = (target) => path.relative(RUNTIME_ROOT, path.resolve(target)).split(path.sep).join("/");
const SUFFIX = "__trimmed";

/**
 * @typedef {object} IndexSpec
 * @property {string} name - Index name (file stem).
 * @property {string} sourceKey - Source key.
 * @property {"registry" | "licensing"} track - Track directory holding the snapshot.
 * @property {string} snapshot - Snapshot name.
 * @property {"taxpayer" | undefined} [keyOn] - `taxpayer`: key sales-tax rows on the taxpayer, not the outlet.
 * @property {string} universe - What the index's uniqueness is decided over.
 */

/** @type {readonly IndexSpec[]} */
export const NAME_INDEXES = Object.freeze([
  { name: "tx-comptroller-franchise-tax-statewide", sourceKey: "tx-comptroller-franchise-tax", track: "registry", snapshot: "tx-comptroller-franchise-tax-statewide", universe: "statewide active franchise taxpayers (the private matching universe)" },
  { name: "tx-comptroller-sales-tax-travis", sourceKey: "tx-comptroller-sales-tax", track: "registry", snapshot: "tx-comptroller-sales-tax-travis", keyOn: "taxpayer", universe: "Travis sales-tax outlets, keyed on the taxpayer (a sole owner, whose number is withheld, is keyed per outlet)" },
  { name: "tx-sos-veteran-owned-business", sourceKey: "tx-sos-veteran-owned-business", track: "registry", snapshot: "tx-sos-veteran-owned-business", universe: "statewide SOS veteran-owned entities" },
  { name: "tdlr-license-files", sourceKey: "tdlr-license-files", track: "licensing", snapshot: "tdlr-license-files", universe: "statewide TDLR electrical and A/C licenses" },
  { name: "tsbpe-responsible-master-plumber", sourceKey: "tsbpe-responsible-master-plumber", track: "licensing", snapshot: "tsbpe-responsible-master-plumber", universe: "statewide TSBPE Responsible Master Plumbers" },
  { name: "austin-row-contractor-licenses", sourceKey: "austin-row-contractor-licenses", track: "licensing", snapshot: "austin-row-contractor-licenses", universe: "City of Austin right-of-way contractor licenses" },
]);

/**
 * Build an index from a snapshot, streaming only the columns it needs.
 *
 * @param {IndexSpec} spec - Index definition.
 * @param {string} parquetPath - Snapshot path.
 * @returns {Promise<import("./name-matcher.mjs").NameIndex>} The index.
 */
export async function buildIndexFromSnapshot(spec, parquetPath) {
  let source = getT3Source(spec.sourceKey);
  const reader = await ParquetReader.openFile(parquetPath);
  try {
    const schemaFields = Object.keys(reader.getSchema().fields);
    if (source.resolveColumns) {
      // Columns resolved from the header at load time: resolve them again from the snapshot's fields.
      const fields = schemaFields.filter((field) => !field.startsWith("_") && !field.endsWith(SUFFIX));
      const roles = source.resolveColumns(fields, fields);
      source = { ...source, keyColumns: roles.keyColumns, nameColumns: roles.nameColumns, extraMatchNames: roles.extraMatchNames, matchNameVersion: roles.matchNameVersion, scopeOf: roles.scopeOf };
    }
    const cursor = reader.getCursor(schemaFields.filter((field) => field.endsWith(SUFFIX) || field === "_row_sha256").map((field) => [field]));
    const rows = [];
    let record = await cursor.next();
    while (record) {
      const row = /** @type {Record<string, unknown>} */ (record);
      const key = spec.keyOn === "taxpayer" ? (row.taxpayer_number__trimmed ? String(row.taxpayer_number__trimmed) : `row:${row._row_sha256}`) : entityKeyOf(source, row);
      const names = matchNamesOf(source, row);
      rows.push({ __key: key, __scope: source.scopeOf(row), ...Object.fromEntries(names.map((text, index) => [`__name_${index}`, text])) });
      record = await cursor.next();
    }
    const width = rows.reduce((most, row) => Math.max(most, Object.keys(row).length - 2), 0);
    return buildNameIndex(rows, { source: spec.sourceKey, nameFields: Array.from({ length: width }, (_, index) => `__name_${index}`), keyOf: (row) => String(row.__key), scopeOf: (row) => String(row.__scope) });
  } finally {
    await reader.close();
  }
}

/**
 * Collision counts of an index: the matcher's summary for the whole universe, and two views of Travis.
 *
 * @param {import("./name-matcher.mjs").NameIndex} index - Index.
 * @param {string} [travisScope] - Scope label of Travis rows.
 * @returns {Record<string, any>} Counts only.
 */
export function collisionSummary(index, travisScope = "travis") {
  let travisNames = 0;
  let travisNamesSharedWithinTravis = 0;
  let travisKeysUnderNamesSharedWithinTravis = 0;
  let travisNamesUniqueInUniverse = 0;
  let travisNamesSharedInUniverse = 0;
  let travisNamesSharedOnlyWithinTravis = 0;
  let travisNamesSharedWithOutOfCounty = 0;
  /** @type {Set<string>} */
  const travisKeys = new Set();
  /** @type {Set<string>} */
  const travisKeysWithUniqueName = new Set();
  /** @type {Set<string>} */
  const travisKeysWithSharedName = new Set();
  let outOfCountyUniqueNames = 0;
  for (const byKey of index.names.values()) {
    const entries = [...byKey.values()];
    const travis = entries.filter((entry) => entry.scope === travisScope);
    if (travis.length === 0) {
      if (entries.length === 1) outOfCountyUniqueNames += 1;
      continue;
    }
    travisNames += 1;
    for (const entry of travis) travisKeys.add(entry.key);
    if (travis.length > 1) {
      travisNamesSharedWithinTravis += 1;
      travisKeysUnderNamesSharedWithinTravis += travis.length;
    }
    if (entries.length === 1) {
      travisNamesUniqueInUniverse += 1;
      travisKeysWithUniqueName.add(entries[0].key);
    } else {
      travisNamesSharedInUniverse += 1;
      for (const entry of travis) travisKeysWithSharedName.add(entry.key);
      if (travis.length === entries.length) travisNamesSharedOnlyWithinTravis += 1;
      else travisNamesSharedWithOutOfCounty += 1;
    }
  }
  return {
    universe: summarizeNameIndex(index),
    travis_alone: { normalized_names: travisNames, non_unique_names: travisNamesSharedWithinTravis, keys_under_non_unique_names: travisKeysUnderNamesSharedWithinTravis },
    travis_in_universe: {
      travis_keys: travisKeys.size,
      normalized_names_held_by_travis_keys: travisNames,
      names_unique_in_universe: travisNamesUniqueInUniverse,
      names_shared_in_universe: travisNamesSharedInUniverse,
      names_shared_only_within_travis: travisNamesSharedOnlyWithinTravis,
      names_shared_with_an_out_of_county_key: travisNamesSharedWithOutOfCounty,
      travis_keys_with_a_unique_name: travisKeysWithUniqueName.size,
      travis_keys_with_a_shared_name: travisKeysWithSharedName.size,
      travis_keys_with_a_unique_and_a_shared_name: [...travisKeysWithUniqueName].filter((key) => travisKeysWithSharedName.has(key)).length,
    },
    out_of_county_unique_names: outOfCountyUniqueNames,
  };
}

/**
 * Write an index as a deterministic Parquet; the file is replaced only when its bytes change (the old one is kept).
 *
 * @param {import("./name-matcher.mjs").NameIndex} index - Index.
 * @param {string} outputPath - Parquet path.
 * @param {Record<string, string>} metadata - Key-value metadata (input digests).
 * @returns {Promise<{ path: string, sha256: string, rows: number, written: boolean, unchanged: boolean }>} Output.
 */
export async function writeNameIndex(index, outputPath, metadata) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const schema = new ParquetSchema({
    normalized_name: { type: "UTF8", compression: "SNAPPY" },
    entity_key: { type: "UTF8", compression: "SNAPPY" },
    scope: { type: "UTF8", compression: "SNAPPY" },
    printed_names: { type: "UTF8", compression: "SNAPPY" },
    rows: { type: "INT64", compression: "SNAPPY" },
    keys_under_name: { type: "INT64", compression: "SNAPPY" },
  });
  const temporary = `${outputPath}.tmp-${process.pid}`;
  const writer = await ParquetWriter.openFile(schema, temporary, { rowGroupSize: 100_000 });
  writer.setMetadata("t3.index_format_version", INDEX_FORMAT_VERSION);
  writer.setMetadata("t3.matcher_version", index.matcher_version);
  writer.setMetadata("t3.source", index.source);
  for (const [key, value] of Object.entries(metadata)) writer.setMetadata(`t3.${key}`, value);
  const names = [...index.names.keys()].sort();
  let rows = 0;
  for (const name of names) {
    const byKey = /** @type {Map<string, import("./name-matcher.mjs").IndexEntry>} */ (index.names.get(name));
    for (const key of [...byKey.keys()].sort()) {
      const entry = /** @type {import("./name-matcher.mjs").IndexEntry} */ (byKey.get(key));
      await writer.appendRow({ normalized_name: name, entity_key: key, scope: entry.scope, printed_names: JSON.stringify(entry.printed_names), rows: BigInt(entry.rows), keys_under_name: BigInt(byKey.size) });
      rows += 1;
    }
  }
  await writer.close();
  const rebuilt = sha256Hex(await readFile(temporary));
  const existing = existsSync(outputPath) ? sha256Hex(await readFile(outputPath)) : null;
  if (existing === rebuilt) {
    await rm(temporary, { force: true });
    return { path: relative(outputPath), sha256: rebuilt, rows, written: false, unchanged: true };
  }
  if (existing !== null) await rename(outputPath, outputPath.replace(/\.parquet$/, `.${existing.slice(0, 16)}.replaced.parquet`));
  await rename(temporary, outputPath);
  return { path: relative(outputPath), sha256: rebuilt, rows, written: true, unchanged: false };
}

/**
 * Read a persisted index back into the form `matchName` takes.
 *
 * @param {string} parquetPath - Index Parquet.
 * @returns {Promise<import("./name-matcher.mjs").NameIndex>} The index (payloads are empty).
 */
export async function readNameIndex(parquetPath) {
  const reader = await ParquetReader.openFile(parquetPath);
  try {
    const metadata = reader.getMetadata();
    if (metadata["t3.matcher_version"] !== MATCHER_VERSION) throw new Error(`${parquetPath}: built by matcher ${metadata["t3.matcher_version"]}, this is ${MATCHER_VERSION}`);
    /** @type {Map<string, Map<string, import("./name-matcher.mjs").IndexEntry>>} */
    const names = new Map();
    const cursor = reader.getCursor();
    let record = await cursor.next();
    while (record) {
      const byKey = names.get(String(record.normalized_name)) ?? new Map();
      byKey.set(String(record.entity_key), { key: String(record.entity_key), scope: String(record.scope), printed_names: JSON.parse(String(record.printed_names)), rows: Number(record.rows), payload: {} });
      names.set(String(record.normalized_name), byKey);
      record = await cursor.next();
    }
    return { matcher_version: MATCHER_VERSION, source: String(metadata["t3.source"]), names, rows_indexed: Number(metadata["t3.rows_indexed"] ?? 0), rows_without_name: Number(metadata["t3.rows_without_name"] ?? 0) };
  } finally {
    await reader.close();
  }
}

/**
 * Build, persist and summarize one index.
 *
 * @param {IndexSpec} spec - Index definition.
 * @param {{ registryDir: string, licensingDir: string, matcherDir: string }} dirs - Directories.
 * @returns {Promise<Record<string, any> | null>} Report, or null when the snapshot does not exist yet.
 */
export async function buildAndWriteIndex(spec, { registryDir, licensingDir, matcherDir }) {
  const snapshot = path.join(spec.track === "registry" ? registryDir : licensingDir, `${spec.snapshot}.parquet`);
  if (!existsSync(snapshot)) return null;
  const started = Date.now();
  const index = await buildIndexFromSnapshot(spec, snapshot);
  const summary = collisionSummary(index);
  const snapshotSha256 = sha256Hex(await readFile(snapshot));
  const output = await writeNameIndex(index, path.join(matcherDir, `${spec.name}.names.parquet`), { snapshot_sha256: snapshotSha256, rows_indexed: String(index.rows_indexed), rows_without_name: String(index.rows_without_name) });
  return { index: spec.name, source: spec.sourceKey, universe: spec.universe, key_on: spec.keyOn ?? "record key", matcher_version: MATCHER_VERSION, format_version: INDEX_FORMAT_VERSION, snapshot: { path: relative(snapshot), sha256: snapshotSha256 }, ...summary, output, duration_seconds: Math.round((Date.now() - started) / 100) / 10 };
}

