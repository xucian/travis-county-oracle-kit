#!/usr/bin/env node
/**
 * T6: publication of the sharded T5 run (assignment decisions.md section 28, layout D: the shard archives as they
 * are; no merge, no Atlas PR). Every subcommand reads `--plan` (or the run) and writes under `--out`; each resumes
 * where it stopped and stops at the first failure.
 *
 *   plan           from run.json: every archive and tables root, every table part (cid and bytes from the CountyTables
 *                  block, size and sha256 from the file), both schemas and every root block; refuses an archive whose
 *                  bytes or six recorded CAR checks differ from the record, or a tables root that does not point back
 *                  at its shard's archive
 *   tables-cars    per tables root, a CAR of the CountyTables block and every part's UnixFS blocks, built with the CLI's
 *                  own importer (the code export-tables computes part CIDs with); every part must come out as the CID
 *                  the block links, and the CAR is re-read with every block verified. The block's `county_root` link
 *                  resolves into the shard's archive CAR.
 *   upload         `elephant-cli upload` of each archive CAR, then its tables directory, to Filebase (the CLI reads
 *                  each root back); every root must be the plan's
 *   filebase-pins  read-only `pin/ls` of every root and part on Filebase, plus negative controls
 *   gateway-check  per gateway: the raw root block of every archive root, tables root and schema against its
 *                  multihash, and the full bytes of every part against its size and sha256; rows go to a JSONL, so a
 *                  rerun repeats only the rows without a definitive answer
 *   pin            Pinata pin-by-CID (recursive) of every archive and tables root, then bulk polling to a bound;
 *                  refusals and pending jobs are kept verbatim
 *   manifest       publish/<run_id>/manifest.json (the CARs are listed as release assets; nothing creates the release)
 *   pin-manifest   the manifest added to Filebase with the CLI's add parameters (its CID must equal the local one),
 *                  pinned by CID on Pinata and fetched in full from each gateway
 *
 * Credentials come from the shell (FILEBASE_ACCESS_KEY, FILEBASE_SECRET_KEY, FILEBASE_BUCKET,
 * PINATA_JWT_SECRET_ACCESS_TOKEN); they are never printed or written.
 *
 * @module counties/travis/t6-publish
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, openSync, closeSync } from "node:fs";
import { appendFile, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

import { filebasePins, gatewayCheck, pinByCid, rawCid, readCarBlocks, rootBlock } from "./publish.mjs";

const MINUTE = 60_000;
const PINATA_API = "https://api.pinata.cloud";
const TERMINAL_PIN_JOB = new Set(["expired", "over_free_limit", "over_max_size", "invalid_object", "bad_host_node"]);
const SIX_CHECKS = ["integrity_errors", "root_errors", "index_errors", "graph_errors", "lexicon_errors", "orphans_errors"];
const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {string} file @returns {Promise<{ size: number, sha256: string }>} */
export async function fileDigest(file) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { size, sha256: hash.digest("hex") };
}

/**
 * Import a package the CLI itself depends on, resolved from the CLI's install, so part CIDs come from the same code
 * that export-tables used.
 *
 * @param {string} cliBin - Path of the elephant-cli executable.
 * @param {string} specifier - Package name, optionally with a subpath (`multiformats/cid`).
 * @returns {Promise<object>} The module.
 */
export async function importFromCli(cliBin, specifier) {
  const segments = specifier.split("/");
  const name = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  const subpath = specifier.slice(name.length);
  let dir = path.dirname(await realpath(cliBin));
  for (;;) {
    const pkgDir = path.join(dir, "node_modules", name);
    if (existsSync(path.join(pkgDir, "package.json"))) {
      const pkg = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
      let entry = pkg.exports?.[`.${subpath}`] ?? (subpath ? null : (pkg.exports ?? pkg.module ?? pkg.main));
      while (entry && typeof entry === "object") entry = entry.import ?? entry.default ?? entry.node ?? null;
      if (!entry) throw new Error(`${specifier}: no ESM entry in ${pkgDir}`);
      return import(pathToFileURL(path.join(pkgDir, entry)).href);
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`${specifier} is not installed beside ${cliBin}`);
    dir = parent;
  }
}

/** @param {string} cliBin @returns {Promise<{ importer: Function, CarWriter: any, CID: any }>} */
export async function cliLibraries(cliBin) {
  const [{ importer }, { CarWriter }, { CID }] = await Promise.all([importFromCli(cliBin, "ipfs-unixfs-importer"), importFromCli(cliBin, "@ipld/car"), importFromCli(cliBin, "multiformats")]);
  return { importer, CarWriter, CID };
}

/**
 * The UnixFS file CID of `content` as `ipfs add --cid-version 1 --raw-leaves --chunker size-262144` computes it.
 *
 * @param {Function} importer - ipfs-unixfs-importer's `importer`.
 * @param {Uint8Array | AsyncIterable<Uint8Array>} content - Bytes.
 * @param {(cid: any, bytes: Uint8Array) => Promise<void>} [put] - Receives every block.
 * @returns {Promise<string>} The CID.
 */
export async function unixfsCid(importer, content, put = async () => {}) {
  let made = null;
  const blockstore = { put: async (cid, bytes) => { await put(cid, bytes); return cid; } };
  for await (const entry of importer([{ content }], blockstore, { cidVersion: 1, rawLeaves: true })) made = entry.cid.toString();
  return made;
}

/**
 * The publication plan of a sharded run.
 *
 * @param {{ runDir: string, runtimeDir: string, schemaCacheDir: string }} options - Run directory, the runtime the
 *   record's paths are relative to, the CLI's schema cache.
 * @returns {Promise<object>} `{ run_id, archives, tables, schemas, sample_extract, lexicon_manifest, counts, sizes, problems }`.
 */
