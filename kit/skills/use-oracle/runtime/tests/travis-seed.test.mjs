import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseCsvRecords } from "../src/core/csv.mjs";
import {
  SEED_COLUMNS,
  TCAD_SOURCE_FIELDS,
  TRAVIS_SEED_BBOX,
  assertSafeSourceFields,
  assertSeedReconciliation,
  buildSeed,
  buildSitusAddress,
  classifyStateCodeBand,
  hasInRangeGeometry,
  isValidGeoId,
  isValidPropId,
  mergeGeometries,
  polygonCentroid,
  selectPilotRows,
  toSeedRow,
} from "../src/counties/travis/seed.mjs";

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "travis-replay");

const SQUARE = {
  type: "Polygon",
  coordinates: [
    [
      [-97.723, 30.3018],
      [-97.7218, 30.3018],
      [-97.7218, 30.3025],
      [-97.723, 30.3025],
      [-97.723, 30.3018],
    ],
  ],
};

function record(overrides = {}) {
  return {
    tcad: {
      prop_id: "900001",
      geo_id: "0219080719",
      state_cd: "A1",
      py_owner_name: "DOE JOHN A",
      situs_num: "804",
      situs_street: "PARK",
      situs_street_sufix: "BLVD",
      situs_city: "Austin",
      situs_zip: "78751-1234",
      legal_acreage: "0.1722",
      tax_year: "2026",
      ...overrides,
    },
    request: { method: "GET", url: "https://traviscad.org/wp-content/largefiles/2026-Certified-Appraisal-Export.zip", multiValueQueryString: {} },
    snapshot: { sourceItemId: "2026-Certified-Appraisal-Export.zip", sourceRevision: "abc", snapshotAt: "2026-10-16T00:00:00.000Z" },
    tnr: {
      geometry: SQUARE,
      objectId: "101",
      request: { method: "GET", url: "https://gis.traviscountytx.gov/server1/rest/services/Boundaries_and_Jurisdictions/TCAD_public/FeatureServer/0/query", multiValueQueryString: { where: ["1=1"] } },
      snapshotAt: "2026-10-16T00:00:00.000Z",
    },
  };
}

describe("Travis identifiers", () => {
  it("keeps PROP_ID and geo_id as printed text", () => {
    expect(isValidPropId("900001")).toBe(true);
    expect(isValidPropId("0123")).toBe(true);
    expect(isValidPropId("")).toBe(false);
    expect(isValidPropId("12-34")).toBe(false);
    expect(isValidGeoId("0219080719")).toBe(true);
    expect(isValidGeoId("219080719")).toBe(false);
  });

  it("refuses contact fields in the retained source columns", () => {
    expect(() => assertSafeSourceFields(TCAD_SOURCE_FIELDS)).not.toThrow();
    expect(() => assertSafeSourceFields(["prop_id", "owner_phone"])).toThrow(/prohibited/);
    expect(() => assertSafeSourceFields(["prop_id", "PROP_ID"])).toThrow(/Duplicate/);
  });
});

describe("Travis situs address and geometry helpers", () => {
  it("builds the situs line the roll prints", () => {
    expect(buildSitusAddress(record().tcad)).toEqual({
      street: "804 PARK BLVD",
      city: "AUSTIN",
      zip: "78751",
      full: "804 PARK BLVD, AUSTIN TX 78751",
    });
  });

  it("computes an area-weighted centroid inside the polygon and merges multi-feature parcels", () => {
    const centroid = polygonCentroid(SQUARE);
    expect(centroid.latitude).toBeCloseTo(30.30215, 4);
    expect(centroid.longitude).toBeCloseTo(-97.7224, 4);
    expect(polygonCentroid(null)).toBeNull();
    expect(mergeGeometries([SQUARE, SQUARE]).type).toBe("MultiPolygon");
    expect(mergeGeometries([SQUARE]).type).toBe("Polygon");
    expect(mergeGeometries([])).toBeNull();
    expect(polygonCentroid(mergeGeometries([SQUARE, SQUARE])).latitude).toBeCloseTo(30.30215, 4);
  });

  it("classifies state-code bands for stratification", () => {
    expect(classifyStateCodeBand("A1")).toBe("single_family");
    expect(classifyStateCodeBand("B2")).toBe("multi_family");
    expect(classifyStateCodeBand("C1")).toBe("vacant");
    expect(classifyStateCodeBand("F1")).toBe("commercial");
    expect(classifyStateCodeBand("F2")).toBe("industrial");
    expect(classifyStateCodeBand("")).toBe("unknown");
    expect(classifyStateCodeBand("Z9")).toBe("other");
  });
});

