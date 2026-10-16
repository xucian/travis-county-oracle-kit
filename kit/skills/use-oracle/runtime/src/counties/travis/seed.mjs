/**
 * Travis County (TX) seed-row construction from already-joined TCAD appraisal
 * export rows and Travis County TNR parcel-layer features.
 *
 * Bulk-first (assignment decisions.md section 3): the TCAD export rows and the
 * TNR features are the captured sources, so every seed row carries the bulk
 * GET that actually fetched the export (`method`, `url`,
 * `multiValueQueryString`), the TNR page query that actually returned the
 * feature, and the retained export columns as `source_<field>` columns. The
 * adapter materializes one per-parcel input from the row without any further
 * network call.
 *
 * The county-wide download, layout resolution, TNR paging and pilot selection
 * live in `build-seed.mjs` (run only inside the US egress window). This module
 * is pure: no network, no filesystem beyond writing the CSV it is asked to
 * write.
 *
 * @module counties/travis/seed
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderCsv } from "../../core/csv.mjs";

export const COUNTY_KEY = "travis";
export const COUNTY_NAME = "Travis";
export const COUNTY_FIPS = "48453";
export const STATE_CODE = "TX";

export const TCAD_PUBLIC_INFORMATION_URL = "https://traviscad.org/publicinformation";
/** TNR "TCAD Parcels" layer. A MapServer layer: the FeatureServer extension is not enabled on this service (verified 2026-10-16). */
export const TNR_PARCEL_LAYER_URL =
  "https://gis.traviscountytx.gov/server1/rest/services/Boundaries_and_Jurisdictions/TCAD_public/MapServer/0";
export const TNR_PARCEL_LAYER_QUERY_URL = `${TNR_PARCEL_LAYER_URL}/query`;

/** Seed-level bounding box (slightly wider than the validation box in `validate.mjs`). */
export const TRAVIS_SEED_BBOX = Object.freeze({
  minLat: 29.95,
  maxLat: 30.75,
  minLng: -98.25,
  maxLng: -97.3,
});

/**
 * Canonical names of the TCAD export fields a seed row retains, spelled as the
 * PACS Legacy 8.0.33 layout spells them (`docs/travis-county-findings.md`
 * section 0). `state_cd` is derived (`imprv_state_cd`, else `land_state_cd`),
 * `tax_year` is `prop_val_yr`, `yr_built`, `living_area_sqft` and `imprv_count`
 * come from `IMP_DET.TXT`, `abs_subdv_desc` from `ABS_SUBD.TXT`, and
 * `owner_confidential` is `T` when the roll flags the owner confidential or
 * address-suppressed (the owner name and mailing address are then blank).
 *
 * @type {readonly string[]}
 */
export const TCAD_SOURCE_FIELDS = Object.freeze([
  "prop_id",
  "geo_id",
  "prop_type_cd",
  "state_cd",
  "imprv_state_cd",
  "land_state_cd",
  "py_owner_name",
  "py_addr_line1",
  "py_addr_line2",
  "py_addr_line3",
  "py_addr_city",
  "py_addr_state",
  "py_addr_zip",
  "owner_confidential",
  "situs_num",
  "situs_street_prefx",
  "situs_street",
  "situs_street_suffix",
  "situs_unit",
  "situs_city",
  "situs_zip",
  "legal_desc",
  "legal_desc2",
  "legal_acreage",
  "hood_cd",
  "abs_subdv_cd",
  "abs_subdv_desc",
  "block",
  "tract_or_lot",
  "land_hstd_val",
  "land_non_hstd_val",
  "imprv_hstd_val",
  "imprv_non_hstd_val",
  "ag_use_val",
  "appraised_val",
  "assessed_val",
  "market_value",
  "deed_book_id",
  "deed_book_page",
  "deed_dt",
  "yr_built",
  "imprv_count",
  "living_area_sqft",
  "tax_year",
]);

/** Columns the export must provide for a usable seed row. */
export const REQUIRED_TCAD_FIELDS = Object.freeze(["prop_id", "geo_id"]);

/** Column names that must never enter a seed (the export is not expected to carry any). */
const EXCLUDED_FIELD_PATTERN = /phone|email|ssn|birth|dob|password/i;

