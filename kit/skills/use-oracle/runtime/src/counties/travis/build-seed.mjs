#!/usr/bin/env node
/**
 * Travis County seed-producing script. **Runs only inside the US egress
 * window** (`county-seed-data`; readiness must be PASS first). It was written
 * and unit-tested offline on 2026-10-16 and has not been run against the live
 * sources; the first live run records the resolved column map, the counts and
 * every request in `<output-dir>/seed-manifest.json`.
 *
 * Inputs:
 *   --export-dir <dir>      the unpacked TCAD Certified Appraisal Export (delimited text files)
 *   --export-url <url>      the exact URL the export archive was downloaded from (recorded as the bulk GET)
 *   --export-archive <zip>  the archive as downloaded (digested as source_revision)
 *   --layout <file>         the Export Layout file (used to confirm column names; the script reads
 *                           the header row of each delimited file and resolves canonical fields
 *                           through TCAD_COLUMN_CANDIDATES; a required field that resolves nowhere aborts)
 *   --tnr-cache <dir>       where paged TNR responses are written (one JSON per page plus a receipt)
 *   --fetch-tnr             page the TNR parcel layer now (egress must be US; otherwise reads the cache)
 *   --output <csv>          full seed CSV (gitignored data/seeds/travis.csv)
 *   --pilot-output <csv>    pilot seed CSV (about 25 rows, stratified)
 *   --pilot-size <n>        default 25
 *   --permit-geo-ids <file> optional newline list of geo_ids that carry Austin permits (pilot stratification)
 *
 * Nothing here touches a geo-restricted host before `assertUsEgress` passes.
 *
 * @module counties/travis/build-seed
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseCsvRecords, renderCsv } from "../../core/csv.mjs";
import { assertUsEgress } from "./adapter.mjs";
import { proveDigitsOnlyNormalization } from "./permit-profile.mjs";
import {
  REQUIRED_TCAD_FIELDS,
  SEED_COLUMNS,
  TCAD_SOURCE_FIELDS,
  TNR_PARCEL_LAYER_QUERY_URL,
  assertSeedReconciliation,
  isValidPropId,
  mergeGeometries,
  selectPilotRows,
  toSeedRow,
  toText,
} from "./seed.mjs";

/**
 * Candidate raw column names (case-insensitive) for each canonical field,
 * following the PACS appraisal-export convention. The resolved map is
 * recorded in the seed manifest; nothing is guessed silently.
 */
export const TCAD_COLUMN_CANDIDATES = Object.freeze({
  prop_id: ["prop_id", "property_id", "prop id"],
  geo_id: ["geo_id", "geographic_id", "geo id"],
  prop_type_cd: ["prop_type_cd", "prop_type", "property_type_cd"],
  state_cd: ["state_cd", "state_code", "ptd_cd", "sptb_cd"],
  py_owner_name: ["py_owner_name", "owner_name", "file_as_name"],
  py_addr_line1: ["py_addr_line1", "owner_addr_line1", "addr_line1"],
  py_addr_line2: ["py_addr_line2", "owner_addr_line2", "addr_line2"],
  py_addr_line3: ["py_addr_line3", "owner_addr_line3", "addr_line3"],
  py_addr_city: ["py_addr_city", "owner_city", "addr_city"],
  py_addr_state: ["py_addr_state", "owner_state", "addr_state"],
  py_addr_zip: ["py_addr_zip", "owner_zip", "addr_zip"],
  situs_num: ["situs_num", "situs_number"],
  situs_street_prefx: ["situs_street_prefx", "situs_street_prefix"],
  situs_street: ["situs_street", "situs_street_name"],
  situs_street_sufix: ["situs_street_sufix", "situs_street_suffix"],
  situs_unit: ["situs_unit"],
  situs_city: ["situs_city"],
  situs_zip: ["situs_zip"],
  legal_desc: ["legal_desc", "legal_description"],
  legal_desc_2: ["legal_desc_2", "legal_description_2"],
  legal_acreage: ["legal_acreage", "acreage"],
  hood_cd: ["hood_cd", "neighborhood_cd", "nbhd_cd"],
  abs_subdv_cd: ["abs_subdv_cd", "abs_subdv"],
  abs_subdv_desc: ["abs_subdv_desc", "subdivision"],
  land_hstd_val: ["land_hstd_val"],
  land_non_hstd_val: ["land_non_hstd_val"],
  imprv_hstd_val: ["imprv_hstd_val"],
  imprv_non_hstd_val: ["imprv_non_hstd_val"],
  ag_use_val: ["ag_use_val", "ag_val"],
  appraised_val: ["appraised_val"],
  assessed_val: ["assessed_val"],
  market_value: ["market_value", "market"],
  deed_type: ["deed_type", "deed_type_cd"],
  deed_dt: ["deed_dt", "deed_date"],
  deed_book_id: ["deed_book_id", "deed_book"],
  deed_book_page: ["deed_book_page", "deed_page"],
  yr_built: ["yr_built", "year_built", "yr_blt"],
  imprv_count: ["imprv_count"],
  living_area_sqft: ["living_area", "main_area", "living_area_sqft", "tot_living_area"],
  tax_year: ["tax_year", "prop_val_yr", "year"],
});

