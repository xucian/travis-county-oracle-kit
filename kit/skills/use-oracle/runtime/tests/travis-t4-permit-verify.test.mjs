import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { harvestAustinPermits } from "../src/counties/travis/t4-permit-fetch.mjs";
import { latestCapture, verifyPermitCapture } from "../src/counties/travis/t4-permit-verify.mjs";

import { context, socrata, withOut } from "./travis-t4-socrata-mock.mjs";

describe("T4 permit capture verification (offline)", () => {
  it("verifies a clean capture: receipts, plan, counts and the versioned header", async () => {
    await withOut(async (out) => {
      const summary = await harvestAustinPermits({ out, context: context(socrata()) });
      expect(await latestCapture(out)).toBe(summary.versionDir);
      const report = await verifyPermitCapture(summary.versionDir);
      expect(report.mismatches).toEqual([]);
      expect(report).toMatchObject({ ok: true, count_json: 8, planned_rows: 8, rows_parsed: 8, partitions_planned: 3, partition_files: 3, csv_files_verified: 3, header_mismatches: 0 });
    });
  });

  it("verifies a month-split capture", async () => {
    await withOut(async (out) => {
      const summary = await harvestAustinPermits({ out, limit: 5, context: context(socrata()) });
      const report = await verifyPermitCapture(summary.versionDir);
      expect(report.mismatches).toEqual([]);
      expect(report).toMatchObject({ ok: true, rows_parsed: 8, partitions_planned: 3, partition_files: 14 });
    });
  });

  it("fails on a changed file, a dropped row and a capture.json that disagrees", async () => {
    await withOut(async (out) => {
      const summary = await harvestAustinPermits({ out, context: context(socrata()) });
      const file = path.join(summary.versionDir, "partition-BP-2022.csv");
      const original = await readFile(file, "utf8");
      await writeFile(file, original.replace("REMODEL", "REMODEX"));
      const changed = await verifyPermitCapture(summary.versionDir);
      expect(changed.ok).toBe(false);
      expect(changed.mismatches.join("\n")).toMatch(/partition-BP-2022\.csv: sha256/);
      const lines = original.trimEnd().split("\n");
      await writeFile(file, `${lines.slice(0, -1).join("\n")}\n`);
      const dropped = await verifyPermitCapture(summary.versionDir);
      expect(dropped.mismatches.join("\n")).toMatch(/partition-BP-2022\.csv: 4 rows, planned 5/);
      await writeFile(file, original);
      const capturePath = path.join(summary.versionDir, "capture.json");
      const capture = JSON.parse(await readFile(capturePath, "utf8"));
      await writeFile(capturePath, JSON.stringify({ ...capture, rows: 9 }));
      expect((await verifyPermitCapture(summary.versionDir)).mismatches).toEqual(["capture.json rows 9, files 8"]);
    });
  });

  it("refuses a header that carries a column the profile does not collect", async () => {
    await withOut(async (out) => {
      const summary = await harvestAustinPermits({ out, context: context(socrata()) });
      const file = path.join(summary.versionDir, "partition-EP-2021.csv");
      const text = await readFile(file, "utf8");
      // Rewrite the file and its receipt digest so only the header check can catch it.
      const tampered = text.replace('"permittype"', '"applicant_full_name"');
      await writeFile(file, tampered);
      const { createHash } = await import("node:crypto");
      const receiptsPath = path.join(summary.versionDir, "receipts.jsonl");
      const receipts = (await readFile(receiptsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      for (const receipt of receipts) if (receipt.file === "partition-EP-2021.csv") Object.assign(receipt, { sha256: createHash("sha256").update(tampered).digest("hex"), bytes: Buffer.byteLength(tampered) });
      await writeFile(receiptsPath, `${receipts.map((receipt) => JSON.stringify(receipt)).join("\n")}\n`);
      const report = await verifyPermitCapture(summary.versionDir);
      expect(report.ok).toBe(false);
      expect(report.mismatches).toContain("partition-EP-2021.csv: header is not the versioned column set");
      expect(report.mismatches).toContain("partition-EP-2021.csv: column applicant_full_name is not collected by the profile");
    });
  });
});
