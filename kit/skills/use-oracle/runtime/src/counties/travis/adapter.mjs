/**
 * Travis County (TX) adapter: bulk-first capture materialized per parcel,
 * custom transform, structural run validation and the internal reconciliation
 * export. Registers `--county travis` on the `elephant-county` CLI verbs.
 *
 * Capture is bulk-first (assignment decisions.md section 3): the seed row
 * already carries the TCAD export columns, the bulk GET that fetched the
 * export, and the TNR feature with the page query that returned it, so a
 * parcel's `input.json` is materialized without any network call. A
 * pre-materialized `<htmlDir>/<PROP_ID>.json` (fixture or earlier capture)
 * takes precedence. `--live-fetch` only refreshes the parcel's geometry with
 * one per-parcel TNR query, after an egress check, and records that request
 * on the geometry entity. There is no per-parcel appraiser page in v1, so
 * raw single-property capture is not offered.
 *
 * The lexicon manifest the transform names its roots by is resolved once per
 * run: `ELEPHANT_SCHEMA_MANIFEST_FILE` (a saved manifest), else the fixture's
 * `lexicon-manifest.json` beside `htmlDir`, else a live fetch of
 * `ELEPHANT_SCHEMA_MANIFEST_URL` (default `https://lexicon.elephant.xyz/api/manifest`).
 * Offline replays and tests never fetch.
 *
 * @module counties/travis/adapter
 */

import AdmZipCtor from "adm-zip";
import { mkdir, readdir, readFile, writeFile, access } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTransformedZipJsonFiles, writeQueryTableParquet, buildCoverageSnapshot } from "../../core/query-table.mjs";
import { classifyFailure, appendFailure } from "../../core/run-state.mjs";
import { writeTravisTransform, resolveDataGroupCids, PARCEL_INPUT_SCHEMA_VERSION, SOURCE_PAYLOAD_FILENAME } from "../../../counties/travis/transforms/transform.mjs";
import { mapTransformedFilesToQueryTableRow, COUNTY_KEY, COUNTY_NAME, SOURCE_SYSTEM } from "./query-table.mjs";
import { TRAVIS_QUERY_TABLE_SCHEMA_FIELDS } from "./enrichment-profile.mjs";
import { buildSeed as buildTravisSeedFiles, toText, isValidPropId, polygonCentroid, TNR_PARCEL_LAYER_QUERY_URL, TRAVIS_SEED_BBOX } from "./seed.mjs";
import {
  collectGeometryPoints,
  assertGeometryInCounty,
  assertManifestReconciled,
  assertUniqueParcelIds,
  assertOutputContract,
  REQUIRED_DATA_ARTIFACTS,
} from "./validate.mjs";

const RUNTIME_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const TRANSFORMS_DIR = path.join(RUNTIME_ROOT, "counties", "travis", "transforms");
export const DEFAULT_JOB_ID = "travis-ingest";
export const DEFAULT_MANIFEST_URL = "https://lexicon.elephant.xyz/api/manifest";
export const EGRESS_CHECK_URL = "https://ipinfo.io/country";
export const MIN_TRANSFORMED_ZIP_BYTES = 200;
export const ZIP_LOCAL_FILE_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/**
 * @param {string} candidate - Filesystem path.
 * @returns {Promise<boolean>} Whether the path exists.
 */
async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} value - JSON text or empty.
 * @returns {Record<string, string[]>} Parsed object, or `{}`.
 */
