#!/usr/bin/env node
/**
 * T4 run record: one JSON in `docs/evidence/` that holds the T4 check (assignment decisions.md section 2 item 4:
 * "fixtures pass; link-method counts and the projection in the run record"), built from the runs' own files only.
 *
 *   node src/counties/travis/t4-record.mjs --pilot <run-dir> --pilot-none <run-dir> --drill <run-dir> --feasibility <run-dir> \
 *     [--capture <dir>] [--link-proof <evidence.json>] [--harvest <evidence.json>] [--readiness <report.json>] [--tests <summary>] \
 *     [--bench-county <shard-bench.json>] [--bench-property_improvement <shard-bench.json>] [--more-bench <file,file>] [--kit-commit <sha>] \
 *     [--size-projection <file>] [--projection-run <run-dir>] [--ruling-10 <evidence.json>] \
 *     --out docs/evidence/travis-t4-run-<date>.json
 *
 * `--projection-run` names the feasibility run the projection is measured on (default `--feasibility`): the shard
 * benchmarks of decisions.md 25.9 measured one run, and the projection stays on it while its full-scale counts come from
 * the current link proof.
 *
 * @module counties/travis/t4-record
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { RUNTIME_ROOT } from "./t3-snapshot.mjs";
import { partitionReceipts } from "./t4-permit-links.mjs";
import { latestCapture } from "./t4-permit-verify.mjs";
import { projectFullRun } from "./t4-projection.mjs";
import { PERMIT_DATASET as PERMIT_SOURCE } from "./t4-permit-fetch.mjs";

export const T4_RECORD_VERSION = "travis.t4-run-record.v1";

/**
 * The capture's artifact hash: SHA-256 over its sorted `file:sha256` partition lines (the loader-watermark recipe of T3).
 *
 * @param {string} captureDir - Capture directory.
 * @returns {Promise<{ artifact_hash: string, partitions: number }>} Digest.
 */
export async function captureArtifactHash(captureDir) {
  const lines = (await partitionReceipts(captureDir)).map((receipt) => `${receipt.file}:${receipt.sha256}`).sort();
  return { artifact_hash: createHash("sha256").update(`${lines.join("\n")}\n`).digest("hex"), partitions: lines.length };
}

/** @param {string} file @returns {Promise<any>} */
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

/**
 * The parts of a `t4-run.json` the record keeps.
 *
 * @param {Record<string, any>} run - Run.
 * @returns {Record<string, any>} Summary.
 */
function runSummary(run) {
  const group = (name) => {
    const cli = run.cli?.[name];
    if (!cli || cli.skipped) return cli ?? null;
    return {
      parcels: cli.parcels,
      validate: { processed: cli.validate?.processed, error_rows: cli.validate?.error_rows, exit: cli.validate?.exit },
      car: { root: cli.hash?.car?.root ?? null, blocks: cli.hash?.car?.blocks ?? null, bytes: cli.car?.bytes ?? null, sha256: cli.car?.sha256 ?? null },
      car_validation: cli.car_validate?.car_validation ?? null,
      tables: cli.export_tables?.tables ?? null,
    };
  };
  return {
    run_dir: run.run_dir,
    attempts: run.attempts,
    seed: run.seed,
    lexicon_manifest: { source: run.lexicon_manifest.source, sha256: run.lexicon_manifest.sha256, property_improvement_cid: run.lexicon_manifest.property_improvement_cid, seed_cid: run.lexicon_manifest.seed_cid },
    eligibility_policy: run.eligibility_policy,
    appraisal: run.appraisal,
    eligibility: run.eligibility,
    permit_states: run.permit_states,
    permits: { linked: run.permits.permits_linked, published: run.permits.permits_published, parcels_written: run.permits.parcels_written, conflicting: run.permits.conflicting, identical_repeats: run.permits.identical_repeats },
    groups: run.groups,
    county_group: group("county"),
    property_improvement_group: group("property_improvement"),
    property_cid_check: run.property_cid_check,
    socrata_cross_check: run.socrata_cross_check ? { ...run.socrata_cross_check, results: undefined } : null,
    timings_ms: Object.fromEntries(Object.entries(run.timings.stages).map(([stage, value]) => [stage, value.ms ?? value])),
    total_ms: run.timings.total_ms,
  };
}

/** @param {number} value @returns {string} */
const n = (value) => value.toLocaleString("en-US");

/**
 * The `no_candidate` limitation: what stays unlinked, with its roofing share (README.md 13, 33, 105, 110).
 *
 * @param {Record<string, any>} linkProof - Link proof.
 * @returns {string} Detail.
 */