/**
 * Stable CSV column order for a Travis seed row.
 *
 * @type {readonly string[]}
 */
export const SEED_COLUMNS = Object.freeze([
  "parcel_id",
  "source_identifier",
  "geo_id",
  "method",
  "url",
  "multiValueQueryString",
  "address",
  "city",
  "state",
  "zip",
  "county",
  "county_fips",
  "latitude",
  "longitude",
  "parcel_polygon",
  "source_url",
  "source_item_id",
  "source_revision",
  "source_snapshot_at",
  "tnr_url",
  "tnr_multiValueQueryString",
  "tnr_object_id",
  "tnr_snapshot_at",
  "source_record_count",
  "source_object_ids",
  "source_features_json",
  ...TCAD_SOURCE_FIELDS.map((field) => `source_${field}`),
]);

const PROP_ID_PATTERN = /^[1-9]\d{0,11}$/;
const GEO_ID_PATTERN = /^\d{10}$/;

/**
 * @param {unknown} value - Raw scalar.
 * @returns {string} Trimmed text, or empty string.
 */
export function toText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/**
 * @param {unknown} value - Candidate `PROP_ID`.
 * @returns {boolean} True for a decoded PROP_ID: a positive decimal integer of up to 12 digits, no padding.
 */
export function isValidPropId(value) {
  return PROP_ID_PATTERN.test(toText(value));
}

/**
 * Decode the export's `prop_id` field (`int(12)`, fixed width, zero padded:
 * `000000379828`) to the identifier TCAD's property search and the TNR layer
 * print (`379828`). The padding is the integer field's encoding, not part of
 * the identifier. Returns null for anything that is not an int(12) value.
 *
 * @param {unknown} raw - The field as read from the record.
 * @returns {string | null} Decoded PROP_ID, or null.
 */
export function decodePropId(raw) {
  const text = toText(raw);
  if (!/^\d{1,12}$/.test(text)) return null;
  const decoded = text.replace(/^0+/, "");
  return decoded === "" ? null : decoded;
}

/**
 * @param {unknown} value - Candidate `geo_id`.
 * @returns {boolean} True for exactly 10 digits.
 */
export function isValidGeoId(value) {
  return GEO_ID_PATTERN.test(toText(value));
}

/**
 * Fail closed if a source-field list smuggles in a contact/PII column or a duplicate.
 *
 * @param {readonly string[]} sourceFields - Candidate field names.
 * @returns {void}
 */
export function assertSafeSourceFields(sourceFields) {
  const seen = new Set();
  for (const field of sourceFields) {
    if (EXCLUDED_FIELD_PATTERN.test(field)) {
      throw new Error(`Field is prohibited in the seed source request: ${field}`);
    }
    const normalized = field.toLowerCase();
    if (seen.has(normalized)) throw new Error(`Duplicate source field: ${field}`);
    seen.add(normalized);
  }
}

/**
 * @param {unknown} value - Raw scalar or object.
 * @returns {string} Text form (JSON for objects/arrays).
 */
function sourceValueToText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * Build the situs address line the roll prints, skipping empty parts.
 *
 * @param {Record<string, unknown>} tcad - Canonical TCAD fields.
 * @returns {{ street: string, city: string, zip: string, full: string }} Address parts.
 */
export function buildSitusAddress(tcad) {
  const street = [tcad.situs_num, tcad.situs_street_prefx, tcad.situs_street, tcad.situs_street_suffix, tcad.situs_unit]
    .map(toText)
    .filter((part) => part.length > 0)
    .join(" ");
  const city = toText(tcad.situs_city).toUpperCase();
  const zip = toText(tcad.situs_zip).slice(0, 5);
  const locality = [city, STATE_CODE, zip].filter((part) => part.length > 0).join(" ");
  const full = [street, locality].filter((part) => part.length > 0).join(", ");
  return { street, city, zip, full };
}

/**
 * @param {unknown} geometry - GeoJSON `Polygon`/`MultiPolygon` (WGS84, `[lon, lat]` vertices).
 * @returns {number[][][]} Every polygon part's outer ring.
 */
