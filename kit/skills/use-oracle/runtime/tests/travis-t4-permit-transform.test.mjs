import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseCsvRecords } from "../src/core/csv.mjs";
import { captureAndTransform } from "../src/counties/travis/adapter.mjs";
import { ALL, ELIGIBILITY_ENV, ELIGIBILITY_ENV_BARE, NONE, decideEligibility, isCurrentEligibility, resolveEligibilityPolicy } from "../src/counties/travis/eligibility.mjs";
import { linkPermitToParcel, summarizePermitRow } from "../src/counties/travis/permit-profile.mjs";
import { TRAVIS_PERMIT_SOURCE_HOSTS, assertOutputContract, assertTravisIdentity } from "../src/counties/travis/validate.mjs";
import {
  COPIED_FROM_APPRAISAL,
  NULL_REQUIRED_ENUMS,
  PERMIT_DATA_DIRNAME,
  PERMIT_SOURCE_PAYLOAD_FILENAME,
  buildTravisPermitOutput,
  partitionPermits,
  permitDates,
  resolvePermitGroupCids,
  writeTravisPermitTransform,
} from "../counties/travis/transforms/permit-transform.mjs";

const RUNTIME = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPLAY = path.join(RUNTIME, "fixtures", "travis-replay");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const AS_OF = "2026-10-17";
const REQUEST = {
  method: "GET",
  url: "https://data.austintexas.gov/resource/3syk-w9eu.csv",
  multiValueQueryString: { $select: ["permittype,permit_number"], $where: ["permittype = 'BP' AND calendar_year_issued = 2021"], $order: [":id"], $limit: ["50000"] },
};

function entry(propId, overrides = {}, extra = {}) {
  const row = {
    permittype: "BP",
    permit_number: "2021-015319 BP",
    description: "RE-ROOF RESIDENCE",
    work_class: "Repair",
    permit_class: "R- 435 Renovations/Remodel",
    status_current: "Final",
    applieddate: "2021-02-02T00:00:00.000",
    issue_date: "2021-02-03T00:00:00.000",
    statusdate: "2021-05-25T00:00:00.000",
    expiresdate: "2021-08-02T00:00:00.000",
    completed_date: "2021-05-24T00:00:00.000",
    tcad_id: "0219080719",
    contractor_company_name: "ACME ROOFING LLC",
    ...overrides,
  };
  const parcelsByGeoId = new Map([["0219080719", [propId]]]);
  const text = JSON.stringify(row);
  return {
    row,
    file: "partition-BP-2021.csv",
    index: 3,
    rowSha256: sha256(text),
    receiptSha256: "a".repeat(64),
    request: REQUEST,
    fetchedAt: "2026-10-17T20:57:00.000Z",
    link: linkPermitToParcel({ tcadId: row.tcad_id, parcelsByGeoId }),
    profile: summarizePermitRow(row, { asOfDate: AS_OF }),
    ...extra,
  };
}