export async function buildPlan({ runDir, runtimeDir, schemaCacheDir }) {
  const run = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
  const at = (relative) => path.resolve(runtimeDir, relative);
  const problems = [];
  const archives = [];
  for (const car of run.cars.filter((entry) => entry.kind === "archive")) {
    const checks = car.car_validation ?? {};
    if (checks.passed !== true || SIX_CHECKS.some((key) => checks[key] !== 0)) problems.push(`${car.group} ${car.shard}: the recorded CAR checks are not all 0`);
    const bytes = await readFile(at(car.path));
    if (bytes.length !== car.size || sha256Hex(bytes) !== car.sha256) problems.push(`${car.path}: not the recorded bytes`);
    archives.push({ shard: car.shard, group: car.group, root: car.root_cid, schema: car.schema_cid, path: car.path, size: car.size, sha256: car.sha256, block_count: car.block_count, properties: car.properties, car_validation: checks, root_block: rootBlock(bytes, car.root_cid) });
  }
  const tables = [];
  for (const car of run.cars.filter((entry) => entry.kind === "tables")) {
    const archive = archives.find((entry) => entry.shard === car.shard && entry.group === car.group);
    const carPath = path.join(car.path, "tables.car");
    const carBytes = await readFile(at(carPath));
    const block = readCarBlocks(carBytes).find((candidate) => candidate.cid === car.root_cid);
    if (!block?.verified) {
      problems.push(`${carPath}: no verified block for ${car.root_cid}`);
      continue;
    }
    const index = JSON.parse(Buffer.from(block.bytes).toString("utf8"));
    if (!archive || index.county_root?.["/"] !== archive.root) problems.push(`${car.group} ${car.shard}: the tables root points at ${index.county_root?.["/"]}, not the shard's archive`);
    const parts = [];
    for (const [table, entry] of Object.entries(index.tables ?? {})) {
      for (const [position, part] of entry.parts.entries()) {
        const file = path.join(car.path, table, `part-${String(position).padStart(5, "0")}.parquet`);
        const digest = await fileDigest(at(file));
        if (digest.size !== part.bytes) problems.push(`${file}: ${digest.size} bytes, the CountyTables block says ${part.bytes}`);
        parts.push({ table, position, cid: part.cid["/"], bytes: part.bytes, rows: part.rows, sha256: digest.sha256, file });
      }
    }
    tables.push({ shard: car.shard, group: car.group, root: car.root_cid, county_root: archive?.root ?? null, schema: car.schema_cid, dir: car.path, tables_car: { path: carPath, size: carBytes.length, sha256: sha256Hex(carBytes) }, root_block: { size: block.bytes.length, sha256: sha256Hex(block.bytes) }, parts });
  }
  const schemas = [];
  for (const cid of [...new Set(archives.map((entry) => entry.schema))]) {
    const bytes = await readFile(path.join(schemaCacheDir, `${cid}.json`));
    if (rawCid(bytes) !== cid) problems.push(`the cached schema ${cid} does not hash to its CID`);
    schemas.push({ cid, title: JSON.parse(bytes.toString("utf8")).title ?? null, groups: [...new Set(archives.filter((entry) => entry.schema === cid).map((entry) => entry.group))], size: bytes.length, sha256: sha256Hex(bytes) });
  }
  const first = archives.find((entry) => entry.group === "county");
  const hashRows = first ? (await readFile(at(path.join(path.dirname(first.path), "hash.csv")), "utf8")).trim().split("\n").slice(1).map((line) => line.split(",")) : [];
  const sampleRow = hashRows.find((row) => row[1] === first?.schema);
  const sum = (items, pick) => items.reduce((total, item) => total + pick(item), 0);
  const archiveBytes = sum(archives, (entry) => entry.size);
  const partBytes = sum(tables, (entry) => sum(entry.parts, (part) => part.bytes));
  const tablesCarBytes = sum(tables, (entry) => entry.tables_car.size);
  const distinct = archiveBytes + partBytes + tablesCarBytes;
  return {
    run_id: run.run_id,
    archives,
    tables,
    schemas,
    sample_extract: sampleRow ? { shard: first.shard, property_cid: sampleRow[0], data_group_root_cid: sampleRow[2] } : null,
    lexicon_manifest: { url: run.lexicon_manifest_url, sha256: run.lexicon_manifest?.sha256_start ?? null },
    counts: run.counts,
    sizes: {
      archive_bytes: archiveBytes,
      part_bytes: partBytes,
      tables_car_bytes: tablesCarBytes,
      distinct_bytes: distinct,
      filebase_counted_bytes: 2 * distinct,
      filebase_plan_bytes: 500e9,
      pinata_upper_bound_bytes: 2 * archiveBytes + partBytes + tablesCarBytes,
      pinata_plan_bytes: 1e12,
      note: "Filebase counts the archive and the parts twice (T5); the Pinata bound counts each archive twice because the recursive pin of a tables root walks its county_root link",
    },
    problems,
  };
}

/**
 * Write one tables root's full CAR: the CountyTables block, then every part's blocks in the block's order.
 *
 * @param {{ entry: object, runtimeDir: string, outFile: string, libs: { importer: Function, CarWriter: any, CID: any } }} options - Plan entry, runtime, destination, CLI libraries.
 * @returns {Promise<{ root: string, path: string, size: number, sha256: string, block_count: number, parts: number }>} The CAR written.
 */
export async function writeTablesCar({ entry, runtimeDir, outFile, libs }) {
  const { importer, CarWriter, CID } = libs;
  const rootBytes = readCarBlocks(await readFile(path.resolve(runtimeDir, entry.tables_car.path))).find((block) => block.cid === entry.root)?.bytes;
  if (!rootBytes) throw new Error(`${entry.tables_car.path}: no block for ${entry.root}`);
  const root = CID.parse(entry.root);
  const { writer, out } = CarWriter.create([root]);
  const partial = `${outFile}.partial`;
  await mkdir(path.dirname(outFile), { recursive: true });
  const piping = pipeline(Readable.from(out), createWriteStream(partial));
  const written = new Set();
  let chain = Promise.resolve();
  const put = (cid, bytes) => {
    const key = cid.toString();
    if (!written.has(key)) {
      written.add(key);
      chain = chain.then(() => writer.put({ cid, bytes }));
    }
    return chain;
  };
  await put(root, rootBytes);
  for (const part of entry.parts) {
    const made = await unixfsCid(importer, createReadStream(path.resolve(runtimeDir, part.file)), put);
    if (made !== part.cid) throw new Error(`${part.file}: the CLI's importer gives ${made}; the CountyTables block links ${part.cid}`);
  }
  await chain;
  await writer.close();
  await piping;
  const bytes = await readFile(partial);
  const blocks = readCarBlocks(bytes);
  const bad = blocks.filter((block) => !block.verified).length;
  if (bad > 0 || blocks.length !== written.size || blocks[0]?.cid !== entry.root) throw new Error(`${partial}: ${bad} unverified blocks, ${blocks.length} blocks for ${written.size} written, first ${blocks[0]?.cid}`);
  rootBlock(bytes, entry.root);
  await rename(partial, outFile);
  return { root: entry.root, path: outFile, size: bytes.length, sha256: sha256Hex(bytes), block_count: blocks.length, parts: entry.parts.length };
}

