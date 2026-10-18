#!/usr/bin/env node
/**
 * T5 coverage record (assignment `docs/progress.md` T5 row): what the v4 transform writes from the whole roll, counted
 * offline from the seed, the TCAD extras index and the cached TNR pages (no request is made):
 *
 * - geometry: polygon and multi-part parcels, the parts written one geometry each, the inner rings dropped (lexicon gap);
 * - the TNR feature inventory: every attribute of the cached features, geometry types, features without a PROP_ID, and
 *   the agreement of the layer's `geo_id` with the roll's on the joined features;
 * - the fields T2 left unread: `structure` values per printed code, lots sized from land segments, the homestead cap loss
 *   and the taxable value per entity class, each with the accounts it is written on and why the rest are not;
 * - the field-coverage maps themselves (`field-coverage.mjs` v3).
 *
 *   node --max-old-space-size=8192 src/counties/travis/t5-field-coverage.mjs [--seed <csv>] [--extras <dir>] [--tnr <dir>] [--out <file>]
 *
 * @module counties/travis/t5-field-coverage
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  FOUNDATION_BY_CODE,
  GEOMETRY_PARTS_VERSION,
  ROOF_COVERING_BY_CODE,
  ROOF_STYLE_BY_CODE,
  TAXABLE_VALUE_FIELD_BY_CLASS,
  TCAD_EXTRAS_MAPPING_VERSION,
  TRANSFORM_VERSION,
  mapStructureAttributes,
  polygonParts,
} from "../../../counties/travis/transforms/transform.mjs";
import { TRAVIS_EXPORT_FIELDS_NOT_READ, TRAVIS_EXTRAS_FIELD_COVERAGE, TRAVIS_FIELD_COVERAGE_VERSION, TRAVIS_TNR_FEATURE_COVERAGE } from "./field-coverage.mjs";
import { RUNTIME_ROOT } from "./t3-snapshot.mjs";
import { streamCsvFile } from "./t4-permit-links.mjs";
import { DEFAULT_OUT_DIR as DEFAULT_EXTRAS_DIR, DEFAULT_SEED, TAXING_ENTITY_CLASS_VERSION, readTcadExtras } from "./t5-tcad-extras.mjs";

export const T5_FIELD_COVERAGE_VERSION = "travis.t5-field-coverage.v1";
const DEFAULT_TNR_DIR = path.join(RUNTIME_ROOT, "data", "travis", "tnr");

/** @param {Record<string, number>} counts @param {string} key */
const bump = (counts, key, by = 1) => {
  counts[key] = (counts[key] ?? 0) + by;
};
const rel = (target) => path.relative(RUNTIME_ROOT, target).split(path.sep).join("/");

/**
 * Inventory the cached TNR pages.
 *
 * @param {string} dir - TNR cache directory (`page-*.json` with receipts).
 * @param {Map<string, string>} rollGeoIds - The roll's geo_id by PROP_ID.
 * @returns {Promise<Record<string, any>>} Inventory.
 */
export async function inventoryTnr(dir, rollGeoIds) {
  const pages = (await readdir(dir)).filter((name) => /^page-\d+\.json$/.test(name)).sort();
  const attributes = {};
  const geometryTypes = {};
  let features = 0;
  let withoutPropId = 0;
  let inRoll = 0;
  let notInRoll = 0;
  const geoId = { equal: 0, differs: 0, blank_on_layer: 0 };
  let request = null;
  for (const page of pages) {
    const body = JSON.parse(await readFile(path.join(dir, page), "utf8"));
    if (!request) request = JSON.parse(await readFile(path.join(dir, page.replace(/\.json$/, ".receipt.json")), "utf8")).request;
    for (const feature of body.features ?? []) {
      features += 1;
      for (const key of Object.keys(feature.properties ?? {})) bump(attributes, key);
      bump(geometryTypes, feature.geometry?.type ?? "(none)");
      const propId = feature.properties?.PROP_ID === null || feature.properties?.PROP_ID === undefined ? "" : String(feature.properties.PROP_ID);
      if (propId === "") {
        withoutPropId += 1;
        continue;
      }
      if (!rollGeoIds.has(propId)) {
        notInRoll += 1;
        continue;
      }
      inRoll += 1;
      const layer = feature.properties?.geo_id === null || feature.properties?.geo_id === undefined ? "" : String(feature.properties.geo_id).trim();
      if (layer === "") geoId.blank_on_layer += 1;
      else if (layer === rollGeoIds.get(propId)) geoId.equal += 1;
      else geoId.differs += 1;
    }
  }
  return {
    layer: "TCAD_public/MapServer/0 (cached pages, T1)",
    request_out_fields: request?.multiValueQueryString?.outFields ?? null,
    pages: pages.length,
    features,
    attributes,
    geometry_types: geometryTypes,
    features_without_prop_id: withoutPropId,
    features_on_roll_accounts: inRoll,
    features_on_accounts_outside_the_roll: notInRoll,
    geo_id_on_joined_features: geoId,
  };
}

