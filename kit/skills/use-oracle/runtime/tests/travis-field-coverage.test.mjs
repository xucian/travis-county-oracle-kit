import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseCsvRecords } from "../src/core/csv.mjs";
import { materializeParcelInput } from "../src/counties/travis/adapter.mjs";
import { ABS_SUBD_FIELDS, IMP_DET_FIELDS, PROP_FIELDS } from "../src/counties/travis/build-seed.mjs";
import { TRAVIS_EXPORT_FIELDS_NOT_READ, TRAVIS_EXTRAS_FIELD_COVERAGE, TRAVIS_FIELD_COVERAGE, TRAVIS_FIELD_COVERAGE_VERSION, TRAVIS_TNR_FEATURE_COVERAGE } from "../src/counties/travis/field-coverage.mjs";
import { IMP_ATR_FIELDS, IMP_INFO_FIELDS, LAND_DET_FIELDS, PROP_ENT_FIELDS, PROP_EXTRA_FIELDS } from "../src/counties/travis/t5-tcad-extras.mjs";
import { buildTravisOutput } from "../counties/travis/transforms/transform.mjs";

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "travis-replay");

const CLASS_FILES = {
  property: (name) => name === "property.json",
  parcel: (name) => name === "parcel.json",
  address: (name) => name === "address.json",
  mailing_address: (name) => name === "mailing_address.json",
  person: (name) => /^person_\d+\.json$/.test(name),
  company: (name) => /^company_\d+\.json$/.test(name),
  lot: (name) => name === "lot.json",
  tax: (name) => /^tax_\d{4}\.json$/.test(name),
  sales_history: (name) => /^sales_history_\d+\.json$/.test(name),
};

