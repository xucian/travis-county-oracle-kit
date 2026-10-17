#!/usr/bin/env node
/**
 * T4 permit run (assignment decisions.md section 2 item 4; kit `county-ingest-run` sections 1-2): one seed (the
 * 25-parcel pilot or the 1,000-parcel feasibility sample) through every stage of the property-first run, offline
 * except for the public lexicon manifest (and the optional Socrata cross-check):
 *
 *   verify capture -> appraisal transform (the T2 adapter) -> internal reconcile-export -> eligibility (`__ALL__` /
 *   `__NONE__`) -> roll index -> permit link pass (the bulk "harvest by parcel") -> permit transform per eligible
 *   parcel -> per-group directories -> elephant-cli validate, hash, CAR validate and export-tables for the County and the
 *   Property Improvement groups (local files only: no upload, no pin, no Atlas PR) -> property-CID check across the two
 *   archives.
 *
 * Every parcel ends in exactly one permit state: `done` (permits written), `done_zero_permits` (eligible, nothing
 * linked: completes cleanly, never retried), `not_eligible`, `appraisal_failed`, `failed_permanent` (dead: recorded,
 * not retried) or `failed_retryable` (retried by `--resume`). Each stage is timed for the 48-hour projection.
 *
 *   PROPERTY_FIRST_PERMIT_ELIGIBLE_USAGE_TYPES_TRAVIS=__ALL__ node --max-old-space-size=12288 src/counties/travis/t4-run.mjs \
 *     --seed data/seeds/travis-pilot.csv --label pilot --cli <elephant-cli> [--cross-check-socrata] \
 *     [--fault-drill permanent:<PROP_ID>,retryable:<PROP_ID>] [--resume <run-dir>]
 *
 * @module counties/travis/t4-run
 */
import AdmZip from "adm-zip";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { parseCsvRecords } from "../../core/csv.mjs";
import { appendFailure } from "../../core/run-state.mjs";
import { COPIED_FROM_APPRAISAL, PERMIT_DATA_DIRNAME, PERMIT_TRANSFORM_VERSION, resolvePermitGroupCids, writeTravisPermitTransform } from "../../../counties/travis/transforms/permit-transform.mjs";
import { buildReconciliationArtifacts, captureAndTransform, classifyTravisFailure } from "./adapter.mjs";
import { decideEligibility, resolveEligibilityPolicy } from "./eligibility.mjs";
import { TCAD_ID_EVIDENCE_VERSION, WORK_CLASSIFIER_VERSION, STATUS_GROUP_VERSION } from "./permit-profile.mjs";
import { captureToFile, compactTimestamp, createCaptureContext, hostLimiter } from "./t3-fetch.mjs";
import { RUNTIME_ROOT } from "./t3-snapshot.mjs";
import { PERMIT_DATASET_ID, PERMIT_DOMAIN, PERMIT_RESOURCE_URL } from "./t4-permit-fetch.mjs";
import { DEFAULT_SEED, readRollGeoIndex, runLinkPass } from "./t4-permit-links.mjs";
import { latestCapture, verifyPermitCapture } from "./t4-permit-verify.mjs";
import { TRAVIS_PERMIT_SOURCE_HOSTS, assertOutputContract, assertTravisIdentity } from "./validate.mjs";

export const T4_RUN_VERSION = "travis-t4-run.v1";
export const LEXICON_MANIFEST_URL = "https://lexicon.elephant.xyz/api/manifest";
export const STAGING_DIRNAME = `${PERMIT_DATA_DIRNAME}.partial`;
export const GROUPS = Object.freeze({ county: "county", permits: "property_improvement" });
const DONE_STATES = new Set(["done", "done_zero_permits", "failed_permanent", "not_eligible"]);

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const rel = (target) => path.relative(RUNTIME_ROOT, target).split(path.sep).join("/");
const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * @param {string} file - JSON file.
 * @returns {Promise<any>} Parsed JSON.
 */
async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

/**
 * Parse the `--fault-drill` value (`permanent:<id>,retryable:<id>`).
 *
 * @param {string | undefined} value - Flag value.
 * @returns {{ permanent: Set<string>, retryable: Set<string> }} Drill.
 */