export function noCandidateDetail(linkProof) {
  const retired = linkProof.tcad_permit_listing?.retired;
  if (!retired) return `${n(linkProof.ten_digit_not_in_roll.rows)} permits on ${n(linkProof.ten_digit_not_in_roll.distinct_geo_ids)} geo_ids no 2026 account prints, and ${n(linkProof.no_candidate_detail.blank_tcad_id)} with a blank tcad_id: loaded internally, not linked to a property (decisions.md section 25.10)`;
  const impact = linkProof.readme_impact;
  return `${n(linkProof.unlinked_reasons.no_candidate)} permits: ${n(linkProof.no_candidate_detail.ten_digit_not_in_roll)} on geo_ids no 2026 account prints that TCAD's permit listing does not attribute to exactly one current account (${n(retired.listed_on_several_current_accounts)} listed on several, ${n(retired.listed_on_other_accounts_only)} only on accounts outside the roll, ${n(retired.not_listed)} not listed) and ${n(linkProof.no_candidate_detail.blank_tcad_id)} with a blank tcad_id: loaded internally, not linked to a property. Among the retired-id permits ${n(impact.roofing.not_on_a_property_retired_geo_id)} are roofing permits (${n(impact.open_roofing.not_on_a_property_retired_geo_id)} open, ${n(impact.stalled_roofing.not_on_a_property_retired_geo_id)} stalled) and ${n(impact.roof_age_anchor.anchor_eligible_permits_unlinked_on_retired_geo_ids)} could anchor a roof age; their parcels are unknown, so at most that many parcels fall back to the built year because of them (decisions.md section 25.10)`;
}

/**
 * The limitation of the `tcad_permit_listing` links.
 *
 * @param {Record<string, any>} linkProof - Link proof.
 * @returns {string} Detail.
 */
export function listingLinkDetail(linkProof) {
  const listing = linkProof.tcad_permit_listing;
  const impact = linkProof.readme_impact;
  return `${n(listing.retired.linked)} permits on retired geo_ids (${n(impact.recovered_by_tcad_permit_listing.roofing)} roofing, ${n(impact.recovered_by_tcad_permit_listing.open_roofing)} open) are linked through TCAD's own permit listing (match_method tcad_permit_listing, confidence official_listing), not through the geo_id they print, which stays the retired id as printed; on the ${n(listing.overlap_with_exact.listed_on_one_current_account)} exactly linked permits TCAD lists on one account it names the same account ${(listing.overlap_with_exact.agreement_share * 100).toFixed(2)}% of the time; a roof-age anchor from such a permit carries the caveat anchor_link_tcad_permit_listing (decisions.md section 25.10)`;
}

