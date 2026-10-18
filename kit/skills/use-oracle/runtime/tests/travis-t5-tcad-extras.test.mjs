import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { IMP_ATR_FIELDS, IMP_INFO_FIELDS, LAND_DET_FIELDS, PROP_ENT_FIELDS, PROP_EXTRA_FIELDS, TCAD_EXTRAS_VERSION, buildTcadExtras, readTcadExtras } from "../src/counties/travis/t5-tcad-extras.mjs";

/** One fixed-width record of `length` characters with `values` at their layout positions. */
function record(length, fields, values) {
  const chars = Array(length).fill(" ");
  for (const [name, value] of Object.entries(values)) {
    const [start, end, kind] = fields[name];
    const width = end - start + 1;
    const text = kind === "int" ? String(value).padStart(width, "0") : String(value).padEnd(width, " ");
    for (let index = 0; index < width; index += 1) chars[start - 1 + index] = text[index];
  }
  return chars.join("");
}
const PROP_ID = [1, 12, "int"];

let dir;
let index;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "travis-extras-"));
  await writeFile(path.join(dir, "seed.csv"), "parcel_id,geo_id\n100,0100000001\n200,0200000002\n");
  const prop = (values) => record(9922, { prop_id: PROP_ID, ...PROP_EXTRA_FIELDS }, values);
  await writeFile(
    path.join(dir, "PROP.TXT"),
    [
      prop({ prop_id: 100, prop_type_cd: "R", sup_num: 0, py_owner_id: 11, ten_percent_cap: 2500 }),
      // A later owner record of the same account: never read (the seed builder's first-record rule).
      prop({ prop_id: 100, prop_type_cd: "R", sup_num: 0, py_owner_id: 12, ten_percent_cap: 9999 }),
      prop({ prop_id: 200, prop_type_cd: "R", sup_num: 0, py_owner_id: 21, ten_percent_cap: 0 }),
      prop({ prop_id: 300, prop_type_cd: "P", sup_num: 0, py_owner_id: 31, ten_percent_cap: 0 }),
    ].join("\n"),
  );
  const ent = (values) => record(953, PROP_ENT_FIELDS, values);
  await writeFile(
    path.join(dir, "PROP_ENT.TXT"),
    [
      ent({ prop_id: 100, sup_num: 0, owner_id: 11, entity_cd: "03", entity_name: "TRAVIS COUNTY", taxable_val: 400000, partial_entity: "F" }),
      ent({ prop_id: 100, sup_num: 0, owner_id: 11, entity_cd: "01", entity_name: "AUSTIN ISD", taxable_val: 380000, partial_entity: "T" }),
      ent({ prop_id: 100, sup_num: 0, owner_id: 11, entity_cd: "08", entity_name: "EANES ISD", taxable_val: 20000, partial_entity: "T" }),
      ent({ prop_id: 100, sup_num: 0, owner_id: 11, entity_cd: "9B", entity_name: "TRAVIS CO ESD NO 2", taxable_val: 400000, partial_entity: "F" }),
      ent({ prop_id: 100, sup_num: 0, owner_id: 12, entity_cd: "03", entity_name: "TRAVIS COUNTY", taxable_val: 1, partial_entity: "F" }),
      ent({ prop_id: 200, sup_num: 0, owner_id: 21, entity_cd: "02", entity_name: "CITY OF AUSTIN", taxable_val: 0, partial_entity: "F" }),
    ].join("\n"),
  );
  const atr = (values) => record(87, IMP_ATR_FIELDS, values);
  await writeFile(
    path.join(dir, "IMP_ATR.TXT"),
    [
      atr({ prop_id: 100, imprv_id: 1, imprv_det_id: 1, imprv_attr_desc: "Roof Covering", imprv_attr_cd: "COMPOSITIO" }),
      atr({ prop_id: 100, imprv_id: 2, imprv_det_id: 5, imprv_attr_desc: "Roof Covering", imprv_attr_cd: "COMPOSITIO" }),
      atr({ prop_id: 100, imprv_id: 1, imprv_det_id: 1, imprv_attr_desc: "Roof Style", imprv_attr_cd: "HIP" }),
      atr({ prop_id: 100, imprv_id: 2, imprv_det_id: 5, imprv_attr_desc: "Roof Style", imprv_attr_cd: "GABLE" }),
      atr({ prop_id: 100, imprv_id: 1, imprv_det_id: 1, imprv_attr_desc: "Grade Factor", imprv_attr_cd: "A" }),
      atr({ prop_id: 999, imprv_id: 1, imprv_det_id: 1, imprv_attr_desc: "Roof Covering", imprv_attr_cd: "METAL" }),
    ].join("\n"),
  );
  const land = (values) => record(199, LAND_DET_FIELDS, values);
  await writeFile(path.join(dir, "LAND_DET.TXT"), [land({ prop_id: 200, size_acres: 1000, size_square_feet: 4356 }), land({ prop_id: 200, size_acres: 377, size_square_feet: 1644 })].join("\n"));
  const info = (values) => record(114, IMP_INFO_FIELDS, values);
  await writeFile(path.join(dir, "IMP_INFO.TXT"), [info({ prop_id: 100, imprv_id: 1, imprv_type_cd: "01", imprv_type_desc: "1 FAM DWELLING" }), info({ prop_id: 100, imprv_id: 2, imprv_type_cd: "21", imprv_type_desc: "GARAGE APARTMENT" })].join("\n"));
  index = await buildTcadExtras({ seedPath: path.join(dir, "seed.csv"), exportDir: dir, archive: path.join(dir, "missing.zip"), outDir: path.join(dir, "out"), skipReceipt: true });
});

