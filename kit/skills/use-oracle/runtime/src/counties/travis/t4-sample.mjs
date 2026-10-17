#!/usr/bin/env node
/**
 * T4 feasibility sample (kit `county-ingest-run` section 2): a deterministic, uniform sample of the seed. The selected
 * accounts are the `size` PROP_IDs with the smallest SHA-256 of `<salt>:<PROP_ID>`, so the same seed and salt always
 * give the same sample, and nothing about a parcel (type, permits, geometry) steers the choice.
 *
 *   node src/counties/travis/t4-sample.mjs [--seed data/seeds/travis.csv] [--size 1000] [--salt travis-t4-feasibility-v1] \
 *     [--output data/seeds/travis-feasibility-1000.csv]
 *
 * Writes the sample CSV (the seed's own columns, values unchanged) and `<output>.json` with the salt, the seed digest,
 * the selected PROP_IDs and the sample's digest.
 *
 * @module counties/travis/t4-sample
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { renderCsv } from "../../core/csv.mjs";
import { RUNTIME_ROOT } from "./t3-snapshot.mjs";
import { DEFAULT_SEED, streamCsvFile } from "./t4-permit-links.mjs";

export const SAMPLE_VERSION = "travis-t4-sample.v1";
export const DEFAULT_SALT = "travis-t4-feasibility-v1";

/**
 * @param {string} salt - Salt.
 * @param {string} propId - PROP_ID as printed.
 * @returns {string} Sort key.
 */
export const sampleKey = (salt, propId) => createHash("sha256").update(`${salt}:${propId}`).digest("hex");

/**
 * Draw the sample.
 *
 * @param {object} options - Options.
 * @param {string} [options.seedPath] - Seed CSV.
 * @param {number} [options.size] - Sample size.
 * @param {string} [options.salt] - Salt.
 * @param {string} options.output - Sample CSV path.
 * @returns {Promise<Record<string, any>>} Sample manifest (also `<output>.json`).
 */
export async function drawSample({ seedPath = DEFAULT_SEED, size = 1000, salt = DEFAULT_SALT, output }) {
  if (!Number.isInteger(size) || size < 1) throw new Error("--size must be a positive integer");
  const keys = [];
  for await (const row of streamCsvFile(seedPath, { columns: ["parcel_id"] })) keys.push([sampleKey(salt, row.parcel_id.trim()), row.parcel_id.trim()]);
  if (keys.length < size) throw new Error(`the seed holds ${keys.length} rows, fewer than ${size}`);
  keys.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  const chosen = new Set(keys.slice(0, size).map(([, propId]) => propId));
  /** @type {Record<string, string>[]} */
  const rows = [];
  /** @type {string[] | null} */
  let columns = null;
  for await (const row of streamCsvFile(seedPath)) {
    columns ??= Object.keys(row);
    if (chosen.has(row.parcel_id.trim())) rows.push(row);
  }
  const text = renderCsv(columns ?? [], rows);
  await writeFile(output, text);
  const manifest = {
    sample_version: SAMPLE_VERSION,
    salt,
    size,
    seed: { path: path.relative(RUNTIME_ROOT, path.resolve(seedPath)).split(path.sep).join("/"), sha256: createHash("sha256").update(await readFile(seedPath)).digest("hex"), rows: keys.length },
    output: { path: path.relative(RUNTIME_ROOT, path.resolve(output)).split(path.sep).join("/"), sha256: createHash("sha256").update(text).digest("hex"), rows: rows.length },
    prop_ids: rows.map((row) => row.parcel_id.trim()),
  };
  await writeFile(`${output}.json`, `${JSON.stringify(manifest, null, 1)}\n`);
  return manifest;
}

/** @param {string[]} argv @returns {Record<string, string>} */
function parseFlags(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith("--") || argv[index + 1] === undefined) throw new Error("usage: t4-sample.mjs [--seed <csv>] [--size <n>] [--salt <text>] [--output <csv>]");
    flags[argv[index].slice(2)] = argv[index + 1];
  }
  return flags;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const flags = parseFlags(process.argv.slice(2));
  const size = Number.parseInt(flags.size ?? "1000", 10);
  drawSample({
    seedPath: path.resolve(flags.seed ?? DEFAULT_SEED),
    size,
    salt: flags.salt ?? DEFAULT_SALT,
    output: path.resolve(flags.output ?? path.join(RUNTIME_ROOT, "data", "seeds", `travis-feasibility-${size}.csv`)),
  })
    .then((manifest) => console.log(JSON.stringify({ travis_t4_sample: manifest.output.path, rows: manifest.output.rows, sha256: manifest.output.sha256, seed_sha256: manifest.seed.sha256, salt: manifest.salt })))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