function parseQuery(value) {
  const raw = toText(value);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Materialize the `travis.parcel-input.v1` object for one seed row. No network.
 *
 * @param {Record<string, string>} row - Seed row (`src/counties/travis/seed.mjs#SEED_COLUMNS`).
 * @returns {object} Parcel input.
 */
export function materializeParcelInput(row) {
  const propId = toText(row.parcel_id) || toText(row.source_identifier);
  if (!isValidPropId(propId)) throw new Error(`seed parcel_id is not a printed PROP_ID: ${JSON.stringify(propId)}`);
  const url = toText(row.url);
  if (!url) throw new Error("seed url (the TCAD bulk export GET actually made) is required");
  /** @type {Record<string, unknown>} */
  const tcad = {};
  for (const [column, value] of Object.entries(row)) {
    if (column.startsWith("source_") && !["source_url", "source_item_id", "source_revision", "source_snapshot_at", "source_record_count", "source_object_ids", "source_features_json", "source_identifier"].includes(column)) {
      tcad[column.slice("source_".length)] = toText(value) || null;
    }
  }
  if (!tcad.geo_id && toText(row.geo_id)) tcad.geo_id = toText(row.geo_id);
  const lat = toText(row.latitude) === "" ? Number.NaN : Number(row.latitude);
  const lon = toText(row.longitude) === "" ? Number.NaN : Number(row.longitude);
  let polygon = null;
  if (toText(row.parcel_polygon)) {
    try {
      polygon = JSON.parse(row.parcel_polygon);
    } catch {
      polygon = null;
    }
  }
  const geometry =
    Number.isFinite(lat) && Number.isFinite(lon) && toText(row.tnr_url)
      ? {
          latitude: lat,
          longitude: lon,
          polygon,
          objectId: toText(row.tnr_object_id) || null,
          snapshotAt: toText(row.tnr_snapshot_at) || null,
          request: { method: "GET", url: toText(row.tnr_url), multiValueQueryString: parseQuery(row.tnr_multiValueQueryString) },
        }
      : null;
  return {
    schemaVersion: PARCEL_INPUT_SCHEMA_VERSION,
    propId,
    geoId: toText(row.geo_id) || toText(tcad.geo_id) || null,
    request: { method: toText(row.method) || "GET", url, multiValueQueryString: parseQuery(row.multiValueQueryString) },
    snapshot: {
      sourceUrl: toText(row.source_url) || null,
      sourceItemId: toText(row.source_item_id) || null,
      sourceRevision: toText(row.source_revision) || null,
      snapshotAt: toText(row.source_snapshot_at) || null,
    },
    tcad,
    situs: { address: toText(row.address) || null, city: toText(row.city) || null, state: toText(row.state) || "TX", zip: toText(row.zip) || null },
    geometry,
  };
}

/**
 * Refuse to contact a geo-restricted host unless the current egress is in the US.
 *
 * @param {typeof fetch} fetchImpl - Fetch implementation.
 * @returns {Promise<string>} The country code observed.
 */
export async function assertUsEgress(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(EGRESS_CHECK_URL, { headers: { Accept: "text/plain" } });
  const country = (await response.text()).trim().toUpperCase();
  if (country !== "US") {
    throw new Error(`egress country is ${country || "unknown"}, not US; refusing to contact gis.traviscountytx.gov`);
  }
  return country;
}

/**
 * Fetch one parcel's feature from the TNR layer (live path only) and return
 * the geometry block with the request actually made.
 *
 * @param {object} options - Parcel id and seams.
 * @param {string} options.propId - PROP_ID as printed.
 * @param {typeof fetch} [options.fetchImpl] - Fetch implementation.
 * @param {string} [options.capturedAt] - ISO timestamp.
 * @returns {Promise<object | null>} Geometry block for the parcel input, or null when the layer has no feature.
 */
export async function fetchTnrFeatureForParcel({ propId, fetchImpl = globalThis.fetch, capturedAt = new Date().toISOString() }) {
  await assertUsEgress(fetchImpl);
  const multiValueQueryString = {
    where: [`PROP_ID=${propId}`],
    outFields: ["PROP_ID,geo_id"],
    returnGeometry: ["true"],
    outSR: ["4326"],
    f: ["geojson"],
  };
  const query = new URLSearchParams(Object.entries(multiValueQueryString).map(([key, values]) => [key, values[0]]));
  const url = `${TNR_PARCEL_LAYER_QUERY_URL}?${query.toString()}`;
  const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`TNR query HTTP ${response.status} for PROP_ID ${propId}`);
  const body = await response.json();
  const feature = Array.isArray(body?.features) ? body.features[0] : null;
  if (!feature) return null;
  const printed = toText(feature.properties?.PROP_ID);
  if (printed !== propId) throw new Error(`TNR feature PROP_ID ${printed} does not match requested ${propId}`);
  const centroid = polygonCentroid(feature.geometry);
  if (!centroid) return null;
  return {
    latitude: centroid.latitude,
    longitude: centroid.longitude,
    polygon: feature.geometry,
    objectId: toText(feature.id ?? feature.properties?.OBJECTID) || null,
    snapshotAt: capturedAt,
    request: { method: "GET", url: TNR_PARCEL_LAYER_QUERY_URL, multiValueQueryString },
    geoId: toText(feature.properties?.geo_id) || null,
  };
}