/**
 * Count what v4 writes over the whole roll.
 *
 * @param {{ seedPath: string, extrasDir: string, tnrDir: string }} options - Inputs.
 * @returns {Promise<Record<string, any>>} Coverage record.
 */
export async function buildCoverage({ seedPath, extrasDir, tnrDir }) {
  const { index, byPropId } = await readTcadExtras({ dir: extrasDir });
  const geometry = { parcels_with_geometry: 0, without_geometry: 0, single_part: 0, multi_part: { parcels: 0, parts: 0, parts_written: 0 }, inner_rings_dropped: { parcels: 0, parts_with_holes: 0, rings: 0, vertices: 0, on_single_part: 0, on_multi_part: 0 } };
  const structure = { accounts_with_codes: 0, written: 0, by_field: { roof_covering_material: {}, roof_material_type: {}, roof_design_type: {}, foundation_type: {} }, conflicting: { roof_covering: 0, roof_style: 0, foundation: 0 }, unmapped: {}, by_code: { roof_covering: {}, roof_style: {}, foundation: {} } };
  const lot = { legal_acreage_positive: 0, legal_acreage_zero_or_blank: 0, sized_from_land_segments: 0, land_acres_agree: 0, land_acres_disagree_left_null: 0, still_without_lot: 0 };
  const tax = { homestead_cap_loss_written: 0, by_field: Object.fromEntries(Object.values(TAXABLE_VALUE_FIELD_BY_CLASS).map((field) => [field, { written: 0, several_entities: 0, none: 0 }])), other_entities_on_accounts: 0 };
  /** @type {Map<string, string>} */
  const rollGeoIds = new Map();
  let rows = 0;
  for await (const row of streamCsvFile(seedPath, { columns: ["parcel_id", "geo_id", "parcel_polygon", "latitude", "source_legal_acreage"] })) {
    rows += 1;
    const propId = row.parcel_id.trim();
    rollGeoIds.set(propId, row.geo_id.trim());
    // Geometry (the v4 rule: one geometry per part of a multi-part parcel).
    if (row.parcel_polygon && row.latitude) {
      geometry.parcels_with_geometry += 1;
      const parts = polygonParts(JSON.parse(row.parcel_polygon)).parts;
      const drawable = parts.filter((part) => part.vertices.length >= 3);
      if (parts.length > 1) {
        geometry.multi_part.parcels += 1;
        geometry.multi_part.parts += parts.length;
        geometry.multi_part.parts_written += drawable.length;
      } else geometry.single_part += 1;
      const holed = parts.filter((part) => part.innerRings > 0);
      if (holed.length > 0) {
        geometry.inner_rings_dropped.parcels += 1;
        geometry.inner_rings_dropped.parts_with_holes += holed.length;
        geometry.inner_rings_dropped.rings += holed.reduce((sum, part) => sum + part.innerRings, 0);
        geometry.inner_rings_dropped.vertices += holed.reduce((sum, part) => sum + part.innerVertices, 0);
        if (parts.length > 1) geometry.inner_rings_dropped.on_multi_part += 1;
        else geometry.inner_rings_dropped.on_single_part += 1;
      }
    } else geometry.without_geometry += 1;
    const extras = byPropId.get(propId);
    // Structure.
    if (extras) {
      const atr = extras.imp_atr;
      for (const kind of ["roof_covering", "roof_style", "foundation"]) {
        if (atr[kind].length === 1) bump(structure.by_code[kind], atr[kind][0]);
        else if (atr[kind].length > 1) structure.conflicting[kind] += 1;
      }
      if (atr.roof_covering.length + atr.roof_style.length + atr.foundation.length > 0) structure.accounts_with_codes += 1;
      const mapped = mapStructureAttributes(atr);
      for (const item of mapped.unmapped) bump(structure.unmapped, item);
      if (Object.values(mapped.fields).some((value) => value !== null)) {
        structure.written += 1;
        for (const [field, value] of Object.entries(mapped.fields)) bump(structure.by_field[field], value ?? "(null)");
      }
      // Tax.
      if (Number(extras.prop?.ten_percent_cap) > 0) tax.homestead_cap_loss_written += 1;
      for (const [entityClass, field] of Object.entries(TAXABLE_VALUE_FIELD_BY_CLASS)) {
        const list = extras.entities?.classes?.[entityClass] ?? [];
        tax.by_field[field][list.length === 1 ? "written" : list.length > 1 ? "several_entities" : "none"] += 1;
      }
      if ((extras.entities?.other ?? 0) > 0) tax.other_entities_on_accounts += 1;
    }
    // Lot.
    const acreage = Number(row.source_legal_acreage || "0");
    if (acreage > 0) lot.legal_acreage_positive += 1;
    else {
      lot.legal_acreage_zero_or_blank += 1;
      const land = extras?.land;
      if (land && land.size_square_feet > 0) {
        lot.sized_from_land_segments += 1;
        const acres = land.size_acres_4dp / 10000;
        if (land.size_acres_4dp > 0 && Math.abs(acres * 43560 - land.size_square_feet) <= Math.max(1, 0.01 * land.size_square_feet)) lot.land_acres_agree += 1;
        else lot.land_acres_disagree_left_null += 1;
      } else lot.still_without_lot += 1;
    }
  }
  return {
    schemaVersion: T5_FIELD_COVERAGE_VERSION,
    generated_at: new Date().toISOString(),
    transform_version: TRANSFORM_VERSION,
    field_coverage_version: TRAVIS_FIELD_COVERAGE_VERSION,
    geometry_parts_version: GEOMETRY_PARTS_VERSION,
    tcad_extras_mapping_version: TCAD_EXTRAS_MAPPING_VERSION,
    taxing_entity_class_version: TAXING_ENTITY_CLASS_VERSION,
    enforced_by: "tests/travis-field-coverage.test.mjs, tests/travis-t5-transform-fixes.test.mjs, tests/travis-t5-tcad-extras.test.mjs",
    roll: { rows, seed: rel(seedPath) },
    tcad_extras: { dir: rel(extrasDir), version: index.version, sha256: index.output.sha256, archive: index.source, counts: index.counts, presence: index.presence },
    geometry: {
      ...geometry,
      rule: "a single-part parcel keeps its point and outer ring in geometry.json (v3's bytes); a multi-part parcel keeps its point in geometry.json (the address's geometry) and gets one geometry_part_<n>.json per part with its outer ring, each linked by parcel_has_geometry",
      lexicon_gap: "geometry.polygon holds one ring: inner rings (holes) are not written and are counted in each parcel's sidecar (geometry.inner_rings_dropped)",
    },
    tnr_feature: { coverage: TRAVIS_TNR_FEATURE_COVERAGE, inventory: await inventoryTnr(tnrDir, rollGeoIds) },
    structure: { ...structure, mapping: { roof_covering: ROOF_COVERING_BY_CODE, roof_style: ROOF_STYLE_BY_CODE, foundation: FOUNDATION_BY_CODE }, rule: "one structure per property (property_has_structure); a field is written when the account prints exactly one code for its attribute and the code has a member; the structure is written when at least one field is" },
    lot,
    tax: { ...tax, rule: "homestead_cap_loss_amount when ten_percent_cap is positive; per class, the taxable value of the one entity of that class on the account; special districts, exemptions and an account-wide taxable value are not written (TRAVIS_EXPORT_FIELDS_NOT_READ)" },
    extras_field_coverage: TRAVIS_EXTRAS_FIELD_COVERAGE,
    export_fields_not_read_with_lexicon_home: TRAVIS_EXPORT_FIELDS_NOT_READ,
    taxing_entities: index.taxing_entities,
    imp_info_types: index.imp_info_types,
  };
}

