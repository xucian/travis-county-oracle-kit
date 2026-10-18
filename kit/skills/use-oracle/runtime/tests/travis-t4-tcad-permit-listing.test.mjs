import { describe, expect, it } from "vitest";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { TCAD_PERMIT_LISTING_VERSION, buildTcadPermitListing, listingDirFor, loadTcadPermitListing, receiptFor, resolveTcadPermitListing } from "../src/counties/travis/t4-tcad-permit-listing.mjs";

import { tcadAccount, withOut, writeSpecialExport } from "./travis-t4-socrata-mock.mjs";

const ACCOUNTS = [
  tcadAccount(100001, [["2021-000001 BP", "0101010101", "2021-03-01 00:00:00"], ["2021-000001 BP", "0101010101", "2021-03-01 00:00:00"]]),
  tcadAccount(100002, [["2021-000005 BP", "0999999999", "2021-03-01 00:00:00"], [" 2021-000009 BP ", null, null], ["", null, null]]),
  tcadAccount(100003, []),
  tcadAccount(700001, [["2021-000009 BP", "0888888888", "2020-01-02 00:00:00"]], "P"),
];

describe("TCAD permit listing (ruling 25.10)", () => {
  it("builds the permit-number index from the receipted capture and loads it back", async () => {
    await withOut(async (out) => {
      const { zipPath, receiptsPath, receipt } = await writeSpecialExport(path.join(out, "lineage"), ACCOUNTS);
      const outRoot = path.join(out, "listing");
      const { dir, index } = await buildTcadPermitListing({ zipPath, receiptsPath, outRoot, log: () => {} });
      expect(dir).toBe(listingDirFor(receipt.sha256, outRoot));
      expect(index).toMatchObject({ listing_version: TCAD_PERMIT_LISTING_VERSION, source: { sha256: receipt.sha256, bytes: receipt.bytes, url: receipt.url, fetched_at: receipt.fetched_at } });
      // The repeated pair collapses; the blank permit number is counted, never listed.
      expect(index.counts).toMatchObject({ accounts: 4, array_elements: 4, accounts_listing_permits: 3, permits_listed: 5, blank_permit_numbers: 1, listed_pairs: 4, permit_numbers: 3, account_types_listing: { R: 2, P: 1 } });
      const text = await readFile(path.join(dir, "listing.tsv"), "utf8");
      expect(text.split("\n")[0]).toBe("permit_number\tprop_id\tref_property_roll\tissue_date");
      const listing = await loadTcadPermitListing(dir, { expectSourceSha256: receipt.sha256 });
      expect(listing.version).toBe(TCAD_PERMIT_LISTING_VERSION);
      expect(listing.accountsFor("2021-000001 BP")).toEqual(["100001"]);
      expect(listing.accountsFor(" 2021-000009 BP")).toEqual(["100002", "700001"]);
      expect(listing.entriesFor("2021-000005 BP")).toEqual([{ propId: "100002", refPropertyRoll: "0999999999", issueDate: "2021-03-01" }]);
      expect(listing.accountsFor("2021-999999 BP")).toEqual([]);
      const resolved = await resolveTcadPermitListing({ receiptsPath, zipFile: path.basename(zipPath), outRoot });
      expect(resolved.index.listing.sha256).toBe(index.listing.sha256);
    });
  });

  it("refuses a capture that differs from its receipt", async () => {
    await withOut(async (out) => {
      const { zipPath, receiptsPath } = await writeSpecialExport(path.join(out, "lineage"), ACCOUNTS);
      await appendFile(zipPath, "x");
      await expect(buildTcadPermitListing({ zipPath, receiptsPath, outRoot: path.join(out, "listing"), log: () => {} })).rejects.toThrow(/bytes on disk, the receipt says/);
      await expect(receiptFor(receiptsPath, "missing.zip")).rejects.toThrow(/no answered receipt/);
    });
  });

  it("refuses a truncated export and a listing edited after it was built", async () => {
    await withOut(async (out) => {
      const truncated = await writeSpecialExport(path.join(out, "truncated"), [], { text: '[\n {"pID": 1, "permits": [{"permitNumber": "2021-000001 BP"}]},\n {"pID": 2' });
      await expect(buildTcadPermitListing({ ...truncated, outRoot: path.join(out, "listing-t"), log: () => {} })).rejects.toThrow(/ends early/);
      const { zipPath, receiptsPath, receipt } = await writeSpecialExport(path.join(out, "lineage"), ACCOUNTS);
      const outRoot = path.join(out, "listing");
      const { dir } = await buildTcadPermitListing({ zipPath, receiptsPath, outRoot, log: () => {} });
      await expect(loadTcadPermitListing(dir, { expectSourceSha256: "b".repeat(64) })).rejects.toThrow(/was built from/);
      await writeFile(path.join(dir, "listing.tsv"), (await readFile(path.join(dir, "listing.tsv"), "utf8")).replace("100001", "100003"));
      await expect(loadTcadPermitListing(dir, { expectSourceSha256: receipt.sha256 })).rejects.toThrow(/differs from its index/);
      await expect(resolveTcadPermitListing({ receiptsPath, zipFile: path.basename(zipPath), outRoot: path.join(out, "nowhere") })).rejects.toThrow(/no TCAD permit listing/);
    });
  });
});