/**
 * Run `task` over `items`, at most `limit` at a time, keeping the input order.
 *
 * @template T, R
 * @param {T[]} items - Inputs.
 * @param {number} limit - Concurrency.
 * @param {(item: T) => Promise<R>} task - Work.
 * @returns {Promise<R[]>} Results.
 */
export async function mapLimited(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const FETCH_TIMEOUT_PRELOAD = new URL("./cli-fetch-timeout.mjs", import.meta.url).href;

/**
 * The CLI's environment: with `fetchTimeoutMs`, Node's fetch timeouts are raised for the CLI process only, through
 * the cli-fetch-timeout.mjs preload (decisions.md 28.7 (a)).
 *
 * @param {number | undefined} fetchTimeoutMs - Timeout in ms, or undefined for Node's defaults.
 * @returns {Record<string, string>} Environment.
 */
export function cliEnv(fetchTimeoutMs) {
  const env = { ...process.env, ELEPHANT_SKIP_UPDATE_CHECK: "1" };
  if (!fetchTimeoutMs) return env;
  return { ...env, CLI_FETCH_TIMEOUT_MS: String(fetchTimeoutMs), NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${FETCH_TIMEOUT_PRELOAD}`].filter(Boolean).join(" ") };
}

/** Spawn the CLI with its output in `logFile`; resolves to the exit code. */
function runCli(cli, args, logFile, env = cliEnv()) {
  return new Promise((resolve) => {
    const fd = openSync(logFile, "a");
    const child = spawn(cli, args, { stdio: ["ignore", fd, fd], env });
    child.on("error", () => { closeSync(fd); resolve(-1); });
    child.on("close", (code) => { closeSync(fd); resolve(code ?? -1); });
  });
}

/**
 * Whether one failed CLI upload may be retried (decisions.md 28.7, decision (8) (i)): only a network error (Node's
 * `fetch failed`) or a 5xx answer to the CLI's `add` or `dag/import`. Anything else (a 4xx, a CID or root mismatch, a
 * readback timeout) is final.
 *
 * @param {string} text - The CLI's output for that attempt.
 * @returns {string | null} Why it is retryable, or null.
 */
export function retryableFailure(text) {
  if (/Upload failed: fetch failed\b/.test(text)) return "network error (fetch failed)";
  const answer = text.match(/(dag\/import failed|add failed for \S+): (5\d\d) /);
  return answer ? `HTTP ${answer[2]} on ${answer[1].startsWith("add") ? "add" : "dag/import"}` : null;
}

/**
 * Upload every archive CAR, then its tables directory, through the CLI; an existing summary is checked, not redone.
 * A retryable failure (retryableFailure) is tried again up to `tries` times in all, `backoffMs` apart; every failed
 * attempt is recorded.
 *
 * @param {{ plan: object, out: string, cli: string, api: string, concurrency?: number, runtimeDir: string, fetchTimeoutMs?: number, tries?: number, backoffMs?: number[], run?: Function, sleepImpl?: (ms: number) => Promise<void> }} options - Plan, output, CLI, Kubo RPC API, the CLI's fetch timeout, the retry policy.
 * @returns {Promise<{ failed: object | null, failures: object[], retries: object[], results: object[] }>} Per root: shard, group, kind, root, gateway URL; every failure (the first as `failed`); every failed attempt.
 */
export async function uploadAll({ plan, out, cli, api, concurrency = 4, runtimeDir, fetchTimeoutMs, tries = 3, backoffMs = [2 * MINUTE, 4 * MINUTE], run = runCli, sleepImpl = sleep }) {
  const env = cliEnv(fetchTimeoutMs);
  const retries = [];
  await mkdir(path.join(out, "uploads"), { recursive: true });
  const results = [];
  const failures = [];
  await mapLimited(plan.archives, concurrency, async (archive) => {
    const tables = plan.tables.find((entry) => entry.shard === archive.shard && entry.group === archive.group);
    for (const [kind, input, expected] of [["archive", archive.path, archive.root], ["tables", tables?.dir, tables?.root]]) {
      if (failures.length > 0) return;
      const base = path.join(out, "uploads", `${archive.group}-${archive.shard}-${kind}`);
      for (let attempt = 1; !existsSync(`${base}.json`); attempt += 1) {
        const offset = existsSync(`${base}.log`) ? (await stat(`${base}.log`)).size : 0;
        const code = await run(cli, ["upload", path.resolve(runtimeDir, input), "--api", api, "--output-json", `${base}.json`], `${base}.log`, env);
        if (code === 0 && existsSync(`${base}.json`)) break;
        const text = existsSync(`${base}.log`) ? (await readFile(`${base}.log`)).subarray(offset).toString("utf8") : "";
        const reason = code === 0 ? null : retryableFailure(text);
        const record = { shard: archive.shard, group: archive.group, kind, attempt, exit_code: code, retryable: Boolean(reason), reason: reason ?? (text.trim().split("\n").filter(Boolean).pop() ?? "").slice(0, 300), at: new Date().toISOString() };
        retries.push(record);
        if (!reason || attempt >= tries) {
          failures.push({ ...record, log: `${base}.log` });
          return;
        }
        await sleepImpl(backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1]);
        if (failures.length > 0) return;
      }
      const summary = JSON.parse(await readFile(`${base}.json`, "utf8"));
      if (summary.root !== expected || (kind === "tables" && summary.countyRoot !== undefined && summary.countyRoot !== archive.root)) {
        failures.push({ shard: archive.shard, group: archive.group, kind, reason: `uploaded root ${summary.root} (county root ${summary.countyRoot ?? "n/a"}), the plan's ${expected}` });
        return;
      }
      results.push({ shard: archive.shard, group: archive.group, kind, root: summary.root, gateway_url: summary.gatewayUrl ?? null });
    }
  });
  return { failed: failures[0] ?? null, failures, retries, results };
}

/** Every root and part CID of the plan, once each. */
export function planCids(plan) {
  return [...new Set([...plan.archives.map((entry) => entry.root), ...plan.tables.map((entry) => entry.root), ...plan.tables.flatMap((entry) => entry.parts.map((part) => part.cid))])];
}

/**
 * The gateway jobs: the raw root block of every archive root, tables root and schema; the full bytes of every part.
 *
 * @param {object} plan - Plan.
 * @returns {{ cid: string, check: "raw" | "file", expected?: { size: number, sha256: string } }[]} Jobs, one per CID and check.
 */