/**
 * Resolve the lexicon manifest for a run (see the module doc for the order).
 *
 * @param {{ htmlDir?: string, allowNetwork?: boolean, fetchImpl?: typeof fetch }} options - Resolution inputs.
 * @returns {Promise<{ manifest: Record<string, unknown>, source: string, roots: { countyCid: string, seedCid: string } }>} Manifest, where it came from, and the root CIDs.
 */
export async function resolveLexiconManifest({ htmlDir, allowNetwork = false, fetchImpl = globalThis.fetch } = {}) {
  const fromEnv = toText(process.env.ELEPHANT_SCHEMA_MANIFEST_FILE);
  const candidates = [fromEnv, htmlDir ? path.join(htmlDir, "..", "lexicon-manifest.json") : ""].filter(Boolean);
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      const manifest = JSON.parse(await readFile(candidate, "utf8"));
      return { manifest, source: `file:${candidate}`, roots: resolveDataGroupCids(manifest) };
    }
  }
  if (!allowNetwork) {
    throw new Error(
      "No lexicon manifest snapshot found (ELEPHANT_SCHEMA_MANIFEST_FILE or <fixture>/lexicon-manifest.json) and network resolution was not requested; refusing to guess data-group CIDs.",
    );
  }
  const url = toText(process.env.ELEPHANT_SCHEMA_MANIFEST_URL) || DEFAULT_MANIFEST_URL;
  const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`lexicon manifest HTTP ${response.status} for ${url}`);
  const manifest = await response.json();
  return { manifest, source: url, roots: resolveDataGroupCids(manifest) };
}

/**
 * Classify a Travis capture/transform failure for retry policy.
 *
 * @param {unknown} error - Error or message.
 * @returns {"transient" | "permanent" | "unknown"} Retry classification.
 */
export function classifyTravisFailure(error) {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (
    /not a printed prop_id|not the printed prop_id|does not match requested|no situs address|outside the travis bbox|unsupported parcel input schema|is required|refusing to guess|egress country|county_jurisdiction|missing data-group root|must carry label|links to missing|is not linked|http 403|http 404|http 400/.test(
      message,
    )
  ) {
    return "permanent";
  }
  return classifyFailure(error);
}

/**
 * Zip a parcel's `data/` directory into `transformed.zip` (`data/<file>` entries).
 *
 * @param {string} dataDir - Absolute data directory.
 * @param {string} zipPath - Destination zip.
 * @returns {Promise<void>} Resolves once written.
 */
async function zipDataDirectory(dataDir, zipPath) {
  const zip = new AdmZipCtor();
  for (const name of (await readdir(dataDir)).sort()) zip.addLocalFile(path.join(dataDir, name), "data");
  await new Promise((resolve, reject) => zip.writeZip(zipPath, (error) => (error ? reject(error) : resolve(undefined))));
}

/**
 * True when a parcel directory already has a non-empty PKZIP `transformed.zip`.
 *
 * @param {string} parcelDir - Per-parcel output directory.
 * @returns {Promise<boolean>} Whether a usable `transformed.zip` exists.
 */
