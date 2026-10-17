#!/usr/bin/env node
/**
 * T4 48-hour projection (kit `county-ingest-run` section 2, `county-permit-adapter` "Throughput rules"): the full-county
 * duration projected from measured numbers only.
 *
 * - Once-per-run stages are measured at full scale, not projected: the Socrata harvest of the whole export (the only
 *   source acquisition T4 adds; TCAD and TNR are cached since T1), the capture verification, the roll index and the
 *   link pass over every permit.
 * - Per-parcel stages (appraisal transform and export, eligibility, group assembly, and the County group's
 *   elephant-cli validate, hash, CAR validate and export-tables) are measured on the feasibility sample and scaled by
 *   the seed's row count.
 * - Property Improvement stages (the permit transform and the group's elephant-cli stages) are scaled by the larger of
 *   two ratios, linked permits and parcels with linked permits, both counted over the whole capture by the link pass.
 *
 * Everything runs sequentially on one machine at the concurrency measured; the gate is 48 hours (172,800 s).
 *
 *   node src/counties/travis/t4-projection.mjs --feasibility <run-dir> [--harvest <evidence.json>] [--link-proof <evidence.json>] \
 *     [--bench-county <shard-bench.json>] [--bench-property_improvement <shard-bench.json>] [--out <file>]
 *
 * @module counties/travis/t4-projection
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { RUNTIME_ROOT } from "./t3-snapshot.mjs";

export const PROJECTION_VERSION = "travis-t4-projection.v1";
export const GATE_SECONDS = 48 * 3600;
export const PER_PARCEL_STAGES = Object.freeze(["appraisal_transform", "appraisal_reconcile_export", "eligibility", "assemble_groups", "cli_county_validate", "cli_county_hash", "cli_county_car_validate", "cli_county_export_tables"]);
export const PER_PERMIT_STAGES = Object.freeze(["permit_transform", "cli_property_improvement_validate", "cli_property_improvement_hash", "cli_property_improvement_car_validate", "cli_property_improvement_export_tables"]);
export const ONCE_STAGES = Object.freeze(["verify_capture", "roll_index", "permit_link_pass"]);

const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * Project the full run.
 *
 * @param {object} input - Measured inputs.
 * @param {Record<string, any>} input.run - The feasibility `t4-run.json`.
 * @param {{ elapsed_ms: number, rows: number, bytes: number, requests: number }} input.harvest - The harvest of record.
 * @param {{ rows: number, linked: number, linked_parcels: number, seed_rows: number }} input.full - Whole-capture counts.
 * @param {Record<string, { parcels: number, shards: number, wall_ms: number, all_passed: boolean }>} [input.shardBench] - `t4-shard-bench` results per group (`county`, `property_improvement`) on the same sample.
 * @returns {Record<string, any>} Projection.
 */
