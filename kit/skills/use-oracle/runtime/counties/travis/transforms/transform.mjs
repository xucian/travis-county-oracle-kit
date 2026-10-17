/**
 * Travis County (TX) appraisal transform: one materialized parcel input
 * (`travis.parcel-input.v1`, built by the adapter from a seed row that
 * carries the TCAD export columns and the TNR feature) to the kit's
 * per-property output contract (`skills/build-county-transform/reference/output-contract.md`):
 *
 * - the County data group (`property`, `address`, `parcel`, `geometry`, `lot`,
 *   `tax`, `sales_history`, owner `person`/`company` with a mailing address),
 * - the Seed data-group root with `address_has_parcel` only (the County
 *   group's `address.json` to `parcel.json`): the root `elephant-cli transform`
 *   writes itself (`writeSeedGroup`, elephant-cli #251). `property_seed` and
 *   `unnormalized_address` are never written into `data/` (assignment
 *   decisions.md section 22); the adapter keeps them beside `data/` for
 *   internal use only,
 * - every relationship as `{from, to}` relative links,
 * - both data-group roots, named by the schema CIDs of the live manifest the
 *   caller resolved (never hardcoded here).
 *
 * Provenance: every TCAD-derived entity carries the bulk export GET that was
 * actually made; `geometry` carries the TNR page query that returned the
 * feature; `request_identifier` is `PROP_ID` as printed everywhere.
 *
 * Owners (assignment decisions.md section 16): never "as printed". A roll
 * owner string is classified by {@link classifyOwnerName}; a person is split
 * and case-normalized to the lexicon name pattern, a company keeps its
 * official name; the printed string and the `(PROP_ID, printed name)` owner
 * key stay in the lexicon-gap sidecar. `geo_id` has no lexicon home either.
 * Every class schema is `additionalProperties: false` and `elephant-cli
 * validate` (1.58.1) rejects `source_payload` on an entity, so lexicon-gap
 * fields are written to `<workDir>/source-payload.json` beside `data/`, which
 * the internal reconciliation reads and the archive never carries
 * (assignment decisions.md section 5: option (ii) does not survive validate,
 * so (iii) applies).
 *
 * Runs standalone too: `node transform.mjs --work-dir <dir> --manifest <manifest.json>`
 * where `<dir>/input.json` exists.
 *
 * @module counties/travis/transforms/transform
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const TRANSFORM_VERSION = "travis-transform-v3";
export const PARCEL_INPUT_SCHEMA_VERSION = "travis.parcel-input.v1";
export const STATE_CODE = "TX";
export const OWNER_CLASSIFICATION_VERSION = "travis-owner-classification-v2";
export const STATE_CODE_MAPPING_VERSION = "travis-state-code-v1";
/** Lexicon-gap sidecar written beside `data/`, never inside it (the CLI rejects `source_payload` on validated entities). */
export const SOURCE_PAYLOAD_FILENAME = "source-payload.json";

/**
 * Owner-name tokens that mark a company (checked as whole tokens). The v2 additions come from the
 * whole 2026 roll: words that sit almost only in company-classified owner strings (trust forms
 * such as REVOCABLE and LIVING, whose "TRUST" the roll's 30-character owner field often cuts off;
 * districts, schools, churches, associations; truncated forms such as ASSOCIATI), excluding words
 * that are also common given names or surnames in the roll (AUSTIN, CHRISTIAN, PARISH, STREET,
 * NORTH, PLAZA, LOAN ...). Where a word is mostly organizational, company is the safer error: the
 * company keeps the owner string, a wrong person split would invent a name.
 */