async function appraisal(run) {
  const out = await mkdtemp(path.join(tmpdir(), "t4-permit-transform-"));
  try {
    const seedRows = parseCsvRecords(await readFile(path.join(REPLAY, "seed.csv"), "utf8"));
    const manifest = await captureAndTransform({ seedRows, htmlDir: path.join(REPLAY, "html"), outputDir: out, asOfDate: AS_OF });
    expect(manifest.reconciled.success).toBe(2);
    const lexicon = JSON.parse(await readFile(path.join(REPLAY, "lexicon-manifest.json"), "utf8"));
    return await run({ out, lexicon, seedRows });
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

describe("T4 permit eligibility", () => {
  it("requires an explicit policy and honours the two sentinels", () => {
    expect(() => resolveEligibilityPolicy({})).toThrow(/not set/);
    expect(() => resolveEligibilityPolicy({ [ELIGIBILITY_ENV]: " " })).toThrow(/not set/);
    expect(() => resolveEligibilityPolicy({ [ELIGIBILITY_ENV_BARE]: ALL })).toThrow(/not set/);
    expect(resolveEligibilityPolicy({ [ELIGIBILITY_ENV_BARE]: ALL }, { singleCounty: true })).toMatchObject({ mode: "all", source: ELIGIBILITY_ENV_BARE });
    expect(() => resolveEligibilityPolicy({ [ELIGIBILITY_ENV]: `${ALL},Commercial` })).toThrow(/stand alone/);
    const all = resolveEligibilityPolicy({ [ELIGIBILITY_ENV]: ALL });
    const none = resolveEligibilityPolicy({ [ELIGIBILITY_ENV]: NONE });
    const list = resolveEligibilityPolicy({ [ELIGIBILITY_ENV]: "Residential, Commercial,Residential" });
    expect(list.usageTypes).toEqual(["Commercial", "Residential"]);
    expect(new Set([all.fingerprint, none.fingerprint, list.fingerprint]).size).toBe(3);
    expect(resolveEligibilityPolicy({ [ELIGIBILITY_ENV]: "Commercial,Residential" }).fingerprint).toBe(list.fingerprint);
    expect(decideEligibility(all, { property_usage_type: "Residential" })).toMatchObject({ eligible: true, reason: "policy_all" });
    expect(decideEligibility(none, { property_usage_type: "Residential" })).toMatchObject({ eligible: false, reason: "policy_none" });
    expect(decideEligibility(list, { property_usage_type: "Industrial" })).toMatchObject({ eligible: false, reason: "usage_type_not_listed" });
    expect(decideEligibility(list, { property_usage_type: null })).toMatchObject({ eligible: false, reason: "no_usage_type" });
    expect(decideEligibility(list, { property_usage_type: "Commercial" })).toMatchObject({ eligible: true, usageType: "Commercial" });
    const decided = decideEligibility(none, {});
    expect(isCurrentEligibility(decided, none)).toBe(true);
    expect(isCurrentEligibility(decided, all)).toBe(false);
  });
});

describe("T4 permit transform (Property Improvement group)", () => {
  it("takes dates from confirmed evidence only and keeps the close date to Final permits", () => {
    expect(permitDates(entry("900001").row, AS_OF).fields).toEqual({ application_received_date: "2021-02-02", permit_issue_date: "2021-02-03", completion_date: "2021-05-24", permit_close_date: "2021-05-25" });
    const active = permitDates(entry("900001", { status_current: "Active", completed_date: "" }).row, AS_OF).fields;
    expect(active).toEqual({ application_received_date: "2021-02-02", permit_issue_date: "2021-02-03", completion_date: null, permit_close_date: null });
    const impossible = permitDates(entry("900001", { completed_date: "2020-01-01T00:00:00.000", statusdate: "2031-01-01T00:00:00.000" }).row, AS_OF);
    expect(impossible.fields).toMatchObject({ completion_date: null, permit_close_date: null });
    expect(impossible.evidence.completed_date).toMatchObject({ evidenceState: "invalid_quarantined", reason: "before_applied_date", raw: "2020-01-01T00:00:00.000" });
    expect(impossible.evidence.statusdate_final).toMatchObject({ evidenceState: "invalid_quarantined", reason: "future" });
  });

  it("collapses identical repeats and excludes differing repeats and blank numbers", () => {
    const a = entry("900001", { permit_number: "A" });
    const b = entry("900001", { permit_number: "B" });
    const bDiffers = entry("900001", { permit_number: "B", description: "OTHER" });
    const blank = entry("900001", { permit_number: " " });
    const result = partitionPermits([a, { ...a, index: 9 }, b, bDiffers, blank]);
    expect(result.publishable.map((item) => item.row.permit_number)).toEqual(["A"]);
    expect(result.identicalRepeats).toBe(1);
    expect(result.conflicting.map((item) => item.excluded).sort()).toEqual(["blank_permit_number", "conflicting_permit_number", "conflicting_permit_number"]);
    expect(partitionPermits([a], new Set(["A"])).conflicting).toHaveLength(1);
  });

  it("writes the group beside the appraisal output with the Seed root and the shared files byte for byte", async () => {
    await appraisal(async ({ out, lexicon, seedRows }) => {
      const parcelDir = path.join(out, "900001");
      const entries = [entry("900001"), entry("900001", { permit_number: "2019-000001 EP", permittype: "EP", status_current: "Active", completed_date: "" }, { index: 7 })];
      const result = await writeTravisPermitTransform({ parcelDir, propId: "900001", entries, manifest: lexicon, asOfDate: AS_OF });
      const { propertyImprovementCid, seedCid } = resolvePermitGroupCids(lexicon);
      expect(result).toMatchObject({ published: 2, conflicting: 0, dataDir: path.join(parcelDir, PERMIT_DATA_DIRNAME) });
      for (const name of [...COPIED_FROM_APPRAISAL, `${seedCid}.json`]) {
        expect(sha256(await readFile(path.join(result.dataDir, name))), name).toBe(sha256(await readFile(path.join(parcelDir, "data", name))));
      }
      const names = (await readdir(result.dataDir)).sort();
      expect(names).toEqual(
        [
          "address.json",
          `${propertyImprovementCid}.json`,
          `${seedCid}.json`,
          "parcel.json",
          "property.json",
          "property_improvement_1.json",
          "property_improvement_2.json",
          "relationship_address_has_parcel.json",
          "relationship_property_has_property_improvement_1.json",
          "relationship_property_has_property_improvement_2.json",
        ].sort(),
      );
      const files = Object.fromEntries(await Promise.all(names.map(async (name) => [name, JSON.parse(await readFile(path.join(result.dataDir, name), "utf8"))])));
      assertOutputContract(files, { countyCid: propertyImprovementCid, seedCid });
      assertTravisIdentity({ row: seedRows[0], files, roots: { countyCid: propertyImprovementCid, seedCid }, sourceHosts: TRAVIS_PERMIT_SOURCE_HOSTS });
      expect(() => assertTravisIdentity({ row: seedRows[0], files, roots: { countyCid: propertyImprovementCid, seedCid } })).toThrow(/data\.austintexas\.gov/);
      expect(files[`${propertyImprovementCid}.json`]).toEqual({
        label: "Property Improvement",
        relationships: { property_has_property_improvement: [{ "/": "./relationship_property_has_property_improvement_1.json" }, { "/": "./relationship_property_has_property_improvement_2.json" }] },
      });
      // Ordered by permit number: the EP permit of 2019 first.
      expect(files["property_improvement_1.json"]).toEqual({
        permit_number: "2019-000001 EP",
        application_received_date: "2021-02-02",
        permit_issue_date: "2021-02-03",
        completion_date: null,
        permit_close_date: null,
        final_inspection_date: null,
        ...Object.fromEntries(NULL_REQUIRED_ENUMS.map((key) => [key, null])),
        source_http_request: REQUEST,
        request_identifier: "900001",
      });
      expect(files["property_improvement_2.json"]).toMatchObject({ permit_number: "2021-015319 BP", completion_date: "2021-05-24", permit_close_date: "2021-05-25" });
      expect(files["relationship_property_has_property_improvement_2.json"]).toEqual({ from: { "/": "./property.json" }, to: { "/": "./property_improvement_2.json" } });
      const sidecar = JSON.parse(await readFile(path.join(parcelDir, PERMIT_SOURCE_PAYLOAD_FILENAME), "utf8"));
      expect(sidecar.published.map((item) => item.permit_number)).toEqual(["2019-000001 EP", "2021-015319 BP"]);
      expect(sidecar.published[1]).toMatchObject({ printed: { description: "RE-ROOF RESIDENCE", contractor_company_name: "ACME ROOFING LLC" }, profile: { roofWorkClass: "primary_roof_replacement" }, capture: { file: "partition-BP-2021.csv", row_index: 3 } });
      expect(JSON.stringify(sidecar)).not.toMatch(/applicant/);
    });
  });

  it("writes no group for a parcel without publishable permits and refuses a row linked elsewhere", async () => {
    await appraisal(async ({ out, lexicon }) => {
      const parcelDir = path.join(out, "900002");
      const none = await writeTravisPermitTransform({ parcelDir, propId: "900002", entries: [], manifest: lexicon, asOfDate: AS_OF });
      expect(none).toMatchObject({ dataDir: null, published: 0 });
      expect((await readdir(parcelDir)).includes(PERMIT_DATA_DIRNAME)).toBe(false);
      expect(JSON.parse(await readFile(none.sourcePayloadPath, "utf8"))).toMatchObject({ prop_id: "900002", published: [], excluded: [] });
      await expect(writeTravisPermitTransform({ parcelDir, propId: "900002", entries: [entry("900001")], manifest: lexicon, asOfDate: AS_OF })).rejects.toThrow(/linked to 900001, not 900002/);
      expect(() => buildTravisPermitOutput({ propId: "900001", entries: [], manifest: lexicon, seedRootName: "other.json", asOfDate: AS_OF })).toThrow(/Seed root/);
      expect(() => resolvePermitGroupCids({ entries: {} })).toThrow(/Property_Improvement/);
    });
  });
});