function outerRings(geometry) {
  if (!geometry || typeof geometry !== "object") return [];
  const geo = /** @type {{ type?: string, coordinates?: unknown }} */ (geometry);
  if (geo.type === "Polygon" && Array.isArray(geo.coordinates)) return [geo.coordinates[0]].filter(Array.isArray);
  if (geo.type === "MultiPolygon" && Array.isArray(geo.coordinates)) {
    return geo.coordinates.map((part) => (Array.isArray(part) ? part[0] : null)).filter(Array.isArray);
  }
  return [];
}

/**
 * Area-weighted centroid of a GeoJSON polygon (outer rings only), falling
 * back to the vertex mean for degenerate rings.
 *
 * @param {unknown} geometry - GeoJSON `Polygon`/`MultiPolygon` in WGS84.
 * @returns {{ latitude: number, longitude: number } | null} Centroid, or null without usable vertices.
 */
export function polygonCentroid(geometry) {
  let weightedLon = 0;
  let weightedLat = 0;
  let totalArea = 0;
  let sumLon = 0;
  let sumLat = 0;
  let vertexCount = 0;
  for (const ring of outerRings(geometry)) {
    const vertices = ring.filter((vertex) => Array.isArray(vertex) && Number.isFinite(vertex[0]) && Number.isFinite(vertex[1]));
    if (vertices.length === 0) continue;
    let area = 0;
    let cx = 0;
    let cy = 0;
    for (let index = 0; index < vertices.length; index += 1) {
      const [x1, y1] = vertices[index];
      const [x2, y2] = vertices[(index + 1) % vertices.length];
      const cross = x1 * y2 - x2 * y1;
      area += cross;
      cx += (x1 + x2) * cross;
      cy += (y1 + y2) * cross;
      sumLon += x1;
      sumLat += y1;
      vertexCount += 1;
    }
    area /= 2;
    if (Math.abs(area) > 1e-12) {
      weightedLon += cx / (6 * area) * Math.abs(area);
      weightedLat += cy / (6 * area) * Math.abs(area);
      totalArea += Math.abs(area);
    }
  }
  if (totalArea > 0) {
    return { latitude: weightedLat / totalArea, longitude: weightedLon / totalArea };
  }
  if (vertexCount > 0) return { latitude: sumLat / vertexCount, longitude: sumLon / vertexCount };
  return null;
}

/**
 * @param {readonly unknown[]} geometries - GeoJSON geometries for one PROP_ID.
 * @returns {object | null} One `Polygon`/`MultiPolygon`, or null.
 */
export function mergeGeometries(geometries) {
  const parts = [];
  for (const geometry of geometries) {
    const geo = /** @type {{ type?: string, coordinates?: unknown }} */ (geometry ?? {});
    if (geo.type === "Polygon" && Array.isArray(geo.coordinates)) parts.push(geo.coordinates);
    if (geo.type === "MultiPolygon" && Array.isArray(geo.coordinates)) parts.push(...geo.coordinates);
  }
  if (parts.length === 0) return null;
  if (parts.length === 1) return { type: "Polygon", coordinates: parts[0] };
  return { type: "MultiPolygon", coordinates: parts };
}

/**
 * @typedef {object} TravisSeedInput
 * @property {Record<string, unknown>} tcad - Canonical TCAD fields (see {@link TCAD_SOURCE_FIELDS}).
 * @property {{ method: string, url: string, multiValueQueryString?: Record<string, string[]> }} request - The bulk export GET actually made.
 * @property {{ sourceItemId: string, sourceRevision: string, snapshotAt: string }} snapshot - Export file name, digest and download time.
 * @property {{ geometry: unknown, objectId?: unknown, request: { method: string, url: string, multiValueQueryString?: Record<string, string[]> }, snapshotAt: string } | null} [tnr] - Joined TNR feature(s) and the page query that returned them.
 * @property {number} [sourceRecordCount] - TNR features folded into this row.
 * @property {string} [sourceObjectIds] - `|`-joined TNR object ids.
 * @property {string} [sourceFeaturesJson] - JSON array of the folded TNR attribute rows when more than one.
 */

