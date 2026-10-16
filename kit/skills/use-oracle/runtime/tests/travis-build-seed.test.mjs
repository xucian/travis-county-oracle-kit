import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { parseCsvRecords } from "../src/core/csv.mjs";
import {
  ABS_SUBD_FIELDS,
  IMP_DET_FIELDS,
  IMP_DET_RECORD_LENGTH,
  LIVING_AREA_DETAIL_TYPES,
  PROP_FIELDS,
  PROP_RECORD_LENGTH,
  buildTravisSeed,
  pageTnrLayer,
  readField,
  readRecord,
  readTnrCache,
  streamMemberLines,
  summarizeImprovementDetails,
} from "../src/counties/travis/build-seed.mjs";

const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip");
const SQUARE = [[-97.723, 30.3018], [-97.7218, 30.3018], [-97.7218, 30.3025], [-97.723, 30.3025], [-97.723, 30.3018]];
const LAYER_QUERY = "https://gis.traviscountytx.gov/server1/rest/services/Boundaries_and_Jurisdictions/TCAD_public/MapServer/0/query";
const EXPORT_URL = "https://traviscad.org/wp-content/largefiles/2026%20Certified%20Appraisal%20Export%20Supp%200_07182026.zip";

/**
 * Build one fixed-width record from field values, the way the Legacy 8.0.33
 * export prints them: integers zero-padded to the field width, text
 * left-aligned and space-padded, dec4 as an integer with four implied decimals.
 */
function fixedWidth(fields, values, length) {
  const chars = new Array(length).fill(" ");
  for (const [name, value] of Object.entries(values)) {
    const spec = fields[name];
    if (!spec) throw new Error(`unknown field ${name}`);
    const [start, end, kind] = spec;
    const width = end - start + 1;
    let text = String(value);
    if (kind === "int" || kind === "dec4") text = text.padStart(width, "0");
    else text = text.padEnd(width, " ");
    if (text.length > width) throw new Error(`${name} too wide`);
    for (let index = 0; index < width; index += 1) chars[start - 1 + index] = text[index];
  }
  return chars.join("");
}

function propLine(values) {
  return fixedWidth(PROP_FIELDS, { prop_val_yr: 2026, sup_num: 0, partial_owner: "F", py_confidential_flag: "F", py_address_suppress_flag: "F", ...values }, PROP_RECORD_LENGTH);
}

function impLine(values) {
  return fixedWidth(IMP_DET_FIELDS, { prop_val_yr: 2026, ...values }, IMP_DET_RECORD_LENGTH);
}

describe("fixed-width decoding (Legacy 8.0.33)", () => {
  it("decodes padded integers, implied decimals and text", () => {
    const line = propLine({ prop_id: 379828, prop_type_cd: "R", geo_id: "0282360106", legal_acreage: "1595", market_value: 329089, deed_dt: "04-29-2002", situs_street: "WHITEHALL" });
    expect(line).toHaveLength(PROP_RECORD_LENGTH);
    expect(line.slice(0, 12)).toBe("000000379828");
    expect(readField(line, PROP_FIELDS.prop_id)).toBe("379828");
    expect(readField(line, PROP_FIELDS.legal_acreage)).toBe("0.1595");
    expect(readField(line, PROP_FIELDS.market_value)).toBe("329089");
    expect(readRecord(line, PROP_FIELDS)).toMatchObject({ prop_type_cd: "R", geo_id: "0282360106", deed_dt: "04-29-2002", situs_street: "WHITEHALL", prop_val_yr: "2026" });
    expect(readField(propLine({ prop_id: 1, legal_acreage: "24188" }), PROP_FIELDS.legal_acreage)).toBe("2.4188");
    expect(readField(propLine({ prop_id: 1, legal_acreage: "50000" }), PROP_FIELDS.legal_acreage)).toBe("5");
    expect(readField(propLine({ prop_id: 1 }), PROP_FIELDS.legal_acreage)).toBe("");
  });

  it("summarizes year built and living area from the living-area detail types", async () => {
    async function* lines() {
      yield impLine({ prop_id: 1, imprv_id: 10, imprv_det_id: 1, imprv_det_type_cd: "011", yr_built: 1990, imprv_det_area: 200 });
      yield impLine({ prop_id: 1, imprv_id: 10, imprv_det_id: 2, imprv_det_type_cd: "1ST", yr_built: 1998, imprv_det_area: 1200 });
      yield impLine({ prop_id: 1, imprv_id: 10, imprv_det_id: 3, imprv_det_type_cd: "2ND", yr_built: 1998, imprv_det_area: 600 });
      yield impLine({ prop_id: 1, imprv_id: 11, imprv_det_id: 4, imprv_det_type_cd: "041", yr_built: 2005, imprv_det_area: 400 });
      yield impLine({ prop_id: 2, imprv_id: 20, imprv_det_id: 5, imprv_det_type_cd: "551", yr_built: 1984, imprv_det_area: 17100 });
      yield impLine({ prop_id: 3, imprv_id: 30, imprv_det_id: 6, imprv_det_type_cd: "1ST", yr_built: 0, imprv_det_area: 900 });
      yield "short line";
    }
    const summary = await summarizeImprovementDetails(lines());
    expect(LIVING_AREA_DETAIL_TYPES).toContain("1ST");
    expect(summary.records).toBe(7);
    expect(summary.badLength).toBe(1);
    expect(summary.byProp.get("1")).toEqual({ yr_built: "1998", living_area_sqft: "1800", imprv_count: "2" });
    expect(summary.byProp.get("2")).toEqual({ yr_built: "1984", living_area_sqft: "", imprv_count: "1" });
    expect(summary.byProp.get("3")).toEqual({ yr_built: "", living_area_sqft: "900", imprv_count: "1" });
  });
});

