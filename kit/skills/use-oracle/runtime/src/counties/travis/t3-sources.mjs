/**
 * T3 official identity sources for Travis County (assignment decisions.md section 23; profile in
 * `docs/travis-sources.yaml` `official_identity`). One entry per business or licensing source: its dataset id, the
 * loader track, the entity key and name columns the matcher uses, and whether its host needs US egress.
 *
 * Source keys and dataset ids are plain strings (the API contract keeps source vocabularies open).
 *
 * @module counties/travis/t3-sources
 */

/** Hosts that reject non-US clients; every request to them is preceded by an egress check. */
export const US_EGRESS_HOSTS = Object.freeze(["data.texas.gov", "tdlr.texas.gov", "tsbpe.texas.gov", "sos.state.tx.us", "comptroller.texas.gov"]);

/** Comptroller county code of Travis (the taxpayer's mailing-address county in 9cir-efmm). */
export const TRAVIS_COMPTROLLER_COUNTY_CODE = "227";

/**
 * @param {string} url - Request URL.
 * @returns {boolean} Whether the host is (a subdomain of) a US-egress-only host.
 */
export function requiresUsEgress(url) {
  const host = new URL(url).hostname.toLowerCase();
  return US_EGRESS_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * @typedef {object} T3Source
 * @property {string} key - Source key (snapshot and watermark name).
 * @property {"business" | "license"} kind - Business record or license record.
 * @property {"registry" | "licensing"} track - Loader track.
 * @property {string} dataset - Dataset label used in run records and `unpublished_source.dataset`.
 * @property {string} authority - Publishing authority.
 * @property {string[] | null} keyColumns - Entity key columns (trimmed values joined); null diffs by row hash only.
 * @property {string[] | undefined} [nullableKeyColumns] - Key columns whose blank value is part of the key (the empty
 *   string) instead of leaving the row without a key.
 * @property {string[]} nameColumns - Columns the matcher indexes (printed values, trimmed).
 * @property {((row: Record<string, unknown>) => (string | null)[]) | undefined} [extraMatchNames] - Further texts
 *   derived from the printed name for indexing (versioned with `matchNameVersion`); the printed name is always indexed.
 * @property {string | undefined} [matchNameVersion] - Version of `extraMatchNames`.
 * @property {string[]} distributionColumns - Columns whose value distributions the load reports.
 * @property {(row: Record<string, unknown>) => string} scopeOf - `travis` or `out_of_county`.
 * @property {"rfc4180" | "unescaped-quotes" | undefined} [csvDialect] - CSV dialect of the source's files (default
 *   `rfc4180`, strict); `unescaped-quotes` for writers that do not escape quotes inside quoted values.
 * @property {PrivacyRule | undefined} [privacy] - Values withheld from every derived store (snapshot, index, deploy).
 * @property {ColumnSet[] | "derive" | undefined} [columnSets] - How printed headers map to snapshot field names: absent,
 *   the printed names are the fields (Socrata API field names); a list, a file's header must equal one set's printed
 *   names exactly (else the load stops) and the fields are {@link snapshotFieldName} of them; `derive`, any header is
 *   accepted and mapped the same way, recorded under a version named by the header's digest.
 * @property {((fields: string[], printed: string[]) => ResolvedColumns) | undefined} [resolveColumns] - Key, name and
 *   scope columns of a source whose header is only known at load time (it throws when they cannot be found).
 * @property {string[] | undefined} [personalContactColumns] - Personal contact fields of individual licensees: kept in
 *   the private snapshot as printed, never served (api-contract.md LicenseRecord).
 */

/**
 * @typedef {object} ColumnSet
 * @property {string} version - Column set version.
 * @property {string[]} printed - Header names exactly as printed, in order.
 */

/**
 * @typedef {object} ResolvedColumns
 * @property {string[]} keyColumns - Entity key fields.
 * @property {string[]} nameColumns - Name fields (trimmed) the matcher indexes.
 * @property {((row: Record<string, unknown>) => (string | null)[]) | undefined} [extraMatchNames] - Derived names.
 * @property {string | undefined} [matchNameVersion] - Version of `extraMatchNames`.
 * @property {(row: Record<string, unknown>) => string} scopeOf - Scope of a row.
 * @property {Record<string, string | null>} roles - Which field plays which role (recorded in the load report).
 */

/**
 * Snapshot field name of a printed header: lower case, every run of characters other than a-z and 0-9 one underscore,
 * none at either end; a name that would start with a digit gets the prefix `c_`.
 *
 * @param {string} printed - Header as printed.
 * @returns {string} Field name.
 */
