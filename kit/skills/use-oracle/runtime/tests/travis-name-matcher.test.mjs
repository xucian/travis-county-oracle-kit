import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MATCHER_VERSION, MATCH_METHOD, buildNameIndex, matchName, normalizeName, summarizeNameIndex } from "../src/counties/travis/name-matcher.mjs";
import { austinRowCompanyName, getT3Source, matchNamesOf } from "../src/counties/travis/t3-sources.mjs";

const RUNTIME = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = JSON.parse(await readFile(path.join(RUNTIME, "fixtures", "travis-t3", "matcher", "cases.json"), "utf8"));

/** @param {Record<string, string>[]} rows */
function franchiseIndex(rows) {
  return buildNameIndex(rows, {
    source: "tx-comptroller-franchise-tax",
    nameFields: ["taxpayer_name"],
    keyOf: (row) => row.taxpayer_number,
    scopeOf: (row) => (row.taxpayer_county_code === "227" ? "travis" : "out_of_county"),
    payloadOf: (row) => ({ taxpayer_number: row.taxpayer_number }),
  });
}

/** @param {ReturnType<typeof matchName>} result @param {Record<string, any>} expected */
function expectCase(result, expected) {
  expect(result.status).toBe(expected.status);
  expect(result.reason).toBe(expected.reason);
  expect(result.candidate_count).toBe(expected.candidate_count);
  expect(result.candidate?.key ?? null).toBe(expected.key);
  expect(result.candidate?.scope ?? null).toBe(expected.scope);
  if (expected.rows !== undefined) expect(result.candidate?.rows).toBe(expected.rows);
  expect(result.matcher_version).toBe(MATCHER_VERSION);
  expect(result.match_method).toBe(MATCH_METHOD);
  if (result.candidate) expect(result.candidate.status).toBe("candidate");
}

describe("Travis exact-unique-normalized-name matcher", () => {
  it("is the version the fixtures were written for", () => {
    expect(FIXTURE.matcher_version).toBe(MATCHER_VERSION);
    expect(MATCH_METHOD).toBe("exact_unique_normalized_name");
  });

  it("normalizes printed names for exact comparison only", () => {
    expect(normalizeName("  Acme   Roofing, L.L.C. ")).toBe("ACME ROOFING");
    expect(normalizeName("PEÑASCO ROOFING LLC")).toBe("PENASCO ROOFING");
    expect(normalizeName("A & B Roofing")).toBe("A B ROOFING");
    expect(normalizeName("Smith Roofing Co. of Texas")).toBe("SMITH ROOFING OF TEXAS");
    expect(normalizeName("L.L.C.")).toBeNull();
    expect(normalizeName("")).toBeNull();
    expect(normalizeName(null)).toBeNull();
    expect(normalizeName(42)).toBeNull();
  });

  for (const testCase of FIXTURE.cases) {
    it(`statewide universe: ${testCase.id}`, () => {
      expectCase(matchName(franchiseIndex(FIXTURE.universe), testCase.printed), testCase.expect);
    });
  }

  for (const testCase of FIXTURE.travis_only_universe_cases) {
    it(`Travis-only universe: ${testCase.id}`, () => {
      const travisOnly = FIXTURE.universe.filter((row) => row.taxpayer_county_code === "227");
      expectCase(matchName(franchiseIndex(travisOnly), testCase.printed), testCase.expect);
    });
  }

  it("summarizes collisions with counts only", () => {
    const summary = summarizeNameIndex(franchiseIndex(FIXTURE.universe));
    expect(summary).toMatchObject(FIXTURE.summary);
    expect(summary.matcher_version).toBe(MATCHER_VERSION);
  });

  it("returns copies, so a caller cannot change the index", () => {
    const index = franchiseIndex(FIXTURE.universe);
    const first = matchName(index, "Acme Roofing");
    first.candidate.printed_names.push("tampered");
    first.candidate.payload.taxpayer_number = "tampered";
    const second = matchName(index, "Acme Roofing");
    expect(second.candidate.printed_names).toEqual(["ACME ROOFING, L.L.C."]);
    expect(second.candidate.payload.taxpayer_number).toBe("10000000001");
  });

  it("indexes the Austin right-of-way company part beside the printed name", () => {
    expect(austinRowCompanyName("**2026/10/06 TAS**Kent Companies Texas, LLC")).toBe("Kent Companies Texas, LLC");
    expect(austinRowCompanyName("Texas Dirt Partners(Hudson Alderman)")).toBe("Texas Dirt Partners");
    expect(austinRowCompanyName("2400 CONSTRUCTION")).toBeNull();
    const source = getT3Source("austin-row-contractor-licenses");
    const rows = [
      { license_number__trimmed: "2024-000001LC", contractor_name__trimmed: "**MH** Shamrock Concrete, LLC(Kelly Calhoun)" },
      { license_number__trimmed: "2024-000002LC", contractor_name__trimmed: "2400 CONSTRUCTION" },
    ];
    const index = buildNameIndex(
      rows.map((row) => ({ ...row, names: matchNamesOf(source, row) })).map((row) => ({ ...row, n0: row.names[0], n1: row.names[1] })),
      { source: source.key, nameFields: ["n0", "n1"], keyOf: (row) => row.license_number__trimmed },
    );
    expect(matchName(index, "Shamrock Concrete LLC")).toMatchObject({ status: "candidate", candidate: { key: "2024-000001LC" } });
    expect(matchName(index, "2400 Construction")).toMatchObject({ status: "candidate", candidate: { key: "2024-000002LC" } });
  });

  it("is importable by a process outside the kit runtime (packages/deploy-build)", async () => {
    const sourceText = await readFile(path.join(RUNTIME, "src", "counties", "travis", "name-matcher.mjs"), "utf8");
    expect(sourceText).not.toMatch(/^\s*import\s/m);
    expect(await readFile(path.join(RUNTIME, "src", "counties", "travis", "t3-sources.mjs"), "utf8")).not.toMatch(/^\s*import\s/m);
    const outside = await mkdtemp(path.join(tmpdir(), "deploy-build-"));
    try {
      const matcherUrl = pathToFileURL(path.join(RUNTIME, "src", "counties", "travis", "name-matcher.mjs")).href;
      const sourcesUrl = pathToFileURL(path.join(RUNTIME, "src", "counties", "travis", "t3-sources.mjs")).href;
      const script = `const m = await import(${JSON.stringify(matcherUrl)}); const s = await import(${JSON.stringify(sourcesUrl)});
const index = m.buildNameIndex([{ k: "1", n: "ACME ROOFING LLC" }], { source: "x", nameFields: ["n"], keyOf: (r) => r.k });
console.log(JSON.stringify({ version: m.MATCHER_VERSION, status: m.matchName(index, "Acme Roofing").status, sources: Object.keys(s.T3_SOURCES).length }));`;
      const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: outside, encoding: "utf8" });
      expect(JSON.parse(output)).toEqual({ version: MATCHER_VERSION, status: "candidate", sources: 6 });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
