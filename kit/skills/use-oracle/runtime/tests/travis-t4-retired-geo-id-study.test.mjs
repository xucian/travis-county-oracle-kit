import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { forEachArrayElement, readSeedPolygons } from "../src/counties/travis/t4-retired-geo-id-study.mjs";

import { withOut } from "./travis-t4-socrata-mock.mjs";

describe("T4 retired geo_id study helpers", () => {
  it("splits a top-level JSON array into its objects, braces inside strings included", async () => {
    const text = '[\n {"pID": 1, "notes": [{"content": "a } { \\" b"}]},\n {"pID": 2, "links": []}\n]\n';
    const seen = [];
    const stream = Readable.from([text.slice(0, 17), text.slice(17)]);
    expect(await forEachArrayElement(stream, (item) => seen.push(JSON.parse(item).pID))).toBe(2);
    expect(seen).toEqual([1, 2]);
  });

  it("finds the polygons that contain a point, holes excluded", async () => {
    await withOut(async (out) => {
      const square = (x, y, size) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
      const polygon = (rings) => JSON.stringify({ type: "Polygon", coordinates: rings }).replaceAll('"', '""');
      const seed = path.join(out, "seed.csv");
      await writeFile(seed, ["parcel_id,parcel_polygon", `1,"${polygon([square(-97.75, 30.25, 0.01), square(-97.746, 30.254, 0.002)])}"`, `2,"${polygon([square(-97.745, 30.255, 0.001)])}"`, "3,"].join("\n") + "\n");
      const index = await readSeedPolygons(seed);
      expect(index.polygons).toBe(2);
      expect(index.lookup(30.251, -97.749)).toEqual(["1"]);
      expect(index.lookup(30.2555, -97.7445)).toEqual(["2"]);
      expect(index.lookup(30.3, -97.7)).toEqual([]);
    });
  });
});