export async function hasCompletedTransform(parcelDir) {
  try {
    const buffer = await readFile(path.join(parcelDir, "transformed.zip"));
    return buffer.length >= MIN_TRANSFORMED_ZIP_BYTES && buffer.subarray(0, 4).equals(ZIP_LOCAL_FILE_MAGIC);
  } catch {
    return false;
  }
}

/**
 * Read every `data/*.json` object from a transformed.zip, relationships and roots included.
 *
 * @param {string} zipPath - Path to `transformed.zip`.
 * @returns {Record<string, Record<string, unknown>>} Basename to parsed JSON.
 */
export function readAllTransformedZipJsonFiles(zipPath) {
  const zip = new AdmZipCtor(zipPath);
  /** @type {Record<string, Record<string, unknown>>} */
  const files = {};
  for (const entry of zip.getEntries()) {
    const name = entry.entryName.replaceAll("\\", "/");
    if (!name.startsWith("data/") || !name.endsWith(".json")) continue;
    files[name.slice("data/".length)] = JSON.parse(entry.getData().toString("utf8"));
  }
  return files;
}

/**
 * @typedef {"success" | "permanent_failure" | "retryable_failure"} ParcelClassification
 */

/**
 * @typedef {object} ParcelTransformResult
 * @property {string} parcelId - PROP_ID as printed.
 * @property {boolean} transformSuccess
 * @property {ParcelClassification} classification
 * @property {string | null} propertyUsageType
 * @property {string | null} error
 */

/**
 * Materialize (or reuse) the parcel input and run the Travis transform for
 * every seed row, writing `<outputDir>/<PROP_ID>/{input.json,data/,transformed.zip}`
 * plus a run `manifest.json`. Every failure is appended to the shared retry
 * ledger under `jobId`.
 *
 * @param {object} options - Run inputs.
 * @param {readonly Record<string, string>[]} options.seedRows - Seed rows.
 * @param {string} options.htmlDir - Directory of pre-materialized `<PROP_ID>.json` inputs (may be empty or absent).
 * @param {string} options.outputDir - Run directory.
 * @param {boolean} [options.liveFetch] - Refresh geometry from the TNR layer (US egress required). Defaults to false.
 * @param {string} [options.jobId] - Retry-ledger job id.
 * @param {string} [options.asOfDate] - Roof-age as-of date.
 * @param {typeof fetch} [options.fetchImpl] - Fetch seam for tests.
 * @returns {Promise<object>} Run manifest, also written to `<outputDir>/manifest.json`.
 */