export const COMPANY_TOKENS = Object.freeze([
  "LLC", "L.L.C.", "LLLP", "LLP", "PLLC", "INC", "INC.", "CORP", "CORP.", "CORPORATION", "CO", "CO.", "COMPANY",
  "LTD", "LTD.", "LP", "L.P.", "LIMITED", "PARTNERSHIP", "PARTNERS", "TRUST", "TRUSTEE", "TRUSTEES", "TR",
  "BANK", "CHURCH", "MINISTRIES", "ASSOCIATION", "ASSN", "ASSOC", "HOA", "HOLDINGS", "PROPERTIES",
  "INVESTMENTS", "ENTERPRISES", "GROUP", "FUND", "FOUNDATION", "USA", "ISD", "DISTRICT", "AUTHORITY",
  "UNIVERSITY", "HOSPITAL", "REALTY", "VENTURES", "CAPITAL", "DEVELOPMENT", "HOMES", "BUILDERS", "ESTATES",
  "CONDOMINIUMS", "APARTMENTS", "MANAGEMENT", "SERVICES", "SYSTEMS", "NATIONAL", "FEDERAL", "STATE", "CITY", "COUNTY",
  "GOVERNMENT", "UNITED", "ESTATE", "TRST", "TRSTS", "TRSTES", "TRS",
  "INCORPORATED", "TRUSTS", "REVOCABLE", "IRREVOCABLE", "LIVING", "FAMILY", "TESTAMENTARY", "EXEMPT", "GST",
  "OF", "THE", "PUBLIC", "SCHOOL", "SCHOOLS", "COLLEGE", "ACADEMY", "SEMINARY", "MUNICIPAL", "UTILITY", "MUD",
  "COMMUNITY", "NEIGHBORHOOD", "HOMEOWNERS", "OWNERS", "MASTER", "HOUSING", "FINANCE", "EQUITY", "HOMEBUYER",
  "SERIES", "VENTURE", "CONSTRUCTION", "MEDICAL", "COMMERCIAL", "INVESTMENT", "ASSOCIATES", "INDUSTRIES",
  "PRODUCTIONS", "CENTER", "PROPERTY", "CONGREGATION", "FELLOWSHIP", "BAPTIST", "METHODIST", "CATHOLIC",
  "LUTHERAN", "PRESBYTERIAN", "EPISCOPAL", "DIOCESE", "MISSIONARY", "CONSERVANCY", "CEMETERY", "TRANSPORTATION",
  "RAILROAD", "RAILWAY", "AT", "ON", "RESIDENTIAL", "WATER", "SUPPLY", "SECTION", "PHASE", "PATIO", "COMMITTEE", "CLUB",
  "SOCIETY", "INSURANCE", "MORTGAGE", "CREDIT", "AGENCY", "INSTITUTE", "INTERNATIONAL", "COOPERATIVE", "RENTAL",
  "RENTALS", "RETAIL", "OFFICE", "CONDOMINIUM", "TOWNHOUSE", "TOWNHOMES", "COMMUNITIES", "DEVELOPERS", "INVESTORS",
  "HOMEOWNER", "OWNER", "ASSOCIAT", "ASSOCIATI", "ASSOCIATIO", "ASSO", "CORPORA", "CORPORAT", "CORPORATIO",
  "BUILDING", "STATION", "FARMS", "CHAPEL", "JOINT",
]);

/** Spaced entity-form and district abbreviations as the roll prints them (L L C, L P, I S D, M U D, L C R A, W C I D). */
const COMPANY_PATTERNS = Object.freeze([/\bL ?L ?C\b/, /\bL ?L ?P\b/, /\bL ?P$/, /\bI ?S ?D\b/, /\bM ?U ?D\b/, /\bL ?C ?R ?A\b/, /\bW ?C ?I ?D\b/]);

const COMPANY_PHRASES = Object.freeze(["CITY OF", "COUNTY OF", "STATE OF", "ESTATE OF", "UNITED STATES"]);

/**
 * Roll annotations that qualify an owner without naming one (whole words,
 * removed before classification and splitting): et al., et ux., et vir, life
 * estate, the Veterans Land Board marker, and anything after a care-of `%`.
 * The printed string stays in the sidecar.
 */
const OWNER_ANNOTATIONS = Object.freeze([
  /\(LIFE ESTATE\)/g,
  /\bLIFE ESTATE\b/g,
  /\bLIFE EST\b/g,
  /\bET ?AL\b/g,
  /\bET ?UX\b/g,
  /\bET ?VIR\b/g,
  /\(VLB\)/g,
]);

/**
 * Remove the roll's annotations from an owner string: the care-of tail after
 * `%`, the qualifiers above, and a trailing `&`; collapse whitespace.
 *
 * @param {string} printed - Owner string as printed.
 * @returns {string} The owner name without annotations (upper case kept).
 */
export function stripOwnerAnnotations(printed) {
  let name = printed.toUpperCase().split("%")[0];
  for (const pattern of OWNER_ANNOTATIONS) name = name.replace(pattern, " ");
  name = name.replace(/\s+/g, " ").trim();
  name = name.replace(/[\s&,/-]+$/g, "").trim();
  return name;
}

const SUFFIXES = Object.freeze({ JR: "Jr.", "JR.": "Jr.", SR: "Sr.", "SR.": "Sr.", II: "II", III: "III", IV: "IV" });

/**
 * @param {unknown} value - Raw scalar.
 * @returns {string | null} Trimmed non-empty text, else null.
 */
