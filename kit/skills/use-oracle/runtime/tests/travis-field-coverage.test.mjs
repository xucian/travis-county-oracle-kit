import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseCsvRecords } from "../src/core/csv.mjs";
import { materializeParcelInput } from "../src/counties/travis/adapter.mjs";
import { ABS_SUBD_FIELDS, IMP_DET_FIELDS, PROP_FIELDS } from "../src/counties/travis/build-seed.mjs";
import { TRAVIS_FIELD_COVERAGE } from "../src/counties/travis/field-coverage.mjs";
import { buildTravisOutput } from "../counties/travis/transforms/transform.mjs";

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "travis-replay");

const CLASS_FILES = {
  property: (name) => name === "property.json",
  parcel: (name) => name === "parcel.json",
  property_seed: (name) => name === "property_seed.json",
  unnormalized_address: (name) => name === "unnormalized_address.json",
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
