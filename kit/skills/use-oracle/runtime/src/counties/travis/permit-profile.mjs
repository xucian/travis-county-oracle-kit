/**
 * Travis County (TX) permit profile for the City of Austin "Issued Construction
 * Permits" Socrata export (`data.austintexas.gov/resource/3syk-w9eu`).
 *
 * The profile owns every county-specific vocabulary decision the kit asks the
 * county profile to own (`skills/use-oracle/reference/permit-evidence-preflight.md`,
 * `roof-age-and-identity-reingest.md`): the exact status vocabulary and its
 * API status groups, the lifecycle mapping handed to the bundled roof-age
 * estimator, the fixture-tested work classification built from exact source
 * terms (the regex tiers of the assignment's first API draft turned into
 * exact normalized terms), the `completed_date`/`statusdate`/`applieddate`
 * evidence states, and the `tcad_id` (TCAD Geographic ID) evidence states
 * with the digits-only normalization proof the parcel link may rely on.
 *
 * Nothing here harvests. The Socrata harvester is `t4-permit-fetch.mjs` and
 * the link pass `t4-permit-links.mjs` (T4); the kit routing profile
 * (`validatePermitProfile`, whose adapter enum has no Socrata family at
 * `99c7bff`) is not used; the jurisdiction catalog lives in
 * `docs/travis-sources.yaml`.
 *
 * Every mapping is exact after one normalization: NFKC, trim, whitespace
 * collapse, upper case (the same normalization `compileRoofAgeProfile`
 * applies). No fuzzy matching anywhere. Anything unmapped is `needs_review`.
 *
 * @module counties/travis/permit-profile
 */

import { compileRoofAgeProfile } from "../../roof-age/estimator.ts";

export const TRAVIS_COUNTY_KEY = "travis";
export const TRAVIS_PERMIT_SOURCE_SYSTEM = "travis_austin_socrata_permits";
export const TRAVIS_PERMIT_DATASET = "austin-issued-construction-permits/3syk-w9eu";
export const TRAVIS_PERMIT_DATASET_URL = "https://data.austintexas.gov/resource/3syk-w9eu";

export const STATUS_GROUP_VERSION = "travis-status-group-v1";
export const LIFECYCLE_MAPPING_VERSION = "travis-lifecycle-v1";
export const WORK_CLASSIFIER_VERSION = "travis-work-classifier-v2";
export const DATE_EVIDENCE_VERSION = "travis-date-evidence-v1";
export const TCAD_ID_NORMALIZATION_VERSION = "travis-tcad-id-digits-v1";
/** Reasons a printed `tcad_id` is not a usable Geographic ID (v2 adds the neighbouring-district forms, T4 capture). */
export const TCAD_ID_EVIDENCE_VERSION = "travis-tcad-id-evidence-v2";
export const TRAVIS_ROOF_AGE_PROFILE_VERSION = "travis-roof-age-profile-v1";

/** Dates before this are migration artifacts in the export (the earliest applied date is 1921-09-20). */
export const EARLIEST_PLAUSIBLE_DATE = "1900-01-01";

/**
 * NFKC, trim, whitespace collapse, upper case. Mirrors the roof-age
 * estimator's `normalizeSourceValue` so a value mapped here is mapped there.
 *
 * @param {unknown} value - Raw source value.
 * @returns {string} Normalized value (empty string for null/blank).
 */
export function normalizeSourceValue(value) {
  if (value === null || value === undefined) return "";
  return String(value).normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase();
}

// ---------------------------------------------------------------------------
// Status groups (api-contract.md "Status group") and lifecycle (estimator).
// ---------------------------------------------------------------------------

/** `status_current` values the API groups as `open` (exact, from the contract). */
export const OPEN_STATUSES = Object.freeze([
  "Active",
  "Pending Permit",
  "On Hold",
  "Re Review",
  "Suspended",
  "Inactive Pending Revision",
]);

/** The exact `Cancelled` variants the export printed on 2026-10-16. */
export const CANCELLED_STATUSES = Object.freeze([
  "Cancelled",
  "Cancelled - Contractor Required",
  "Cancelled - New Permit Required",
]);

/** `status_current` values the API groups as `closed` whatever the completion evidence. */
export const CLOSED_STATUSES = Object.freeze([
  "Final",
  "Withdrawn",
  ...CANCELLED_STATUSES,
  "VOID",
  "Aborted",
]);

/** `Expired` is `closed` with a confirmed completion date and `stalled` otherwise. */
export const EXPIRED_STATUS = "Expired";

/**
 * Values observed in the export on 2026-10-16 that the contract does not map.
 * They are `needs_review` on purpose; the list exists so the vocabulary test
 * notices a new value when the fixture is refreshed.
 */
