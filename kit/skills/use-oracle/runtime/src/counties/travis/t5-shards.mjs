/**
 * T5 shard plan, digests and done-markers (assignment decisions.md section 25.9, approved 2026-10-18).
 *
 * - **Plan.** The seed is cut into shards of at most `shardSize` properties (5,000 by the ruling) taken in sorted PROP_ID
 *   order, so a rerun on the same seed builds the same shards. The seed is already sorted (checked: a descent stops the
 *   plan). Each shard gets its own `seed.csv` and the matching lines of the TCAD extras index.
 * - **Markers.** Each shard stage writes to an attempt-numbered staging location and, only after its checks pass, writes
 *   `<shard>/<stage>.done.json` atomically (temporary file, fsync, rename) with its input digest (what it read: file
 *   digests, the lexicon manifest SHA-256, the CLI version, the code it ran) and its output digests. A resume recomputes
 *   the input digest and re-hashes the outputs: a matching marker is skipped, anything else is rerun under a new attempt
 *   number, so a crash or a sleep redoes only the stages that were in flight. Nothing a marker names is ever rewritten in
 *   place; a redone stage writes a new location. The same check, without writing, verifies a finished run
 *   (`t5-run.mjs --verify`, or the start command on a finished run).
 *
 * @module counties/travis/t5-shards
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";

import { encodeCsvCell } from "../../core/csv.mjs";
import { parseCsvRecordSpans } from "./t3-snapshot.mjs";

export const SHARD_PLAN_VERSION = "travis-t5-shard-plan.v1";
export const MARKER_VERSION = "travis-t5-done-marker.v1";
export const DEFAULT_SHARD_SIZE = 5000;

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * SHA-256 of a file, streamed.
 *
 * @param {string} file - File.
 * @returns {Promise<string>} Hex digest.
 */
export async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { highWaterMark: 1 << 22 })) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * A stable digest of a JSON value (keys sorted at every level).
 *
 * @param {unknown} value - Value.
 * @returns {string} Hex digest.
 */
export function digestOf(value) {
  const canonical = (item) => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") return Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])]));
    return item;
  };
  return sha256Hex(JSON.stringify(canonical(value)));
}

/**
 * Digest of a directory tree: every file's relative path, size and SHA-256, sorted (empty directories ignored).
 *
 * @param {string} dir - Directory.
 * @returns {Promise<{ sha256: string, files: number, bytes: number }>} Tree digest.
 */
export async function treeDigest(dir) {
  /** @type {[string, number, string][]} */
  const entries = [];
  const walk = async (current) => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) entries.push([path.relative(dir, full).split(path.sep).join("/"), (await stat(full)).size, await sha256File(full)]);
    }
  };
  await walk(dir);
  return { sha256: sha256Hex(JSON.stringify(entries)), files: entries.length, bytes: entries.reduce((sum, [, size]) => sum + size, 0) };
}

/**
 * The artifact hash of one parcel's `data/` directory (the loader's `(path, artifact hash)` unit): the SHA-256 over its
 * sorted `(file name, SHA-256)` pairs.
 *
 * @param {string} dataDir - Directory of JSON files.
 * @returns {Promise<string>} Hex digest.
 */
export async function dataDirDigest(dataDir) {
  const names = (await readdir(dataDir)).filter((name) => name.endsWith(".json")).sort();
  const pairs = [];
  for (const name of names) pairs.push([name, sha256Hex(await readFile(path.join(dataDir, name)))]);
  return sha256Hex(JSON.stringify(pairs));
}

/**
 * Shard id of an index (`s0001`, `s0002`, ...).
 *
 * @param {number} index - Zero-based index.
 * @returns {string} Id.
 */
export const shardId = (index) => `s${String(index + 1).padStart(4, "0")}`;

/**
 * Stream a CSV file as raw records (header first), keeping each record's text as captured.
 *
 * @param {string} file - CSV file.
 * @returns {AsyncGenerator<{ text: string, fields: string[] }>} Records.
 */
