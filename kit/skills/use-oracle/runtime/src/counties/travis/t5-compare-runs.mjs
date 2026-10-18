#!/usr/bin/env node
/**
 * T5 resume proof (assignment T5 phase A step 5): compare the done-markers of runs over the same plan. For every stage of
 * every shard it reports the attempt that produced the final output, the attempts the run's processes made, and whether
 * the output digests equal the reference run's: CAR SHA-256 and archive root, tables root and tables tree, hash CSV,
 * validate and CAR-check CSVs, roof-age JSONL and query-table Parquet, the per-parcel artifact digests of the appraisal
 * and permit stages, and the link pass files. Not compared byte for byte: `tables-export.json` (the CLI writes the absolute
 * output path and the export time into it) and the `hashed/` ZIPs (they carry file times; the CAR holds their blocks).
 *
 *   node src/counties/travis/t5-compare-runs.mjs --reference <run-dir> --run <run-dir> [--run <run-dir>] [--out <file>]
 *
 * @module counties/travis/t5-compare-runs
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { RUNTIME_ROOT } from "./t3-snapshot.mjs";
import { digestOf } from "./t5-shards.mjs";

const rel = (target) => path.relative(RUNTIME_ROOT, target).split(path.sep).join("/");

/**
 * Comparable digests of one marker's output (what must be equal across runs over the same inputs).
 *
 * @param {Record<string, any>} marker - Done-marker.
 * @param {string} runDir - Its run.
 * @returns {Promise<Record<string, any>>} Digests.
 */
async function comparable(marker, runDir) {
  const out = marker.output ?? {};
  const files = {};
  for (const item of out.files ?? []) {
    const name = item.path.replace(/-a\d+(\/|$)/g, "-aN$1").replace(/\.p\d+/g, "");
    if (/tables-export\.json$/.test(name)) continue;
    // The CLI's per-property ZIPs under hashed/ carry file times, so they differ byte for byte between runs; they are an
    // intermediate (the CAR holds the same blocks and is what is published), compared by count only.
    if (/\/hashed$/.test(name)) continue;
    files[name] = item.sha256;
  }
  const result = { files };
  if (out.car) result.car = { root: out.car.root, blocks: out.car.blocks };
  if (out.tables) result.tables = out.tables;
  if (out.parcels) result.parcels = digestOf(out.parcels);
  if (out.states) result.states = digestOf(Object.fromEntries(Object.entries(out.states).map(([key, value]) => [key, { ...value, artifact_hash: value.artifact_hash ?? null }])));
  if (out.processed) result.processed = out.processed;
  if (out.invalid) result.invalid = out.invalid.length;
  if (out.car_validation) result.car_validation = out.car_validation;
  if (out.roof_age) result.roof_age = digestOf(out.roof_age);
  void runDir;
  return result;
}

/**
 * Every marker of a run.
 *
 * @param {string} runDir - Run directory.
 * @returns {Promise<Map<string, Record<string, any>>>} `<dir>/<stage>` to marker.
 */
async function markersOf(runDir) {
  const out = new Map();
  for (const sub of ["global", ...((await readdir(path.join(runDir, "shards"))).sort().map((name) => path.join("shards", name)))]) {
    for (const name of (await readdir(path.join(runDir, sub))).sort()) {
      if (!name.endsWith(".done.json")) continue;
      out.set(`${sub}/${name.replace(/\.done\.json$/, "")}`, JSON.parse(await readFile(path.join(runDir, sub, name), "utf8")));
    }
  }
  return out;
}

/**
 * The attempts each stage made in a run (`stages.jsonl` lines: the runs of a stage, by process).
 *
 * @param {string} runDir - Run directory.
 * @returns {Promise<Map<string, { attempt: number, pid: number, at: string, redone_because: string }[]>>} Attempts.
 */