afterAll(() => {});

describe("t5-tcad-extras: the export fields T2 left unread", () => {
  it("keeps the seed's accounts in seed order, the first R record of each, and that owner's entity rows", async () => {
    expect(index.version).toBe(TCAD_EXTRAS_VERSION);
    expect(index.counts.prop).toMatchObject({ records: 4, real: 3, first_records: 2, later_owner_records: 1, ten_percent_cap_positive: 1 });
    expect(index.counts.prop_ent).toMatchObject({ records: 6, matched: 5, other_owner_or_supplement: 1 });
    const lines = (await readFile(path.join(dir, "out", "extras.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.prop_id)).toEqual(["100", "200"]);
    const [first, second] = lines;
    expect(first.prop).toEqual({ sup_num: "0", owner_id: "11", ten_percent_cap: "2500" });
    expect(first.entities.classes.county).toEqual([{ entity_cd: "03", entity_name: "TRAVIS COUNTY", taxable_val: "400000", partial_entity: false }]);
    expect(first.entities.classes.school.map((item) => item.entity_name)).toEqual(["AUSTIN ISD", "EANES ISD"]);
    expect(first.entities.other).toBe(1);
    expect(first.imp_atr).toEqual({ roof_covering: ["COMPOSITIO"], roof_style: ["GABLE", "HIP"], foundation: [], other_attributes: 1 });
    expect(first.imp_info).toEqual({ improvements: 2, types: ["01", "21"] });
    expect(second.entities.classes.city).toEqual([{ entity_cd: "02", entity_name: "CITY OF AUSTIN", taxable_val: "0", partial_entity: false }]);
    expect(second.land).toEqual({ segments: 2, size_acres_4dp: 1377, size_square_feet: 6000 });
    expect(index.presence.roof_style).toEqual({ one_code: 0, several_codes: 1, none: 1 });
    expect(index.presence.entity_class_on_account.school).toEqual({ none: 1, one: 0, several: 1 });
    expect(index.taxing_entities.find((item) => item.entity_cd === "9B")).toMatchObject({ class: "other", rows: 1 });
  });

  it("reads back only the accounts asked for and fails closed when the file no longer matches its index", async () => {
    const { byPropId } = await readTcadExtras({ dir: path.join(dir, "out"), propIds: new Set(["200"]) });
    expect([...byPropId.keys()]).toEqual(["200"]);
    const file = path.join(dir, "out", "extras.jsonl");
    await writeFile(file, `${(await readFile(file, "utf8")).replace('"2500"', '"2501"')}`);
    await expect(readTcadExtras({ dir: path.join(dir, "out") })).rejects.toThrow(/no longer matches its index/);
  });
});
