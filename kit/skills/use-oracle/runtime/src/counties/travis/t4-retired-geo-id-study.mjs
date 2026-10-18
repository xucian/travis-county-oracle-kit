#!/usr/bin/env node
/**
 * T4 study of the permits whose 10-digit `tcad_id` no 2026 real-property account prints (assignment decisions.md section
 * 25.10). It measures; it writes no link and adds no link method (the operator rules first). Offline, over files already
 * captured with receipts:
 *
 * - `prop-types`: every PROP.TXT record of the 2026 certified export (all account types, not only the seed's `R`), so a
 *   "retired" geo_id that is still printed on a mobile-home, business-personal-property or mineral account is found.
 * - `tcad-json`: the 2026 Certified Special Export (JSON, one array of accounts): per account its geo_ids, its `links`
 *   (`linkedPID`) and the permit numbers TCAD itself lists in `permits[]`, so a permit can be looked up by TCAD's own
 *   account assignment.
 * - `point-in-polygon`: each permit's printed latitude/longitude against the seed's TNR polygons (the 2026 parcels), as a
 *   candidate method: how many land in exactly one polygon, and, on the permits that already link exactly, how often the
 *   polygon is the linked parcel (its precision).
 * - the roofing and roof-age impact of leaving the permits unlinked.
 *
 *   node --max-old-space-size=16384 src/counties/travis/t4-retired-geo-id-study.mjs --tcad-json <zip> --export <certified.zip> --out <report.json>
 *
 * @module counties/travis/t4-retired-geo-id-study
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { classifyDateEvidence, summarizePermitRow } from "./permit-profile.mjs";
import { RUNTIME_ROOT } from "./t3-snapshot.mjs";
import { DEFAULT_SEED, readRollGeoIndex, streamCapturedPermits, streamCsvFile } from "./t4-permit-links.mjs";
import { latestCapture } from "./t4-permit-verify.mjs";
import { forEachArrayElement, zipMemberStream } from "./t4-tcad-permit-listing.mjs";

export { forEachArrayElement };

export const STUDY_VERSION = "travis-t4-retired-geo-id-study.v1";

/**
 * Every account of the TCAD JSON export, reduced to what the study needs.
 *
 * @param {string} zipPath - The special export zip.
 * @returns {Promise<{ accounts: Map<number, { type: string, inactive: boolean, geoIds: string[], links: number[] }>, permitAccounts: Map<string, number[]>, elements: number, ms: number }>} Index.
 */
export async function readTcadJson(zipPath) {
  const started = performance.now();
  const accounts = new Map();
  /** @type {Map<string, number[]>} */
  const permitAccounts = new Map();
  const elements = await forEachArrayElement(zipMemberStream(zipPath), (text) => {
    const account = JSON.parse(text);
    const pid = Number(account.pID);
    const geoIds = (account.propertyIdentification ?? []).map((item) => String(item.geoID ?? "").trim()).filter(Boolean);
    const links = (account.links ?? []).map((item) => Number(item.linkedPID)).filter(Number.isFinite);
    accounts.set(pid, { type: String(account.propType ?? ""), inactive: Number(account.inactive) === 1, geoIds, links });
    if (accounts.size % 50_000 === 0) process.stderr.write(`[tcad-json] ${accounts.size} accounts, ${Math.round((performance.now() - started) / 1000)} s\n`);
    for (const permit of account.permits ?? []) {
      const number = String(permit.permitNumber ?? "").trim();
      if (!number) continue;
      const list = permitAccounts.get(number) ?? permitAccounts.set(number, []).get(number);
      if (!list.includes(pid)) list.push(pid);
    }
  });
  return { accounts, permitAccounts, elements, ms: performance.now() - started };
}

/**
 * geo_id to (PROP_ID, type) over every PROP.TXT record of the certified export (fixed width: prop_id 1-12, type 13-17,
 * geo_id 547-596, as the seed manifest records).
 *
 * @param {string} exportZip - Certified export zip.
 * @returns {Promise<{ byGeoId: Map<string, { propId: string, type: string }[]>, records: number }>} Index.
 */