export const OBSERVED_UNMAPPED_STATUSES = Object.freeze([
  "Pending",
  "Closed",
  "Denied but Closed",
  "Expired - License",
  "New Permit Required",
  "Inactive Contractor",
  "Revoked",
  "Application Incomplete",
  "Rejected",
  "Awaiting Upload",
]);

/** Lifecycle for the roof-age estimator: only `Final` is completed work. */
export const LIFECYCLE_COMPLETED_STATUSES = Object.freeze(["Final"]);
export const LIFECYCLE_OPEN_STATUSES = OPEN_STATUSES;
export const LIFECYCLE_OTHER_STATUSES = Object.freeze([
  "Withdrawn",
  ...CANCELLED_STATUSES,
  "VOID",
  "Aborted",
  EXPIRED_STATUS,
]);

const OPEN_SET = new Set(OPEN_STATUSES.map(normalizeSourceValue));
const CLOSED_SET = new Set(CLOSED_STATUSES.map(normalizeSourceValue));
const EXPIRED = normalizeSourceValue(EXPIRED_STATUS);

/**
 * @typedef {object} StatusGroupResult
 * @property {"open" | "stalled" | "closed" | "needs_review"} statusGroup
 * @property {string} basis - Why the group was chosen (fixture-readable).
 * @property {string} version - {@link STATUS_GROUP_VERSION}.
 */

/**
 * Map a printed `status_current` to the API status group.
 *
 * @param {object} input - Printed status and the completion-date evidence state.
 * @param {unknown} input.statusCurrent - `status_current` as printed.
 * @param {{ evidenceState: string } | null | undefined} [input.completedDateEvidence] - From {@link classifyDateEvidence}.
 * @returns {StatusGroupResult} Group and basis.
 */
export function classifyStatusGroup({ statusCurrent, completedDateEvidence }) {
  const status = normalizeSourceValue(statusCurrent);
  if (status === "") {
    return { statusGroup: "needs_review", basis: "blank_status", version: STATUS_GROUP_VERSION };
  }
  if (OPEN_SET.has(status)) {
    return { statusGroup: "open", basis: "exact_open_status", version: STATUS_GROUP_VERSION };
  }
  if (CLOSED_SET.has(status)) {
    return { statusGroup: "closed", basis: "exact_closed_status", version: STATUS_GROUP_VERSION };
  }
  if (status === EXPIRED) {
    if (completedDateEvidence?.evidenceState === "confirmed_present") {
      return {
        statusGroup: "closed",
        basis: "expired_with_confirmed_completion",
        version: STATUS_GROUP_VERSION,
      };
    }
    return {
      statusGroup: "stalled",
      basis: "expired_without_confirmed_completion",
      version: STATUS_GROUP_VERSION,
    };
  }
  return { statusGroup: "needs_review", basis: "unmapped_status", version: STATUS_GROUP_VERSION };
}

/**
 * Lifecycle status the estimator sees (`completed` | `open` | `other` | `needs_review`).
 *
 * @param {unknown} statusCurrent - `status_current` as printed.
 * @returns {"completed" | "open" | "other" | "needs_review"} Lifecycle status.
 */
export function classifyLifecycleStatus(statusCurrent) {
  const status = normalizeSourceValue(statusCurrent);
  if (LIFECYCLE_COMPLETED_STATUSES.map(normalizeSourceValue).includes(status)) return "completed";
  if (OPEN_SET.has(status)) return "open";
  if (LIFECYCLE_OTHER_STATUSES.map(normalizeSourceValue).includes(status)) return "other";
  return "needs_review";
}

// ---------------------------------------------------------------------------
// Date evidence (completed_date, statusdate, applieddate).
// ---------------------------------------------------------------------------

const SOCRATA_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?$/;

/**
 * @param {string} value - `YYYY-MM-DD`.
 * @returns {number | null} UTC epoch milliseconds for a real calendar date, else null.
 */
function calendarEpoch(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const epoch = Date.UTC(year, month - 1, day);
  const date = new Date(epoch);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return epoch;
}

/**
 * @typedef {object} DateEvidence
 * @property {string | null} value - ISO `YYYY-MM-DD` when confirmed, the raw text when quarantined, null when unknown.
 * @property {"confirmed_present" | "unknown" | "invalid_quarantined"} evidenceState
 * @property {string | null} raw - The value exactly as printed (null when blank).
 * @property {string} reason - Fixture-readable reason.
 * @property {string} version - {@link DATE_EVIDENCE_VERSION}.
 */

/**
 * Classify one Socrata floating timestamp into the kit's evidence states. A
 * blank export column is `unknown`, never a confirmed empty (that needs a
 * detail lookup, which v1 does not do). Malformed, impossible, future, or
 * chronologically impossible values are `invalid_quarantined` with the raw
 * value kept.
 *
 * @param {unknown} raw - The printed value.
 * @param {object} options - Bounds.
 * @param {string} options.asOfDate - `YYYY-MM-DD`; later dates are quarantined as future.
 * @param {string | null} [options.notBefore] - `YYYY-MM-DD` chronology start (the permit's valid applied date); earlier dates are quarantined.
 * @returns {DateEvidence} Evidence record.
 */