export function parseFaultDrill(value) {
  const drill = { permanent: new Set(), retryable: new Set() };
  for (const part of String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean)) {
    const [kind, id] = part.split(":");
    if (!(kind === "permanent" || kind === "retryable") || !/^\d{1,12}$/.test(id ?? "")) throw new Error(`--fault-drill takes permanent:<PROP_ID> and retryable:<PROP_ID>, got ${part}`);
    drill[kind].add(id);
  }
  return drill;
}

/**
 * Run one elephant-cli command, logging both streams to a file; never throws on a non-zero exit.
 *
 * @param {string} cli - CLI path.
 * @param {string[]} args - Arguments.
 * @param {string} cwd - Working directory.
 * @param {string} logFile - Log file.
 * @returns {Promise<{ code: number | null, ms: number, output: string }>} Result.
 */
export async function runCli(cli, args, cwd, logFile) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, { cwd, env: process.env });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", async (code) => {
      const output = Buffer.concat(chunks).toString("utf8");
      await writeFile(logFile, output);
      resolve({ code, ms: performance.now() - started, output });
    });
  });
}

/**
 * The human lines of a CLI log (the JSON log lines dropped).
 *
 * @param {string} output - CLI output.
 * @returns {string} Text lines.
 */
const textLines = (output) =>
  output
    .split("\n")
    .filter((line) => !line.startsWith('{"level"') && !/^unknown format "percentage"/.test(line))
    .join("\n");

/**
 * Parse the CLI outputs this runner reads.
 *
 * @param {string} output - CLI output.
 * @returns {Record<string, any>} Parsed values (missing ones null).
 */
export function parseCliOutput(output) {
  const text = textLines(output);
  const processed = /Properties processed: (\d+), succeeded: (\d+), failed: (\d+)/.exec(text);
  const car = /CAR written: .* \((\d+) blocks, root (\w+)\)/.exec(text);
  const tables = /Tables written: .* \((\d+) tables, (\d+) parts, root (\w+)\)/.exec(text);
  const report = {};
  for (const [key, pattern] of [
    ["blocks", /Blocks:\s+(\d+)/],
    ["properties", /Properties:\s+(\d+)/],
    ["data_groups_validated", /Data groups validated:\s+(\d+)/],
    ["integrity_errors", /integrity errors:\s+(\d+)/],
    ["root_errors", /root errors:\s+(\d+)/],
    ["index_errors", /index errors:\s+(\d+)/],
    ["graph_errors", /graph errors:\s+(\d+)/],
    ["lexicon_errors", /lexicon errors:\s+(\d+)/],
    ["orphans_errors", /orphans errors:\s+(\d+)/],
  ]) {
    const match = pattern.exec(text);
    if (match) report[key] = Number(match[1]);
  }
  return {
    processed: processed ? { processed: Number(processed[1]), succeeded: Number(processed[2]), failed: Number(processed[3]) } : null,
    car: car ? { blocks: Number(car[1]), root: car[2] } : null,
    tables: tables ? { tables: Number(tables[1]), parts: Number(tables[2]), root: tables[3] } : null,
    car_validation: Object.keys(report).length > 0 ? { ...report, passed: /CAR passed every check/.test(text) } : null,
  };
}

/**
 * @param {string} csvFile - `elephant-cli hash` CSV.
 * @param {string} seedCid - Seed schema CID.
 * @returns {Promise<string[]>} The property CIDs (one per property).
 */
async function propertyCids(csvFile, seedCid) {
  const rows = parseCsvRecords(await readFile(csvFile, "utf8"));
  return [...new Set(rows.filter((row) => row.dataGroupCid === seedCid).map((row) => row.propertyCid))].sort();
}

/**
 * @param {string} csvFile - Errors CSV written by `validate`.
 * @returns {Promise<number>} Data rows.
 */
async function errorRows(csvFile) {
  if (!existsSync(csvFile)) return 0;
  return parseCsvRecords(await readFile(csvFile, "utf8")).length;
}

/**
 * The day after a `YYYY-MM-DD` date (UTC).
 *
 * @param {string} date - Date.
 * @returns {string} Next date.
 */