/**
 * Resolve the canonical field map from a header row.
 *
 * @param {readonly string[]} header - Raw column names.
 * @returns {{ map: Record<string, string>, missing: string[] }} Resolved raw name per canonical field, and unresolved fields.
 */
export function resolveColumnMap(header) {
  const byLower = new Map(header.map((name) => [name.trim().toLowerCase(), name]));
  const map = {};
  const missing = [];
  for (const field of TCAD_SOURCE_FIELDS) {
    const candidates = TCAD_COLUMN_CANDIDATES[field] ?? [field];
    const hit = candidates.map((candidate) => byLower.get(candidate.toLowerCase())).find(Boolean);
    if (hit) map[field] = hit;
    else missing.push(field);
  }
  const missingRequired = REQUIRED_TCAD_FIELDS.filter((field) => missing.includes(field));
  if (missingRequired.length > 0) {
    throw new Error(`Export layout does not provide required columns: ${missingRequired.join(", ")} (header: ${header.join(", ")})`);
  }
  return { map, missing };
}

/**
 * @param {Record<string, string>} raw - One export row keyed by raw column name.
 * @param {Record<string, string>} map - Resolved column map.
 * @returns {Record<string, string>} Canonical TCAD fields.
 */
export function toCanonicalTcadRow(raw, map) {
  const canonical = {};
  for (const [field, column] of Object.entries(map)) canonical[field] = toText(raw[column]);
  return canonical;
}

/**
 * Join improvement-detail rows (year built, living area, count) onto property rows.
 *
 * @param {readonly Record<string, string>[]} improvements - Canonical improvement rows with `prop_id`, `yr_built`, `living_area_sqft`.
 * @returns {Map<string, { yr_built: string, living_area_sqft: string, imprv_count: string }>} Per PROP_ID: earliest year built, summed living area, count.
 */
export function summarizeImprovements(improvements) {
  const byProp = new Map();
  for (const row of improvements) {
    const propId = toText(row.prop_id);
    if (!propId) continue;
    const entry = byProp.get(propId) ?? { years: [], area: 0, count: 0 };
    const year = Number(row.yr_built);
    if (Number.isInteger(year) && year > 1700) entry.years.push(year);
    const area = Number(row.living_area_sqft);
    if (Number.isFinite(area) && area > 0) entry.area += area;
    entry.count += 1;
    byProp.set(propId, entry);
  }
  return new Map(
    [...byProp.entries()].map(([propId, entry]) => [
      propId,
      {
        yr_built: entry.years.length ? String(Math.min(...entry.years)) : "",
        living_area_sqft: entry.area > 0 ? String(entry.area) : "",
        imprv_count: String(entry.count),
      },
    ]),
  );
}

/**
 * Page the TNR parcel layer (GeoJSON, WGS84), writing every response and a
 * receipt per page. Requires US egress; never retries a 403.
 *
 * @param {{ cacheDir: string, pageSize?: number, fetchImpl?: typeof fetch, snapshotAt?: string }} options - Cache directory and seams.
 * @returns {Promise<{ pages: number, features: number }>} Counts.
 */
