import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  NOT_COLLECTED_PERSONAL,
  NOT_COLLECTED_ROLLING,
  PERMIT_COLUMNS_V1,
  compareColumns,
  harvestAustinPermits,
  partitionFile,
  partitionUrl,
  partitionWhere,
  planPartitions,
} from "../src/counties/travis/t4-permit-fetch.mjs";
import { sourceHttpRequest } from "../src/counties/travis/t3-fetch.mjs";

import { ALL_COLUMNS, context, socrata, withOut } from "./travis-t4-socrata-mock.mjs";

describe("T4 Austin permit harvester: request shape", () => {
  it("collects every named column except the applicant fields and the rolling flag", () => {
    expect(PERMIT_COLUMNS_V1).toHaveLength(60);
    for (const column of [...NOT_COLLECTED_PERSONAL, ...NOT_COLLECTED_ROLLING]) expect(PERMIT_COLUMNS_V1).not.toContain(column);
    expect(compareColumns(ALL_COLUMNS.map((fieldName) => ({ fieldName })))).toMatchObject({ ok: true, unexpected: [], missing: [] });
    expect(compareColumns([...ALL_COLUMNS, "applicant_email"].map((fieldName) => ({ fieldName })))).toMatchObject({ ok: false, unexpected: ["applicant_email"] });
    expect(compareColumns(ALL_COLUMNS.slice(1).map((fieldName) => ({ fieldName })))).toMatchObject({ ok: false, missing: ["permittype"] });
  });

  it("builds a stable partition request with no offset", () => {
    const url = partitionUrl({ permittype: "BP", year: 2021 });
    const request = sourceHttpRequest(url);
    expect(request.url).toBe("https://data.austintexas.gov/resource/3syk-w9eu.csv");
    expect(request.multiValueQueryString.$where).toEqual(["permittype = 'BP' AND calendar_year_issued = 2021"]);
    expect(request.multiValueQueryString.$order).toEqual([":id"]);
    expect(request.multiValueQueryString.$limit).toEqual(["50000"]);
    expect(request.multiValueQueryString.$offset).toBeUndefined();
    expect(request.multiValueQueryString.$select[0].split(",")).toEqual([...PERMIT_COLUMNS_V1]);
    expect(partitionUrl({ permittype: "BP", year: 2021 })).toBe(url);
    expect(partitionWhere({ permittype: null, year: null })).toBe("permittype IS NULL AND calendar_year_issued IS NULL");
    expect(partitionWhere({ permittype: "O'X", year: 2021, month: 12 })).toBe("permittype = 'O''X' AND calendar_year_issued = 2021 AND issue_date >= '2021-12-01T00:00:00' AND issue_date < '2022-01-01T00:00:00'");
    expect(partitionFile({ permittype: "BP", year: 2021, month: 3 })).toBe("partition-BP-2021-03.csv");
    expect(partitionFile({ permittype: null, year: null })).toBe("partition-NULL-NULL.csv");
  });

  it("plans partitions from the group-by answer and marks those at the limit for a month split", () => {
    const plan = planPartitions([{ permittype: "EP", calendar_year_issued: "2021", n: "5" }, { permittype: "BP", calendar_year_issued: 2022, n: "10" }, { permittype: "BP", calendar_year_issued: null, n: "1" }], 10);
    expect(plan).toEqual([
      { permittype: "BP", year: null, expected_rows: 1, split: false },
      { permittype: "BP", year: 2022, expected_rows: 10, split: true },
      { permittype: "EP", year: 2021, expected_rows: 5, split: false },
    ]);
    expect(() => planPartitions([{ permittype: "BP", calendar_year_issued: "2021", n: "1" }, { permittype: "BP", calendar_year_issued: "2021", n: "2" }])).toThrow(/repeats/);
    expect(() => planPartitions([{ permittype: "BP", calendar_year_issued: "20x1", n: "1" }])).toThrow(/integer/);
  });
});