export async function readPropTxtGeoIds(exportZip) {
  const stream = zipMemberStream(exportZip, "PROP.TXT");
  stream.setEncoding("latin1");
  const byGeoId = new Map();
  let buffer = "";
  let records = 0;
  for await (const chunk of stream) {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.length < 596) continue;
      records += 1;
      const propId = String(Number.parseInt(line.slice(0, 12), 10));
      const type = line.slice(12, 17).trim();
      const geoId = line.slice(546, 596).trim();
      if (!geoId) continue;
      (byGeoId.get(geoId) ?? byGeoId.set(geoId, []).get(geoId)).push({ propId, type });
    }
  }
  return { byGeoId, records };
}

/**
 * Polygons of the seed (TNR 2026 parcels) in a grid index.
 *
 * @param {string} seedPath - Seed CSV.
 * @param {number} [cell] - Grid cell in degrees.
 * @returns {Promise<{ lookup: (lat: number, lon: number) => string[], polygons: number }>} Index.
 */
export async function readSeedPolygons(seedPath, cell = 0.005) {
  /** @type {Map<string, { propId: string, rings: number[][][], box: number[] }[]>} */
  const grid = new Map();
  let polygons = 0;
  for await (const row of streamCsvFile(seedPath, { columns: ["parcel_id", "parcel_polygon"] })) {
    if (!row.parcel_polygon) continue;
    let geometry;
    try {
      geometry = JSON.parse(row.parcel_polygon);
    } catch {
      continue;
    }
    const parts = geometry.type === "MultiPolygon" ? geometry.coordinates : geometry.type === "Polygon" ? [geometry.coordinates] : [];
    for (const part of parts) {
      const outer = part[0];
      if (!Array.isArray(outer) || outer.length < 3) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of outer) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
      const entry = { propId: row.parcel_id.trim(), rings: part, box: [minX, minY, maxX, maxY] };
      polygons += 1;
      for (let gx = Math.floor(minX / cell); gx <= Math.floor(maxX / cell); gx += 1) {
        for (let gy = Math.floor(minY / cell); gy <= Math.floor(maxY / cell); gy += 1) {
          const key = `${gx}:${gy}`;
          (grid.get(key) ?? grid.set(key, []).get(key)).push(entry);
        }
      }
    }
  }
  const inRing = (ring, x, y) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  return {
    polygons,
    lookup(lat, lon) {
      const found = new Set();
      for (const entry of grid.get(`${Math.floor(lon / cell)}:${Math.floor(lat / cell)}`) ?? []) {
        const [minX, minY, maxX, maxY] = entry.box;
        if (lon < minX || lon > maxX || lat < minY || lat > maxY) continue;
        if (!inRing(entry.rings[0], lon, lat)) continue;
        if (entry.rings.slice(1).some((hole) => inRing(hole, lon, lat))) continue;
        found.add(entry.propId);
      }
      return [...found];
    },
  };
}

/** @param {Record<string, number>} counts @param {string} key */
const bump = (counts, key, by = 1) => {
  counts[key] = (counts[key] ?? 0) + by;
};

