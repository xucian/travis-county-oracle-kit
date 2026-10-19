import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { cidLength, classifyNoSitus, metresOutside, polygonVertices, readVarint, walkCar } from "../src/counties/travis/t5-reconcile.mjs";
import { TRAVIS_VALIDATION_BBOX } from "../src/counties/travis/validate.mjs";

/** Unsigned varint bytes. */
const varint = (value) => {
  const out = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    out.push(byte);
  } while (value > 0);
  return out;
};

/** A CIDv1 (dag-json, sha2-256) with a fixed digest byte. */
const cid = (fill) => Buffer.from([0x01, ...varint(0x0129), 0x12, 0x20, ...Array(32).fill(fill)]);

describe("T5 reconciliation helpers", () => {
  it("reads varints and the CID length at the start of a CAR section", () => {
    expect(readVarint(Uint8Array.from([0x05]), 0)).toEqual([5, 1]);
    expect(readVarint(Uint8Array.from([0xa9, 0x02]), 0)).toEqual([0x129, 2]);
    expect(() => readVarint(Uint8Array.from([0x80]), 0)).toThrow(/truncated/);
    expect(cidLength(Buffer.concat([cid(7), Buffer.from("data")]))).toBe(37);
  });

  it("walks a CARv1 block by block: block count, data bytes, framing, and a key per block", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "t5-reconcile-"));
    try {
      const header = Buffer.from("header-bytes");
      const blocks = [
        [cid(1), Buffer.from('{"a":1}')],
        [cid(2), Buffer.from('{"bb":22}')],
        [cid(1), Buffer.from('{"a":1}')],
      ];
      const sections = blocks.map(([id, data]) => Buffer.concat([Buffer.from(varint(id.length + data.length)), id, data]));
      const file = path.join(dir, "test.car");
      await writeFile(file, Buffer.concat([Buffer.from(varint(header.length)), header, ...sections]));
      const keys = [];
      const walked = await walkCar(file, (key, bytes) => keys.push([key, bytes]));
      expect(walked).toMatchObject({ blocks: 3, data_bytes: 7 + 9 + 7 });
      expect(walked.framing_bytes).toBe(walked.size - walked.data_bytes);
      expect(keys[0][0]).toBe(keys[2][0]);
      expect(keys[0][0]).not.toBe(keys[1][0]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("classes a blank situs street: nothing printed, a house number only, or the street printed one column to the right", () => {
    const row = (parts) => Object.fromEntries(["num", "street_prefx", "street", "street_suffix", "unit"].map((name) => [`source_situs_${name}`, parts[name] ?? ""]));
    expect(classifyNoSitus(row({}))).toBe("nothing_printed");
    expect(classifyNoSitus(row({ num: "18829" }))).toBe("number_only");
    expect(classifyNoSitus(row({ street_prefx: "E", street_suffix: "PARMER", unit: "LN" }))).toBe("columns_shifted");
    expect(classifyNoSitus(row({ street_suffix: "PINNACLE", unit: "CV" }))).toBe("columns_shifted");
    expect(classifyNoSitus(row({ street_suffix: "PINNACLE", unit: "1" }))).toBe("other_parts");
    expect(classifyNoSitus(row({ street: "MAIN" }))).toBe("other_parts");
  });

  it("measures how far a point sits outside the validation box, and reads polygon vertices", () => {
    const { minLat, maxLng } = TRAVIS_VALIDATION_BBOX;
    expect(metresOutside(30.3, -97.7)).toBe(0);
    expect(metresOutside(minLat - 0.001, -97.7)).toBe(111);
    expect(metresOutside(30.3, maxLng + 0.01)).toBeGreaterThan(950);
    expect(polygonVertices({ type: "MultiPolygon", coordinates: [[[[-97.7, 30.3], [-97.6, 30.3]]], [[[-97.5, 30.2]]]] })).toEqual([[-97.7, 30.3], [-97.6, 30.3], [-97.5, 30.2]]);
    expect(polygonVertices([[[-97.7, 30.3]]])).toEqual([[-97.7, 30.3]]);
    expect(polygonVertices(null)).toEqual([]);
  });
});
