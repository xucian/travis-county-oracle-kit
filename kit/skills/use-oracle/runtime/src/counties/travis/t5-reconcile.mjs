#!/usr/bin/env node
/**
 * T5 phase B reconciliation (assignment decisions.md section 2 item 5 and section 27; kit `county-ingest-run` section 8,
 * `query-db-loading-matching`): reads a finished T5 run directory, its Loader generation, the seed and the published
 * CARs, and reports what the run record alone does not show. Read-only; offline; a few minutes on the full run.
 *
 * - **Dead accounts.** Every dead tombstone with its seed facts and a reason class: `no_situs_street` split into
 *   `nothing_printed`, `number_only` and `columns_shifted` (the street printed one column to the right: name in the
 *   suffix column, suffix in the unit column), and `outside_validation_bbox` with the distance past the box, whether the
 *   centroid or only polygon vertices lie outside it, and the TNR layer's own extent; the shard of each; the permits
 *   linked to dead accounts (internal only).
 * - **Shards without a group.** For every shard with no Property Improvement archive: its linked permits (from the link
 *   pass), the permits that print one of its accounts' geo_ids and how they were linked, and how many roll accounts share
 *   each such geo_id.
 * - **Sizes.** Every archive CAR parsed block by block (CARv1: varint section length, CID, data), checked against the
 *   recorded size and block count; table parts and the tables index per group; distinct bytes and the bytes Filebase
 *   counts (each archive root, each part and each tables root pinned: 2 x (archive blocks + parts) + index, the formula of
 *   decisions.md 25.9 that reproduces the T2 pilot's 505,699 counted bytes); blocks shared by both groups.
 * - **Roof-age anchors.** The parcels T4's link-pass rule anchors (completed primary-roof replacement or new
 *   construction with a confirmed `completed_date`) against the estimator's anchors in the run, with the date field used.
 * - **The rulings of decisions.md 27.9 and 27.10.** Every seed account with a point outside the API contract's rounded box
 *   (`county_line`) and every seed row in the shifted situs-columns pattern (`situs_columns_shifted`, the transform's
 *   own reader), with its state in the run: ready (and, for the shifted ones, flagged in its sidecar) or dead.
 * - **Checks.** `seed = ready + dead + invalid`; link outcomes and evidence states sum to the capture; published permits
 *   and Property Improvement properties against linked ones less those on dead accounts; geometry rows against the
 *   seed's points and polygon parts; the run record's limitations recomputed from its own counts, plus what they miss.
 *
 *   node --max-old-space-size=8192 src/counties/travis/t5-reconcile.mjs --run data/travis/runs/<run_id> [--out <file>]
 *
 * @module counties/travis/t5-reconcile
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readShiftedSitusColumns } from "../../../counties/travis/transforms/transform.mjs";
import { RUNTIME_ROOT } from "./t3-snapshot.mjs";
import { readLines, sha256File, streamCsvRecords } from "./t5-shards.mjs";
import { TRAVIS_VALIDATION_BBOX } from "./validate.mjs";

export const T5_RECONCILE_VERSION = "travis-t5-reconcile.v2";
/** The API contract's rounded box, which the T5 full run's guard used before decisions.md 27.9. */
export const TRAVIS_CONTRACT_BBOX = Object.freeze({ minLat: 30.02, maxLat: 30.63, minLng: -98.17, maxLng: -97.37 });
const METERS_PER_DEGREE_LAT = 111_320;
const rel = (target) => path.relative(RUNTIME_ROOT, target).split(path.sep).join("/");
const bump = (map, key, by = 1) => {
  map[key] = (map[key] ?? 0) + by;
};

/**
 * Read one unsigned varint.
 *
 * @param {Uint8Array} bytes - Buffer.
 * @param {number} at - Offset.
 * @returns {[number, number]} Value and the next offset.
 */
