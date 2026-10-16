#!/usr/bin/env node
/**
 * Travis County seed-producing script (`county-seed-data`). **Runs only after
 * the readiness validator prints PASS with `seed_allowed: true`, inside a US
 * egress window.** Not run on 2026-10-16: the validator is BLOCKED on the
 * parcel gate until the operator approves the documented GIS exception.
 *
 * Reads the TCAD 2026 Certified Appraisal Export in the PACS **Legacy 8.0.33
 * fixed-width** layout (field positions below come from
 * `Legacy8.0.33-AppraisalExportLayout.xlsx`), streaming each member from the
 * downloaded archive with `unzip -p` (or from an extracted directory), so the
 * 4.9 GB `PROP.TXT` is never held in memory:
 *
 * - `PROP.TXT`: one record per property and owner; only real-property
 *   accounts (`prop_type_cd` R) become seed rows; additional owner records of
 *   an account already written are folded and counted; MH, P and MN accounts
 *   are counted and excluded (not land parcels).
 * - `IMP_DET.TXT`: year built (earliest valid year among the living-area
 *   detail types, else among all details), living area (sum of the
 *   living-area detail areas) and improvement count per property.
 * - `ABS_SUBD.TXT`: abstract/subdivision descriptions.
 * - The TNR "TCAD Parcels" MapServer layer, paged into a local cache with a
 *   receipt per page (`--fetch-tnr`, US egress required), joined on PROP_ID.
 *
 * Outputs (all under the gitignored `data/`): the full seed CSV, the
 * stratified pilot seed CSV, and `travis-seed-manifest.json` with the counts,
 * the reconciliation, the column positions used, and the `tcad_id` digits-only
 * one-to-one proof over the roll's geo_ids.
 *
 * Usage:
 *   node src/counties/travis/build-seed.mjs \
 *     --export-archive '<2026 Certified Appraisal Export Supp 0_07182026.zip>' \
 *     --export-url '<the exact URL the archive was downloaded from>' \
 *     [--export-dir <dir with extracted PROP.TXT, IMP_DET.TXT, ABS_SUBD.TXT>] \
 *     --tnr-cache data/travis/tnr [--fetch-tnr] \
 *     --output data/seeds/travis.csv --pilot-output data/seeds/travis-pilot.csv [--pilot-size 25] \
 *     [--permit-geo-ids <file with one geo_id per line>]
 *
 * @module counties/travis/build-seed
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { encodeCsvCell } from "../../core/csv.mjs";
import { assertUsEgress } from "./adapter.mjs";
import { proveDigitsOnlyNormalization } from "./permit-profile.mjs";
import {
  SEED_COLUMNS,
  TNR_PARCEL_LAYER_QUERY_URL,
  assertSafeSourceFields,
  assertSeedReconciliation,
  decodePropId,
  mergeGeometries,
  selectPilotRows,
  toSeedRow,
  toText,
  TCAD_SOURCE_FIELDS,
} from "./seed.mjs";

export const LAYOUT_VERSION = "Legacy8.0.33";
export const PROP_RECORD_LENGTH = 9922;
export const IMP_DET_RECORD_LENGTH = 622;

/**
 * `PROP.TXT` field positions (1-based, inclusive) from the Legacy 8.0.33
 * layout, sheet Property. Kinds: `text` (trimmed), `int` (zero-padded
 * integer), `dec4` (integer with four implied decimals).
 */