/**
 * Build one Travis seed row.
 *
 * @param {TravisSeedInput} input - Joined parcel data plus provenance.
 * @returns {Record<string, string>} CSV row keyed by {@link SEED_COLUMNS}.
 */
export function toSeedRow(input) {
  const tcad = input.tcad;
  const propId = toText(tcad.prop_id);
  if (!isValidPropId(propId)) throw new Error(`Not a printed TCAD PROP_ID: ${JSON.stringify(propId)}`);
  const situs = buildSitusAddress(tcad);
  const geometry = input.tnr?.geometry ?? null;
  const centroid = geometry ? polygonCentroid(geometry) : null;
  /** @type {Record<string, string>} */
  const row = {
    parcel_id: propId,
    source_identifier: propId,
    geo_id: toText(tcad.geo_id),
    method: toText(input.request.method) || "GET",
    url: input.request.url,
    multiValueQueryString: JSON.stringify(input.request.multiValueQueryString ?? {}),
    address: situs.full,
    city: situs.city,
    state: STATE_CODE,
    zip: situs.zip,
    county: COUNTY_NAME,
    county_fips: COUNTY_FIPS,
    latitude: centroid ? String(centroid.latitude) : "",
    longitude: centroid ? String(centroid.longitude) : "",
    parcel_polygon: geometry ? JSON.stringify(geometry) : "",
    source_url: TCAD_PUBLIC_INFORMATION_URL,
    source_item_id: input.snapshot.sourceItemId,
    source_revision: input.snapshot.sourceRevision,
    source_snapshot_at: input.snapshot.snapshotAt,
    tnr_url: input.tnr ? input.tnr.request.url : "",
    tnr_multiValueQueryString: input.tnr ? JSON.stringify(input.tnr.request.multiValueQueryString ?? {}) : "",
    tnr_object_id: input.tnr ? toText(input.tnr.objectId) : "",
    tnr_snapshot_at: input.tnr ? input.tnr.snapshotAt : "",
    source_record_count: String(input.sourceRecordCount ?? (input.tnr ? 1 : 0)),
    source_object_ids: input.sourceObjectIds ?? "",
    source_features_json: input.sourceFeaturesJson ?? "",
  };
  for (const field of TCAD_SOURCE_FIELDS) {
    row[`source_${field}`] = sourceValueToText(tcad[field]);
  }
  return row;
}

/**
 * @param {unknown} stateCd - TCAD state/property class code (A1, B2, C1, F1 ...).
 * @returns {string} Coarse band for pilot stratification.
 */
export function classifyStateCodeBand(stateCd) {
  const code = toText(stateCd).toUpperCase();
  if (code === "") return "unknown";
  if (code === "A1") return "single_family";
  if (code === "A2") return "mobile_home";
  if (code === "A3") return "condo";
  if (code.startsWith("A")) return "residential_other";
  if (code.startsWith("B")) return "multi_family";
  if (code.startsWith("C")) return "vacant";
  if (code.startsWith("D")) return "agricultural";
  if (code.startsWith("E")) return "rural_residence";
  if (code === "F1") return "commercial";
  if (code === "F2") return "industrial";
  if (code.startsWith("F")) return "commercial_other";
  if (code.startsWith("J")) return "utility";
  if (code.startsWith("X")) return "exempt";
  return "other";
}

/**
 * @param {Record<string, string>} row - Seed row.
 * @returns {boolean} Whether the centroid falls inside the seed bbox.
 */
export function hasInRangeGeometry(row) {
  const latitude = Number(row.latitude);
  const longitude = Number(row.longitude);
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= TRAVIS_SEED_BBOX.minLat &&
    latitude <= TRAVIS_SEED_BBOX.maxLat &&
    longitude >= TRAVIS_SEED_BBOX.minLng &&
    longitude <= TRAVIS_SEED_BBOX.maxLng
  );
}

/**
 * Deterministic, stratified pilot selection: round-robin over the state-code
 * bands, alternating rows with and without geometry and (when supplied) with
 * and without known permits, ordered inside each stratum by a sha256 of the
 * PROP_ID so the choice never depends on roll order.
 *
 * @param {readonly Record<string, string>[]} rows - Full seed rows.
 * @param {{ size?: number, permitGeoIds?: Set<string> }} [options] - Pilot size and the `geo_id`s that carry permits.
 * @returns {Record<string, string>[]} The selected rows in selection order.
 */