export function readVarint(bytes, at) {
  let value = 0;
  let shift = 0;
  let byte;
  do {
    if (at >= bytes.length) throw new Error("truncated varint");
    byte = bytes[at];
    at += 1;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return [value, at];
}

/**
 * The byte length of the CIDv1 at the start of a CAR section (version, codec, multihash code, digest length, digest).
 *
 * @param {Uint8Array} section - Section bytes.
 * @returns {number} CID length.
 */
export function cidLength(section) {
  let [, at] = readVarint(section, 0);
  [, at] = readVarint(section, at);
  [, at] = readVarint(section, at);
  const [digestLength, digestAt] = readVarint(section, at);
  return digestAt + digestLength;
}

/**
 * Walk a CARv1 file: every block's CID key (a short digest of the CID bytes) and data length.
 *
 * @param {string} file - CAR file.
 * @param {(key: string, dataBytes: number) => void} [onBlock] - Per block.
 * @returns {Promise<{ size: number, blocks: number, data_bytes: number, framing_bytes: number }>} Totals.
 */
export async function walkCar(file, onBlock = () => {}) {
  const handle = await open(file, "r");
  try {
    const size = (await handle.stat()).size;
    let buffer = Buffer.alloc(0);
    let position = 0;
    const fill = async (need) => {
      while (buffer.length < need && position < size) {
        const chunk = Buffer.alloc(Math.min(1 << 24, size - position));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        position += bytesRead;
        buffer = Buffer.concat([buffer, chunk.subarray(0, bytesRead)]);
      }
    };
    await fill(16);
    const [headerLength, headerAt] = readVarint(buffer, 0);
    await fill(headerAt + headerLength);
    buffer = buffer.subarray(headerAt + headerLength);
    let blocks = 0;
    let dataBytes = 0;
    for (;;) {
      await fill(16);
      if (buffer.length === 0) break;
      const [length, at] = readVarint(buffer, 0);
      await fill(at + length);
      if (buffer.length < at + length) throw new Error(`${file}: truncated block section`);
      const section = buffer.subarray(at, at + length);
      const cid = cidLength(section);
      blocks += 1;
      dataBytes += length - cid;
      onBlock(createHash("sha1").update(section.subarray(0, cid)).digest("base64").slice(0, 16), length - cid);
      buffer = buffer.subarray(at + length);
    }
    return { size, blocks, data_bytes: dataBytes, framing_bytes: size - dataBytes };
  } finally {
    await handle.close();
  }
}

/**
 * Class of a dead account the transform refused for its blank situs street.
 *
 * @param {Record<string, string>} row - Seed row (`source_situs_*`).
 * @returns {"nothing_printed" | "number_only" | "columns_shifted" | "other_parts"} Class.
 */
export function classifyNoSitus(row) {
  const value = (name) => String(row[`source_situs_${name}`] ?? "").trim();
  if (value("street") !== "") return "other_parts";
  const suffix = value("street_suffix");
  const unit = value("unit");
  // The street printed one column to the right (its name in the suffix column, its suffix word in the unit column),
  // exactly as the transform reads it (situs columns v1, decisions.md 27.10).
  if (readShiftedSitusColumns(Object.fromEntries(["num", "street_prefx", "street", "street_suffix", "unit"].map((name) => [`situs_${name}`, value(name)])))) return "columns_shifted";
  if (value("num") !== "" && suffix === "" && value("street_prefx") === "") return "number_only";
  if (value("num") === "" && suffix === "" && value("street_prefx") === "" && unit === "") return "nothing_printed";
  return "other_parts";
}

/**
 * Every [longitude, latitude] pair of a GeoJSON polygon or multipolygon (or a bare coordinate array).
 *
 * @param {unknown} polygon - Parsed `parcel_polygon`.
 * @returns {[number, number][]} Vertices.
 */
export function polygonVertices(polygon) {
  const out = [];
  const walk = (value) => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === "number" && typeof value[1] === "number") out.push([value[0], value[1]]);
    else for (const item of value) walk(item);
  };
  walk(polygon && typeof polygon === "object" && !Array.isArray(polygon) ? /** @type {any} */ (polygon).coordinates : polygon);
  return out;
}

/**
 * How far a point lies outside a box, in metres (0 inside).
 *
 * @param {number} latitude - Latitude.
 * @param {number} longitude - Longitude.
 * @param {{ minLat: number, maxLat: number, minLng: number, maxLng: number }} [box] - Box.
 * @returns {number} Metres.
 */
export function metresOutside(latitude, longitude, box = TRAVIS_VALIDATION_BBOX) {
  const dLat = Math.max(box.minLat - latitude, latitude - box.maxLat, 0) * METERS_PER_DEGREE_LAT;
  const dLng = Math.max(box.minLng - longitude, longitude - box.maxLng, 0) * METERS_PER_DEGREE_LAT * Math.cos((latitude * Math.PI) / 180);
  return Math.round(Math.hypot(dLat, dLng));
}

/** @param {string} file @returns {Promise<any>} */
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

/**
 * Reconcile a finished T5 run.
 *
 * @param {{ runDir: string, seedPath?: string }} options - Run directory (and the roll seed, default the run's own).
 * @returns {Promise<Record<string, any>>} Report.
 */