async function main() {
  const flags = {};
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 2) flags[argv[index].replace(/^--/, "")] = argv[index + 1];
  const captureDir = flags.capture ? path.resolve(flags.capture) : await latestCapture();
  const seedPath = path.resolve(flags.seed ?? DEFAULT_SEED);
  const asOfDate = "2026-10-17";
  const t0 = performance.now();
  const roll = await readRollGeoIndex(seedPath);
  const polygons = await readSeedPolygons(seedPath);
  const props = flags.export ? await readPropTxtGeoIds(path.resolve(flags.export)) : null;
  process.stderr.write(`[study] roll, polygons and PROP.TXT read in ${Math.round((performance.now() - t0) / 1000)} s\n`);
  const tcad = flags["tcad-json"] ? await readTcadJson(path.resolve(flags["tcad-json"])) : null;
  const seedPids = new Set([...roll.propIds].map(Number));

  const retired = { permits: 0, distinct: new Set(), with_coordinates: 0, pip: { none: 0, one: 0, several: 0 }, pip_one_by_type: {}, prop_txt_types: {}, prop_txt_found_ids: new Set(), tcad: { listed_on_one_seed_account: 0, listed_on_several: 0, listed_on_non_seed_only: 0, not_listed: 0 }, tcad_vs_pip: { both_one_and_equal: 0, both_one_differ: 0 } };
  const roofing = { permits: 0, by_class: {}, open: 0, stalled: 0, anchor_eligible: 0, anchor_eligible_pip_one: 0, anchor_eligible_tcad_one: 0, anchor_parcels_pip: new Set(), anchor_parcels_tcad: new Set() };
  const validation = { linked_with_coordinates: 0, pip_one: 0, pip_one_equal: 0, pip_several_includes: 0, pip_none: 0, tcad_listed_one: 0, tcad_listed_one_equal: 0, tcad_not_listed: 0 };
  const anchoredExact = new Set();
  const isAnchor = (summary, row) => (summary.roofWorkClass === "primary_roof_replacement" || summary.roofWorkClass === "primary_roof_new_construction") && summary.lifecycleStatus === "completed" && classifyDateEvidence(row.completed_date, { asOfDate }).evidenceState === "confirmed_present";
  const pending = [];

  for await (const entry of streamCapturedPermits(captureDir)) {
    const row = entry.row;
    const tcadId = row.tcad_id.trim();
    if (!/^\d{10}$/.test(tcadId)) continue;
    const linked = roll.byGeoId.get(tcadId);
    const lat = row.latitude.trim() === "" ? Number.NaN : Number(row.latitude);
    const lon = row.longitude.trim() === "" ? Number.NaN : Number(row.longitude);
    const hasPoint = Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0 && lon !== 0;
    const number = row.permit_number.trim();
    if (linked?.length === 1) {
      const summary = summarizePermitRow(row, { asOfDate });
      if (isAnchor(summary, row)) anchoredExact.add(linked[0]);
      // Precision of the candidate methods on permits that already link exactly (every 5th, to bound the time).
      if (entry.index % 5 === 0) {
        if (hasPoint) {
          validation.linked_with_coordinates += 1;
          const hits = polygons.lookup(lat, lon);
          if (hits.length === 0) validation.pip_none += 1;
          else if (hits.length === 1) {
            validation.pip_one += 1;
            if (hits[0] === linked[0]) validation.pip_one_equal += 1;
          } else if (hits.includes(linked[0])) validation.pip_several_includes += 1;
        }
        if (tcad) {
          const accounts = (tcad.permitAccounts.get(number) ?? []).filter((pid) => seedPids.has(pid));
          if (accounts.length === 1) {
            validation.tcad_listed_one += 1;
            if (String(accounts[0]) === linked[0]) validation.tcad_listed_one_equal += 1;
          } else if (accounts.length === 0) validation.tcad_not_listed += 1;
        }
      }
      continue;
    }
    if (linked) continue; // shared geo_id: multiple_candidates, not this study
    retired.permits += 1;
    retired.distinct.add(tcadId);
    if (props) {
      const found = props.byGeoId.get(tcadId) ?? [];
      const types = [...new Set(found.map((item) => item.type))].sort().join("+") || "absent";
      bump(retired.prop_txt_types, types);
    }
    let pipOne = null;
    if (hasPoint) {
      retired.with_coordinates += 1;
      const hits = polygons.lookup(lat, lon);
      if (hits.length === 0) retired.pip.none += 1;
      else if (hits.length === 1) {
        retired.pip.one += 1;
        pipOne = hits[0];
        bump(retired.pip_one_by_type, row.permittype);
      } else retired.pip.several += 1;
    }
    let tcadOne = null;
    if (tcad) {
      const all = tcad.permitAccounts.get(number) ?? [];
      const inSeed = all.filter((pid) => seedPids.has(pid));
      if (inSeed.length === 1) {
        retired.tcad.listed_on_one_seed_account += 1;
        tcadOne = String(inSeed[0]);
      } else if (inSeed.length > 1) retired.tcad.listed_on_several += 1;
      else if (all.length > 0) retired.tcad.listed_on_non_seed_only += 1;
      else retired.tcad.not_listed += 1;
      if (pipOne && tcadOne) {
        if (pipOne === tcadOne) retired.tcad_vs_pip.both_one_and_equal += 1;
        else retired.tcad_vs_pip.both_one_differ += 1;
      }
    }
    const summary = summarizePermitRow(row, { asOfDate });
    if (summary.isRoofing) {
      roofing.permits += 1;
      bump(roofing.by_class, summary.roofWorkClass);
      if (summary.statusGroup === "open") roofing.open += 1;
      if (summary.statusGroup === "stalled") roofing.stalled += 1;
    }
    if (isAnchor(summary, row)) {
      roofing.anchor_eligible += 1;
      if (pipOne) {
        roofing.anchor_eligible_pip_one += 1;
        pending.push(["pip", pipOne]);
      }
      if (tcadOne) {
        roofing.anchor_eligible_tcad_one += 1;
        pending.push(["tcad", tcadOne]);
      }
    }
  }
  for (const [method, parcel] of pending) if (!anchoredExact.has(parcel)) (method === "pip" ? roofing.anchor_parcels_pip : roofing.anchor_parcels_tcad).add(parcel);

  let linkStats = null;
  if (tcad) {
    const types = {};
    let pairs = 0;
    for (const [pid, account] of tcad.accounts) {
      for (const other of account.links) {
        pairs += 1;
        bump(types, `${account.type}->${tcad.accounts.get(other)?.type ?? "absent"}`);
      }
      void pid;
    }
    linkStats = { link_pairs: pairs, by_type_pair: Object.fromEntries(Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 12)) };
  }
  const report = {
    study_version: STUDY_VERSION,
    capture: path.relative(RUNTIME_ROOT, captureDir),
    seed: { path: path.relative(RUNTIME_ROOT, seedPath), sha256: roll.seedSha256, polygons: polygons.polygons },
    prop_txt: props ? { records: props.records, distinct_geo_ids: props.byGeoId.size } : null,
    tcad_json: tcad ? { accounts: tcad.accounts.size, elements: tcad.elements, permit_numbers_listed: tcad.permitAccounts.size, inactive_accounts: [...tcad.accounts.values()].filter((item) => item.inactive).length, read_s: Math.round(tcad.ms / 1000), links: linkStats } : null,
    retired: {
      permits: retired.permits,
      distinct_geo_ids: retired.distinct.size,
      prop_txt_account_types: retired.prop_txt_types,
      with_coordinates: retired.with_coordinates,
      point_in_polygon: retired.pip,
      point_in_polygon_one_by_permittype: retired.pip_one_by_type,
      tcad_permit_listing: retired.tcad,
      tcad_and_point_in_polygon: retired.tcad_vs_pip,
    },
    validation_on_exact_links_every_5th: validation,
    readme_impact: {
      roofing_permits: roofing.permits,
      roofing_by_class: roofing.by_class,
      open_roofing: roofing.open,
      stalled_roofing: roofing.stalled,
      roof_age_anchor_eligible: roofing.anchor_eligible,
      anchor_eligible_with_one_polygon: roofing.anchor_eligible_pip_one,
      anchor_eligible_listed_on_one_tcad_account: roofing.anchor_eligible_tcad_one,
      parcels_without_an_exact_anchor_that_would_gain_one: { point_in_polygon: roofing.anchor_parcels_pip.size, tcad_listing: roofing.anchor_parcels_tcad.size },
      parcels_with_an_exact_anchor: anchoredExact.size,
    },
    elapsed_s: Math.round((performance.now() - t0) / 1000),
  };
  if (flags.out) await writeFile(path.resolve(flags.out), `${JSON.stringify(report, null, 1)}\n`);
  console.log(JSON.stringify(report, null, 1));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}