export async function captureAndTransform({
  seedRows,
  htmlDir,
  outputDir,
  liveFetch = false,
  jobId = DEFAULT_JOB_ID,
  asOfDate = new Date().toISOString().slice(0, 10),
  fetchImpl = globalThis.fetch,
}) {
  await mkdir(outputDir, { recursive: true });
  const runStarted = performance.now();
  const manifestStarted = performance.now();
  const resolved = await resolveLexiconManifest({ htmlDir, allowNetwork: liveFetch, fetchImpl });
  const lexiconManifestResolveMs = performance.now() - manifestStarted;
  /** @type {ParcelTransformResult[]} */
  const results = [];
  /** @type {{ parcelId: string, materializeMs: number, transformMs: number, checkMs: number, zipMs: number }[]} */
  const parcelTimings = [];
  let geometryCount = 0;
  for (const row of seedRows) {
    const parcelId = toText(row.parcel_id) || toText(row.source_identifier);
    const parcelDir = path.join(outputDir, parcelId || "_invalid");
    await mkdir(parcelDir, { recursive: true });
    const timing = { parcelId, materializeMs: 0, transformMs: 0, checkMs: 0, zipMs: 0 };
    let stageStarted = performance.now();
    try {
      const fixturePath = path.join(htmlDir ?? "", `${parcelId}.json`);
      let input;
      let inputSource;
      if (htmlDir && (await pathExists(fixturePath))) {
        input = JSON.parse(await readFile(fixturePath, "utf8"));
        inputSource = "pre-materialized";
      } else {
        input = materializeParcelInput(row);
        inputSource = "seed-row";
      }
      if (liveFetch === true) {
        const refreshed = await fetchTnrFeatureForParcel({ propId: input.propId, fetchImpl });
        if (refreshed) {
          const { geoId, ...geometry } = refreshed;
          input = { ...input, geometry, geoId: input.geoId ?? geoId };
        }
      }
      await writeFile(path.join(parcelDir, "input.json"), `${JSON.stringify(input, null, 2)}\n`, "utf8");
      await writeFile(
        path.join(parcelDir, "property_seed.json"),
        `${JSON.stringify({ parcel_id: input.propId, source_http_request: input.request, request_identifier: input.propId }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        path.join(parcelDir, "unnormalized_address.json"),
        `${JSON.stringify({ full_address: input.situs?.address ?? input.propId, county_jurisdiction: COUNTY_NAME, latitude: input.geometry?.latitude ?? null, longitude: input.geometry?.longitude ?? null, source_http_request: input.request, request_identifier: input.propId }, null, 2)}\n`,
        "utf8",
      );

      timing.materializeMs = performance.now() - stageStarted;
      stageStarted = performance.now();
      const transform = await writeTravisTransform({ workDir: parcelDir, input, manifest: resolved.manifest });
      timing.transformMs = performance.now() - stageStarted;
      stageStarted = performance.now();
      const files = Object.fromEntries(
        await Promise.all(transform.files.map(async (name) => [name, JSON.parse(await readFile(path.join(transform.dataDir, name), "utf8"))])),
      );
      assertOutputContract(files, transform.roots);
      const points = files["geometry.json"] ? collectGeometryPoints(files["geometry.json"]) : [];
      assertGeometryInCounty(points);
      if (points.length > 0) geometryCount += 1;
      timing.checkMs = performance.now() - stageStarted;
      stageStarted = performance.now();

      await zipDataDirectory(transform.dataDir, path.join(parcelDir, "transformed.zip"));
      timing.zipMs = performance.now() - stageStarted;
      await writeFile(
        path.join(parcelDir, "transform-receipt.json"),
        `${JSON.stringify({ inputSource, warnings: transform.warnings, roots: transform.roots, files: transform.files, sourcePayloadPath: transform.sourcePayloadPath }, null, 2)}\n`,
        "utf8",
      );
      results.push({
        parcelId: input.propId,
        transformSuccess: true,
        classification: "success",
        propertyUsageType: typeof files["property.json"]?.property_usage_type === "string" ? files["property.json"].property_usage_type : null,
        error: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failureClass = classifyTravisFailure(error);
      const classification = failureClass === "permanent" ? "permanent_failure" : "retryable_failure";
      await appendFailure(outputDir, jobId, { parcelId, error: message, classification: failureClass, attempts: 1, at: new Date().toISOString(), jobId });
      results.push({ parcelId, transformSuccess: false, classification, propertyUsageType: null, error: message });
    }
    parcelTimings.push(timing);
  }
  const reconciled = {
    seedRows: seedRows.length,
    success: results.filter((row) => row.classification === "success").length,
    permanentFailure: results.filter((row) => row.classification === "permanent_failure").length,
    retryableFailure: results.filter((row) => row.classification === "retryable_failure").length,
  };
  const manifest = {
    county: COUNTY_KEY,
    outputDir,
    jobId,
    asOfDate,
    liveFetch: liveFetch === true,
    lexiconManifest: { source: resolved.source, countyCid: resolved.roots.countyCid, seedCid: resolved.roots.seedCid },
    geometryCount,
    results,
    reconciled,
    timings: summarizeTimings({ parcelTimings, lexiconManifestResolveMs, totalMs: performance.now() - runStarted }),
  };
  await writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

/**
 * Summarize per-parcel stage timings (milliseconds, rounded to 0.1 ms).
 *
 * @param {{ parcelTimings: { parcelId: string, materializeMs: number, transformMs: number, checkMs: number, zipMs: number }[], lexiconManifestResolveMs: number, totalMs: number }} input - Raw timings.
 * @returns {object} Totals, p50/p95 per stage and the per-parcel rows.
 */
export function summarizeTimings({ parcelTimings, lexiconManifestResolveMs, totalMs }) {
  const round = (value) => Math.round(value * 10) / 10;
  const stages = ["materializeMs", "transformMs", "checkMs", "zipMs"];
  const quantile = (values, q) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return round(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]);
  };
  const perStage = {};
  for (const stage of stages) {
    const values = parcelTimings.map((timing) => timing[stage]);
    perStage[stage] = { total: round(values.reduce((sum, value) => sum + value, 0)), p50: quantile(values, 0.5), p95: quantile(values, 0.95) };
  }
  return {
    unit: "ms",
    totalMs: round(totalMs),
    lexiconManifestResolveMs: round(lexiconManifestResolveMs),
    parcels: parcelTimings.length,
    perStage,
    perParcel: parcelTimings.map((timing) => Object.fromEntries(Object.entries(timing).map(([key, value]) => [key, typeof value === "number" ? round(value) : value]))),
  };
}

/**
 * Structurally validate an ingest run (never calls `@elephant-xyz/cli`).
 *
 * @param {{ outputDir: string, results: ParcelTransformResult[], reconciled?: object, lexiconManifest?: { countyCid: string, seedCid: string } }} manifest - Run manifest.
 * @param {{ allowEmpty?: boolean }} [options] - Fail-closed override for all-failure runs.
 * @returns {Promise<{ valid: boolean, checked: number, issues: { parcelId: string | null, reason: string }[] }>} Summary.
 */
export async function validateRun(manifest, options = {}) {
  const allowEmpty = options.allowEmpty === true;
  const issues = [];
  let checked = 0;
  const reconciled = manifest.reconciled ?? {
    seedRows: manifest.results.length,
    success: manifest.results.filter((row) => row.classification === "success").length,
    permanentFailure: manifest.results.filter((row) => row.classification === "permanent_failure").length,
    retryableFailure: manifest.results.filter((row) => row.classification === "retryable_failure").length,
  };
  try {
    assertManifestReconciled(reconciled);
  } catch (error) {
    issues.push({ parcelId: null, reason: error instanceof Error ? error.message : String(error) });
  }
  try {
    assertUniqueParcelIds(manifest.results);
  } catch (error) {
    issues.push({ parcelId: null, reason: error instanceof Error ? error.message : String(error) });
  }
  if (reconciled.seedRows > 0 && reconciled.success === 0 && !allowEmpty) {
    issues.push({
      parcelId: null,
      reason: `0 of ${reconciled.seedRows} seed rows produced a successful parcel; refusing to treat an all-failure run as valid. Pass { allowEmpty: true } (CLI: --allow-empty) to permit an empty export.`,
    });
  }
  for (const parcel of manifest.results) {
    if (parcel.classification !== "success") continue;
    checked += 1;
    const parcelDir = path.join(manifest.outputDir, parcel.parcelId);
    if (!(await hasCompletedTransform(parcelDir))) {
      issues.push({ parcelId: parcel.parcelId, reason: "transformed.zip missing or not a valid PKZIP" });
      continue;
    }
    const files = readAllTransformedZipJsonFiles(path.join(parcelDir, "transformed.zip"));
    for (const required of REQUIRED_DATA_ARTIFACTS) {
      if (files[required] === undefined) issues.push({ parcelId: parcel.parcelId, reason: `transformed.zip is missing data/${required}` });
    }
    if (manifest.lexiconManifest) {
      try {
        assertOutputContract(files, manifest.lexiconManifest);
      } catch (error) {
        issues.push({ parcelId: parcel.parcelId, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { valid: issues.length === 0, checked, issues };
}

/**
 * Build the internal query-table Parquet + coverage JSON from a completed run
 * (rows = successfully transformed parcels). Fails closed on an empty export
 * for a non-empty seed unless `allowEmpty` is explicit.
 *
 * @param {{ outputDir: string, seedRows: readonly Record<string, string>[], workingDir: string, allowEmpty?: boolean, asOfDate?: string }} run - Run output, seed rows, destination.
 * @returns {Promise<{ county: string, parquetPath: string, coveragePath: string, manifestPath: string, rowCount: number, expectedCount: number }>} Written artifacts.
 */
export async function buildReconciliationArtifacts({ outputDir, seedRows, workingDir, allowEmpty = false, asOfDate }) {
  const expectedCount = seedRows.length;
  let asOf = asOfDate;
  if (!asOf) {
    try {
      asOf = JSON.parse(await readFile(path.join(outputDir, "manifest.json"), "utf8")).asOfDate;
    } catch {
      asOf = new Date().toISOString().slice(0, 10);
    }
  }
  const rows = [];
  for (const row of seedRows) {
    const zipPath = path.join(outputDir, row.parcel_id, "transformed.zip");
    try {
      const files = readTransformedZipJsonFiles(zipPath);
      if (files["property.json"] === undefined) continue;
      let sourcePayload = null;
      try {
        sourcePayload = JSON.parse(await readFile(path.join(outputDir, row.parcel_id, SOURCE_PAYLOAD_FILENAME), "utf8"));
      } catch {
        sourcePayload = null;
      }
      rows.push(mapTransformedFilesToQueryTableRow({ parcelId: row.parcel_id, files, seedRow: row, sourcePayload, asOfDate: asOf }));
    } catch {
      continue;
    }
  }
  const identifiers = rows.map((row) => row.request_identifier);
  if (new Set(identifiers).size !== identifiers.length) throw new Error("Query table would contain duplicate request_identifier values");
  if (expectedCount > 0 && rows.length === 0 && allowEmpty !== true) {
    throw new Error(
      `Refusing to write an empty Travis reconciliation table: 0 of ${expectedCount} seed rows produced a successful, complete parcel. Pass { allowEmpty: true } (CLI: --allow-empty) to permit an empty export.`,
    );
  }
  await mkdir(workingDir, { recursive: true });
  const parquetPath = path.join(workingDir, "query-table.parquet");
  const coveragePath = path.join(workingDir, "dataset-coverage.json");
  const manifestPath = path.join(workingDir, "manifest.json");
  await writeQueryTableParquet({ parquetPath, schemaFields: TRAVIS_QUERY_TABLE_SCHEMA_FIELDS, rows });
  const exportedAt = new Date().toISOString();
  const coverage = buildCoverageSnapshot({ county: COUNTY_KEY, source: "appraisal", ingestedCount: rows.length, expectedCount, exportedAt });
  await writeFile(coveragePath, `${JSON.stringify(coverage, null, 2)}\n`, "utf8");
  const artifacts = { county: COUNTY_KEY, parquetPath, coveragePath, manifestPath, rowCount: rows.length, expectedCount };
  await writeFile(manifestPath, `${JSON.stringify(artifacts, null, 2)}\n`, "utf8");
  return artifacts;
}

/** Travis adapter object consumed by `bin/elephant-county.mjs` and `core/replay.mjs`. */
export const travisAdapter = {
  key: COUNTY_KEY,
  countyName: COUNTY_NAME,
  sourceSystem: SOURCE_SYSTEM,
  transformsDir: TRANSFORMS_DIR,
  flowPath: null,
  seedBbox: TRAVIS_SEED_BBOX,
  buildSeed: buildTravisSeedFiles,
  captureAndTransform,
  validateRun,
  buildReconciliationArtifacts,
};
