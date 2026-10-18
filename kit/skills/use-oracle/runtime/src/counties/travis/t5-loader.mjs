/**
 * T5 Loader (assignment decisions.md section 6 "Loader state per track"; kit `query-db-loading-matching` "Single writer
 * and idempotency", "Artifact scope and ready gate", "Content-aware watermarks", "Tombstones"; `api-contract.md` Run
 * `loader_watermarks[]` and `tombstones_consumed`). The Travis v1 internal store is file-based (`travis-sources.yaml`
 * `destination.mode`: Parquet and JSON under the gitignored `data/`; no `DATABASE_URL`), so the Loader is one writer per
 * county and scope over a directory, never a public source:
 *
 *   data/travis/loader/<scope>/
 *     merges/<run_id>/<shard>.json   one record per shard merge (written atomically, as each shard completes)
 *     generations/<run_id>/          the consolidated state a finalize writes: hash indexes, watermark, tombstones, tables
 *     CURRENT                        the generation in force (replaced atomically: the watermark moves with the merge)
 *     loads.jsonl                    one line per finalize (the internal run history: timestamps, deltas, tombstones)
 *
 * - **Ready gate.** A shard's ready parcels are named by its appraisal done-marker with each parcel's artifact hash (the
 *   SHA-256 over its `data/` files); the merge recomputes every hash from disk and refuses the shard on a mismatch, so a
 *   partially regenerated output never loads. One sweep over the shard markers, no per-parcel status files.
 * - **Watermarks.** Per track and source prefix (`appraisal` parcel groups, `permits` capture partitions and permit
 *   groups): `path`, `artifact_hash` (SHA-256 over the sorted `(key, path, artifact hash)` index, so a corrected in-place
 *   output with a new hash reloads), `merged_count`, `merged_rows`, `last_merged_at`, `hash_index_path`.
 * - **Tombstones.** Dead (permanent appraisal failure) and invalid (failed `elephant-cli validate`) parcels, and keys a
 *   prior generation held that this run no longer produces, are tombstoned with their evidence and terminal reason; a
 *   stale row of a prior generation is dropped from the new one in the same atomic finalize.
 * - **Idempotent.** Re-merging the same shard writes nothing new; finalizing the same merges again gives the same
 *   generation (its digest is recorded), and the watermark does not move.
 *
 * @module counties/travis/t5-loader
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, link, mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { ParquetSchema, ParquetWriter } from "@dsnp/parquetjs";

import { RUNTIME_ROOT } from "./t3-snapshot.mjs";
import { atomicWrite, dataDirDigest, digestOf, readLines, sha256File } from "./t5-shards.mjs";

export const LOADER_VERSION = "travis-t5-loader.v1";
export const DEFAULT_LOADER_ROOT = path.join(RUNTIME_ROOT, "data", "travis", "loader");

const rel = (target) => path.relative(RUNTIME_ROOT, target).split(path.sep).join("/");
const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");

/**
 * The digest of a hash index (`{key: [path, artifact_hash]}`), over the sorted triples.
 *
 * @param {Record<string, [string, string]>} index - Index.
 * @returns {string} Hex digest.
 */
export function indexDigest(index) {
  return sha256Hex(JSON.stringify(Object.keys(index).sort().map((key) => [key, index[key][0], index[key][1]])));
}

/**
 * Verify a shard's ready parcels against their data directories (the ready-hash gate).
 *
 * @param {{ key: string, dir: string, artifact_hash: string }[]} ready - Ready parcels (absolute `dir`).
 * @returns {Promise<{ ok: boolean, mismatches: string[] }>} Verdict.
 */