export function nextDay(date) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/**
 * Socrata cross-check: the server's own count of the permits printing each geo_id and issued no later than the capture's
 * latest issue date, against the capture's count. The export is republished daily and only grows with new issues, so the
 * comparison holds on any later day; one more request counts the rows issued after that date, as context.
 *
 * @param {object} options - Options.
 * @param {string} options.dir - Receipt directory.
 * @param {string[]} options.geoIds - Printed geo_ids.
 * @param {Map<string, { rows: number }>} options.captured - Capture counts per tcad_id.
 * @param {string} options.captureVersion - The capture's rowsUpdatedAt.
 * @param {string} options.issueDateMax - The capture's latest issue date (`YYYY-MM-DD`).
 * @param {typeof fetch} [options.fetchImpl] - Fetch (tests).
 * @returns {Promise<Record<string, any>>} Result.
 */
async function crossCheckSocrata({ dir, geoIds, captured, captureVersion, issueDateMax, fetchImpl = globalThis.fetch }) {
  const ctx = createCaptureContext({ fetchImpl, limit: hostLimiter({ [PERMIT_DOMAIN]: 2, default: 1 }), log: () => {} });
  const metadataUrl = `https://${PERMIT_DOMAIN}/api/views/${PERMIT_DATASET_ID}.json`;
  const stamp = compactTimestamp(new Date());
  const meta = await captureToFile(ctx, { source: "t4-cross-check", kind: "metadata", dir, file: `metadata-${stamp}.json`, url: metadataUrl, resume: false });
  const version = String((await readJson(path.join(dir, meta.file))).rowsUpdatedAt);
  const before = `issue_date < '${nextDay(issueDateMax)}T00:00:00'`;
  const laterUrl = `${PERMIT_RESOURCE_URL}.json?${new URLSearchParams({ $select: "count(*) as n", $where: `issue_date >= '${nextDay(issueDateMax)}T00:00:00'` })}`;
  const later = await captureToFile(ctx, { source: "t4-cross-check", kind: "count", dir, file: `count-issued-after-${issueDateMax}.json`, url: laterUrl, resume: false });
  const issuedAfter = Number.parseInt((await readJson(path.join(dir, later.file)))[0]?.n ?? "NaN", 10);
  const started = performance.now();
  const results = await Promise.all(
    geoIds.map(async (geoId) => {
      const url = `${PERMIT_RESOURCE_URL}.json?${new URLSearchParams({ $select: "count(*) as n", $where: `tcad_id = '${geoId}' AND ${before}` })}`;
      const receipt = await captureToFile(ctx, { source: "t4-cross-check", kind: "count", dir, file: `count-${geoId}.json`, url, resume: false });
      const server = Number.parseInt((await readJson(path.join(dir, receipt.file)))[0]?.n ?? "NaN", 10);
      return { geo_id: geoId, server_rows: server, capture_rows: captured.get(geoId)?.rows ?? 0, ms: receipt.duration_ms };
    }),
  );
  const differs = results.filter((result) => result.server_rows !== result.capture_rows);
  const durations = results.map((result) => result.ms).sort((left, right) => left - right);
  return {
    requests: ctx.state.requests,
    dataset_version_now: version,
    capture_version: captureVersion,
    same_version: version === captureVersion,
    issued_through: issueDateMax,
    rows_issued_after_now: issuedAfter,
    geo_ids: results.length,
    equal: results.length - differs.length,
    differs,
    per_request_ms: { p50: durations[Math.floor(durations.length / 2)] ?? null, p95: durations[Math.min(durations.length - 1, Math.ceil(0.95 * durations.length) - 1)] ?? null, max: durations.at(-1) ?? null },
    elapsed_ms: Math.round(performance.now() - started),
    results,
  };
}

/**
 * Run the T4 stages for one seed.
 *
 * @param {object} options - Options.
 * @param {string} options.seedPath - Seed CSV (pilot or sample).
 * @param {string} options.label - Run label (`pilot`, `feasibility-1000`, ...).
 * @param {string | null} options.cli - elephant-cli path (null: skip the CLI stages).
 * @param {string} [options.captureDir] - Verified capture (default: newest).
 * @param {string} [options.rollSeed] - Whole-roll seed for the geo_id index.
 * @param {string | null} [options.manifestFile] - Saved lexicon manifest (default: fetch the live one).
 * @param {boolean} [options.crossCheck] - Ask Socrata for each parcel's geo_id count.
 * @param {{ permanent: Set<string>, retryable: Set<string> }} [options.drill] - Injected faults (labelled).
 * @param {string | null} [options.resumeDir] - Earlier run directory to resume.
 * @param {boolean} [options.singleCounty] - Allow the bare eligibility variable.
 * @param {string} [options.runsDir] - Runs root.
 * @param {typeof fetch} [options.fetchImpl] - Fetch for the cross-check (tests).
 * @returns {Promise<Record<string, any>>} Run record (`<run>/t4-run.json`).
 */
