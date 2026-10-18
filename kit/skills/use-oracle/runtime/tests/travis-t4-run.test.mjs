import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ELIGIBILITY_ENV } from "../src/counties/travis/eligibility.mjs";
import { harvestAustinPermits } from "../src/counties/travis/t4-permit-fetch.mjs";
import { nextDay, parseCliOutput, parseFaultDrill, runT4 } from "../src/counties/travis/t4-run.mjs";
import { TCAD_PERMIT_LISTING_VERSION, buildTcadPermitListing, loadTcadPermitListing } from "../src/counties/travis/t4-tcad-permit-listing.mjs";

import { context, socrata, tcadAccount, withOut, writeSpecialExport } from "./travis-t4-socrata-mock.mjs";

const RUNTIME = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPLAY = path.join(RUNTIME, "fixtures", "travis-replay");
const permit = (overrides) => ({ permittype: "BP", calendar_year_issued: "2021", issue_date: "2021-03-01T00:00:00.000", applieddate: "2021-02-01T00:00:00.000", status_current: "Final", completed_date: "2021-05-01T00:00:00.000", statusdate: "2021-05-01T00:00:00.000", work_class: "Repair", permit_class: "R- 435 Renovations/Remodel", description: "RE-ROOF RESIDENCE", ...overrides });
// 900001 (geo_id 0219080719) has two permits; 900002 (0403010404) has none; one permit is on another county's id.
const ROWS = [permit({ permit_number: "2021-000001 BP", tcad_id: "0219080719" }), permit({ permit_number: "2021-000002 EP", permittype: "EP", tcad_id: "0219080719", status_current: "Active", completed_date: "" }), permit({ permit_number: "2021-000003 BP", tcad_id: "R320021" })];

const saved = process.env[ELIGIBILITY_ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[ELIGIBILITY_ENV];
  else process.env[ELIGIBILITY_ENV] = saved;
});

async function setup(out) {
  const capture = await harvestAustinPermits({ out: path.join(out, "permits"), context: context(socrata({ data: ROWS })) });
  return { captureDir: capture.versionDir, rollSeed: path.join(REPLAY, "seed.csv"), manifestFile: path.join(REPLAY, "lexicon-manifest.json"), seedPath: path.join(REPLAY, "seed.csv"), runsDir: path.join(out, "runs"), cli: null };
}