export async function* streamCsvRecords(file) {
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
  let buffer = "";
  let scanned = 0;
  let inQuotes = false;
  for await (const chunk of stream) {
    buffer += chunk;
    let start = 0;
    for (let index = scanned; index < buffer.length; index += 1) {
      const code = buffer.charCodeAt(index);
      if (code === 34) inQuotes = !inQuotes;
      else if (code === 10 && !inQuotes) {
        const text = buffer.slice(start, index).replace(/\r$/, "");
        if (text !== "") for (const record of parseCsvRecordSpans(text)) yield { text, fields: record.fields.map((field) => field.value) };
        start = index + 1;
      }
    }
    buffer = buffer.slice(start);
    scanned = buffer.length;
  }
  const rest = buffer.replace(/\r$/, "");
  if (rest.trim() !== "") for (const record of parseCsvRecordSpans(rest)) yield { text: rest, fields: record.fields.map((field) => field.value) };
}

/**
 * Write a file atomically: a temporary sibling, fsync, rename.
 *
 * @param {string} file - Target.
 * @param {string | Buffer} content - Content.
 * @returns {Promise<void>} Resolves once renamed.
 */
export async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, "w");
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

/**
 * Plan the shards: split the (sorted) seed into `shardSize`-row shard seeds, with the matching TCAD extras lines.
 *
 * @param {object} options - Options.
 * @param {string} options.seedPath - Seed CSV (sorted by PROP_ID).
 * @param {string} options.extrasFile - `extras.jsonl` of the TCAD extras index (same order as the seed), or null.
 * @param {string} options.shardsDir - Where `<shard>/seed.csv` and `<shard>/extras.jsonl` go.
 * @param {number} [options.shardSize] - Rows per shard.
 * @param {number | null} [options.maxShards] - Stop after this many shards (a dry run); null for the whole seed.
 * @returns {Promise<{ version: string, shard_size: number, max_shards: number | null, seed_rows_read: number, rows: number, shards: { id: string, rows: number, first: string, last: string, seed_sha256: string, extras_sha256: string | null, extras_lines: number }[] }>} Plan.
 */