export async function runT4({ seedPath, label, cli, captureDir, rollSeed = DEFAULT_SEED, manifestFile = null, crossCheck = false, drill = parseFaultDrill(""), resumeDir = null, singleCounty = false, runsDir = path.join(RUNTIME_ROOT, "data", "travis", "runs"), fetchImpl = globalThis.fetch }) {
  const runStarted = performance.now();
  const startedAt = new Date();
  const policy = resolveEligibilityPolicy(process.env, { singleCounty });
  const capture = captureDir ?? (await latestCapture());
  const previous = resumeDir ? await readJson(path.join(resumeDir, "t4-run.json")) : null;
  const runDir = resumeDir ?? path.join(runsDir, `${compactTimestamp(startedAt)}-t4-${label}`);
  const attempt = (previous?.attempts?.length ?? 0) + 1;
  await mkdir(path.join(runDir, "html"), { recursive: true });
  const jobId = `travis-t4-${label}`;
  /** @type {Record<string, any>} */
  const timings = {};
  const time = async (stage, items, task) => {
    const started = performance.now();
    const result = await task();
    const ms = performance.now() - started;
    timings[stage] = { ms: round(ms), items, per_item_ms: items > 0 ? round(ms / items, 3) : null };
    return result;
  };

  // Seed.
  const seedBytes = await readFile(seedPath);
  if (!resumeDir) await writeFile(path.join(runDir, "seed.csv"), seedBytes);
  const seedRows = parseCsvRecords(seedBytes.toString("utf8"));

  // Lexicon manifest (the only request besides the optional cross-check).
  const manifestPath = path.join(runDir, "lexicon-manifest.json");
  const manifestInfo = await time("lexicon_manifest", 1, async () => {
    if (resumeDir && existsSync(manifestPath)) return { source: "resumed", url: LEXICON_MANIFEST_URL };
    if (manifestFile) {
      await copyFile(manifestFile, manifestPath);
      return { source: `file:${manifestFile}`, url: LEXICON_MANIFEST_URL };
    }
    const response = await fetch(LEXICON_MANIFEST_URL, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`lexicon manifest HTTP ${response.status}`);
    await writeFile(manifestPath, Buffer.from(await response.arrayBuffer()));
    return { source: "live", url: LEXICON_MANIFEST_URL, fetched_at: new Date().toISOString(), status: response.status };
  });
  const manifestBytes = await readFile(manifestPath);
  const lexicon = JSON.parse(manifestBytes.toString("utf8"));
  const roots = resolvePermitGroupCids(lexicon);

  // Capture verification (fail closed).
  const verified = await time("verify_capture", 1, () => verifyPermitCapture(capture));
  if (!verified.ok) throw new Error(`capture ${rel(capture)} does not verify: ${verified.mismatches.slice(0, 3).join("; ")}`);
  const captureSummary = await readJson(path.join(capture, "capture.json"));
  const asOfDate = String(captureSummary.rows_updated_at.end_iso).slice(0, 10);

  // Appraisal (T2 adapter) and its internal export.
  const appraisal = await time("appraisal_transform", seedRows.length, () => captureAndTransform({ seedRows, htmlDir: path.join(runDir, "html"), outputDir: runDir, jobId, asOfDate }));
  const reconciliation = await time("appraisal_reconcile_export", seedRows.length, () => buildReconciliationArtifacts({ outputDir: runDir, seedRows, workingDir: path.join(runDir, "reconciliation"), asOfDate }));

  // Eligibility from the transformed property.json.
  const succeeded = new Set(appraisal.results.filter((result) => result.classification === "success").map((result) => result.parcelId));
  /** @type {Map<string, any>} */
  const eligibility = new Map();
  await time("eligibility", succeeded.size, async () => {
    for (const parcelId of succeeded) {
      const property = await readJson(path.join(runDir, parcelId, "data", "property.json"));
      const decision = decideEligibility(policy, property);
      await writeFile(path.join(runDir, parcelId, "eligibility.json"), `${JSON.stringify(decision, null, 2)}\n`);
      eligibility.set(parcelId, decision);
    }
  });
  const eligible = new Set([...eligibility].filter(([, decision]) => decision.eligible).map(([parcelId]) => parcelId));

  // Roll index and the link pass (the bulk harvest by parcel). With no eligible parcel (`__NONE__`) nothing is harvested.
  const geoIdOf = new Map(seedRows.map((row) => [String(row.parcel_id).trim(), String(row.geo_id ?? "").trim()]));
  let roll = null;
  let linkPass = { summary: null, selected: new Map(), conflictingNumbers: new Set(), tcadCounts: new Map() };
  if (eligible.size > 0) {
    roll = await time("roll_index", 0, () => readRollGeoIndex(rollSeed));
    timings.roll_index.items = roll.stats.seed_rows;
    linkPass = await time("permit_link_pass", 0, () => runLinkPass({ captureDir: capture, roll, asOfDate, select: eligible, countTcadIds: new Set([...eligible].map((id) => geoIdOf.get(id)).filter(Boolean)) }));
    timings.permit_link_pass.items = linkPass.summary.rows;
  } else {
    timings.roll_index = { skipped: "no eligible parcel" };
    timings.permit_link_pass = { skipped: "no eligible parcel" };
  }

  // Permit transform per parcel.
  /** @type {Map<string, any>} */
  const states = new Map();
  const permitStage = { permits_linked: 0, permits_published: 0, conflicting: 0, identical_repeats: 0, parcels_written: 0 };
  await time("permit_transform", eligible.size, async () => {
    for (const row of seedRows) {
      const parcelId = String(row.parcel_id).trim();
      const parcelDir = path.join(runDir, parcelId);
      const statusFile = path.join(parcelDir, "permit-status.json");
      const fingerprint = { policy: policy.fingerprint, capture: captureSummary.rows_updated_at.end, permit_transform: PERMIT_TRANSFORM_VERSION };
      if (resumeDir && existsSync(statusFile)) {
        const prior = await readJson(statusFile);
        if (DONE_STATES.has(prior.status) && JSON.stringify(prior.fingerprint) === JSON.stringify(fingerprint)) {
          states.set(parcelId, { ...prior, resumed: true });
          if (prior.status === "done") {
            permitStage.permits_published += prior.permits_published;
            permitStage.parcels_written += 1;
          }
          permitStage.permits_linked += prior.permits_linked ?? 0;
          continue;
        }
      }
      const geoId = geoIdOf.get(parcelId) ?? "";
      const sharedBy = roll ? (roll.byGeoId.get(geoId)?.length ?? 0) : null;
      const captured = linkPass.tcadCounts.get(geoId) ?? { rows: 0, by_unlinked_reason: {} };
      /** @type {Record<string, any>} */
      let state;
      if (!succeeded.has(parcelId)) state = { status: "appraisal_failed" };
      else if (!eligible.has(parcelId)) state = { status: "not_eligible", reason: eligibility.get(parcelId)?.reason ?? null };
      else {
        const entries = linkPass.selected.get(parcelId) ?? [];
        try {
          if (drill.permanent.has(parcelId)) throw new Error(`fault drill: injected permanent failure for ${parcelId} (HTTP 404 class)`);
          if (drill.retryable.has(parcelId)) throw new Error(`fault drill: injected timeout for ${parcelId}`);
          const written = await writeTravisPermitTransform({ parcelDir, propId: parcelId, entries, manifest: lexicon, asOfDate, conflictingNumbers: linkPass.conflictingNumbers, dataDirName: STAGING_DIRNAME });
          if (written.dataDir) {
            const names = await readdir(written.dataDir);
            const files = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await readJson(path.join(written.dataDir, name))])));
            assertOutputContract(files, { countyCid: roots.propertyImprovementCid, seedCid: roots.seedCid });
            assertTravisIdentity({ row: { ...row, parcel_id: parcelId }, files, roots: { countyCid: roots.propertyImprovementCid, seedCid: roots.seedCid }, sourceHosts: TRAVIS_PERMIT_SOURCE_HOSTS });
            for (const name of COPIED_FROM_APPRAISAL) {
              if (sha256Hex(await readFile(path.join(written.dataDir, name))) !== sha256Hex(await readFile(path.join(parcelDir, "data", name)))) throw new Error(`${name} differs from the appraisal output`);
            }
            await rename(written.dataDir, path.join(parcelDir, PERMIT_DATA_DIRNAME));
          }
          state = { status: written.published > 0 ? "done" : "done_zero_permits", permits_linked: entries.length, permits_published: written.published, conflicting: written.conflicting, identical_repeats: written.identicalRepeats };
          permitStage.permits_linked += entries.length;
          permitStage.permits_published += written.published;
          permitStage.conflicting += written.conflicting;
          permitStage.identical_repeats += written.identicalRepeats;
          if (written.published > 0) permitStage.parcels_written += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const failureClass = classifyTravisFailure(error);
          state = { status: failureClass === "permanent" ? "failed_permanent" : "failed_retryable", error: message, failure_class: failureClass, drill: drill.permanent.has(parcelId) || drill.retryable.has(parcelId) };
          await appendFailure(runDir, `${jobId}-permits`, { parcelId, error: message, classification: failureClass, attempts: attempt, at: new Date().toISOString(), jobId: `${jobId}-permits` });
        }
      }
      state = { ...state, geo_id: geoId || null, geo_id_shared_by_accounts: sharedBy, permits_printing_geo_id: roll ? captured.rows : null, unlinked_on_geo_id: roll ? captured.by_unlinked_reason : null, fingerprint, attempt };
      await writeFile(statusFile, `${JSON.stringify(state, null, 2)}\n`);
      states.set(parcelId, state);
    }
  });

  // Per-group directories (fresh per attempt, so a resume never mixes outputs).
  const validateDir = path.join(runDir, attempt === 1 ? "validate" : `validate-r${attempt}`);
  const groupParcels = { county: [], property_improvement: [] };
  await time("assemble_groups", seedRows.length, async () => {
    for (const parcelId of succeeded) {
      const target = path.join(validateDir, GROUPS.county, parcelId);
      await mkdir(target, { recursive: true });
      new AdmZip(path.join(runDir, parcelId, "transformed.zip")).extractAllTo(target, true);
      groupParcels.county.push(parcelId);
      const permitData = path.join(runDir, parcelId, PERMIT_DATA_DIRNAME);
      if (states.get(parcelId)?.status === "done" && existsSync(permitData)) {
        const permitTarget = path.join(validateDir, GROUPS.permits, parcelId, "data");
        await mkdir(permitTarget, { recursive: true });
        for (const name of await readdir(permitData)) await copyFile(path.join(permitData, name), path.join(permitTarget, name));
        groupParcels.property_improvement.push(parcelId);
      }
    }
  });

  // elephant-cli, per group.
  /** @type {Record<string, any>} */
  const cliResults = {};
  if (cli) {
    await mkdir(path.join(validateDir, "logs"), { recursive: true });
    for (const group of [GROUPS.county, GROUPS.permits]) {
      const count = groupParcels[group].length;
      if (count === 0) {
        cliResults[group] = { skipped: "no parcel in this group" };
        continue;
      }
      const name = `travis-${group}`;
      const step = async (stage, args) => {
        const result = await runCli(cli, args, validateDir, path.join(validateDir, "logs", `${name}-${stage}.log`));
        timings[`cli_${group}_${stage}`] = { ms: round(result.ms), items: count, per_item_ms: round(result.ms / count, 3) };
        return { exit: result.code, ...parseCliOutput(result.output) };
      };
      const validate = await step("validate", ["validate", `./${group}`, "--output-csv", `./${name}-errors.csv`]);
      validate.error_rows = await errorRows(path.join(validateDir, `${name}-errors.csv`));
      const hash = await step("hash", ["hash", `./${group}`, "--output-zip", `./${name}-hashed`, "--output-csv", `${name}-hash.csv`, "--output-car", `${name}.car`]);
      const carValidate = await step("car_validate", ["validate", `${name}.car`, "--output-csv", `${name}-car-errors.csv`]);
      const exportTables = await step("export_tables", ["export-tables", `${name}.car`, "--output", `./${name}-tables`, "--part-size", "128m", "--output-json", `${name}-tables-export.json`, "--atlas-page", "./atlas-page/counties/TX/travis.json", "--county", "travis", "--state", "TX", "--fips", "48453"]);
      const carFile = path.join(validateDir, `${name}.car`);
      cliResults[group] = {
        parcels: count,
        validate,
        hash,
        car_validate: carValidate,
        export_tables: exportTables,
        car: existsSync(carFile) ? { path: rel(carFile), bytes: (await stat(carFile)).size, sha256: sha256Hex(await readFile(carFile)) } : null,
      };
    }
  }

  // Property CIDs: every Property Improvement property is the same property in the County archive.
  let cidCheck = null;
  if (cli && cliResults.county?.hash && cliResults.property_improvement?.hash) {
    const county = new Set(await propertyCids(path.join(validateDir, "travis-county-hash.csv"), roots.seedCid));
    const permits = await propertyCids(path.join(validateDir, "travis-property_improvement-hash.csv"), roots.seedCid);
    const missing = permits.filter((cid) => !county.has(cid));
    cidCheck = { county_properties: county.size, permit_properties: permits.length, permit_properties_in_county_archive: permits.length - missing.length, missing, same_property_cid: missing.length === 0 && permits.length === groupParcels.property_improvement.length };
  }

  // Optional Socrata cross-check of the bulk lookup.
  let crossCheckResult = null;
  if (crossCheck) {
    const geoIds = [...new Set([...eligible].map((id) => geoIdOf.get(id)).filter(Boolean))].sort();
    if (!linkPass.summary?.issue_date_max) throw new Error("the cross-check needs the capture's latest issue date from the link pass");
    crossCheckResult = await crossCheckSocrata({ dir: path.join(runDir, "socrata-cross-check"), geoIds, captured: linkPass.tcadCounts, captureVersion: captureSummary.rows_updated_at.end, issueDateMax: linkPass.summary.issue_date_max, fetchImpl });
    timings.socrata_cross_check = { ms: crossCheckResult.elapsed_ms, items: geoIds.length, per_item_ms: geoIds.length ? round(crossCheckResult.elapsed_ms / geoIds.length, 1) : null };
  }

  const stateCounts = {};
  for (const state of states.values()) stateCounts[state.status] = (stateCounts[state.status] ?? 0) + 1;
  const record = {
    schemaVersion: T4_RUN_VERSION,
    run_dir: rel(runDir),
    label,
    attempts: [...(previous?.attempts ?? []), { attempt, started_at: startedAt.toISOString(), finished_at: new Date().toISOString(), resumed: Boolean(resumeDir), fault_drill: { permanent: [...drill.permanent], retryable: [...drill.retryable] } }],
    seed: { path: rel(path.resolve(seedPath)), sha256: sha256Hex(seedBytes), rows: seedRows.length },
    roll_seed: roll ? { path: rel(path.resolve(rollSeed)), sha256: roll.seedSha256, rows: roll.stats.seed_rows } : { skipped: "no eligible parcel" },
    capture: { dir: rel(capture), dataset: captureSummary.dataset, rows_updated_at: captureSummary.rows_updated_at.end_iso, rows: captureSummary.rows, verified: verified.ok },
    lexicon_manifest: { ...manifestInfo, sha256: sha256Hex(manifestBytes), seed_cid: roots.seedCid, property_improvement_cid: roots.propertyImprovementCid },
    as_of_date: asOfDate,
    eligibility_policy: { variable: policy.source, value: policy.raw, mode: policy.mode, fingerprint: policy.fingerprint },
    versions: { run: T4_RUN_VERSION, permit_transform: PERMIT_TRANSFORM_VERSION, status_group: STATUS_GROUP_VERSION, work_classifier: WORK_CLASSIFIER_VERSION, tcad_id_evidence: TCAD_ID_EVIDENCE_VERSION },
    appraisal: { reconciled: appraisal.reconciled, geometry: appraisal.geometryCount, reconcile_export: { rows: reconciliation.rowCount, expected: reconciliation.expectedCount } },
    eligibility: { eligible: eligible.size, not_eligible: succeeded.size - eligible.size },
    permit_states: stateCounts,
    permits: { ...permitStage, link_pass_capture_totals: linkPass.summary ? { rows: linkPass.summary.rows, linked: linkPass.summary.linked, link_method: linkPass.summary.link_method, unlinked_reasons: linkPass.summary.unlinked_reasons } : null },
    groups: { county: groupParcels.county.length, property_improvement: groupParcels.property_improvement.length },
    cli: cliResults,
    property_cid_check: cidCheck,
    socrata_cross_check: crossCheckResult,
    parcels: Object.fromEntries([...states].map(([parcelId, state]) => [parcelId, { status: state.status, usage_type: eligibility.get(parcelId)?.usageType ?? null, permits_linked: state.permits_linked ?? 0, permits_published: state.permits_published ?? 0, geo_id_shared_by_accounts: state.geo_id_shared_by_accounts, permits_printing_geo_id: state.permits_printing_geo_id, unlinked_on_geo_id: state.unlinked_on_geo_id, error: state.error ?? null, drill: state.drill ?? false, resumed: state.resumed ?? false }])),
    timings: { unit: "ms", total_ms: round(performance.now() - runStarted), stages: timings, appraisal_stages: appraisal.timings.perStage },
    no_publication: "local files only: no upload, no pin, no Atlas PR (T6)",
  };
  await writeFile(path.join(runDir, "t4-run.json"), `${JSON.stringify(record, null, 1)}\n`);
  return record;
}