async function outputs() {
  const rows = parseCsvRecords(await readFile(path.join(FIXTURE_DIR, "seed.csv"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(FIXTURE_DIR, "lexicon-manifest.json"), "utf8"));
  // The person parcel with an agricultural value, and the company parcel: together they exercise every mapped target.
  return [materializeParcelInput({ ...rows[0], source_ag_use_val: "1200" }), materializeParcelInput(rows[1])].map((input) => buildTravisOutput(input, { manifest }));
}

describe("Travis field coverage (T2 proof)", () => {
  it("has an entry for every export field the seed builder reads, and each lands somewhere", () => {
    expect(Object.keys(TRAVIS_FIELD_COVERAGE.PROP).sort()).toEqual(Object.keys(PROP_FIELDS).sort());
    expect(Object.keys(TRAVIS_FIELD_COVERAGE.IMP_DET).sort()).toEqual(Object.keys(IMP_DET_FIELDS).sort());
    expect(Object.keys(TRAVIS_FIELD_COVERAGE.ABS_SUBD).sort()).toEqual(Object.keys(ABS_SUBD_FIELDS).sort());
    for (const [file, fields] of Object.entries(TRAVIS_FIELD_COVERAGE)) {
      for (const [field, target] of Object.entries(fields)) {
        expect(target.lexicon.length + target.sidecar.length + (target.seed ? 1 : 0), `${file}.${field}`).toBeGreaterThan(0);
      }
    }
  });

  it("names only lexicon targets and sidecar keys the transform actually writes", async () => {
    const built = await outputs();
    for (const fields of Object.values(TRAVIS_FIELD_COVERAGE)) {
      for (const [field, target] of Object.entries(fields)) {
        for (const lexiconTarget of target.lexicon) {
          const [className, property] = lexiconTarget.split(".");
          const match = CLASS_FILES[className];
          expect(match, `${field}: unknown class ${className}`).toBeTypeOf("function");
          const written = built.some(({ files }) => Object.entries(files).some(([name, body]) => match(name) && Object.hasOwn(body, property)));
          expect(written, `${field} -> ${lexiconTarget}`).toBe(true);
        }
        for (const key of target.sidecar) {
          const present = built.some(({ sourcePayload }) => key.split(".").reduce((value, part) => (value && Object.hasOwn(value, part) ? value[part] : undefined), sourcePayload) !== undefined);
          expect(present, `${field} -> sidecar ${key}`).toBe(true);
        }
      }
    }
  });
});

describe("Travis field coverage v3 (T5 pre-run fixes: the extras and the TNR feature)", () => {
  const extrasLine = (overrides = {}) => ({
    prop_id: "900001",
    prop: { sup_num: "0", owner_id: "77", ten_percent_cap: "20000" },
    entities: {
      classes: Object.fromEntries(
        [
          ["county", "TRAVIS COUNTY"],
          ["hospital", "TRAVIS COUNTY HEALTHCARE DISTRICT"],
          ["college", "AUSTIN COMM COLL DIST"],
          ["school", "AUSTIN ISD"],
          ["city", "CITY OF AUSTIN"],
        ].map(([name, entity]) => [name, [{ entity_cd: "00", entity_name: entity, taxable_val: "500000", partial_entity: false }]]),
      ),
      other: 1,
      conflicting: [],
    },
    imp_atr: { roof_covering: ["WOOD SHING"], roof_style: ["HIP"], foundation: ["SLAB"], other_attributes: 0 },
    land: { segments: 1, size_acres_4dp: 1377, size_square_feet: 6000 },
    imp_info: { improvements: 1, types: ["01"] },
    ...overrides,
  });

  async function extrasOutputs() {
    const rows = parseCsvRecords(await readFile(path.join(FIXTURE_DIR, "seed.csv"), "utf8"));
    const manifest = JSON.parse(await readFile(path.join(FIXTURE_DIR, "lexicon-manifest.json"), "utf8"));
    // One account with a printed legal acreage, one sized by its land segments: together every extras target.
    return [materializeParcelInput(rows[0], extrasLine()), materializeParcelInput({ ...rows[0], source_legal_acreage: "0" }, extrasLine())].map((input) => buildTravisOutput(input, { manifest }));
  }

  const EXTRA_CLASS_FILES = { ...CLASS_FILES, structure: (name) => name === "structure.json", geometry: (name) => /^geometry(_part_\d+)?\.json$/.test(name) };

  it("has an entry for every field the extras builder reads", () => {
    expect(TRAVIS_FIELD_COVERAGE_VERSION).toBe("travis-field-coverage-v3");
    expect(Object.keys(TRAVIS_EXTRAS_FIELD_COVERAGE.PROP).sort()).toEqual(Object.keys(PROP_EXTRA_FIELDS).sort());
    expect(Object.keys(TRAVIS_EXTRAS_FIELD_COVERAGE.PROP_ENT).sort()).toEqual(Object.keys(PROP_ENT_FIELDS).sort());
    expect(Object.keys(TRAVIS_EXTRAS_FIELD_COVERAGE.IMP_ATR).sort()).toEqual(Object.keys(IMP_ATR_FIELDS).sort());
    expect(Object.keys(TRAVIS_EXTRAS_FIELD_COVERAGE.LAND_DET).sort()).toEqual(Object.keys(LAND_DET_FIELDS).sort());
    expect(Object.keys(TRAVIS_EXTRAS_FIELD_COVERAGE.IMP_INFO).sort()).toEqual(Object.keys(IMP_INFO_FIELDS).sort());
  });

  it("names only lexicon targets and sidecar keys the v4 transform writes", async () => {
    const built = await extrasOutputs();
    for (const fields of [...Object.values(TRAVIS_EXTRAS_FIELD_COVERAGE), TRAVIS_TNR_FEATURE_COVERAGE]) {
      for (const [field, target] of Object.entries(fields)) {
        expect(target.lexicon.length + target.sidecar.length + (target.seed ? 1 : 0), field).toBeGreaterThan(0);
        for (const lexiconTarget of target.lexicon) {
          const [className, property] = lexiconTarget.split(".");
          const match = EXTRA_CLASS_FILES[className];
          expect(match, `${field}: unknown class ${className}`).toBeTypeOf("function");
          const written = built.some(({ files }) => Object.entries(files).some(([name, body]) => match(name) && Object.hasOwn(body, property) && body[property] !== null));
          expect(written, `${field} -> ${lexiconTarget}`).toBe(true);
        }
        for (const key of target.sidecar) {
          const present = built.some(({ sourcePayload }) => key.split(".").reduce((value, part) => (value && Object.hasOwn(value, part) ? value[part] : undefined), sourcePayload) !== undefined);
          expect(present, `${field} -> sidecar ${key}`).toBe(true);
        }
      }
    }
  });

  it("lists what still has no faithful member, with a reason, and no longer lists what v4 writes", () => {
    const files = TRAVIS_EXPORT_FIELDS_NOT_READ.map((item) => `${item.file}:${item.lexicon}`);
    expect(files.some((item) => item.includes("homestead_cap_loss_amount"))).toBe(false);
    expect(files.some((item) => item.startsWith("LAND_DET.TXT"))).toBe(false);
    expect(files.some((item) => item.includes("roof_covering_material"))).toBe(false);
    for (const item of TRAVIS_EXPORT_FIELDS_NOT_READ) expect(item.reason.length).toBeGreaterThan(20);
  });
});