export async function planShards({ seedPath, extrasFile, shardsDir, shardSize = DEFAULT_SHARD_SIZE, maxShards = null }) {
  if (!Number.isInteger(shardSize) || shardSize < 1) throw new Error(`shard size must be a positive integer, got ${shardSize}`);
  const shards = [];
  /** @type {string | null} */
  let header = null;
  let current = null;
  let previous = -1;
  let rowsRead = 0;
  const extrasLines = extrasFile ? readLines(extrasFile) : null;
  const close = async () => {
    if (!current) return;
    await new Promise((resolve, reject) => current.seed.end((error) => (error ? reject(error) : resolve(undefined))));
    if (current.extras) await new Promise((resolve, reject) => current.extras.end((error) => (error ? reject(error) : resolve(undefined))));
    await rename(`${current.seedPath}.partial`, current.seedPath);
    if (current.extrasPath) await rename(`${current.extrasPath}.partial`, current.extrasPath);
    shards.push({ id: current.id, rows: current.rows, first: current.first, last: current.last, seed_sha256: current.seedHash.digest("hex"), extras_sha256: current.extrasHash ? current.extrasHash.digest("hex") : null, extras_lines: current.extrasCount });
    current = null;
  };
  let propIdColumn = -1;
  for await (const record of streamCsvRecords(seedPath)) {
    if (header === null) {
      header = record.text;
      propIdColumn = record.fields.indexOf("parcel_id");
      if (propIdColumn < 0) throw new Error("seed has no parcel_id column");
      continue;
    }
    const propId = String(record.fields[propIdColumn] ?? "").trim();
    const numeric = Number(propId);
    if (!/^\d{1,12}$/.test(propId) || numeric <= previous) throw new Error(`seed is not sorted by PROP_ID at ${propId} (after ${previous}); shards must be cut from sorted PROP_IDs`);
    previous = numeric;
    if (current && current.rows >= shardSize) await close();
    if (!current) {
      if (maxShards !== null && shards.length >= maxShards) break;
      const id = shardId(shards.length);
      const dir = path.join(shardsDir, id);
      await mkdir(dir, { recursive: true });
      const seedFile = path.join(dir, "seed.csv");
      current = { id, rows: 0, first: propId, last: propId, seedPath: seedFile, seed: createWriteStream(`${seedFile}.partial`), seedHash: createHash("sha256"), extrasPath: extrasLines ? path.join(dir, "extras.jsonl") : null, extras: extrasLines ? createWriteStream(path.join(dir, "extras.jsonl.partial")) : null, extrasHash: extrasLines ? createHash("sha256") : null, extrasCount: 0 };
      const head = `${header}\n`;
      current.seed.write(head);
      current.seedHash.update(head);
    }
    const line = `${record.text}\n`;
    if (!current.seed.write(line)) await new Promise((resolve) => current.seed.once("drain", resolve));
    current.seedHash.update(line);
    current.rows += 1;
    current.last = propId;
    rowsRead += 1;
    if (extrasLines) {
      const next = await extrasLines.next();
      if (next.done) throw new Error(`the TCAD extras index ends before seed account ${propId}`);
      const extrasId = next.value.slice(12, next.value.indexOf('"', 12));
      if (extrasId !== propId) throw new Error(`the TCAD extras index is out of step with the seed: ${extrasId} where the seed has ${propId}`);
      const text = `${next.value}\n`;
      if (!current.extras.write(text)) await new Promise((resolve) => current.extras.once("drain", resolve));
      current.extrasHash.update(text);
      current.extrasCount += 1;
    }
  }
  await close();
  if (extrasLines) await extrasLines.return(undefined);
  return { version: SHARD_PLAN_VERSION, shard_size: shardSize, max_shards: maxShards, seed_rows_read: rowsRead, rows: shards.reduce((sum, shard) => sum + shard.rows, 0), shards };
}

/**
 * Lines of a text file, streamed.
 *
 * @param {string} file - File.
 * @returns {AsyncGenerator<string>} Lines (empty lines skipped).
 */
export async function* readLines(file) {
  let rest = "";
  for await (const chunk of createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 })) {
    const lines = (rest + chunk).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) if (line !== "") yield line;
  }
  if (rest !== "") yield rest;
}

/**
 * Path of a stage's done-marker.
 *
 * @param {string} dir - Shard (or global) directory.
 * @param {string} stage - Stage name.
 * @returns {string} Marker path.
 */
export const markerPath = (dir, stage) => path.join(dir, `${stage}.done.json`);

/**
 * Write a done-marker atomically.
 *
 * @param {string} dir - Shard (or global) directory.
 * @param {string} stage - Stage name.
 * @param {{ input: Record<string, any>, output: Record<string, any>, attempt: number, started_at: string, ms: number }} body - What the stage read and wrote.
 * @returns {Promise<Record<string, any>>} The marker.
 */
export async function writeMarker(dir, stage, body) {
  const marker = { version: MARKER_VERSION, stage, input_digest: digestOf(body.input), ...body, finished_at: new Date().toISOString() };
  await atomicWrite(markerPath(dir, stage), `${JSON.stringify(marker, null, 1)}\n`);
  return marker;
}

