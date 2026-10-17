#!/usr/bin/env node
/**
 * T3 offline load (assignment decisions.md section 23): turns the verified US-window captures into the private
 * snapshots of the registry and licensing tracks. No request is sent. Every step is idempotent: run it again and every
 * snapshot reports 0 new, 0 changed, 0 removed, rewrites nothing and leaves its watermark byte-identical.
 *
 *   node --max-old-space-size=16384 src/counties/travis/t3-load.mjs [--only step,step] [--now <iso>] [--window <dir>]
 *
 * Steps, in order (the single writer of each track):
 *   franchise-statewide  9cir-efmm statewide capture -> registry `tx-comptroller-franchise-tax-statewide` (the private
 *                        matching universe)
 *   franchise-travis     the Travis rows of the same capture (taxpayer_county_code 227) -> registry
 *                        `tx-comptroller-franchise-tax-travis`, diffed against the snapshot on disk (the 2026-10-16
 *                        Travis cache on the first run): new, changed and tombstoned taxpayers, and where the tombstoned
 *                        ones went (another county in the statewide file, or gone from the file)
 *   sales-tax            jrea-zgmq Travis outlets (outlet_county_code 227) -> registry `tx-comptroller-sales-tax-travis`
 *                        under the privacy rule `travis-t3-privacy.v1` (no sole owner's taxpayer number is stored)
 *   veteran              2vfr-72e4 statewide -> registry `tx-sos-veteran-owned-business`
 *   veteran-join         veteran rows joined to the franchise statewide rows by SOS file number
 *                        (`travis-sos-file-number-join.v1`); the Travis subset is the rows joined to a Travis taxpayer
 *   tdlr                 the TDLR electrical and A/C license files -> licensing `tdlr-license-files` (column set
 *                        `tdlr-licfile-columns.v1`), with each license type's permit role (`tdlr-permit-role.v1`)
 *   tsbpe                the TSBPE Responsible Master Plumber CSV -> licensing `tsbpe-responsible-master-plumber`,
 *                        columns resolved from its header; until a CSV capture exists the step reports
 *                        `awaiting_capture` (the HTML page saved by the 2026-10-17 run is set aside, never loaded)
 *   name-index           the matcher's normalized-name index of every loaded snapshot -> `data/travis/matcher/`
 *                        (`travis-exact-unique-normalized-name.v1`; the franchise index is statewide), with collision
 *                        counts statewide and for Travis
 *
 * Prints one line per step and writes `data/travis/t3-loads/<stamp>.json` (counts and digests only).
 *
 * @module counties/travis/t3-load
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ParquetReader } from "@dsnp/parquetjs";

import { joinVeteranToFranchise } from "./t3-join.mjs";
import { NAME_INDEXES, buildAndWriteIndex } from "./t3-name-index.mjs";
import { RUNTIME_ROOT, entityKeyOf, loadSnapshot, selectCaptureReceipts } from "./t3-snapshot.mjs";
import { TDLR_PERMIT_ROLE_VERSION, TRAVIS_COMPTROLLER_COUNTY_CODE, getT3Source, tdlrPermitRole } from "./t3-sources.mjs";

export const DEFAULT_WINDOW = path.join(RUNTIME_ROOT, "data", "travis", "t3-window");
export const REGISTRY_DIR = path.join(RUNTIME_ROOT, "data", "travis", "registry");
export const LICENSING_DIR = path.join(RUNTIME_ROOT, "data", "travis", "licensing");
export const LOADS_DIR = path.join(RUNTIME_ROOT, "data", "travis", "t3-loads");
export const MATCHER_DIR = path.join(RUNTIME_ROOT, "data", "travis", "matcher");

export const TRAVIS_FRANCHISE_FILTER = Object.freeze({
  label: `taxpayer_county_code = ${TRAVIS_COMPTROLLER_COUNTY_CODE} (Travis, the taxpayer's mailing county)`,
  /** @param {Record<string, any>} row */
  test: (row) => row.taxpayer_county_code__trimmed === TRAVIS_COMPTROLLER_COUNTY_CODE,
});

