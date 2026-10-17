import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { harvestAustinPermits } from "../src/counties/travis/t4-permit-fetch.mjs";
import { readRollGeoIndex, runLinkPass, streamCsvFile } from "../src/counties/travis/t4-permit-links.mjs";

import { context, socrata, withOut } from "./travis-t4-socrata-mock.mjs";

/** A five-account roll: two accounts share one geo_id; the multi-line legal text is quoted. */
const SEED = [
  "parcel_id,source_identifier,geo_id,method,url,multiValueQueryString,address,legal",
  '100001,100001,0101010101,GET,https://traviscad.org/x.zip,{},"100 MAIN ST, TX 78701","LOT 1\nBLK A"',
  '100002,100002,0202020202,GET,https://traviscad.org/x.zip,{},"200 OAK AVE, TX 78702",LOT 2',
  '100003,100003,0303030303,GET,https://traviscad.org/x.zip,{},"300 ELM DR, TX 78703",LOT 3',
  '100004,100004,0303030303,GET,https://traviscad.org/x.zip,{},"300 ELM DR UNIT B, TX 78703",LOT 3B',
  '1234567,1234567,0404040404,GET,https://traviscad.org/x.zip,{},"400 PINE LN, TX 78704","LOT ""4"""',
].join("\n");

const permit = (overrides) => ({ permittype: "BP", calendar_year_issued: "2021", issue_date: "2021-03-01T00:00:00.000", applieddate: "2021-02-01T00:00:00.000", status_current: "Final", completed_date: "2021-05-01T00:00:00.000", statusdate: "2021-05-01T00:00:00.000", work_class: "Repair", permit_class: "R- 435 Renovations/Remodel", description: "REMODEL KITCHEN", ...overrides });

const ROWS = [
  permit({ permit_number: "2021-000001 BP", tcad_id: "0101010101", description: "RE-ROOF RESIDENCE" }),
  permit({ permit_number: "2021-000002 BP", tcad_id: "0101010101", status_current: "Active", completed_date: "" }),
  permit({ permit_number: "2021-000003 BP", tcad_id: "0303030303" }),
  permit({ permit_number: "2021-000004 BP", tcad_id: "" }),
  permit({ permit_number: "2021-000005 BP", tcad_id: "0999999999" }),
  permit({ permit_number: "2021-000006 BP", tcad_id: "R320021", latitude: "30.47" }),
  permit({ permit_number: "2021-000007 EP", permittype: "EP", tcad_id: "0202020202", status_current: "Pending" }),
  permit({ permit_number: "2021-000007 EP", permittype: "EP", tcad_id: "0202020202", status_current: "Pending" }),
  permit({ permit_number: "2021-000008 BP", tcad_id: "0202020202", description: "ROOF", status_current: "Expired", completed_date: "" }),
];