export function selectPilotRows(rows, { size = 25, permitGeoIds = new Set() } = {}) {
  /** @type {Map<string, Record<string, string>[]>} */
  const strata = new Map();
  for (const row of rows) {
    const key = [
      classifyStateCodeBand(row.source_state_cd),
      hasInRangeGeometry(row) ? "geometry" : "no_geometry",
      permitGeoIds.has(row.geo_id) ? "permits" : "no_permits",
    ].join("/");
    const bucket = strata.get(key) ?? [];
    bucket.push(row);
    strata.set(key, bucket);
  }
  const rank = (row) => createHash("sha256").update(`travis-pilot:${row.parcel_id}`).digest("hex");
  const ordered = [...strata.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, bucket]) => bucket.sort((left, right) => rank(left).localeCompare(rank(right))));
  const selected = [];
  let exhausted = false;
  for (let round = 0; !exhausted && selected.length < size; round += 1) {
    exhausted = true;
    for (const bucket of ordered) {
      if (round < bucket.length) {
        exhausted = false;
        if (selected.length < size) selected.push(bucket[round]);
      }
    }
  }
  return selected;
}

/**
 * @typedef {object} SeedReconciliationStats
 * @property {number} rowsWritten - Seed rows written (one per real-property account).
 * @property {number} uniquePropIds - Distinct PROP_IDs among the written rows.
 * @property {number} rollRows - Real-property (prop_type_cd R) records read.
 * @property {number} invalidPropIds - R records whose prop_id did not decode.
 * @property {number} [foldedOwnerRecords] - Additional owner records of an account already written.
 * @property {number} gisFeatures - TNR features carrying a PROP_ID.
 * @property {number} gisJoined - Of those, features whose PROP_ID is a written row.
 * @property {number} gisUnjoined - The rest.
 */

/**
 * Fail closed if a full-seed build's counters do not reconcile:
 * `rollRows = rowsWritten + invalidPropIds + foldedOwnerRecords` and
 * `gisFeatures = gisJoined + gisUnjoined`.
 *
 * @param {SeedReconciliationStats} stats - Seed-build counters.
 * @returns {void}
 */
export function assertSeedReconciliation(stats) {
  if (stats.rowsWritten !== stats.uniquePropIds) {
    throw new Error(`rowsWritten ${stats.rowsWritten} != uniquePropIds ${stats.uniquePropIds}`);
  }
  const folded = stats.foldedOwnerRecords ?? 0;
  if (stats.rollRows !== stats.rowsWritten + stats.invalidPropIds + folded) {
    throw new Error(
      `rollRows ${stats.rollRows} != rowsWritten ${stats.rowsWritten} + invalidPropIds ${stats.invalidPropIds} + foldedOwnerRecords ${folded}`,
    );
  }
  if (stats.gisFeatures !== stats.gisJoined + stats.gisUnjoined) {
    throw new Error(`gisFeatures ${stats.gisFeatures} != gisJoined ${stats.gisJoined} + gisUnjoined ${stats.gisUnjoined}`);
  }
}

/**
 * Render seed rows to CSV (and write them when `outputPath` is given).
 *
 * @param {object} options - Seed inputs.
 * @param {readonly TravisSeedInput[]} options.records - Already-joined records, one per PROP_ID.
 * @param {string} [options.outputPath] - When set, the CSV is written here.
 * @returns {Promise<{ rows: Record<string, string>[], csv: string, outputPath: string | null }>} Rows, CSV text and the path written.
 */
export async function buildSeed(options) {
  assertSafeSourceFields(TCAD_SOURCE_FIELDS);
  const rows = options.records.map((record) => toSeedRow(record));
  const ids = rows.map((row) => row.parcel_id);
  if (new Set(ids).size !== ids.length) throw new Error("Seed records contain duplicate PROP_ID values");
  const csv = renderCsv(SEED_COLUMNS, rows);
  if (options.outputPath) {
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, csv, "utf8");
  }
  return { rows, csv, outputPath: options.outputPath ?? null };
}