export async function pageTnrLayer({ cacheDir, pageSize = 1000, fetchImpl = globalThis.fetch, snapshotAt = new Date().toISOString() }) {
  await assertUsEgress(fetchImpl);
  await mkdir(cacheDir, { recursive: true });
  let offset = 0;
  let pages = 0;
  let features = 0;
  for (;;) {
    const multiValueQueryString = {
      where: ["1=1"],
      outFields: ["OBJECTID,PROP_ID,geo_id"],
      returnGeometry: ["true"],
      outSR: ["4326"],
      f: ["geojson"],
      resultOffset: [String(offset)],
      resultRecordCount: [String(pageSize)],
    };
    const query = new URLSearchParams(Object.entries(multiValueQueryString).map(([key, values]) => [key, values[0]]));
    const url = `${TNR_PARCEL_LAYER_QUERY_URL}?${query.toString()}`;
    const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`TNR query HTTP ${response.status} at offset ${offset}`);
    const text = await response.text();
    const pageName = `page-${String(pages).padStart(5, "0")}`;
    await writeFile(path.join(cacheDir, `${pageName}.json`), text, "utf8");
    await writeFile(
      path.join(cacheDir, `${pageName}.receipt.json`),
      `${JSON.stringify({ request: { method: "GET", url: TNR_PARCEL_LAYER_QUERY_URL, multiValueQueryString }, status: response.status, byteLength: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex"), snapshotAt }, null, 2)}\n`,
      "utf8",
    );
    const body = JSON.parse(text);
    const count = Array.isArray(body.features) ? body.features.length : 0;
    pages += 1;
    features += count;
    if (count < pageSize || body.exceededTransferLimit === false) break;
    offset += count;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { pages, features };
}

/**
 * Read cached TNR pages into per-PROP_ID feature lists with their page request.
 *
 * @param {string} cacheDir - Directory written by {@link pageTnrLayer}.
 * @returns {Promise<Map<string, { geometries: unknown[], objectIds: string[], geoIds: string[], request: object, snapshotAt: string }>>} Features by PROP_ID.
 */
export async function readTnrCache(cacheDir) {
  const byProp = new Map();
  const names = (await readdir(cacheDir)).filter((name) => /^page-\d{5}\.json$/.test(name)).sort();
  for (const name of names) {
    const page = JSON.parse(await readFile(path.join(cacheDir, name), "utf8"));
    const receipt = JSON.parse(await readFile(path.join(cacheDir, name.replace(".json", ".receipt.json")), "utf8"));
    for (const feature of page.features ?? []) {
      const propId = toText(feature.properties?.PROP_ID);
      if (!propId) continue;
      const entry = byProp.get(propId) ?? { geometries: [], objectIds: [], geoIds: [], request: receipt.request, snapshotAt: receipt.snapshotAt };
      entry.geometries.push(feature.geometry);
      entry.objectIds.push(toText(feature.id ?? feature.properties?.OBJECTID));
      entry.geoIds.push(toText(feature.properties?.geo_id));
      byProp.set(propId, entry);
    }
  }
  return byProp;
}

/**
 * @param {string} dir - Export directory.
 * @returns {Promise<{ propertyFile: string, improvementFile: string | null }>} The property and improvement files, by name heuristics confirmed against the layout.
 */
async function locateExportFiles(dir) {
  const names = await readdir(dir);
  const propertyFile = names.find((name) => /^prop(\.|_info|erty)/i.test(name) && !/ent|imp|land|abs/i.test(name));
  const improvementFile = names.find((name) => /imp(rv)?_?det|improvement_?det/i.test(name)) ?? null;
  if (!propertyFile) throw new Error(`No property file found in ${dir}; files: ${names.join(", ")}`);
  return { propertyFile: path.join(dir, propertyFile), improvementFile: improvementFile ? path.join(dir, improvementFile) : null };
}

/**
 * Build the seed from the export directory and the TNR cache.
 *
 * @param {object} options - Script inputs.
 * @returns {Promise<object>} Seed manifest.
 */
