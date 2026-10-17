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
 * @property {string[]} nameColumns - Columns the matcher indexes (printed values, trimmed).
 * @property {((row: Record<string, unknown>) => (string | null)[]) | undefined} [extraMatchNames] - Further texts
 *   derived from the printed name for indexing (versioned with `matchNameVersion`); the printed name is always indexed.
 * @property {string | undefined} [matchNameVersion] - Version of `extraMatchNames`.
 * @property {string[]} distributionColumns - Columns whose value distributions the load reports.
 * @property {(row: Record<string, unknown>) => string} scopeOf - `travis` or `out_of_county`.
 */

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
    keyColumns: null,
    nameColumns: [],
    distributionColumns: [],
    scopeOf: () => "statewide",
  },
  "tsbpe-responsible-master-plumber": {
    key: "tsbpe-responsible-master-plumber",
    kind: "license",
    track: "licensing",
    dataset: "tsbpe-responsible-master-plumber (free licensee list CSV from tsbpe.texas.gov/free-licensee-list/)",
    authority: "Texas State Board of Plumbing Examiners (Responsible Master Plumber, with the last known company)",
    keyColumns: null,
    nameColumns: [],
    distributionColumns: [],
    scopeOf: () => "statewide",
  },
});

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