export function snapshotFieldName(printed) {
  const name = String(printed)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (name === "") throw new Error(`header ${JSON.stringify(printed)} has no letters or digits`);
  return /^[0-9]/.test(name) ? `c_${name}` : name;
}

/** The 23 columns every TDLR license file printed on 2026-10-17 (all 16 electrical and A/C files). */
export const TDLR_LICFILE_COLUMNS_V1 = Object.freeze([
  "LICENSE TYPE",
  "LICENSE NUMBER",
  "LICENSE EXPIRATION DATE",
  "COUNTY",
  "NAME",
  "MAILING ADDRESS LINE1",
  "MAILING ADDRESS LINE2",
  "MAILING ADDRESS CITY, STATE ZIP",
  "PHONE NUMBER",
  "BUSINESS NAME",
  "BUSINESS ADDRESS-LINE1",
  "BUSINESS ADDRESS-LINE2",
  "BUSINESS CITY, STATE ZIP",
  "BUSINESS COUNTY CODE",
  "BUSINESS COUNTY",
  "BUSINESS ZIP",
  "BUSINESS PHONE",
  "LICENSE SUBTYPE",
  "CONTINUING EDUCATION FLAG",
  "Same Address or not",
  "Business Address that mentions BOX",
  "Mailing address that mentions BOX",
  "Phone-same or not",
]);

/** Version of {@link tdlrPermitRole}. */
export const TDLR_PERMIT_ROLE_VERSION = "tdlr-permit-role.v1";

/**
 * What a printed TDLR license type can do for a permit (`tdlr-permit-role.v1`): `contractor` licenses a business or
 * person to contract the trade's work, so it can back a permit's listed contractor (electrical permits: an electrical
 * or electrical sign contractor; mechanical permits: an A/C contractor; appliance installation: its contractor);
 * `qualifying_individual` is the master whose license qualifies an electrical contractor (it backs the contractor's
 * license, not a permit by itself); `works_under_a_contractor` (journeymen, apprentices, technicians, wiremen,
 * installers) cannot back a permit contractor; `not_a_trade_license` (continuing-education providers). The mapping is
 * read from the license-type names TDLR prints and the trades' roles; no roofing type exists (Texas issues no roofing
 * license). An unknown type is `unclassified`.
 */
export const TDLR_PERMIT_ROLES = Object.freeze({
  "Electrical Contractor": "contractor",
  "Electrical Sign Contractor": "contractor",
  "A/C Contractor": "contractor",
  "Appliance Installation Contractor": "contractor",
  "Master Electrician": "qualifying_individual",
  "Master Sign Electrician": "qualifying_individual",
  "Journeyman Electrician": "works_under_a_contractor",
  "Journeyman Sign Electrician": "works_under_a_contractor",
  "Journeyman Industrial Electrician": "works_under_a_contractor",
  "Journeyman Lineman Electrician": "works_under_a_contractor",
  "Apprentice Electrician": "works_under_a_contractor",
  "Apprentice Sign Electrician": "works_under_a_contractor",
  "Maintenance Electrician": "works_under_a_contractor",
  "Residential Wireman": "works_under_a_contractor",
  "Appliance Installer": "works_under_a_contractor",
  "A/C Technician": "works_under_a_contractor",
  "A/C CE Provider": "not_a_trade_license",
  "Electrician CE Provider": "not_a_trade_license",
});

/**
 * @param {unknown} licenseType - Printed license type (trimmed).
 * @returns {string} Its permit role under {@link TDLR_PERMIT_ROLE_VERSION}.
 */
export function tdlrPermitRole(licenseType) {
  return TDLR_PERMIT_ROLES[String(licenseType ?? "")] ?? "unclassified";
}

/**
 * Column roles of a TSBPE licensee list, whose header is first seen when the capture lands. The license number field
 * must be exactly one; the licensee is one full-name field or first and last name fields; the company field is
 * optional. Anything else stops the load with the printed header, so a mapping can be added instead of guessed.
 *
 * @param {string[]} fields - Snapshot field names.
 * @param {string[]} printed - Header as printed.
 * @returns {ResolvedColumns} Roles.
 */