export function classifyDateEvidence(raw, { asOfDate, notBefore = null }) {
  const text = raw === null || raw === undefined ? "" : String(raw).trim();
  if (text === "") {
    return { value: null, evidenceState: "unknown", raw: null, reason: "blank", version: DATE_EVIDENCE_VERSION };
  }
  const match = SOCRATA_DATE.exec(text);
  const iso = match ? `${match[1]}-${match[2]}-${match[3]}` : null;
  const epoch = iso ? calendarEpoch(iso) : null;
  if (epoch === null) {
    return { value: text, evidenceState: "invalid_quarantined", raw: text, reason: "malformed", version: DATE_EVIDENCE_VERSION };
  }
  const asOfEpoch = calendarEpoch(asOfDate);
  if (asOfEpoch === null) {
    throw new Error(`asOfDate must be YYYY-MM-DD, got ${asOfDate}`);
  }
  if (epoch < calendarEpoch(EARLIEST_PLAUSIBLE_DATE)) {
    return { value: text, evidenceState: "invalid_quarantined", raw: text, reason: "before_earliest_plausible_date", version: DATE_EVIDENCE_VERSION };
  }
  if (epoch > asOfEpoch) {
    return { value: text, evidenceState: "invalid_quarantined", raw: text, reason: "future", version: DATE_EVIDENCE_VERSION };
  }
  if (notBefore) {
    const floor = calendarEpoch(notBefore);
    if (floor !== null && epoch < floor) {
      return { value: text, evidenceState: "invalid_quarantined", raw: text, reason: "before_applied_date", version: DATE_EVIDENCE_VERSION };
    }
  }
  return { value: iso, evidenceState: "confirmed_present", raw: text, reason: "valid", version: DATE_EVIDENCE_VERSION };
}

// ---------------------------------------------------------------------------
// Work classification: exact normalized terms, no regex at query time.
// ---------------------------------------------------------------------------

export const BUILDING_PERMIT_TYPE = "BP";
/** Trade and driveway permits are never roofing work (contract: `other`). */
export const NON_BUILDING_PERMIT_TYPES = Object.freeze(["EP", "MP", "PP", "DS"]);

/**
 * Terms (in normalized form: upper case, punctuation collapsed to one space)
 * that name a primary-roof replacement. Derived from the first draft's
 * `\bre-?\s?roof|\bshingle|roof\s+replacement|\breplace\w*\s+(the\s+)?roof|\bnew\s+roof`.
 */
export const REPLACEMENT_TERMS = Object.freeze([
  "RE ROOF",
  "RE ROOFING",
  "RE ROOFED",
  "RE ROOFS",
  "REROOF",
  "REROOFING",
  "REROOFED",
  "REROOFS",
  "ROOF REPLACEMENT",
  "REPLACEMENT ROOF",
  "REPLACE ROOF",
  "REPLACE THE ROOF",
  "REPLACE EXISTING ROOF",
  "REPLACING ROOF",
  "REPLACING THE ROOF",
  "REPLACED ROOF",
  "REPLACED THE ROOF",
  "NEW ROOF",
  "SHINGLE",
  "SHINGLES",
  "SHINGLED",
  "RESHINGLE",
  "RE SHINGLE",
  "ROOF TEAR OFF",
  "TEAR OFF ROOF",
  "TEAR OFF AND REPLACE ROOF",
]);

/** Terms that name repair or coating work on a primary roof (never resets age). */
export const REPAIR_TERMS = Object.freeze([
  "ROOF REPAIR",
  "ROOF REPAIRS",
  "REPAIR ROOF",
  "REPAIR THE ROOF",
  "REPAIRING ROOF",
  "REPAIRED ROOF",
  "ROOF PATCH",
  "PATCH ROOF",
  "ROOF LEAK",
  "ROOF LEAKS",
  "ROOF COATING",
  "ROOF COATINGS",
  "ELASTOMERIC",
  "ELASTOMERIC COATING",
  "SILICONE ROOF",
  "SILICONE COATING",
  "RECOAT ROOF",
  "RE COAT ROOF",
  "ROOF RECOAT",
]);