describe("toSeedRow", () => {
  it("builds a row that matches the committed fixture seed", async () => {
    const row = toSeedRow(record({ situs_zip: "78751" }));
    expect(row.parcel_id).toBe("900001");
    expect(row.source_identifier).toBe("900001");
    expect(row.geo_id).toBe("0219080719");
    expect(row.url).not.toContain("?");
    expect(JSON.parse(row.multiValueQueryString)).toEqual({});
    expect(row.address).toBe("804 PARK BLVD, AUSTIN TX 78751");
    expect(row.county).toBe("Travis");
    expect(row.county_fips).toBe("48453");
    expect(Number(row.latitude)).toBeCloseTo(30.30215, 4);
    expect(JSON.parse(row.parcel_polygon)).toEqual(SQUARE);
    expect(row.tnr_url).toContain("FeatureServer/0/query");
    expect(row.source_state_cd).toBe("A1");
    expect(Object.keys(row)).toEqual([...SEED_COLUMNS]);

    const fixtureRows = parseCsvRecords(await readFile(path.join(FIXTURE_DIR, "seed.csv"), "utf8"));
    expect(fixtureRows).toHaveLength(2);
    expect(Object.keys(fixtureRows[0])).toEqual([...SEED_COLUMNS]);
    expect(fixtureRows.map((item) => item.parcel_id)).toEqual(["900001", "900002"]);
    expect(fixtureRows[1].latitude).toBe("");
    expect(fixtureRows[1].tnr_url).toBe("");
  });

  it("fails loud on a PROP_ID that is not printed digits", () => {
    expect(() => toSeedRow(record({ prop_id: "R-1" }))).toThrow(/printed TCAD PROP_ID/);
  });
});

describe("pilot selection and reconciliation", () => {
  it("selects a deterministic, stratified pilot", () => {
    const rows = [];
    for (let index = 0; index < 60; index += 1) {
      const band = index % 3 === 0 ? "A1" : index % 3 === 1 ? "F1" : "C1";
      rows.push(
        toSeedRow(
          record({
            prop_id: String(100000 + index),
            geo_id: String(1000000000 + index),
            state_cd: band,
            ...(index % 2 === 0 ? {} : {}),
          }),
        ),
      );
      if (index % 2 === 1) {
        rows[rows.length - 1] = { ...rows[rows.length - 1], latitude: "", longitude: "", parcel_polygon: "" };
      }
    }
    const first = selectPilotRows(rows, { size: 12, permitGeoIds: new Set(["1000000003"]) });
    const second = selectPilotRows([...rows].reverse(), { size: 12, permitGeoIds: new Set(["1000000003"]) });
    expect(first.map((row) => row.parcel_id)).toEqual(second.map((row) => row.parcel_id));
    expect(first).toHaveLength(12);
    const bands = new Set(first.map((row) => classifyStateCodeBand(row.source_state_cd)));
    expect(bands).toEqual(new Set(["single_family", "commercial", "vacant"]));
    expect(first.some((row) => row.latitude === "")).toBe(true);
    expect(first.some((row) => row.latitude !== "")).toBe(true);
    expect(first.some((row) => row.geo_id === "1000000003")).toBe(true);
    expect(hasInRangeGeometry(first.find((row) => row.latitude !== ""))).toBe(true);
    expect(hasInRangeGeometry({ latitude: String(TRAVIS_SEED_BBOX.maxLat + 1), longitude: "-97.7" })).toBe(false);
  });

  it("reconciles roll rows, written rows and GIS features", () => {
    const good = { rowsWritten: 2, uniquePropIds: 2, rollRows: 3, invalidPropIds: 1, gisFeatures: 3, gisJoined: 2, gisUnjoined: 1 };
    expect(() => assertSeedReconciliation(good)).not.toThrow();
    expect(() => assertSeedReconciliation({ ...good, uniquePropIds: 1 })).toThrow(/uniquePropIds/);
    expect(() => assertSeedReconciliation({ ...good, rollRows: 4 })).toThrow(/rollRows/);
    expect(() => assertSeedReconciliation({ ...good, gisUnjoined: 0 })).toThrow(/gisFeatures/);
  });

  it("buildSeed never touches the network and rejects duplicate PROP_IDs", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("buildSeed must never call fetch()");
    };
    try {
      const { rows, csv } = await buildSeed({ records: [record()] });
      expect(rows).toHaveLength(1);
      expect(parseCsvRecords(csv)[0].parcel_id).toBe("900001");
      await expect(buildSeed({ records: [record(), record()] })).rejects.toThrow(/duplicate PROP_ID/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