export function gatewayJobs(plan) {
  const jobs = new Map();
  for (const cid of [...plan.archives.map((entry) => entry.root), ...plan.tables.map((entry) => entry.root), ...plan.schemas.map((entry) => entry.cid)]) jobs.set(`raw ${cid}`, { cid, check: "raw" });
  for (const part of plan.tables.flatMap((entry) => entry.parts)) jobs.set(`file ${part.cid}`, { cid: part.cid, check: "file", expected: { size: part.bytes, sha256: part.sha256 } });
  return [...jobs.values()];
}

const resultOf = (row) => (row.check === "file" ? row.bytes : row.multihash);
const definitive = (row) => ["match", "mismatch"].includes(resultOf(row));

/**
 * The row that stands per gateway, check and CID: the latest definitive one, else the latest.
 *
 * @param {object[]} rows - Every row, in the order written.
 * @returns {Map<string, object>} Keyed `gateway check cid`.
 */
export function standingRows(rows) {
  const standing = new Map();
  for (const row of rows) {
    const key = `${row.gateway} ${row.check} ${row.cid}`;
    const previous = standing.get(key);
    if (!previous || !definitive(previous) || definitive(row)) standing.set(key, row);
  }
  return standing;
}

/**
 * Per gateway: jobs, matches, mismatches, unverified and retried rows.
 *
 * @param {object[]} rows - Standing rows.
 * @returns {Record<string, object>} Summary per gateway.
 */
export function summarizeGateways(rows) {
  const summary = {};
  for (const row of rows) {
    const entry = (summary[row.gateway] ??= { rows: 0, raw: 0, file: 0, file_bytes: 0, match: 0, mismatch: 0, unverified: 0, retried: 0, max_attempts: 0 });
    entry.rows += 1;
    entry[row.check] += 1;
    if (row.check === "file" && resultOf(row) === "match") entry.file_bytes += row.size;
    entry[resultOf(row) === "match" ? "match" : resultOf(row) === "mismatch" ? "mismatch" : "unverified"] += 1;
    if (row.attempts > 1) entry.retried += 1;
    entry.max_attempts = Math.max(entry.max_attempts, row.attempts ?? 0);
  }
  return summary;
}

/**
 * Check jobs on gateways, appending each row to `jsonl` and skipping a job that already has a definitive row there.
 *
 * @param {{ jobs: object[], gateways: string[], jsonl: string, concurrency?: number, deadlineMs?: number, check?: Function }} options - Jobs, gateway origins, the row log.
 * @returns {Promise<object[]>} The standing rows of these jobs.
 */