export function resolveTsbpeColumns(fields, printed) {
  const one = (pattern, role, optional = false) => {
    const found = fields.filter((field) => pattern.test(field));
    if (found.length === 1) return found[0];
    if (found.length === 0 && optional) return null;
    throw new Error(`TSBPE header: ${found.length === 0 ? "no" : "several"} ${role} column${found.length > 1 ? `s (${found.join(", ")})` : ""}; printed header ${JSON.stringify(printed)}; add its column roles to t3-sources.mjs`);
  };
  const license = one(/^(license|lic)(_(number|no|num|nbr))?$|^(license|lic)_?(number|no|num|nbr)$/, "license number");
  const fullName = fields.filter((field) => /^(full_)?name$|^licensee(_name)?$|^name_of_licensee$|^(plumber|rmp)(_name)?$/.test(field));
  const first = fields.find((field) => /^first(_name)?$/.test(field)) ?? null;
  const last = fields.find((field) => /^last(_name)?$/.test(field)) ?? null;
  const middle = fields.find((field) => /^(middle|mi)(_name|_initial)?$/.test(field)) ?? null;
  if (fullName.length > 1) throw new Error(`TSBPE header: several name columns (${fullName.join(", ")}); printed header ${JSON.stringify(printed)}`);
  if (fullName.length === 0 && !(first && last)) throw new Error(`TSBPE header: no licensee name column; printed header ${JSON.stringify(printed)}; add its column roles to t3-sources.mjs`);
  const company = one(/company|business|employer|firm/, "company", true);
  const county = fields.find((field) => /county/.test(field)) ?? null;
  const nameColumns = [...(fullName.length === 1 ? [`${fullName[0]}__trimmed`] : []), ...(company ? [`${company}__trimmed`] : [])];
  return {
    keyColumns: [license],
    nameColumns,
    ...(fullName.length === 0
      ? {
          extraMatchNames: (row) => [[row[`${first}__trimmed`], middle ? row[`${middle}__trimmed`] : null, row[`${last}__trimmed`]].filter((part) => typeof part === "string" && part !== "").join(" ") || null],
          matchNameVersion: "tsbpe-first-middle-last.v1",
        }
      : {}),
    scopeOf: (row) => (county && String(row[`${county}__trimmed`] ?? "").toUpperCase() === "TRAVIS" ? "travis" : county ? "out_of_county" : "statewide"),
    roles: { license_number: license, holder_name: fullName[0] ?? null, first_name: fullName.length === 0 ? first : null, middle_name: fullName.length === 0 ? middle : null, last_name: fullName.length === 0 ? last : null, company, county },
  };
}

/**
 * @typedef {object} PrivacyRule
 * @property {string} version - Rule version (recorded in the snapshot metadata and the load report).
 * @property {(row: Record<string, unknown>) => string | null} classOf - Privacy class of a row (null: nothing withheld).
 * @property {string[]} withheldColumns - Source columns emptied for a classed row (printed and trimmed values).
 * @property {string[]} recordKeyColumns - The printed key of a classed row (withheld parts included): the message of
 *   its keyed `business_record_id` (record-ids.mjs, decisions.md section 24.2).
 */

/** Version of the privacy rules below. */
export const PRIVACY_VERSION = "travis-t3-privacy.v1";

/**
 * Comptroller organization types whose taxpayer number could derive from a Social Security number: only a natural
 * person has one, and the sole owner (`IS`) is the only natural-person type the sales-tax permit file prints (9,471 of
 * the 49,025 Travis outlets of 2026-10-17; no `IS` name carries an entity word). Partnerships, estates and trusts get an
 * employer number or a Comptroller-assigned number. The rule withholds the number of every `IS` row whatever its form:
 * a row's first digit is not proof of how its number was assigned.
 */
export const INDIVIDUAL_OWNER_TYPES = Object.freeze(["IS"]);

/**
 * Privacy class of a sales-tax row (`travis-t3-privacy.v1`).
 *
 * @param {Record<string, unknown>} row - Normalized row (trimmed values under `<column>__trimmed`).
 * @returns {"individual_owner" | null} `individual_owner` when the taxpayer is a sole owner.
 */
export function salesTaxPrivacyClass(row) {
  return INDIVIDUAL_OWNER_TYPES.includes(String(row.taxpayer_organization_type__trimmed ?? "")) ? "individual_owner" : null;
}

/** @param {Record<string, unknown>} row @returns {string} */
const comptrollerScope = (row) => (row.taxpayer_county_code__trimmed === TRAVIS_COMPTROLLER_COUNTY_CODE ? "travis" : "out_of_county");

