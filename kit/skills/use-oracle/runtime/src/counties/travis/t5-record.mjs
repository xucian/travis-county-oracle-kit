/**
 * The T5 run record (`api-contract.md` Run schema; assignment decisions.md section 6: "Each run writes
 * `runs/<run_id>.json`"): timestamps and attempts, sources and their watermarks, the Loader's watermarks and tombstones,
 * counts per table with `seed = ready + dead + invalid` checked, deltas against the prior load, evidence states,
 * unlinked reasons, roof-age counts, limitations, every CAR the run wrote (archive and tables, per shard and group),
 * per-stage timings, peak memory, the tool versions and the internal run history. It is written by `t5-run.mjs` once
 * every shard is merged and the Loader has finalized; `groups`, `manifest_cid`, `gateway_checks` and `atlas` stay empty
 * until publication (T6).
 *
 * @module counties/travis/t5-record
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { GEOMETRY_PARTS_VERSION, SITUS_COLUMNS_VERSION, TCAD_EXTRAS_MAPPING_VERSION, TRANSFORM_VERSION } from "../../../counties/travis/transforms/transform.mjs";
import { PERMIT_TRANSFORM_VERSION } from "../../../counties/travis/transforms/permit-transform.mjs";
import { IMPROVEMENT_ENUMS_VERSION, PARCEL_LINK_VERSION, STATUS_GROUP_VERSION, TCAD_ID_EVIDENCE_VERSION, WORK_CLASSIFIER_VERSION, compiledTravisRoofAgeProfile, summarizePermitRow } from "./permit-profile.mjs";
import { RUNTIME_ROOT } from "./t3-snapshot.mjs";
import { LOADER_VERSION } from "./t5-loader.mjs";
import { RECERTIFY_VERSION } from "./t5-recertify.mjs";
import { sumRoofAgeCounts, T5_ROOF_AGE_VERSION } from "./t5-roof-age.mjs";
import { readLines } from "./t5-shards.mjs";
import { TRAVIS_VALIDATION_BBOX } from "./validate.mjs";

export const T5_RECORD_VERSION = "travis.t5-run-record.v1";
const rel = (target) => path.relative(RUNTIME_ROOT, target).split(path.sep).join("/");
const fmt = (value) => Number(value ?? 0).toLocaleString("en-US");

/** @param {string[]} args @returns {Promise<string | null>} git output in the kit worktree. */
const git = (args) => new Promise((resolve) => execFile("git", ["-C", RUNTIME_ROOT, ...args], (error, stdout) => resolve(error ? null : String(stdout).trim())));

/**
 * Sum `{name: number}` maps.
 *
 * @param {Record<string, number>[]} maps - Maps.
 * @returns {Record<string, number>} Sum.
 */
const sumMaps = (maps) => {
  const out = {};
  for (const map of maps) for (const [key, value] of Object.entries(map ?? {})) out[key] = (out[key] ?? 0) + (typeof value === "number" ? value : 0);
  return out;
};

/**
 * Per-stage timings over every shard (each stage's wall time as its marker records it, attempts that ran in this run's
 * processes; skipped stages count 0 for this attempt).
 *
 * In a next run (`previous_run`), a marker that started before this run was created was carried from the earlier run:
 * it counts under `carried`, not in the timings.
 *
 * @param {Record<string, any>[]} results - Shard results.
 * @param {string | null} [since] - The next run's creation time (null for a first run).
 * @param {Record<string, number>} [carried] - Filled with the carried stages per stage name.
 * @returns {Record<string, { total_ms: number, shards: number, mean_ms: number }>} Timings.
 */