export async function reconcileRun({ runDir, seedPath = null }) {
  const started = Date.now();
  const record = await readJson(path.join(runDir, "run.json"));
  const plan = (await readJson(path.join(runDir, "global", "plan.done.json"))).output;
  const linkMarker = await readJson(path.join(runDir, "global", "link.done.json"));
  const linkDir = path.join(runDir, "global", linkMarker.output.dir);
  const seed = seedPath ?? path.join(RUNTIME_ROOT, record.inputs.seed.path);
  const generation = path.join(RUNTIME_ROOT, record.loader.generation);
  const shardOf = (propId) => plan.shards.find((shard) => Number(propId) >= Number(shard.first) && Number(propId) <= Number(shard.last))?.id ?? null;

  // Tombstones of the generation, and the shards whose Property Improvement group was skipped.
  const tombstones = (await readFile(path.join(generation, "tombstones.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const deadKeys = new Set(tombstones.filter((item) => item.reason === "dead").map((item) => item.key));
  const groupless = record.shards.per_shard.filter((shard) => shard.property_improvement_root === null).map((shard) => shard.id);
  /** @type {Map<string, string>} geo_id -> shard, for the accounts of the group-less shards */
  const grouplessGeo = new Map();
  const grouplessFacts = {};
  for (const id of groupless) {
    const shardDir = path.join(runDir, "shards", id);
    const permits = (await readJson(path.join(shardDir, "permits.done.json"))).output;
    let header = null;
    let accounts = 0;
    let withGeo = 0;
    for await (const csv of streamCsvRecords(path.join(shardDir, "seed.csv"))) {
      if (!header) {
        header = csv.fields;
        continue;
      }
      accounts += 1;
      const geo = String(csv.fields[header.indexOf("geo_id")] ?? "").trim();
      if (geo) {
        withGeo += 1;
        grouplessGeo.set(geo, id);
      }
    }
    const shard = plan.shards.find((item) => item.id === id);
    grouplessFacts[id] = { accounts, prop_id_range: [Number(shard.first), Number(shard.last)], with_geo_id: withGeo, link_pass_rows: linkMarker.output.per_shard[id].rows, permit_states: permits.counts, linked: permits.linked, printed_geo_ids: {}, permits_printing_a_geo_id: 0, their_link_state: {} };
  }

  // One pass over the internal permits table: dead-account links, the group-less shards' printed geo_ids, T4's anchor rule.
  const deadPermits = {};
  const t4Anchored = new Set();
  let permitRows = 0;
  for await (const line of readLines(path.join(linkDir, "permits-internal.jsonl"))) {
    const row = JSON.parse(line);
    permitRows += 1;
    const propertyId = row.property_id ? String(row.property_id) : null;
    if (propertyId && deadKeys.has(propertyId)) {
      const entry = (deadPermits[propertyId] ??= { permits: 0, roofing: 0, open_roofing: 0, stalled_roofing: 0 });
      entry.permits += 1;
      if (row.is_roofing) {
        entry.roofing += 1;
        if (row.status_group === "open") entry.open_roofing += 1;
        if (row.status_group === "stalled") entry.stalled_roofing += 1;
      }
    }
    if (propertyId && (row.roof_work_class === "primary_roof_replacement" || row.roof_work_class === "primary_roof_new_construction") && row.lifecycle_status === "completed" && row.completed_date_evidence === "confirmed_present") t4Anchored.add(propertyId);
    const geo = String(row.tcad_id ?? "").trim();
    const id = grouplessGeo.get(geo);
    if (id) {
      const facts = grouplessFacts[id];
      facts.permits_printing_a_geo_id += 1;
      bump(facts.printed_geo_ids, geo);
      bump(facts.their_link_state, row.unlinked_reason ?? `linked:${row.match_method}`);
    }
  }

  // One pass over the seed: dead rows, holders of the printed geo_ids, geometry of the whole roll and of the dead.
  const printed = new Set(Object.values(grouplessFacts).flatMap((facts) => Object.keys(facts.printed_geo_ids)));
  /** @type {Map<string, number[]>} */
  const holders = new Map();
  const deadRows = new Map();
  const countyLine = [];
  const shifted = [];
  const extent = { minLat: 90, maxLat: -90, minLng: 180, maxLng: -180 };
  const geometry = { seed_rows: 0, with_point: 0, multi_part_parcels: 0, multi_part_parts: 0, dead_with_point: 0, dead_multi_part_parcels: 0, dead_multi_part_parts: 0 };
  let header = null;
  for await (const csv of streamCsvRecords(seed)) {
    if (!header) {
      header = csv.fields;
      continue;
    }
    const row = Object.fromEntries(header.map((name, index) => [name, csv.fields[index]]));
    geometry.seed_rows += 1;
    const isDead = deadKeys.has(row.parcel_id);
    const latitude = Number(row.latitude);
    const longitude = Number(row.longitude);
    if (row.latitude && Number.isFinite(latitude)) {
      geometry.with_point += 1;
      if (isDead) geometry.dead_with_point += 1;
      extent.minLat = Math.min(extent.minLat, latitude);
      extent.maxLat = Math.max(extent.maxLat, latitude);
      extent.minLng = Math.min(extent.minLng, longitude);
      extent.maxLng = Math.max(extent.maxLng, longitude);
    }
    let vertices = [];
    if (row.parcel_polygon) {
      try {
        const polygon = JSON.parse(row.parcel_polygon);
        const coordinates = polygon?.coordinates ?? polygon;
        const multi = polygon?.type ? polygon.type === "MultiPolygon" : Array.isArray(coordinates?.[0]?.[0]?.[0]);
        const parts = multi && Array.isArray(coordinates) ? coordinates.length : 0;
        if (parts > 1) {
          geometry.multi_part_parcels += 1;
          geometry.multi_part_parts += parts;
          if (isDead) {
            geometry.dead_multi_part_parcels += 1;
            geometry.dead_multi_part_parts += parts;
          }
        }
        if (isDead) row.__polygon = polygon;
        vertices = polygonVertices(polygon);
      } catch {
        // an unparsable polygon is the seed's concern (T1); counted as no polygon here
      }
    }
    // The county line (27.9): any point past the contract's rounded box, and whether the validation box holds it.
    const centroidOutside = row.latitude && Number.isFinite(latitude) ? metresOutside(latitude, longitude, TRAVIS_CONTRACT_BBOX) : 0;
    let verticesOutside = 0;
    let maxOutside = centroidOutside;
    let insideValidation = !row.latitude || !Number.isFinite(latitude) || metresOutside(latitude, longitude) === 0;
    for (const [lng, lat] of vertices) {
      const metres = metresOutside(lat, lng, TRAVIS_CONTRACT_BBOX);
      if (metres > 0) {
        verticesOutside += 1;
        if (metres > maxOutside) maxOutside = metres;
        if (metresOutside(lat, lng) > 0) insideValidation = false;
      }
    }
    if (centroidOutside > 0 || verticesOutside > 0) countyLine.push({ prop_id: row.parcel_id, centroid_metres_outside: centroidOutside, vertices: vertices.length, vertices_outside: verticesOutside, max_metres_outside: maxOutside, inside_validation_box: insideValidation });
    const tcadSitus = Object.fromEntries(["num", "street_prefx", "street", "street_suffix", "unit"].map((name) => [`situs_${name}`, row[`source_situs_${name}`] ?? ""]));
    const reading = readShiftedSitusColumns(tcadSitus);
    if (reading) shifted.push({ prop_id: row.parcel_id, printed: reading.printed, read_as: reading.read_as, address: row.address ?? null });
    if (isDead) deadRows.set(row.parcel_id, row);
    const geo = String(row.geo_id ?? "").trim();
    if (printed.has(geo)) (holders.get(geo) ?? holders.set(geo, []).get(geo)).push(Number(row.parcel_id));
  }

  // The dead accounts, classified.
  const dead = tombstones
    .filter((item) => item.reason === "dead")
    .map((item) => {
      const row = deadRows.get(item.key) ?? {};
      const base = { prop_id: item.key, shard: shardOf(item.key), geo_id: row.geo_id ?? null, situs_zip: row.source_situs_zip || null, evidence: item.evidence, linked_permits: deadPermits[item.key] ?? null };
      if (/no situs address/.test(item.evidence ?? "")) {
        const parts = Object.fromEntries(["num", "street_prefx", "street", "street_suffix", "unit"].map((name) => [name, row[`source_situs_${name}`] ?? ""]));
        return { ...base, reason: "no_situs_street", class: classifyNoSitus(row), printed_situs: parts, source_fact: classifyNoSitus(row) !== "columns_shifted" };
      }
      if (/outside the Travis bbox/.test(item.evidence ?? "")) {
        const vertices = polygonVertices(row.__polygon);
        const centroid = row.latitude ? [Number(row.latitude), Number(row.longitude)] : null;
        const outside = vertices.filter(([lng, lat]) => metresOutside(lat, lng) > 0);
        return { ...base, reason: "outside_validation_bbox", situs: row.address ?? null, centroid, centroid_metres_outside: centroid ? metresOutside(centroid[0], centroid[1]) : null, vertices: vertices.length, vertices_outside: outside.length, max_metres_outside: vertices.length ? Math.max(...vertices.map(([lng, lat]) => metresOutside(lat, lng))) : null, source_fact: false };
      }
      return { ...base, reason: "other", source_fact: null };
    });
  const byClass = {};
  for (const item of dead) bump(byClass, item.class ? `${item.reason}:${item.class}` : item.reason);
  const deadPermitTotals = Object.values(deadPermits).reduce((sum, item) => ({ permits: sum.permits + item.permits, roofing: sum.roofing + item.roofing, open_roofing: sum.open_roofing + item.open_roofing, stalled_roofing: sum.stalled_roofing + item.stalled_roofing }), { permits: 0, roofing: 0, open_roofing: 0, stalled_roofing: 0 });
  for (const facts of Object.values(grouplessFacts)) {
    const geos = Object.keys(facts.printed_geo_ids);
    facts.printed_geo_ids = geos.map((geo) => ({ geo_id: geo, permits: facts.printed_geo_ids[geo], accounts_sharing_it: holders.get(geo)?.length ?? 0, prop_ids: (holders.get(geo) ?? []).sort((left, right) => left - right) }));
    facts.every_printed_geo_id_is_shared = facts.printed_geo_ids.every((item) => item.accounts_sharing_it > 1);
  }

  // The accounts of the 27.9 and 27.10 rulings: ready or dead in this run (and the shifted ones' sidecar flag).
  const appraisalOf = new Map();
  for (const shard of plan.shards) appraisalOf.set(shard.id, (await readJson(path.join(runDir, "shards", shard.id, "appraisal.done.json"))).output);
  const stateOf = async (propId, { sidecar = false } = {}) => {
    const shard = shardOf(propId);
    const output = appraisalOf.get(shard);
    const ready = Boolean(output?.parcels?.[propId]);
    const out = { shard, state: ready ? "ready" : deadKeys.has(propId) ? "dead" : "absent" };
    if (sidecar && ready) {
      const file = path.join(runDir, "shards", shard, output.dir, propId, "source-payload.json");
      out.sidecar_flag = existsSync(file) ? (await readJson(file)).situs_columns_shifted?.version ?? null : null;
    }
    return out;
  };
  for (const item of countyLine) Object.assign(item, await stateOf(item.prop_id));
  for (const item of shifted) Object.assign(item, await stateOf(item.prop_id, { sidecar: true }));
  const rulings = {
    county_line: { box: TRAVIS_CONTRACT_BBOX, validation_box: TRAVIS_VALIDATION_BBOX, accounts: countyLine.length, ready: countyLine.filter((item) => item.state === "ready").length, dead: countyLine.filter((item) => item.state === "dead").length, all_inside_validation_box: countyLine.every((item) => item.inside_validation_box), list: countyLine },
    situs_columns_shifted: { seed_rows_matching: shifted.length, ready: shifted.filter((item) => item.state === "ready").length, sidecar_flagged: shifted.filter((item) => item.sidecar_flag).length, list: shifted },
  };

  // Sizes, per group, from the CARs themselves and the tables directories.
  const groups = {};
  const seenAll = new Set();
  let repeatedBlocks = 0;
  let repeatedBytes = 0;
  for (const car of record.cars.filter((item) => item.kind === "archive")) {
    const group = (groups[car.group] ??= { archives: 0, car_bytes: 0, blocks: 0, block_bytes: 0, framing_bytes: 0, tables_dirs: 0, parts: 0, parts_bytes: 0, index_bytes: 0 });
    const walked = await walkCar(path.join(RUNTIME_ROOT, car.path), (key, bytes) => {
      if (seenAll.has(key)) {
        repeatedBlocks += 1;
        repeatedBytes += bytes;
      } else seenAll.add(key);
    });
    if (walked.size !== car.size || walked.blocks !== car.block_count) throw new Error(`${car.path}: ${walked.size} bytes and ${walked.blocks} blocks, the run record says ${car.size} and ${car.block_count}`);
    group.archives += 1;
    group.car_bytes += walked.size;
    group.blocks += walked.blocks;
    group.block_bytes += walked.data_bytes;
    group.framing_bytes += walked.framing_bytes;
    const walk = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith(".parquet")) {
          group.parts += 1;
          group.parts_bytes += (await stat(full)).size;
        } else if (entry.name === "tables.car") group.index_bytes += (await stat(full)).size;
      }
    };
    // The tables directory the record names: a rerun whose CAR came out byte for byte the same keeps the earlier chain's.
    const tablesCar = record.cars.find((item) => item.kind === "tables" && item.group === car.group && item.shard === car.shard);
    await walk(path.join(RUNTIME_ROOT, tablesCar?.path ?? path.join(path.dirname(car.path), "tables")));
    group.tables_dirs += 1;
  }
  const gb = (bytes) => Math.round((bytes / 1e9) * 1000) / 1000;
  for (const group of Object.values(groups)) {
    group.distinct_bytes = group.block_bytes + group.parts_bytes + group.index_bytes;
    group.filebase_counted_bytes = 2 * (group.block_bytes + group.parts_bytes) + group.index_bytes;
    group.gb = { car: gb(group.car_bytes), blocks: gb(group.block_bytes), parts: gb(group.parts_bytes), distinct: gb(group.distinct_bytes), filebase_counted: gb(group.filebase_counted_bytes) };
  }
  const sum = (key) => Object.values(groups).reduce((total, group) => total + group[key], 0);
  const sizes = {
    method: "archive blocks parsed from each CAR; parts = the .parquet files of each tables directory; index = its tables.car; distinct = blocks + parts + index; Filebase counted = 2 x (blocks + parts) + index (decisions.md 25.9: the tables root DAG links the archive root and every part, each also pinned on its own)",
    groups,
    total: { car_bytes: sum("car_bytes"), block_bytes: sum("block_bytes"), parts_bytes: sum("parts_bytes"), distinct_bytes: sum("distinct_bytes"), filebase_counted_bytes: sum("filebase_counted_bytes"), gb: { car: gb(sum("car_bytes")), blocks: gb(sum("block_bytes")), parts: gb(sum("parts_bytes")), distinct: gb(sum("distinct_bytes")), filebase_counted: gb(sum("filebase_counted_bytes")) } },
    blocks_in_both_groups: { blocks: repeatedBlocks, bytes: repeatedBytes, note: "the property, address, parcel and Seed blocks a Property Improvement archive shares with its County archive (the same property CIDs)" },
    distinct_across_groups: { blocks: seenAll.size, bytes: sum("block_bytes") - repeatedBytes + sum("parts_bytes") + sum("index_bytes"), gb: gb(sum("block_bytes") - repeatedBytes + sum("parts_bytes") + sum("index_bytes")) },
  };

  // Roof-age anchors: T4's rule against the estimator.
  const estimator = new Map();
  const anchorField = {};
  for (const shard of plan.shards) {
    const marker = await readJson(path.join(runDir, "shards", shard.id, "reconcile.done.json"));
    for await (const line of readLines(path.join(runDir, "shards", shard.id, marker.output.dir, "roof-age.jsonl"))) {
      const item = JSON.parse(line);
      if (item.roof_age_basis !== "completed_replacement" && item.roof_age_basis !== "new_construction") continue;
      estimator.set(item.prop_id, item.roof_age_anchor?.date_field ?? null);
      bump(anchorField, item.roof_age_anchor?.date_field ?? "none");
    }
  }
  const onlyEstimator = [...estimator.keys()].filter((key) => !t4Anchored.has(key));
  const onlyT4 = [...t4Anchored].filter((key) => !estimator.has(key));
  const onlyEstimatorFields = {};
  for (const key of onlyEstimator) bump(onlyEstimatorFields, estimator.get(key) ?? "none");
  const anchors = {
    t4_rule: "completed primary-roof replacement or new construction with a confirmed completed_date (t4-permit-links.mjs)",
    t4_rule_parcels: t4Anchored.size,
    estimator_parcels: estimator.size,
    estimator_anchor_date_field: anchorField,
    only_estimator: onlyEstimator.length,
    only_estimator_by_date_field: onlyEstimatorFields,
    only_t4_rule: onlyT4.length,
    only_t4_rule_dead: onlyT4.filter((key) => deadKeys.has(key)).length,
    reconciles: t4Anchored.size - onlyT4.length + onlyEstimator.length === estimator.size,
  };

  // Checks over the record's own numbers.
  const a = record.counts.appraisal;
  const p = record.counts.permits;
  const reasons = Object.values(p.unlinked_reasons).reduce((total, value) => total + value, 0);
  const evidence = Object.fromEntries(Object.entries(record.evidence_states).map(([name, states]) => [name, Object.values(states).reduce((total, value) => total + value, 0)]));
  const tables = record.counts.tables;
  const checks = {
    seed_equals_ready_dead_invalid: a.seed === a.ready + a.dead + a.invalid,
    dead_tombstones_equal_dead: deadKeys.size === a.dead,
    links_sum_to_capture: p.linked + reasons === p.captured && p.captured === permitRows,
    evidence_states_sum_to_capture: Object.values(evidence).every((value) => value === p.captured),
    published_equals_linked_less_dead: p.published === p.linked - deadPermitTotals.permits,
    permit_parcels_equal_linked_less_dead: tables.property_improvement.property === p.linked_parcels - Object.keys(deadPermits).length,
    county_properties_equal_ready: tables.county.property === a.ready,
    geometry_points_equal_seed_less_dead: tables.county.address_has_geometry === geometry.with_point - geometry.dead_with_point,
    geometry_rows_equal_points_plus_parts: tables.county.geometry === tables.county.address_has_geometry + (geometry.multi_part_parts - geometry.dead_multi_part_parts),
    roof_age_parcels_equal_ready: record.roof_age.parcels === a.ready,
    roof_age_basis_sums: Object.values(record.roof_age.by_basis).reduce((total, value) => total + value, 0) === record.roof_age.parcels,
    every_archive_passed_car_validation: record.cars.filter((car) => car.kind === "archive").every((car) => car.car_validation?.passed && Object.entries(car.car_validation).filter(([key]) => key.endsWith("_errors")).every(([, value]) => value === 0)),
    group_less_shards_have_no_linked_permit: Object.values(grouplessFacts).every((facts) => facts.link_pass_rows === 0 && facts.permit_states.done === 0),
    county_line_accounts_ready: rulings.county_line.ready === rulings.county_line.accounts && rulings.county_line.all_inside_validation_box,
    shifted_situs_accounts_ready_and_flagged: rulings.situs_columns_shifted.ready === rulings.situs_columns_shifted.seed_rows_matching && rulings.situs_columns_shifted.sidecar_flagged === rulings.situs_columns_shifted.seed_rows_matching,
    every_dead_account_is_a_source_fact: dead.every((item) => item.source_fact === true),
  };

  // The limitations, recomputed from the record's own counts, and what they do not say.
  const roofing = p.roofing;
  const limitation = (reason) => record.limitations.find((item) => item.incomplete_reason === reason)?.detail ?? "";
  const has = (reason, ...numbers) => numbers.every((number) => limitation(reason).includes(Number(number).toLocaleString("en-US")));
  const limitations = {
    listed: record.limitations.length,
    recomputed: {
      out_of_county: has("out_of_county", p.unlinked_reasons.out_of_county),
      no_candidate: has("no_candidate", p.unlinked_reasons.no_candidate, record.evidence_states.tcad_id.unknown),
      tcad_permit_listing_link: has("tcad_permit_listing_link", p.by_link_method.tcad_permit_listing, record.roof_age.caveats.anchor_link_tcad_permit_listing),
      multiple_candidates: has("multiple_candidates", p.unlinked_reasons.multiple_candidates),
      invalid_quarantined: has("invalid_quarantined", p.unlinked_reasons.invalid_quarantined),
      roofing_not_on_a_property: has("roofing_not_on_a_property", roofing.permits - roofing.linked, roofing.by_status_group.open - roofing.by_status_group_linked.open, roofing.by_status_group.stalled - roofing.by_status_group_linked.stalled, roofing.permits - roofing.linked + deadPermitTotals.roofing, deadPermitTotals.roofing),
      needs_review_status: has("needs_review_status", p.status_group.needs_review),
      no_parcel_polygon: has("no_parcel_polygon", a.without_geometry),
      partial_history: has("partial_history", record.roof_age.by_historical_coverage.partial, record.roof_age.by_historical_coverage.unknown, record.roof_age.by_basis.year_built, record.roof_age.by_basis.none),
    },
    // What the record does not say: each class of dead account and the permits on them, unless an item names its count.
    missing: [
      {
        source: "tcad-2026-certified-appraisal-export",
        incomplete_reason: "no_situs_street",
        count: dead.filter((item) => item.reason === "no_situs_street" && item.source_fact).length,
        detail: `${dead.filter((item) => item.reason === "no_situs_street" && item.source_fact).length} accounts print no situs street (${byClass["no_situs_street:nothing_printed"] ?? 0} print no situs part at all, ${byClass["no_situs_street:number_only"] ?? 0} only a house number): permanent failures, not published`,
      },
      {
        source: "tcad-2026-certified-appraisal-export",
        incomplete_reason: "situs_columns_shifted",
        count: byClass["no_situs_street:columns_shifted"] ?? 0,
        detail: `${byClass["no_situs_street:columns_shifted"] ?? 0} accounts print the street one column to the right (the name in the suffix column, the suffix in the unit column): refused as a blank street, not published (decisions.md 27)`,
      },
      {
        source: "pipeline",
        incomplete_reason: "outside_validation_bbox",
        count: byClass.outside_validation_bbox ?? 0,
        detail: `${byClass.outside_validation_bbox ?? 0} accounts on the county line refused by the validation box although TCAD appraises them and the TNR layer draws them: a pipeline defect, not a source gap (decisions.md 27)`,
      },
      {
        source: "austin-issued-construction-permits/3syk-w9eu",
        incomplete_reason: "linked_to_dead_account",
        count: deadPermitTotals.permits,
        detail: `${deadPermitTotals.permits} linked permits (${deadPermitTotals.roofing} roofing) sit on ${Object.keys(deadPermits).length} dead accounts: loaded internally, shown on no property; with them ${(roofing.permits - roofing.linked + deadPermitTotals.roofing).toLocaleString("en-US")} roofing permits are shown on no property, not ${(roofing.permits - roofing.linked).toLocaleString("en-US")}`,
      },
    ].filter((item) => item.count > 0 && !has(item.incomplete_reason, item.count)),
  };

  return {
    version: T5_RECONCILE_VERSION,
    run_id: record.run_id,
    run_json_sha256: await sha256File(path.join(runDir, "run.json")),
    seed: rel(seed),
    dead: { total: dead.length, by_class: byClass, source_facts: dead.filter((item) => item.source_fact === true).length, not_source_facts: dead.filter((item) => item.source_fact === false).length, shards: [...new Set(dead.map((item) => item.shard))].sort(), linked_permits: deadPermitTotals, validation_bbox: TRAVIS_VALIDATION_BBOX, tnr_point_extent: extent, accounts: dead },
    shards_without_property_improvement: grouplessFacts,
    rulings,
    geometry,
    sizes,
    roof_age_anchors: anchors,
    checks,
    all_checks_pass: Object.values(checks).every(Boolean) && anchors.reconciles && Object.values(limitations.recomputed).every(Boolean) && limitations.missing.length === 0,
    limitations,
    seconds: Math.round((Date.now() - started) / 100) / 10,
  };
}