describe("T4 permit link pass", () => {
  it("streams a CSV with quoted newlines and doubled quotes, keeping only the asked columns", async () => {
    await withOut(async (out) => {
      const file = path.join(out, "seed.csv");
      await writeFile(file, `${SEED}\n`);
      const rows = [];
      for await (const row of streamCsvFile(file, { columns: ["parcel_id", "legal"] })) rows.push(row);
      expect(rows).toEqual([
        { parcel_id: "100001", legal: "LOT 1\nBLK A" },
        { parcel_id: "100002", legal: "LOT 2" },
        { parcel_id: "100003", legal: "LOT 3" },
        { parcel_id: "100004", legal: "LOT 3B" },
        { parcel_id: "1234567", legal: 'LOT "4"' },
      ]);
    });
  });

  it("indexes the roll by geo_id and re-proves the digits-only normalization", async () => {
    await withOut(async (out) => {
      const file = path.join(out, "seed.csv");
      await writeFile(file, `${SEED}\n`);
      const roll = await readRollGeoIndex(file);
      expect(roll.stats).toMatchObject({ seed_rows: 5, distinct_geo_ids: 4, shared_geo_ids: 1, accounts_on_shared_geo_ids: 2, non_ten_digit_geo_ids: 0 });
      expect(roll.proof.oneToOne).toBe(true);
      expect(roll.byGeoId.get("0303030303")).toEqual(["100003", "100004"]);
      expect(roll.seedSha256).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it("links on geo_id exactly, keeps every unlinked reason, and returns the selected parcels' rows with provenance", async () => {
    await withOut(async (out) => {
      const file = path.join(out, "seed.csv");
      await writeFile(file, `${SEED}\n`);
      const roll = await readRollGeoIndex(file);
      const capture = await harvestAustinPermits({ out: path.join(out, "permits"), context: context(socrata({ data: ROWS })) });
      const { summary, selected } = await runLinkPass({ captureDir: capture.versionDir, roll, asOfDate: "2026-10-17", select: new Set(["100001", "100003", "1234567"]) });
      expect(summary.rows).toBe(9);
      expect(summary.link_method).toEqual({ exact: 5, normalized_digits: 0 });
      expect(summary.unlinked_reasons).toEqual({ no_candidate: 2, multiple_candidates: 1, invalid_quarantined: 1 });
      expect(summary.no_candidate_detail).toEqual({ blank_tcad_id: 1, ten_digit_not_in_roll: 1 });
      expect(summary.linked_parcels).toBe(2);
      expect(summary.issue_date_max).toBe("2021-03-01");
      expect(summary.tcad_id_quarantine_reasons).toEqual({ williamson_cad_account_form: 1 });
      expect(summary.williamson_cad_tcad_id).toMatchObject({ account_form_rows: 1, marker_rows: 0, with_coordinates: 1, north_of_30_40: 1 });
      expect(summary.ten_digit_not_in_roll).toMatchObject({ rows: 1, distinct_geo_ids: 1, by_issue_decade: { "2020s": { not_in_roll: 1, in_roll: 6 } } });
      expect(summary.permit_number).toMatchObject({ printed_more_than_once: 1, rows_under_repeated_numbers: 2, repeated_rows_identical_to_first: 1, printed_on_differing_rows: 0 });
      expect(summary.status_vocabulary.new_unmapped_values).toEqual([]);
      expect(summary.status_group).toEqual({ closed: 5, open: 1, needs_review: 2, stalled: 1 });
      expect(summary.roof_work_class).toMatchObject({ primary_roof_replacement: 1, needs_review: 1 });
      expect(summary.needs_review_descriptions_top).toEqual([{ normalized_description: "ROOF", rows: 1 }]);
      expect([...selected.keys()].sort()).toEqual(["100001"]);
      const rows = selected.get("100001");
      expect(rows.map((entry) => entry.row.permit_number)).toEqual(["2021-000001 BP", "2021-000002 BP"]);
      for (const entry of rows) {
        expect(entry.link.propertyLink).toEqual({ match_method: "exact", normalization_version: null, confidence: "exact" });
        expect(entry.rowSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(entry.request.url).toBe("https://data.austintexas.gov/resource/3syk-w9eu.csv");
        expect(entry.request.multiValueQueryString.$where).toEqual(["permittype = 'BP' AND calendar_year_issued = 2021"]);
        expect(entry.row.applicant_full_name).toBeUndefined();
      }
    });
  });

  it("refuses a partition whose bytes no longer match its receipt", async () => {
    await withOut(async (out) => {
      const file = path.join(out, "seed.csv");
      await writeFile(file, `${SEED}\n`);
      const roll = await readRollGeoIndex(file);
      const capture = await harvestAustinPermits({ out: path.join(out, "permits"), context: context(socrata({ data: ROWS })) });
      await writeFile(path.join(capture.versionDir, "partition-BP-2021.csv"), "changed\n");
      await expect(runLinkPass({ captureDir: capture.versionDir, roll, asOfDate: "2026-10-17" })).rejects.toThrow(/bytes differ from the receipt/);
    });
  });
});