/**
 * Follow-up measures (decisions.md section 25.10): (1) lineage through TCAD `links` to accounts absent from the 2026
 * export, keyed by the old property ids Austin's past parcel snapshots print beside each retired geo_id; (2) the kit's
 * other explicit fallback, the permit's street line against exactly one seed account's situs street line, with its
 * precision on exactly linked permits. Measures only.
 *
 * @param {object} options - Inputs.
 * @param {string} options.tcadJson - Special export zip.
 * @param {string} options.captureDir - Permit capture.
 * @param {string} options.seedPath - Seed CSV.
 * @param {Map<string, Set<string>>} options.oldPropIdsByGeoId - Retired geo_id to the property ids Austin's snapshots print.
 * @returns {Promise<Record<string, any>>} Measures.
 */
export async function followUp({ tcadJson, captureDir, seedPath, oldPropIdsByGeoId }) {
  const roll = await readRollGeoIndex(seedPath);
  const linkedFrom = new Map();
  const eventTypes = {};
  await forEachArrayElement(zipMemberStream(tcadJson), (text) => {
    const account = JSON.parse(text);
    for (const link of account.links ?? []) {
      const key = String(link.linkedPID);
      (linkedFrom.get(key) ?? linkedFrom.set(key, new Set()).get(key)).add(String(account.pID));
    }
    for (const event of account.events ?? []) bump(eventTypes, `${event.eventType ?? ""}|${String(event.eventDescription ?? "").slice(0, 40)}`);
  });
  const street = (value) => String(value ?? "").toUpperCase().split(",")[0].replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const bySitus = new Map();
  for (const [propId, address] of roll.situsByPropId) {
    const key = street(address);
    if (!key || !/^\d/.test(key)) continue;
    (bySitus.get(key) ?? bySitus.set(key, []).get(key)).push(propId);
  }
  const lineage = { retired_geo_ids_with_old_property_id: 0, old_property_id_linked_from_current_accounts: 0, permits_covered: 0, one_current_seed_account: 0, several_current_accounts: 0 };
  const permitsPerGeo = new Map();
  const address = { retired: { compared: 0, one: 0, several: 0, none: 0 }, validation_every_5th: { compared: 0, one: 0, one_equal: 0 } };
  for await (const entry of streamCapturedPermits(captureDir)) {
    const row = entry.row;
    const tcadId = row.tcad_id.trim();
    if (!/^\d{10}$/.test(tcadId)) continue;
    const linked = roll.byGeoId.get(tcadId);
    const key = street(row.original_address1);
    if (linked?.length === 1) {
      if (entry.index % 5 === 0 && key && /^\d/.test(key)) {
        address.validation_every_5th.compared += 1;
        const hits = bySitus.get(key) ?? [];
        if (hits.length === 1) {
          address.validation_every_5th.one += 1;
          if (hits[0] === linked[0]) address.validation_every_5th.one_equal += 1;
        }
      }
      continue;
    }
    if (linked) continue;
    permitsPerGeo.set(tcadId, (permitsPerGeo.get(tcadId) ?? 0) + 1);
    if (key && /^\d/.test(key)) {
      address.retired.compared += 1;
      const hits = bySitus.get(key) ?? [];
      if (hits.length === 1) address.retired.one += 1;
      else if (hits.length > 1) address.retired.several += 1;
      else address.retired.none += 1;
    }
  }
  for (const [geoId, olds] of oldPropIdsByGeoId) {
    if (!permitsPerGeo.has(geoId)) continue;
    lineage.retired_geo_ids_with_old_property_id += 1;
    const current = new Set();
    for (const old of olds) for (const pid of linkedFrom.get(old) ?? []) current.add(pid);
    if (current.size === 0) continue;
    lineage.old_property_id_linked_from_current_accounts += 1;
    lineage.permits_covered += permitsPerGeo.get(geoId);
    const inSeed = [...current].filter((pid) => roll.propIds.has(pid));
    if (inSeed.length === 1) lineage.one_current_seed_account += 1;
    else if (inSeed.length > 1) lineage.several_current_accounts += 1;
  }
  return { lineage_through_tcad_links: lineage, address_street_line: address, tcad_event_types_top: Object.fromEntries(Object.entries(eventTypes).sort((a, b) => b[1] - a[1]).slice(0, 15)) };
}