export async function runGatewayChecks({ jobs, gateways, jsonl, concurrency = 6, deadlineMs = 20 * MINUTE, check = gatewayCheck }) {
  const previous = existsSync(jsonl) ? (await readFile(jsonl, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const done = standingRows(previous);
  await Promise.all(gateways.map((gateway) => mapLimited(jobs.filter((job) => !definitive(done.get(`${gateway} ${job.check} ${job.cid}`) ?? {})), concurrency, async (job) => {
    const row = await check({ ...job, gateway, deadlineMs });
    const { url, detail, ...kept } = row;
    await appendFile(jsonl, `${JSON.stringify({ ...kept, ...(detail ? { detail } : {}) })}\n`);
    return row;
  })));
  const all = standingRows((await readFile(jsonl, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)));
  return gateways.flatMap((gateway) => jobs.map((job) => all.get(`${gateway} ${job.check} ${job.cid}`)).filter(Boolean));
}

/**
 * Gateway checks paced to a gateway's quota (decisions.md 28.7, the operator's ruling 3): one request in flight; a row
 * that ends `unverified` on a 429 is checked again after waiting out its `Retry-After` in full, up to `maxRounds` times.
 * Rows go to `jsonl` as they are made, so a restart resumes; a job with a definitive row there is skipped. A mismatch
 * or a 4xx other than 429 stops the run; a row still unverified after the paced rounds is kept with its status.
 *
 * @param {{ jobs: object[], gateway: string, jsonl: string, check?: Function, sleepImpl?: (ms: number) => Promise<void>, deadlineMs?: number, maxRounds?: number, onRow?: (row: object) => void }} options - Jobs, one gateway, the row log.
 * @returns {Promise<{ stop: object | null, rows: object[] }>} Why it stopped (or null) and the standing rows of these jobs.
 */
export async function runPacedChecks({ jobs, gateway, jsonl, check = gatewayCheck, sleepImpl = sleep, deadlineMs = 20 * MINUTE, maxRounds = 6, onRow = () => {} }) {
  const read = async () => (existsSync(jsonl) ? (await readFile(jsonl, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  const done = standingRows(await read());
  let stop = null;
  for (const job of jobs) {
    if (definitive(done.get(`${gateway} ${job.check} ${job.cid}`) ?? {})) continue;
    let row;
    for (let round = 1; ; round += 1) {
      row = { ...(await check({ ...job, gateway, deadlineMs })), paced_rounds: round };
      if (definitive(row) || row.status !== 429 || round >= maxRounds) break;
      await sleepImpl(((row.retry_after_s ?? 60) + 5) * 1000);
    }
    const { url, detail, ...kept } = row;
    await appendFile(jsonl, `${JSON.stringify({ ...kept, ...(detail ? { detail } : {}) })}\n`);
    onRow(row);
    if (resultOf(row) === "mismatch") stop = { reason: "mismatch", cid: row.cid, check: row.check, status: row.status };
    else if (row.status >= 400 && row.status < 500 && row.status !== 429) stop = { reason: `HTTP ${row.status}`, cid: row.cid, check: row.check, status: row.status, detail: row.detail ?? null };
    if (stop) break;
  }
  const all = standingRows(await read());
  return { stop, rows: jobs.map((job) => all.get(`${gateway} ${job.check} ${job.cid}`)).filter(Boolean) };
}

/**
 * Pinata pin-by-CID of every root: requests spaced out (429 retried), then the pinned list and the pin jobs polled
 * until every root is pinned or failed, or the bound passes. Nothing is dropped: each root keeps its exact outcome.
 *
 * @param {{ roots: { cid: string, name: string }[], jwt: string, fetchImpl?: typeof fetch, waitMs?: number, pollMs?: number, spacingMs?: number, now?: () => Date, sleepImpl?: (ms: number) => Promise<void> }} options - Roots and names, JWT.
 * @returns {Promise<object[]>} Per root: `{cid, name, already_pinned, request_status, job_id, job_status, pinned, error, requested_at, pinned_at}`.
 */
export async function pinRoots({ roots, jwt, fetchImpl = fetch, waitMs = 45 * MINUTE, pollMs = MINUTE, spacingMs = 400, now = () => new Date(), sleepImpl = sleep }) {
  const headers = { authorization: `Bearer ${jwt}`, "content-type": "application/json" };
  const state = new Map(roots.map((root) => [root.cid, { cid: root.cid, name: root.name, already_pinned: false, request_status: null, job_id: null, job_status: null, pinned: false, error: null, requested_at: null, pinned_at: null }]));
  const pinnedNow = async () => {
    const found = new Set();
    for (let offset = 0; ; offset += 1000) {
      const response = await fetchImpl(`${PINATA_API}/data/pinList?status=pinned&pageLimit=1000&pageOffset=${offset}`, { headers });
      if (!response.ok) throw new Error(`pinList HTTP ${response.status}`);
      const rows = (await response.json())?.rows ?? [];
      for (const row of rows) found.add(row.ipfs_pin_hash);
      if (rows.length < 1000) return found;
    }
  };
  for (const cid of await pinnedNow()) if (state.has(cid)) Object.assign(state.get(cid), { already_pinned: true, pinned: true, job_status: "pinned", pinned_at: now().toISOString() });
  for (const root of roots) {
    const entry = state.get(root.cid);
    if (entry.pinned) continue;
    for (let attempt = 1; ; attempt += 1) {
      entry.requested_at = now().toISOString();
      const response = await fetchImpl(`${PINATA_API}/pinning/pinByHash`, { method: "POST", headers, body: JSON.stringify({ hashToPin: root.cid, pinataMetadata: { name: root.name } }) });
      entry.request_status = response.status;
      if (response.ok) {
        const job = await response.json().catch(() => ({}));
        Object.assign(entry, { job_id: job?.id ?? null, job_status: job?.status ?? null, error: null });
        break;
      }
      const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
      if (response.status === 429 && attempt < 6) {
        await sleepImpl(Math.max(5_000 * attempt, Number(response.headers?.get?.("retry-after") ?? 0) * 1000));
        continue;
      }
      entry.error = `pinByHash HTTP ${response.status}: ${detail}`;
      break;
    }
    await sleepImpl(spacingMs);
  }
  const started = now().getTime();
  const open = () => [...state.values()].filter((entry) => !entry.pinned && !entry.error && !TERMINAL_PIN_JOB.has(entry.job_status));
  while (open().length > 0) {
    const pinned = await pinnedNow().catch((error) => {
      for (const entry of open()) entry.last_list_error = error.message;
      return new Set();
    });
    for (const entry of open()) if (pinned.has(entry.cid)) Object.assign(entry, { pinned: true, job_status: "pinned", pinned_at: now().toISOString() });
    if (open().length === 0) break;
    const jobs = await fetchImpl(`${PINATA_API}/pinning/pinJobs?limit=1000`, { headers });
    if (jobs.ok) for (const row of (await jobs.json())?.rows ?? []) if (state.has(row.ipfs_pin_hash) && !state.get(row.ipfs_pin_hash).pinned) state.get(row.ipfs_pin_hash).job_status = row.status;
    if (now().getTime() - started + pollMs > waitMs) break;
    await sleepImpl(pollMs);
  }
  return [...state.values()];
}

/**
 * Read-only: how many of `cids` Pinata lists as pinned now, and the job status of the rest.
 *
 * @param {{ cids: string[], jwt: string, fetchImpl?: typeof fetch }} options - Roots, JWT.
 * @returns {Promise<{ roots: number, pinned: number, pending: Record<string, number>, not_listed: number }>} The counts.
 */
export async function pinStatus({ cids, jwt, fetchImpl = fetch }) {
  const headers = { authorization: `Bearer ${jwt}` };
  const pinned = new Set();
  for (let offset = 0; ; offset += 1000) {
    const response = await fetchImpl(`${PINATA_API}/data/pinList?status=pinned&pageLimit=1000&pageOffset=${offset}`, { headers });
    if (!response.ok) throw new Error(`pinList HTTP ${response.status}`);
    const rows = (await response.json())?.rows ?? [];
    for (const row of rows) pinned.add(row.ipfs_pin_hash);
    if (rows.length < 1000) break;
  }
  const jobs = await fetchImpl(`${PINATA_API}/pinning/pinJobs?limit=1000`, { headers });
  const status = new Map(jobs.ok ? ((await jobs.json())?.rows ?? []).map((row) => [row.ipfs_pin_hash, row.status]) : []);
  const pending = {};
  let notListed = 0;
  for (const cid of cids.filter((value) => !pinned.has(value))) {
    if (status.has(cid)) pending[status.get(cid)] = (pending[status.get(cid)] ?? 0) + 1;
    else notListed += 1;
  }
  return { roots: cids.length, pinned: cids.filter((value) => pinned.has(value)).length, pending, not_listed: notListed };
}

/**
 * The run's artifact manifest (assignment decisions.md 7.2 and 28): every root, part and schema, the CARs as release
 * assets, the upload, pin and gateway outcomes. It refuses a root that was not uploaded as planned, a missing tables
 * CAR, and any gateway row that is not a match.
 *
 * @param {{ plan: object, uploads: object[], tablesCars: object[], filebase: object, gatewayRows: object[], gatewayFile: { path: string, sha256: string }, pins: object[], release: { tag: string, status: string } }} inputs - Outcomes of every step.
 * @returns {object} The manifest.
 */
export function buildShardManifest({ plan, uploads, tablesCars, filebase, gatewayRows, gatewayFile, pins, release, backgroundChecks = null, extraNotes = [] }) {
  const uploaded = new Map(uploads.map((entry) => [`${entry.kind} ${entry.root}`, entry]));
  for (const entry of plan.archives) if (!uploaded.has(`archive ${entry.root}`)) throw new Error(`archive ${entry.root} (${entry.group} ${entry.shard}) was not uploaded`);
  for (const entry of plan.tables) if (!uploaded.has(`tables ${entry.root}`)) throw new Error(`tables ${entry.root} (${entry.group} ${entry.shard}) were not uploaded`);
  const cars = new Map(tablesCars.map((entry) => [entry.root, entry]));
  for (const entry of plan.tables) if (!cars.has(entry.root)) throw new Error(`no full tables CAR for ${entry.root}`);
  const failing = gatewayRows.filter((row) => resultOf(row) !== "match");
  if (failing.length > 0) throw new Error(`${failing.length} gateway rows are not a match (first: ${failing[0].gateway} ${failing[0].check} ${failing[0].cid} ${resultOf(failing[0])})`);
  if (!filebase.all_pinned) throw new Error("Filebase does not pin every CID, or a control came back pinned");
  const roots = [...plan.archives.map((entry) => entry.root), ...plan.tables.map((entry) => entry.root)];
  const unrecorded = roots.filter((cid) => !pins.some((pin) => pin.cid === cid));
  if (unrecorded.length > 0) throw new Error(`no Pinata outcome recorded for ${unrecorded.length} roots`);
  const directory = (cid, name, block) => ({ cid, name, size: block.size, codec: "directory", sha256: block.sha256, digest_of: "root block" });
  const order = (a, b) => a.group.localeCompare(b.group) || a.shard.localeCompare(b.shard);
  const archives = [...plan.archives].sort(order);
  const tables = [...plan.tables].sort(order);
  const unpinned = pins.filter((pin) => !pin.pinned).map(({ cid, job_status, request_status, error }) => ({ cid, job_status, request_status, error }));
  return {
    schemaVersion: "travis.publish-manifest.v2",
    label: "run 1: the shard archives uploaded with readback and checked on two public gateways; no Atlas PR (decisions.md 28)",
    run_id: plan.run_id,
    county: { key: "travis", state: "TX", fips: "48453" },
    lexicon_manifest: plan.lexicon_manifest,
    layout: { kind: "shard archives", note: "one CountyIndex archive per group per shard of at most 5,000 properties (decisions.md 25.9, 28.3)", groups: Object.fromEntries(plan.schemas.flatMap((schema) => schema.groups.map((group) => [group, { schema: schema.cid, archives: archives.filter((entry) => entry.group === group).length, properties: archives.filter((entry) => entry.group === group).reduce((total, entry) => total + (entry.properties ?? 0), 0), blocks: archives.filter((entry) => entry.group === group).reduce((total, entry) => total + entry.block_count, 0) }]))) },
    objects: [
      ...archives.map((entry) => directory(entry.root, `${entry.group}/${entry.shard}/archive (CountyIndex root)`, entry.root_block)),
      ...tables.map((entry) => directory(entry.root, `${entry.group}/${entry.shard}/tables (CountyTables root)`, entry.root_block)),
      ...tables.flatMap((entry) => entry.parts.map((part) => ({ cid: part.cid, name: `${entry.group}/${entry.shard}/tables/${part.table}/part-${String(part.position).padStart(5, "0")}.parquet`, size: part.bytes, codec: "file", sha256: part.sha256 }))),
      ...plan.schemas.map((schema) => ({ cid: schema.cid, name: `${schema.title ?? schema.groups.join(", ")} data-group schema (live lexicon)`, size: schema.size, codec: "file", sha256: schema.sha256 })),
    ],
    coverage: plan.counts,
    indexes: { county_index: archives.map((entry) => entry.root), county_tables: tables.map((entry) => entry.root) },
    sample_extract: plan.sample_extract,
    cars: [
      ...archives.map((entry) => ({ kind: "archive", group: entry.group, shard: entry.shard, root_cid: entry.root, schema_cid: entry.schema, block_count: entry.block_count, properties: entry.properties, car_validation: entry.car_validation, size: entry.size, sha256: entry.sha256, release_asset: path.basename(entry.path), readback_url: uploaded.get(`archive ${entry.root}`).gateway_url })),
      ...tables.map((entry) => {
        const car = cars.get(entry.root);
        return { kind: "tables", group: entry.group, shard: entry.shard, root_cid: entry.root, county_root: entry.county_root, schema_cid: entry.schema, block_count: car.block_count, parts: car.parts, size: car.size, sha256: car.sha256, release_asset: path.basename(car.path), readback_url: uploaded.get(`tables ${entry.root}`).gateway_url };
      }),
    ],
    release,
    uploads: { api: "https://rpc.filebase.io", readback_gateway: "https://ipfs.filebase.io", archives: archives.length, tables: tables.length, all_read_back: true },
    filebase_pins: { checked_at: filebase.checked_at, cids: filebase.rows.length, pinned: filebase.rows.filter((row) => row.pinned).length, controls_unpinned: filebase.controls.every((control) => !control.pinned) },
    gateway_checks: { scope: "the raw root block of every archive root, tables root and schema against its multihash; the full bytes of every table part against its size and sha256", file: gatewayFile, per_gateway: summarizeGateways(gatewayRows), ...(backgroundChecks ? { background: backgroundChecks } : {}) },
    second_pin: { vendor: "pinata", method: "pin-by-CID, recursive, of every archive and tables root", roots: roots.length, pinned: pins.filter((pin) => pin.pinned).length, unpinned_roots: unpinned },
    pins,
    notes: [
      "A directory entry's size and sha256 are its root block's: the bytes a gateway returns for /ipfs/<cid>?format=raw.",
      "Each archive CAR (elephant-cli hash --output-car) holds the whole DAG under its CountyIndex root. Each tables CAR holds the CountyTables block and every part's blocks; the block's county_root link resolves into the same shard's archive CAR, so import the archive CAR first.",
      `The CARs are assets of the repository release ${release.tag} (${release.status}), referenced here by name, size and sha256; they are not separate IPFS objects.`,
      "No origins are listed: no candidate-operated node serves these blocks. Filebase (the upload) and Pinata (the second pin) are pinning vendors; gateway URLs are locators, never identities.",
      ...(unpinned.length > 0 ? [`The second pin is incomplete: ${unpinned.length} roots are not pinned on Pinata (outcomes verbatim in pins[]); Filebase pins every CID.`] : []),
      "No IPNS name is used and no Atlas PR is open (decisions.md 28.3); the manifest does not list itself, its CID is in the publication record.",
      ...extraNotes,
    ],
  };
}

/**
 * Filebase `add` of one file with the CLI's parameters; the CID must equal the locally computed one.
 *
 * @param {{ bytes: Uint8Array, name: string, expectedCid: string, token: string, api?: string, fetchImpl?: typeof fetch }} options - File, local CID, bearer token.
 * @returns {Promise<{ status: number, hash: string | null }>} Filebase's answer.
 */
export async function filebaseAdd({ bytes, name, expectedCid, token, api = "https://rpc.filebase.io", fetchImpl = fetch }) {
  const form = new FormData();
  form.append("file", new Blob([bytes]), name);
  const response = await fetchImpl(`${api}/api/v0/add?pin=true&cid-version=1&raw-leaves=true&chunker=size-262144`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
  const text = await response.text();
  const hash = text.split("\n").filter((line) => line.trimStart().startsWith("{")).map((line) => JSON.parse(line)).find((line) => line.Hash)?.Hash ?? null;
  if (!response.ok || hash !== expectedCid) throw new Error(`Filebase add answered ${response.status} with ${hash ?? "no CID"}; the local CID is ${expectedCid}`);
  return { status: response.status, hash };
}

async function main(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let index = 0; index < rest.length; index += 2) flags[rest[index].replace(/^--/, "")] = rest[index + 1];
  const out = path.resolve(flags.out ?? ".");
  const runtimeDir = path.resolve(flags.runtime ?? ".");
  const read = async (file) => JSON.parse(await readFile(file, "utf8"));
  const write = async (file, value) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  };
  const plan = command === "plan" ? null : await read(path.join(out, "plan.json"));
  const filebaseToken = () => {
    const { FILEBASE_ACCESS_KEY: key, FILEBASE_SECRET_KEY: secret, FILEBASE_BUCKET: bucket } = process.env;
    if (!key || !secret || !bucket) throw new Error("FILEBASE_ACCESS_KEY, FILEBASE_SECRET_KEY and FILEBASE_BUCKET are not all set in this shell");
    return Buffer.from(`${key}:${secret}:${bucket}`).toString("base64");
  };
  const jwt = () => {
    if (!process.env.PINATA_JWT_SECRET_ACCESS_TOKEN) throw new Error("PINATA_JWT_SECRET_ACCESS_TOKEN is not set in this shell");
    return process.env.PINATA_JWT_SECRET_ACCESS_TOKEN;
  };
  const gateways = (flags.gateways ?? "").split(",").filter(Boolean);
  if (command === "plan") {
    const built = await buildPlan({ runDir: path.resolve(flags.run), runtimeDir, schemaCacheDir: flags["schema-cache"] });
    await write(path.join(out, "plan.json"), built);
    console.log(JSON.stringify({ archives: built.archives.length, tables: built.tables.length, parts: built.tables.reduce((total, entry) => total + entry.parts.length, 0), schemas: built.schemas.length, sizes: built.sizes, problems: built.problems }));
    if (built.problems.length > 0) process.exitCode = 1;
  } else if (command === "tables-cars") {
    const libs = await cliLibraries(flags.cli);
    const results = await mapLimited(plan.tables, Number(flags.concurrency ?? 4), async (entry) => {
      const marker = path.join(out, "tables-cars", `${entry.group}-${entry.shard}-tables.json`);
      if (existsSync(marker)) return read(marker);
      const made = await writeTablesCar({ entry, runtimeDir, outFile: path.join(out, "tables-cars", `travis-${entry.group}-${entry.shard}-tables.car`), libs });
      await write(marker, made);
      return made;
    });
    await write(path.join(out, "tables-cars.json"), results);
    console.log(JSON.stringify({ cars: results.length, blocks: results.reduce((total, entry) => total + entry.block_count, 0), bytes: results.reduce((total, entry) => total + entry.size, 0) }));
  } else if (command === "upload") {
    const { failed, failures, retries, results } = await uploadAll({ plan, out, cli: flags.cli, api: flags.api ?? "https://rpc.filebase.io", concurrency: Number(flags.concurrency ?? 4), runtimeDir, fetchTimeoutMs: flags["fetch-timeout-minutes"] ? Number(flags["fetch-timeout-minutes"]) * MINUTE : undefined });
    const previous = existsSync(path.join(out, "uploads.json")) ? (await read(path.join(out, "uploads.json"))).retries ?? [] : [];
    await write(path.join(out, "uploads.json"), { failed, failures, retries: [...previous, ...retries], results });
    console.log(JSON.stringify({ uploaded: results.length, retries: retries.length, failures }));
    if (failed) process.exitCode = 1;
  } else if (command === "filebase-pins") {
    const cids = planCids(plan);
    const size = Math.ceil(cids.length / Number(flags.concurrency ?? 8));
    const token = filebaseToken();
    const chunks = await Promise.all(Array.from({ length: Math.ceil(cids.length / size) }, (_, index) => filebasePins({ cids: cids.slice(index * size, (index + 1) * size), token })));
    const result = { checked_at: new Date().toISOString(), rows: chunks.flatMap((chunk) => chunk.rows), controls: chunks.map((chunk) => chunk.control) };
    result.all_pinned = result.rows.every((row) => row.pinned) && result.controls.every((control) => !control.pinned);
    await write(path.join(out, "filebase-pins.json"), result);
    console.log(JSON.stringify({ all_pinned: result.all_pinned, pinned: result.rows.filter((row) => row.pinned).length, total: result.rows.length, controls_pinned: result.controls.filter((control) => control.pinned).length }));
    if (!result.all_pinned) process.exitCode = 1;
  } else if (command === "gateway-check") {
    let jobs = gatewayJobs(plan);
    const sample = Number(flags.sample ?? 0);
    if (sample > 0) jobs = [...jobs.filter((job) => job.check === "raw").slice(0, sample), ...jobs.filter((job) => job.check === "file").slice(0, sample)];
    const jsonl = path.join(out, flags.jsonl ?? "gateway-checks.jsonl");
    const rows = await runGatewayChecks({ jobs, gateways, jsonl, concurrency: Number(flags.concurrency ?? 6), deadlineMs: Number(flags["deadline-minutes"] ?? 20) * MINUTE });
    const summary = summarizeGateways(rows);
    if (sample === 0) await write(path.join(out, "gateway-checks.json"), rows);
    console.log(JSON.stringify(summary));
    if (Object.values(summary).some((entry) => entry.mismatch > 0 || entry.unverified > 0)) process.exitCode = 1;
  } else if (command === "pin") {
    const roots = [...plan.archives.map((entry) => ({ cid: entry.root, name: `travis-${plan.run_id}-${entry.group}-${entry.shard}-archive` })), ...plan.tables.map((entry) => ({ cid: entry.root, name: `travis-${plan.run_id}-${entry.group}-${entry.shard}-tables` }))];
    const pins = await pinRoots({ roots, jwt: jwt(), waitMs: Number(flags["wait-minutes"] ?? 45) * MINUTE });
    await write(path.join(out, "pins.json"), pins);
    const count = (predicate) => pins.filter(predicate).length;
    console.log(JSON.stringify({ roots: pins.length, pinned: count((pin) => pin.pinned), refused: count((pin) => pin.error), failed_jobs: count((pin) => TERMINAL_PIN_JOB.has(pin.job_status)), pending: count((pin) => !pin.pinned && !pin.error && !TERMINAL_PIN_JOB.has(pin.job_status)), statuses: [...new Set(pins.filter((pin) => !pin.pinned).map((pin) => pin.error ?? pin.job_status))] }));
    if (pins.some((pin) => !pin.pinned)) process.exitCode = 2;
  } else if (command === "gateway-paced") {
    const jsonl = path.join(out, flags.jsonl);
    if (!existsSync(jsonl) && flags["seed-from"]) {
      const seed = (await readFile(path.join(out, flags["seed-from"]), "utf8")).split("\n").filter(Boolean).filter((line) => JSON.parse(line).gateway === flags.gateway);
      await writeFile(jsonl, seed.length > 0 ? `${seed.join("\n")}\n` : "");
    }
    const jobs = gatewayJobs(plan);
    if (flags["extra-file"]) {
      const [cid, size, sha256] = flags["extra-file"].split(",");
      jobs.push({ cid, check: "file", expected: { size: Number(size), sha256 } });
    }
    const started = new Date().toISOString();
    const { stop, rows } = await runPacedChecks({ jobs, gateway: flags.gateway, jsonl });
    const summary = { gateway: flags.gateway, started, finished: new Date().toISOString(), jobs: jobs.length, stop, ...summarizeGateways(rows)[flags.gateway] };
    await write(path.join(out, `${path.basename(jsonl, ".jsonl")}.summary.json`), summary);
    if (flags["copy-to"]) await write(path.resolve(flags["copy-to"]), { summary, rows });
    console.log(JSON.stringify(summary));
    if (stop || summary.unverified > 0) process.exitCode = 1;
  } else if (command === "gateway-status") {
    const jsonl = path.join(out, flags.jsonl);
    const rows = existsSync(jsonl) ? (await readFile(jsonl, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    const standing = [...standingRows(rows).values()].filter((row) => row.gateway === flags.gateway);
    const total = gatewayJobs(plan).length + (flags["extra-jobs"] ? Number(flags["extra-jobs"]) : 0);
    const summary = summarizeGateways(standing)[flags.gateway] ?? { match: 0, mismatch: 0, unverified: 0 };
    const pidFile = path.join(out, `${path.basename(jsonl, ".jsonl")}.pid.json`);
    const pid = existsSync(pidFile) ? (await read(pidFile)).pid : null;
    let running = false;
    try { running = pid ? process.kill(pid, 0) : false; } catch { running = false; }
    const finished = existsSync(path.join(out, `${path.basename(jsonl, ".jsonl")}.summary.json`));
    console.log(JSON.stringify({ gateway: flags.gateway, running, finished, jobs: total, match: summary.match, mismatch: summary.mismatch, unverified: summary.unverified, remaining: total - summary.match - summary.mismatch, last_row_at: rows.at(-1)?.checked_at ?? null }));
  } else if (command === "pin-status") {
    const cids = [...plan.archives.map((entry) => entry.root), ...plan.tables.map((entry) => entry.root), ...(flags["extra-cids"] ?? "").split(",").filter(Boolean)];
    console.log(JSON.stringify({ checked_at: new Date().toISOString(), ...(await pinStatus({ cids, jwt: jwt() })) }));
  } else if (command === "manifest") {
    const gatewayRows = await read(path.join(out, "gateway-checks.json"));
    if (flags["with-matches-of"]) {
      const lines = (await readFile(path.join(out, "gateway-checks.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
      gatewayRows.push(...[...standingRows(lines).values()].filter((row) => row.gateway === flags["with-matches-of"] && resultOf(row) === "match"));
    }
    const gatewayCopy = path.resolve(flags["gateway-copy"]);
    await write(gatewayCopy, gatewayRows);
    const manifest = buildShardManifest({
      plan,
      uploads: (await read(path.join(out, "uploads.json"))).results,
      tablesCars: await read(path.join(out, "tables-cars.json")),
      filebase: await read(path.join(out, "filebase-pins.json")),
      gatewayRows,
      gatewayFile: { path: flags["gateway-name"], sha256: sha256Hex(await readFile(gatewayCopy)) },
      pins: await read(path.join(out, "pins.json")),
      release: { tag: flags["release-tag"], status: "not created; a separate go at submission" },
      backgroundChecks: flags["background-gateway"] ? { gateway: flags["background-gateway"], file: flags["background-file"], status: "running after this manifest was pinned; paced to the gateway's quota (decisions.md 28.7, ruling 3); its rows are kept outside this immutable manifest" } : null,
      extraNotes: flags["background-gateway"] ? [`The ${gatewayRows.filter((row) => row.gateway === flags["background-gateway"]).length} ${flags["background-gateway"]} rows in gateway_checks were made before any Pinata pin, so that gateway fetched them from the public network; its remaining rows are checked in the background, paced to its quota, and recorded in ${flags["background-file"]}, not in this manifest.`] : [],
    });
    await write(path.resolve(flags.output), manifest);
    const bytes = await readFile(path.resolve(flags.output));
    console.log(JSON.stringify({ output: flags.output, objects: manifest.objects.length, cars: manifest.cars.length, size: bytes.length, sha256: sha256Hex(bytes) }));
  } else if (command === "pin-manifest") {
    const { importer } = await cliLibraries(flags.cli);
    const bytes = await readFile(path.resolve(flags.file));
    const cid = await unixfsCid(importer, bytes);
    const filebase = await filebaseAdd({ bytes, name: path.basename(flags.file), expectedCid: cid, token: filebaseToken() });
    const pinata = await pinByCid({ cid, name: `travis-publish-manifest-${plan.run_id}`, jwt: jwt(), waitMs: 30 * MINUTE });
    const expected = { size: bytes.length, sha256: sha256Hex(bytes) };
    const checks = await Promise.all(gateways.map((gateway) => gatewayCheck({ cid, gateway, check: "file", expected })));
    const result = { cid, ...expected, filebase, pinata, gateway_checks: checks.map(({ url, detail, ...kept }) => kept) };
    await write(path.join(out, "manifest-pin.json"), result);
    console.log(JSON.stringify({ cid, size: expected.size, filebase: filebase.hash === cid, pinata: pinata.pinned ? "pinned" : pinata.error ?? pinata.job_status, gateways: checks.map((row) => `${row.gateway} ${row.bytes}`) }));
    if (!pinata.pinned || checks.some((row) => row.bytes !== "match")) process.exitCode = 1;
  } else {
    throw new Error("usage: t6-publish.mjs <plan|tables-cars|upload|filebase-pins|gateway-check|gateway-paced|gateway-status|pin|pin-status|manifest|pin-manifest> --out <dir> ...");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