export async function verifyReadyGate(ready) {
  const mismatches = [];
  for (const item of ready) {
    if (!existsSync(item.dir)) mismatches.push(`${item.key}: ${rel(item.dir)} missing`);
    else if ((await dataDirDigest(item.dir)) !== item.artifact_hash) mismatches.push(`${item.key}: artifact hash differs from the ready marker`);
  }
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * Record one shard's merge (single writer: the runner serializes calls). Idempotent: an identical record is not rewritten.
 *
 * @param {object} options - Options.
 * @param {string} options.loaderDir - `data/travis/loader/<scope>`.
 * @param {string} options.runId - Run id.
 * @param {string} options.shard - Shard id.
 * @param {{ key: string, dir: string, artifact_hash: string }[]} options.ready - Ready appraisal parcels (verified here).
 * @param {{ key: string, reason: string, evidence: string | null }[]} options.dead - Dead parcels.
 * @param {{ key: string, reason: string, evidence: string | null }[]} options.invalid - Invalid parcels.
 * @param {{ key: string, reason: string, evidence: string | null }[]} options.retryable - Retryable parcels (not loaded; retried by a resume).
 * @param {{ key: string, dir: string, artifact_hash: string, permits: number }[]} options.permitGroups - Parcels with a published Property Improvement group.
 * @param {Record<string, { file: string, rows: number }>} options.tables - Internal table parts of the shard (absolute `file`).
 * @returns {Promise<{ record: Record<string, any>, written: boolean }>} The merge record.
 */
export async function recordShardMerge({ loaderDir, runId, shard, ready, dead, invalid, retryable, permitGroups, tables }) {
  const gate = await verifyReadyGate(ready);
  if (!gate.ok) throw new Error(`loader: shard ${shard} fails the ready-hash gate: ${gate.mismatches.slice(0, 3).join("; ")}`);
  const permitGate = await verifyReadyGate(permitGroups);
  if (!permitGate.ok) throw new Error(`loader: shard ${shard} permit groups fail the ready-hash gate: ${permitGate.mismatches.slice(0, 3).join("; ")}`);
  const tableEntries = {};
  for (const [name, table] of Object.entries(tables)) tableEntries[name] = { file: rel(table.file), sha256: await sha256File(table.file), rows: table.rows };
  const body = {
    version: LOADER_VERSION,
    run_id: runId,
    shard,
    appraisal: {
      ready: ready.map((item) => ({ key: item.key, path: rel(item.dir), artifact_hash: item.artifact_hash })),
      dead,
      invalid,
      retryable,
    },
    permits: { groups: permitGroups.map((item) => ({ key: item.key, path: rel(item.dir), artifact_hash: item.artifact_hash, permits: item.permits })) },
    tables: tableEntries,
  };
  const file = path.join(loaderDir, "merges", runId, `${shard}.json`);
  const digest = digestOf(body);
  if (existsSync(file)) {
    const prior = JSON.parse(await readFile(file, "utf8"));
    if (prior.digest === digest) return { record: prior, written: false };
  }
  const record = { ...body, digest, merged_at: new Date().toISOString() };
  await atomicWrite(file, `${JSON.stringify(record)}\n`);
  return { record, written: true };
}

/**
 * The generation in force (null before the first finalize).
 *
 * @param {string} loaderDir - Loader directory.
 * @returns {Promise<{ id: string, dir: string, state: Record<string, any> } | null>} Generation.
 */
export async function currentGeneration(loaderDir) {
  const pointer = path.join(loaderDir, "CURRENT");
  if (!existsSync(pointer)) return null;
  const id = (await readFile(pointer, "utf8")).trim();
  const dir = path.join(loaderDir, "generations", id);
  return { id, dir, state: JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")) };
}

/** Columns of the internal permits table (one row per captured permit, linked or not). */
export const PERMITS_TABLE_FIELDS = Object.freeze(
  Object.fromEntries(
    [
      "permit_key",
      "permit_number",
      "row_sha256",
      "capture_file",
      "fetched_at",
      "permittype",
      "permit_class",
      "work_class",
      "status_current",
      "status_group",
      "lifecycle_status",
      "roof_work_class",
      "completed_date_evidence",
      "tcad_id",
      "tcad_id_evidence",
      "property_id",
      "match_method",
      "link_confidence",
      "unlinked_reason",
      "applieddate",
      "issue_date",
      "completed_date",
      "expiresdate",
      "statusdate",
      "jurisdiction",
    ]
      .map((name) => [name, { type: "UTF8", optional: true }])
      .concat([
        ["capture_row_index", { type: "INT64", optional: true }],
        ["is_roofing", { type: "BOOLEAN", optional: true }],
        ["is_reroof", { type: "BOOLEAN", optional: true }],
      ]),
  ),
);

/**
 * Write the internal permits table from the link pass's rows (`permits-internal.jsonl`), and the permits key index.
 *
 * @param {string} rowsFile - JSONL, one internal row per captured permit.
 * @param {string} parquetPath - Destination.
 * @returns {Promise<{ rows: number, sha256: string, index: Record<string, string>, linked: number, unlinked: number }>} Table.
 */
export async function writePermitsTable(rowsFile, parquetPath) {
  await mkdir(path.dirname(parquetPath), { recursive: true });
  const partial = `${parquetPath}.partial`;
  const writer = await ParquetWriter.openFile(new ParquetSchema(structuredClone(PERMITS_TABLE_FIELDS)), partial);
  /** @type {Record<string, string>} */
  const index = {};
  let rows = 0;
  let linked = 0;
  try {
    for await (const line of readLines(rowsFile)) {
      const row = JSON.parse(line);
      rows += 1;
      if (row.property_id) linked += 1;
      index[row.permit_key] = row.row_sha256;
      const record = {};
      for (const [name, spec] of Object.entries(PERMITS_TABLE_FIELDS)) {
        const value = row[name];
        if (value === null || value === undefined || value === "") continue;
        record[name] = spec.type === "INT64" ? BigInt(value) : spec.type === "BOOLEAN" ? Boolean(value) : String(value);
      }
      await writer.appendRow(record);
    }
  } finally {
    await writer.close();
  }
  await rename(partial, parquetPath);
  return { rows, sha256: await sha256File(parquetPath), index, linked, unlinked: rows - linked };
}

/**
 * Hard-link (or keep) a table part inside a generation, named by its content.
 *
 * @param {string} source - Absolute source file.
 * @param {string} dir - Destination directory.
 * @param {string} name - Base name.
 * @param {string} sha256 - Its digest.
 * @returns {Promise<string>} Destination path.
 */
async function placePart(source, dir, name, sha256) {
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, `${name}.${sha256.slice(0, 16)}${path.extname(source)}`);
  if (!existsSync(target)) await link(source, target);
  return target;
}

/** @param {Record<string, [string, string]>} prior @param {Record<string, [string, string]>} next */
function diffIndexes(prior, next) {
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  for (const [key, [, hash]] of Object.entries(next)) {
    const before = prior[key];
    if (!before) added += 1;
    else if (before[1] === hash) unchanged += 1;
    else changed += 1;
  }
  const removed = Object.keys(prior).filter((key) => !Object.hasOwn(next, key));
  return { new: added, changed, unchanged, removed: removed.length, removedKeys: removed };
}

/**
 * Finalize a run's load: consolidate this run's shard merges into a new generation, compare it with the generation in
 * force (deltas), write the tombstones, the internal tables and the watermarks, and move `CURRENT` atomically.
 *
 * @param {object} options - Options.
 * @param {string} options.loaderDir - Loader directory.
 * @param {string} options.runId - Run id.
 * @param {string} options.runDir - The run directory (the watermarks' path prefix).
 * @param {string[]} options.shards - Every shard of the plan (all must have a merge record).
 * @param {boolean} options.wholeSeed - Whether the plan covers the whole seed (only then is a key absent from this run tombstoned as gone).
 * @param {{ dir: string, partitions: { file: string, sha256: string, rows: number }[] }} options.capture - The permit capture's partitions.
 * @param {string} options.permitsRowsFile - The link pass's internal rows (JSONL).
 * @returns {Promise<Record<string, any>>} What the run record carries (`loader_watermarks`, `tombstones_consumed`, `deltas`, tables).
 */
export async function finalizeLoad({ loaderDir, runId, runDir, shards, wholeSeed, capture, permitsRowsFile }) {
  const now = new Date().toISOString();
  const mergesDir = path.join(loaderDir, "merges", runId);
  const records = [];
  for (const shard of shards) {
    const file = path.join(mergesDir, `${shard}.json`);
    if (!existsSync(file)) throw new Error(`loader: shard ${shard} of run ${runId} has no merge record; finalize needs every shard`);
    records.push(JSON.parse(await readFile(file, "utf8")));
  }
  const prior = await currentGeneration(loaderDir);
  const priorIndexes = { appraisal: {}, permit_groups: {}, permits: {} };
  if (prior) {
    for (const [name, file] of Object.entries(prior.state.hash_index_files)) priorIndexes[name] = JSON.parse(await readFile(path.join(prior.dir, file), "utf8"));
  }
  const generationDir = path.join(loaderDir, "generations", `${runId}.partial`);
  await mkdir(generationDir, { recursive: true });

  // Appraisal and permit-group indexes from this run's merges.
  /** @type {Record<string, [string, string]>} */
  const appraisal = {};
  /** @type {Record<string, [string, string]>} */
  const permitGroups = {};
  const dead = [];
  const invalid = [];
  const retryable = [];
  let permitsPublished = 0;
  const tableParts = {};
  for (const record of records) {
    for (const item of record.appraisal.ready) appraisal[item.key] = [item.path, item.artifact_hash];
    for (const item of record.permits.groups) {
      permitGroups[item.key] = [item.path, item.artifact_hash];
      permitsPublished += item.permits;
    }
    dead.push(...record.appraisal.dead);
    invalid.push(...record.appraisal.invalid);
    retryable.push(...record.appraisal.retryable);
    for (const [name, table] of Object.entries(record.tables)) {
      const placed = await placePart(path.join(RUNTIME_ROOT, table.file), path.join(generationDir, "tables", name), record.shard, table.sha256);
      (tableParts[name] ??= []).push({ shard: record.shard, file: path.relative(generationDir, placed), sha256: table.sha256, rows: table.rows });
    }
  }
  if (retryable.length > 0) throw new Error(`loader: ${retryable.length} parcels are still retryable; resume the run before finalizing`);

  // The internal permits table (every captured permit, linked or not) and its key index.
  const permits = await writePermitsTable(permitsRowsFile, path.join(generationDir, "tables", "permits", "permits.parquet"));
  /** @type {Record<string, [string, string]>} */
  const permitIndex = Object.fromEntries(Object.entries(permits.index).map(([key, hash]) => [key, [rel(capture.dir), hash]]));
  tableParts.permits = [{ shard: null, file: "tables/permits/permits.parquet", sha256: permits.sha256, rows: permits.rows }];

  // Deltas and tombstones.
  const deltas = { appraisal: diffIndexes(priorIndexes.appraisal, appraisal), permit_groups: diffIndexes(priorIndexes.permit_groups, permitGroups), permits: diffIndexes(priorIndexes.permits, permitIndex) };
  const deadKeys = new Set(dead.map((item) => item.key));
  const invalidKeys = new Set(invalid.map((item) => item.key));
  const tombstones = [];
  for (const item of dead) tombstones.push({ track: "appraisal", key: item.key, reason: "dead", terminal_reason: item.reason, evidence: item.evidence, prior_artifact_hash: priorIndexes.appraisal[item.key]?.[1] ?? null, stale_row_removed: Boolean(priorIndexes.appraisal[item.key]), at: now });
  for (const item of invalid) tombstones.push({ track: "appraisal", key: item.key, reason: "invalid", terminal_reason: item.reason, evidence: item.evidence, prior_artifact_hash: priorIndexes.appraisal[item.key]?.[1] ?? null, stale_row_removed: Boolean(priorIndexes.appraisal[item.key]), at: now });
  if (wholeSeed) {
    for (const key of deltas.appraisal.removedKeys) {
      if (deadKeys.has(key) || invalidKeys.has(key)) continue;
      tombstones.push({ track: "appraisal", key, reason: "absent_from_seed", terminal_reason: "not in this run's seed", evidence: null, prior_artifact_hash: priorIndexes.appraisal[key][1], stale_row_removed: true, at: now });
    }
    for (const key of deltas.permits.removedKeys) tombstones.push({ track: "permits", key, reason: "absent_from_capture", terminal_reason: "not in this run's permit capture", evidence: null, prior_artifact_hash: priorIndexes.permits[key][1], stale_row_removed: true, at: now });
    for (const key of deltas.permit_groups.removedKeys) tombstones.push({ track: "permit_groups", key, reason: "no_published_permit", terminal_reason: "the parcel publishes no permit in this run", evidence: null, prior_artifact_hash: priorIndexes.permit_groups[key][1], stale_row_removed: true, at: now });
  }
  const runPrefix = `${rel(runDir)}/shards`;
  const partitionIndex = Object.fromEntries(capture.partitions.map((item) => [item.file, [rel(path.join(capture.dir, item.file)), item.sha256]]));
  const watermarks = [
    { track: "appraisal", path: `${runPrefix}/*/appraisal-a*/*/data`, artifact_hash: indexDigest(appraisal), merged_count: Object.keys(appraisal).length, merged_rows: Object.keys(appraisal).length, last_merged_at: now, hash_index_path: "hash-index.appraisal.json" },
    { track: "permits", path: rel(capture.dir), artifact_hash: indexDigest(partitionIndex), merged_count: capture.partitions.length, merged_rows: permits.rows, last_merged_at: now, hash_index_path: "hash-index.permits.json" },
    { track: "permits", path: `${runPrefix}/*/appraisal-a*/*/permit-data-a*`, artifact_hash: indexDigest(permitGroups), merged_count: Object.keys(permitGroups).length, merged_rows: permitsPublished, last_merged_at: now, hash_index_path: "hash-index.permit_groups.json" },
  ];
  // A finalize that changes nothing keeps the prior watermark times (idempotent re-load).
  if (prior && prior.state.watermarks.every((item, position) => item.artifact_hash === watermarks[position]?.artifact_hash) && tombstones.every((item) => !item.stale_row_removed)) {
    watermarks.forEach((item, position) => (item.last_merged_at = prior.state.watermarks[position].last_merged_at));
  }
  const files = { appraisal: "hash-index.appraisal.json", permit_groups: "hash-index.permit_groups.json", permits: "hash-index.permits.json", partitions: "hash-index.partitions.json" };
  await atomicWrite(path.join(generationDir, files.appraisal), JSON.stringify(appraisal));
  await atomicWrite(path.join(generationDir, files.permit_groups), JSON.stringify(permitGroups));
  await atomicWrite(path.join(generationDir, files.permits), JSON.stringify(permitIndex));
  await atomicWrite(path.join(generationDir, files.partitions), JSON.stringify(partitionIndex));
  await atomicWrite(path.join(generationDir, "tombstones.jsonl"), tombstones.map((item) => JSON.stringify(item)).join("\n") + (tombstones.length ? "\n" : ""));
  const tombstonesConsumed = { dead: tombstones.filter((item) => item.reason === "dead").length, invalid: tombstones.filter((item) => item.reason === "invalid").length };
  const state = {
    version: LOADER_VERSION,
    run_id: runId,
    finalized_at: now,
    prior_generation: prior?.id ?? null,
    watermarks,
    hash_index_files: { appraisal: files.appraisal, permit_groups: files.permit_groups, permits: files.permits },
    tables: tableParts,
    deltas: Object.fromEntries(Object.entries(deltas).map(([name, delta]) => [name, { new: delta.new, changed: delta.changed, unchanged: delta.unchanged, removed: delta.removed }])),
    tombstones_consumed: tombstonesConsumed,
    tombstones: { total: tombstones.length, stale_rows_removed: tombstones.filter((item) => item.stale_row_removed).length, by_reason: tombstones.reduce((acc, item) => ({ ...acc, [item.reason]: (acc[item.reason] ?? 0) + 1 }), {}) },
    counts: { appraisal_ready: Object.keys(appraisal).length, dead: dead.length, invalid: invalid.length, permit_groups: Object.keys(permitGroups).length, permits_published: permitsPublished, permits_rows: permits.rows, permits_linked: permits.linked, permits_unlinked: permits.unlinked },
  };
  await atomicWrite(path.join(generationDir, "state.json"), `${JSON.stringify(state, null, 1)}\n`);
  // Move the generation into place, then the pointer (each a rename: a crash leaves the old pointer in force).
  const finalDir = path.join(loaderDir, "generations", runId);
  if (existsSync(finalDir)) await rename(finalDir, path.join(loaderDir, "generations", `${runId}.replaced-${Date.now()}`));
  await rename(generationDir, finalDir);
  await atomicWrite(path.join(loaderDir, "CURRENT"), `${runId}\n`);
  const stateSha = await sha256File(path.join(finalDir, "state.json"));
  await appendFile(path.join(loaderDir, "loads.jsonl"), `${JSON.stringify({ run_id: runId, finalized_at: now, prior_generation: state.prior_generation, deltas: state.deltas, tombstones_consumed: tombstonesConsumed, watermarks: watermarks.map((item) => ({ track: item.track, artifact_hash: item.artifact_hash, merged_count: item.merged_count })), state_sha256: stateSha })}\n`);
  return { ...state, generation_dir: rel(finalDir), state_sha256: stateSha };
}

/**
 * The internal run history (every finalize of this scope).
 *
 * @param {string} loaderDir - Loader directory.
 * @returns {Promise<Record<string, any>[]>} History, oldest first.
 */
export async function loadHistory(loaderDir) {
  const file = path.join(loaderDir, "loads.jsonl");
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8")).split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

/**
 * The T3 tracks' watermarks (registry, licensing), as the run record lists them.
 *
 * @param {string[]} dirs - Track directories holding a `watermark.json`.
 * @returns {Promise<Record<string, any>[]>} Watermarks.
 */
export async function t3Watermarks(dirs) {
  const out = [];
  for (const dir of dirs) {
    const file = path.join(dir, "watermark.json");
    if (!existsSync(file)) continue;
    const body = JSON.parse(await readFile(file, "utf8"));
    for (const [name, entry] of Object.entries(body.entries ?? {})) {
      out.push({ track: entry.track ?? body.track, source: name, path: entry.path, artifact_hash: entry.artifact_hash, merged_count: entry.merged_count, merged_rows: entry.merged_rows ?? null, last_merged_at: entry.last_merged_at, watermark_sha256: await sha256File(file) });
    }
  }
  return out;
}

/** @param {string} dir @returns {Promise<number>} Bytes of every file under `dir`. */
export async function bytesUnder(dir) {
  let total = 0;
  if (!existsSync(dir)) return 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? await bytesUnder(full) : (await stat(full)).size;
  }
  return total;
}