/** @param {string[]} argv @returns {Record<string, string>} */
function parseFlags(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith("--") || argv[index + 1] === undefined) throw new Error("usage: t5-field-coverage.mjs [--seed <csv>] [--extras <dir>] [--tnr <dir>] [--out <file>]");
    flags[argv[index].slice(2)] = argv[index + 1];
  }
  return flags;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const flags = parseFlags(process.argv.slice(2));
  buildCoverage({ seedPath: path.resolve(flags.seed ?? DEFAULT_SEED), extrasDir: path.resolve(flags.extras ?? DEFAULT_EXTRAS_DIR), tnrDir: path.resolve(flags.tnr ?? DEFAULT_TNR_DIR) })
    .then(async (record) => {
      if (flags.out) await writeFile(path.resolve(flags.out), `${JSON.stringify(record, null, 1)}\n`);
      console.log(JSON.stringify({ travis_t5_field_coverage: record.roll.rows, geometry: { multi_part: record.geometry.multi_part, inner_rings_dropped: record.geometry.inner_rings_dropped }, structure_written: record.structure.written, lot: record.lot, homestead_cap_loss_written: record.tax.homestead_cap_loss_written, tnr: { features: record.tnr_feature.inventory.features, geo_id: record.tnr_feature.inventory.geo_id_on_joined_features } }));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : error);
      process.exit(1);
    });
}
