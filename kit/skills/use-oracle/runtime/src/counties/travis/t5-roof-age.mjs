/**
 * T5 roof-age estimates (assignment decisions.md section 5 "Roof age", `api-contract.md` "Roof age"; kit
 * `query-db-loading-matching` "Roof age"): the kit's bundled estimator (`elephant.roof-age-estimate.v1`) per parcel, with
 * the frozen Travis profile (`travisRoofAgeProfile`, exact `status_current` and `roof_work_class` pairs), after the permit
 * link pass and before any product query. Internal reconciliation only: nothing here is published (the transform never
 * writes `structure.roof_date` or `roof_age_years`); the deploy-time build runs the same estimator over the published
 * fields and the two counts must reconcile.
 *
 * Inputs per parcel: the built year the County group publishes (`property.property_structure_built_year`) and every
 * permit linked to the parcel that the Property Improvement group publishes (conflicting and blank-number rows excluded,
 * as the permit transform excludes them). Historical coverage: a parcel with a linked permit has `partial` history (the
 * Austin export is one jurisdiction's system, with migrated legacy rows); a parcel without one has `unknown` history (the
 * export may not cover its jurisdiction at all). Partial history lowers certainty; it never proves no later replacement.
 *
 * Output per parcel: the contract's fields (`roof_year`, `roof_age_years` = as-of year minus roof year, `roof_age_basis`,
 * `roof_age_confidence`, `roof_age_anchor`, `roof_age_as_of`, `roof_age_caveats`), the estimator's own whole-year age and
 * eligibility reason, the permit outcome counts, the link method of the anchor permit (an anchor linked through TCAD's
 * permit listing adds the caveat `anchor_link_tcad_permit_listing`, decisions.md 25.10) and the policy and profile digests.
 *
 * @module counties/travis/t5-roof-age
 */
import { estimateRoofAge } from "../../roof-age/estimator.ts";
import { compiledTravisRoofAgeProfile, describePermitRow } from "./permit-profile.mjs";
import { SOURCE_SYSTEM } from "./query-table.mjs";

export const T5_ROOF_AGE_VERSION = "travis-t5-roof-age.v1";
export const LISTING_ANCHOR_CAVEAT = "anchor_link_tcad_permit_listing";
/** The contract's `roof_age_basis` for each estimator eligibility reason (`api-contract.md` "Roof age"). */
export const BASIS_BY_REASON = Object.freeze({
  accepted_completed_primary_roof_replacement: "completed_replacement",
  accepted_completed_primary_roof_new_construction: "new_construction",
  accepted_property_built_year: "year_built",
  no_valid_anchor: null,
});
/** README.md 36 and 74: roofs older than 15 years, strict (`roof_age_years > 15`). */
export const DEFAULT_AGE_THRESHOLD = 15;

/**
 * Estimate one parcel's roof age.
 *
 * @param {object} input - Inputs.
 * @param {string} input.propId - PROP_ID as printed.
 * @param {number | null} input.builtYear - `property_structure_built_year` as published (null when not).
 * @param {{ row: Record<string, string>, link: { propertyLink: { match_method: string } } }[]} input.permits - The parcel's published linked permits.
 * @param {string} input.asOfDate - `YYYY-MM-DD` (the permit capture's date).
 * @returns {Record<string, any>} The parcel's roof-age record.
 */