export const PROP_FIELDS = Object.freeze({
  prop_id: [1, 12, "int"],
  prop_type_cd: [13, 17, "text"],
  prop_val_yr: [18, 22, "int"],
  sup_num: [23, 34, "int"],
  geo_id: [547, 596, "text"],
  py_owner_name: [609, 678, "text"],
  partial_owner: [679, 679, "text"],
  py_addr_line1: [694, 753, "text"],
  py_addr_line2: [754, 813, "text"],
  py_addr_line3: [814, 873, "text"],
  py_addr_city: [874, 923, "text"],
  py_addr_state: [924, 973, "text"],
  py_addr_zip: [979, 983, "text"],
  py_confidential_flag: [990, 990, "text"],
  py_address_suppress_flag: [991, 991, "text"],
  situs_street_prefx: [1040, 1049, "text"],
  situs_street: [1050, 1099, "text"],
  situs_street_suffix: [1100, 1109, "text"],
  situs_city: [1110, 1139, "text"],
  situs_zip: [1140, 1149, "text"],
  legal_desc: [1150, 1404, "text"],
  legal_desc2: [1405, 1659, "text"],
  legal_acreage: [1660, 1675, "dec4"],
  abs_subdv_cd: [1676, 1685, "text"],
  hood_cd: [1686, 1695, "text"],
  block: [1696, 1745, "text"],
  tract_or_lot: [1746, 1795, "text"],
  land_hstd_val: [1796, 1810, "int"],
  land_non_hstd_val: [1811, 1825, "int"],
  imprv_hstd_val: [1826, 1840, "int"],
  imprv_non_hstd_val: [1841, 1855, "int"],
  ag_use_val: [1856, 1870, "int"],
  appraised_val: [1916, 1930, "int"],
  assessed_val: [1946, 1960, "int"],
  deed_book_id: [1994, 2013, "text"],
  deed_book_page: [2014, 2033, "text"],
  deed_dt: [2034, 2058, "text"],
  imprv_state_cd: [2732, 2741, "text"],
  land_state_cd: [2742, 2751, "text"],
  market_value: [4214, 4227, "int"],
  situs_num: [4460, 4474, "text"],
  situs_unit: [4475, 4479, "text"],
});

/** `IMP_DET.TXT` positions (sheet ImprovementDetail). */
export const IMP_DET_FIELDS = Object.freeze({
  prop_id: [1, 12, "int"],
  prop_val_yr: [13, 16, "int"],
  imprv_id: [17, 28, "int"],
  imprv_det_id: [29, 40, "int"],
  imprv_det_type_cd: [41, 50, "text"],
  yr_built: [86, 89, "int"],
  imprv_det_area: [94, 108, "int"],
});

/** `ABS_SUBD.TXT` positions (sheet AbstractSubdivision). */
export const ABS_SUBD_FIELDS = Object.freeze({
  abs_subdv_cd: [1, 10, "text"],
  abs_subdv_desc: [11, 50, "text"],
});

/** Improvement detail types that are finished living area (observed in the 2026 certified IMP_DET.TXT). */
export const LIVING_AREA_DETAIL_TYPES = Object.freeze(["1ST", "2ND", "3RD", "4TH", "5TH", "ADDL", "1/2", "FBSMT"]);

/**
 * Read one fixed-width field.
 *
 * @param {string} line - Record (latin-1 decoded).
 * @param {readonly [number, number, string]} spec - `[start, end, kind]`, 1-based inclusive.
 * @returns {string} Decoded text (empty when blank; integers without padding; dec4 as a decimal string).
 */
export function readField(line, [start, end, kind]) {
  const raw = line.slice(start - 1, end).trim();
  if (raw === "") return "";
  if (kind === "int") {
    if (!/^-?\d+$/.test(raw)) return raw;
    const negative = raw.startsWith("-");
    const digits = raw.replace(/^-/, "").replace(/^0+/, "") || "0";
    return negative && digits !== "0" ? `-${digits}` : digits;
  }
  if (kind === "dec4") {
    if (!/^\d+$/.test(raw)) return raw;
    const digits = raw.replace(/^0+/, "").padStart(5, "0");
    const whole = digits.slice(0, -4).replace(/^0+(?=\d)/, "");
    const fraction = digits.slice(-4).replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : whole;
  }
  return raw;
}

/**
 * @param {string} line - Record.
 * @param {Record<string, readonly [number, number, string]>} fields - Field map.
 * @returns {Record<string, string>} Every field decoded.
 */
export function readRecord(line, fields) {
  const record = {};
  for (const [name, spec] of Object.entries(fields)) record[name] = readField(line, spec);
  return record;
}

/**
 * Stream the lines of one export member: from `<exportDir>/<member>` when it
 * exists, otherwise from the archive through `unzip -p` (never fully in memory).
 *
 * @param {{ exportDir?: string | null, exportArchive?: string | null, member: string }} options - Sources.
 * @returns {AsyncGenerator<string>} Lines without terminators, latin-1 decoded.
 */