/** Terms that name accessory-roof work (carports, patio covers, awnings; never resets primary roof age). */
export const ACCESSORY_TERMS = Object.freeze([
  "CARPORT",
  "CARPORTS",
  "CARPORT ROOF",
  "PATIO COVER",
  "PATIO COVERS",
  "COVERED PATIO",
  "COVERED PORCH",
  "COVERED DECK",
  "PATIO ROOF",
  "PORCH ROOF",
  "ROOF OVERHANG",
  "OVERHANG",
  "AWNING",
  "AWNINGS",
  "GAZEBO",
  "PERGOLA",
  "CABANA",
  "STORAGE SHED",
  "SHED ROOF",
  "DETACHED GARAGE",
  "DETACHED GARAGES",
  "DETACHED GARAGE ROOF",
  "GARAGE ROOF",
  "CANOPY",
]);

/**
 * Terms that mention a roof without describing roofing work. They are removed
 * before any other match so "NEW ROOF TOP UNIT" never reads as a new roof.
 */
export const EXCLUSION_TERMS = Object.freeze([
  "WATERPROOF",
  "WATERPROOFING",
  "FIREPROOF",
  "FIREPROOFING",
  "SOUNDPROOF",
  "SOUNDPROOFING",
  "WEATHERPROOF",
  "WEATHERPROOFING",
  "DAMPPROOF",
  "DAMP PROOF",
  "DAMPPROOFING",
  "DAMP PROOFING",
  "ROOF DECK",
  "ROOF DRAIN",
  "ROOF DRAINS",
  "ROOF HATCH",
  "ROOF ACCESS",
  "ROOF TOP UNIT",
  "ROOF TOP UNITS",
  "ROOFTOP UNIT",
  "ROOFTOP UNITS",
  "RTU",
  "RTUS",
  "SOLAR",
  "PHOTOVOLTAIC",
  "PV",
  "ROOF MOUNTED",
  "ROOF MOUNT",
]);

/** A bare roof mention left after every term above is removed is ambiguous. */
export const GENERIC_ROOF_TOKENS = Object.freeze(["ROOF", "ROOFS", "ROOFING", "ROOFED"]);

/** `work_class` value that, with a new-building permit class, means a new primary roof. */
export const NEW_CONSTRUCTION_WORK_CLASS = "New";

/**
 * `permit_class` values (exact, as the export prints them) whose `New`
 * permits build a whole structure and therefore a new primary roof.
 */
export const NEW_BUILDING_PERMIT_CLASSES = Object.freeze([
  "R- 101 Single Family Houses",
  "R- 102 Secondary Apartment",
  "R- 103 Two Family Bldgs",
  "C- 101 Single Family Houses",
  "C- 103 Two Family Bldgs",
  "C- 104 Three & Four Family Bldgs",
  "C- 105 Five or More Family Bldgs",
  "C- 106 Mixed Use",
  "C- 213 Hotels, Motels, & Tourist Cabins",
  "C- 214 Other Nonhousekeeping Shelter",
  "C- 318 Amusement, Social & Rec Bldgs",
  "C- 319 Churches and Othr Religious Bldgs",
  "C- 320 Industrial Bldgs",
  "C- 321 Pkg Garage Bldg & Open Deck",
  "C- 322 Service Station & Repair Garage",
  "C- 323 Hospital & Institutional Bldgs",
  "C- 324 Office, Bank & Professional Bldgs",
  "C- 325 Public Works & Utilities Bldgs",
  "C- 326 Schools & Other Educational Bldgs",
  "C- 327 Stores & Customer Services",
  "C- 328 Commercial Other Nonresident Bldg",
]);

const NEW_BUILDING_SET = new Set(NEW_BUILDING_PERMIT_CLASSES.map(normalizeSourceValue));

/**
 * Upper-case text with every non-alphanumeric run collapsed to one space, so
 * `re-roof`, `re/roof` and `re  roof` all read `RE ROOF`.
 *
 * @param {unknown} value - Raw text.
 * @returns {string} Normalized token text.
 */
export function normalizeWorkText(value) {
  if (value === null || value === undefined) return "";
  return ` ${String(value).normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim()} `;
}

/**
 * Remove every whole-word occurrence of the given terms (longest first) and
 * report which matched.
 *
 * @param {string} text - Normalized text, space-padded.
 * @param {readonly string[]} terms - Normalized terms.
 * @returns {{ text: string, matched: string[] }} Remaining text and matched terms (unique, in term order).
 */
function consumeTerms(text, terms) {
  const ordered = [...terms].sort((left, right) => right.length - left.length || left.localeCompare(right));
  const matched = new Set();
  let remaining = text;
  for (const term of ordered) {
    const needle = ` ${term} `;
    if (remaining.includes(needle)) {
      matched.add(term);
      remaining = remaining.split(needle).join("  ");
    }
  }
  return { text: remaining, matched: [...matched] };
}

/**
 * @param {string} text - Normalized text with class terms removed.
 * @returns {string[]} Generic roof tokens still present.
 */
function remainingRoofTokens(text) {
  const tokens = new Set(text.split(/\s+/).filter(Boolean));
  return GENERIC_ROOF_TOKENS.filter((token) => tokens.has(token));
}