/** @type {Readonly<Record<string, T3Source>>} */
export const T3_SOURCES = Object.freeze({
  "tx-comptroller-franchise-tax": {
    key: "tx-comptroller-franchise-tax",
    kind: "business",
    track: "registry",
    dataset: "tx-comptroller-franchise-tax/9cir-efmm",
    authority: "Texas Comptroller of Public Accounts (Active Franchise Taxpayers; the SOS file number is the registry key, the SOS is the authority of record)",
    keyColumns: ["taxpayer_number"],
    nameColumns: ["taxpayer_name__trimmed"],
    distributionColumns: [
      "taxpayer_county_code",
      "taxpayer_state",
      "taxpayer_organizational_type",
      "record_type_code",
      "sos_status_code",
      "right_to_transact_business_code",
      "current_exempt_reason_code",
    ],
    scopeOf: comptrollerScope,
  },
  "tx-comptroller-sales-tax": {
    key: "tx-comptroller-sales-tax",
    kind: "business",
    track: "registry",
    dataset: "tx-comptroller-sales-tax/jrea-zgmq",
    authority: "Texas Comptroller of Public Accounts (Active Sales Tax Permit Holders, Travis outlets)",
    keyColumns: ["taxpayer_number", "outlet_number"],
    nameColumns: ["taxpayer_name__trimmed", "outlet_name__trimmed"],
    distributionColumns: ["outlet_county_code", "taxpayer_organization_type", "outlet_inside_outside_city_limits_indicator", "outlet_state"],
    scopeOf: (row) => (row.outlet_county_code__trimmed === TRAVIS_COMPTROLLER_COUNTY_CODE ? "travis" : "out_of_county"),
    // assignment decisions.md section 23: no SSN-derived taxpayer number is stored in a derived store or served.
    privacy: { version: PRIVACY_VERSION, classOf: salesTaxPrivacyClass, withheldColumns: ["taxpayer_number"], recordKeyColumns: ["taxpayer_number", "outlet_number"] },
  },
  "tx-sos-veteran-owned-business": {
    key: "tx-sos-veteran-owned-business",
    kind: "business",
    track: "registry",
    dataset: "tx-sos-veteran-owned-business/2vfr-72e4",
    authority: "Texas Secretary of State (Veteran Owned Business)",
    keyColumns: ["filing_number"],
    nameColumns: ["name__trimmed"],
    distributionColumns: ["corp_type", "status_description", "entity_state"],
    scopeOf: () => "statewide",
  },
  "austin-row-contractor-licenses": {
    key: "austin-row-contractor-licenses",
    kind: "license",
    track: "licensing",
    dataset: "austin-row-contractor-licenses/8d92-wsiw",
    authority: "City of Austin Transportation and Public Works (Active Right of Way Contractor License Holders)",
    keyColumns: ["license_number"],
    nameColumns: ["contractor_name__trimmed"],
    extraMatchNames: (row) => [austinRowCompanyName(row.contractor_name__trimmed)],
    matchNameVersion: "austin-row-company-name.v1",
    distributionColumns: [],
    scopeOf: () => "travis",
  },
  "tdlr-license-files": {
    key: "tdlr-license-files",
    kind: "license",
    track: "licensing",
    dataset: "tdlr-license-files (daily CSV files from tdlr.texas.gov/LicenseSearch/licfile.asp; data.texas.gov copy 7358-krk7)",
    authority: "Texas Department of Licensing and Regulation (electrical and air conditioning/refrigeration licenses)",
    // (type, subtype, number), ruled by the operator on 2026-10-17 (assignment decisions.md section 24.3): 121 A/C
    // technician numbers are printed twice, once registered (REG), once certified (CER); a blank subtype is part of the key.
    keyColumns: ["license_type", "license_subtype", "license_number"],
    nullableKeyColumns: ["license_subtype"],
    nameColumns: ["name__trimmed", "business_name__trimmed"],
    distributionColumns: ["license_type", "license_subtype", "business_county", "continuing_education_flag"],
    scopeOf: (row) => (String(row.business_county__trimmed ?? "").toUpperCase() === "TRAVIS" ? "travis" : "out_of_county"),
    // TDLR wraps values in quotes without escaping the quotes inside them (3 of the 16 files of 2026-10-17).
    csvDialect: "unescaped-quotes",
    columnSets: [{ version: "tdlr-licfile-columns.v1", printed: [...TDLR_LICFILE_COLUMNS_V1] }],
    personalContactColumns: ["mailing_address_line1", "mailing_address_line2", "mailing_address_city_state_zip", "phone_number"],
  },
  "tsbpe-responsible-master-plumber": {
    key: "tsbpe-responsible-master-plumber",
    kind: "license",
    track: "licensing",
    dataset: "tsbpe-responsible-master-plumber (free licensee list CSV from tsbpe.texas.gov/free-licensee-list/)",
    authority: "Texas State Board of Plumbing Examiners (Responsible Master Plumber, with the last known company)",
    // Resolved from the header when the capture lands (resolveTsbpeColumns); never captured as a CSV before.
    keyColumns: null,
    nameColumns: [],
    distributionColumns: [],
    scopeOf: () => "statewide",
    csvDialect: "unescaped-quotes",
    columnSets: "derive",
    resolveColumns: resolveTsbpeColumns,
  },
});