export function text(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * @param {unknown} value - Raw numeric text.
 * @returns {number | null} Finite number, else null.
 */
export function number(value) {
  const trimmed = text(value);
  if (trimmed === null) return null;
  const parsed = Number(trimmed.replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param {unknown} value - Raw integer text.
 * @returns {number | null} Integer, else null.
 */
export function integer(value) {
  const parsed = number(value);
  return parsed === null ? null : Math.trunc(parsed);
}

/**
 * Title-case one name token to the lexicon pattern `^[A-Z][a-z]*([ \-',.][A-Za-z][a-z]*)*$`.
 *
 * @param {string} token - Upper- or mixed-case token.
 * @returns {string} Normalized token (`O'BRIEN` to `O'Brien`, `MARY-ANN` to `Mary-Ann`).
 */
export function toTitleCase(token) {
  return token
    .toLowerCase()
    .replace(/(^|[ \-',.])([a-z])/g, (_match, separator, letter) => `${separator}${letter.toUpperCase()}`);
}

const NAME_TOKEN = /^[A-Z][a-z]*([ \-',.][A-Za-z][a-z]*)*$/;

/**
 * Classify a roll owner string.
 *
 * @param {unknown} printed - `py_owner_name` as printed.
 * @returns {"company" | "person" | "unknown"} Classification.
 */
export function classifyOwnerName(printed) {
  const name = text(printed);
  if (name === null) return "unknown";
  const upper = stripOwnerAnnotations(name);
  if (upper === "") return "unknown";
  if (COMPANY_PHRASES.some((phrase) => upper.includes(phrase))) return "company";
  if (COMPANY_PATTERNS.some((pattern) => pattern.test(upper))) return "company";
  const tokens = upper.split(/[\s,]+/).filter(Boolean);
  if (tokens.some((token) => COMPANY_TOKENS.includes(token))) return "company";
  if (/\d/.test(upper)) return "company";
  return "person";
}

/**
 * Split a TCAD person name (`LAST FIRST MIDDLE`, optionally `& CO-OWNER`)
 * into lexicon person fields. Only the first owner before `&` becomes the
 * entity; the rest stays in `source_payload`.
 *
 * @param {string} printed - Owner string as printed.
 * @returns {{ first_name: string, last_name: string, middle_name: string | null, suffix_name: string | null } | null} Fields, or null when the string cannot be split into a valid person.
 */
export function splitPersonName(printed) {
  const primary = stripOwnerAnnotations(printed).split("&")[0].trim();
  const rawTokens = primary.split(/\s+/).filter(Boolean);
  let suffix = null;
  const tokens = [];
  for (const token of rawTokens) {
    const upper = token.toUpperCase();
    if (SUFFIXES[upper]) suffix = SUFFIXES[upper];
    else tokens.push(token);
  }
  if (tokens.length < 2) return null;
  const last = toTitleCase(tokens[0]);
  const first = toTitleCase(tokens[1]);
  const middle = tokens.length > 2 ? toTitleCase(tokens.slice(2).join(" ")) : null;
  if (!NAME_TOKEN.test(last) || !NAME_TOKEN.test(first)) return null;
  if (middle !== null && !/^[A-Z][a-zA-Z\s\-',.]*$/.test(middle)) return null;
  return { first_name: first, last_name: last, middle_name: middle, suffix_name: suffix };
}

/**
 * TCAD state codes (STATE_CD.TXT of the 2026 certified export, descriptions
 * quoted) to lexicon `property_type` and `property_usage_type`. A null
 * `propertyType` means "by improvement value": `Building` when improved,
 * else `LandParcel`. A null usage means the code does not determine one; the
 * raw code stays in the sidecar. Version: {@link STATE_CODE_MAPPING_VERSION}.
 */
export const TCAD_STATE_CODE_MAPPING = Object.freeze({
  A1: { description: "SINGLE FAMILY RESIDENCE", propertyType: "SingleFamily", usageType: "Residential" },
  A2: { description: "SINGLE FAMILY RESIDENCE MH", propertyType: "ManufacturedHome", usageType: "Residential" },
  A3: { description: "SINGLE FAMILY RESIDENCE DETAILS", propertyType: "MiscellaneousResidential", usageType: "Residential" },
  A4: { description: "CONDOS", propertyType: "Condominium", usageType: "Residential" },
  A5: { description: "CONDOS DETAILS", propertyType: "Condominium", usageType: "Residential" },
  A9: { description: "HS COMMERCIAL HIGHEST & BEST USE", propertyType: "SingleFamily", usageType: "Residential" },
  B1: { description: "MULTIFAMILY", propertyType: "MultipleFamily", usageType: "Residential" },
  B2: { description: "DUPLEX", propertyType: "Duplex", usageType: "Residential" },
  B3: { description: "TRI-PLEX", propertyType: "3Units", usageType: "Residential" },
  B4: { description: "FOUR-PLEX", propertyType: "4Units", usageType: "Residential" },
  B5: { description: "MULTIFAMILY WITH HS", propertyType: "MultipleFamily", usageType: "Residential" },
  C1: { description: "VACANT LOT", propertyType: "VacantLand", usageType: null },
  C2: { description: "COLONIA PROPERTY", propertyType: "VacantLand", usageType: null },
  D1: { description: "ACREAGE (AG) 1-D / 1-D-1", propertyType: "LandParcel", usageType: "Agricultural" },
  D2: { description: "IMPR DETAIL ON D1 LAND", propertyType: "Building", usageType: "Agricultural" },
  D3: { description: "AG 1-D", propertyType: "LandParcel", usageType: "Agricultural" },
  E1: { description: "FARM AND RANCH IMPR ON NON-AG LAND", propertyType: null, usageType: null },
  E2: { description: "FARM AND RANCH IMPR MH ON NON-AG LAND", propertyType: "ManufacturedHome", usageType: null },
  E3: { description: "FARM AND RANCH IMPR MISC ON NON-AG LAND", propertyType: null, usageType: null },
  F1: { description: "COMMERCIAL IMPROVED", propertyType: "Building", usageType: "Commercial" },
  F2: { description: "INDUSTRIAL MAJOR MANUFACTURING IMPROVED", propertyType: "Building", usageType: "Industrial" },
  F3: { description: "COMMERCIAL DETAILS", propertyType: null, usageType: "Commercial" },
  F4: { description: "COMMERCIAL CONDO", propertyType: "Unit", usageType: "Commercial" },
  F5: { description: "COMMERCIAL RES CONVERSION", propertyType: "Building", usageType: "Commercial" },
  J1: { description: "UTILITY (WATER)", propertyType: null, usageType: "Utility" },
  J2: { description: "UTILITY (GAS)", propertyType: null, usageType: "Utility" },
  J3: { description: "UTILITY (ELECTRIC)", propertyType: null, usageType: "Utility" },
  J4: { description: "UTILITY (TELEPHONE)", propertyType: null, usageType: "TelecommunicationsFacility" },
  J5: { description: "UTILITY (RAILROADS)", propertyType: null, usageType: "Railroad" },
  J6: { description: "UTILITY (PIPELINES)", propertyType: null, usageType: "Utility" },
  J7: { description: "UTILITY (CABLE)", propertyType: null, usageType: "Utility" },
  J8: { description: "UTILITY (OTHER)", propertyType: null, usageType: "Utility" },
  M1: { description: "TANGIBLE PERSONAL PROP MH", propertyType: "ManufacturedHome", usageType: "Residential" },
  O1: { description: "RESIDENTIAL INVENTORY", propertyType: null, usageType: "Residential" },
  S1: { description: "SPECIAL INVENTORY", propertyType: null, usageType: null },
  X: { description: "TOTALLY EXEMPT PROPERTY", propertyType: null, usageType: null },
});

/**
 * @param {string | null} stateCd - TCAD state code (imprv_state_cd, else land_state_cd).
 * @param {number | null} improvementValue - Improvement value, when printed.
 * @returns {{ propertyType: string, usageType: string | null, buildStatus: string | null, mapped: boolean, description: string | null }} Lexicon classification.
 */
export function mapStateCode(stateCd, improvementValue) {
  const code = (stateCd ?? "").toUpperCase();
  const entry = TCAD_STATE_CODE_MAPPING[code] ?? null;
  const improved = improvementValue !== null && improvementValue > 0;
  const buildStatus = code.startsWith("C") ? "VacantLand" : improved ? "Improved" : improvementValue === null ? null : "VacantLand";
  const byImprovement = improved ? "Building" : "LandParcel";
  if (!entry) return { propertyType: byImprovement, usageType: null, buildStatus, mapped: false, description: null };
  return { propertyType: entry.propertyType ?? byImprovement, usageType: entry.usageType, buildStatus, mapped: true, description: entry.description };
}

/**
 * @param {unknown} value - Deed date as printed: `MM-DD-YYYY` (the Legacy 8.0.33 export), `MM/DD/YYYY`, or `YYYY-MM-DD`.
 * @returns {string | null} `YYYY-MM-DD` for a real calendar date, else null.
 */
export function parseDeedDate(value) {
  const raw = text(value);
  if (raw === null) return null;
  let iso = null;
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  const usMatch = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(raw);
  if (isoMatch) iso = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  else if (usMatch) iso = `${usMatch[3]}-${usMatch[1].padStart(2, "0")}-${usMatch[2].padStart(2, "0")}`;
  if (!iso) return null;
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || year < 1800) return null;
  return iso;
}

/**
 * Resolve the data-group schema CIDs from a live manifest object (or the
 * `{entries}` wrapper the replay fixture stores).
 *
 * @param {Record<string, unknown>} manifest - `https://lexicon.elephant.xyz/api/manifest` body.
 * @returns {{ countyCid: string, seedCid: string }} The two root names.
 */
export function resolveDataGroupCids(manifest) {
  const entries = /** @type {Record<string, { ipfsCid?: string, type?: string }>} */ (
    manifest && typeof manifest === "object" && "entries" in manifest ? manifest.entries : manifest
  );
  const county = entries?.County?.ipfsCid;
  const seed = entries?.Seed?.ipfsCid;
  if (typeof county !== "string" || typeof seed !== "string") {
    throw new Error("lexicon manifest must carry County and Seed data-group entries");
  }
  return { countyCid: county, seedCid: seed };
}

/**
 * @param {string} name - Target file name.
 * @returns {{ "/": string }} Relative link.
 */
const link = (name) => ({ "/": `./${name}` });

/**
 * @param {object} request - `{method, url, multiValueQueryString}` as recorded in the seed.
 * @returns {object} Lexicon `source_http_request` (query-free `url`, query in `multiValueQueryString`).
 */
function sourceHttpRequest(request) {
  const method = text(request?.method) ?? "GET";
  const url = text(request?.url);
  if (url === null) throw new Error("input.request.url is required (the bulk GET actually made)");
  const query = request?.multiValueQueryString;
  const result = { method, url };
  if (query && typeof query === "object" && Object.keys(query).length > 0) result.multiValueQueryString = query;
  return result;
}

/**
 * Build every output file for one parcel.
 *
 * @param {object} input - `travis.parcel-input.v1` object.
 * @param {{ manifest: Record<string, unknown> }} options - Live manifest (or fixture snapshot wrapper).
 * @returns {{ files: Record<string, object>, warnings: string[], roots: { countyCid: string, seedCid: string }, sourcePayload: object }} Files keyed by basename plus the lexicon-gap sidecar (not part of `data/`).
 */
export function buildTravisOutput(input, { manifest }) {
  if (input?.schemaVersion !== PARCEL_INPUT_SCHEMA_VERSION) {
    throw new Error(`unsupported parcel input schema: ${String(input?.schemaVersion)}`);
  }
  const propId = text(input.propId);
  if (propId === null || !/^\d{1,12}$/.test(propId)) throw new Error(`input.propId must be the printed PROP_ID, got ${String(input.propId)}`);
  const tcad = input.tcad ?? {};
  const geoId = text(input.geoId ?? tcad.geo_id);
  const roots = resolveDataGroupCids(manifest);
  const request = sourceHttpRequest(input.request);
  const envelope = { source_http_request: request, request_identifier: propId };
  const warnings = [];
  /** @type {Record<string, object>} */
  const files = {};
  /** @type {Record<string, object | object[]>} */
  const countyRelationships = {};
  const addRelationship = (key, name, from, to, many) => {
    files[name] = { from: link(from), to: link(to) };
    if (many) {
      const list = /** @type {object[]} */ (countyRelationships[key] ?? []);
      list.push(link(name));
      countyRelationships[key] = list;
    } else {
      countyRelationships[key] = link(name);
    }
  };

  if (text(tcad.situs_street) === null) {
    throw new Error("no situs address: the roll prints no situs street for this account");
  }

  // --- property -------------------------------------------------------------
  const improvementValue =
    number(tcad.imprv_hstd_val) === null && number(tcad.imprv_non_hstd_val) === null
      ? null
      : (number(tcad.imprv_hstd_val) ?? 0) + (number(tcad.imprv_non_hstd_val) ?? 0);
  const landValue =
    number(tcad.land_hstd_val) === null && number(tcad.land_non_hstd_val) === null
      ? null
      : (number(tcad.land_hstd_val) ?? 0) + (number(tcad.land_non_hstd_val) ?? 0);
  const stateCd = text(tcad.state_cd);
  const classification = mapStateCode(stateCd, improvementValue);
  if (!classification.mapped) warnings.push(`unmapped state_cd ${String(stateCd)}; property_type fell back to ${classification.propertyType}, usage null`);
  const legal = [text(tcad.legal_desc), text(tcad.legal_desc2)].filter(Boolean).join(" ");
  const builtYear = integer(tcad.yr_built);
  const livingArea = number(tcad.living_area_sqft);
  // A zero legal acreage means the roll prints none (platted lots); it is never a lot of 0 square feet.
  const acreage = number(tcad.legal_acreage) !== null && number(tcad.legal_acreage) > 0 ? number(tcad.legal_acreage) : null;
  const lotSqft = acreage === null ? null : Math.round(acreage * 43560);
  const ownerConfidential = text(tcad.owner_confidential) === "T";
  const printedOwner = ownerConfidential ? null : text(tcad.py_owner_name);
  const ownerClass = ownerConfidential ? "confidential" : classifyOwnerName(printedOwner);

  /** Lexicon-gap fields: never written into a validated entity (the CLI rejects `source_payload`); kept beside the archive. */
  const sourcePayload = {
    schemaVersion: "travis.source-payload.v1",
    transform_version: TRANSFORM_VERSION,
    prop_id: propId,
    geo_id: geoId,
    state_cd: stateCd,
    prop_type_cd: text(tcad.prop_type_cd),
    state_code_mapping_version: STATE_CODE_MAPPING_VERSION,
    state_cd_description: classification.description,
    imprv_state_cd: text(tcad.imprv_state_cd),
    land_state_cd: text(tcad.land_state_cd),
    hood_cd: text(tcad.hood_cd),
    abs_subdv_cd: text(tcad.abs_subdv_cd),
    situs_city: text(input.situs?.city),
    appraised_val: number(tcad.appraised_val),
    legal_acreage: number(tcad.legal_acreage),
    deed_book_id: text(tcad.deed_book_id),
    deed_book_page: text(tcad.deed_book_page),
    imprv_count: integer(tcad.imprv_count),
    owner: {
      classification_version: OWNER_CLASSIFICATION_VERSION,
      printed_name: printedOwner,
      name_without_annotations: printedOwner === null ? null : stripOwnerAnnotations(printedOwner),
      classification: ownerClass,
      owner_key: printedOwner === null ? null : `${propId}:${printedOwner}`,
    },
    source_snapshot: input.snapshot ?? null,
  };

  files["property.json"] = {
    parcel_identifier: propId,
    property_type: classification.propertyType,
    property_usage_type: classification.usageType,
    build_status: classification.buildStatus,
    property_structure_built_year: builtYear !== null && builtYear > 1700 ? builtYear : null,
    property_effective_built_year: null,
    property_legal_description_text: legal || null,
    subdivision: text(tcad.abs_subdv_desc),
    // The lexicon pattern needs two or more digits; a living area under 10 sqft is not a living area.
    livable_floor_area: livingArea !== null && livingArea >= 10 ? String(Math.round(livingArea)) : null,
    area_under_air: null,
    // total_area is building area; the roll gives living area only, so it stays null (never the lot area).
    total_area: null,
    number_of_units: null,
    number_of_units_type: null,
    structure_form: null,
    ownership_estate_type: null,
    historic_designation: false,
    zoning: null,
    ...envelope,
  };

  // --- address (unnormalized branch; county_name omitted: the live enum lacks Travis) ---
  const situs = input.situs ?? {};
  const centroid = input.geometry && Number.isFinite(Number(input.geometry.latitude)) && Number.isFinite(Number(input.geometry.longitude))
    ? { latitude: Number(input.geometry.latitude), longitude: Number(input.geometry.longitude) }
    : null;
  const zip = text(situs.zip);
  files["address.json"] = {
    unnormalized_address: text(situs.address),
    city_name: text(situs.city) ? String(situs.city).toUpperCase().replace(/[^A-Z\s\-']/g, "") || null : null,
    state_code: STATE_CODE,
    postal_code: zip && /^\d{5}/.test(zip) ? zip.slice(0, 5) : null,
    country_code: "US",
    block: text(tcad.block),
    lot: text(tcad.tract_or_lot),
    latitude: centroid?.latitude ?? null,
    longitude: centroid?.longitude ?? null,
    ...envelope,
  };
  addRelationship("property_has_address", "relationship_property_has_address.json", "property.json", "address.json", false);

  // --- parcel ---------------------------------------------------------------
  files["parcel.json"] = { parcel_identifier: propId, ...envelope };
  addRelationship("property_has_parcel", "relationship_property_has_parcel.json", "property.json", "parcel.json", true);

  // --- geometry (TNR feature, its own request) --------------------------------
  if (centroid && input.geometry?.request) {
    const polygon = Array.isArray(input.geometry.polygon?.coordinates?.[0])
      ? input.geometry.polygon.coordinates[0]
          .filter((vertex) => Array.isArray(vertex) && Number.isFinite(vertex[0]) && Number.isFinite(vertex[1]))
          .map((vertex) => ({ latitude: vertex[1], longitude: vertex[0] }))
      : [];
    files["geometry.json"] = {
      latitude: centroid.latitude,
      longitude: centroid.longitude,
      ...(polygon.length >= 3 ? { polygon } : {}),
      source_http_request: sourceHttpRequest(input.geometry.request),
      request_identifier: propId,
    };
    addRelationship("parcel_has_geometry", "relationship_parcel_has_geometry.json", "parcel.json", "geometry.json", true);
    addRelationship("address_has_geometry", "relationship_address_has_geometry.json", "address.json", "geometry.json", false);
  } else {
    warnings.push("no TNR geometry for this parcel; geometry.json omitted");
  }

  // --- lot --------------------------------------------------------------------
  if (lotSqft !== null) {
    files["lot.json"] = {
      lot_type: lotSqft > 10890 ? "GreaterThanOneQuarterAcre" : "LessThanOrEqualToOneQuarterAcre",
      lot_length_feet: null,
      lot_width_feet: null,
      lot_area_sqft: lotSqft,
      lot_size_acre: acreage,
      landscaping_features: null,
      view: null,
      fencing_type: null,
      fence_height: null,
      fence_length: null,
      driveway_material: null,
      driveway_condition: null,
      lot_condition_issues: null,
      ...envelope,
    };
    addRelationship("property_has_lot", "relationship_property_has_lot.json", "property.json", "lot.json", false);
  }

  // --- tax ----------------------------------------------------------------------
  const taxYear = integer(tcad.tax_year);
  const market = number(tcad.market_value);
  const assessed = number(tcad.assessed_val);
  const appraised = number(tcad.appraised_val);
  if (taxYear !== null && (market !== null || assessed !== null || appraised !== null)) {
    const taxName = `tax_${taxYear}.json`;
    // The roll prints market, appraised and assessed values per account. Taxable values are per
    // taxing entity (PROP_ENT.TXT, not read in v1), so `property_taxable_value_amount` is omitted
    // rather than proxied from the assessed value. Non-nullable amounts the roll does not print are
    // omitted; nullable ones are written as null.
    const assessedAmount = assessed ?? appraised;
    const agricultural = number(tcad.ag_use_val);
    files[taxName] = {
      tax_year: taxYear,
      ...(market !== null ? { property_market_value_amount: market } : {}),
      ...(assessedAmount !== null ? { property_assessed_value_amount: assessedAmount } : {}),
      property_building_amount: improvementValue,
      property_land_amount: landValue,
      ...(agricultural !== null && agricultural > 0 ? { agricultural_valuation_amount: agricultural } : {}),
      monthly_tax_amount: null,
      yearly_tax_amount: null,
      period_start_date: null,
      period_end_date: null,
      first_year_on_tax_roll: null,
      first_year_building_on_tax_roll: null,
      ...envelope,
    };
    addRelationship("property_has_tax", `relationship_property_has_${taxName.replace(".json", "")}.json`, "property.json", taxName, true);
  }

  // --- owner: person or company, mailing address, link through the deed when dated ---
  const deedDate = parseDeedDate(tcad.deed_dt);
  if (text(tcad.deed_dt) && deedDate === null) warnings.push(`deed_dt ${String(tcad.deed_dt)} is not a calendar date; sales_history omitted`);
  let ownerFile = null;
  let ownerKind = null;
  if (ownerClass === "company") {
    ownerFile = "company_1.json";
    ownerKind = "company";
    // `company.name` has no lexicon pattern: the owner string without the roll's annotations, upper case kept.
    files[ownerFile] = { name: stripOwnerAnnotations(printedOwner), sunbiz_document_number: null, ...envelope };
  } else if (ownerClass === "person") {
    const person = splitPersonName(printedOwner);
    if (person) {
      ownerFile = "person_1.json";
      ownerKind = "person";
      files[ownerFile] = {
        first_name: person.first_name,
        last_name: person.last_name,
        middle_name: person.middle_name,
        prefix_name: null,
        suffix_name: person.suffix_name,
        birth_date: null,
        us_citizenship_status: null,
        veteran_status: null,
        ...envelope,
      };
    } else {
      warnings.push(`owner ${JSON.stringify(printedOwner)} could not be split into a person; kept in source_payload only`);
    }
  }
  if (ownerFile) {
    const mailing = [tcad.py_addr_line1, tcad.py_addr_line2, tcad.py_addr_line3]
      .map(text)
      .filter(Boolean)
      .join(" ");
    const mailingLocality = [text(tcad.py_addr_city), text(tcad.py_addr_state), text(tcad.py_addr_zip)].filter(Boolean).join(" ");
    const mailingFull = [mailing, mailingLocality].filter(Boolean).join(", ");
    if (mailingFull) {
      files["mailing_address.json"] = {
        unnormalized_address: mailingFull,
        city_name: text(tcad.py_addr_city) ? String(tcad.py_addr_city).toUpperCase().replace(/[^A-Z\s\-']/g, "") || null : null,
        state_code: text(tcad.py_addr_state) && /^[A-Za-z]{2}$/.test(String(tcad.py_addr_state).trim()) ? String(tcad.py_addr_state).trim().toUpperCase() : null,
        postal_code: text(tcad.py_addr_zip) && /^\d{5}/.test(String(tcad.py_addr_zip).trim()) ? String(tcad.py_addr_zip).trim().slice(0, 5) : null,
        latitude: null,
        longitude: null,
        ...envelope,
      };
      addRelationship(
        `${ownerKind}_has_mailing_address`,
        `relationship_${ownerKind}_1_has_mailing_address.json`,
        ownerFile,
        "mailing_address.json",
        true,
      );
    }
    if (deedDate) {
      addRelationship(`sales_history_has_${ownerKind}`, `relationship_sales_history_1_has_${ownerKind}_1.json`, "sales_history_1.json", ownerFile, true);
    } else {
      addRelationship(`${ownerKind}_has_property`, `relationship_${ownerKind}_1_has_property.json`, ownerFile, "property.json", true);
    }
  }
  if (deedDate) {
    // The deed date is a fact about the property whether or not an owner entity is written
    // (a confidential or unsplittable owner keeps the transfer date, without the owner link).
    files["sales_history_1.json"] = { ownership_transfer_date: deedDate, ...envelope };
    addRelationship("property_has_sales_history", "relationship_property_has_sales_history_1.json", "property.json", "sales_history_1.json", true);
  }
  if (ownerConfidential) warnings.push("owner flagged confidential by the roll; no owner entity or mailing address written");

  // --- Seed data group: address_has_parcel only, as `elephant-cli transform` writes it (#251) ---
  // No property_seed or unnormalized_address in data/: the live county enum lacks Travis, and the
  // CLI's export-tables refuses the Seed group's property_seed key (decisions.md section 22).
  files["relationship_address_has_parcel.json"] = { from: link("address.json"), to: link("parcel.json") };
  files[`${roots.seedCid}.json`] = {
    label: "Seed",
    relationships: { address_has_parcel: link("relationship_address_has_parcel.json") },
  };
  files[`${roots.countyCid}.json`] = { label: "County", relationships: countyRelationships };

  return { files, warnings, roots, sourcePayload };
}

/**
 * Write one parcel's output under `<workDir>/data/`.
 *
 * @param {{ workDir: string, input: object, manifest: Record<string, unknown> }} options - Working directory, parcel input and manifest.
 * @returns {Promise<{ dataDir: string, files: string[], warnings: string[], roots: { countyCid: string, seedCid: string }, sourcePayloadPath: string }>} Written files and the sidecar path.
 */
export async function writeTravisTransform({ workDir, input, manifest }) {
  const { files, warnings, roots, sourcePayload } = buildTravisOutput(input, { manifest });
  const dataDir = path.join(workDir, "data");
  await mkdir(dataDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(dataDir, name), `${JSON.stringify(body, null, 2)}\n`, "utf8");
  }
  const sourcePayloadPath = path.join(workDir, SOURCE_PAYLOAD_FILENAME);
  await writeFile(sourcePayloadPath, `${JSON.stringify(sourcePayload, null, 2)}\n`, "utf8");
  return { dataDir, files: Object.keys(files).sort(), warnings, roots, sourcePayloadPath };
}

async function main(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith("--") || argv[index + 1] === undefined) throw new Error(`usage: --work-dir <dir> --manifest <file>`);
    flags[argv[index].slice(2)] = argv[index + 1];
  }
  const workDir = path.resolve(flags["work-dir"]);
  const input = JSON.parse(await readFile(path.join(workDir, "input.json"), "utf8"));
  const manifest = JSON.parse(await readFile(path.resolve(flags.manifest), "utf8"));
  const result = await writeTravisTransform({ workDir, input, manifest });
  console.log(JSON.stringify({ event: "travis_transform_complete", ...result }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