/**
 * @typedef {object} RoofWorkClassification
 * @property {"primary_roof_replacement" | "primary_roof_new_construction" | "repair_or_coating" | "accessory_roof" | "other" | "needs_review"} roofWorkClass
 * @property {string} basis - Fixture-readable rule that fired.
 * @property {{ replacement: string[], repair: string[], accessory: string[], exclusion: string[], generic: string[] }} matchedTerms
 * @property {{ field: string, term: string }[]} termEvidence - Which field each matched term came from (the source evidence retained for the classification).
 * @property {string} version - {@link WORK_CLASSIFIER_VERSION}.
 */

/**
 * Classify a permit's roofing work from exact terms in `description`,
 * `work_class` and `permit_class`.
 *
 * Precedence (fixture-tested, v2): non-building permit types are `other`;
 * exclusion terms are removed first; replacement without accessory terms is
 * `primary_roof_replacement` (legacy rows coded `New` whose text says re-roof
 * stay re-roofs); a `New` permit in a new-building class is
 * `primary_roof_new_construction` unless its text names only repair work (a
 * repair of an existing building coded `New`): the permit builds the whole
 * structure, so an attached carport, a covered porch or a negation such as
 * "no carport" in its text does not make it accessory work (v1 put accessory
 * terms first and read 42,287 new buildings of the T4 capture as
 * `accessory_roof`); otherwise replacement with accessory terms is
 * `needs_review`; accessory terms are `accessory_roof`; repair terms are
 * `repair_or_coating`; a bare roof mention that no term explains is
 * `needs_review`; everything else is `other`.
 *
 * @param {object} row - Printed permit fields.
 * @param {unknown} row.permitType - `permittype`.
 * @param {unknown} row.description - `description`.
 * @param {unknown} row.workClass - `work_class`.
 * @param {unknown} row.permitClass - `permit_class`.
 * @returns {RoofWorkClassification} Classification with the retained term evidence.
 */
export function classifyRoofWork({ permitType, description, workClass, permitClass }) {
  const matchedTerms = { replacement: [], repair: [], accessory: [], exclusion: [], generic: [] };
  /** @type {{ field: string, term: string }[]} */
  const termEvidence = [];
  const result = (roofWorkClass, basis) => ({ roofWorkClass, basis, matchedTerms, termEvidence, version: WORK_CLASSIFIER_VERSION });

  const type = normalizeSourceValue(permitType);
  if (type !== BUILDING_PERMIT_TYPE) {
    return result("other", type === "" ? "blank_permit_type" : "non_building_permit_type");
  }

  for (const [field, raw] of [
    ["description", description],
    ["work_class", workClass],
    ["permit_class", permitClass],
  ]) {
    let text = normalizeWorkText(raw);
    if (text.trim() === "") continue;
    for (const [bucket, terms] of [
      ["exclusion", EXCLUSION_TERMS],
      ["replacement", REPLACEMENT_TERMS],
      ["accessory", ACCESSORY_TERMS],
      ["repair", REPAIR_TERMS],
    ]) {
      const consumed = consumeTerms(text, terms);
      text = consumed.text;
      for (const term of consumed.matched) {
        if (!matchedTerms[bucket].includes(term)) matchedTerms[bucket].push(term);
        termEvidence.push({ field, term });
      }
    }
    for (const token of remainingRoofTokens(text)) {
      if (!matchedTerms.generic.includes(token)) matchedTerms.generic.push(token);
      termEvidence.push({ field, term: token });
    }
  }

  const hasReplacement = matchedTerms.replacement.length > 0;
  const hasAccessory = matchedTerms.accessory.length > 0;
  const hasRepair = matchedTerms.repair.length > 0;
  const newBuilding =
    normalizeSourceValue(workClass) === normalizeSourceValue(NEW_CONSTRUCTION_WORK_CLASS) && NEW_BUILDING_SET.has(normalizeSourceValue(permitClass));
  if (hasReplacement && !hasAccessory) return result("primary_roof_replacement", "replacement_terms");
  if (newBuilding && hasRepair && !hasAccessory && !hasReplacement) return result("repair_or_coating", "repair_or_coating_terms");
  if (newBuilding) return result("primary_roof_new_construction", hasAccessory || hasReplacement ? "new_building_permit_class_over_terms" : "new_building_permit_class");
  if (hasReplacement && hasAccessory) return result("needs_review", "replacement_and_accessory_terms");
  if (hasAccessory) return result("accessory_roof", "accessory_terms");
  if (hasRepair) return result("repair_or_coating", "repair_or_coating_terms");
  if (matchedTerms.generic.length > 0) return result("needs_review", "unqualified_roof_mention");
  return result("other", "no_roof_terms");
}