export function estimateParcelRoofAge({ propId, builtYear, permits, asOfDate }) {
  const methodByNumber = new Map(permits.map((entry) => [String(entry.row.permit_number ?? "").trim(), entry.link?.propertyLink?.match_method ?? null]));
  const estimate = estimateRoofAge(
    {
      asOfDate,
      builtYear: { year: Number.isInteger(builtYear) ? builtYear : null, evidenceState: Number.isInteger(builtYear) ? "confirmed_present" : "unknown", sourceSystem: SOURCE_SYSTEM, sourceRecordId: propId, field: "property_structure_built_year" },
      permits: permits.map((entry) => describePermitRow(entry.row, { asOfDate }).evidence),
      historicalCoverage: permits.length > 0 ? { state: "partial", caveats: [] } : { state: "unknown", caveats: [] },
    },
    compiledTravisRoofAgeProfile,
  );
  const anchor = estimate.anchor;
  const asOfYear = Number(asOfDate.slice(0, 4));
  const roofYear = anchor?.type === "permit_terminal_date" ? Number(anchor.date.slice(0, 4)) : anchor?.type === "property_built_year" ? anchor.year : null;
  const anchorMethod = anchor?.type === "permit_terminal_date" ? (methodByNumber.get(anchor.source.sourceRecordId) ?? null) : null;
  const caveats = [...estimate.historicalCoverage.caveats];
  if (anchorMethod === "tcad_permit_listing") caveats.push(LISTING_ANCHOR_CAVEAT);
  return {
    prop_id: propId,
    roof_age_as_of: asOfDate,
    roof_year: roofYear,
    roof_age_years: roofYear === null ? null : asOfYear - roofYear,
    roof_age_basis: BASIS_BY_REASON[estimate.eligibility.reason],
    roof_age_confidence: estimate.confidence,
    roof_age_anchor:
      anchor?.type === "permit_terminal_date"
        ? { permit_id: anchor.source.sourceRecordId, date: anchor.date, date_field: anchor.source.dateField === "completionDate" ? "completed_date" : "statusdate" }
        : anchor?.type === "property_built_year"
          ? { source_field: "year_built" }
          : null,
    roof_age_caveats: caveats.sort(),
    estimator: {
      schema_version: estimate.schemaVersion,
      estimated_age_years: estimate.estimatedAgeYears,
      eligibility_reason: estimate.eligibility.reason,
      work_classification: estimate.workClassification,
      historical_coverage: estimate.historicalCoverage.state,
      permit_count: estimate.evidence.permitCount,
      permit_outcome_counts: estimate.evidence.permitOutcomeCounts,
      anchor_link_method: anchorMethod,
    },
    policy: { version: estimate.policy.version, profile_version: estimate.policy.profileVersion, profile_sha256: estimate.policy.profileSha256 },
  };
}

/** @param {Record<string, number>} counts @param {string} key */
const bump = (counts, key, by = 1) => {
  counts[key] = (counts[key] ?? 0) + by;
};

/**
 * Empty roof-age counts.
 *
 * @returns {Record<string, any>} Counts.
 */
export function emptyRoofAgeCounts() {
  return {
    parcels: 0,
    eligible: 0,
    ineligible: 0,
    by_basis: {},
    by_confidence: {},
    by_eligibility_reason: {},
    by_historical_coverage: {},
    caveats: {},
    anchor_link_method: {},
    older_than_threshold: { threshold_years: DEFAULT_AGE_THRESHOLD, rule: "roof_age_years > threshold", total: 0, by_basis: {} },
    permit_outcomes: {},
    permits_evaluated: 0,
  };
}

/**
 * Add one parcel's record to the counts.
 *
 * @param {Record<string, any>} counts - From {@link emptyRoofAgeCounts}.
 * @param {Record<string, any>} record - From {@link estimateParcelRoofAge}.
 * @returns {void}
 */
export function countRoofAge(counts, record) {
  counts.parcels += 1;
  const basis = record.roof_age_basis ?? "none";
  if (record.roof_age_basis === null) counts.ineligible += 1;
  else counts.eligible += 1;
  bump(counts.by_basis, basis);
  bump(counts.by_confidence, record.roof_age_confidence);
  bump(counts.by_eligibility_reason, record.estimator.eligibility_reason);
  bump(counts.by_historical_coverage, record.estimator.historical_coverage);
  for (const caveat of record.roof_age_caveats) bump(counts.caveats, caveat);
  if (record.estimator.anchor_link_method) bump(counts.anchor_link_method, record.estimator.anchor_link_method);
  if (record.roof_age_years !== null && record.roof_age_years > DEFAULT_AGE_THRESHOLD) {
    counts.older_than_threshold.total += 1;
    bump(counts.older_than_threshold.by_basis, basis);
  }
  counts.permits_evaluated += record.estimator.permit_count;
  for (const [outcome, value] of Object.entries(record.estimator.permit_outcome_counts)) if (value > 0) bump(counts.permit_outcomes, outcome, value);
}

/**
 * Sum several count objects (per-shard counts into run totals).
 *
 * @param {Record<string, any>[]} list - Counts.
 * @returns {Record<string, any>} Sum.
 */
export function sumRoofAgeCounts(list) {
  const total = emptyRoofAgeCounts();
  const addMap = (target, source) => {
    for (const [key, value] of Object.entries(source ?? {})) target[key] = (target[key] ?? 0) + value;
  };
  for (const counts of list) {
    total.parcels += counts.parcels;
    total.eligible += counts.eligible;
    total.ineligible += counts.ineligible;
    total.permits_evaluated += counts.permits_evaluated;
    total.older_than_threshold.total += counts.older_than_threshold.total;
    for (const key of ["by_basis", "by_confidence", "by_eligibility_reason", "by_historical_coverage", "caveats", "anchor_link_method", "permit_outcomes"]) addMap(total[key], counts[key]);
    addMap(total.older_than_threshold.by_basis, counts.older_than_threshold.by_basis);
  }
  return total;
}