export async function* streamMemberLines({ exportDir = null, exportArchive = null, member }) {
  const direct = exportDir ? path.join(exportDir, member) : null;
  let input;
  let child = null;
  let stderr = "";
  if (direct && existsSync(direct)) {
    input = createReadStream(direct, { encoding: "latin1" });
  } else if (exportArchive && existsSync(exportArchive)) {
    child = spawn("unzip", ["-p", exportArchive, member], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("latin1");
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    input = child.stdout;
  } else {
    throw new Error(`${member}: not found under --export-dir ${exportDir ?? "(none)"} and no readable --export-archive`);
  }
  const exited = child ? new Promise((resolve) => child.on("close", (code) => resolve(code))) : Promise.resolve(0);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let finished = false;
  try {
    for await (const line of lines) {
      if (line.length > 0) yield line;
    }
    finished = true;
  } finally {
    if (!finished) {
      lines.close();
      if (child) child.kill();
      else input.destroy();
    }
  }
  const code = await exited;
  if (code !== 0) throw new Error(`unzip -p ${member} exited ${code}: ${stderr.trim().slice(0, 300)}`);
}

/**
 * Summarize improvement details per decoded PROP_ID.
 *
 * @param {AsyncIterable<string>} lines - `IMP_DET.TXT` lines.
 * @returns {Promise<{ byProp: Map<string, { yr_built: string, living_area_sqft: string, imprv_count: string }>, records: number, badLength: number }>} Summary.
 */
export async function summarizeImprovementDetails(lines) {
  /** @type {Map<string, { livingYears: number[], allYears: number[], area: number, improvements: Set<string> }>} */
  const acc = new Map();
  let records = 0;
  let badLength = 0;
  const living = new Set(LIVING_AREA_DETAIL_TYPES);
  for await (const line of lines) {
    records += 1;
    if (line.length !== IMP_DET_RECORD_LENGTH) {
      badLength += 1;
      continue;
    }
    const record = readRecord(line, IMP_DET_FIELDS);
    const propId = record.prop_id;
    if (!propId || propId === "0") continue;
    const entry = acc.get(propId) ?? { livingYears: [], allYears: [], area: 0, improvements: new Set() };
    entry.improvements.add(record.imprv_id);
    const year = Number(record.yr_built);
    const validYear = Number.isInteger(year) && year >= 1800 && year <= 2100;
    const isLiving = living.has(record.imprv_det_type_cd.toUpperCase());
    if (validYear) {
      entry.allYears.push(year);
      if (isLiving) entry.livingYears.push(year);
    }
    const area = Number(record.imprv_det_area);
    if (isLiving && Number.isFinite(area) && area > 0) entry.area += area;
    acc.set(propId, entry);
  }
  const byProp = new Map();
  for (const [propId, entry] of acc) {
    const years = entry.livingYears.length > 0 ? entry.livingYears : entry.allYears;
    byProp.set(propId, {
      yr_built: years.length > 0 ? String(Math.min(...years)) : "",
      living_area_sqft: entry.area > 0 ? String(entry.area) : "",
      imprv_count: String(entry.improvements.size),
    });
  }
  return { byProp, records, badLength };
}

/**
 * @param {AsyncIterable<string>} lines - `ABS_SUBD.TXT` lines.
 * @returns {Promise<Map<string, string>>} Code to description.
 */
export async function readAbstractSubdivisions(lines) {
  const map = new Map();
  for await (const line of lines) {
    const record = readRecord(line, ABS_SUBD_FIELDS);
    if (record.abs_subdv_cd) map.set(record.abs_subdv_cd, record.abs_subdv_desc);
  }
  return map;
}

/**
 * Page the TNR "TCAD Parcels" MapServer layer (GeoJSON, WGS84, ordered by
 * OBJECTID), writing every response and a receipt per page. Requires US
 * egress; never retries a refusal.
 *
 * @param {{ cacheDir: string, pageSize?: number, fetchImpl?: typeof fetch, snapshotAt?: string, delayMs?: number }} options - Cache directory and seams.
 * @returns {Promise<{ pages: number, features: number }>} Counts.
 */
export async function pageTnrLayer({ cacheDir, pageSize = 1000, fetchImpl = globalThis.fetch, snapshotAt = new Date().toISOString(), delayMs = 500 }) {
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
      orderByFields: ["OBJECTID ASC"],
      f: ["geojson"],
      resultOffset: [String(offset)],
      resultRecordCount: [String(pageSize)],
    };
    const query = new URLSearchParams(Object.entries(multiValueQueryString).map(([key, values]) => [key, values[0]]));
    const url = `${TNR_PARCEL_LAYER_QUERY_URL}?${query.toString()}`;
    const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`TNR query HTTP ${response.status} at offset ${offset}`);
    const text = await response.text();
    const body = JSON.parse(text);
    if (body.error) throw new Error(`TNR query error at offset ${offset}: ${JSON.stringify(body.error).slice(0, 200)}`);
    const pageName = `page-${String(pages).padStart(5, "0")}`;
    await writeFile(path.join(cacheDir, `${pageName}.json`), text, "utf8");
    await writeFile(
      path.join(cacheDir, `${pageName}.receipt.json`),
      `${JSON.stringify({ request: { method: "GET", url: TNR_PARCEL_LAYER_QUERY_URL, multiValueQueryString }, status: response.status, byteLength: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex"), snapshotAt }, null, 2)}\n`,
      "utf8",
    );
    const count = Array.isArray(body.features) ? body.features.length : 0;
    pages += 1;
    features += count;
    const exceeded = body.exceededTransferLimit ?? body.properties?.exceededTransferLimit;
    if (count < pageSize || exceeded === false) break;
    offset += count;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { pages, features };
}