/** Classes that count as roofing for the open/stalled signal (contract: `is_roofing`). */
export const ROOFING_WORK_CLASSES = Object.freeze([
  "primary_roof_replacement",
  "primary_roof_new_construction",
  "repair_or_coating",
  "accessory_roof",
]);

// ---------------------------------------------------------------------------
// tcad_id (TCAD Geographic ID) evidence, normalization proof and linking.
// ---------------------------------------------------------------------------

const GEO_ID_PATTERN = /^\d{10}$/;
/**
 * The account form of the Williamson Central Appraisal District (`R` and six digits) and its marker `WCAD`. The T4
 * capture (v1792239863) prints it on 103,848 + 21 permits, 99.98% of those with coordinates north of latitude 30.40 in
 * the Austin limits that lie in Williamson County: another county's parcel id, never a TCAD Geographic ID, so these
 * permits are outside the Travis parcel population (the 2026-10-16 count of "7-character" values was this form).
 */
const WILLIAMSON_CAD_ACCOUNT = /^R\d{6}$/;
const WILLIAMSON_CAD_MARKER = "WCAD";

/**
 * @typedef {object} TcadIdEvidence
 * @property {string | null} value - The 10-digit id when confirmed, the raw text when quarantined, null when blank.
 * @property {"confirmed_present" | "unknown" | "invalid_quarantined"} evidenceState
 * @property {string | null} raw - As printed.
 * @property {string} reason
 */

/**
 * Classify a printed `tcad_id` ({@link TCAD_ID_EVIDENCE_VERSION}). Only an
 * exact 10-digit value is a usable Geographic ID. The Williamson CAD account
 * form (`R` and six digits; 103,848 rows in the T4 capture) and its `WCAD`
 * marker (21) name another county's parcel; other lengths (176) and other
 * text (2) are malformed. All of them are quarantined with the raw value kept;
 * blanks are unknown.
 *
 * @param {unknown} raw - `tcad_id` as printed.
 * @returns {TcadIdEvidence} Evidence record.
 */
export function tcadIdEvidence(raw) {
  const text = raw === null || raw === undefined ? "" : String(raw).trim();
  if (text === "") return { value: null, evidenceState: "unknown", raw: null, reason: "blank" };
  if (GEO_ID_PATTERN.test(text)) return { value: text, evidenceState: "confirmed_present", raw: text, reason: "ten_digit_geo_id" };
  if (WILLIAMSON_CAD_ACCOUNT.test(text)) return { value: text, evidenceState: "invalid_quarantined", raw: text, reason: "williamson_cad_account_form" };
  if (text.toUpperCase() === WILLIAMSON_CAD_MARKER) return { value: text, evidenceState: "invalid_quarantined", raw: text, reason: "williamson_cad_marker" };
  return { value: text, evidenceState: "invalid_quarantined", raw: text, reason: /^\d+$/.test(text) ? `digits_length_${text.length}` : "non_numeric" };
}

/**
 * The digits-only form used by the recorded fallback comparison.
 *
 * @param {unknown} value - A printed identifier.
 * @returns {string} Every non-digit removed.
 */
export function normalizeTcadIdDigits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

/**
 * Prove (or disprove) that the digits-only normalization is one-to-one over
 * the roll's `geo_id` population. Run during the US egress window over the
 * full TCAD export; the result is recorded with
 * {@link TCAD_ID_NORMALIZATION_VERSION} before the fallback is enabled.
 *
 * @param {Iterable<unknown>} geoIds - Every `geo_id` printed in the roll.
 * @returns {{ normalizationVersion: string, checkedCount: number, distinctGeoIds: number, distinctDigits: number, oneToOne: boolean, collisions: { digits: string, geoIds: string[] }[] }} Proof record.
 */
export function proveDigitsOnlyNormalization(geoIds) {
  /** @type {Map<string, Set<string>>} */
  const byDigits = new Map();
  const distinct = new Set();
  let checkedCount = 0;
  for (const raw of geoIds) {
    const printed = String(raw ?? "").trim();
    if (printed === "") continue;
    checkedCount += 1;
    distinct.add(printed);
    const digits = normalizeTcadIdDigits(printed);
    const members = byDigits.get(digits) ?? new Set();
    members.add(printed);
    byDigits.set(digits, members);
  }
  const collisions = [...byDigits.entries()]
    .filter(([, members]) => members.size > 1)
    .map(([digits, members]) => ({ digits, geoIds: [...members].sort() }))
    .sort((left, right) => left.digits.localeCompare(right.digits));
  return {
    normalizationVersion: TCAD_ID_NORMALIZATION_VERSION,
    checkedCount,
    distinctGeoIds: distinct.size,
    distinctDigits: byDigits.size,
    oneToOne: collisions.length === 0,
    collisions,
  };
}