const relative = (target) => path.relative(RUNTIME_ROOT, path.resolve(target)).split(path.sep).join("/");

/**
 * The newest consistent Socrata capture of a source (`v<rowsUpdatedAt>` directory with a consistent `capture.json`).
 *
 * @param {string} windowDir - Window directory.
 * @param {string} sourceKey - Source key.
 * @returns {Promise<{ dir: string, capture: Record<string, any> }>} Capture directory and its summary.
 */
export async function latestSocrataCapture(windowDir, sourceKey) {
  const base = path.join(windowDir, sourceKey);
  if (!existsSync(base)) throw new Error(`${relative(base)}: no capture (run the window fetch)`);
  const candidates = [];
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^v\d+$/.test(entry.name)) continue;
    const file = path.join(base, entry.name, "capture.json");
    if (!existsSync(file)) continue;
    const capture = JSON.parse(await readFile(file, "utf8"));
    if (capture.consistent) candidates.push({ dir: path.join(base, entry.name), capture, version: Number(entry.name.slice(1)) });
  }
  if (candidates.length === 0) throw new Error(`${relative(base)}: no consistent capture`);
  candidates.sort((left, right) => right.version - left.version);
  return { dir: candidates[0].dir, capture: candidates[0].capture };
}

/**
 * Entity key and scope of every row of a snapshot.
 *
 * @param {string} sourceKey - Source key.
 * @param {string} parquetPath - Snapshot.
 * @returns {Promise<Map<string, Set<string>>>} Key to the scopes its rows carry.
 */
export async function readKeyScopes(sourceKey, parquetPath) {
  const source = getT3Source(sourceKey);
  /** @type {Map<string, Set<string>>} */
  const scopes = new Map();
  const reader = await ParquetReader.openFile(parquetPath);
  try {
    const schemaFields = Object.keys(reader.getSchema().fields);
    const projection = schemaFields.filter((field) => field.endsWith("__trimmed") || field === "_row_sha256").map((field) => [field]);
    const cursor = reader.getCursor(projection);
    let record = await cursor.next();
    while (record) {
      const key = entityKeyOf(source, /** @type {Record<string, unknown>} */ (record));
      const set = scopes.get(key) ?? new Set();
      set.add(source.scopeOf(/** @type {Record<string, unknown>} */ (record)));
      scopes.set(key, set);
      record = await cursor.next();
    }
  } finally {
    await reader.close();
  }
  return scopes;
}

/**
 * Tombstones written by one merge.
 *
 * @param {string} outputDir - Track directory.
 * @param {string} name - Snapshot name.
 * @param {string} removedAt - Merge time.
 * @returns {Promise<string[]>} Tombstoned keys.
 */
export async function tombstonesOf(outputDir, name, removedAt) {
  const file = path.join(outputDir, `${name}.tombstones.jsonl`);
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.removed_at === removedAt)
    .map((entry) => entry.key);
}

/**
 * The newest dated capture directory of a file source (`d<YYYYMMDD>`) that holds a CSV receipt (HTML set aside).
 *
 * @param {string} windowDir - Window directory.
 * @param {string} sourceKey - Source key.
 * @returns {Promise<{ dir: string | null, set_aside: Record<string, any>[] }>} Directory (null when none) and what was set aside.
 */