/**
 * Read cached TNR pages into per-PROP_ID geometry with the page request that returned it.
 *
 * @param {string} cacheDir - Directory written by {@link pageTnrLayer}.
 * @returns {Promise<{ byProp: Map<string, { geometries: unknown[], objectIds: string[], geoIds: string[], request: object, snapshotAt: string }>, features: number, featuresWithoutPropId: number, pages: number }>} Features by PROP_ID and counts.
 */
export async function readTnrCache(cacheDir) {
  const byProp = new Map();
  let features = 0;
  let featuresWithoutPropId = 0;
  const names = (await readdir(cacheDir)).filter((name) => /^page-\d{5}\.json$/.test(name)).sort();
  for (const name of names) {
    const page = JSON.parse(await readFile(path.join(cacheDir, name), "utf8"));
    const receipt = JSON.parse(await readFile(path.join(cacheDir, name.replace(".json", ".receipt.json")), "utf8"));
    for (const feature of page.features ?? []) {
      features += 1;
      const raw = feature.properties?.PROP_ID;
      const propId = raw === null || raw === undefined ? null : decodePropId(String(raw));
      if (!propId) {
        featuresWithoutPropId += 1;
        continue;
      }
      const entry = byProp.get(propId) ?? { geometries: [], objectIds: [], geoIds: [], request: receipt.request, snapshotAt: receipt.snapshotAt };
      entry.geometries.push(feature.geometry);
      entry.objectIds.push(toText(feature.id ?? feature.properties?.OBJECTID));
      entry.geoIds.push(toText(feature.properties?.geo_id));
      byProp.set(propId, entry);
    }
  }
  return { byProp, features, featuresWithoutPropId, pages: names.length };
}

/**
 * Decode one real-property PROP.TXT record into the canonical TCAD fields.
 * An owner flagged confidential or address-suppressed by the roll keeps no
 * name and no mailing address in the seed.
 *
 * @param {Record<string, string>} record - `readRecord(line, PROP_FIELDS)` with `prop_id` decoded.
 * @param {{ improvements: Map<string, { yr_built: string, living_area_sqft: string, imprv_count: string }>, subdivisions: Map<string, string> }} joins - IMP_DET and ABS_SUBD lookups.
 * @returns {{ tcad: Record<string, string>, confidential: boolean }} Canonical fields.
 */