/** @param {string[]} argv @returns {Record<string, string | boolean>} */
function parseFlags(argv) {
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument ${token}`);
    const name = token.slice(2);
    if (["cross-check-socrata", "single-county", "skip-cli"].includes(name)) flags[name] = true;
    else {
      if (argv[index + 1] === undefined) throw new Error(`missing value for ${token}`);
      flags[name] = argv[index + 1];
      index += 1;
    }
  }
  return flags;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const resumeDir = typeof flags.resume === "string" ? path.resolve(flags.resume) : null;
  const previous = resumeDir ? await readJson(path.join(resumeDir, "t4-run.json")) : null;
  const seedPath = typeof flags.seed === "string" ? path.resolve(flags.seed) : resumeDir ? path.join(resumeDir, "seed.csv") : null;
  const label = typeof flags.label === "string" ? flags.label : previous?.label;
  if (!seedPath || !label) throw new Error("usage: t4-run.mjs --seed <csv> --label <name> --cli <elephant-cli> [--capture <dir>] [--roll-seed <csv>] [--manifest <file>] [--cross-check-socrata] [--fault-drill permanent:<id>,retryable:<id>] [--resume <run-dir>] [--single-county] [--skip-cli]");
  if (!flags["skip-cli"] && typeof flags.cli !== "string") throw new Error("--cli <path to elephant-cli> is required (or --skip-cli)");
  const record = await runT4({
    seedPath,
    label,
    cli: flags["skip-cli"] ? null : path.resolve(String(flags.cli)),
    captureDir: typeof flags.capture === "string" ? path.resolve(flags.capture) : undefined,
    rollSeed: typeof flags["roll-seed"] === "string" ? path.resolve(flags["roll-seed"]) : DEFAULT_SEED,
    manifestFile: typeof flags.manifest === "string" ? path.resolve(flags.manifest) : null,
    crossCheck: flags["cross-check-socrata"] === true,
    drill: parseFaultDrill(typeof flags["fault-drill"] === "string" ? flags["fault-drill"] : ""),
    resumeDir,
    singleCounty: flags["single-county"] === true,
  });
  const cli = record.cli;
  const line = (group) => (cli[group]?.validate ? `${group} validate ${cli[group].validate.processed?.succeeded}/${cli[group].validate.processed?.processed} (${cli[group].validate.error_rows} error rows), CAR ${cli[group].hash?.car?.blocks} blocks root ${cli[group].hash?.car?.root}, checks ${cli[group].car_validate?.car_validation?.passed ? "pass" : "FAIL"}, ${cli[group].export_tables?.tables?.tables} tables root ${cli[group].export_tables?.tables?.root}` : `${group} ${cli[group]?.skipped ?? "not run"}`);
  console.log(
    JSON.stringify({
      travis_t4_run: record.run_dir,
      attempt: record.attempts.length,
      seed_rows: record.seed.rows,
      appraisal: record.appraisal.reconciled,
      eligibility: record.eligibility,
      permit_states: record.permit_states,
      permits_linked: record.permits.permits_linked,
      permits_published: record.permits.permits_published,
      property_cid_check: record.property_cid_check?.same_property_cid ?? null,
      socrata_cross_check: record.socrata_cross_check ? `${record.socrata_cross_check.equal}/${record.socrata_cross_check.geo_ids} equal through ${record.socrata_cross_check.issued_through}` : null,
      total_s: round(record.timings.total_ms / 1000),
    }),
  );
  if (cli.county) console.log(line("county"));
  if (cli.property_improvement) console.log(line("property_improvement"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}
