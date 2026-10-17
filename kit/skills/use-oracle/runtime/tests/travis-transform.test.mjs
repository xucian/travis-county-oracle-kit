import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseCsvRecords } from "../src/core/csv.mjs";
import { materializeParcelInput } from "../src/counties/travis/adapter.mjs";
import { assertOutputContract, assertTravisIdentity } from "../src/counties/travis/validate.mjs";
import {
  TRANSFORM_VERSION,
  buildTravisOutput,
  classifyOwnerName,
  mapStateCode,
  parseDeedDate,
  resolveDataGroupCids,
  splitPersonName,
  stripOwnerAnnotations,
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
    expect(parseDeedDate("04-29-2002")).toBe("2002-04-29");
    expect(parseDeedDate("06/15/2015")).toBe("2015-06-15");
    expect(parseDeedDate("2015-02-30")).toBeNull();
    expect(parseDeedDate("")).toBeNull();
  });
});

describe("v2 rules: owner annotations, TCAD state codes, areas, situs (T2 pilot findings)", () => {
  it("removes the roll's owner annotations before classifying and splitting, on whole words only", () => {
    expect(stripOwnerAnnotations("SMITH JOHN ETAL")).toBe("SMITH JOHN");
    expect(stripOwnerAnnotations("SMITH JOHN ET AL")).toBe("SMITH JOHN");
    expect(stripOwnerAnnotations("DOE JANE (LIFE ESTATE)")).toBe("DOE JANE");
    expect(stripOwnerAnnotations("DOE JANE LIFE ESTATE &")).toBe("DOE JANE");
    expect(stripOwnerAnnotations("ACME HOLDINGS LLC % JOHN DOE")).toBe("ACME HOLDINGS LLC");
    expect(stripOwnerAnnotations("LLOBET ALAN")).toBe("LLOBET ALAN");
    expect(classifyOwnerName("SMITH JOHN ETAL")).toBe("person");
    expect(splitPersonName("SMITH JOHN ETAL")).toEqual({ first_name: "John", last_name: "Smith", middle_name: null, suffix_name: null });
    expect(splitPersonName("DOE JANE M LIFE ESTATE")).toEqual({ first_name: "Jane", last_name: "Doe", middle_name: "M", suffix_name: null });
    expect(splitPersonName("LLOBET ALAN")).toEqual({ first_name: "Alan", last_name: "Llobet", middle_name: null, suffix_name: null });
    expect(classifyOwnerName("DOE JOHN ESTATE")).toBe("company");
    expect(classifyOwnerName("DOE JOHN TRST")).toBe("company");
    expect(classifyOwnerName("DOE JANE LIFE ESTATE")).toBe("person");
    expect(classifyOwnerName("ETAL")).toBe("unknown");
  });

  it("classifies the roll's organizational owners, including spaced abbreviations and truncated trust names", () => {
    for (const owner of ["GSGB L P", "PFLUGERVILLE I S D", "LAKEWAY M U D", "L C R A", "COSSA GREBMORF L L C", "ENGLISH JOANNE K REVOCABLE", "SOUTHERN PACIFIC TRANSPORTATION", "AUSTIN PUBLIC SCHOOLS", "PALISADES ON BARTON CREEK"]) {
      expect(classifyOwnerName(owner), owner).toBe("company");
    }
    for (const owner of ["STOWELL AUSTIN & STEPHANIE", "TAYLOR CHRISTIAN CADE", "PARISH DOUGLAS W", "PLAZA VALERIE MICHELLE", "SMITH JOHN L"]) {
      expect(classifyOwnerName(owner), owner).toBe("person");
    }
  });

  it("maps TCAD's own state codes (STATE_CD.TXT), not the Florida-style table", () => {
    expect(mapStateCode("A3", 1000)).toMatchObject({ propertyType: "MiscellaneousResidential", usageType: "Residential", mapped: true });
    expect(mapStateCode("A4", 250000)).toMatchObject({ propertyType: "Condominium", usageType: "Residential" });
    expect(mapStateCode("A5", 0)).toMatchObject({ propertyType: "Condominium" });
    expect(mapStateCode("B1", 1)).toMatchObject({ propertyType: "MultipleFamily", usageType: "Residential" });
    expect(mapStateCode("B3", 1)).toMatchObject({ propertyType: "3Units" });
    expect(mapStateCode("D1", 0)).toMatchObject({ propertyType: "LandParcel", usageType: "Agricultural" });
    expect(mapStateCode("E1", 90000)).toMatchObject({ propertyType: "Building", usageType: null, mapped: true });
    expect(mapStateCode("F4", 1)).toMatchObject({ propertyType: "Unit", usageType: "Commercial" });
    expect(mapStateCode("J4", 1)).toMatchObject({ usageType: "TelecommunicationsFacility" });
    expect(mapStateCode("J5", 0)).toMatchObject({ propertyType: "LandParcel", usageType: "Railroad" });
    expect(mapStateCode("O1", 0)).toMatchObject({ propertyType: "LandParcel", usageType: "Residential", buildStatus: "VacantLand" });
    expect(mapStateCode("X", 0)).toMatchObject({ propertyType: "LandParcel", usageType: null, mapped: true });
  });

  it("writes no lot for a zero legal acreage, no living area under 10 sqft, and keeps the raw codes in the sidecar", async () => {
    const { rows, manifest, roots } = await fixture();
    const input = materializeParcelInput({ ...rows[0], source_legal_acreage: "0", source_living_area_sqft: "0" });
    const { files, sourcePayload } = buildTravisOutput(input, { manifest });
    expect(files).not.toHaveProperty("lot.json");
    expect(files["property.json"]).toMatchObject({ livable_floor_area: null, total_area: null });
    expect(sourcePayload).toMatchObject({ legal_acreage: 0, state_cd: "A1", state_cd_description: "SINGLE FAMILY RESIDENCE", imprv_state_cd: "A1" });
    const checked = assertOutputContract(files, roots);
    expect(checked.rootKeys).not.toContain("property_has_lot");
  });

  it("fails an account whose roll row prints no situs street instead of inventing an address", async () => {
    const { rows, manifest } = await fixture();
    const input = materializeParcelInput({ ...rows[0], address: "", source_situs_num: "", source_situs_street: "", source_situs_street_suffix: "" });
    expect(() => buildTravisOutput(input, { manifest })).toThrow(/no situs address/);
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
        "sales_history_has_person",
      ].sort(),
    );

    const seedRoot = files[`${roots.seedCid}.json`];
    expect(seedRoot.label).toBe("Seed");
    expect(Object.keys(seedRoot)).toEqual(["label", "relationships"]);
    // The Seed root elephant-cli transform writes itself (#251): address_has_parcel only (decisions.md section 22).
    expect(seedRoot.relationships).toEqual({ address_has_parcel: { "/": "./relationship_address_has_parcel.json" } });
    expect(files["relationship_address_has_parcel.json"]).toEqual({ from: { "/": "./address.json" }, to: { "/": "./parcel.json" } });
    expect(files).not.toHaveProperty("property_seed.json");
    expect(files).not.toHaveProperty("unnormalized_address.json");
    expect(Object.keys(files).some((name) => name.includes("property_seed"))).toBe(false);

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
    expect(property.source_http_request).toEqual({ method: "GET", url: "https://traviscad.org/wp-content/largefiles/2026%20Certified%20Appraisal%20Export%20Supp%200_07182026.zip" });
    expect(URL_PATTERN.test(property.source_http_request.url)).toBe(true);
    expect(files["address.json"]).toMatchObject({ unnormalized_address: "804 PARK BLVD, AUSTIN TX 78751", city_name: "AUSTIN", state_code: "TX", postal_code: "78751", block: "A", lot: "1" });
    // total_area is building area: the roll prints living area only, and the lot area lives on the lot.
    expect(property).toMatchObject({ livable_floor_area: "1800", total_area: null });
    expect(files["address.json"]).not.toHaveProperty("county_name");
    expect(files["person_1.json"]).toMatchObject({ first_name: "John", last_name: "Doe", middle_name: "A", suffix_name: null, birth_date: null });
    expect(files["mailing_address.json"]).toMatchObject({ unnormalized_address: "804 PARK BLVD, AUSTIN TX 78751", state_code: "TX", postal_code: "78751" });
    expect(files["sales_history_1.json"]).toMatchObject({ ownership_transfer_date: "2015-06-15" });
    expect(files["sales_history_1.json"]).not.toHaveProperty("purchase_price_amount");
    expect(files["tax_2026.json"]).toMatchObject({ tax_year: 2026, property_market_value_amount: 600000, property_assessed_value_amount: 580000, property_land_amount: 250000, property_building_amount: 350000 });
    // Taxable values are per taxing entity in the export; the transform never proxies them from the assessed value.
    expect(files["tax_2026.json"]).not.toHaveProperty("property_taxable_value_amount");
    expect(files["tax_2026.json"]).not.toHaveProperty("agricultural_valuation_amount");
    expect(files["lot.json"]).toMatchObject({ lot_area_sqft: 7501, lot_size_acre: 0.1722, lot_type: "LessThanOrEqualToOneQuarterAcre" });

    const geometry = files["geometry.json"];
    expect(geometry.latitude).toBeCloseTo(30.30215, 4);
    expect(geometry.polygon).toHaveLength(5);
    expect(geometry.source_http_request.url).toBe("https://gis.traviscountytx.gov/server1/rest/services/Boundaries_and_Jurisdictions/TCAD_public/MapServer/0/query");
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
      source_http_request: { method: "GET", url: "https://traviscad.org/wp-content/largefiles/2026%20Certified%20Appraisal%20Export%20Supp%200_07182026.zip" },
      request_identifier: "900002",
    });
    expect(files["mailing_address.json"]).toMatchObject({ state_code: "CO", postal_code: "80201" });
    expect(files["property.json"]).toMatchObject({ property_type: "Building", property_usage_type: "Commercial" });
    expect(files["address.json"].latitude).toBeNull();
    // Blank situs city: the city is never derived from the ZIP, the mailing address or GIS.
    expect(files["address.json"]).toMatchObject({ unnormalized_address: "2206 LINDELL AVE, TX 78704", city_name: null, postal_code: "78704", block: "3", lot: "7" });
    expect(files).not.toHaveProperty("unnormalized_address.json");
  });

  it("fails closed on a wrong input schema, a missing bulk request, or a manifest without the groups", async () => {
    const { rows, manifest } = await fixture();
    const input = materializeParcelInput(rows[0]);
    expect(() => buildTravisOutput({ ...input, schemaVersion: "other" }, { manifest })).toThrow(/unsupported parcel input schema/);
    expect(() => buildTravisOutput({ ...input, request: { method: "GET", url: "" } }, { manifest })).toThrow(/bulk GET actually made/);
    expect(() => buildTravisOutput(input, { manifest: { entries: {} } })).toThrow(/County and Seed/);
    expect(() => buildTravisOutput({ ...input, propId: "R1" }, { manifest })).toThrow(/printed PROP_ID/);
  });

  it("writes no owner entity or mailing address for an owner the roll flags confidential, but keeps the deed date", async () => {
    const { rows, manifest, roots } = await fixture();
    const input = materializeParcelInput({ ...rows[0], source_owner_confidential: "T", source_py_owner_name: "", source_py_addr_line1: "" });
    const { files, warnings, sourcePayload } = buildTravisOutput(input, { manifest });
    expect(warnings).toContain("owner flagged confidential by the roll; no owner entity or mailing address written");
    expect(files).not.toHaveProperty("person_1.json");
    expect(files).not.toHaveProperty("company_1.json");
    expect(files).not.toHaveProperty("mailing_address.json");
    expect(files["sales_history_1.json"]).toMatchObject({ ownership_transfer_date: "2015-06-15" });
    expect(sourcePayload.owner).toMatchObject({ classification: "confidential", printed_name: null, owner_key: null });
    assertOutputContract(files, roots);
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

describe("assertTravisIdentity (wrong-county check, decisions.md section 22)", () => {
  it("accepts the fixture parcel and fails closed on every wrong-county signal", async () => {
    const { rows, manifest, roots } = await fixture();
    const { files } = buildTravisOutput(materializeParcelInput(rows[0]), { manifest });
    const row = rows[0];
    expect(() => assertTravisIdentity({ row, files, roots })).not.toThrow();
    expect(() => assertTravisIdentity({ row: { ...row, county: "Williamson", county_fips: "48491" }, files, roots })).toThrow(/not a Travis record: seed row names county "Williamson"/);
    expect(() => assertTravisIdentity({ row: { ...row, county_fips: "48201" }, files, roots })).toThrow(/FIPS "48201"/);
    expect(() => assertTravisIdentity({ row: { ...row, parcel_id: "900099" }, files, roots })).toThrow(/request_identifier "900001" is not the seed row's parcel_id 900099/);
    const foreign = { ...files, "tax_2026.json": { ...files["tax_2026.json"], source_http_request: { method: "GET", url: "https://hcad.org/roll.zip" } } };
    expect(() => assertTravisIdentity({ row, files: foreign, roots })).toThrow(/tax_2026.json source_http_request host "hcad.org" is not an appraisal source/);
    expect(() => assertTravisIdentity({ row, files: { ...files, "address.json": { ...files["address.json"], state_code: "OK" } }, roots })).toThrow(/state_code "OK" is not TX/);
    expect(() => assertTravisIdentity({ row, files: { ...files, "address.json": { ...files["address.json"], county_name: "Hays" } }, roots })).toThrow(/county_name "Hays" is not Travis/);
    expect(() => assertTravisIdentity({ row, files: { ...files, "address.json": { ...files["address.json"], county_name: "Travis" } }, roots })).not.toThrow();
    const outside = { ...files, "geometry.json": { ...files["geometry.json"], latitude: 29.7, longitude: -95.4 } };
    expect(() => assertTravisIdentity({ row, files: outside, roots })).toThrow(/outside the Travis bbox/);
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
