import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseCsvRecords } from "../src/core/csv.mjs";
import { readTransformedZipJsonFiles } from "../src/core/query-table.mjs";
import { captureAndTransform } from "../src/counties/travis/adapter.mjs";
import { TRAVIS_QUERY_TABLE_SCHEMA_FIELDS, travisEnrichmentProfile } from "../src/counties/travis/enrichment-profile.mjs";
import { enrichmentProfileRegistry } from "../src/counties/enrichment-profiles.mjs";
import { COUNTY_KEY, formatOwnerName, mapTransformedFilesToQueryTableRow, travisPropertyId } from "../src/counties/travis/query-table.mjs";
import { compiledTravisRoofAgeProfile } from "../src/counties/travis/permit-profile.mjs";

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "travis-replay");

describe("Travis query-table row mapping", () => {
  it("derives a stable id and owner names", () => {
    expect(travisPropertyId("900001")).toMatch(/^[0-9a-f]{32}$/);
    expect(travisPropertyId("900001")).not.toBe(travisPropertyId("900002"));
    expect(formatOwnerName({ name: "LINDELL HOLDINGS LLC" })).toBe("LINDELL HOLDINGS LLC");
    expect(formatOwnerName({ first_name: "John", middle_name: "A", last_name: "Doe" })).toBe("John A Doe");
    expect(formatOwnerName(null)).toBeNull();
  });

  it("maps the replayed fixture parcel into the committed expected row with internal roof-age lineage", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "travis-query-table-"));
    try {
      const seedRows = parseCsvRecords(await readFile(path.join(FIXTURE_DIR, "seed.csv"), "utf8"));
      const outputDir = path.join(tempDir, "ingest");
      await captureAndTransform({ seedRows, htmlDir: path.join(FIXTURE_DIR, "html"), outputDir, liveFetch: false, asOfDate: "2026-09-14" });
      const files = readTransformedZipJsonFiles(path.join(outputDir, "900001", "transformed.zip"));
      const sourcePayload = JSON.parse(await readFile(path.join(outputDir, "900001", "source-payload.json"), "utf8"));
      const row = mapTransformedFilesToQueryTableRow({ parcelId: "900001", files, seedRow: seedRows[0], sourcePayload, asOfDate: "2026-09-14" });
      const expectedRow = JSON.parse(await readFile(path.join(FIXTURE_DIR, "expected-row.json"), "utf8"));
      expect(row).toEqual(expectedRow);
      expect(row).toMatchObject({
        geo_id: "0219080719",
        owner_kind: "person",
        owner_name: "John A Doe",
        owners_text: "DOE JOHN A & JANE DOE",
        owner_mailing_state: "TX",
        last_sale_date: "2015-06-15",
        roof_age_source: "construction_year_default",
        roof_age_confidence: "low",
        roof_age_profile_version: "travis-roof-age-profile-v1",
        roof_age_profile_sha256: compiledTravisRoofAgeProfile.sha256,
        roof_age_historical_coverage_state: "unknown",
        coordinate_basis: "parcel_centroid",
      });
      expect(Object.keys(row).sort()).toEqual(Object.keys(TRAVIS_QUERY_TABLE_SCHEMA_FIELDS).sort());

      const commercial = readTransformedZipJsonFiles(path.join(outputDir, "900002", "transformed.zip"));
      const commercialPayload = JSON.parse(await readFile(path.join(outputDir, "900002", "source-payload.json"), "utf8"));
      const commercialRow = mapTransformedFilesToQueryTableRow({ parcelId: "900002", files: commercial, seedRow: seedRows[1], sourcePayload: commercialPayload, asOfDate: "2026-09-14" });
      expect(commercialRow).toMatchObject({ owner_kind: "company", owner_mailing_state: "CO", latitude: null, coordinate_basis: null, last_sale_date: null, built_year: 1975 });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the Travis enrichment profile valid but unregistered", () => {
    expect(travisEnrichmentProfile.countyKey).toBe(COUNTY_KEY);
    expect(travisEnrichmentProfile.sunbiz.zipPrefixes).toEqual(["786", "787"]);
    expect(travisEnrichmentProfile.bbb.categories.map((category) => category.key)).toEqual(["roofing-contractors", "solar-energy-contractors", "heating-and-air-conditioning"]);
    expect(enrichmentProfileRegistry.countyKeys).not.toContain("travis");
  });
});