export function stageTimings(results, since = null, carried = {}) {
  const out = {};
  const add = (name, marker) => {
    if (!marker || marker.ms === undefined) return;
    if (since && marker.started_at && marker.started_at < since) {
      carried[name] = (carried[name] ?? 0) + 1;
      return;
    }
    const entry = (out[name] ??= { total_ms: 0, shards: 0, mean_ms: 0 });
    entry.total_ms += marker.ms;
    entry.shards += 1;
  };
  for (const result of results) {
    add("appraisal", result.appraisal);
    add("permits", result.permits);
    add("reconcile", result.reconcile);
    add("cid_check", result.cid_check);
    add("merge", result.merge);
    for (const [group, steps] of Object.entries(result.groups)) for (const step of ["validate", "hash", "car_validate", "export_tables"]) add(`cli_${group}_${step}`, steps?.[step]);
  }
  for (const entry of Object.values(out)) entry.mean_ms = Math.round(entry.total_ms / Math.max(1, entry.shards));
  return out;
}

/**
 * What a next run changed against the run it was cloned from: per group, the shard archives whose root is new, and the
 * stages it carried (their markers held, so they did not run).
 *
 * @param {Record<string, any>} previousRun - The run state's `previous_run`.
 * @param {Record<string, any>[]} results - Shard results.
 * @param {Record<string, number>} carried - Carried stages per stage name.
 * @returns {Promise<Record<string, any>>} `changed_since_previous`.
 */
export async function sincePrevious(previousRun, results, carried) {
  const { readFile } = await import("node:fs/promises");
  const before = JSON.parse(await readFile(path.join(RUNTIME_ROOT, previousRun.dir, "run.json"), "utf8"));
  const rootOf = new Map(before.shards.per_shard.map((entry) => [entry.id, entry]));
  const groups = {};
  for (const result of results) {
    for (const group of ["county", "property_improvement"]) {
      const now = result.groups[group]?.hash?.output?.car?.root ?? null;
      const then = rootOf.get(result.shard)?.[`${group}_root`] ?? null;
      if (!now && !then) continue;
      const entry = (groups[group] ??= { archives: 0, unchanged: 0, new_roots: 0, shards_with_new_roots: [] });
      entry.archives += 1;
      if (now === then) entry.unchanged += 1;
      else {
        entry.new_roots += 1;
        entry.shards_with_new_roots.push(result.shard);
      }
    }
  }
  return { changed_since_previous: { previous_run_id: previousRun.run_id, groups, carried_stages: carried } };
}

/**
 * The dead accounts by reason (from their tombstone evidence) and the linked permits that sit on them (internal only).
 *
 * @param {import("./t5-run.mjs").T5Run} run - The run (its link directory and as-of date).
 * @param {Record<string, any>[]} results - Shard results.
 * @returns {Promise<{ accounts: number, by_reason: Record<string, number>, permits: { accounts: number, permits: number, roofing: number, open_roofing: number, stalled_roofing: number } }>} Dead accounts.
 */
export async function deadAccounts(run, results) {
  const byReason = {};
  const permits = { accounts: 0, permits: 0, roofing: 0, open_roofing: 0, stalled_roofing: 0 };
  let accounts = 0;
  for (const result of results) {
    const dead = result.appraisal.output.dead ?? [];
    for (const item of dead) {
      const reason = /no situs address/.test(item.evidence ?? "") ? "no_situs_street" : /outside the Travis bbox/.test(item.evidence ?? "") ? "outside_validation_bbox" : "other";
      byReason[reason] = (byReason[reason] ?? 0) + 1;
      accounts += 1;
    }
    const keys = new Set(dead.map((item) => String(item.key)));
    const file = path.join(run.linkDir ?? "", `${result.shard}.jsonl`);
    if (keys.size === 0 || !run.linkDir || !existsSync(file)) continue;
    const needles = [...keys].map((key) => [key, `"propertyId":"${key}"`]);
    const withPermits = new Set();
    for await (const line of readLines(file)) {
      if (!needles.some(([, needle]) => line.includes(needle))) continue;
      const entry = JSON.parse(line);
      const key = String(entry.link?.propertyId ?? "");
      if (!keys.has(key)) continue;
      withPermits.add(key);
      permits.permits += 1;
      const profile = summarizePermitRow(entry.row, { asOfDate: run.asOfDate });
      if (profile.isRoofing) {
        permits.roofing += 1;
        if (profile.statusGroup === "open") permits.open_roofing += 1;
        if (profile.statusGroup === "stalled") permits.stalled_roofing += 1;
      }
    }
    permits.accounts += withPermits.size;
  }
  return { accounts, by_reason: byReason, permits };
}