describe("T4 run orchestration (no elephant-cli)", () => {
  it("parses the CLI lines it reads and the fault drill", () => {
    const parsed = parseCliOutput(
      [
        '{"level":"info","message":"x"}',
        "Properties processed: 25, succeeded: 24, failed: 1",
        "CAR written: /x/travis-county.car (471 blocks, root bafyroot)",
        "  Blocks:                 471",
        "  Properties:             25",
        "  Data groups validated:  50",
        "  integrity errors:       0",
        "  root errors:            0",
        "  index errors:           0",
        "  graph errors:           0",
        "  lexicon errors:         0",
        "  orphans errors:         0",
        "✅ CAR passed every check",
        "Tables written: /x/t (23 tables, 23 parts, root bafytables)",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      processed: { processed: 25, succeeded: 24, failed: 1 },
      car: { blocks: 471, root: "bafyroot" },
      tables: { tables: 23, parts: 23, root: "bafytables" },
      car_validation: { blocks: 471, properties: 25, data_groups_validated: 50, integrity_errors: 0, root_errors: 0, index_errors: 0, graph_errors: 0, lexicon_errors: 0, orphans_errors: 0, passed: true },
    });
    expect(parseFaultDrill("permanent:1, retryable:2")).toEqual({ permanent: new Set(["1"]), retryable: new Set(["2"]) });
    expect(() => parseFaultDrill("slow:1")).toThrow(/fault-drill/);
    expect(nextDay("2026-10-17")).toBe("2026-10-18");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
  });

  it("refuses to run without an explicit eligibility policy", async () => {
    await withOut(async (out) => {
      delete process.env[ELIGIBILITY_ENV];
      await expect(runT4({ ...(await setup(out)), label: "test" })).rejects.toThrow(/not set/);
    });
  });

  it("__ALL__: the permit path and the permit-less path, each parcel in one state", async () => {
    await withOut(async (out) => {
      process.env[ELIGIBILITY_ENV] = "__ALL__";
      const record = await runT4({ ...(await setup(out)), label: "test" });
      expect(record.appraisal.reconciled).toMatchObject({ seedRows: 2, success: 2 });
      expect(record.eligibility).toEqual({ eligible: 2, not_eligible: 0 });
      expect(record.permit_states).toEqual({ done: 1, done_zero_permits: 1 });
      expect(record.parcels["900001"]).toMatchObject({ status: "done", permits_linked: 2, permits_published: 2, permits_printing_geo_id: 2 });
      expect(record.parcels["900002"]).toMatchObject({ status: "done_zero_permits", permits_linked: 0, permits_printing_geo_id: 0 });
      expect(record.permits.link_pass_capture_totals).toMatchObject({ rows: 3, linked: 2, unlinked_reasons: { out_of_county: 1 } });
      expect(record.groups).toEqual({ county: 2, property_improvement: 1 });
      const runDir = path.join(RUNTIME, record.run_dir);
      expect((await readdir(path.join(runDir, "validate", "property_improvement"))).sort()).toEqual(["900001"]);
      expect(existsSync(path.join(runDir, "900001", "permit-data.partial"))).toBe(false);
      expect(JSON.parse(await readFile(path.join(runDir, "900002", "eligibility.json"), "utf8"))).toMatchObject({ eligible: true, reason: "policy_all" });
      expect(record.timings.stages.permit_link_pass.items).toBe(3);
      expect(record.no_publication).toMatch(/no upload/);
    });
  });

  it("publishes a retired geo_id's permit under the one account TCAD's listing names, and fingerprints the listing (ruling 25.10)", async () => {
    await withOut(async (out) => {
      process.env[ELIGIBILITY_ENV] = "__ALL__";
      const retired = permit({ permit_number: "2021-000004 BP", tcad_id: "0999999999" });
      const capture = await harvestAustinPermits({ out: path.join(out, "permits"), context: context(socrata({ data: [...ROWS, retired] })) });
      const lineage = await writeSpecialExport(path.join(out, "lineage"), [tcadAccount(900001, [["2021-000001 BP", "0219080719"]]), tcadAccount(900002, [["2021-000004 BP", "0999999999", "2021-03-01 00:00:00"]])]);
      const { dir } = await buildTcadPermitListing({ ...lineage, outRoot: path.join(out, "listing"), log: () => {} });
      const tcadListing = await loadTcadPermitListing(dir, { expectSourceSha256: lineage.receipt.sha256 });
      const record = await runT4({ ...(await setup(out)), captureDir: capture.versionDir, label: "listing", tcadListing });
      expect(record.permit_states).toEqual({ done: 2 });
      expect(record.parcels["900002"]).toMatchObject({ status: "done", permits_linked: 1, permits_published: 1, permits_printing_geo_id: 0 });
      expect(record.permits.by_link_method).toEqual({ exact: 2, tcad_permit_listing: 1 });
      expect(record.permits.link_pass_capture_totals.link_method).toEqual({ exact: 2, normalized_digits: 0, tcad_permit_listing: 1 });
      expect(record.versions).toMatchObject({ parcel_link: "travis-parcel-link-v3", tcad_permit_listing: TCAD_PERMIT_LISTING_VERSION });
      expect(record.tcad_permit_listing).toMatchObject({ listing_sha256: tcadListing.index.listing.sha256, source_sha256: lineage.receipt.sha256 });
      const runDir = path.join(RUNTIME, record.run_dir);
      const status = JSON.parse(await readFile(path.join(runDir, "900002", "permit-status.json"), "utf8"));
      expect(status.fingerprint).toMatchObject({ parcel_link: "travis-parcel-link-v3", tcad_permit_listing: tcadListing.index.listing.sha256 });
      const sidecar = JSON.parse(await readFile(path.join(runDir, "900002", "permit-source-payload.json"), "utf8"));
      expect(sidecar.published[0].link).toMatchObject({ property_id: "900002", property_link: { match_method: "tcad_permit_listing", confidence: "official_listing", listing_source_sha256: lineage.receipt.sha256 }, tcad_id_evidence: { value: "0999999999" }, listing: { listed_accounts: 1, current_accounts: 1 }, listing_entries: [{ propId: "900002", refPropertyRoll: "0999999999", issueDate: "2021-03-01" }] });
      const exactSidecar = JSON.parse(await readFile(path.join(runDir, "900001", "permit-source-payload.json"), "utf8"));
      expect(exactSidecar.published.map((item) => [item.link.property_link.match_method, item.link.listing, item.link.listing_entries])).toEqual([["exact", null, null], ["exact", null, null]]);
      const published = JSON.parse(await readFile(path.join(runDir, "900002", "permit-data", "property_improvement_1.json"), "utf8"));
      expect(published).toMatchObject({ permit_number: "2021-000004 BP", request_identifier: "900002", source_http_request: { url: "https://data.austintexas.gov/resource/3syk-w9eu.csv" } });
      expect((await readdir(path.join(runDir, "validate", "property_improvement"))).sort()).toEqual(["900001", "900002"]);
    });
  });

  it("cross-checks each geo_id with Socrata through the capture's latest issue date", async () => {
    await withOut(async (out) => {
      process.env[ELIGIBILITY_ENV] = "__ALL__";
      // The server has grown by one permit on 900001's geo_id, issued after the capture's latest issue date.
      const later = permit({ permit_number: "2026-000009 BP", tcad_id: "0219080719", calendar_year_issued: "2026", issue_date: "2026-10-20T00:00:00.000" });
      const server = socrata({ data: [...ROWS, later] });
      const record = await runT4({ ...(await setup(out)), label: "cross", crossCheck: true, fetchImpl: server.fetchImpl });
      expect(record.socrata_cross_check).toMatchObject({ geo_ids: 2, equal: 2, differs: [], issued_through: "2021-03-01", rows_issued_after_now: 1 });
      const counts = server.requests.filter((url) => url.includes("tcad_id"));
      expect(counts).toHaveLength(2);
      for (const url of counts) expect(new URL(url).searchParams.get("$where")).toMatch(/^tcad_id = '\d{10}' AND issue_date < '2021-03-02T00:00:00'$/);
    });
  });

  it("__NONE__: appraisal only, no permit artifacts", async () => {
    await withOut(async (out) => {
      process.env[ELIGIBILITY_ENV] = "__NONE__";
      const record = await runT4({ ...(await setup(out)), label: "none" });
      expect(record.permit_states).toEqual({ not_eligible: 2 });
      expect(record.groups).toEqual({ county: 2, property_improvement: 0 });
      const runDir = path.join(RUNTIME, record.run_dir);
      expect(existsSync(path.join(runDir, "900001", "permit-data"))).toBe(false);
      expect(existsSync(path.join(runDir, "900001", "permit-source-payload.json"))).toBe(false);
      expect(record.timings.stages.permit_link_pass).toEqual({ skipped: "no eligible parcel" });
      expect(record.permits.link_pass_capture_totals).toBeNull();
    });
  });

  it("fault drill: a permanent failure stays dead, a retryable one completes on resume", async () => {
    await withOut(async (out) => {
      process.env[ELIGIBILITY_ENV] = "__ALL__";
      const options = await setup(out);
      const drilled = await runT4({ ...options, label: "drill", drill: parseFaultDrill("permanent:900002,retryable:900001") });
      expect(drilled.permit_states).toEqual({ failed_permanent: 1, failed_retryable: 1 });
      expect(drilled.parcels["900002"]).toMatchObject({ status: "failed_permanent", drill: true });
      expect(drilled.groups.property_improvement).toBe(0);
      const runDir = path.join(RUNTIME, drilled.run_dir);
      const ledger = (await readFile(path.join(runDir, "_run", "travis-t4-drill-permits", "failures.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(ledger.map((entry) => [entry.parcelId, entry.classification]).sort()).toEqual([["900001", "transient"], ["900002", "permanent"]]);
      const resumed = await runT4({ ...options, label: "drill", resumeDir: runDir });
      expect(resumed.attempts).toHaveLength(2);
      expect(resumed.permit_states).toEqual({ done: 1, failed_permanent: 1 });
      expect(resumed.parcels["900002"]).toMatchObject({ status: "failed_permanent", resumed: true });
      expect(resumed.parcels["900001"]).toMatchObject({ status: "done", permits_published: 2, resumed: false });
      // Link methods count the completed parcels only, the resumed ones included.
      expect(drilled.permits.by_link_method).toEqual({});
      expect(resumed.permits).toMatchObject({ permits_linked: 2, by_link_method: { exact: 2 } });
      expect((await readdir(path.join(runDir, "validate-r2", "property_improvement"))).sort()).toEqual(["900001"]);
    });
  });
});