describe("TNR paging (MapServer layer 0)", () => {
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

  it("pages in OBJECTID order until a short page, writes every response with a receipt, and reads the cache back", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "travis-tnr-pages-"));
    try {
      const urls = [];
      const fetchImpl = async (url) => {
        if (url.startsWith("https://ipinfo.io/")) return new Response("US", { status: 200 });
        urls.push(url);
        const offset = Number(new URL(url).searchParams.get("resultOffset"));
        const features = offset === 0
          ? [
              { id: 1, properties: { OBJECTID: 1, PROP_ID: 900001, geo_id: "0219080719" }, geometry: { type: "Polygon", coordinates: [SQUARE] } },
              { id: 2, properties: { OBJECTID: 2, PROP_ID: null, geo_id: null }, geometry: { type: "Polygon", coordinates: [SQUARE] } },
            ]
          : [];
        return new Response(JSON.stringify({ type: "FeatureCollection", features }), { status: 200 });
      };
      const paged = await pageTnrLayer({ cacheDir: tempDir, pageSize: 2, fetchImpl, snapshotAt: "2026-10-20T00:00:00.000Z", delayMs: 0 });
      expect(paged).toEqual({ pages: 2, features: 2 });
      expect(urls[0].startsWith(`${LAYER_QUERY}?`)).toBe(true);
      expect(new URL(urls[0]).searchParams.get("orderByFields")).toBe("OBJECTID ASC");
      const receipt = JSON.parse(await readFile(path.join(tempDir, "page-00000.receipt.json"), "utf8"));
      expect(receipt.request.url).toBe(LAYER_QUERY);
      expect(receipt.request.multiValueQueryString.resultOffset).toEqual(["0"]);
      const cache = await readTnrCache(tempDir);
      expect(cache.features).toBe(2);
      expect(cache.featuresWithoutPropId).toBe(1);
      expect(cache.byProp.get("900001").geometries).toHaveLength(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("stops on a layer error body instead of caching it", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "travis-tnr-error-"));
    try {
      const fetchImpl = async (url) =>
        url.startsWith("https://ipinfo.io/")
          ? new Response("US", { status: 200 })
          : new Response(JSON.stringify({ error: { code: 500, message: "Server object extension 'featureserver' not found." } }), { status: 200 });
      await expect(pageTnrLayer({ cacheDir: tempDir, fetchImpl, delayMs: 0 })).rejects.toThrow(/TNR query error/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function writeSyntheticExport(dir) {
  const prop = [
    propLine({ prop_id: 900001, prop_type_cd: "R", geo_id: "0219080719", py_owner_name: "DOE JOHN A", py_addr_line1: "804 PARK BLVD", py_addr_city: "AUSTIN", py_addr_state: "TX", py_addr_zip: "78751", situs_num: "804", situs_street: "PARK", situs_street_suffix: "BLVD", situs_city: "AUSTIN", situs_zip: "78751", legal_desc: "LOT 1 BLK A", legal_acreage: "1722", abs_subdv_cd: "S1234", land_hstd_val: 250000, imprv_hstd_val: 350000, market_value: 600000, assessed_val: 580000, appraised_val: 600000, deed_dt: "06-15-2015", imprv_state_cd: "A1", land_state_cd: "A1" }),
    propLine({ prop_id: 900002, prop_type_cd: "R", geo_id: "0403010404", py_owner_name: "LINDELL HOLDINGS LLC", py_addr_city: "DENVER", py_addr_state: "CO", py_addr_zip: "80201", situs_num: "2206", situs_street: "LINDELL", situs_street_suffix: "AVE", situs_zip: "78704", market_value: 2100000, imprv_state_cd: "F1", land_state_cd: "F1" }),
    propLine({ prop_id: 900003, prop_type_cd: "R", geo_id: "0137681242", py_owner_name: "CONFIDENTIAL OWNER", py_addr_line1: "1 SECRET WAY", py_confidential_flag: "T", situs_num: "64", situs_street: "WHITE MAGNOLIA CIR", situs_city: "AUSTIN", situs_zip: "78734", imprv_state_cd: "A4" }),
    propLine({ prop_id: 900003, prop_type_cd: "R", geo_id: "0137681242", py_owner_name: "SECOND OWNER", partial_owner: "T", imprv_state_cd: "A4" }),
    propLine({ prop_id: 900004, prop_type_cd: "MH", geo_id: "0219080719" }),
    propLine({ prop_id: 900005, prop_type_cd: "P", geo_id: "" }),
  ];
  await writeFile(path.join(dir, "PROP.TXT"), `${prop.join("\r\n")}\r\n`, "latin1");
  const imp = [
    impLine({ prop_id: 900001, imprv_id: 1, imprv_det_id: 1, imprv_det_type_cd: "1ST", yr_built: 1998, imprv_det_area: 1800 }),
    impLine({ prop_id: 900002, imprv_id: 2, imprv_det_id: 2, imprv_det_type_cd: "1ST", yr_built: 1975, imprv_det_area: 5000 }),
  ];
  await writeFile(path.join(dir, "IMP_DET.TXT"), `${imp.join("\r\n")}\r\n`, "latin1");
  await writeFile(path.join(dir, "ABS_SUBD.TXT"), `${fixedWidth(ABS_SUBD_FIELDS, { abs_subdv_cd: "S1234", abs_subdv_desc: "FIXTURE ADDN" }, 50)}\r\n`, "latin1");
}

async function writeTnrCacheFixture(dir) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "page-00000.json"),
    JSON.stringify({
      type: "FeatureCollection",
      features: [
        { id: 1, properties: { OBJECTID: 1, PROP_ID: 900001, geo_id: "0219080719" }, geometry: { type: "Polygon", coordinates: [SQUARE] } },
        { id: 2, properties: { OBJECTID: 2, PROP_ID: 999999, geo_id: "0000000001" }, geometry: { type: "Polygon", coordinates: [SQUARE] } },
        { id: 3, properties: { OBJECTID: 3, PROP_ID: null, geo_id: null }, geometry: { type: "Polygon", coordinates: [SQUARE] } },
      ],
    }),
    "utf8",
  );
  await writeFile(
    path.join(dir, "page-00000.receipt.json"),
    JSON.stringify({ request: { method: "GET", url: LAYER_QUERY, multiValueQueryString: { where: ["1=1"], resultOffset: ["0"] } }, snapshotAt: "2026-10-20T00:00:00.000Z" }),
    "utf8",
  );
}

async function checkSeed(tempDir, manifest) {
  expect(manifest.counts).toMatchObject({
    propRecords: 6,
    propRecordsByType: { R: 4, MH: 1, P: 1 },
    rollRows: 4,
    rowsWritten: 3,
    uniquePropIds: 3,
    invalidPropIds: 0,
    foldedOwnerRecords: 1,
    foldedOwnerPropIds: 1,
    confidentialOwners: 1,
    assessedParcelCount: 3,
    gisFeatureCount: 3,
    gisFeaturesWithoutPropId: 1,
    gisFeatures: 2,
    gisJoined: 1,
    gisUnjoined: 1,
    rowsWithGeometry: 1,
    rowsWithoutGeometry: 2,
    improvementDetailRecords: 2,
    subdivisionCodes: 1,
  });
  expect(manifest.layoutVersion).toBe("Legacy8.0.33");
  expect(manifest.tcadIdNormalizationProof.oneToOne).toBe(true);
  expect(manifest.pilot.size).toBe(2);
  const seed = parseCsvRecords(await readFile(path.join(tempDir, "seeds", "travis.csv"), "utf8"));
  expect(seed.map((row) => row.parcel_id)).toEqual(["900001", "900002", "900003"]);
  const [first, second, condo] = seed;
  expect(first).toMatchObject({
    source_identifier: "900001",
    geo_id: "0219080719",
    address: "804 PARK BLVD, AUSTIN TX 78751",
    source_state_cd: "A1",
    source_yr_built: "1998",
    source_living_area_sqft: "1800",
    source_legal_acreage: "0.1722",
    source_abs_subdv_desc: "FIXTURE ADDN",
    source_deed_dt: "06-15-2015",
    source_owner_confidential: "F",
    tnr_url: LAYER_QUERY,
    url: EXPORT_URL,
  });
  expect(first.latitude).not.toBe("");
  expect(second.latitude).toBe("");
  expect(second.address).toBe("2206 LINDELL AVE, TX 78704");
  expect(condo).toMatchObject({ source_owner_confidential: "T", source_py_owner_name: "", source_py_addr_line1: "", latitude: "" });
  const written = JSON.parse(await readFile(path.join(tempDir, "seeds", "travis-seed-manifest.json"), "utf8"));
  expect(written.counts).toEqual(manifest.counts);
  const pilot = parseCsvRecords(await readFile(path.join(tempDir, "seeds", "travis-pilot.csv"), "utf8"));
  expect(pilot).toHaveLength(2);
  expect(pilot.map((row) => row.parcel_id).sort()).toEqual([...manifest.pilot.propIds].sort());
}

describe("buildTravisSeed (offline, synthetic fixed-width export)", () => {
  it("builds from an extracted export directory", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "travis-build-seed-dir-"));
    try {
      const exportDir = path.join(tempDir, "export");
      await mkdir(exportDir, { recursive: true });
      await writeSyntheticExport(exportDir);
      await writeTnrCacheFixture(path.join(tempDir, "tnr"));
      const manifest = await buildTravisSeed({
        exportDir,
        exportUrl: EXPORT_URL,
        tnrCache: path.join(tempDir, "tnr"),
        output: path.join(tempDir, "seeds", "travis.csv"),
        pilotOutput: path.join(tempDir, "seeds", "travis-pilot.csv"),
        pilotSize: 2,
        snapshotAt: "2026-10-20T00:00:00.000Z",
      });
      await checkSeed(tempDir, manifest);
      expect(manifest.exportArchiveSha256).toBeNull();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("streams the members straight from the downloaded archive and digests it", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "travis-build-seed-zip-"));
    try {
      const staging = path.join(tempDir, "staging");
      await mkdir(staging, { recursive: true });
      await writeSyntheticExport(staging);
      const zip = new AdmZip();
      for (const name of ["PROP.TXT", "IMP_DET.TXT", "ABS_SUBD.TXT"]) zip.addLocalFile(path.join(staging, name));
      const archive = path.join(tempDir, "2026 Certified Appraisal Export Supp 0_07182026.zip");
      zip.writeZip(archive);
      await writeTnrCacheFixture(path.join(tempDir, "tnr"));
      const lines = [];
      for await (const line of streamMemberLines({ exportArchive: archive, member: "ABS_SUBD.TXT" })) lines.push(line);
      expect(lines).toHaveLength(1);
      const manifest = await buildTravisSeed({
        exportArchive: archive,
        exportUrl: EXPORT_URL,
        tnrCache: path.join(tempDir, "tnr"),
        output: path.join(tempDir, "seeds", "travis.csv"),
        pilotOutput: path.join(tempDir, "seeds", "travis-pilot.csv"),
        pilotSize: 2,
        snapshotAt: "2026-10-20T00:00:00.000Z",
      });
      await checkSeed(tempDir, manifest);
      expect(manifest.exportArchiveSha256).toMatch(/^[0-9a-f]{64}$/);
      const seed = parseCsvRecords(await readFile(path.join(tempDir, "seeds", "travis.csv"), "utf8"));
      expect(seed[0].source_revision).toBe(manifest.exportArchiveSha256);
      await expect(async () => {
        for await (const line of streamMemberLines({ exportArchive: archive, member: "MISSING.TXT" })) void line;
      }).rejects.toThrow(/unzip -p MISSING.TXT exited/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed on a record that does not have the layout's length", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "travis-build-seed-bad-"));
    try {
      const exportDir = path.join(tempDir, "export");
      await mkdir(exportDir, { recursive: true });
      await writeSyntheticExport(exportDir);
      await writeFile(path.join(exportDir, "PROP.TXT"), "000000900001R    too short\r\n", "latin1");
      await writeTnrCacheFixture(path.join(tempDir, "tnr"));
      await expect(
        buildTravisSeed({ exportDir, exportUrl: EXPORT_URL, tnrCache: path.join(tempDir, "tnr"), output: path.join(tempDir, "seeds", "travis.csv") }),
      ).rejects.toThrow(/expected 9922/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