/**
 * The limitations the run's own counts back (`Limitation` shape of `/v1/meta`).
 *
 * @param {Record<string, any>} link - The link pass summary.
 * @param {Record<string, any>} roofAge - Roof-age totals.
 * @param {Record<string, any>} appraisal - Appraisal counts.
 * @param {Awaited<ReturnType<typeof deadAccounts>>} [dead] - The dead accounts and the permits on them.
 * @returns {Record<string, any>[]} Limitations.
 */
export function buildLimitations(link, roofAge, appraisal, dead = { accounts: 0, by_reason: {}, permits: { accounts: 0, permits: 0, roofing: 0, open_roofing: 0, stalled_roofing: 0 } }) {
  const permits = "austin-issued-construction-permits/3syk-w9eu";
  const reasons = link.unlinked_reasons ?? {};
  const listing = link.tcad_permit_listing?.retired ?? {};
  const impact = link.readme_impact ?? {};
  const item = (source, availability, accessStatus, reason, detail, evidence, request = null) => ({ source, availability, source_access_status: accessStatus, incomplete_reason: reason, detail, evidence, records_request: request });
  const roofingUnlinked = Number(impact.roofing?.not_on_a_property ?? 0);
  const onDead = dead.permits;
  const deadItems = [];
  if (dead.by_reason.no_situs_street) deadItems.push(item("tcad-2026-certified-appraisal-export", "supported_partial", "available", "no_situs_street", `${fmt(dead.by_reason.no_situs_street)} accounts print no situs street (the roll prints no street for them, a source fact; a street printed one column to the right is read, decisions.md 27.10): permanent appraisal failures, tombstoned dead, not published`, "the run's dead tombstones (Loader generation tombstones.jsonl)"));
  if (dead.by_reason.outside_validation_bbox) deadItems.push(item("pipeline", "supported_partial", "available", "outside_validation_bbox", `${fmt(dead.by_reason.outside_validation_bbox)} accounts refused by the validation box although TCAD appraises them: tombstoned dead, not published (decisions.md 27.9)`, "the run's dead tombstones"));
  if (dead.by_reason.other) deadItems.push(item("pipeline", "supported_partial", "available", "dead_other", `${fmt(dead.by_reason.other)} accounts failed the appraisal stage permanently for another reason: tombstoned dead, not published`, "the run's dead tombstones"));
  if (onDead.permits > 0) deadItems.push(item(permits, "supported_partial", "available", "linked_to_dead_account", `${fmt(onDead.permits)} linked permits (${fmt(onDead.roofing)} roofing) sit on ${fmt(onDead.accounts)} dead accounts: loaded internally, shown on no property`, "global/link per-shard files, the run's dead tombstones"));
  return [
    item("bbb.org", "unsupported", "blocked", "http_403_source_block", "BBB returns a bot challenge and 403 to scripted access; ratings ship as rating null, status blocked, until approved API access (decisions.md section 4)", "docs/travis-bbb-access-request.md"),
    item(permits, "supported_partial", "available", "jurisdiction_scope", "the Austin export covers Austin (full purpose and ETJ) and the cities whose permits it carries; unincorporated Travis and the other cities are not in it, so a property outside that scope shows no permit history", "docs/travis-sources.yaml"),
    item("travis-other-jurisdictions", "unsupported", "blocked", "blocked_or_custodian_only", "the 22 jurisdictions other than Austin stay blocked or custodian-only as classified (travis-sources.yaml)", "docs/travis-sources.yaml", "per jurisdiction in travis-sources.yaml"),
    item(permits, "supported_partial", "available", "out_of_county", `${fmt(reasons.out_of_county)} Austin permits on Williamson County parcels (tcad_id printed as a Williamson CAD account): outside Travis, left out of the Travis permit totals (decisions.md section 25.6)`, "global/link summary.json"),
    item(permits, "supported_partial", "available", "no_candidate", `${fmt(reasons.no_candidate)} permits: ${fmt(link.no_candidate_detail?.blank_tcad_id)} with a blank tcad_id and ${fmt(link.no_candidate_detail?.ten_digit_not_in_roll)} on geo_ids no 2026 account prints that TCAD's permit listing does not attribute to one current account; loaded internally, linked to no property (decisions.md section 25.10)`, "global/link summary.json"),
    item(permits, "supported_partial", "available", "tcad_permit_listing_link", `${fmt(listing.linked)} permits on retired geo_ids are linked through TCAD's own permit listing (match_method tcad_permit_listing, confidence official_listing); a roof-age anchor from one carries the caveat anchor_link_tcad_permit_listing (${fmt(roofAge.caveats?.anchor_link_tcad_permit_listing)} parcels)`, "global/link summary.json"),
    item(permits, "supported_partial", "available", "multiple_candidates", `${fmt(reasons.multiple_candidates)} permits on geo_ids shared by several accounts (mostly condominium regimes): linked to no one property`, "global/link summary.json"),
    item(permits, "supported_partial", "available", "invalid_quarantined", `${fmt(reasons.invalid_quarantined)} permits with a malformed tcad_id`, "global/link summary.json"),
    item(permits, "supported_partial", "available", "roofing_not_on_a_property", `${fmt(roofingUnlinked + onDead.roofing)} roofing permits are loaded internally and counted but shown on no property: ${fmt(roofingUnlinked)} link to no property (${fmt(impact.open_roofing?.not_on_a_property)} open, ${fmt(impact.stalled_roofing?.not_on_a_property)} stalled) and ${fmt(onDead.roofing)} sit on dead accounts (${fmt(onDead.open_roofing)} open, ${fmt(onDead.stalled_roofing)} stalled)`, "global/link summary.json"),
    item(permits, "supported_partial", "available", "status_indexed_only", "the status is the daily export's value with its capture time; open roofing permits are not refreshed from the permit's live page in v1", "docs/decisions.md section 5"),
    item(permits, "supported_partial", "available", "needs_review_status", `${fmt(link.status_group?.needs_review)} permits carry a status outside the profile's mapping (needs_review): left out of the open, stalled and closed counts`, "global/link summary.json"),
    item(permits, "supported_partial", "available", "applicant_not_collected", "the seven applicant fields are personal contact fields and are not collected (T1 privacy classification, decisions.md 25.8)", "docs/travis-sources.yaml"),
    item("tx-licensing", "unsupported", "available", "no_roofing_license", "Texas issues no roofing license, and historical license qualification (which license holder backed which business on a permit's date) is closed for v1 (decisions.md section 23)", "docs/decisions.md section 23"),
    item("travis-tnr-tcad-parcels", "supported_partial", "available", "no_parcel_polygon", `${fmt(appraisal.without_geometry)} accounts have no polygon of their own on the TNR layer (condominium units and recent splits): no parcel coordinates, never geocoded`, "docs/evidence/travis-t5-field-coverage-2026-10-18.json"),
    item("travis-tnr-tcad-parcels", "supported_partial", "available", "polygon_inner_rings", "geometry.polygon holds one ring: the inner rings of 284 parcels (605 rings) are not written (lexicon gap, counted in each parcel's sidecar)", "docs/evidence/travis-t5-field-coverage-2026-10-18.json"),
    item("tcad-2026-certified-appraisal-export", "supported_partial", "available", "no_faithful_member", "special-district taxable values, per-entity exemptions, an account-wide taxable value, the improvement type as a property form or building count, and an exterior-wall attribute (not printed) have no faithful lexicon member and are not written", "docs/evidence/travis-t5-field-coverage-2026-10-18.json"),
    item("lexicon", "supported_partial", "available", "county_label", "no archive field names the county: address.county_name is omitted until lexicon#194; the Atlas page, the run record and the manifest name it (decisions.md section 22)", "docs/decisions.md section 22"),
    item("roof-age", "supported_partial", "available", "partial_history", `${fmt(roofAge.by_historical_coverage?.partial)} parcels have permit history (partial: one jurisdiction's system); ${fmt(roofAge.by_historical_coverage?.unknown)} have none in the export (history_unknown); ${fmt(roofAge.by_basis?.year_built)} roof ages fall back to the built year (low confidence) and ${fmt(roofAge.by_basis?.none)} parcels have no age`, "run.json roof_age"),
    ...deadItems,
  ];
}

