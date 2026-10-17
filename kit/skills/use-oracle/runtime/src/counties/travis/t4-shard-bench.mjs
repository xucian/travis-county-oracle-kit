#!/usr/bin/env node
/**
 * T4 shard benchmark: the elephant-cli chain (validate, hash, CAR validate, export-tables) on K shards of one group
 * directory at once, to measure the parallel rate the full run can use. The kit cuts each group's CAR at 5,000
 * properties, so a full run is a set of independent shards; this measures how many of them one machine runs side by side.
 * Local files only (no upload); every shard must validate with 0 failures.
 *
 *   node src/counties/travis/t4-shard-bench.mjs --group-dir <run>/validate/county --shards 4 --cli <elephant-cli> [--out <file>]
 *
 * @module counties/travis/t4-shard-bench
 */
import { cp, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { parseCliOutput, runCli } from "./t4-run.mjs";

export const SHARD_BENCH_VERSION = "travis-t4-shard-bench.v1";

/**
 * Split parcel directories round-robin into `shards` lists.
 *
 * @param {string[]} parcels - Parcel directory names.
 * @param {number} shards - Shard count.
 * @returns {string[][]} Shards.
 */
export function splitShards(parcels, shards) {
  const out = Array.from({ length: shards }, () => []);
  [...parcels].sort().forEach((parcel, index) => out[index % shards].push(parcel));
  return out.filter((shard) => shard.length > 0);
}

/**
 * Run the benchmark.
 *
 * @param {{ groupDir: string, shards: number, cli: string }} options - Options.
 * @returns {Promise<Record<string, any>>} Result.
 */
export async function benchShards({ groupDir, shards, cli }) {
  const group = path.basename(groupDir);
  const parcels = (await readdir(groupDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const split = splitShards(parcels, shards);
  const root = path.join(path.dirname(groupDir), `shards-${group}-${split.length}`);
  for (const [index, shard] of split.entries()) {
    const dir = path.join(root, `s${index}`, group);
    await mkdir(dir, { recursive: true });
    for (const parcel of shard) await cp(path.join(groupDir, parcel), path.join(dir, parcel), { recursive: true });
  }
  const started = performance.now();
  const results = await Promise.all(
    split.map(async (shard, index) => {
      const cwd = path.join(root, `s${index}`);
      const name = `travis-${group}-s${index}`;
      const steps = {};
      const run = async (stage, args) => {
        const result = await runCli(cli, args, cwd, path.join(cwd, `${stage}.log`));
        steps[stage] = { ms: Math.round(result.ms), exit: result.code, ...parseCliOutput(result.output) };
      };
      const shardStarted = performance.now();
      await run("validate", ["validate", `./${group}`, "--output-csv", `./${name}-errors.csv`]);
      await run("hash", ["hash", `./${group}`, "--output-zip", `./${name}-hashed`, "--output-csv", `${name}-hash.csv`, "--output-car", `${name}.car`]);
      await run("car_validate", ["validate", `${name}.car`, "--output-csv", `${name}-car-errors.csv`]);
      await run("export_tables", ["export-tables", `${name}.car`, "--output", `./${name}-tables`, "--part-size", "128m", "--output-json", `${name}-tables-export.json`]);
      return { shard: index, parcels: shard.length, ms: Math.round(performance.now() - shardStarted), steps };
    }),
  );
  const wallMs = performance.now() - started;
  const failed = results.filter((result) => result.steps.validate.processed?.failed !== 0 || result.steps.validate.processed?.succeeded !== result.parcels || !result.steps.car_validate.car_validation?.passed);
  return {
    bench_version: SHARD_BENCH_VERSION,
    group,
    parcels: parcels.length,
    shards: split.length,
    wall_ms: Math.round(wallMs),
    wall_ms_per_parcel: Math.round((wallMs / parcels.length) * 1000) / 1000,
    all_passed: failed.length === 0,
    failed_shards: failed.map((result) => result.shard),
    results,
  };
}

/** @param {string[]} argv @returns {Record<string, string>} */
function parseFlags(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith("--") || argv[index + 1] === undefined) throw new Error("usage: t4-shard-bench.mjs --group-dir <dir> --shards <n> --cli <elephant-cli> [--out <file>]");
    flags[argv[index].slice(2)] = argv[index + 1];
  }
  return flags;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const flags = parseFlags(process.argv.slice(2));
  benchShards({ groupDir: path.resolve(flags["group-dir"]), shards: Number.parseInt(flags.shards ?? "4", 10), cli: path.resolve(flags.cli) })
    .then(async (result) => {
      if (flags.out) await writeFile(path.resolve(flags.out), `${JSON.stringify(result, null, 1)}\n`);
      console.log(JSON.stringify({ travis_t4_shard_bench: result.group, parcels: result.parcels, shards: result.shards, wall_s: Math.round(result.wall_ms / 100) / 10, wall_ms_per_parcel: result.wall_ms_per_parcel, all_passed: result.all_passed }));
      process.exit(result.all_passed ? 0 : 1);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : error);
      process.exit(1);
    });
}