describe("T4 Austin permit harvester: capture", () => {
  it("captures every partition with a receipt, never requests an applicant column, and reconciles the counts", async () => {
    await withOut(async (out) => {
      const net = socrata({ failOnce: new Set(["calendar_year_issued+%3D+2022"]) });
      const summary = await harvestAustinPermits({ out, context: context(net) });
      expect(summary).toMatchObject({ consistent: true, expected_rows: 8, planned_rows: 8, rows: 8, partitions: 3, resumed: 0, egress: { country: "RO", gating: false } });
      for (const url of net.requests) {
        for (const column of NOT_COLLECTED_PERSONAL) expect(url).not.toContain(column);
        expect(url).not.toContain("issued_in_last_30_days");
        expect(new URL(url).searchParams.get("$offset")).toBeNull();
      }
      const files = (await readdir(summary.versionDir)).sort();
      expect(files.filter((file) => file.endsWith(".csv"))).toEqual(["partition-BP-2021.csv", "partition-BP-2022.csv", "partition-EP-2021.csv"]);
      const receipts = (await readFile(path.join(summary.versionDir, "receipts.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const pages = receipts.filter((receipt) => receipt.kind === "page");
      expect(pages.filter((receipt) => receipt.status === 429)).toHaveLength(1);
      const ok = pages.filter((receipt) => receipt.status === 200);
      expect(ok.map((receipt) => [receipt.file, receipt.rows, receipt.expected_rows]).sort()).toEqual([
        ["partition-BP-2021.csv", 2, 2],
        ["partition-BP-2022.csv", 5, 5],
        ["partition-EP-2021.csv", 1, 1],
      ]);
      for (const receipt of ok) {
        expect(receipt.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(receipt.source_http_request.multiValueQueryString.$where[0]).toMatch(/^permittype = '(BP|EP)' AND calendar_year_issued = 20\d\d$/);
      }
      const header = (await readFile(path.join(summary.versionDir, "partition-BP-2021.csv"), "utf8")).split("\n")[0];
      expect(header.split(",").map((cell) => cell.replaceAll('"', ""))).toEqual([...PERMIT_COLUMNS_V1]);
    });
  });

  it("resumes intact partitions without a request and refetches a tampered one", async () => {
    await withOut(async (out) => {
      const net = socrata();
      const first = await harvestAustinPermits({ out, context: context(net) });
      const again = socrata();
      const second = await harvestAustinPermits({ out, context: context(again) });
      expect(second).toMatchObject({ consistent: true, rows: 8, resumed: 5 });
      expect(again.requests.filter((url) => url.includes(".csv"))).toEqual([]);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path.join(first.versionDir, "partition-EP-2021.csv"), "tampered\n");
      const third = socrata();
      const repaired = await harvestAustinPermits({ out, context: context(third) });
      expect(repaired).toMatchObject({ consistent: true, rows: 8 });
      expect(third.requests.filter((url) => url.includes(".csv"))).toHaveLength(1);
    });
  });

  it("splits a partition at the limit by issue month", async () => {
    await withOut(async (out) => {
      const summary = await harvestAustinPermits({ out, limit: 5, context: context(socrata()) });
      expect(summary).toMatchObject({ consistent: true, rows: 8, partitions_split_by_month: ["partition-BP-2022.csv"] });
      const files = (await readdir(summary.versionDir)).filter((file) => file.endsWith(".csv")).sort();
      expect(files).toContain("partition-BP-2022-01.csv");
      expect(files).toContain("partition-BP-2022-07.csv");
      expect(files).toContain("partition-BP-2022-12.csv");
    });
  });

  it("marks the capture inconsistent when the dataset changes mid-capture or a partition is short", async () => {
    await withOut(async (out) => {
      const changed = await harvestAustinPermits({ out, context: context(socrata({ versionOf: (call) => (call === 1 ? 1 : 2) })) });
      expect(changed.consistent).toBe(false);
      expect(changed.inconsistency[0]).toMatch(/updated during the capture/);
    });
    await withOut(async (out) => {
      const short = await harvestAustinPermits({ out, context: context(socrata({ dropRowFrom: 2021 })) });
      expect(short.consistent).toBe(false);
      expect(JSON.stringify(short.inconsistency)).toContain("partition_row_mismatches");
    });
  });

  it("stops before any data request when the column set differs", async () => {
    await withOut(async (out) => {
      const net = socrata({ columns: [...ALL_COLUMNS, "applicant_email"] });
      await expect(harvestAustinPermits({ out, context: context(net) })).rejects.toThrow(/column set differs.*applicant_email/);
      expect(net.requests.filter((url) => url.includes("/resource/"))).toEqual([]);
    });
  });
});