/**
 * What the scoped reruns of the run did, from the state (shards, commits, changed files and proofs) and the markers
 * (the stages re-certified, and each rerun shard's comparison with the run).
 *
 * @param {import("./t5-run.mjs").T5Run} run - The run.
 * @param {Record<string, any>[]} results - Shard results.
 * @returns {Promise<Record<string, any>[]>} One entry per scoped rerun.
 */
async function scopedReruns(run, results) {
  const { readFile } = await import("node:fs/promises");
  const linkMarkerPath = path.join(run.globalDir, "link.done.json");
  const linkMarker = existsSync(linkMarkerPath) ? JSON.parse(await readFile(linkMarkerPath, "utf8")) : null;
  return (run.state.scoped_reruns ?? []).map((scope) => {
    const attempts = new Set(scope.attempts ?? []);
    const stages = {};
    const shards = new Set();
    const count = (shard, stage, marker) => {
      if (!(marker?.recertified ?? []).some((entry) => attempts.has(entry.attempt))) return;
      stages[stage] = (stages[stage] ?? 0) + 1;
      if (shard) shards.add(shard);
    };
    count(null, "link", linkMarker);
    const comparisons = {};
    for (const result of results) {
      for (const name of ["appraisal", "permits", "reconcile", "cid_check", "merge"]) count(result.shard, name, result[name]);
      for (const [group, steps] of Object.entries(result.groups)) for (const step of ["validate", "hash", "car_validate", "export_tables"]) count(result.shard, `${group}.${step}`, steps?.[step]);
      if (scope.shards.includes(result.shard)) {
        const a = result.appraisal.output.rerun_comparison ?? null;
        const p = result.permits.output.rerun_comparison ?? null;
        comparisons[result.shard] = {
          appraisal: a ? { identical: a.identical, previously_ready: a.previously_ready, unchanged: a.unchanged, sidecars_compared: a.sidecars_compared, newly_ready: a.newly_ready, still_dead: a.still_dead } : null,
          permits: p ? { identical: p.identical, previous_states: p.previous_states, unchanged: p.unchanged, added: p.added } : null,
          county_root: result.groups.county?.hash?.output?.car?.root ?? null,
          property_improvement_root: result.groups.property_improvement?.hash?.output?.car?.root ?? null,
        };
      }
    }
    return { ...scope, recertified: { shards: shards.size, stages }, comparisons };
  });
}