/** Version of {@link businessDetailUrl}. */
export const DETAIL_URL_VERSION = "travis-comptroller-detail-url.v1";

/** The Comptroller's franchise tax account status page, by taxpayer number (probed under US egress on 2026-10-17). */
export const COMPTROLLER_FRANCHISE_DETAIL_PREFIX = "https://comptroller.texas.gov/taxes/franchise/account-status/search/";

/**
 * `BusinessRecord.detail_url` (api-contract.md): the per-taxpayer franchise account status page for a franchise-tax row
 * with an 11-digit taxpayer number; null for every other source (the page is the franchise account status, and was
 * probed for a franchise taxpayer only) and whenever the number is withheld. The window probe of 2026-10-17 answered
 * HTTP 200 without a redirect with a page generated for that taxpayer; the page renders the record in the browser from
 * `https://comptroller.texas.gov/data-search/franchise-tax/<taxpayer_number>`, which was not requested, so the URL is a
 * link for a person to follow, never provenance: no `source_http_request` or `unpublished_source` names it, and the
 * row's provenance stays its bulk page request.
 *
 * @param {string} sourceKey - Source key of the row.
 * @param {Record<string, unknown>} row - Snapshot row (trimmed values under `<column>__trimmed`).
 * @returns {string | null} The detail URL, or null.
 */
export function businessDetailUrl(sourceKey, row) {
  if (sourceKey !== "tx-comptroller-franchise-tax") return null;
  const number = row.taxpayer_number__trimmed;
  return typeof number === "string" && /^\d{11}$/.test(number) ? `${COMPTROLLER_FRANCHISE_DETAIL_PREFIX}${number}` : null;
}

/** Version of {@link sosFileNumberJoinKey}. */
export const SOS_JOIN_VERSION = "travis-sos-file-number-join.v1";

/**
 * The SOS file number as a join key between the Comptroller franchise file and the SOS veteran-owned file. The
 * franchise file prints it zero-padded to 10 digits (all 3,245,622 printed values of 2026-10-17), the veteran file
 * without the padding, as 9 digits (all 27,205); the printed values never compare equal. The key is the printed digits
 * left-padded with zeros to 10: the same number, the padding restored, nothing else changed. Anything but 1 to 10 digits
 * has no key. Ruled by the operator on 2026-10-17 to be the exact SOS file number of section 23 (assignment
 * decisions.md section 24.1).
 *
 * @param {unknown} printed - SOS file number or filing number as printed (trimmed).
 * @returns {string | null} The 10-digit key, or null.
 */
export function sosFileNumberJoinKey(printed) {
  if (typeof printed !== "string") return null;
  const digits = printed.trim();
  return /^\d{1,10}$/.test(digits) ? digits.padStart(10, "0") : null;
}

/**
 * The company part of an Austin right-of-way `contractor_name`: the city prints staff annotations before some names
 * (`**2026/10/06 TAS**Kent Companies Texas, LLC`) and an agent's name in parentheses after others
 * (`Texas Dirt Partners(Hudson Alderman)`). Both are removed; the printed value stays as printed in the snapshot.
 *
 * @param {unknown} printed - `contractor_name` as printed (trimmed).
 * @returns {string | null} The company name, or null when nothing differs from the printed value.
 */
export function austinRowCompanyName(printed) {
  if (typeof printed !== "string") return null;
  const company = printed
    .replace(/^\s*\*\*[^*]*\*\*\s*/, "")
    .replace(/\s*\([^()]*\)\s*$/, "")
    .trim();
  return company === "" || company === printed.trim() ? null : company;
}

/**
 * Every text the matcher indexes for a row: the printed name columns, then the source's derived names.
 *
 * @param {T3Source} source - Source definition.
 * @param {Record<string, unknown>} row - Snapshot row.
 * @returns {string[]} Non-empty texts, printed first.
 */
export function matchNamesOf(source, row) {
  const printed = source.nameColumns.map((column) => row[column]);
  const derived = source.extraMatchNames ? source.extraMatchNames(row) : [];
  return [...printed, ...derived].filter((value) => typeof value === "string" && value.trim() !== "").map((value) => String(value));
}

/**
 * @param {string} key - Source key.
 * @returns {T3Source} The source definition.
 */
export function getT3Source(key) {
  const source = T3_SOURCES[key];
  if (!source) throw new Error(`unknown T3 source ${key}; known: ${Object.keys(T3_SOURCES).join(", ")}`);
  return source;
}
