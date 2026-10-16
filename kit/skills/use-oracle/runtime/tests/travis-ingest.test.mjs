import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createRequire } from "node:module";

import { parseCsvRecords } from "../src/core/csv.mjs";
import { loadRetryableFailures, runStatePaths } from "../src/core/run-state.mjs";
import { runReplay } from "../src/core/replay.mjs";
import {
  ZIP_LOCAL_FILE_MAGIC,
  assertUsEgress,
  buildReconciliationArtifacts,
  captureAndTransform,
  classifyTravisFailure,
  fetchTnrFeatureForParcel,
  hasCompletedTransform,
  materializeParcelInput,
  readAllTransformedZipJsonFiles,
  resolveLexiconManifest,
  travisAdapter,
  validateRun,
} from "../src/counties/travis/adapter.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { ParquetReader } = require("@dsnp/parquetjs");

const RUNTIME_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = path.join(RUNTIME_ROOT, "fixtures", "travis-replay");
const CLI_PATH = path.join(RUNTIME_ROOT, "bin", "elephant-county.mjs");

async function loadFixtureSeedRows() {
  return parseCsvRecords(await readFile(path.join(FIXTURE_DIR, "seed.csv"), "utf8"));
}

async function readParquetRows(parquetPath) {
  const reader = await ParquetReader.openFile(parquetPath);
  try {
    const cursor = reader.getCursor();
    const rows = [];
    let record = await cursor.next();
    while (record) {
      rows.push(record);
      record = await cursor.next();
    }
    return rows;
  } finally {
    await reader.close();
  }
}

describe("materializeParcelInput (bulk-first, no network)", () => {
  it("builds the parcel input from the seed row and matches the pre-materialized fixture", async () => {
    const [row] = await loadFixtureSeedRows();
    const input = materializeParcelInput(row);
    const fixture = JSON.parse(await readFile(path.join(FIXTURE_DIR, "html", "900001.json"), "utf8"));
    expect(input).toEqual(fixture);
    expect(input.request).toEqual({ method: "GET", url: "https://traviscad.org/wp-content/largefiles/2026-Certified-Appraisal-Export.zip", multiValueQueryString: {} });
    expect(input.geometry.request.multiValueQueryString.resultOffset).toEqual(["0"]);
    expect(input.tcad.py_owner_name).toBe("DOE JOHN A & JANE DOE");
    expect(input).not.toHaveProperty("source_url");
  });

  it("fails closed without a printed PROP_ID or the bulk request URL", async () => {
    const [row] = await loadFixtureSeedRows();
    expect(() => materializeParcelInput({ ...row, parcel_id: "", source_identifier: "" })).toThrow(/printed PROP_ID/);
    expect(() => materializeParcelInput({ ...row, url: "" })).toThrow(/bulk export GET/);
  });
});

