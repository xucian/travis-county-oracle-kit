#!/usr/bin/env node
/**
 * T5 projection (assignment T5 phase A step 6; kit `county-ingest-run` section 2): the full run's hours and peak memory
 * from measured numbers only, with the v4 transform.
 *
 * - **From the dry run** (the T5 runner itself, real seed rows, 8 shards in flight): every shard stage's wall time as its
 *   done-marker records it, measured while the other shards ran beside it. The sum per stage, scaled to the full roll
 *   (County-side stages by seed rows; Property Improvement stages by the larger of the permit-group parcels and the
 *   published permits, both counted over the whole capture by the link pass, as T4 scaled them), divided by the
 *   concurrency, gives the shard phase; the dry run's own packing (its pool wall time over that ideal) is applied as
 *   measured. The global stages (readiness, manifest, link pass over the whole capture) and the Loader's finalize (the
 *   internal permits table holds every captured permit) are already full scale in a dry run and are added as measured;
 *   the plan and the appraisal index scale with the seed.
 * - **From the T4 method** (`t4-projection.mjs` with `t4-shard-bench.mjs` passes on the v4 feasibility sample), when given.
 * - **Peak memory**: the dry run's peaks (runner, the elephant-cli processes together, swap) and, when given, a one-process
 *   bench on a larger shard, so the per-process CLI memory can be read at two shard sizes.
 *
 *   node src/counties/travis/t5-projection.mjs --dry-run <run-dir> [--t4-projection <file>] [--bench-single <file>] [--out <file>]
 *
 * @module counties/travis/t5-projection
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { RUNTIME_ROOT } from "./t3-snapshot.mjs";

export const T5_PROJECTION_VERSION = "travis-t5-projection.v1";
export const GATE_MS = 48 * 3600 * 1000;
export const FULL_SEED_ROWS = 441961;
const PI_STAGES = /^cli_property_improvement_/;
const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * Project the full run from a dry run's record.
 *
 * @param {object} input - Inputs.
 * @param {Record<string, any>} input.record - The dry run's `run.json`.
 * @param {Record<string, any>} input.link - The link pass summary (whole capture).
 * @param {number} [input.fullSeedRows] - Seed rows of the full run.
 * @param {Record<string, any> | null} [input.t4] - A `t4-projection.mjs` result on the v4 feasibility sample.
 * @param {Record<string, any> | null} [input.single] - A one-shard `t4-shard-bench.mjs` result (memory per process).
 * @returns {Record<string, any>} Projection.
 */
export function projectFromDryRun({ record, link, fullSeedRows = FULL_SEED_ROWS, t4 = null, single = null }) {
  const dryParcels = record.counts.appraisal.seed;
  const dryPermitParcels = record.counts.permits.parcels_with_permits;
  const dryPermits = record.counts.permits.published;
  const parcelScale = fullSeedRows / dryParcels;
  const permitScale = Math.max(link.linked_parcels / Math.max(1, dryPermitParcels), link.linked / Math.max(1, dryPermits));
  const concurrency = record.scope.concurrency;
  const lines = [];
  let shardWorkMs = 0;
  for (const [stage, timing] of Object.entries(record.timings.stages)) {
    const scale = PI_STAGES.test(stage) ? permitScale : parcelScale;
    const projected = timing.total_ms * scale;
    shardWorkMs += projected;
    lines.push({ stage, measured_ms: timing.total_ms, shards: timing.shards, scale: round(scale, 3), projected_h: round(projected / 3_600_000, 2), basis: PI_STAGES.test(stage) ? `larger of ${link.linked_parcels} permit-group parcels / ${dryPermitParcels} and ${link.linked} permits / ${dryPermits}` : `${fullSeedRows} seed rows / ${dryParcels}` });
  }
  const dryShardWorkMs = Object.values(record.timings.stages).reduce((sum, timing) => sum + timing.total_ms, 0);
  const idealDryPoolMs = dryShardWorkMs / concurrency;
  const dryPoolMs = record.timings.pool_ms ?? null;
  const packing = dryPoolMs ? dryPoolMs / idealDryPoolMs : 1;
  const globalMs = record.timings.global_ms ?? 0;
  const finalizeMs = record.timings.finalize_ms ?? 0;
  const shardPhaseMs = (shardWorkMs / concurrency) * packing;
  const totalMs = globalMs + shardPhaseMs + finalizeMs;
  const perProcess = record.memory.peak_cli_processes > 0 ? record.memory.peak_cli_rss_gb / record.memory.peak_cli_processes : null;
  const singlePerProcess = single ? single.memory.peak_total_rss_bytes / 1024 ** 3 / Math.max(1, single.memory.peak_processes) : null;
  return {
    projection_version: T5_PROJECTION_VERSION,
    dry_run: { run_id: record.run_id, parcels: dryParcels, shards: record.shards.total, shard_size: record.scope.shard_size, concurrency, permit_parcels: dryPermitParcels, permits: dryPermits, pool_h: dryPoolMs === null ? null : round(dryPoolMs / 3_600_000, 3), ideal_pool_h: round(idealDryPoolMs / 3_600_000, 3), packing: round(packing, 3) },
    full_scale: { seed_rows: fullSeedRows, shards: Math.ceil(fullSeedRows / 5000), permit_parcels: link.linked_parcels, permits: link.linked },
    scales: { per_parcel: round(parcelScale, 3), permit_group: round(permitScale, 3) },
    stages: lines,
    global_h: round(globalMs / 3_600_000, 3),
    shard_phase_h: round(shardPhaseMs / 3_600_000, 2),
    finalize_h: round(finalizeMs / 3_600_000, 3),
    full_run: { projected_h: round(totalMs / 3_600_000, 2), within_gate: totalMs <= GATE_MS, margin_h: round((GATE_MS - totalMs) / 3_600_000, 2), gate_h: 48 },
    t4_method: t4 ? { sequential_h: t4.full_run?.projected_h ?? null, sharded_h: t4.full_run_sharded?.projected_h ?? null, sharded_within_gate: t4.full_run_sharded?.within_gate ?? null, sample: t4.sample } : null,
    memory: {
      dry_run: record.memory,
      cli_gb_per_process_dry_run: perProcess === null ? null : round(perProcess, 2),
      single_process_bench: single ? { parcels: single.parcels, shards: single.shards, peak_gb: round(single.memory.peak_total_rss_bytes / 1024 ** 3, 2), gb_per_process: round(singlePerProcess, 2) } : null,
      // Two peaks that never overlap: the link pass (the runner alone, before any elephant-cli process) and the shard pool
      // (8 CLI processes and the runner, which then holds well under 1 GB; the dry run's combined peak is measured).
      full_run_peak_estimate_gb: perProcess === null ? null : round(Math.max(record.memory.peak_runner_rss_gb, concurrency * Math.max(perProcess, singlePerProcess ?? 0) + Math.max(0, (record.memory.peak_combined_rss_gb ?? 0) - record.memory.peak_cli_rss_gb)), 1),
      note: "the runner's own peak is the link pass, before the elephant-cli pool starts; during the pool the runner holds well under 1 GB",
    },
    assumptions: [
      "the dry run's stage times were measured with 8 shards in flight on this machine; they scale linearly with parcels (County side) or with the larger of permit-group parcels and permits (Property Improvement side)",
      "the dry run's shards are 250 properties; the full run's are 5,000, so each CLI call's fixed start-up cost is spread over 20 times more properties: the projection is conservative on that count",
      "memory as free as during the dry run (the preflight's swap and VM warnings apply); a nearly full swap doubled the 8-shard County time in the T4 measurements (decisions.md 25.9)",
      "no upload, pin or gateway time (T6)",
    ],
  };
}

