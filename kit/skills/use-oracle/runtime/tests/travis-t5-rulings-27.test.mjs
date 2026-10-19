import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseCsvRecords } from "../src/core/csv.mjs";
import { materializeParcelInput } from "../src/counties/travis/adapter.mjs";
import { TRAVIS_SEED_BBOX } from "../src/counties/travis/seed.mjs";
import { TRAVIS_CONTRACT_BBOX, classifyNoSitus } from "../src/counties/travis/t5-reconcile.mjs";
import { CODE_CHANGE_PROOFS, codeChanges, proveLinkStageUnchanged, proveSitusColumnsBranch, proveValidationBoxWidened, shardFacts } from "../src/counties/travis/t5-recertify.mjs";
import { STAGE_CODE } from "../src/counties/travis/t5-run.mjs";
import { renderRows } from "../src/counties/travis/t5-shards.mjs";
import { TRAVIS_VALIDATION_BBOX, assertGeometryInCounty, assertTravisIdentity } from "../src/counties/travis/validate.mjs";
import { SITUS_COLUMNS_VERSION, SITUS_SHIFTED_SUFFIX_WORDS, buildTravisOutput, readShiftedSitusColumns, resolveDataGroupCids } from "../counties/travis/transforms/transform.mjs";

const RUNTIME = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = path.join(RUNTIME, "fixtures", "travis-replay");
/** The kit commit the T5 full run ran (run.json kit_commit); the text proofs are checked against it when the history has it. */
const RUN_COMMIT = "962f851";
const atCommit = (file) => {
  try {
    return execFileSync("git", ["-C", RUNTIME, "show", `${RUN_COMMIT}:./${file}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};
const HAS_RUN_COMMIT = atCommit("src/counties/travis/validate.mjs") !== null;

async function fixture() {
  const rows = parseCsvRecords(await readFile(path.join(FIXTURE_DIR, "seed.csv"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(FIXTURE_DIR, "lexicon-manifest.json"), "utf8"));
  return { rows, manifest, roots: resolveDataGroupCids(manifest) };
}
const situs = (parts) => Object.fromEntries(["num", "street_prefx", "street", "street_suffix", "unit"].map((name) => [`situs_${name}`, parts[name] ?? null]));
const shiftedRow = (row, parts) => ({ ...row, ...Object.fromEntries(Object.entries(situs(parts)).map(([name, value]) => [`source_${name}`, value ?? ""])), address: "E PARMER LN, TX 78753" });

describe("27.9: the validation box is the seed builder's box", () => {
  it("equals TRAVIS_SEED_BBOX and contains the API contract's rounded box", () => {
    expect({ ...TRAVIS_VALIDATION_BBOX }).toEqual({ ...TRAVIS_SEED_BBOX });
    expect(TRAVIS_VALIDATION_BBOX.minLat).toBeLessThanOrEqual(TRAVIS_CONTRACT_BBOX.minLat);
    expect(TRAVIS_VALIDATION_BBOX.maxLat).toBeGreaterThanOrEqual(TRAVIS_CONTRACT_BBOX.maxLat);
    expect(TRAVIS_VALIDATION_BBOX.minLng).toBeLessThanOrEqual(TRAVIS_CONTRACT_BBOX.minLng);
    expect(TRAVIS_VALIDATION_BBOX.maxLng).toBeGreaterThanOrEqual(TRAVIS_CONTRACT_BBOX.maxLng);
  });

  it("accepts the points of the 12 county-line accounts the rounded box refused, and still refuses geometry outside Travis", () => {
    // The refusing point of each, as the run's tombstones print it (355402, 355441, 355648, 355650, 355656, 355668, 358848, 787307, 808449, 808450, 832972, 947911).
    const refused = [
      [30.636479668980307, -97.96070449342227],
      [30.632200789978068, -98.0042430250227],
      [30.358775675268614, -98.17000823672576],
      [30.35462762421729, -98.17018090903237],
      [30.34858490143125, -98.17801145314051],
      [30.360330287605187, -98.17054932374415],
      [30.41938551456935, -97.36979987465058],
      [30.351037435301983, -98.17156086587066],
      [30.63166359529014, -97.94959335748058],
      [30.631808385076813, -97.94942340053124],
      [30.631575559864793, -97.94943275330874],
      [30.360214522293262, -98.17015531379144],
    ];
    for (const [latitude, longitude] of refused) expect(() => assertGeometryInCounty([{ latitude, longitude }])).not.toThrow();
    // The worst vertex of the 12 (355656, 2.35 km past the Census line, 1.5 km past the rounded box) is inside the box too.
    expect(() => assertGeometryInCounty([{ latitude: 30.3485, longitude: -98.1866 }])).not.toThrow();
    for (const [latitude, longitude] of [[29.7, -95.4], [30.76, -97.7], [29.94, -97.7], [30.3, -98.26], [30.3, -97.29], [0, 0]]) {
      expect(() => assertGeometryInCounty([{ latitude, longitude }]), `${latitude},${longitude}`).toThrow(/outside the Travis bbox/);
    }
  });
});

describe("27.10: a street printed one column to the right, exactly that pattern", () => {
  it("reads the three accounts' printed columns", () => {
    expect(readShiftedSitusColumns(situs({ street_prefx: "E", street_suffix: "PARMER", unit: "LN" }))).toEqual({
      version: SITUS_COLUMNS_VERSION,
      printed: { situs_num: null, situs_street_prefx: "E", situs_street: null, situs_street_suffix: "PARMER", situs_unit: "LN" },
      read_as: { street_prefix: "E", street_name: "PARMER", street_suffix: "LN", unit: null },
    });
    expect(readShiftedSitusColumns(situs({ street_suffix: "PINNACLE", unit: "CV" }))?.read_as).toEqual({ street_prefix: null, street_name: "PINNACLE", street_suffix: "CV", unit: null });
    expect(SITUS_SHIFTED_SUFFIX_WORDS).toContain("LN");
    expect(SITUS_SHIFTED_SUFFIX_WORDS).toContain("CV");
    expect(SITUS_SHIFTED_SUFFIX_WORDS.every((word) => /^[A-Z]{2,4}$/.test(word))).toBe(true);
  });

  it("reads nothing broader: a street present, nothing printed, a house number only, a real unit, a suffix word or two words in the suffix column", () => {
    for (const parts of [
      { street: "MAIN", street_suffix: "ST" },
      { street: "PARMER", street_suffix: "LN", unit: "LN" },
      {},
      { num: "18829" },
      { street_suffix: "PINNACLE", unit: "A" },
      { street_suffix: "PINNACLE", unit: "101" },
      { street_suffix: "PINNACLE", unit: "APT" },
      { street_suffix: "PINNACLE", unit: "STE" },
      { street_suffix: "PINNACLE", unit: "BLDG" },
      { street_suffix: "DR", unit: "LN" },
      { street_suffix: "HAMILTON POOL", unit: "RD" },
      { street_suffix: "pinnacle", unit: "CV" },
      { street_suffix: "PINNACLE" },
      { unit: "CV" },
    ]) {
      expect(readShiftedSitusColumns(situs(parts)), JSON.stringify(parts)).toBeNull();
    }
  });

  it("publishes a shifted account with its printed address and flags the reading in the sidecar; a row with a street is unchanged", async () => {
    const { rows, manifest, roots } = await fixture();
    const row = shiftedRow(rows[0], { street_prefx: "E", street_suffix: "PARMER", unit: "LN" });
    const { files, sourcePayload } = buildTravisOutput(materializeParcelInput(row), { manifest });
    expect(files["address.json"].unnormalized_address).toBe("E PARMER LN, TX 78753");
    expect(sourcePayload.situs_columns_shifted).toMatchObject({ version: SITUS_COLUMNS_VERSION, read_as: { street_name: "PARMER", street_suffix: "LN" } });
    expect(() => assertTravisIdentity({ row, files, roots })).not.toThrow();
    const plain = buildTravisOutput(materializeParcelInput(rows[0]), { manifest });
    expect(Object.hasOwn(plain.sourcePayload, "situs_columns_shifted")).toBe(false);
    // A blank street any other way stays a permanent failure with the run's message.
    expect(() => buildTravisOutput(materializeParcelInput(shiftedRow(rows[0], { street_suffix: "PINNACLE", unit: "101" })), { manifest })).toThrow(/^no situs address: the roll prints no situs street for this account$/);
    expect(() => buildTravisOutput(materializeParcelInput(shiftedRow(rows[0], {})), { manifest })).toThrow(/no situs address/);
  });

  it("the reconciliation classes a dead blank street exactly as the transform reads it", () => {
    const row = (parts) => Object.fromEntries(["num", "street_prefx", "street", "street_suffix", "unit"].map((name) => [`source_situs_${name}`, parts[name] ?? ""]));
    expect(classifyNoSitus(row({ street_prefx: "E", street_suffix: "PARMER", unit: "LN" }))).toBe("columns_shifted");
    expect(classifyNoSitus(row({ street_suffix: "PINNACLE", unit: "STE" }))).toBe("other_parts");
  });

  it.runIf(HAS_RUN_COMMIT)("gives every row with a street the run's output and sidecar, byte for byte (the run's transform, 962f851, side by side)", async () => {
    const { rows, manifest } = await fixture();
    const dir = await mkdtemp(path.join(tmpdir(), "travis-transform-962f851-"));
    try {
      const file = path.join(dir, "transform.mjs");
      await writeFile(file, atCommit("counties/travis/transforms/transform.mjs"));
      const before = await import(pathToFileURL(file).href);
      for (const source of rows) {
        for (const row of [source, { ...source, source_situs_unit: "A" }, { ...source, source_situs_street_suffix: "" }]) {
          const input = materializeParcelInput(row);
          expect(JSON.stringify(buildTravisOutput(input, { manifest }))).toBe(JSON.stringify(before.buildTravisOutput(input, { manifest })));
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("t5-recertify: the text proofs", () => {
  const box = (minLat, maxLat, minLng, maxLng, doc = "/** The box. */") => `// head\n${doc}\nexport const TRAVIS_VALIDATION_BBOX = Object.freeze({\n  minLat: ${minLat},\n  maxLat: ${maxLat},\n  minLng: ${minLng},\n  maxLng: ${maxLng},\n});\n\nexport function f() {}\n`;

  it("validation_box_widened holds only for a widened box with nothing else changed", () => {
    expect(proveValidationBoxWidened(box(30.02, 30.63, -98.17, -97.37), box(29.95, 30.75, -98.25, -97.3, "/**\n * A longer doc.\n */"))).toMatchObject({ holds: true, now_box: { minLat: 29.95, maxLng: -97.3 } });
    expect(proveValidationBoxWidened(box(30.02, 30.63, -98.17, -97.37), box(30.05, 30.75, -98.25, -97.3)).holds).toBe(false);
    expect(proveValidationBoxWidened(box(30.02, 30.63, -98.17, -97.37), box(29.95, 30.75, -98.25, -97.3).replace("export function f() {}", "export function f() { return 1; }")).holds).toBe(false);
    expect(proveValidationBoxWidened("nothing", box(29.95, 30.75, -98.25, -97.3)).holds).toBe(false);
  });

  it("situs_columns_branch holds only for the delimited blocks and the one guard condition", () => {
    const before = "a\n  if (text(tcad.situs_street) === null) {\n    throw x;\n  }\nb\n";
    const now = "a\n  // [travis-situs-columns-v1\n  const situsShift = 1;\n  // travis-situs-columns-v1]\n  if (text(tcad.situs_street) === null && situsShift === null) {\n    throw x;\n  }\n// [travis-situs-columns-v1 note\nextra\n// travis-situs-columns-v1]\nb\n";
    expect(proveSitusColumnsBranch(before, now)).toMatchObject({ holds: true, blocks: 2 });
    expect(proveSitusColumnsBranch(before, now.replace("\nb\n", "\nc\n")).holds).toBe(false);
    expect(proveSitusColumnsBranch(before, now.replace("// travis-situs-columns-v1]\nb", "b")).holds).toBe(false);
    expect(proveSitusColumnsBranch(before, now.replace("&& situsShift === null", "&& true")).holds).toBe(false);
    expect(proveSitusColumnsBranch(now, now).holds).toBe(false);
  });

  it("link_stage_unchanged holds only when the plan and link stages are byte for byte the same", () => {
    const file = (body) => `x\n  async planAndLink() {\n    // Plan.\n${body}\n    this.link = linkMarker.output;\n  }\ny\n`;
    expect(proveLinkStageUnchanged(file("    stage();"), file("    stage();").replace("y\n", "z\n")).holds).toBe(true);
    expect(proveLinkStageUnchanged(file("    stage();"), file("    stage(2);")).holds).toBe(false);
  });

  it("codeChanges lists each changed file once with the stages it touches, and refuses a file without a proof", async () => {
    const texts = { "src/counties/travis/validate.mjs": [box(30.02, 30.63, -98.17, -97.37), box(29.95, 30.75, -98.25, -97.3)], "src/counties/travis/t5-loader.mjs": ["a", "b"] };
    const read = (index) => async (file) => Buffer.from(texts[file]?.[index] ?? `same ${file}`);
    const changes = await codeChanges({ commit: "abc1234", stageCode: { appraisal: ["src/counties/travis/validate.mjs", "x.mjs"], permits: ["src/counties/travis/validate.mjs"], loader: ["src/counties/travis/t5-loader.mjs"] }, readAtCommit: read(0), readNow: read(1) });
    expect(changes.stages).toEqual({ appraisal: ["src/counties/travis/validate.mjs"], permits: ["src/counties/travis/validate.mjs"], loader: ["src/counties/travis/t5-loader.mjs"] });
    expect(changes.files["src/counties/travis/validate.mjs"]).toMatchObject({ stages: ["appraisal", "permits"], proof: "validation_box_widened", holds: true });
    expect(changes.files["src/counties/travis/t5-loader.mjs"]).toMatchObject({ proof: null, holds: false });
    expect(changes.files["x.mjs"]).toMatchObject({ stages: [], holds: true, detail: "unchanged" });
  });

  it.runIf(HAS_RUN_COMMIT)("every stage file changed since the run's kit commit 962f851 has a proof, and each holds on the real texts", async () => {
    const changes = await codeChanges({ commit: RUN_COMMIT, stageCode: STAGE_CODE });
    const changed = Object.entries(changes.files).filter(([, item]) => item.at_run_sha256 !== item.now_sha256);
    expect(changed.map(([file]) => file).sort()).toEqual(Object.keys(CODE_CHANGE_PROOFS).sort());
    for (const [file, item] of changed) expect(item.holds, `${file}: ${item.detail}`).toBe(true);
    expect(changes.stages).toMatchObject({ link: ["src/counties/travis/t5-run.mjs"], permits: ["src/counties/travis/validate.mjs"], reconcile: [], loader: [] });
    expect([...changes.stages.appraisal].sort()).toEqual(["counties/travis/transforms/transform.mjs", "src/counties/travis/validate.mjs"]);
  });
});

describe("t5-recertify: the shard facts", () => {
  it("validation_box_widened needs no guard refusal in the shard; situs_columns_branch needs every blank street dead and outside the pattern", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "travis-recertify-facts-"));
    try {
      const marker = (dead) => ({ output: { dead, counts: { failed_permanent: 0 }, failures: [] } });
      expect((await shardFacts({ proof: "validation_box_widened", stage: "appraisal", dir, marker: marker([{ key: "1", evidence: "no situs address: the roll prints no situs street for this account" }]) })).holds).toBe(true);
      expect((await shardFacts({ proof: "validation_box_widened", stage: "appraisal", dir, marker: marker([{ key: "2", evidence: "coordinate 30.64,-97.9 is outside the Travis bbox" }]) })).holds).toBe(false);
      expect((await shardFacts({ proof: "validation_box_widened", stage: "permits", dir, marker: { output: { counts: { failed_permanent: 1 }, failures: [{ key: "3" }] } } })).holds).toBe(false);
      const { rows } = await fixture();
      const columns = Object.keys(rows[0]);
      const csv = (list) => renderRows(columns, list);
      const blank = { ...shiftedRow(rows[0], {}), parcel_id: "900010", source_identifier: "900010" };
      const shifted = { ...shiftedRow(rows[0], { street_suffix: "PINNACLE", unit: "CV" }), parcel_id: "900011", source_identifier: "900011" };
      const noSitus = { key: "900010", evidence: "no situs address: the roll prints no situs street for this account" };
      await writeFile(path.join(dir, "seed.csv"), csv([rows[0], blank]));
      expect(await shardFacts({ proof: "situs_columns_branch", stage: "appraisal", dir, marker: marker([noSitus]) })).toMatchObject({ holds: true, facts: { blank_street_rows: 1, shifted_pattern_rows: 0 } });
      expect((await shardFacts({ proof: "situs_columns_branch", stage: "appraisal", dir, marker: marker([]) })).holds).toBe(false);
      await writeFile(path.join(dir, "seed.csv"), csv([rows[0], blank, shifted]));
      expect(await shardFacts({ proof: "situs_columns_branch", stage: "appraisal", dir, marker: marker([noSitus, { key: "900011", evidence: noSitus.evidence }]) })).toMatchObject({ holds: false, facts: { shifted_pattern_rows: 1 } });
      expect((await shardFacts({ proof: "situs_columns_branch", stage: "permits", dir, marker: marker([]) })).holds).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