export async function buildTravisSeed(options) {
  const { propertyFile, improvementFile } = await locateExportFiles(options.exportDir);
  const propertyText = await readFile(propertyFile, "utf8");
  const rawRows = parseCsvRecords(propertyText);
  if (rawRows.length === 0) throw new Error(`Property file has no rows: ${propertyFile}`);
  const { map, missing } = resolveColumnMap(Object.keys(rawRows[0]));
  let improvements = new Map();
  if (improvementFile) {
    const rawImprovements = parseCsvRecords(await readFile(improvementFile, "utf8"));
    const improvementMap = resolveColumnMap(Object.keys(rawImprovements[0] ?? { prop_id: "", geo_id: "" })).map;
    improvements = summarizeImprovements(rawImprovements.map((row) => toCanonicalTcadRow(row, improvementMap)));
  }
  const tnr = await readTnrCache(options.tnrCache);
  const archiveBytes = await readFile(options.exportArchive);
  const sourceRevision = createHash("sha256").update(archiveBytes).digest("hex");
  const snapshotAt = options.snapshotAt ?? new Date().toISOString();
  const request = { method: "GET", url: options.exportUrl, multiValueQueryString: {} };
  const snapshot = { sourceItemId: path.basename(options.exportArchive), sourceRevision, snapshotAt };

  const records = [];
  const seen = new Set();
  let invalidPropIds = 0;
  let duplicates = 0;
  let gisJoined = 0;
  for (const raw of rawRows) {
    const tcad = toCanonicalTcadRow(raw, map);
    const extra = improvements.get(tcad.prop_id);
    if (extra) Object.assign(tcad, extra);
    if (!isValidPropId(tcad.prop_id)) {
      invalidPropIds += 1;
      continue;
    }
    if (seen.has(tcad.prop_id)) {
      duplicates += 1;
      continue;
    }
    seen.add(tcad.prop_id);
    const feature = tnr.get(tcad.prop_id) ?? null;
    if (feature) gisJoined += feature.geometries.length;
    records.push({
      tcad,
      request,
      snapshot,
      tnr: feature
        ? { geometry: mergeGeometries(feature.geometries), objectId: feature.objectIds.join("|"), request: feature.request, snapshotAt: feature.snapshotAt }
        : null,
      sourceRecordCount: feature ? feature.geometries.length : 0,
      sourceObjectIds: feature ? feature.objectIds.join("|") : "",
    });
  }
  const rows = records.map((record) => toSeedRow(record));
  const gisFeatures = [...tnr.values()].reduce((total, entry) => total + entry.geometries.length, 0);
  const stats = {
    rollRows: rawRows.length - duplicates,
    rowsWritten: rows.length,
    uniquePropIds: new Set(rows.map((row) => row.parcel_id)).size,
    invalidPropIds,
    gisFeatures,
    gisJoined,
    gisUnjoined: gisFeatures - gisJoined,
  };
  assertSeedReconciliation(stats);
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, renderCsv(SEED_COLUMNS, rows), "utf8");

  let pilot = null;
  if (options.pilotOutput) {
    const permitGeoIds = new Set(
      options.permitGeoIds ? (await readFile(options.permitGeoIds, "utf8")).split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [],
    );
    const selected = selectPilotRows(rows, { size: options.pilotSize ?? 25, permitGeoIds });
    await writeFile(options.pilotOutput, renderCsv(SEED_COLUMNS, selected), "utf8");
    pilot = { path: options.pilotOutput, size: selected.length, propIds: selected.map((row) => row.parcel_id) };
  }
  const manifest = {
    schemaVersion: "travis.seed-manifest.v1",
    builtAt: snapshotAt,
    exportUrl: options.exportUrl,
    exportArchiveSha256: sourceRevision,
    propertyFile: path.basename(propertyFile),
    improvementFile: improvementFile ? path.basename(improvementFile) : null,
    columnMap: map,
    unresolvedOptionalColumns: missing,
    counts: {
      ...stats,
      duplicatePropIdRows: duplicates,
      assessedParcelCount: rows.length,
      gisFeatureCount: gisFeatures,
      gisDistinctPropIds: tnr.size,
      rowsWithGeometry: rows.filter((row) => row.latitude !== "").length,
    },
    tcadIdNormalizationProof: proveDigitsOnlyNormalization(rows.map((row) => row.geo_id)),
    pilot,
    output: options.output,
  };
  await writeFile(path.join(path.dirname(options.output), "travis-seed-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    if (name === "fetch-tnr") {
      flags[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
    flags[name] = value;
    index += 1;
  }
  return flags;
}

async function main(argv) {
  const flags = parseArgs(argv);
  for (const required of ["export-dir", "export-url", "export-archive", "tnr-cache", "output"]) {
    if (!flags[required]) throw new Error(`--${required} is required`);
  }
  if (flags["fetch-tnr"] === true) {
    const paged = await pageTnrLayer({ cacheDir: flags["tnr-cache"] });
    console.error(JSON.stringify({ event: "tnr_paged", ...paged }));
  }
  const manifest = await buildTravisSeed({
    exportDir: flags["export-dir"],
    exportUrl: flags["export-url"],
    exportArchive: flags["export-archive"],
    tnrCache: flags["tnr-cache"],
    output: flags.output,
    pilotOutput: flags["pilot-output"] ?? null,
    pilotSize: flags["pilot-size"] ? Number(flags["pilot-size"]) : 25,
    permitGeoIds: flags["permit-geo-ids"] ?? null,
  });
  console.log(JSON.stringify({ event: "travis_seed_complete", ...manifest }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
