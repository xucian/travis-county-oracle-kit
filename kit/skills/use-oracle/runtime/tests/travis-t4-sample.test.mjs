import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseCsvRecords } from "../src/core/csv.mjs";
import { drawSample, sampleKey } from "../src/counties/travis/t4-sample.mjs";

import { withOut } from "./travis-t4-socrata-mock.mjs";

describe("T4 feasibility sample", () => {
  it("draws the same uniform sample for the same seed and salt, values unchanged", async () => {
    await withOut(async (out) => {
      const seed = path.join(out, "seed.csv");
      const lines = ["parcel_id,geo_id,parcel_polygon"];
      for (let index = 1; index <= 50; index += 1) lines.push(`${100000 + index},${String(index).padStart(10, "0")},"{""type"":""Polygon"",""note"":""a, b""}"`);
      await writeFile(seed, `${lines.join("\n")}\n`);
      const first = await drawSample({ seedPath: seed, size: 5, salt: "s1", output: path.join(out, "a.csv") });
      const again = await drawSample({ seedPath: seed, size: 5, salt: "s1", output: path.join(out, "b.csv") });
      const other = await drawSample({ seedPath: seed, size: 5, salt: "s2", output: path.join(out, "c.csv") });
      expect(first.output.sha256).toBe(again.output.sha256);
      expect(first.prop_ids).toEqual(again.prop_ids);
      expect(other.prop_ids).not.toEqual(first.prop_ids);
      const expected = Array.from({ length: 50 }, (_, index) => String(100001 + index))
        .sort((left, right) => (sampleKey("s1", left) < sampleKey("s1", right) ? -1 : 1))
        .slice(0, 5)
        .sort();
      expect([...first.prop_ids].sort()).toEqual(expected);
      const rows = parseCsvRecords(await readFile(path.join(out, "a.csv"), "utf8"));
      expect(rows).toHaveLength(5);
      expect(rows[0].parcel_polygon).toBe('{"type":"Polygon","note":"a, b"}');
      expect(JSON.parse(await readFile(path.join(out, "a.csv.json"), "utf8"))).toMatchObject({ salt: "s1", size: 5, seed: { rows: 50 }, output: { rows: 5 } });
      await expect(drawSample({ seedPath: seed, size: 51, output: path.join(out, "d.csv") })).rejects.toThrow(/fewer than 51/);
    });
  });
});