export async function latestFileCapture(windowDir, sourceKey) {
  const base = path.join(windowDir, sourceKey);
  const setAside = [];
  if (!existsSync(base)) return { dir: null, set_aside: setAside };
  const dirs = (await readdir(base, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^d\d{8}$/.test(entry.name)).map((entry) => entry.name).sort().reverse();
  for (const name of dirs) {
    const dir = path.join(base, name);
    if (!existsSync(path.join(dir, "receipts.jsonl"))) continue;
    const selection = await selectCaptureReceipts(dir);
    setAside.push(...selection.excluded.map((entry) => ({ ...entry, dir: relative(dir) })));
    if (selection.receipts.length > 0) return { dir, set_aside: setAside };
  }
  return { dir: null, set_aside: setAside };
}

/**
 * License summary of a licensing snapshot: licenses by permit role and type, Travis business-county counts, how the
 * published lists overlap, and keys whose rows differ between lists (counts only).
 *
 * @param {string} parquetPath - Snapshot.
 * @param {string} sourceKey - Source key (`tdlr-license-files`).
 * @returns {Promise<Record<string, any>>} Summary.
 */
export async function summarizeTdlrSnapshot(parquetPath, sourceKey) {
  const source = getT3Source(sourceKey);
  /** @type {Map<string, { type: string, travis: boolean, files: Set<string>, hashes: Set<string> }>} */
  const licenses = new Map();
  const reader = await ParquetReader.openFile(parquetPath);
  try {
    const cursor = reader.getCursor([["license_type__trimmed"], ["license_subtype__trimmed"], ["license_number__trimmed"], ["business_county__trimmed"], ["business_name__trimmed"], ["_capture_file"], ["_row_sha256"]]);
    let record = await cursor.next();
    while (record) {
      const key = entityKeyOf(source, /** @type {Record<string, unknown>} */ (record));
      const entry = licenses.get(key) ?? { type: String(record.license_type__trimmed ?? ""), travis: false, business: false, files: new Set(), hashes: new Set() };
      if (String(record.business_county__trimmed ?? "").toUpperCase() === "TRAVIS") entry.travis = true;
      if (record.business_name__trimmed) entry.business = true;
      entry.files.add(String(record._capture_file));
      entry.hashes.add(String(record._row_sha256));
      licenses.set(key, entry);
      record = await cursor.next();
    }
  } finally {
    await reader.close();
  }
  /** @type {Record<string, { licenses: number, travis_business_county: number }>} */
  const byRole = {};
  /** @type {Record<string, { role: string, licenses: number, travis_business_county: number }>} */
  const byType = {};
  /** @type {Record<string, number>} */
  const onlyInFile = {};
  let inSeveral = 0;
  let differing = 0;
  for (const entry of licenses.values()) {
    const role = tdlrPermitRole(entry.type);
    byRole[role] ??= { licenses: 0, travis_business_county: 0 };
    byRole[role].licenses += 1;
    if (entry.travis) byRole[role].travis_business_county += 1;
    byType[entry.type] ??= { role, licenses: 0, travis_business_county: 0 };
    byType[entry.type].licenses += 1;
    if (entry.travis) byType[entry.type].travis_business_county += 1;
    if (entry.files.size > 1) inSeveral += 1;
    else {
      const [file] = entry.files;
      onlyInFile[file] = (onlyInFile[file] ?? 0) + 1;
    }
    if (entry.hashes.size > 1) differing += 1;
  }
  const sortObject = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
  return {
    permit_role_version: TDLR_PERMIT_ROLE_VERSION,
    licenses: licenses.size,
    licenses_in_several_lists: inSeveral,
    licenses_with_differing_rows_between_lists: differing,
    licenses_only_in_one_list: sortObject(onlyInFile),
    by_role: sortObject(byRole),
    by_type: sortObject(byType),
  };
}

/** @typedef {{ windowDir: string, registryDir: string, licensingDir: string, matcherDir: string, now: string, log: (line: string) => void, results: Record<string, any> }} LoadContext */

/** @type {Record<string, (ctx: LoadContext) => Promise<Record<string, any>>>} */
export const STEPS = {
  async "franchise-statewide"(ctx) {
    const { dir, capture } = await latestSocrataCapture(ctx.windowDir, "tx-comptroller-franchise-tax");
    const report = await loadSnapshot({
      sourceKey: "tx-comptroller-franchise-tax",
      captureDir: dir,
      outputDir: ctx.registryDir,
      name: "tx-comptroller-franchise-tax-statewide",
      scopeLabel: `statewide (the private matching universe), capture of ${capture.rows_updated_at?.end_iso ?? "unknown"} under US egress`,
      duplicateDetailLimit: 200,
      now: ctx.now,
    });
    return { report, freshness: { rows_updated_at: capture.rows_updated_at?.end_iso ?? null, expected_rows: capture.expected_rows, started_at: capture.started_at, finished_at: capture.finished_at } };
  },

  async "franchise-travis"(ctx) {
    const { dir, capture } = await latestSocrataCapture(ctx.windowDir, "tx-comptroller-franchise-tax");
    const name = "tx-comptroller-franchise-tax-travis";
    const report = await loadSnapshot({
      sourceKey: "tx-comptroller-franchise-tax",
      captureDir: dir,
      outputDir: ctx.registryDir,
      name,
      scopeLabel: `Travis: taxpayer_county_code ${TRAVIS_COMPTROLLER_COUNTY_CODE} (the taxpayer's mailing-address county), derived from the statewide capture of ${capture.rows_updated_at?.end_iso ?? "unknown"} under US egress`,
      rowFilter: TRAVIS_FRANCHISE_FILTER,
      now: ctx.now,
    });
    // Where the tombstoned Travis taxpayers went: another county of the statewide file, or out of the file.
    let tombstonedWhere = null;
    if (report.merged && report.diff.tombstoned > 0) {
      const statewide = path.join(ctx.registryDir, "tx-comptroller-franchise-tax-statewide.parquet");
      if (existsSync(statewide)) {
        const scopes = await readKeyScopes("tx-comptroller-franchise-tax", statewide);
        const keys = await tombstonesOf(ctx.registryDir, name, ctx.now);
        tombstonedWhere = { tombstoned: keys.length, in_statewide_file_other_county: 0, in_statewide_file_travis: 0, not_in_statewide_file: 0 };
        for (const key of keys) {
          const scope = scopes.get(key);
          if (!scope) tombstonedWhere.not_in_statewide_file += 1;
          else if (scope.has("travis")) tombstonedWhere.in_statewide_file_travis += 1;
          else tombstonedWhere.in_statewide_file_other_county += 1;
        }
      }
    }
    return { report, tombstoned_where: tombstonedWhere };
  },

  async "sales-tax"(ctx) {
    const { dir, capture } = await latestSocrataCapture(ctx.windowDir, "tx-comptroller-sales-tax");
    const report = await loadSnapshot({
      sourceKey: "tx-comptroller-sales-tax",
      captureDir: dir,
      outputDir: ctx.registryDir,
      name: "tx-comptroller-sales-tax-travis",
      scopeLabel: `Travis outlets: ${capture.where ?? "outlet_county_code 227"} (the outlet's county), capture of ${capture.rows_updated_at?.end_iso ?? "unknown"} under US egress`,
      now: ctx.now,
    });
    return { report, freshness: { rows_updated_at: capture.rows_updated_at?.end_iso ?? null, expected_rows: capture.expected_rows, where: capture.where ?? null } };
  },

  async veteran(ctx) {
    const { dir, capture } = await latestSocrataCapture(ctx.windowDir, "tx-sos-veteran-owned-business");
    const report = await loadSnapshot({
      sourceKey: "tx-sos-veteran-owned-business",
      captureDir: dir,
      outputDir: ctx.registryDir,
      name: "tx-sos-veteran-owned-business",
      scopeLabel: `statewide; the Travis subset is the rows joined to a Travis franchise row by SOS file number; capture of dataset version ${capture.rows_updated_at?.end_iso ?? "unknown"} under US egress`,
      now: ctx.now,
    });
    return { report, freshness: { rows_updated_at: capture.rows_updated_at?.end_iso ?? null, expected_rows: capture.expected_rows } };
  },

  async "veteran-join"(ctx) {
    const veteranParquet = path.join(ctx.registryDir, "tx-sos-veteran-owned-business.parquet");
    const franchiseParquet = path.join(ctx.registryDir, "tx-comptroller-franchise-tax-statewide.parquet");
    for (const file of [veteranParquet, franchiseParquet]) if (!existsSync(file)) throw new Error(`${relative(file)} missing: run the veteran and franchise-statewide steps first`);
    const join = await joinVeteranToFranchise({ veteranParquet, franchiseParquet, outputPath: path.join(ctx.registryDir, "tx-sos-veteran-owned-business.franchise-join.parquet") });
    await writeFile(path.join(ctx.registryDir, "tx-sos-veteran-owned-business.franchise-join.report.json"), `${JSON.stringify(join, null, 1)}\n`);
    return { join, status: join.output.written ? "written" : "unchanged", detail: `${join.counts.matched} of ${join.counts.veteran_rows} veteran rows joined (Travis ${join.travis_subset}); exact printed values equal ${join.counts.printed_values_equal}; taxid agrees ${join.counts.taxid_agrees}, differs ${join.counts.taxid_differs}, blank ${join.counts.taxid_blank}` };
  },

  async tdlr(ctx) {
    const { dir, set_aside: setAside } = await latestFileCapture(ctx.windowDir, "tdlr-license-files");
    if (!dir) throw new Error("tdlr-license-files: no CSV capture under the window directory (run the window fetch)");
    const report = await loadSnapshot({
      sourceKey: "tdlr-license-files",
      captureDir: dir,
      outputDir: ctx.licensingDir,
      name: "tdlr-license-files",
      scopeLabel: `statewide electrical and air conditioning/refrigeration license files of ${path.basename(dir).slice(1)} (tdlr.texas.gov, under US egress); scope travis = business county TRAVIS`,
      duplicateDetailLimit: 0,
      now: ctx.now,
    });
    const licenses = await summarizeTdlrSnapshot(path.join(ctx.licensingDir, "tdlr-license-files.parquet"), "tdlr-license-files");
    return { report, licenses, set_aside: setAside };
  },

  async tsbpe(ctx) {
    const { dir, set_aside: setAside } = await latestFileCapture(ctx.windowDir, "tsbpe-responsible-master-plumber");
    if (!dir) {
      return {
        status: "awaiting_capture",
        set_aside: setAside,
        detail: `no CSV capture yet${setAside.length > 0 ? ` (set aside: ${setAside.map((entry) => `${entry.dir}/${entry.file} ${entry.reason}`).join(", ")})` : ""}; run the window command node src/counties/travis/t3-vpn-fetch.mjs --only tsbpe-responsible-master-plumber under US egress, then this step again`,
      };
    }
    const report = await loadSnapshot({
      sourceKey: "tsbpe-responsible-master-plumber",
      captureDir: dir,
      outputDir: ctx.licensingDir,
      name: "tsbpe-responsible-master-plumber",
      scopeLabel: `statewide Responsible Master Plumber list of ${path.basename(dir).slice(1)} (tsbpe.texas.gov, under US egress)`,
      duplicateDetailLimit: 0,
      now: ctx.now,
    });
    return { report, set_aside: setAside };
  },

  async "name-index"(ctx) {
    const indexes = {};
    const missing = [];
    for (const spec of NAME_INDEXES) {
      const built = await buildAndWriteIndex(spec, { registryDir: ctx.registryDir, licensingDir: ctx.licensingDir, matcherDir: ctx.matcherDir });
      if (built) indexes[spec.name] = built;
      else missing.push(spec.name);
    }
    const all = Object.values(indexes);
    return {
      indexes,
      missing,
      index: { output: { unchanged: all.every((built) => built.output.unchanged) } },
      status: all.every((built) => built.output.unchanged) ? "unchanged" : "written",
      detail: `${all.length} indexes${missing.length ? `, not yet built (no snapshot): ${missing.join(", ")}` : ""}; ${all.map((built) => `${built.index} ${built.universe.non_unique_names} non-unique of ${built.universe.normalized_names}`).join("; ")}`,
    };
  },
};

export const STEP_ORDER = Object.freeze(Object.keys(STEPS));

/**
 * One line per step.
 *
 * @param {string} step - Step name.
 * @param {Record<string, any>} result - Step result.
 * @returns {string} Progress line.
 */
export function stepLine(step, result) {
  const report = result.report;
  if (!report) return `[${step}] ${result.status ?? "done"}${result.detail ? ` (${result.detail})` : ""}`;
  const diff = report.diff;
  return `[${step}] ${report.counts.rows.toLocaleString("en-US")} rows, ${report.counts.distinct_keys.toLocaleString("en-US")} keys; diff new ${diff.new}, changed ${diff.changed}, unchanged ${diff.unchanged}, removed ${diff.removed}; ${report.merged ? `merged (${report.merge_reason})` : "no-op"}; snapshot ${report.snapshot.sha256.slice(0, 12)}; ${report.duration_seconds}s`;
}

/**
 * Run the load steps.
 *
 * @param {object} [options] - Options.
 * @param {string[]} [options.only] - Steps (default: all, in order).
 * @param {string} [options.now] - Merge time (ISO).
 * @param {string} [options.windowDir] - Window directory.
 * @param {string} [options.registryDir] - Registry track directory.
 * @param {string} [options.licensingDir] - Licensing track directory.
 * @param {string} [options.matcherDir] - Name index directory.
 * @param {string | null} [options.loadsDir] - Where the run summary goes (null: not written).
 * @param {(line: string) => void} [options.log] - Progress output.
 * @returns {Promise<Record<string, any>>} Summary.
 */
export async function runLoad({ only = [...STEP_ORDER], now = new Date().toISOString(), windowDir = DEFAULT_WINDOW, registryDir = REGISTRY_DIR, licensingDir = LICENSING_DIR, matcherDir = path.join(path.dirname(registryDir), "matcher"), loadsDir = LOADS_DIR, log = (line) => console.log(line) } = {}) {
  const unknown = only.filter((step) => !STEPS[step]);
  if (unknown.length > 0) throw new Error(`unknown step ${unknown.join(", ")}; known: ${STEP_ORDER.join(", ")}`);
  const ctx = { windowDir, registryDir, licensingDir, matcherDir, now, log, results: {} };
  const started = Date.now();
  for (const step of STEP_ORDER.filter((name) => only.includes(name))) {
    const result = await STEPS[step](ctx);
    ctx.results[step] = result;
    log(stepLine(step, result));
  }
  const reports = Object.values(ctx.results).map((result) => result.report).filter(Boolean);
  const derived = Object.values(ctx.results).map((result) => result.join ?? result.index ?? null).filter(Boolean);
  const awaiting = Object.entries(ctx.results).filter(([, result]) => result.status === "awaiting_capture").map(([step]) => step);
  const summary = {
    kind: "travis-t3-load",
    loaded_at: now,
    seconds: (Date.now() - started) / 1000,
    awaiting_capture: awaiting,
    steps: ctx.results,
    all_no_op: reports.every((report) => !report.merged && report.diff.new === 0 && report.diff.changed === 0 && report.diff.removed === 0 && report.rebuild_matches_snapshot) && derived.every((artifact) => artifact.output.unchanged),
  };
  if (loadsDir) {
    await mkdir(loadsDir, { recursive: true });
    const stamp = now.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    await writeFile(path.join(loadsDir, `${stamp}.json`), `${JSON.stringify(summary, null, 1)}\n`);
    summary.record = relative(path.join(loadsDir, `${stamp}.json`));
  }
  log(`t3-load: ${Object.keys(ctx.results).length} steps; ${summary.all_no_op ? "all no-op (0 new, 0 changed, 0 removed; identical bytes)" : "merged where the capture changed"}${awaiting.length ? `; awaiting capture: ${awaiting.join(", ")}` : ""}; ${summary.seconds.toFixed(1)}s${summary.record ? `; record ${summary.record}` : ""}`);
  return summary;
}

/** @param {string[]} argv @returns {Record<string, any>} Options. */
export function parseArgs(argv) {
  /** @type {Record<string, any>} */
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--only") options.only = argv[(index += 1)].split(",").map((step) => step.trim()).filter(Boolean);
    else if (flag === "--now") options.now = argv[(index += 1)];
    else if (flag === "--window") options.windowDir = path.resolve(argv[(index += 1)]);
    else throw new Error(`unknown argument ${flag}`);
  }
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runLoad(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
}
