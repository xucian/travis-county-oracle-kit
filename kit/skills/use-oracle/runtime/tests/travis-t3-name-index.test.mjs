import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MATCHER_VERSION, buildNameIndex, matchName } from "../src/counties/travis/name-matcher.mjs";
import { NAME_INDEXES, buildIndexFromSnapshot, collisionSummary, readNameIndex, writeNameIndex } from "../src/counties/travis/t3-name-index.mjs";
import { loadSnapshot } from "../src/counties/travis/t3-snapshot.mjs";

const RUNTIME = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = JSON.parse(await readFile(path.join(RUNTIME, "fixtures", "travis-t3", "matcher", "cases.json"), "utf8"));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const csvCell = (value) => (value === undefined ? "" : `"${String(value).replace(/"/g, '""')}"`);

/** Load the fixture universe as a franchise snapshot (the same path the real statewide universe takes). */
async function fixtureSnapshot(root) {
  const capture = path.join(root, "capture");
  await mkdir(capture, { recursive: true });
  const columns = ["taxpayer_number", "taxpayer_name", "taxpayer_county_code", "sos_status_code"];
  const text = `${columns.map((column) => `"${column}"`).join(",")}\n${FIXTURE.universe.map((row) => columns.map((column) => csvCell(row[column])).join(",")).join("\n")}\n`;
  await writeFile(path.join(capture, "page-00000.csv"), text);
  await writeFile(path.join(capture, "receipts.jsonl"), `${JSON.stringify({ kind: "page", file: "page-00000.csv", url: "https://data.texas.gov/resource/9cir-efmm.csv?%24offset=0", fetched_at: "2026-10-17T16:07:20.000Z", status: 200, bytes: Buffer.byteLength(text), sha256: sha256(text), rows: FIXTURE.universe.length, content_type: "text/csv" })}\n`);
  await loadSnapshot({ sourceKey: "tx-comptroller-franchise-tax", captureDir: capture, outputDir: path.join(root, "registry"), name: "tx-comptroller-franchise-tax-statewide", now: "2026-10-17T00:00:00.000Z" });
  return path.join(root, "registry", "tx-comptroller-franchise-tax-statewide.parquet");
}

const outcome = (result) => ({ status: result.status, reason: result.reason, candidate_count: result.candidate_count, key: result.candidate?.key ?? null, scope: result.candidate?.scope ?? null, rows: result.candidate?.rows ?? null });

describe("T3 persisted name index", () => {
  it("matches every fixture case the same way from the snapshot, from Parquet, and from the matcher's in-memory index", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-index-"));
    try {
      const spec = NAME_INDEXES.find((candidate) => candidate.name === "tx-comptroller-franchise-tax-statewide");
      const built = await buildIndexFromSnapshot(spec, await fixtureSnapshot(root));
      const inMemory = buildNameIndex(FIXTURE.universe, {
        source: "tx-comptroller-franchise-tax",
        nameFields: ["taxpayer_name"],
        keyOf: (row) => row.taxpayer_number,
        scopeOf: (row) => (row.taxpayer_county_code === "227" ? "travis" : "out_of_county"),
      });
      const output = await writeNameIndex(built, path.join(root, "matcher", "franchise.names.parquet"), { snapshot_sha256: "test" });
      const reread = await readNameIndex(path.join(root, "matcher", "franchise.names.parquet"));
      expect(reread.matcher_version).toBe(MATCHER_VERSION);
      for (const testCase of FIXTURE.cases) {
        const expected = outcome(matchName(inMemory, testCase.printed));
        expect(outcome(matchName(built, testCase.printed)), testCase.id).toEqual(expected);
        expect(outcome(matchName(reread, testCase.printed)), testCase.id).toEqual(expected);
        expect(expected.status, testCase.id).toBe(testCase.expect.status);
        expect(expected.key, testCase.id).toBe(testCase.expect.key);
      }
      // Deterministic: the same index writes the same bytes, and the file is not rewritten.
      const again = await writeNameIndex(built, path.join(root, "matcher", "franchise.names.parquet"), { snapshot_sha256: "test" });
      expect(again).toMatchObject({ sha256: output.sha256, written: false, unchanged: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("counts collisions for the universe, for Travis alone and for Travis names in the universe", () => {
    const rows = [
      { key: "1", name: "ACME ROOFING LLC", scope: "travis" },
      { key: "2", name: "ACME ROOFING INC", scope: "out_of_county" },
      { key: "3", name: "TWIN CO", scope: "travis" },
      { key: "4", name: "TWIN CO", scope: "travis" },
      { key: "5", name: "SOLO TRAVIS LLC", scope: "travis" },
      { key: "6", name: "SOLO ELSEWHERE LLC", scope: "out_of_county" },
    ];
    const index = buildNameIndex(rows, { source: "test", nameFields: ["name"], keyOf: (row) => row.key, scopeOf: (row) => row.scope });
    const summary = collisionSummary(index);
    expect(summary.universe).toMatchObject({ normalized_names: 4, non_unique_names: 2, keys_under_non_unique_names: 4 });
    expect(summary.travis_alone).toEqual({ normalized_names: 3, non_unique_names: 1, keys_under_non_unique_names: 2 });
    expect(summary.travis_in_universe).toMatchObject({ travis_keys: 4, names_unique_in_universe: 1, names_shared_in_universe: 2, names_shared_only_within_travis: 1, names_shared_with_an_out_of_county_key: 1, travis_keys_with_a_unique_name: 1, travis_keys_with_a_shared_name: 3 });
    expect(summary.out_of_county_unique_names).toBe(1);
  });

  it("refuses an index written by another matcher version", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-index-version-"));
    try {
      const index = buildNameIndex([{ key: "1", name: "ACME" }], { source: "test", nameFields: ["name"], keyOf: (row) => row.key });
      await writeNameIndex({ ...index, matcher_version: "some-other-matcher.v9" }, path.join(root, "x.names.parquet"), {});
      await expect(readNameIndex(path.join(root, "x.names.parquet"))).rejects.toThrow(/built by matcher some-other-matcher\.v9/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