/**
 * Build the run record.
 *
 * @param {object} options - Inputs.
 * @param {import("./t5-run.mjs").T5Run} options.run - The finished run.
 * @param {Record<string, any>} options.loader - The Loader's finalize output.
 * @param {Record<string, any>[]} options.history - The Loader's run history (`loads.jsonl`).
 * @param {Record<string, any>[]} options.t3 - The registry and licensing watermarks (T3).
 * @param {number} options.diskBytes - Bytes under the run directory.
 * @returns {Promise<Record<string, any>>} Record.
 */
export async function buildRunRecord({ run, loader, history, t3, diskBytes }) {
  const results = run.plan.shards.map((shard) => run.shardResults.get(shard.id));
  const link = run.linkSummary;
  const roofAge = sumRoofAgeCounts(results.map((result) => result.reconcile.output.roof_age));
  const dead = results.reduce((sum, result) => sum + result.appraisal.output.dead.length, 0);
  const invalid = results.reduce((sum, result) => sum + (result.groups.county?.validate?.output?.invalid?.length ?? 0), 0);
  const readyAll = results.reduce((sum, result) => sum + Object.keys(result.appraisal.output.parcels).length, 0);
  const ready = readyAll - invalid;
  const seed = run.plan.rows;
  const geometry = results.reduce((sum, result) => sum + (result.appraisal.output.geometry ?? 0), 0);
  const permitCounts = sumMaps(results.map((result) => result.permits.output.counts));
  const published = results.reduce((sum, result) => sum + result.permits.output.published, 0);
  const tables = {};
  const cars = [];
  for (const result of results) {
    for (const [group, steps] of Object.entries(result.groups)) {
      if (!steps?.hash) continue;
      const exported = steps.export_tables.output;
      cars.push({ root_cid: steps.hash.output.car.root, group, kind: "archive", shard: result.shard, schema_cid: group === "county" ? run.roots.countyCid : run.roots.propertyImprovementCid, block_count: steps.hash.output.car.blocks, properties: steps.validate.output.members, car_validation: steps.car_validate.output.car_validation, path: steps.car.path, size: steps.car.bytes, sha256: steps.car.sha256, readback_url: null });
      cars.push({ root_cid: exported.tables.root, group, kind: "tables", shard: result.shard, schema_cid: group === "county" ? run.roots.countyCid : run.roots.propertyImprovementCid, tables: exported.tables.tables, parts: exported.tables.parts, path: steps.tables?.dir ?? `${path.dirname(steps.car.path)}/tables`, readback_url: null });
    }
  }
  // Rows per table: the CLI's own tables-export.json of every shard.
  const { readFile } = await import("node:fs/promises");
  for (const result of results) {
    for (const [group, steps] of Object.entries(result.groups)) {
      if (!steps?.export_tables) continue;
      const exported = JSON.parse(await readFile(path.join(RUNTIME_ROOT, steps.tables?.export_json ?? path.join(path.dirname(steps.car.path), "tables-export.json")), "utf8"));
      tables[group] = sumMaps([tables[group], Object.fromEntries(Object.entries(exported.tables).map(([name, value]) => [name, value.rows]))]);
    }
  }
  const startedAt = run.state.created_at;
  const finishedAt = run.state.finished_at;
  const kitCommit = await git(["rev-parse", "--short", "HEAD"]);
  const kitDirty = (await git(["status", "--porcelain", "--", "src/counties/travis", "counties/travis", "src/roof-age"])) ?? "";
  const loaderDeltas = loader.deltas;
  const deadInfo = await deadAccounts(run, results);
  const reruns = await scopedReruns(run, results);
  const rerunShards = new Set(reruns.flatMap((scope) => scope.shards));
  const attemptMs = (attempt) => (attempt.ended_at ? new Date(attempt.ended_at).getTime() - new Date(attempt.started_at).getTime() : null);
  const previousRun = run.state.previous_run ?? null;
  const carried = {};
  const timings = stageTimings(results, previousRun ? startedAt : null, carried);
  const nextRun = previousRun ? { previous_run: previousRun, ...(await sincePrevious(previousRun, results, carried)) } : {};
  return {
    schemaVersion: T5_RECORD_VERSION,
    run_id: run.state.run_id,
    label: run.state.label,
    county: "Travis County, TX",
    fips: "48453",
    started_at: startedAt,
    finished_at: finishedAt,
    attempts: run.state.attempts.map((attempt) => ({ attempt: attempt.attempt, pid: attempt.pid, started_at: attempt.started_at, ended_at: attempt.ended_at ?? null, status: attempt.status, resumed: attempt.resumed, reaped_orphans: attempt.reaped_orphans?.length ?? 0, error: attempt.error ?? null })),
    scope: { shard_size: run.options.shardSize, concurrency: run.options.concurrency, max_shards: run.options.maxShards, whole_seed: run.wholeSeed, eligibility: run.options.eligibility, loader_scope: run.options.loaderScope },
    window: { permits: { dataset_rows_updated_at: run.captureSummary.rows_updated_at.end_iso, issued_through: link.issue_date_max, as_of_date: run.asOfDate }, appraisal: { roll: "TCAD 2026 Certified Appraisal Export, supplement 0" } },
    sources: [
      { dataset: "tcad-2026-certified-appraisal-export", url: run.plan.extras ? "https://traviscad.org/wp-content/largefiles/2026%20Certified%20Appraisal%20Export%20Supp%200_07182026.zip" : null, watermark: "2026 certified, supplement 0", fetched_at: "2026-10-16T17:42:52Z", sha256: run.plan.extras?.archive_sha256 ?? null, availability: "supported_full", source_access_status: "available" },
      { dataset: "travis-tnr-tcad-parcels", url: "https://gis.traviscountytx.gov/server1/rest/services/Boundaries_and_Jurisdictions/TCAD_public/MapServer/0/query", watermark: "T1 page capture 2026-10-16", fetched_at: "2026-10-16", sha256: null, availability: "supported_partial", source_access_status: "available" },
      { dataset: "austin-issued-construction-permits/3syk-w9eu", url: "https://data.austintexas.gov/resource/3syk-w9eu", watermark: run.captureSummary.rows_updated_at.end_iso, fetched_at: run.captureSummary.fetched_at ?? run.captureSummary.finished_at ?? null, sha256: loader.watermarks.find((item) => item.track === "permits")?.artifact_hash ?? null, availability: "supported_partial", source_access_status: "available" },
      { dataset: "tcad-2026-certified-special-export-json", url: run.listing.source_url, watermark: "2026 certified special export", fetched_at: run.listing.fetched_at, sha256: run.listing.source_sha256, availability: "supported_partial", source_access_status: "available" },
      ...t3.map((item) => ({ dataset: item.source, url: null, watermark: item.last_merged_at, fetched_at: null, sha256: item.artifact_hash, availability: "supported_full", source_access_status: "available" })),
    ],
    loader_watermarks: [...loader.watermarks, ...t3.map((item) => ({ track: item.track, path: item.path, artifact_hash: item.artifact_hash, merged_count: item.merged_count, merged_rows: item.merged_rows, last_merged_at: item.last_merged_at }))],
    tombstones_consumed: loader.tombstones_consumed,
    tombstones: loader.tombstones,
    counts: {
      appraisal: { seed, ready, dead, invalid, retryable: 0, reconciles: seed === ready + dead + invalid, rule: "seed = ready + dead + invalid (kit county-ingest-run section 8)", with_geometry: geometry, without_geometry: readyAll - geometry },
      permits: {
        captured: link.rows,
        linked: link.linked,
        linked_parcels: link.linked_parcels,
        by_link_method: link.link_method,
        unlinked_reasons: link.unlinked_reasons,
        permit_states: permitCounts,
        published,
        parcels_with_permits: results.reduce((sum, result) => sum + (result.permits.output.counts.done ?? 0), 0),
        roofing: link.roofing,
        status_group: link.status_group,
      },
      tables: { ...tables, internal: Object.fromEntries(Object.entries(loader.tables).map(([name, parts]) => [name, parts.reduce((sum, part) => sum + part.rows, 0)])) },
    },
    deltas: Object.fromEntries(Object.entries(loaderDeltas).map(([name, delta]) => [name, { ...delta, dead: name === "appraisal" ? dead : 0, invalid: name === "appraisal" ? invalid : 0, retryable: 0 }])),
    evidence_states: link.evidence_states,
    unlinked_reasons: link.unlinked_reasons,
    roof_age: { ...roofAge, version: T5_ROOF_AGE_VERSION, estimator: "elephant.roof-age-estimate.v1", profile: { version: compiledTravisRoofAgeProfile.version, sha256: compiledTravisRoofAgeProfile.sha256 }, as_of_date: run.asOfDate, link_pass_anchor_parcels: link.readme_impact?.roof_age_anchor ?? null },
    limitations: buildLimitations(link, roofAge, { without_geometry: readyAll - geometry }, deadInfo),
    shards: {
      total: run.plan.shards.length,
      per_shard: results.map((result) => ({ id: result.shard, rows: result.rows, first: run.plan.shards.find((shard) => shard.id === result.shard).first, last: run.plan.shards.find((shard) => shard.id === result.shard).last, appraisal_attempt: result.appraisal.attempt, rerun: rerunShards.has(result.shard), recertified: (result.appraisal.recertified ?? []).length > 0, county_root: result.groups.county?.hash?.output?.car?.root ?? null, property_improvement_root: result.groups.property_improvement?.hash?.output?.car?.root ?? null, county_car_sha256: result.groups.county?.car?.sha256 ?? null, property_improvement_car_sha256: result.groups.property_improvement?.car?.sha256 ?? null })),
    },
    cars,
    groups: {},
    manifest_cid: null,
    atlas: null,
    gateway_checks: [],
    timings: { unit: "ms", wall_ms: new Date(finishedAt).getTime() - new Date(startedAt).getTime(), last_attempt_ms: Math.round(new Date(finishedAt).getTime() - new Date(run.attempt.started_at).getTime()), attempts_ms: run.state.attempts.map((attempt) => ({ attempt: attempt.attempt, ms: attemptMs(attempt) })), stages: timings },
    memory: { peak_cli_rss_gb: Math.round((run.peak.cli_rss_bytes / 1024 ** 3) * 10) / 10, peak_cli_processes: run.peak.cli_processes, peak_runner_rss_gb: Math.round((run.peak.runner_rss_bytes / 1024 ** 3) * 10) / 10, peak_combined_rss_gb: Math.round(((run.peak.combined_rss_bytes ?? 0) / 1024 ** 3) * 10) / 10, peak_swap_used_gb: Math.round((run.peak.swap_used_bytes / 1024 ** 3) * 10) / 10, sampled: "every progress tick (60 s) and shard completion; ps RSS" },
    disk: { run_dir_gb: Math.round((diskBytes / 1024 ** 3) * 100) / 100 },
    preflight: run.preflight,
    no_sleep: run.noSleep,
    readiness_report: run.readiness,
    cli_commit: `${run.cliVersion} (44bb182, project-local in the assignment repository)`,
    lexicon_manifest_url: run.state.lexicon_manifest.url,
    lexicon_manifest: run.state.lexicon_manifest,
    kit_commit: kitDirty ? `${kitCommit} (+ uncommitted Travis changes)` : kitCommit,
    versions: { run: "travis-t5-run.v1", record: T5_RECORD_VERSION, transform: TRANSFORM_VERSION, geometry_parts: GEOMETRY_PARTS_VERSION, tcad_extras_mapping: TCAD_EXTRAS_MAPPING_VERSION, situs_columns: SITUS_COLUMNS_VERSION, validation_box: `${TRAVIS_VALIDATION_BBOX.minLat}-${TRAVIS_VALIDATION_BBOX.maxLat} N, ${TRAVIS_VALIDATION_BBOX.minLng} to ${TRAVIS_VALIDATION_BBOX.maxLng} W`, recertify: RECERTIFY_VERSION, permit_transform: PERMIT_TRANSFORM_VERSION, status_group: STATUS_GROUP_VERSION, work_classifier: WORK_CLASSIFIER_VERSION, tcad_id_evidence: TCAD_ID_EVIDENCE_VERSION, parcel_link: PARCEL_LINK_VERSION, improvement_enums: IMPROVEMENT_ENUMS_VERSION, loader: LOADER_VERSION, roof_age: T5_ROOF_AGE_VERSION },
    inputs: { seed: run.plan.seed, tcad_extras: run.plan.extras, capture: { dir: rel(run.captureDir), rows: run.captureSummary.rows, rows_updated_at: run.captureSummary.rows_updated_at.end_iso }, tcad_permit_listing: run.listing },
    loader: { scope: run.options.loaderScope, generation: loader.generation_dir, state_sha256: loader.state_sha256, prior_generation: loader.prior_generation },
    run_history: history,
    ...nextRun,
    scoped_reruns: reruns,
    no_publication: "local files only: no upload, no pin, no Atlas PR (T6)",
  };
}
