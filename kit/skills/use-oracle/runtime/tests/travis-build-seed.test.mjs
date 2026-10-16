import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseCsvRecords } from "../src/core/csv.mjs";
import {
  TCAD_COLUMN_CANDIDATES,
  buildTravisSeed,
  pageTnrLayer,
  readTnrCache,
  resolveColumnMap,
  summarizeImprovements,
  toCanonicalTcadRow,
} from "../src/counties/travis/build-seed.mjs";
import { TCAD_SOURCE_FIELDS } from "../src/counties/travis/seed.mjs";

const SQUARE = [[-97.723, 30.3018], [-97.7218, 30.3018], [-97.7218, 30.3025], [-97.723, 30.3025], [-97.723, 30.3018]];

describe("TCAD column resolution", () => {
  it("has candidates for every retained field and resolves case-insensitively", () => {
    for (const field of TCAD_SOURCE_FIELDS) expect(TCAD_COLUMN_CANDIDATES[field], field).toBeDefined();
    const { map, missing } = resolveColumnMap(["PROP_ID", "GEO_ID", "py_owner_name", "Situs_Street", "deed_dt"]);
    expect(map.prop_id).toBe("PROP_ID");
    expect(map.situs_street).toBe("Situs_Street");
    expect(missing).toContain("state_cd");
    expect(toCanonicalTcadRow({ PROP_ID: " 900001 ", GEO_ID: "0219080719", py_owner_name: "DOE JOHN" }, map)).toMatchObject({ prop_id: "900001", geo_id: "0219080719", py_owner_name: "DOE JOHN" });
  });

  it("fails loud when a required column resolves nowhere", () => {
    expect(() => resolveColumnMap(["owner", "value"])).toThrow(/required columns: prop_id, geo_id/);
  });

  it("summarizes improvement details per PROP_ID (earliest year, summed area, count)", () => {
    const summary = summarizeImprovements([
      { prop_id: "1", yr_built: "1998", living_area_sqft: "1200" },
      { prop_id: "1", yr_built: "2005", living_area_sqft: "600" },
      { prop_id: "2", yr_built: "", living_area_sqft: "" },
    ]);
    expect(summary.get("1")).toEqual({ yr_built: "1998", living_area_sqft: "1800", imprv_count: "2" });
    expect(summary.get("2")).toEqual({ yr_built: "", living_area_sqft: "", imprv_count: "1" });
  });
});