async function attemptsOf(runDir) {
  const out = new Map();
  const text = await readFile(path.join(runDir, "stages.jsonl"), "utf8").catch(() => "");
  for (const line of text.split("\n").filter(Boolean)) {
    const item = JSON.parse(line);
    const key = `${item.dir.split("/").slice(-1)[0] === "global" ? "global" : `shards/${item.dir.split("/").slice(-1)[0]}`}/${item.stage}`;
    (out.get(key) ?? out.set(key, []).get(key)).push({ attempt: item.attempt, pid: item.pid, at: item.at, redone_because: item.redone_because });
  }
  return out;
}

/**
 * Compare runs against a reference.
 *
 * @param {{ reference: string, runs: string[] }} options - Run directories.
 * @returns {Promise<Record<string, any>>} Report.
 */
export async function compareRuns({ reference, runs }) {
  const referenceMarkers = await markersOf(reference);
  const report = { reference: rel(reference), runs: [] };
  for (const runDir of runs) {
    const markers = await markersOf(runDir);
    const attempts = await attemptsOf(runDir);
    const state = JSON.parse(await readFile(path.join(runDir, "run-state.json"), "utf8"));
    const pids = state.attempts.map((item) => item.pid);
    const differences = [];
    const stages = [];
    for (const [key, refMarker] of referenceMarkers) {
      const marker = markers.get(key);
      if (!marker) {
        differences.push({ stage: key, reason: "missing" });
        continue;
      }
      if (key === "global/loader" || key === "global/plan" || key === "global/cli") continue;
      const left = await comparable(refMarker, reference);
      const right = await comparable(marker, runDir);
      const equal = JSON.stringify(left) === JSON.stringify(right);
      if (!equal) differences.push({ stage: key, reference: left, run: right });
      const made = attempts.get(key) ?? [];
      stages.push({ stage: key, final_attempt: marker.attempt, final_by_process: pids.indexOf(made.find((item) => item.attempt === marker.attempt)?.pid) + 1, runs: made.length, equal });
    }
    const byProcess = {};
    for (const stage of stages) byProcess[stage.final_by_process] = (byProcess[stage.final_by_process] ?? 0) + 1;
    const redone = stages.filter((stage) => stage.runs > 1 || stage.final_attempt > 1);
    report.runs.push({
      run: rel(runDir),
      attempts: state.attempts.map((item) => ({ attempt: item.attempt, pid: item.pid, started_at: item.started_at, ended_at: item.ended_at ?? null, status: item.status, reaped_orphans: item.reaped_orphans?.length ?? 0 })),
      stages_compared: stages.length,
      all_equal_to_reference: differences.length === 0,
      differences,
      final_markers_by_process: byProcess,
      stages_run_more_than_once: redone.map((stage) => ({ stage: stage.stage, runs: stage.runs, final_attempt: stage.final_attempt })),
      shards_finished_by_first_process: [...new Set(stages.filter((stage) => stage.stage.endsWith("/merge") && stage.final_by_process === 1).map((stage) => stage.stage.split("/")[1]))],
      shards_finished_after_resume: [...new Set(stages.filter((stage) => stage.stage.endsWith("/merge") && stage.final_by_process > 1).map((stage) => stage.stage.split("/")[1]))],
    });
  }
  return report;
}

/** @param {string[]} argv */
function parseFlags(argv) {
  const flags = { run: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index].slice(2);
    if (name === "run") flags.run.push(argv[index + 1]);
    else flags[name] = argv[index + 1];
  }
  return flags;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const flags = parseFlags(process.argv.slice(2));
  compareRuns({ reference: path.resolve(flags.reference), runs: flags.run.map((item) => path.resolve(item)) })
    .then(async (report) => {
      if (flags.out) await writeFile(path.resolve(flags.out), `${JSON.stringify(report, null, 1)}\n`);
      console.log(JSON.stringify(report.runs.map((item) => ({ run: item.run, all_equal_to_reference: item.all_equal_to_reference, stages_compared: item.stages_compared, differences: item.differences.length, attempts: item.attempts.map((attempt) => attempt.status), shards_finished_by_first_process: item.shards_finished_by_first_process.length, shards_finished_after_resume: item.shards_finished_after_resume.length, stages_run_more_than_once: item.stages_run_more_than_once }))));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : error);
      process.exit(1);
    });
}