/** @param {string[]} argv @returns {Record<string, string>} */
function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith("--") || argv[index + 1] === undefined) throw new Error("usage: t5-reconcile.mjs --run <run dir> [--seed <seed.csv>] [--out <file>]");
    flags[argv[index].slice(2)] = argv[index + 1];
  }
  return flags;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (!flags.run) throw new Error("--run <run dir> is required");
  const runDir = path.resolve(RUNTIME_ROOT, flags.run);
  if (!existsSync(path.join(runDir, "run.json"))) throw new Error(`${flags.run} has no run.json: reconcile a finished run`);
  const report = await reconcileRun({ runDir, seedPath: flags.seed ? path.resolve(flags.seed) : null });
  if (flags.out) await writeFile(path.resolve(flags.out), `${JSON.stringify(report, null, 1)}\n`);
  const s = report.sizes;
  console.log(
    JSON.stringify({
      travis_t5_reconcile: report.run_id,
      all_checks_pass: report.all_checks_pass,
      dead: report.dead.by_class,
      dead_shards: report.dead.shards,
      shards_without_property_improvement: Object.fromEntries(Object.entries(report.shards_without_property_improvement).map(([id, facts]) => [id, { accounts: facts.accounts, linked: facts.linked, permits_printing_a_geo_id: facts.permits_printing_a_geo_id, their_link_state: facts.their_link_state, every_printed_geo_id_is_shared: facts.every_printed_geo_id_is_shared }])),
      sizes_gb: { county: s.groups.county?.gb, property_improvement: s.groups.property_improvement?.gb, total: s.total.gb, distinct_across_groups: s.distinct_across_groups.gb },
      roof_age_anchors: { t4_rule: report.roof_age_anchors.t4_rule_parcels, estimator: report.roof_age_anchors.estimator_parcels, only_estimator: report.roof_age_anchors.only_estimator, only_t4_rule_dead: report.roof_age_anchors.only_t4_rule_dead },
      rulings: { county_line: { accounts: report.rulings.county_line.accounts, ready: report.rulings.county_line.ready }, situs_columns_shifted: { seed_rows_matching: report.rulings.situs_columns_shifted.seed_rows_matching, ready: report.rulings.situs_columns_shifted.ready, sidecar_flagged: report.rulings.situs_columns_shifted.sidecar_flagged } },
      failed_checks: Object.entries(report.checks).filter(([, ok]) => !ok).map(([name]) => name),
      limitations_missing: report.limitations.missing.length,
      seconds: report.seconds,
    }),
  );
  process.exit(report.all_checks_pass ? 0 : 3);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`[t5-reconcile] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