export function toCanonicalTcad(record, { improvements, subdivisions }) {
  const confidential = record.py_confidential_flag === "T" || record.py_address_suppress_flag === "T";
  const extra = improvements.get(record.prop_id) ?? { yr_built: "", living_area_sqft: "", imprv_count: "0" };
  const owner = (value) => (confidential ? "" : value);
  const tcad = {
    prop_id: record.prop_id,
    geo_id: record.geo_id,
    prop_type_cd: record.prop_type_cd,
    state_cd: record.imprv_state_cd || record.land_state_cd,
    imprv_state_cd: record.imprv_state_cd,
    land_state_cd: record.land_state_cd,
    py_owner_name: owner(record.py_owner_name),
    py_addr_line1: owner(record.py_addr_line1),
    py_addr_line2: owner(record.py_addr_line2),
    py_addr_line3: owner(record.py_addr_line3),
    py_addr_city: owner(record.py_addr_city),
    py_addr_state: owner(record.py_addr_state),
    py_addr_zip: owner(record.py_addr_zip),
    owner_confidential: confidential ? "T" : "F",
    situs_num: record.situs_num,
    situs_street_prefx: record.situs_street_prefx,
    situs_street: record.situs_street,
    situs_street_suffix: record.situs_street_suffix,
    situs_unit: record.situs_unit,
    situs_city: record.situs_city,
    situs_zip: record.situs_zip,
    legal_desc: record.legal_desc,
    legal_desc2: record.legal_desc2,
    legal_acreage: record.legal_acreage,
    hood_cd: record.hood_cd,
    abs_subdv_cd: record.abs_subdv_cd,
    abs_subdv_desc: subdivisions.get(record.abs_subdv_cd) ?? "",
    block: record.block,
    tract_or_lot: record.tract_or_lot,
    land_hstd_val: record.land_hstd_val,
    land_non_hstd_val: record.land_non_hstd_val,
    imprv_hstd_val: record.imprv_hstd_val,
    imprv_non_hstd_val: record.imprv_non_hstd_val,
    ag_use_val: record.ag_use_val,
    appraised_val: record.appraised_val,
    assessed_val: record.assessed_val,
    market_value: record.market_value,
    deed_book_id: record.deed_book_id,
    deed_book_page: record.deed_book_page,
    deed_dt: record.deed_dt,
    yr_built: extra.yr_built,
    imprv_count: extra.imprv_count,
    living_area_sqft: extra.living_area_sqft,
    tax_year: record.prop_val_yr,
  };
  return { tcad, confidential };
}

/**
 * CSV writer with backpressure (rows are never concatenated into one string).
 *
 * @param {string} filePath - Destination.
 * @returns {{ write: (row: Record<string, string>) => Promise<void>, close: () => Promise<void> }} Writer.
 */
function csvWriter(filePath) {
  const stream = createWriteStream(filePath, { encoding: "utf8" });
  const writeLine = (line) =>
    new Promise((resolve, reject) => {
      stream.once("error", reject);
      if (stream.write(`${line}\n`)) {
        stream.off("error", reject);
        resolve(undefined);
      } else {
        stream.once("drain", () => {
          stream.off("error", reject);
          resolve(undefined);
        });
      }
    });
  let headerWritten = false;
  const header = () => SEED_COLUMNS.map(encodeCsvCell).join(",");
  return {
    async write(row) {
      if (!headerWritten) {
        await writeLine(header());
        headerWritten = true;
      }
      await writeLine(SEED_COLUMNS.map((column) => encodeCsvCell(row[column] ?? "")).join(","));
    },
    async close() {
      if (!headerWritten) await writeLine(header());
      await new Promise((resolve, reject) => stream.end((error) => (error ? reject(error) : resolve(undefined))));
    },
  };
}

/**
 * @param {object} feature - Per-PROP_ID TNR entry, or null.
 * @returns {object | null} The `tnr` block for {@link toSeedRow}.
 */
function tnrBlock(feature) {
  return feature
    ? { geometry: mergeGeometries(feature.geometries), objectId: feature.objectIds.join("|"), request: feature.request, snapshotAt: feature.snapshotAt }
    : null;
}

/**
 * Build the Travis seed from the export and the TNR cache.
 *
 * @param {object} options - Script inputs (see the module doc).
 * @returns {Promise<object>} Seed manifest (also written beside the seed).
 */
