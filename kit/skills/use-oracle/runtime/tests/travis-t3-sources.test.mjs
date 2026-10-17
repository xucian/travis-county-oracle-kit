import { describe, expect, it } from "vitest";

import { DETAIL_URL_VERSION, businessDetailUrl, INDIVIDUAL_OWNER_TYPES, PRIVACY_VERSION, T3_SOURCES, TDLR_LICFILE_COLUMNS_V1, resolveTsbpeColumns, salesTaxPrivacyClass, snapshotFieldName, sosFileNumberJoinKey, tdlrPermitRole } from "../src/counties/travis/t3-sources.mjs";
import { entityKeyOf, resolveColumnSet } from "../src/counties/travis/t3-snapshot.mjs";

describe("T3 source rules", () => {
  it("classes sole owners of the sales-tax file as individual_owner and nothing else", () => {
    expect(PRIVACY_VERSION).toBe("travis-t3-privacy.v2");
    expect(INDIVIDUAL_OWNER_TYPES).toEqual(["IS", "S"]);
    expect(salesTaxPrivacyClass({ taxpayer_organization_type__trimmed: "IS" })).toBe("individual_owner");
    expect(salesTaxPrivacyClass({ taxpayer_organization_type__trimmed: "S" })).toBe("individual_owner");
    // Partnerships, estates and trusts are entities with their own numbers (decisions.md section 24.4).
    for (const type of ["CL", "CT", "PL", "PI", "PZ", "ES", "TR", "GS", "P", null]) expect(salesTaxPrivacyClass({ taxpayer_organization_type__trimmed: type })).toBeNull();
    expect(T3_SOURCES["tx-comptroller-sales-tax"].privacy).toMatchObject({ version: PRIVACY_VERSION, withheldColumns: ["taxpayer_number"] });
    // The franchise file prints entities only; no privacy rule applies to it.
    expect(T3_SOURCES["tx-comptroller-franchise-tax"].privacy).toBeUndefined();
  });

  it("joins SOS file numbers on the digits, padded to the franchise file's 10-digit width", () => {
    expect(sosFileNumberJoinKey("801234567")).toBe("0801234567");
    expect(sosFileNumberJoinKey("0801234567")).toBe("0801234567");
    expect(sosFileNumberJoinKey(" 801234567 ")).toBe("0801234567");
    for (const value of ["", "80123456A", "12345678901", null, undefined, 801234567]) expect(sosFileNumberJoinKey(value)).toBeNull();
  });

  it("maps the TDLR header to snapshot fields under its column set and refuses any other header", () => {
    expect(snapshotFieldName("MAILING ADDRESS CITY, STATE ZIP")).toBe("mailing_address_city_state_zip");
    expect(snapshotFieldName("Phone-same or not")).toBe("phone_same_or_not");
    expect(snapshotFieldName("2nd Line")).toBe("c_2nd_line");
    const source = T3_SOURCES["tdlr-license-files"];
    const set = resolveColumnSet(source, [...TDLR_LICFILE_COLUMNS_V1]);
    expect(set.version).toBe("tdlr-licfile-columns.v1");
    expect(set.fields).toHaveLength(23);
    expect(set.fields.slice(0, 3)).toEqual(["license_type", "license_number", "license_expiration_date"]);
    expect(() => resolveColumnSet(source, [...TDLR_LICFILE_COLUMNS_V1, "NEW COLUMN"])).toThrow(/matches no column set/);
    // Socrata sources keep their printed API field names.
    expect(resolveColumnSet(T3_SOURCES["tx-comptroller-franchise-tax"], ["taxpayer_number", "_621111"])).toMatchObject({ version: "printed", fields: ["taxpayer_number", "_621111"] });
  });

  it("names the permit role of every license type TDLR printed and leaves unknown types unclassified", () => {
    expect(tdlrPermitRole("Electrical Contractor")).toBe("contractor");
    expect(tdlrPermitRole("A/C Contractor")).toBe("contractor");
    expect(tdlrPermitRole("Master Electrician")).toBe("qualifying_individual");
    expect(tdlrPermitRole("Apprentice Electrician")).toBe("works_under_a_contractor");
    expect(tdlrPermitRole("A/C CE Provider")).toBe("not_a_trade_license");
    expect(tdlrPermitRole("Roofing Contractor")).toBe("unclassified");
  });

  it("finds the TSBPE license, name and company columns, and stops on a header it cannot read", () => {
    const fields = (printed) => printed.map(snapshotFieldName);
    const full = ["License Number", "Name", "Company Name", "County"];
    expect(resolveTsbpeColumns(fields(full), full)).toMatchObject({ keyColumns: ["license_number"], nameColumns: ["name__trimmed", "company_name__trimmed"], roles: { license_number: "license_number", holder_name: "name", company: "company_name", county: "county" } });
    const split = ["LicenseNo", "First Name", "Last Name", "Business"];
    const resolved = resolveTsbpeColumns(fields(split), split);
    expect(resolved.keyColumns).toEqual(["licenseno"]);
    expect(resolved.extraMatchNames({ first_name__trimmed: "PAT", last_name__trimmed: "PLUMBER" })).toEqual(["PAT PLUMBER"]);
    expect(resolved.scopeOf({})).toBe("statewide");
    const none = ["Number", "Holder"];
    expect(() => resolveTsbpeColumns(fields(none), none)).toThrow(/no license number column/);
    const two = ["License Number", "Lic No", "Name"];
    expect(() => resolveTsbpeColumns(fields(two), two)).toThrow(/several license number columns/);
    const twoCompanies = ["License Number", "Name", "Company", "Employer"];
    expect(() => resolveTsbpeColumns(fields(twoCompanies), twoCompanies)).toThrow(/several company columns/);
  });

  it("reads the Responsible Master Plumber header captured on 2026-10-17, taking the plumbing company, not the insurer", () => {
    const printed = ["RANK", "LICENSE_NBR", "LIC_STATUS", "LICENSE_DATE", "EXPIRATION_DTE", "LAST_NAME", "FIRST_NAME", "MIDDLE_NAME", "SUFFIX", "ADDR1", "ADDR2", "ADDR3", "CITY", "STATE", "ZIP", "PHONE", "COUNTY", "MEDGAS_ENDR", "MRF_ENDR", "WS_ENDR", "INS_EXPIRY_DTE", "PLUMB_COMPANY", "INSURANCE_COMPANY"];
    const resolved = resolveTsbpeColumns(printed.map(snapshotFieldName), printed);
    expect(resolved.keyColumns).toEqual(["license_nbr"]);
    expect(resolved.nameColumns).toEqual(["plumb_company__trimmed"]);
    expect(resolved.roles).toMatchObject({ license_number: "license_nbr", holder_name: null, first_name: "first_name", middle_name: "middle_name", last_name: "last_name", company: "plumb_company", county: "county" });
    expect(resolved.extraMatchNames({ first_name__trimmed: "PAT", middle_name__trimmed: "Q", last_name__trimmed: "PLUMBER" })).toEqual(["PAT Q PLUMBER"]);
    expect(resolved.scopeOf({ county__trimmed: "Travis" })).toBe("travis");
    expect(resolved.scopeOf({ county__trimmed: "HARRIS" })).toBe("out_of_county");
  });

  it("gives franchise rows the account status page by taxpayer number and every other row none", () => {
    expect(DETAIL_URL_VERSION).toBe("travis-comptroller-detail-url.v1");
    expect(businessDetailUrl("tx-comptroller-franchise-tax", { taxpayer_number__trimmed: "32000000001" })).toBe("https://comptroller.texas.gov/taxes/franchise/account-status/search/32000000001");
    expect(businessDetailUrl("tx-comptroller-franchise-tax", { taxpayer_number__trimmed: "3200000000" })).toBeNull();
    expect(businessDetailUrl("tx-comptroller-franchise-tax", { taxpayer_number__trimmed: null })).toBeNull();
    // Sales-tax rows (a withheld sole owner's above all) and veteran rows get no detail URL.
    expect(businessDetailUrl("tx-comptroller-sales-tax", { taxpayer_number__trimmed: "32000000001" })).toBeNull();
    expect(businessDetailUrl("tx-comptroller-sales-tax", { taxpayer_number__trimmed: null, _privacy_class: "individual_owner" })).toBeNull();
    expect(businessDetailUrl("tx-sos-veteran-owned-business", { filing_number__trimmed: "801000001" })).toBeNull();
  });

  it("keys TDLR licenses by type, subtype and number, a blank subtype included (decisions.md 24.3)", () => {
    const source = T3_SOURCES["tdlr-license-files"];
    const reg = { license_type__trimmed: "A/C Technician", license_subtype__trimmed: "REG", license_number__trimmed: "123", _row_sha256: "a" };
    const cer = { ...reg, license_subtype__trimmed: "CER", _row_sha256: "b" };
    const blank = { ...reg, license_subtype__trimmed: null, _row_sha256: "c" };
    expect(new Set([entityKeyOf(source, reg), entityKeyOf(source, cer), entityKeyOf(source, blank)]).size).toBe(3);
    expect(entityKeyOf(source, blank)).toBe("A/C Technician\u001f\u001f123");
    expect(entityKeyOf(source, { ...reg, license_number__trimmed: null })).toBe("row:a");
  });
});
