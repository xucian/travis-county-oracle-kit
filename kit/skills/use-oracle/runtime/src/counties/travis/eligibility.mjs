/**
 * Travis property-first permit eligibility (kit `county-appraisal-onboarding` section 4, `county-ingest-run` section 7).
 *
 * The policy is the county-scoped `PROPERTY_FIRST_PERMIT_ELIGIBLE_USAGE_TYPES_TRAVIS`: `__ALL__` makes every parcel
 * eligible, `__NONE__` makes the run appraisal-only, any other value is a comma list of lexicon
 * `property_usage_type` values. The bare `PROPERTY_FIRST_PERMIT_ELIGIBLE_USAGE_TYPES` is read only when the caller says
 * the run is single-county. Unlike the kit's services default, an unset or empty policy is refused: the kit warns that
 * empty silently falls back to a commercial default list, so this module fails closed instead.
 *
 * Eligibility is decided from the transformed `property.json` (the usage type only exists after transform) and is
 * stamped with the policy fingerprint, so a run under a different policy recomputes it instead of trusting a stale file.
 *
 * @module counties/travis/eligibility
 */
import { createHash } from "node:crypto";

export const ELIGIBILITY_VERSION = "travis-permit-eligibility.v1";
export const ELIGIBILITY_ENV = "PROPERTY_FIRST_PERMIT_ELIGIBLE_USAGE_TYPES_TRAVIS";
export const ELIGIBILITY_ENV_BARE = "PROPERTY_FIRST_PERMIT_ELIGIBLE_USAGE_TYPES";
export const ALL = "__ALL__";
export const NONE = "__NONE__";

/**
 * @typedef {object} EligibilityPolicy
 * @property {"all" | "none" | "list"} mode
 * @property {string[]} usageTypes - Sorted usage types (list mode only).
 * @property {string} raw - The value as set.
 * @property {string} source - The variable it came from.
 * @property {string} fingerprint - SHA-256 of the version and the normalized policy.
 */

/**
 * Resolve the policy from the environment.
 *
 * @param {Record<string, string | undefined>} [env] - Environment.
 * @param {{ singleCounty?: boolean }} [options] - Whether the bare variable may be read.
 * @returns {EligibilityPolicy} Policy.
 */
export function resolveEligibilityPolicy(env = process.env, { singleCounty = false } = {}) {
  let source = ELIGIBILITY_ENV;
  let raw = env[ELIGIBILITY_ENV];
  if ((raw === undefined || raw.trim() === "") && singleCounty) {
    source = ELIGIBILITY_ENV_BARE;
    raw = env[ELIGIBILITY_ENV_BARE];
  }
  if (raw === undefined || raw.trim() === "") {
    throw new Error(`${ELIGIBILITY_ENV} is not set: set it explicitly to ${ALL} (every parcel), ${NONE} (appraisal only) or a comma list of property_usage_type values; an empty policy is refused, never defaulted`);
  }
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  let mode = "list";
  if (values.length === 1 && values[0] === ALL) mode = "all";
  else if (values.length === 1 && values[0] === NONE) mode = "none";
  else if (values.includes(ALL) || values.includes(NONE)) throw new Error(`${source}: ${ALL} and ${NONE} stand alone, got ${JSON.stringify(raw)}`);
  const usageTypes = mode === "list" ? [...new Set(values)].sort() : [];
  const normalized = mode === "list" ? usageTypes.join(",") : mode === "all" ? ALL : NONE;
  const fingerprint = createHash("sha256").update(`${ELIGIBILITY_VERSION}|${normalized}`).digest("hex");
  return { mode, usageTypes, raw, source, fingerprint };
}

/**
 * Decide one parcel's eligibility from its transformed `property.json`.
 *
 * @param {EligibilityPolicy} policy - Policy.
 * @param {{ property_usage_type?: unknown } | null | undefined} property - Transformed property.
 * @returns {{ schemaVersion: string, eligible: boolean, usageType: string | null, policyFingerprint: string, policy: string, reason: string }} Decision (`eligibility.json`).
 */
export function decideEligibility(policy, property) {
  const usageType = typeof property?.property_usage_type === "string" ? property.property_usage_type : null;
  let eligible = false;
  let reason;
  if (policy.mode === "all") {
    eligible = true;
    reason = "policy_all";
  } else if (policy.mode === "none") {
    reason = "policy_none";
  } else if (usageType === null) {
    reason = "no_usage_type";
  } else {
    eligible = policy.usageTypes.includes(usageType);
    reason = eligible ? "usage_type_listed" : "usage_type_not_listed";
  }
  return { schemaVersion: ELIGIBILITY_VERSION, eligible, usageType, policyFingerprint: policy.fingerprint, policy: policy.mode === "list" ? policy.usageTypes.join(",") : policy.raw.trim(), reason };
}

/**
 * Whether an existing eligibility record was decided under this policy (else it must be recomputed).
 *
 * @param {{ policyFingerprint?: string } | null | undefined} record - Existing `eligibility.json`.
 * @param {EligibilityPolicy} policy - Current policy.
 * @returns {boolean} Whether the record is current.
 */
export function isCurrentEligibility(record, policy) {
  return record?.policyFingerprint === policy.fingerprint && record?.schemaVersion === ELIGIBILITY_VERSION;
}
