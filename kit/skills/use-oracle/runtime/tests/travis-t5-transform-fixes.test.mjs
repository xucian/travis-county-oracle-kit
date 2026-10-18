import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseCsvRecords } from "../src/core/csv.mjs";
import { materializeParcelInput } from "../src/counties/travis/adapter.mjs";
import { classifyTaxingEntity } from "../src/counties/travis/t5-tcad-extras.mjs";
import { assertOutputContract, assertTravisIdentity } from "../src/counties/travis/validate.mjs";
import {
  STRUCTURE_REQUIRED_FIELDS,
  TCAD_EXTRAS_MAPPING_VERSION,
  TRANSFORM_VERSION,
  buildTravisOutput,
  mapStructureAttributes,
  polygonParts,
  resolveDataGroupCids,
} from "../counties/travis/transforms/transform.mjs";

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "travis-replay");

async function fixture() {
  const rows = parseCsvRecords(await readFile(path.join(FIXTURE_DIR, "seed.csv"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(FIXTURE_DIR, "lexicon-manifest.json"), "utf8"));
  return { rows, manifest, roots: resolveDataGroupCids(manifest) };
}

const ring = (lon, lat, size = 0.0006) => [
  [lon, lat],
  [lon + size, lat],
  [lon + size, lat + size],
  [lon, lat + size],
  [lon, lat],
];
const hole = (lon, lat) => ring(lon + 0.0001, lat + 0.0001, 0.0002);

/** An extras-index line (`t5-tcad-extras.mjs`) for the fixture account. */
const extrasLine = (overrides = {}) => ({
  prop_id: "900001",
  prop: { sup_num: "0", owner_id: "77", ten_percent_cap: "0" },
  entities: { classes: { county: [{ entity_cd: "03", entity_name: "TRAVIS COUNTY", taxable_val: "580000", partial_entity: false }] }, other: 2, conflicting: [] },
  imp_atr: { roof_covering: ["COMPOSITIO"], roof_style: ["HIP"], foundation: ["SLAB"], other_attributes: 4 },
  land: { segments: 1, size_acres_4dp: 1722, size_square_feet: 7501 },
  imp_info: { improvements: 1, types: ["01"] },
  ...overrides,
});

describe("transform v4: one geometry per polygon part (T5 pre-run fix)", () => {
  it("is version 4", () => {
    expect(TRANSFORM_VERSION).toBe("travis-transform-v4");
  });

  it("reads a Polygon's outer ring and counts its holes, and every part of a MultiPolygon", () => {
    const single = polygonParts({ type: "Polygon", coordinates: [ring(-97.72, 30.3), hole(-97.72, 30.3)] });
    expect(single.parts).toHaveLength(1);
    expect(single.parts[0]).toMatchObject({ innerRings: 1, innerVertices: 5 });
    expect(single.parts[0].vertices[0]).toEqual({ latitude: 30.3, longitude: -97.72 });
    const multi = polygonParts({ type: "MultiPolygon", coordinates: [[ring(-97.72, 30.3)], [ring(-97.71, 30.31), hole(-97.71, 30.31)], [ring(-97.7, 30.32)]] });
    expect(multi.parts.map((part) => part.vertices.length)).toEqual([5, 5, 5]);
    expect(multi.parts.map((part) => part.innerRings)).toEqual([0, 1, 0]);
    expect(polygonParts(null).parts).toEqual([]);
  });

  it("keeps a single-part parcel's geometry exactly as v3 wrote it (point and polygon in one file)", async () => {
    const { rows, manifest, roots } = await fixture();
    const { files, sourcePayload } = buildTravisOutput(materializeParcelInput(rows[0]), { manifest });
    expect(Object.keys(files).filter((name) => name.startsWith("geometry"))).toEqual(["geometry.json"]);
    expect(files["geometry.json"].polygon).toHaveLength(5);
    expect(files[`${roots.countyCid}.json`].relationships.parcel_has_geometry).toEqual([{ "/": "./relationship_parcel_has_geometry.json" }]);
    expect(sourcePayload.geometry).toMatchObject({ geojson_type: "Polygon", parts: 1, parts_written: 1, inner_rings_dropped: { parts_with_holes: 0, rings: 0, vertices: 0 } });
  });

  it("writes one geometry per part of a multi-part parcel, linked from the parcel, and keeps the point on the address", async () => {
    const { rows, manifest, roots } = await fixture();
    const polygon = { type: "MultiPolygon", coordinates: [[ring(-97.723, 30.3018)], [ring(-97.7218, 30.3025), hole(-97.7218, 30.3025)], [ring(-97.7225, 30.303)]] };
    const row = { ...rows[0], parcel_polygon: JSON.stringify(polygon) };
    const { files, warnings, sourcePayload } = buildTravisOutput(materializeParcelInput(row), { manifest });
    expect(warnings).toEqual([]);
    assertOutputContract(files, roots);
    assertTravisIdentity({ row, files, roots });
    expect(files["geometry.json"]).not.toHaveProperty("polygon");
    expect(files["geometry.json"].latitude).toBeCloseTo(30.30215, 4);
    for (const index of [1, 2, 3]) {
      const part = files[`geometry_part_${index}.json`];
      expect(part.polygon).toHaveLength(5);
      expect(part).not.toHaveProperty("latitude");
      expect(part.request_identifier).toBe("900001");
      expect(part.source_http_request).toEqual(files["geometry.json"].source_http_request);
      expect(files[`relationship_parcel_has_geometry_part_${index}.json`]).toEqual({ from: { "/": "./parcel.json" }, to: { "/": `./geometry_part_${index}.json` } });
    }
    const county = files[`${roots.countyCid}.json`].relationships;
    expect(county.parcel_has_geometry).toHaveLength(4);
    expect(county.address_has_geometry).toEqual({ "/": "./relationship_address_has_geometry.json" });
    expect(files["relationship_address_has_geometry.json"].to).toEqual({ "/": "./geometry.json" });
    // The holes are the lexicon gap: counted in the sidecar, never written.
    expect(sourcePayload.geometry).toMatchObject({ geojson_type: "MultiPolygon", parts: 3, parts_written: 3, inner_rings_dropped: { parts_with_holes: 1, rings: 1, vertices: 5 } });
  });

  it("records a holed polygon's dropped inner ring and writes its outer ring only", async () => {
    const { rows, manifest } = await fixture();
    const row = { ...rows[0], parcel_polygon: JSON.stringify({ type: "Polygon", coordinates: [ring(-97.723, 30.3018), hole(-97.723, 30.3018)] }) };
    const { files, sourcePayload } = buildTravisOutput(materializeParcelInput(row), { manifest });
    expect(files["geometry.json"].polygon).toHaveLength(5);
    expect(files["geometry.json"].polygon[1]).toEqual({ latitude: 30.3018, longitude: -97.7224 });
    expect(sourcePayload.geometry.inner_rings_dropped).toEqual({ parts_with_holes: 1, rings: 1, vertices: 5 });
  });

  it("fails closed when any part lies outside Travis County", async () => {
    const { rows, manifest, roots } = await fixture();
    const polygon = { type: "MultiPolygon", coordinates: [[ring(-97.723, 30.3018)], [ring(-96.5, 30.3)]] };
    const row = { ...rows[0], parcel_polygon: JSON.stringify(polygon) };
    const { files } = buildTravisOutput(materializeParcelInput(row), { manifest });
    expect(() => assertTravisIdentity({ row, files, roots })).toThrow(/outside the Travis bbox/);
  });
});

describe("transform v4: the TCAD fields T2 left unread (T5 pre-run fix)", () => {
  it("classes taxing entities by their printed names, exactly", () => {
    expect(classifyTaxingEntity("TRAVIS COUNTY")).toBe("county");
    expect(classifyTaxingEntity("TRAVIS COUNTY HEALTHCARE DISTRICT")).toBe("hospital");
    expect(classifyTaxingEntity("AUSTIN COMM COLL DIST")).toBe("college");
    expect(classifyTaxingEntity("HAYS CONSOLIDATED ISD")).toBe("school");
    expect(classifyTaxingEntity("CITY OF AUSTIN")).toBe("city");
    expect(classifyTaxingEntity("VILLAGE OF THE HILLS")).toBe("city");
    for (const other of ["TRAVIS CENTRAL APP DIST", "TRAVIS CO ESD NO 2", "REINVESTMENT ZONE # 1 CITY OF PFLUG", "TRAVIS CO MUD NO 15", "WHISPER VALLEY PID", "TRAVIS CO BCCP"]) {
      expect(classifyTaxingEntity(other), other).toBe("other");
    }
  });

  it("maps one printed code per attribute; several codes or an unknown code leave the field null", () => {
    expect(mapStructureAttributes({ roof_covering: ["COMPOSITIO"], roof_style: ["HIP"], foundation: ["SLAB"] }).fields).toEqual({ roof_covering_material: null, roof_material_type: "Composition", roof_design_type: "Hip", foundation_type: "Slab on Grade" });
    expect(mapStructureAttributes({ roof_covering: ["BUILT-UP"], roof_style: ["FLAT"], foundation: ["PIER AND B"] }).fields).toEqual({ roof_covering_material: "Built-Up Roof", roof_material_type: null, roof_design_type: "Flat", foundation_type: "Pier and Beam" });
    expect(mapStructureAttributes({ roof_covering: ["WOOD SHING"] }).fields).toMatchObject({ roof_covering_material: "Wood Shingle", roof_material_type: "Wood" });
    expect(mapStructureAttributes({ foundation: ["FLOATING S"] }).fields).toMatchObject({ foundation_type: "Slab on Grade" });
    expect(mapStructureAttributes({ foundation: ["BLOCKS"] }).fields).toMatchObject({ foundation_type: null });
    const conflicting = mapStructureAttributes({ roof_covering: ["COMPOSITIO", "METAL"], roof_style: ["GABLE"], foundation: [] });
    expect(conflicting.fields).toEqual({ roof_covering_material: null, roof_material_type: null, roof_design_type: "Gable", foundation_type: null });
    expect(conflicting.conflicting).toEqual(["roof_covering"]);
    const unknown = mapStructureAttributes({ roof_covering: ["SLATE"] });
    expect(unknown.unmapped).toEqual(["roof_covering:SLATE"]);
    expect(unknown.fields.roof_material_type).toBeNull();
  });

  it("writes one structure with every required field, roof age never written, from the account's IMP_ATR codes", async () => {
    const { rows, manifest, roots } = await fixture();
    const row = rows[0];
    const { files, warnings, sourcePayload } = buildTravisOutput(materializeParcelInput(row, extrasLine()), { manifest });
    expect(warnings).toEqual([]);
    assertOutputContract(files, roots);
    assertTravisIdentity({ row, files, roots });
    const structure = files["structure.json"];
    expect(Object.keys(structure).sort()).toEqual([...STRUCTURE_REQUIRED_FIELDS, "source_http_request", "request_identifier"].sort());
    expect(structure).toMatchObject({ roof_material_type: "Composition", roof_covering_material: null, roof_design_type: "Hip", foundation_type: "Slab on Grade", roof_age_years: null, request_identifier: "900001" });
    expect(structure).not.toHaveProperty("roof_date");
    expect(structure.source_http_request).toEqual(files["property.json"].source_http_request);
    expect(files[`${roots.countyCid}.json`].relationships.property_has_structure).toEqual({ "/": "./relationship_property_has_structure.json" });
    expect(sourcePayload.tcad_extras).toMatchObject({ version: TCAD_EXTRAS_MAPPING_VERSION, imp_atr: { roof_covering: ["COMPOSITIO"] }, structure_conflicting: [], structure_unmapped: [], improvement_types: ["01"] });
  });

  it("writes no structure when no attribute maps to a member", async () => {
    const { rows, manifest } = await fixture();
    const extras = extrasLine({ imp_atr: { roof_covering: ["OTHER"], roof_style: ["GABLE", "HIP"], foundation: [], other_attributes: 0 } });
    const { files, sourcePayload } = buildTravisOutput(materializeParcelInput(rows[0], extras), { manifest });
    expect(files).not.toHaveProperty("structure.json");
    expect(sourcePayload.tcad_extras.structure_conflicting).toEqual(["roof_style"]);
  });

  it("sizes a lot the roll prints without legal acreage from its land segments", async () => {
    const { rows, manifest } = await fixture();
    const row = { ...rows[0], source_legal_acreage: "0" };
    const without = buildTravisOutput(materializeParcelInput(row), { manifest });
    expect(without.files).not.toHaveProperty("lot.json");
    const agree = buildTravisOutput(materializeParcelInput(row, extrasLine({ land: { segments: 2, size_acres_4dp: 1377, size_square_feet: 6000 } })), { manifest });
    expect(agree.files["lot.json"]).toMatchObject({ lot_area_sqft: 6000, lot_size_acre: 0.1377, lot_type: "LessThanOrEqualToOneQuarterAcre" });
    expect(agree.sourcePayload.tcad_extras.lot_area_source).toBe("LAND_DET.size_square_feet+size_acres");
    const disagree = buildTravisOutput(materializeParcelInput(row, extrasLine({ land: { segments: 1, size_acres_4dp: 5000, size_square_feet: 6000 } })), { manifest });
    expect(disagree.files["lot.json"]).toMatchObject({ lot_area_sqft: 6000, lot_size_acre: null });
    expect(disagree.sourcePayload.tcad_extras.lot_area_source).toBe("LAND_DET.size_square_feet");
    // A printed legal acreage still wins.
    const legal = buildTravisOutput(materializeParcelInput(rows[0], extrasLine({ land: { segments: 1, size_acres_4dp: 9999, size_square_feet: 43555 } })), { manifest });
    expect(legal.files["lot.json"]).toMatchObject({ lot_area_sqft: 7501, lot_size_acre: 0.1722 });
  });

  it("adds the homestead cap loss and the one entity per class's taxable value; two entities of a class are left out", async () => {
    const { rows, manifest } = await fixture();
    const classes = {
      county: [{ entity_cd: "03", entity_name: "TRAVIS COUNTY", taxable_val: "580000", partial_entity: false }],
      hospital: [{ entity_cd: "2J", entity_name: "TRAVIS COUNTY HEALTHCARE DISTRICT", taxable_val: "580000", partial_entity: false }],
      college: [{ entity_cd: "68", entity_name: "AUSTIN COMM COLL DIST", taxable_val: "575000", partial_entity: false }],
      city: [{ entity_cd: "02", entity_name: "CITY OF AUSTIN", taxable_val: "0", partial_entity: false }],
      school: [
        { entity_cd: "01", entity_name: "AUSTIN ISD", taxable_val: "480000", partial_entity: true },
        { entity_cd: "08", entity_name: "EANES ISD", taxable_val: "100000", partial_entity: true },
      ],
    };
    const extras = extrasLine({ prop: { sup_num: "0", owner_id: "77", ten_percent_cap: "20000" }, entities: { classes, other: 3, conflicting: [] } });
    const { files, sourcePayload } = buildTravisOutput(materializeParcelInput(rows[0], extras), { manifest });
    expect(files["tax_2026.json"]).toMatchObject({ homestead_cap_loss_amount: 20000, county_taxable_value_amount: 580000, hospital_taxable_value_amount: 580000, college_taxable_value_amount: 575000, city_taxable_value_amount: 0 });
    expect(files["tax_2026.json"]).not.toHaveProperty("school_taxable_value_amount");
    expect(files["tax_2026.json"]).not.toHaveProperty("property_taxable_value_amount");
    expect(sourcePayload.tcad_extras.taxable_values_not_written).toEqual([{ field: "school_taxable_value_amount", reason: "several_entities_of_class", entities: 2 }]);
    const noCap = buildTravisOutput(materializeParcelInput(rows[0], extrasLine()), { manifest });
    expect(noCap.files["tax_2026.json"]).not.toHaveProperty("homestead_cap_loss_amount");
  });

  it("refuses an extras line of another account", async () => {
    const { rows } = await fixture();
    expect(() => materializeParcelInput(rows[0], extrasLine({ prop_id: "900002" }))).toThrow(/not the printed PROP_ID/);
  });

  it("writes what v3 wrote (no structure, no new tax field) when no extras are supplied", async () => {
    const { rows, manifest } = await fixture();
    const { files, sourcePayload } = buildTravisOutput(materializeParcelInput(rows[0]), { manifest });
    expect(files).not.toHaveProperty("structure.json");
    expect(files["tax_2026.json"]).not.toHaveProperty("county_taxable_value_amount");
    expect(sourcePayload.tcad_extras).toBeNull();
  });
});