/**
 * @typedef {object} ParcelLinkResult
 * @property {string | null} propertyId - `PROP_ID` of the one matching parcel, else null.
 * @property {{ match_method: "exact" | "normalized_digits", normalization_version: string | null, confidence: "exact" | "normalized" } | null} propertyLink
 * @property {"no_candidate" | "multiple_candidates" | "invalid_quarantined" | null} unlinkedReason
 * @property {TcadIdEvidence} tcadIdEvidence
 */

/**
 * Link one permit to one parcel on `geo_id` exactly as printed first. The
 * digits-only comparison runs only when a proof with `oneToOne: true` is
 * supplied. Zero or several candidates stay valid-unlinked.
 *
 * @param {object} input - Permit id and the roll indexes.
 * @param {unknown} input.tcadId - `tcad_id` as printed.
 * @param {Map<string, readonly string[]>} input.parcelsByGeoId - `geo_id` as printed to the `PROP_ID`s carrying it.
 * @param {{ proof: { oneToOne: boolean, normalizationVersion: string }, parcelsByDigits: Map<string, readonly string[]> } | null} [input.digitsFallback] - Enabled only with a one-to-one proof.
 * @returns {ParcelLinkResult} Link decision.
 */
export function linkPermitToParcel({ tcadId, parcelsByGeoId, digitsFallback = null }) {
  const evidence = tcadIdEvidence(tcadId);
  const unlinked = (unlinkedReason) => ({ propertyId: null, propertyLink: null, unlinkedReason, tcadIdEvidence: evidence });
  if (evidence.evidenceState === "invalid_quarantined") return unlinked("invalid_quarantined");
  if (evidence.evidenceState === "unknown") return unlinked("no_candidate");

  const exact = parcelsByGeoId.get(evidence.value) ?? [];
  if (exact.length === 1) {
    return {
      propertyId: exact[0],
      propertyLink: { match_method: "exact", normalization_version: null, confidence: "exact" },
      unlinkedReason: null,
      tcadIdEvidence: evidence,
    };
  }
  if (exact.length > 1) return unlinked("multiple_candidates");

  if (digitsFallback && digitsFallback.proof?.oneToOne === true) {
    const candidates = digitsFallback.parcelsByDigits.get(normalizeTcadIdDigits(evidence.value)) ?? [];
    if (candidates.length === 1) {
      return {
        propertyId: candidates[0],
        propertyLink: {
          match_method: "normalized_digits",
          normalization_version: digitsFallback.proof.normalizationVersion,
          confidence: "normalized",
        },
        unlinkedReason: null,
        tcadIdEvidence: evidence,
      };
    }
    if (candidates.length > 1) return unlinked("multiple_candidates");
  }
  return unlinked("no_candidate");
}

// ---------------------------------------------------------------------------
// Roof-age profile for the bundled estimator.
// ---------------------------------------------------------------------------

/**
 * The estimator maps exact `field`/`value` pairs. Status comes straight from
 * `status_current`; work comes from this profile's classifier output
 * (`roof_work_class`), because the Austin scope lives in free-text
 * `description` and only the fixture-tested term classifier can read it. The
 * estimator still fails closed: any value not listed here is `needs_review`.
 */
export const travisRoofAgeProfile = Object.freeze({
  version: TRAVIS_ROOF_AGE_PROFILE_VERSION,
  sources: [
    {
      sourceSystem: TRAVIS_PERMIT_SOURCE_SYSTEM,
      statusMappings: [
        ...LIFECYCLE_COMPLETED_STATUSES.map((value) => ({ field: "status_current", value, status: "completed" })),
        ...LIFECYCLE_OPEN_STATUSES.map((value) => ({ field: "status_current", value, status: "open" })),
        ...LIFECYCLE_OTHER_STATUSES.map((value) => ({ field: "status_current", value, status: "other" })),
      ],
      workMappings: [
        "primary_roof_replacement",
        "primary_roof_new_construction",
        "repair_or_coating",
        "accessory_roof",
        "other",
      ].map((value) => ({ field: "roof_work_class", value, classification: value })),
    },
  ],
});

export const compiledTravisRoofAgeProfile = compileRoofAgeProfile(travisRoofAgeProfile);

/**
 * @typedef {object} SocrataPermitRow
 * @property {unknown} permit_number
 * @property {unknown} permittype
 * @property {unknown} description
 * @property {unknown} work_class
 * @property {unknown} permit_class
 * @property {unknown} status_current
 * @property {unknown} [statusdate]
 * @property {unknown} [completed_date]
 * @property {unknown} [applieddate]
 * @property {unknown} [issue_date]
 * @property {unknown} [expiresdate]
 * @property {unknown} [tcad_id]
 */