/** @param {string[]} argv @returns {Record<string, string>} */
function parseFlags(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith("--") || argv[index + 1] === undefined) throw new Error(`bad flag ${argv[index]}`);
    flags[argv[index].slice(2)] = argv[index + 1];
  }
  return flags;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  for (const required of ["pilot", "pilot-none", "drill", "feasibility", "out"]) if (!flags[required]) throw new Error(`--${required} is required`);
  const load = (dir) => readJson(path.join(path.resolve(dir), "t4-run.json"));
  const [pilot, none, drill, feasibility] = await Promise.all([load(flags.pilot), load(flags["pilot-none"]), load(flags.drill), load(flags.feasibility)]);
  const projectionRun = flags["projection-run"] ? await load(flags["projection-run"]) : feasibility;
  const ruling10 = flags["ruling-10"] ? await readJson(path.resolve(flags["ruling-10"])) : null;
  const captureDir = path.resolve(flags.capture ?? (await latestCapture()));
  const harvest = await readJson(path.resolve(flags.harvest ?? path.join(RUNTIME_ROOT, "docs", "evidence", "travis-t4-harvest-v1792239863.json")));
  const linkProof = await readJson(path.resolve(flags["link-proof"] ?? path.join(RUNTIME_ROOT, "docs", "evidence", "travis-t4-link-proof-v1792239863.json")));
  const readiness = flags.readiness ? await readJson(path.resolve(flags.readiness)) : null;
  const artifact = await captureArtifactHash(captureDir);
  /** @type {Record<string, any>} */
  const shardBench = {};
  for (const group of ["county", "property_improvement"]) if (flags[`bench-${group}`]) shardBench[group] = await readJson(path.resolve(flags[`bench-${group}`]));
  const projection = projectFullRun({
    run: projectionRun,
    harvest: { elapsed_ms: harvest.harvest.throughput.elapsed_ms, rows: harvest.harvest.rows, bytes: harvest.harvest.bytes, requests: harvest.harvest.requests },
    full: { rows: linkProof.rows, linked: linkProof.linked, linked_parcels: linkProof.linked_parcels, seed_rows: linkProof.roll.seed_rows },
    shardBench,
  });
  const extraBench = [];
  for (const file of String(flags["more-bench"] ?? "").split(",").filter(Boolean)) extraBench.push(await readJson(path.resolve(file)));
  const record = {
    schemaVersion: T4_RECORD_VERSION,
    status: "T4 run of record (permit profile, permit pilot and feasibility); offline except the lexicon manifest and the Socrata cross-checks; nothing uploaded, pinned or registered",
    increment: "T4 (assignment decisions.md section 2 item 4)",
    check: "fixtures pass; link-method counts and the projection in the run record",
    kit_commit: flags["kit-commit"] ?? null,
    cli_commit: "44bb182 (@elephant-xyz/cli 1.58.1, project-local in the assignment repository)",
    lexicon_manifest_url: "https://lexicon.elephant.xyz/api/manifest",
    source: {
      dataset: harvest.harvest.dataset,
      url: "https://data.austintexas.gov/resource/3syk-w9eu.csv",
      watermark: harvest.harvest.rows_updated_at.end_iso,
      fetched: { started_at: harvest.harvest.started_at, finished_at: harvest.harvest.finished_at },
      artifact_hash: artifact.artifact_hash,
      artifact_hash_recipe: "SHA-256 over the sorted lines <partition file>:<sha256>, one per partition",
      partitions: artifact.partitions,
      rows: harvest.harvest.rows,
      bytes: harvest.harvest.bytes,
      requests: harvest.harvest.requests,
      throttling_seen: "none (0 HTTP 429, 0 retries)",
      verification: harvest.verification.line,
      availability: "supported_partial",
      availability_note: "Austin's export only (the other 22 jurisdictions are blocked or custodian-only as classified); 17% of its rows do not link to a 2026 Travis account",
      evidence: "docs/evidence/travis-t4-harvest-v1792239863.json",
    },
    link_proof: {
      evidence: "docs/evidence/travis-t4-link-proof-v1792239863.json",
      rows: linkProof.rows,
      link_method: linkProof.link_method,
      linked: linkProof.linked,
      linked_share: linkProof.linked_share,
      linked_parcels: linkProof.linked_parcels,
      unlinked_reasons: linkProof.unlinked_reasons,
      no_candidate_detail: linkProof.no_candidate_detail,
      by_permittype_link: linkProof.by_permittype_link,
      roll: linkProof.roll,
      williamson_cad_tcad_id: { account_form_rows: linkProof.williamson_cad_tcad_id.account_form_rows, marker_rows: linkProof.williamson_cad_tcad_id.marker_rows, with_coordinates: linkProof.williamson_cad_tcad_id.with_coordinates, north_of_30_40: linkProof.williamson_cad_tcad_id.north_of_30_40 },
      ten_digit_not_in_roll: { rows: linkProof.ten_digit_not_in_roll.rows, distinct_geo_ids: linkProof.ten_digit_not_in_roll.distinct_geo_ids },
      tcad_permit_listing: linkProof.tcad_permit_listing
        ? {
            listing_version: linkProof.tcad_permit_listing.listing_version,
            source: { url: linkProof.tcad_permit_listing.source.url, fetched_at: linkProof.tcad_permit_listing.source.fetched_at, bytes: linkProof.tcad_permit_listing.source.bytes, sha256: linkProof.tcad_permit_listing.source.sha256, receipts: linkProof.tcad_permit_listing.source.receipts },
            listing: linkProof.tcad_permit_listing.listing,
            precedence: linkProof.tcad_permit_listing.precedence,
            retired: linkProof.tcad_permit_listing.retired,
            overlap_with_exact: { listed_on_one_current_account: linkProof.tcad_permit_listing.overlap_with_exact.listed_on_one_current_account, agree: linkProof.tcad_permit_listing.overlap_with_exact.agree, agreement_share: linkProof.tcad_permit_listing.overlap_with_exact.agreement_share, roofing: linkProof.tcad_permit_listing.overlap_with_exact.roofing },
            classification: ruling10?.classification?.decision ?? null,
            evidence: "docs/evidence/travis-t4-ruling-10-tcad-listing-2026-10-18.json",
          }
        : null,
      permit_number: linkProof.permit_number,
    },
    evidence_states: linkProof.evidence_states,
    unlinked_reasons: linkProof.unlinked_reasons,
    profile: {
      versions: linkProof.versions,
      status_group: linkProof.status_group,
      lifecycle: linkProof.lifecycle,
      status_vocabulary: linkProof.status_vocabulary,
      roof_work_class: linkProof.roof_work_class,
      roofing: linkProof.roofing,
      date_reasons: linkProof.date_reasons,
      needs_review_distinct_descriptions: linkProof.needs_review_distinct_descriptions,
    },
    pilot: { all: runSummary(pilot), appraisal_only: runSummary(none), fault_drill: runSummary(drill) },
    feasibility: runSummary(feasibility),
    readme_impact: linkProof.readme_impact ? { ...linkProof.readme_impact, before_ruling_25_10: ruling10?.readme_impact?.before ?? null, evidence: "docs/evidence/travis-t4-ruling-10-tcad-listing-2026-10-18.json" } : null,
    projection_basis: projectionRun === feasibility ? "the feasibility run above" : `the feasibility run ${projectionRun.run_dir}, which the shard benchmarks and the size projection measured (decisions.md section 25.9), with the full-scale counts of the current link proof`,
    projection,
    shard_bench: [...Object.values(shardBench), ...extraBench].map((bench) => ({ group: bench.group, tag: bench.tag ?? null, started_at: bench.started_at ?? null, parcels: bench.parcels, shards: bench.shards, wall_ms: bench.wall_ms, wall_ms_per_parcel: bench.wall_ms_per_parcel, memory: bench.memory ?? null, all_passed: bench.all_passed, shard_ms: bench.results.map((result) => result.ms) })),
    size_projection: flags["size-projection"] ? await readJson(path.resolve(flags["size-projection"])) : null,
    limitations: [
      { source: PERMIT_SOURCE, availability: "supported_partial", source_access_status: "available", incomplete_reason: "out_of_county", detail: `${linkProof.unlinked_reasons.out_of_county.toLocaleString("en-US")} Austin permits on Williamson County parcels (tcad_id printed as a Williamson CAD account): outside Travis, left out of the Travis permit totals (decisions.md section 25.6)`, evidence: "docs/evidence/travis-t4-link-proof-v1792239863.json", records_request: null },
      { source: PERMIT_SOURCE, availability: "supported_partial", source_access_status: "available", incomplete_reason: "no_candidate", detail: noCandidateDetail(linkProof), evidence: linkProof.tcad_permit_listing?.retired ? "docs/evidence/travis-t4-ruling-10-tcad-listing-2026-10-18.json" : "docs/evidence/travis-t4-retired-geo-ids-2026-10-18.json", records_request: null },
      ...(linkProof.tcad_permit_listing?.retired ? [{ source: PERMIT_SOURCE, availability: "supported_partial", source_access_status: "available", incomplete_reason: "tcad_permit_listing_link", detail: listingLinkDetail(linkProof), evidence: "docs/evidence/travis-t4-ruling-10-tcad-listing-2026-10-18.json", records_request: null }] : []),
      { source: PERMIT_SOURCE, availability: "supported_partial", source_access_status: "available", incomplete_reason: "multiple_candidates", detail: `${linkProof.unlinked_reasons.multiple_candidates.toLocaleString("en-US")} permits on ${linkProof.roll.shared_geo_ids.toLocaleString("en-US")} geo_ids shared by ${linkProof.roll.accounts_on_shared_geo_ids.toLocaleString("en-US")} accounts (mostly condominium regimes): not linked to one property`, evidence: "docs/evidence/travis-t4-link-proof-v1792239863.json", records_request: null },
      { source: PERMIT_SOURCE, availability: "supported_partial", source_access_status: "available", incomplete_reason: "invalid_quarantined", detail: `${linkProof.unlinked_reasons.invalid_quarantined.toLocaleString("en-US")} permits with a malformed tcad_id`, evidence: "docs/evidence/travis-t4-link-proof-v1792239863.json", records_request: null },
      { source: PERMIT_SOURCE, availability: "supported_partial", source_access_status: "available", incomplete_reason: "status_indexed_only", detail: "the status is the daily export's value with its capture time; open roofing permits are not refreshed from the permit's live page in v1", evidence: "docs/decisions.md section 5", records_request: null },
      { source: "travis-other-jurisdictions", availability: "unsupported", source_access_status: "blocked", incomplete_reason: "blocked_or_custodian_only", detail: "the 22 jurisdictions other than Austin stay blocked or custodian-only as classified (travis-sources.yaml)", evidence: "docs/travis-sources.yaml", records_request: "per jurisdiction in travis-sources.yaml" },
    ],
    readiness_report: readiness ? { overall: readiness.overall, seed_allowed: readiness.seed_allowed, gates: Object.fromEntries((readiness.gates ?? []).map((gate) => [gate.gate, gate.status])) } : null,
    tests: flags.tests ?? null,
    loader_watermarks: [],
    loader_watermarks_note: "no Query DB load in T4 (the permits track's Loader is T5); the capture's artifact hash above is the watermark T5 starts from",
    tombstones_consumed: { dead: 0, invalid: 0 },
    publication: "none: the County and Property Improvement CARs and tables are local files under the run directories (T6 publishes)",
  };
  await writeFile(path.resolve(flags.out), `${JSON.stringify(record, null, 1)}\n`);
  console.log(JSON.stringify({ travis_t4_record: path.relative(RUNTIME_ROOT, path.resolve(flags.out)), artifact_hash: artifact.artifact_hash, projection_h: projection.full_run.projected_h, within_gate: projection.full_run.within_gate }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}
