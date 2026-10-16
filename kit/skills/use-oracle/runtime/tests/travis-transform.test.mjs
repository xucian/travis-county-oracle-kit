import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseCsvRecords } from "../src/core/csv.mjs";
import { materializeParcelInput } from "../src/counties/travis/adapter.mjs";
import { assertOutputContract } from "../src/counties/travis/validate.mjs";
import {
  TRANSFORM_VERSION,
  buildTravisOutput,
  classifyOwnerName,
  mapStateCode,
  parseDeedDate,
  resolveDataGroupCids,
  splitPersonName,
  toTitleCase,
} from "../counties/travis/transforms/transform.mjs";

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "travis-replay");
const NAME_PATTERN = /^[A-Z][a-z]*([ \-',.][A-Za-z][a-z]*)*$/;
const URL_PATTERN = /^https?:\/\/[a-zA-Z0-9.-]+(:[0-9]+)?(\/[#a-zA-Z0-9._%-]+)*$/;

async function fixture() {
  const rows = parseCsvRecords(await readFile(path.join(FIXTURE_DIR, "seed.csv"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(FIXTURE_DIR, "lexicon-manifest.json"), "utf8"));
  return { rows, manifest, roots: resolveDataGroupCids(manifest) };
}

describe("owner classification and normalization (decisions.md section 16)", () => {
  it("classifies companies by whole tokens and phrases, persons otherwise", () => {
    expect(classifyOwnerName("LINDELL HOLDINGS LLC")).toBe("company");
    expect(classifyOwnerName("CITY OF AUSTIN")).toBe("company");
    expect(classifyOwnerName("DOE FAMILY TRUST")).toBe("company");
    expect(classifyOwnerName("DOE JOHN A")).toBe("person");
    expect(classifyOwnerName("INCE MARY")).toBe("person");
    expect(classifyOwnerName("")).toBe("unknown");
    expect(classifyOwnerName(null)).toBe("unknown");
  });

  it("splits LAST FIRST MIDDLE into pattern-valid person fields and keeps co-owners out of the entity", () => {
    expect(splitPersonName("DOE JOHN A & JANE DOE")).toEqual({ first_name: "John", last_name: "Doe", middle_name: "A", suffix_name: null });
    expect(splitPersonName("O'BRIEN MARY-ANN JR")).toEqual({ first_name: "Mary-Ann", last_name: "O'Brien", middle_name: null, suffix_name: "Jr." });
    expect(splitPersonName("SMITH")).toBeNull();
    for (const value of ["Doe", "O'Brien", "Mary-Ann", "St John"]) expect(NAME_PATTERN.test(toTitleCase(value.toUpperCase()))).toBe(true);
  });

  it("maps TCAD state codes and deed dates conservatively", () => {
    expect(mapStateCode("A1", 350000)).toMatchObject({ propertyType: "SingleFamily", usageType: "Residential", buildStatus: "Improved", mapped: true });
    expect(mapStateCode("C1", 0)).toMatchObject({ propertyType: "VacantLand", buildStatus: "VacantLand" });
    expect(mapStateCode("F2", 10)).toMatchObject({ propertyType: "Building", usageType: "Industrial" });
    expect(mapStateCode("Z9", 10)).toMatchObject({ propertyType: "Building", mapped: false });
    expect(mapStateCode("Z9", 0)).toMatchObject({ propertyType: "LandParcel", mapped: false });
    expect(parseDeedDate("2015-06-15")).toBe("2015-06-15");
    expect(parseDeedDate("06/15/2015")).toBe("2015-06-15");
    expect(parseDeedDate("2015-02-30")).toBeNull();
    expect(parseDeedDate("")).toBeNull();
  });
});

describe("buildTravisOutput (output contract)", () => {
  it("writes the Seed and County groups for the residential fixture parcel", async () => {
    const { rows, manifest, roots } = await fixture();
    const input = materializeParcelInput(rows[0]);
    const { files, warnings, sourcePayload } = buildTravisOutput(input, { manifest });
    expect(warnings).toEqual([]);
    const checked = assertOutputContract(files, roots);
    expect(checked.rootKeys.sort()).toEqual(
      [
        "address_has_geometry",
        "address_has_parcel",
        "parcel_has_geometry",
        "person_has_mailing_address",
        "property_has_address",
        "property_has_lot",
        "property_has_parcel",
        "property_has_sales_history",
        "property_has_tax",
        "property_seed",
        "sales_history_has_person",
      ].sort(),
    );

    const seedRoot = files[`${roots.seedCid}.json`];
    expect(seedRoot.label).toBe("Seed");
    expect(Object.keys(seedRoot)).toEqual(["label", "relationships"]);
    expect(files["property_seed.json"]).toMatchObject({ parcel_id: "900001", request_identifier: "900001" });
    expect(files["unnormalized_address.json"]).toMatchObject({ full_address: "804 PARK BLVD, AUSTIN TX 78751", county_jurisdiction: "Travis" });
    expect(files["relationship_address_has_parcel.json"]).toEqual({ from: { "/": "./address.json" }, to: { "/": "./parcel.json" } });

    const property = files["property.json"];
    expect(property).toMatchObject({
      parcel_identifier: "900001",
      property_type: "SingleFamily",
      property_usage_type: "Residential",
      build_status: "Improved",
      property_structure_built_year: 1998,
      subdivision: "FIXTURE ADDN",
      request_identifier: "900001",
    });
    expect(property).not.toHaveProperty("source_payload");
    for (const body of Object.values(files)) expect(body).not.toHaveProperty("source_payload");
    expect(sourcePayload).toMatchObject({
      schemaVersion: "travis.source-payload.v1",
      transform_version: TRANSFORM_VERSION,
      geo_id: "0219080719",
      state_cd: "A1",
      owner: { classification: "person", printed_name: "DOE JOHN A & JANE DOE", owner_key: "900001:DOE JOHN A & JANE DOE" },
    });
    expect(property.source_http_request).toEqual({ method: "GET", url: "https://traviscad.org/wp-content/largefiles/2026-Certified-Appraisal-Export.zip" });
    expect(URL_PATTERN.test(property.source_http_request.url)).toBe(true);
    expect(files["address.json"]).toMatchObject({ unnormalized_address: "804 PARK BLVD, AUSTIN TX 78751", city_name: "AUSTIN", state_code: "TX", postal_code: "78751" });
    expect(files["address.json"]).not.toHaveProperty("county_name");
    expect(files["person_1.json"]).toMatchObject({ first_name: "John", last_name: "Doe", middle_name: "A", suffix_name: null, birth_date: null });
    expect(files["mailing_address.json"]).toMatchObject({ unnormalized_address: "804 PARK BLVD, AUSTIN TX 78751", state_code: "TX", postal_code: "78751" });
    expect(files["sales_history_1.json"]).toMatchObject({ ownership_transfer_date: "2015-06-15" });
    expect(files["sales_history_1.json"]).not.toHaveProperty("purchase_price_amount");
    expect(files["tax_2026.json"]).toMatchObject({ tax_year: 2026, property_market_value_amount: 600000, property_assessed_value_amount: 580000, property_taxable_value_amount: 580000, property_land_amount: 250000, property_building_amount: 350000 });
    expect(files["tax_2026.json"]).not.toHaveProperty("agricultural_valuation_amount");
    expect(files["lot.json"]).toMatchObject({ lot_area_sqft: 7501, lot_size_acre: 0.1722, lot_type: "LessThanOrEqualToOneQuarterAcre" });

    const geometry = files["geometry.json"];
    expect(geometry.latitude).toBeCloseTo(30.30215, 4);
    expect(geometry.polygon).toHaveLength(5);
    expect(geometry.source_http_request.url).toBe("https://gis.traviscountytx.gov/server1/rest/services/Boundaries_and_Jurisdictions/TCAD_public/FeatureServer/0/query");
    expect(geometry.source_http_request.multiValueQueryString.where).toEqual(["1=1"]);
    expect(URL_PATTERN.test(geometry.source_http_request.url)).toBe(true);
    for (const [name, body] of Object.entries(files)) {
      if (name.startsWith("relationship_") || name.startsWith("bafkrei")) continue;
      expect(body.request_identifier, name).toBe("900001");
      expect(body.source_http_request?.url, name).toBeTruthy();
    }
  });

  it("handles the commercial fixture parcel: company owner, no deed date, no geometry", async () => {
    const { rows, manifest, roots } = await fixture();
    const { files, warnings } = buildTravisOutput(materializeParcelInput(rows[1]), { manifest });
    expect(warnings).toEqual(["no TNR geometry for this parcel; geometry.json omitted"]);
    const checked = assertOutputContract(files, roots);
    expect(checked.rootKeys).toContain("company_has_property");
    expect(checked.rootKeys).not.toContain("property_has_sales_history");
    expect(files).not.toHaveProperty("geometry.json");
    expect(files["company_1.json"]).toEqual({
      name: "LINDELL HOLDINGS LLC",
      sunbiz_document_number: null,
      source_http_request: { method: "GET", url: "https://traviscad.org/wp-content/largefiles/2026-Certified-Appraisal-Export.zip" },
      request_identifier: "900002",
    });
    expect(files["mailing_address.json"]).toMatchObject({ state_code: "CO", postal_code: "80201" });
    expect(files["property.json"]).toMatchObject({ property_type: "Building", property_usage_type: "Commercial" });
    expect(files["address.json"].latitude).toBeNull();
    expect(files["unnormalized_address.json"].latitude).toBeNull();
  });

  it("fails closed on a wrong input schema, a missing bulk request, or a manifest without the groups", async () => {
    const { rows, manifest } = await fixture();
    const input = materializeParcelInput(rows[0]);
    expect(() => buildTravisOutput({ ...input, schemaVersion: "other" }, { manifest })).toThrow(/unsupported parcel input schema/);
    expect(() => buildTravisOutput({ ...input, request: { method: "GET", url: "" } }, { manifest })).toThrow(/bulk GET actually made/);
    expect(() => buildTravisOutput(input, { manifest: { entries: {} } })).toThrow(/County and Seed/);
    expect(() => buildTravisOutput({ ...input, propId: "R1" }, { manifest })).toThrow(/printed PROP_ID/);
  });

  it("keeps an unsplittable owner out of the entities but in source_payload", async () => {
    const { rows, manifest, roots } = await fixture();
    const input = materializeParcelInput({ ...rows[0], source_py_owner_name: "SMITH" });
    const { files, warnings, sourcePayload } = buildTravisOutput(input, { manifest });
    expect(warnings.some((warning) => /could not be split/.test(warning))).toBe(true);
    expect(files).not.toHaveProperty("person_1.json");
    expect(files).not.toHaveProperty("mailing_address.json");
    expect(sourcePayload.owner.printed_name).toBe("SMITH");
    assertOutputContract(files, roots);
  });
});

describe("assertOutputContract", () => {
  it("rejects a missing root, a dangling link and an unlinked entity", async () => {
    const { rows, manifest, roots } = await fixture();
    const { files } = buildTravisOutput(materializeParcelInput(rows[0]), { manifest });
    const withoutRoot = { ...files };
    delete withoutRoot[`${roots.seedCid}.json`];
    expect(() => assertOutputContract(withoutRoot, roots)).toThrow(/missing data-group root/);
    const dangling = { ...files, "relationship_property_has_address.json": { from: { "/": "./property.json" }, to: { "/": "./nowhere.json" } } };
    expect(() => assertOutputContract(dangling, roots)).toThrow(/must link two existing entity files/);
    const unlinked = { ...files, "orphan.json": { request_identifier: "900001" } };
    expect(() => assertOutputContract(unlinked, roots)).toThrow(/not linked by any relationship/);
  });
});