export async function buildTravisSeed(options) {
  assertSafeSourceFields(TCAD_SOURCE_FIELDS);
  const source = { exportDir: options.exportDir ?? null, exportArchive: options.exportArchive ?? null };
  const snapshotAt = options.snapshotAt ?? new Date().toISOString();
  let archiveSha256 = null;
  if (options.exportArchive) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(options.exportArchive)) hash.update(chunk);
    archiveSha256 = hash.digest("hex");
  }
  const request = { method: "GET", url: options.exportUrl, multiValueQueryString: {} };
  const snapshot = {
    sourceItemId: options.exportArchive ? path.basename(options.exportArchive) : "PROP.TXT",
    sourceRevision: archiveSha256 ?? "unarchived-export",
    snapshotAt,
  };

  const improvements = await summarizeImprovementDetails(streamMemberLines({ ...source, member: "IMP_DET.TXT" }));
  const subdivisions = await readAbstractSubdivisions(streamMemberLines({ ...source, member: "ABS_SUBD.TXT" }));
  const tnr = await readTnrCache(options.tnrCache);

  await mkdir(path.dirname(options.output), { recursive: true });
  const writer = csvWriter(options.output);
  const recordsByType = {};
  const recordsByYear = {};
  const seen = new Set();
  const foldedPropIds = new Set();
  const index = [];
  const geoIds = [];
  let records = 0;
  let rollRows = 0;
  let rowsWritten = 0;
  let invalidPropIds = 0;
  let foldedOwnerRecords = 0;
  let confidentialOwners = 0;
  let gisJoined = 0;
  for await (const line of streamMemberLines({ ...source, member: "PROP.TXT" })) {
    records += 1;
    if (line.length !== PROP_RECORD_LENGTH) {
      throw new Error(`PROP.TXT record ${records} has length ${line.length}, expected ${PROP_RECORD_LENGTH} (layout ${LAYOUT_VERSION})`);
    }
    const record = readRecord(line, PROP_FIELDS);
    const type = record.prop_type_cd || "(blank)";
    recordsByType[type] = (recordsByType[type] ?? 0) + 1;
    recordsByYear[record.prop_val_yr] = (recordsByYear[record.prop_val_yr] ?? 0) + 1;
    if (record.prop_type_cd !== "R") continue;
    rollRows += 1;
    const propId = decodePropId(line.slice(0, 12));
    if (!propId) {
      invalidPropIds += 1;
      continue;
    }
    if (seen.has(propId)) {
      foldedOwnerRecords += 1;
      foldedPropIds.add(propId);
      continue;
    }
    seen.add(propId);
    const { tcad, confidential } = toCanonicalTcad({ ...record, prop_id: propId }, { improvements: improvements.byProp, subdivisions });
    if (confidential) confidentialOwners += 1;
    const feature = tnr.byProp.get(propId) ?? null;
    if (feature) gisJoined += feature.geometries.length;
    const row = toSeedRow({
      tcad,
      request,
      snapshot,
      tnr: tnrBlock(feature),
      sourceRecordCount: feature ? feature.geometries.length : 0,
      sourceObjectIds: feature ? feature.objectIds.join("|") : "",
    });
    await writer.write(row);
    rowsWritten += 1;
    geoIds.push(row.geo_id);
    index.push({ parcel_id: row.parcel_id, geo_id: row.geo_id, source_state_cd: row.source_state_cd, latitude: row.latitude, longitude: row.longitude });
  }
  await writer.close();

  const gisFeaturesWithPropId = tnr.features - tnr.featuresWithoutPropId;
  const stats = {
    rollRows,
    rowsWritten,
    uniquePropIds: seen.size,
    invalidPropIds,
    foldedOwnerRecords,
    gisFeatures: gisFeaturesWithPropId,
    gisJoined,
    gisUnjoined: gisFeaturesWithPropId - gisJoined,
  };
  assertSeedReconciliation(stats);

  let pilot = null;
  if (options.pilotOutput) {
    const permitGeoIds = new Set(
      options.permitGeoIds
        ? (await readFile(options.permitGeoIds, "utf8")).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
        : [],
    );
    const selected = selectPilotRows(index, { size: options.pilotSize ?? 25, permitGeoIds });
    const wanted = new Map(selected.map((item, position) => [item.parcel_id, position]));
    const pilotRows = new Array(selected.length).fill(null);
    const pilotSeen = new Set();
    for await (const line of streamMemberLines({ ...source, member: "PROP.TXT" })) {
      if (pilotSeen.size === wanted.size) break;
      if (readField(line, PROP_FIELDS.prop_type_cd) !== "R") continue;
      const propId = decodePropId(line.slice(0, 12));
      if (!propId || !wanted.has(propId) || pilotSeen.has(propId)) continue;
      pilotSeen.add(propId);
      const record = readRecord(line, PROP_FIELDS);
      const { tcad } = toCanonicalTcad({ ...record, prop_id: propId }, { improvements: improvements.byProp, subdivisions });
      const feature = tnr.byProp.get(propId) ?? null;
      pilotRows[wanted.get(propId)] = toSeedRow({
        tcad,
        request,
        snapshot,
        tnr: tnrBlock(feature),
        sourceRecordCount: feature ? feature.geometries.length : 0,
        sourceObjectIds: feature ? feature.objectIds.join("|") : "",
      });
    }
    const pilotWriter = csvWriter(options.pilotOutput);
    for (const row of pilotRows) if (row) await pilotWriter.write(row);
    await pilotWriter.close();
    pilot = { path: options.pilotOutput, size: pilotRows.filter(Boolean).length, propIds: selected.map((item) => item.parcel_id) };
  }

  const rowsWithGeometry = index.filter((item) => item.latitude !== "").length;
  const manifest = {
    schemaVersion: "travis.seed-manifest.v2",
    builtAt: snapshotAt,
    layoutVersion: LAYOUT_VERSION,
    exportUrl: options.exportUrl,
    exportArchive: options.exportArchive ? path.basename(options.exportArchive) : null,
    exportArchiveSha256: archiveSha256,
    fieldPositions: { PROP: PROP_FIELDS, IMP_DET: IMP_DET_FIELDS, ABS_SUBD: ABS_SUBD_FIELDS },
    livingAreaDetailTypes: LIVING_AREA_DETAIL_TYPES,
    counts: {
      propRecords: records,
      propRecordsByType: recordsByType,
      propRecordsByYear: recordsByYear,
      ...stats,
      assessedParcelCount: rowsWritten,
      confidentialOwners,
      foldedOwnerPropIds: foldedPropIds.size,
      improvementDetailRecords: improvements.records,
      improvementDetailBadLength: improvements.badLength,
      propertiesWithImprovementDetails: improvements.byProp.size,
      subdivisionCodes: subdivisions.size,
      gisFeatureCount: tnr.features,
      gisFeaturesWithoutPropId: tnr.featuresWithoutPropId,
      gisPages: tnr.pages,
      gisDistinctPropIds: tnr.byProp.size,
      rowsWithGeometry,
      rowsWithoutGeometry: rowsWritten - rowsWithGeometry,
    },
    tcadIdNormalizationProof: proveDigitsOnlyNormalization(geoIds),
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
  for (const required of ["export-url", "tnr-cache", "output"]) {
    if (!flags[required]) throw new Error(`--${required} is required`);
  }
  if (!flags["export-archive"] && !flags["export-dir"]) throw new Error("--export-archive or --export-dir is required");
  if (flags["fetch-tnr"] === true) {
    const paged = await pageTnrLayer({ cacheDir: flags["tnr-cache"] });
    console.error(JSON.stringify({ event: "tnr_paged", ...paged }));
  }
  const manifest = await buildTravisSeed({
    exportArchive: flags["export-archive"] ?? null,
    exportDir: flags["export-dir"] ?? null,
    exportUrl: flags["export-url"],
    tnrCache: flags["tnr-cache"],
    output: flags.output,
    pilotOutput: flags["pilot-output"] ?? null,
    pilotSize: flags["pilot-size"] ? Number(flags["pilot-size"]) : 25,
    permitGeoIds: flags["permit-geo-ids"] ?? null,
  });
  const { fieldPositions, ...summary } = manifest;
  void fieldPositions;
  console.log(JSON.stringify({ event: "travis_seed_complete", ...summary }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