export function projectFullRun({ run, harvest, full, shardBench = {} }) {
  const stages = run.timings.stages;
  const sampleParcels = run.seed.rows;
  const samplePermits = run.permits.permits_published;
  const sampleParcelsWithPermits = run.groups.property_improvement;
  const parcelScale = full.seed_rows / sampleParcels;
  const permitScale = samplePermits > 0 ? full.linked / samplePermits : null;
  const permitParcelScale = sampleParcelsWithPermits > 0 ? full.linked_parcels / sampleParcelsWithPermits : null;
  const permitGroupScale = Math.max(permitScale ?? 0, permitParcelScale ?? 0);
  const lines = [];
  lines.push({ stage: "socrata_harvest", basis: "measured at full scale (the whole export)", measured_s: round(harvest.elapsed_ms / 1000), scale: 1, projected_s: round(harvest.elapsed_ms / 1000), rate: `${Math.round((harvest.rows / harvest.elapsed_ms) * 60000)} rows/min, ${harvest.requests} requests` });
  for (const stage of ONCE_STAGES) {
    const ms = stages[stage]?.ms;
    if (ms === undefined) continue;
    lines.push({ stage, basis: "measured at full scale (once per run)", measured_s: round(ms / 1000), scale: 1, projected_s: round(ms / 1000), rate: stages[stage].items > 1 ? `${Math.round((stages[stage].items / ms) * 60000)} rows/min` : null });
  }
  for (const stage of PER_PARCEL_STAGES) {
    const ms = stages[stage]?.ms;
    if (ms === undefined) continue;
    lines.push({ stage, basis: `measured on ${sampleParcels} parcels, scaled by ${full.seed_rows} seed rows`, measured_s: round(ms / 1000, 2), scale: round(parcelScale, 3), projected_s: round((ms / 1000) * parcelScale), rate: `${Math.round((sampleParcels / ms) * 60000)} parcels/min` });
  }
  for (const stage of PER_PERMIT_STAGES) {
    const ms = stages[stage]?.ms;
    if (ms === undefined) continue;
    lines.push({ stage, basis: `measured on ${samplePermits} permits of ${sampleParcelsWithPermits} parcels, scaled by the larger of ${full.linked} linked permits and ${full.linked_parcels} parcels with permits`, measured_s: round(ms / 1000, 2), scale: round(permitGroupScale, 3), projected_s: round((ms / 1000) * permitGroupScale), rate: samplePermits > 0 ? `${Math.round((samplePermits / ms) * 60000)} permits/min` : null });
  }
  const total = lines.reduce((sum, line) => sum + line.projected_s, 0);
  const acquisition = lines.filter((line) => line.stage === "socrata_harvest").reduce((sum, line) => sum + line.projected_s, 0);
  const slowest = [...lines].sort((left, right) => right.projected_s - left.projected_s).slice(0, 3).map((line) => ({ stage: line.stage, projected_h: round(line.projected_s / 3600, 2) }));
  // The same total with each group's elephant-cli chain run as K concurrent shards (measured by t4-shard-bench).
  let parallel = null;
  const benchGroups = Object.entries(shardBench).filter(([, bench]) => bench && bench.all_passed);
  if (benchGroups.length > 0) {
    const replaced = new Set();
    let benchSeconds = 0;
    const groups = {};
    for (const [group, bench] of benchGroups) {
      const prefix = `cli_${group}_`;
      for (const line of lines) if (line.stage.startsWith(prefix)) replaced.add(line.stage);
      const scale = group === "county" ? parcelScale : permitGroupScale;
      const projected = (bench.wall_ms / 1000) * scale;
      benchSeconds += projected;
      groups[group] = { shards: bench.shards, sample_parcels: bench.parcels, measured_wall_s: round(bench.wall_ms / 1000, 2), scale: round(scale, 3), projected_s: round(projected), projected_h: round(projected / 3600, 2) };
    }
    const rest = lines.filter((line) => !replaced.has(line.stage)).reduce((sum, line) => sum + line.projected_s, 0);
    const totalParallel = rest + benchSeconds;
    parallel = { groups, projected_s: round(totalParallel), projected_h: round(totalParallel / 3600, 2), within_gate: totalParallel <= GATE_SECONDS, margin_h: round((GATE_SECONDS - totalParallel) / 3600, 2), note: "the elephant-cli stages of each benchmarked group replaced by its measured K-shard wall time, scaled like the sequential stage; every other stage as above" };
  }
  return {
    projection_version: PROJECTION_VERSION,
    gate_s: GATE_SECONDS,
    sample: { run_dir: run.run_dir, parcels: sampleParcels, parcels_with_permits: sampleParcelsWithPermits, permits_published: samplePermits },
    full_scale: full,
    scales: { per_parcel: round(parcelScale, 3), permits: permitScale === null ? null : round(permitScale, 3), parcels_with_permits: permitParcelScale === null ? null : round(permitParcelScale, 3), permit_group_used: round(permitGroupScale, 3) },
    stages: lines,
    source_acquisition: { projected_s: round(acquisition), projected_h: round(acquisition / 3600, 3), within_gate: acquisition <= GATE_SECONDS, note: "the kit's 48-hour gate is per scraped source; the Austin export is the only acquisition T4 adds (TCAD and TNR were captured in T1)" },
    full_run: { projected_s: round(total), projected_h: round(total / 3600, 2), within_gate: total <= GATE_SECONDS, margin_h: round((GATE_SECONDS - total) / 3600, 2), mode: "every stage sequential, elephant-cli as one process per group" },
    full_run_sharded: parallel,
    slowest_stages: slowest,
    assumptions: [
      "sequential stages on the operator's machine at the measured concurrency (one Socrata request pair in flight; elephant-cli at its own default concurrency)",
      "per-parcel and per-permit costs scale linearly; CARs are cut into the kit's 5,000-property shards, so hash, CAR validate and export-tables run per shard at the sampled per-property rate",
      "the full run's link pass streams its rows to per-parcel files instead of holding them in memory (the write cost is in the permit transform stage, which writes the sidecar per parcel)",
      "no upload, pin or gateway time (T6), no Query DB load (T5's Loader)",
    ],
  };
}

/** @param {string[]} argv @returns {Record<string, string>} */
function parseFlags(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith("--") || argv[index + 1] === undefined) throw new Error("usage: t4-projection.mjs --feasibility <run-dir> [--harvest <evidence.json>] [--link-proof <evidence.json>] [--out <file>]");
    flags[argv[index].slice(2)] = argv[index + 1];
  }
  return flags;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (!flags.feasibility) throw new Error("--feasibility <run-dir> is required");
  const run = JSON.parse(await readFile(path.join(path.resolve(flags.feasibility), "t4-run.json"), "utf8"));
  const harvestEvidence = JSON.parse(await readFile(path.resolve(flags.harvest ?? path.join(RUNTIME_ROOT, "docs", "evidence", "travis-t4-harvest-v1792239863.json")), "utf8"));
  const linkProof = JSON.parse(await readFile(path.resolve(flags["link-proof"] ?? path.join(RUNTIME_ROOT, "docs", "evidence", "travis-t4-link-proof-v1792239863.json")), "utf8"));
  const harvest = { elapsed_ms: harvestEvidence.harvest.throughput.elapsed_ms, rows: harvestEvidence.harvest.rows, bytes: harvestEvidence.harvest.bytes, requests: harvestEvidence.harvest.requests };
  const shardBench = {};
  for (const group of ["county", "property_improvement"]) {
    if (flags[`bench-${group}`]) shardBench[group] = JSON.parse(await readFile(path.resolve(flags[`bench-${group}`]), "utf8"));
  }
  const projection = projectFullRun({ run, harvest, full: { rows: linkProof.rows, linked: linkProof.linked, linked_parcels: linkProof.linked_parcels, seed_rows: linkProof.roll.seed_rows }, shardBench });
  if (flags.out) await writeFile(path.resolve(flags.out), `${JSON.stringify(projection, null, 1)}\n`);
  console.log(JSON.stringify({ travis_t4_projection: projection.full_run, sharded: projection.full_run_sharded ? { projected_h: projection.full_run_sharded.projected_h, within_gate: projection.full_run_sharded.within_gate, shards: Object.fromEntries(Object.entries(projection.full_run_sharded.groups).map(([group, value]) => [group, value.shards])) } : null, source_acquisition_h: projection.source_acquisition.projected_h, slowest: projection.slowest_stages }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