/** @param {string[]} argv @returns {Record<string, string>} */
function parseFlags(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) flags[argv[index].slice(2)] = argv[index + 1];
  return flags;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const flags = parseFlags(process.argv.slice(2));
  const runDir = path.resolve(flags["dry-run"]);
  const record = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
  // Phase times from the markers' own clocks: the global stages, the shard pool (first shard stage start to last merge),
  // and the Loader's finalize.
  const { readdir } = await import("node:fs/promises");
  const markerFiles = [...(await readdir(path.join(runDir, "global"))).filter((name) => name.endsWith(".done.json")).map((name) => path.join(runDir, "global", name))];
  for (const shard of await readdir(path.join(runDir, "shards"))) for (const name of await readdir(path.join(runDir, "shards", shard))) if (name.endsWith(".done.json")) markerFiles.push(path.join(runDir, "shards", shard, name));
  const markers = await Promise.all(markerFiles.map(async (file) => ({ file, marker: JSON.parse(await readFile(file, "utf8")) })));
  const shardMarkers = markers.filter((item) => item.file.includes(`${path.sep}shards${path.sep}`)).map((item) => item.marker);
  const globalMarkers = markers.filter((item) => !item.file.includes(`${path.sep}shards${path.sep}`)).map((item) => item.marker);
  record.timings.global_ms ??= globalMarkers.filter((marker) => marker.stage !== "loader").reduce((sum, marker) => sum + marker.ms, 0);
  record.timings.finalize_ms ??= globalMarkers.find((marker) => marker.stage === "loader")?.ms ?? 0;
  record.timings.pool_ms ??= Math.max(...shardMarkers.map((marker) => Date.parse(marker.finished_at))) - Math.min(...shardMarkers.map((marker) => Date.parse(marker.started_at)));
  const linkMarker = JSON.parse(await readFile(path.join(runDir, "global", "link.done.json"), "utf8"));
  const link = JSON.parse(await readFile(path.join(runDir, "global", linkMarker.output.dir, "summary.json"), "utf8"));
  const t4 = flags["t4-projection"] ? JSON.parse(await readFile(path.resolve(flags["t4-projection"]), "utf8")) : null;
  const single = flags["bench-single"] ? JSON.parse(await readFile(path.resolve(flags["bench-single"]), "utf8")) : null;
  const projection = projectFromDryRun({ record, link, t4, single });
  if (flags.out) await writeFile(path.resolve(flags.out), `${JSON.stringify(projection, null, 1)}\n`);
  console.log(JSON.stringify({ travis_t5_projection: path.relative(RUNTIME_ROOT, runDir), full_run: projection.full_run, shard_phase_h: projection.shard_phase_h, global_h: projection.global_h, finalize_h: projection.finalize_h, packing: projection.dry_run.packing, t4_method: projection.t4_method, memory: { peak_estimate_gb: projection.memory.full_run_peak_estimate_gb, per_process_dry: projection.memory.cli_gb_per_process_dry_run, single: projection.memory.single_process_bench } }));
}