/**
 * Read a done-marker and check it still holds: the input digest equals the one recomputed now, and every output file it
 * names still has its recorded SHA-256 (`output.files[]`: `{path, sha256}`, relative to `dir`; a `tree` entry is checked
 * with {@link treeDigest}).
 *
 * With `rehash: false` (the runner's quick, read-only check of a finished run) the outputs are only checked to exist;
 * `stats`, when given, counts the outputs checked and the files and bytes re-hashed.
 *
 * @param {string} dir - Shard (or global) directory.
 * @param {string} stage - Stage name.
 * @param {Record<string, any>} input - The stage's input now.
 * @param {{ rehash?: boolean, stats?: { outputs: number, files: number, bytes: number } | null }} [options] - Check depth and counters.
 * @returns {Promise<{ marker: Record<string, any> | null, valid: boolean, reason: string }>} Verdict.
 */
export async function checkMarker(dir, stage, input, { rehash = true, stats = null } = {}) {
  const file = markerPath(dir, stage);
  if (!existsSync(file)) return { marker: null, valid: false, reason: "no marker" };
  let marker;
  try {
    marker = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return { marker: null, valid: false, reason: "unreadable marker" };
  }
  if (marker.version !== MARKER_VERSION) return { marker, valid: false, reason: `marker version ${marker.version}` };
  if (marker.input_digest !== digestOf(input)) return { marker, valid: false, reason: "input changed" };
  for (const item of marker.output?.files ?? []) {
    const target = path.join(dir, item.path);
    if (!existsSync(target)) return { marker, valid: false, reason: `output ${item.path} missing` };
    if (stats) stats.outputs += 1;
    if (!rehash) continue;
    let digest;
    if (item.tree) {
      const tree = await treeDigest(target);
      digest = tree.sha256;
      if (stats) {
        stats.files += tree.files;
        stats.bytes += tree.bytes;
      }
    } else {
      digest = await sha256File(target);
      if (stats) {
        // Stat before touching the shared counters: `stats.bytes += await ...` reads the total before the await and
        // loses the other shards' additions when several markers are checked at once.
        const { size } = await stat(target);
        stats.files += 1;
        stats.bytes += size;
      }
    }
    if (digest !== item.sha256) return { marker, valid: false, reason: `output ${item.path} changed` };
  }
  return { marker, valid: true, reason: "matches" };
}

/**
 * Reserve the next attempt number of a stage: one more than the marker's, than any attempt directory with the stage's
 * prefix, and than any earlier reservation (`<stage>.a<n>.started`, created exclusively here), so an attempt a crash left
 * half-written is never reused.
 *
 * @param {string} dir - Shard (or global) directory.
 * @param {string} stage - Stage name.
 * @param {string | null} prefix - Attempt directory prefix (`appraisal-a`), if the stage writes one.
 * @param {Record<string, any> | null} marker - The stage's marker, if any.
 * @returns {Promise<number>} Attempt.
 */
export async function reserveAttempt(dir, stage, prefix, marker) {
  await mkdir(dir, { recursive: true });
  for (;;) {
    let highest = marker?.attempt ?? 0;
    const reservation = `${stage}.a`;
    for (const name of await readdir(dir)) {
      if (name.startsWith(reservation) && name.endsWith(".started")) {
        const number = Number.parseInt(name.slice(reservation.length), 10);
        if (Number.isInteger(number)) highest = Math.max(highest, number);
      } else if (prefix && name.startsWith(prefix)) {
        const number = Number.parseInt(name.slice(prefix.length), 10);
        if (Number.isInteger(number)) highest = Math.max(highest, number);
      }
    }
    const attempt = highest + 1;
    try {
      const handle = await open(path.join(dir, `${reservation}${attempt}.started`), "wx");
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
      await handle.close();
      return attempt;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

/**
 * Render seed rows (as parsed objects) back to CSV in a fixed column order (tests and small seeds).
 *
 * @param {string[]} columns - Columns.
 * @param {Record<string, string>[]} rows - Rows.
 * @returns {string} CSV text.
 */
export const renderRows = (columns, rows) => `${columns.join(",")}\n${rows.map((row) => columns.map((column) => encodeCsvCell(row[column] ?? "")).join(",")).join("\n")}\n`;