describe("TNR paging", () => {
  it("refuses from non-US egress before any layer request", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return new Response("RO", { status: 200 });
    };
    const tempDir = await mkdtemp(path.join(tmpdir(), "travis-tnr-"));
    try {
      await expect(pageTnrLayer({ cacheDir: tempDir, fetchImpl })).rejects.toThrow(/not US/);
      expect(calls).toEqual(["https://ipinfo.io/country"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("pages until a short page, writes every response with a receipt, and reads the cache back", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "travis-tnr-pages-"));
    try {
      const fetchImpl = async (url) => {
        if (url.startsWith("https://ipinfo.io/")) return new Response("US", { status: 200 });
        const offset = Number(new URL(url).searchParams.get("resultOffset"));
        const features = offset === 0
          ? [
              { id: 1, properties: { OBJECTID: 1, PROP_ID: "900001", geo_id: "0219080719" }, geometry: { type: "Polygon", coordinates: [SQUARE] } },
              { id: 2, properties: { OBJECTID: 2, PROP_ID: "900001", geo_id: "0219080719" }, geometry: { type: "Polygon", coordinates: [SQUARE] } },
            ]
          : [];
        return new Response(JSON.stringify({ type: "FeatureCollection", features }), { status: 200 });
      };
      const paged = await pageTnrLayer({ cacheDir: tempDir, pageSize: 2, fetchImpl, snapshotAt: "2026-10-20T00:00:00.000Z" });
      expect(paged).toEqual({ pages: 2, features: 2 });
      const receipt = JSON.parse(await readFile(path.join(tempDir, "page-00000.receipt.json"), "utf8"));
      expect(receipt.request.url).toContain("FeatureServer/0/query");
      expect(receipt.request.multiValueQueryString.resultOffset).toEqual(["0"]);
      const cache = await readTnrCache(tempDir);
      expect(cache.get("900001").geometries).toHaveLength(2);
      expect(cache.get("900001").objectIds).toEqual(["1", "2"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("buildTravisSeed (offline, synthetic export)", () => {
  it("joins the export, the improvement details and the TNR cache into a reconciled seed with a pilot", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "travis-build-seed-"));
    try {
      const exportDir = path.join(tempDir, "export");
      const cacheDir = path.join(tempDir, "tnr");
      await mkdir(exportDir, { recursive: true });
      await mkdir(cacheDir, { recursive: true });
      const header = "prop_id,geo_id,state_cd,py_owner_name,py_addr_line1,py_addr_city,py_addr_state,py_addr_zip,situs_num,situs_street,situs_street_sufix,situs_city,situs_zip,legal_desc,legal_acreage,land_hstd_val,imprv_hstd_val,market_value,assessed_val,appraised_val,deed_dt,tax_year";
      const rows = [
        "900001,0219080719,A1,DOE JOHN A,804 PARK BLVD,AUSTIN,TX,78751,804,PARK,BLVD,AUSTIN,78751,LOT 1,0.1722,250000,350000,600000,580000,600000,2015-06-15,2026",
        "900002,0403010404,F1,LINDELL HOLDINGS LLC,PO BOX 1,DENVER,CO,80201,2206,LINDELL,AVE,AUSTIN,78704,LOT 7,0.5,0,0,2100000,2100000,2100000,,2026",
        "bad-id,0000000000,C1,NOBODY,,,,,,,,,,,,,,,,,,2026",
        "900001,0219080719,A1,DOE JOHN A,804 PARK BLVD,AUSTIN,TX,78751,804,PARK,BLVD,AUSTIN,78751,LOT 1,0.1722,250000,350000,600000,580000,600000,2015-06-15,2026",
      ];
      await writeFile(path.join(exportDir, "PROP.TXT"), `${[header, ...rows].join("\n")}\n`, "utf8");
      await writeFile(path.join(exportDir, "IMP_DET.TXT"), "prop_id,geo_id,yr_built,living_area\n900001,0219080719,1998,1800\n900002,0403010404,1975,\n", "utf8");
      const archive = path.join(tempDir, "export.zip");
      await writeFile(archive, "not-a-real-zip-just-bytes", "utf8");
      await writeFile(
        path.join(cacheDir, "page-00000.json"),
        JSON.stringify({ type: "FeatureCollection", features: [{ id: 1, properties: { OBJECTID: 1, PROP_ID: "900001", geo_id: "0219080719" }, geometry: { type: "Polygon", coordinates: [SQUARE] } }, { id: 2, properties: { OBJECTID: 2, PROP_ID: "999999", geo_id: "0000000001" }, geometry: { type: "Polygon", coordinates: [SQUARE] } }] }),
        "utf8",
      );
      await writeFile(
        path.join(cacheDir, "page-00000.receipt.json"),
        JSON.stringify({ request: { method: "GET", url: "https://gis.traviscountytx.gov/server1/rest/services/Boundaries_and_Jurisdictions/TCAD_public/FeatureServer/0/query", multiValueQueryString: { where: ["1=1"], resultOffset: ["0"] } }, snapshotAt: "2026-10-20T00:00:00.000Z" }),
        "utf8",
      );
      const output = path.join(tempDir, "seeds", "travis.csv");
      const manifest = await buildTravisSeed({
        exportDir,
        exportUrl: "https://traviscad.org/wp-content/largefiles/2026-Certified-Appraisal-Export.zip",
        exportArchive: archive,
        tnrCache: cacheDir,
        output,
        pilotOutput: path.join(tempDir, "seeds", "travis-pilot.csv"),
        pilotSize: 1,
        snapshotAt: "2026-10-20T00:00:00.000Z",
      });
      expect(manifest.counts).toMatchObject({ rollRows: 3, rowsWritten: 2, invalidPropIds: 1, duplicatePropIdRows: 1, gisFeatures: 2, gisJoined: 1, gisUnjoined: 1, assessedParcelCount: 2, gisFeatureCount: 2, rowsWithGeometry: 1 });
      expect(manifest.columnMap.prop_id).toBe("prop_id");
      expect(manifest.tcadIdNormalizationProof.oneToOne).toBe(true);
      expect(manifest.pilot.size).toBe(1);
      const seed = parseCsvRecords(await readFile(output, "utf8"));
      expect(seed.map((row) => row.parcel_id)).toEqual(["900001", "900002"]);
      expect(seed[0].source_yr_built).toBe("1998");
      expect(seed[0].source_living_area_sqft).toBe("1800");
      expect(seed[0].latitude).not.toBe("");
      expect(seed[1].latitude).toBe("");
      expect(seed[0].url).toBe("https://traviscad.org/wp-content/largefiles/2026-Certified-Appraisal-Export.zip");
      expect(seed[0].source_revision).toMatch(/^[0-9a-f]{64}$/);
      const written = JSON.parse(await readFile(path.join(tempDir, "seeds", "travis-seed-manifest.json"), "utf8"));
      expect(written.counts).toEqual(manifest.counts);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