/**
 * Coverage of each candidate method on the retired-geo_id permits, overall and for the roofing subsets (decisions.md
 * section 25.10): TCAD's own `permits[]` naming one current account; the permit point in one current polygon; the street
 * line on one current account; and the split children reached through TCAD `links` narrowed by the street line to one.
 * Measures only.
 *
 * @param {object} options - Inputs.
 * @param {string} options.tcadJson - Special export zip.
 * @param {string} options.captureDir - Capture.
 * @param {string} options.seedPath - Seed.
 * @param {Map<string, Set<string>>} options.oldPropIdsByGeoId - Retired geo_id to Austin snapshot property ids.
 * @returns {Promise<Record<string, any>>} Coverage table.
 */
export async function methodCoverage({ tcadJson, captureDir, seedPath, oldPropIdsByGeoId }) {
  const roll = await readRollGeoIndex(seedPath);
  const polygons = await readSeedPolygons(seedPath);
  const tcad = await readTcadJson(tcadJson);
  const linkedFrom = new Map();
  for (const [pid, account] of tcad.accounts) for (const other of account.links) (linkedFrom.get(String(other)) ?? linkedFrom.set(String(other), new Set()).get(String(other))).add(String(pid));
  const street = (value) => String(value ?? "").toUpperCase().split(",")[0].replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const bySitus = new Map();
  const situsOf = new Map();
  for (const [propId, address] of roll.situsByPropId) {
    const key = street(address);
    situsOf.set(propId, key);
    if (key && /^\d/.test(key)) (bySitus.get(key) ?? bySitus.set(key, []).get(key)).push(propId);
  }
  const asOfDate = "2026-10-17";
  const subsets = ["all", "roofing", "open_roofing", "stalled_roofing", "anchor_eligible"];
  const methods = ["tcad_permit_listing", "point_in_polygon", "street_line", "lineage_and_street_line", "any", "methods_disagree"];
  const table = Object.fromEntries(subsets.map((subset) => [subset, Object.fromEntries([["permits", 0], ...methods.map((method) => [method, 0])])]));
  for await (const entry of streamCapturedPermits(captureDir)) {
    const row = entry.row;
    const tcadId = row.tcad_id.trim();
    if (!/^\d{10}$/.test(tcadId) || roll.byGeoId.has(tcadId)) continue;
    const summary = summarizePermitRow(row, { asOfDate });
    const anchor = (summary.roofWorkClass === "primary_roof_replacement" || summary.roofWorkClass === "primary_roof_new_construction") && summary.lifecycleStatus === "completed" && classifyDateEvidence(row.completed_date, { asOfDate }).evidenceState === "confirmed_present";
    const inSubset = { all: true, roofing: summary.isRoofing, open_roofing: summary.isRoofing && summary.statusGroup === "open", stalled_roofing: summary.isRoofing && summary.statusGroup === "stalled", anchor_eligible: anchor };
    const found = {};
    const listed = (tcad.permitAccounts.get(row.permit_number.trim()) ?? []).map(String).filter((pid) => roll.propIds.has(pid));
    if (listed.length === 1) found.tcad_permit_listing = listed[0];
    const lat = row.latitude.trim() === "" ? Number.NaN : Number(row.latitude);
    const lon = row.longitude.trim() === "" ? Number.NaN : Number(row.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0) {
      const hits = polygons.lookup(lat, lon);
      if (hits.length === 1) found.point_in_polygon = hits[0];
    }
    const key = street(row.original_address1);
    if (key && /^\d/.test(key)) {
      const hits = bySitus.get(key) ?? [];
      if (hits.length === 1) found.street_line = hits[0];
      const children = new Set();
      for (const old of oldPropIdsByGeoId.get(tcadId) ?? []) for (const pid of linkedFrom.get(old) ?? []) if (roll.propIds.has(pid)) children.add(pid);
      const narrowed = [...children].filter((pid) => situsOf.get(pid) === key);
      if (narrowed.length === 1) found.lineage_and_street_line = narrowed[0];
    }
    const distinct = new Set(Object.values(found));
    for (const subset of subsets) {
      if (!inSubset[subset]) continue;
      table[subset].permits += 1;
      for (const method of Object.keys(found)) table[subset][method] += 1;
      if (distinct.size >= 1) table[subset].any += 1;
      if (distinct.size > 1) table[subset].methods_disagree += 1;
    }
  }
  return { coverage: table };
}