/**
 * @typedef {object} PermitRowDescription
 * @property {import("../../roof-age/estimator.ts").RoofAgePermitEvidence} evidence - Exactly the estimator's input shape (strict schema; nothing extra).
 * @property {RoofWorkClassification} classification - The work classification the evidence was built from.
 * @property {DateEvidence} appliedDateEvidence
 * @property {DateEvidence} completedDateEvidence
 * @property {DateEvidence | null} closeDateEvidence - `statusdate` evidence when the permit is Final, else null.
 */

/**
 * Describe one export row for the estimator and the API.
 *
 * `completed_date` is the completion date. The close date is `statusdate`
 * only when `status_current` is `Final` (the date the permit was finaled);
 * for any other status the close date is unknown, never synthesized.
 * `applieddate` is the chronology start.
 *
 * @param {SocrataPermitRow} row - One export row.
 * @param {{ asOfDate: string }} options - As-of date.
 * @returns {PermitRowDescription} Evidence plus the classification and date evidence it was built from.
 */
export function describePermitRow(row, { asOfDate }) {
  const applied = classifyDateEvidence(row.applieddate, { asOfDate });
  const notBefore = applied.evidenceState === "confirmed_present" ? applied.value : null;
  const completion = classifyDateEvidence(row.completed_date, { asOfDate, notBefore });
  const isFinal = classifyLifecycleStatus(row.status_current) === "completed";
  const close = isFinal ? classifyDateEvidence(row.statusdate, { asOfDate, notBefore }) : null;
  const classification = classifyRoofWork({
    permitType: row.permittype,
    description: row.description,
    workClass: row.work_class,
    permitClass: row.permit_class,
  });
  const evidence = {
    sourceSystem: TRAVIS_PERMIT_SOURCE_SYSTEM,
    sourceRecordId: String(row.permit_number ?? "").trim(),
    statusEvidence: [{ field: "status_current", value: normalizeSourceValue(row.status_current) || "UNKNOWN" }],
    workEvidence: [{ field: "roof_work_class", value: classification.roofWorkClass }],
    completionDate: { value: completion.value, evidenceState: completion.evidenceState },
    closeDate: close ? { value: close.value, evidenceState: close.evidenceState } : { value: null, evidenceState: "unknown" },
    chronologyStartDate:
      applied.evidenceState === "unknown" ? null : { value: applied.value, evidenceState: applied.evidenceState },
  };
  return { evidence, classification, appliedDateEvidence: applied, completedDateEvidence: completion, closeDateEvidence: close };
}

/**
 * The estimator's permit evidence for one export row (strict schema shape).
 *
 * @param {SocrataPermitRow} row - One export row.
 * @param {{ asOfDate: string }} options - As-of date.
 * @returns {import("../../roof-age/estimator.ts").RoofAgePermitEvidence} Evidence for `classifyRoofAgePermit`/`estimateRoofAge`.
 */
export function toRoofAgePermitEvidence(row, { asOfDate }) {
  return describePermitRow(row, { asOfDate }).evidence;
}

/**
 * The full profile view of one export row: what the API, the estimator and
 * the parcel link read. Deploy-time duration math (open_since,
 * open_duration_days) is not computed here.
 *
 * @param {SocrataPermitRow} row - One export row.
 * @param {{ asOfDate: string }} options - As-of date.
 * @returns {object} Profile summary.
 */
export function summarizePermitRow(row, { asOfDate }) {
  const described = describePermitRow(row, { asOfDate });
  const completedDateEvidence = described.completedDateEvidence;
  const statusGroup = classifyStatusGroup({ statusCurrent: row.status_current, completedDateEvidence });
  const roofWorkClass = described.classification.roofWorkClass;
  return {
    permitNumber: described.evidence.sourceRecordId,
    sourceSystem: TRAVIS_PERMIT_SOURCE_SYSTEM,
    statusGroup: statusGroup.statusGroup,
    statusGroupBasis: statusGroup.basis,
    lifecycleStatus: classifyLifecycleStatus(row.status_current),
    roofWorkClass,
    workClassifierVersion: WORK_CLASSIFIER_VERSION,
    isRoofing: ROOFING_WORK_CLASSES.includes(roofWorkClass),
    isReroof: roofWorkClass === "primary_roof_replacement",
    completedDateEvidence,
    tcadIdEvidence: tcadIdEvidence(row.tcad_id),
    versions: {
      statusGroup: STATUS_GROUP_VERSION,
      lifecycle: LIFECYCLE_MAPPING_VERSION,
      workClassifier: WORK_CLASSIFIER_VERSION,
      dateEvidence: DATE_EVIDENCE_VERSION,
      tcadIdNormalization: TCAD_ID_NORMALIZATION_VERSION,
      tcadIdEvidence: TCAD_ID_EVIDENCE_VERSION,
      roofAgeProfile: compiledTravisRoofAgeProfile.version,
      roofAgeProfileSha256: compiledTravisRoofAgeProfile.sha256,
    },
  };
}