describe("lexicon manifest resolution", () => {
  it("uses the fixture snapshot offline and refuses to guess without one", async () => {
    const resolved = await resolveLexiconManifest({ htmlDir: path.join(FIXTURE_DIR, "html"), allowNetwork: false });
    expect(resolved.source).toContain("lexicon-manifest.json");
    expect(resolved.roots.countyCid).toMatch(/^bafkrei/);
    const tempDir = await mkdtemp(path.join(tmpdir(), "travis-manifest-"));
    try {
      await expect(resolveLexiconManifest({ htmlDir: path.join(tempDir, "html"), allowNetwork: false })).rejects.toThrow(/refusing to guess/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fetches live only when allowed, from the manifest URL", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "travis-manifest-live-"));
    try {
      const calls = [];
      const fetchImpl = async (url) => {
        calls.push(url);
        return new Response(JSON.stringify({ County: { ipfsCid: "bafkreicounty", type: "dataGroup" }, Seed: { ipfsCid: "bafkreiseed", type: "dataGroup" } }), { status: 200 });
      };
      const resolved = await resolveLexiconManifest({ htmlDir: path.join(tempDir, "html"), allowNetwork: true, fetchImpl });
      expect(calls).toEqual(["https://lexicon.elephant.xyz/api/manifest"]);
      expect(resolved.roots).toEqual({ countyCid: "bafkreicounty", seedCid: "bafkreiseed" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("egress guard and live TNR fetch", () => {
  it("refuses to contact the TNR layer from non-US egress and records the request when it does", async () => {
    const nonUs = async () => new Response("RO", { status: 200 });
    await expect(assertUsEgress(nonUs)).rejects.toThrow(/egress country is RO/);
    await expect(fetchTnrFeatureForParcel({ propId: "900001", fetchImpl: nonUs })).rejects.toThrow(/not US/);

    const calls = [];
    const us = async (url) => {
      calls.push(url);
      if (url.startsWith("https://ipinfo.io/")) return new Response("US", { status: 200 });
      return new Response(
        JSON.stringify({
          type: "FeatureCollection",
          features: [
            {
              id: 101,
              properties: { PROP_ID: "900001", geo_id: "0219080719" },
              geometry: { type: "Polygon", coordinates: [[[-97.723, 30.3018], [-97.7218, 30.3018], [-97.7218, 30.3025], [-97.723, 30.3025], [-97.723, 30.3018]]] },
            },
          ],
        }),
        { status: 200 },
      );
    };
    const geometry = await fetchTnrFeatureForParcel({ propId: "900001", fetchImpl: us, capturedAt: "2026-10-20T00:00:00.000Z" });
    expect(calls[0]).toBe("https://ipinfo.io/country");
    expect(calls[1]).toContain("FeatureServer/0/query?where=PROP_ID%3D900001");
    expect(geometry.request.multiValueQueryString.where).toEqual(["PROP_ID=900001"]);
    expect(geometry.latitude).toBeCloseTo(30.30215, 4);
    expect(geometry.geoId).toBe("0219080719");

    const mismatched = async (url) =>
      url.startsWith("https://ipinfo.io/")
        ? new Response("US", { status: 200 })
        : new Response(JSON.stringify({ features: [{ properties: { PROP_ID: "900009" }, geometry: null }] }), { status: 200 });
    await expect(fetchTnrFeatureForParcel({ propId: "900001", fetchImpl: mismatched })).rejects.toThrow(/does not match requested/);
  });
});

describe("captureAndTransform (fixture, no network)", () => {
  it("transforms both fixture parcels into valid ZIPs with both data-group roots", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("captureAndTransform must not call fetch() in an offline replay");
    };
    const tempDir = await mkdtemp(path.join(tmpdir(), "travis-ingest-"));
    try {
      const seedRows = await loadFixtureSeedRows();
      const outputDir = path.join(tempDir, "ingest");
      const manifest = await captureAndTransform({ seedRows, htmlDir: path.join(FIXTURE_DIR, "html"), outputDir, liveFetch: false, asOfDate: "2026-09-14" });
      expect(manifest.county).toBe("travis");
      expect(manifest.reconciled).toEqual({ seedRows: 2, success: 2, permanentFailure: 0, retryableFailure: 0 });
      expect(manifest.geometryCount).toBe(1);
      expect(manifest.lexiconManifest.source).toContain("lexicon-manifest.json");

      const zipPath = path.join(outputDir, "900001", "transformed.zip");
      expect((await readFile(zipPath)).subarray(0, 4)).toEqual(ZIP_LOCAL_FILE_MAGIC);
      expect(await hasCompletedTransform(path.join(outputDir, "900001"))).toBe(true);
      const files = readAllTransformedZipJsonFiles(zipPath);
      expect(files[`${manifest.lexiconManifest.countyCid}.json`].label).toBe("County");
      expect(files[`${manifest.lexiconManifest.seedCid}.json`].label).toBe("Seed");
      expect(files["unnormalized_address.json"].county_jurisdiction).toBe("Travis");

      const receipt = JSON.parse(await readFile(path.join(outputDir, "900001", "transform-receipt.json"), "utf8"));
      expect(receipt.inputSource).toBe("pre-materialized");
      const sidecar = JSON.parse(await readFile(path.join(outputDir, "900001", "source-payload.json"), "utf8"));
      expect(sidecar).toMatchObject({ schemaVersion: "travis.source-payload.v1", geo_id: "0219080719" });
      expect(Object.keys(files).some((name) => JSON.stringify(files[name]).includes("source_payload"))).toBe(false);
      const receipt2 = JSON.parse(await readFile(path.join(outputDir, "900002", "transform-receipt.json"), "utf8"));
      expect(receipt2.inputSource).toBe("seed-row");

      expect(await validateRun(manifest)).toEqual({ valid: true, checked: 2, issues: [] });
      expect(JSON.parse(await readFile(path.join(outputDir, "manifest.json"), "utf8"))).toEqual(manifest);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("classifies failures, keeps the retry ledger, and reconciles seed = success + permanent + retryable", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "travis-reconcile-"));
    try {
      const [fixtureRow, commercialRow] = await loadFixtureSeedRows();
      const permanentRow = { ...fixtureRow, parcel_id: "900003", source_identifier: "900003", latitude: "40.0", longitude: "-97.7" };
      const retryableRow = { ...commercialRow, parcel_id: "900004", source_identifier: "900004" };
      const htmlDir = path.join(tempDir, "html");
      await mkdir(htmlDir, { recursive: true });
      await writeFile(path.join(tempDir, "lexicon-manifest.json"), await readFile(path.join(FIXTURE_DIR, "lexicon-manifest.json")));
      // A pre-materialized input for 900004 that fails inside the transform for a transient-looking reason.
      await writeFile(path.join(htmlDir, "900004.json"), JSON.stringify({ schemaVersion: "travis.parcel-input.v1", propId: "900004", request: { method: "GET", url: "https://example.invalid/export.zip" }, tcad: {}, situs: {}, geometry: { latitude: 30.3, longitude: -97.7, request: null } }), "utf8");
      const outputDir = path.join(tempDir, "ingest");
      const jobId = "travis-reconcile-test";
      const manifest = await captureAndTransform({ seedRows: [fixtureRow, permanentRow, retryableRow], htmlDir, outputDir, liveFetch: false, jobId, asOfDate: "2026-09-14" });
      expect(manifest.reconciled.seedRows).toBe(3);
      expect(manifest.reconciled.success).toBe(2);
      expect(manifest.reconciled.permanentFailure + manifest.reconciled.retryableFailure).toBe(1);
      const byId = Object.fromEntries(manifest.results.map((result) => [result.parcelId, result]));
      expect(byId["900003"].classification).toBe("permanent_failure");
      expect(byId["900003"].error).toMatch(/outside the Travis bbox/);
      expect(byId["900004"].classification).toBe("success");
      const validation = await validateRun(manifest);
      expect(validation.valid).toBe(true);
      expect(validation.checked).toBe(2);
      const { failuresPath } = runStatePaths(outputDir, jobId);
      expect((await readFile(failuresPath, "utf8")).trim().split("\n")).toHaveLength(1);
      expect(await loadRetryableFailures(outputDir, jobId)).toHaveLength(0);
      expect(await loadRetryableFailures(outputDir, jobId, { includePermanent: true })).toHaveLength(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("classifies Travis-specific permanent patterns and defers to the shared rules otherwise", () => {
    expect(classifyTravisFailure(new Error("coordinate 40,-97 is outside the Travis bbox"))).toBe("permanent");
    expect(classifyTravisFailure(new Error("TNR feature PROP_ID 1 does not match requested 2"))).toBe("permanent");
    expect(classifyTravisFailure(new Error("egress country is RO, not US"))).toBe("permanent");
    expect(classifyTravisFailure(new Error("fetch failed: ECONNRESET"))).toBe("transient");
    expect(classifyTravisFailure(new Error("something unexpected"))).toBe("unknown");
  });

  it("refuses an all-failure run unless allowEmpty is explicit", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "travis-all-fail-"));
    try {
      const [fixtureRow] = await loadFixtureSeedRows();
      const badRow = { ...fixtureRow, parcel_id: "900005", source_identifier: "900005", latitude: "40.0", longitude: "-97.7" };
      const outputDir = path.join(tempDir, "ingest");
      const manifest = await captureAndTransform({ seedRows: [badRow], htmlDir: path.join(FIXTURE_DIR, "html"), outputDir, liveFetch: false });
      expect(manifest.reconciled).toEqual({ seedRows: 1, success: 0, permanentFailure: 1, retryableFailure: 0 });
      expect((await validateRun(manifest)).valid).toBe(false);
      expect((await validateRun(manifest, { allowEmpty: true })).valid).toBe(true);
      await expect(buildReconciliationArtifacts({ outputDir, seedRows: [badRow], workingDir: path.join(tempDir, "reconciliation") })).rejects.toThrow(/Refusing to write an empty Travis/);
      const artifacts = await buildReconciliationArtifacts({ outputDir, seedRows: [badRow], workingDir: path.join(tempDir, "reconciliation"), allowEmpty: true });
      expect(artifacts.rowCount).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("runReplay and the public CLI", () => {
  it("runs the offline pipeline through internal reconciliation artifacts", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "travis-replay-inprocess-"));
    try {
      const replay = await runReplay({ adapter: travisAdapter, fixtureDir: FIXTURE_DIR, outputDir: tempDir, skipValidate: false });
      expect(replay.seedRows).toHaveLength(2);
      expect(replay.validation).toEqual({ valid: true, checked: 2, issues: [] });
      expect(replay.artifacts.rowCount).toBe(2);
      const rows = await readParquetRows(replay.artifacts.parquetPath);
      expect(rows.map((row) => row.request_identifier).sort()).toEqual(["900001", "900002"]);
      expect(rows[0].source_system).toBe("travis_appraiser");
      expect(rows[0].county_name).toBe("Travis");
      const coverage = JSON.parse(await readFile(replay.artifacts.coveragePath, "utf8"));
      expect(coverage.datasets[0]).toMatchObject({ county: "travis", source: "appraisal", ingested_count: 2, expected_count: 2 });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("is registered on elephant-county replay and runs independent of cwd", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "travis-replay-cli-"));
    const cwdDir = await mkdtemp(path.join(tmpdir(), "travis-replay-cwd-"));
    try {
      const { stdout } = await execFileAsync(process.execPath, [CLI_PATH, "replay", "--county", "travis", "--fixture", FIXTURE_DIR, "--output", tempDir], { cwd: cwdDir });
      const summary = JSON.parse(stdout);
      expect(summary.event).toBe("replay_complete");
      expect(summary.county).toBe("travis");
      expect(summary.manifest.reconciled).toEqual({ seedRows: 2, success: 2, permanentFailure: 0, retryableFailure: 0 });
      expect(summary.artifacts.rowCount).toBe(2);
      const written = JSON.parse(await readFile(path.join(tempDir, "replay-summary.json"), "utf8"));
      expect(written.manifest).toEqual(summary.manifest);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      await rm(cwdDir, { recursive: true, force: true });
    }
  });

  it("does not offer raw single-property capture (bulk-first county)", async () => {
    expect(travisAdapter.captureRawProperty).toBeUndefined();
    const { runCaptureRaw } = await import("../bin/elephant-county.mjs");
    await expect(runCaptureRaw(["--county", "travis", "--seed", path.join(FIXTURE_DIR, "seed.csv"), "--output", tmpdir()])).rejects.toThrow(/does not support raw single-property capture/);
  });
});
