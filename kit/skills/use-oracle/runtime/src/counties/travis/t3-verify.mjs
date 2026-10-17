#!/usr/bin/env node
/**
 * T3 window verification (assignment decisions.md section 23): offline, no request is sent. Every file the window fetch
 * recorded is checked against its receipt before anything is loaded.
 *
 *   node src/counties/travis/t3-verify.mjs [--window data/travis/t3-window] [--run <stamp>] [--out <report.json>]
 *
 * For every `receipts.jsonl` under the window directory, the latest answered receipt of each file is checked:
 *   - the file exists and its byte count and SHA-256 equal the receipt's;
 *   - a CSV capture (`page` or `file`) is recounted with the capture's own quote-aware counter and parsed in full
 *     (RFC 4180, every record as wide as the header); both counts must equal the receipt's `rows`;
 *   - a receipt whose body is HTML under a `.csv` name (a download link that served a web page) is verified for bytes and
 *     digest and classed `not_csv`: its `rows` is a newline count of a web page, never a row count;
 *   - a Socrata capture's `count.json` must equal `capture.json` `expected_rows`, the pages must sum to it, every page
 *     but the last must hold `page_size` rows, and the dataset's `rowsUpdatedAt` must be equal at start and end;
 *   - a metadata file copied into a version directory must carry the digest of the staging copy it came from;
 *   - the run record's per-source rows and bytes must equal the sums over that source's data receipts.
 *
 * Exit 0 when nothing mismatches, 1 otherwise. The report holds file names, sizes, digests and counts only.
 *
 * @module counties/travis/t3-verify
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createCsvRowCounter } from "./t3-fetch.mjs";
import { RUNTIME_ROOT, parseCsvRecordSpans } from "./t3-snapshot.mjs";
import { T3_SOURCES } from "./t3-sources.mjs";

export const VERIFIER_VERSION = "travis-t3-window-verify.v1";
const DATA_KINDS = new Set(["page", "file"]);

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const relative = (target) => {
  const rel = path.relative(RUNTIME_ROOT, path.resolve(target));
  return rel.startsWith("..") ? path.resolve(target) : rel.split(path.sep).join("/");
};

/**
 * @param {string} dir - Directory to search.
 * @returns {Promise<string[]>} Every `receipts.jsonl` below it, sorted.
 */
export async function findReceiptLogs(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await findReceiptLogs(target)));
    else if (entry.name === "receipts.jsonl") found.push(target);
  }
  return found.sort();
}

/**
 * @param {Record<string, any>} receipt - Receipt.
 * @returns {boolean} Whether the body was HTML.
 */
export const isHtmlReceipt = (receipt) => /text\/html/i.test(String(receipt.content_type ?? ""));

/**
 * Count CSV data rows two ways: the capture's quote-aware byte counter and a full RFC 4180 parse.
 *
 * @param {Buffer} bytes - File bytes.
 * @param {"rfc4180" | "unescaped-quotes"} [dialect] - CSV dialect of the source.
 * @returns {{ dialect: string, counter_rows: number, parsed_rows: number, lenient_rows: number, header_columns: number, width_mismatches: number }} Counts.
 */
export function recountCsv(bytes, dialect = "rfc4180") {
  const counter = createCsvRowCounter();
  counter.push(bytes);
  let header = null;
  let parsed = 0;
  let lenient = 0;
  let widthMismatches = 0;
  for (const record of parseCsvRecordSpans(bytes.toString("utf8"), { dialect })) {
    if (header === null) {
      header = record.fields.length;
      continue;
    }
    parsed += 1;
    if (record.lenient) lenient += 1;
    if (record.fields.length !== header) widthMismatches += 1;
  }
  return { dialect, counter_rows: counter.rows(), parsed_rows: parsed, lenient_rows: lenient, header_columns: header ?? 0, width_mismatches: widthMismatches };
}

/**
 * Verify one receipt log.
 *
 * @param {string} logPath - `receipts.jsonl`.
 * @param {{ dialect?: "rfc4180" | "unescaped-quotes" }} [options] - CSV dialect of the source.
 * @returns {Promise<{ dir: string, absDir: string, receipts: number, attempts_not_answered: number, files: Record<string, any>[], mismatches: string[] }>} Result.
 */
export async function verifyReceiptLog(logPath, { dialect = "rfc4180" } = {}) {
  const dir = path.dirname(logPath);
  const lines = (await readFile(logPath, "utf8")).split("\n").filter((line) => line.trim() !== "");
  const receipts = lines.map((line) => JSON.parse(line));
  /** @type {Map<string, Record<string, any>>} */
  const latest = new Map();
  let notAnswered = 0;
  for (const receipt of receipts) {
    if (typeof receipt.file !== "string") continue;
    if (receipt.status === null || receipt.status === undefined || receipt.retried) {
      notAnswered += 1;
      continue;
    }
    latest.set(receipt.file, receipt);
  }
  const files = [];
  const mismatches = [];
  for (const receipt of [...latest.values()].sort((left, right) => left.file.localeCompare(right.file))) {
    const target = path.join(dir, receipt.file);
    const where = `${relative(dir)}/${receipt.file}`;
    /** @type {Record<string, any>} */
    const result = { file: receipt.file, kind: receipt.kind ?? null, status: receipt.status, fetched_at: receipt.fetched_at ?? null, content_type: receipt.content_type ?? null, receipt_bytes: receipt.bytes, receipt_sha256: receipt.sha256, receipt_rows: receipt.rows ?? null };
    if (!existsSync(target)) {
      mismatches.push(`${where}: file missing`);
      files.push({ ...result, exists: false });
      continue;
    }
    const bytes = await readFile(target);
    const digest = sha256Hex(bytes);
    result.bytes = bytes.length;
    result.sha256 = digest;
    result.bytes_match = bytes.length === receipt.bytes;
    result.sha256_match = digest === receipt.sha256;
    if (!result.bytes_match) mismatches.push(`${where}: ${bytes.length} bytes, receipt says ${receipt.bytes}`);
    if (!result.sha256_match) mismatches.push(`${where}: sha256 ${digest}, receipt says ${receipt.sha256}`);
    if (receipt.status < 200 || receipt.status >= 300) result.class = "http_error_recorded";
    else if (DATA_KINDS.has(receipt.kind) && /\.csv$/i.test(receipt.file) && isHtmlReceipt(receipt)) {
      result.class = "not_csv";
      result.note = "a CSV download link served an HTML page; its receipt rows count newlines of the page, not CSV rows";
    } else if (DATA_KINDS.has(receipt.kind) && /\.csv$/i.test(receipt.file)) {
      result.class = "csv";
      Object.assign(result, recountCsv(bytes, dialect));
      result.rows_match = result.counter_rows === receipt.rows && result.parsed_rows === receipt.rows && result.width_mismatches === 0;
      if (result.counter_rows !== receipt.rows) mismatches.push(`${where}: counter recounts ${result.counter_rows} rows, receipt says ${receipt.rows}`);
      if (result.parsed_rows !== receipt.rows) mismatches.push(`${where}: full parse finds ${result.parsed_rows} rows, receipt says ${receipt.rows}`);
      if (result.width_mismatches > 0) mismatches.push(`${where}: ${result.width_mismatches} records differ in width from the header`);
    } else result.class = receipt.kind === "metadata" || /\.json$/i.test(receipt.file) ? "json" : "other";
    if (result.class === "json") {
      try {
        JSON.parse(bytes.toString("utf8"));
        result.json_parses = true;
      } catch {
        result.json_parses = false;
        mismatches.push(`${where}: does not parse as JSON`);
      }
    }
    if (typeof receipt.note === "string" && receipt.note.startsWith("copied from ")) result.copied_from = receipt.note.slice("copied from ".length);
    files.push(result);
  }
  return { dir: relative(dir), absDir: path.resolve(dir), receipts: receipts.length, attempts_not_answered: notAnswered, files, mismatches };
}

/**
 * Socrata capture checks (count, pages, version).
 *
 * @param {string} versionDir - `v<rowsUpdatedAt>` directory.
 * @param {Record<string, any>[]} files - Verified files of its receipt log.
 * @returns {Promise<{ checks: Record<string, any>, mismatches: string[] }>} Result.
 */
export async function verifySocrataCapture(versionDir, files) {
  const mismatches = [];
  const where = relative(versionDir);
  const capture = JSON.parse(await readFile(path.join(versionDir, "capture.json"), "utf8"));
  const count = Number.parseInt(JSON.parse(await readFile(path.join(versionDir, "count.json"), "utf8"))[0]?.n ?? "NaN", 10);
  const pages = files.filter((file) => file.kind === "page").sort((left, right) => left.file.localeCompare(right.file));
  const pageRows = pages.reduce((sum, page) => sum + (page.parsed_rows ?? 0), 0);
  const pageBytes = pages.reduce((sum, page) => sum + (page.bytes ?? 0), 0);
  const shortPages = pages.slice(0, -1).filter((page) => page.parsed_rows !== capture.page_size).map((page) => page.file);
  const expectedLast = capture.expected_rows - capture.page_size * (pages.length - 1);
  const checks = {
    dataset_id: capture.dataset_id,
    where: capture.where,
    count_json: count,
    expected_rows: capture.expected_rows,
    captured_rows: pageRows,
    capture_json_rows: capture.rows,
    pages: pages.length,
    capture_json_pages: capture.pages,
    page_size: capture.page_size,
    bytes: pageBytes,
    capture_json_bytes: capture.bytes,
    rows_updated_at_start: capture.rows_updated_at?.start_iso ?? null,
    rows_updated_at_end: capture.rows_updated_at?.end_iso ?? null,
    version_unchanged: capture.rows_updated_at?.start === capture.rows_updated_at?.end,
    consistent_at_capture: capture.consistent,
  };
  if (count !== capture.expected_rows) mismatches.push(`${where}: count.json ${count}, capture.json expected_rows ${capture.expected_rows}`);
  if (pageRows !== capture.expected_rows) mismatches.push(`${where}: pages hold ${pageRows} rows, expected_rows ${capture.expected_rows}`);
  if (pageRows !== capture.rows) mismatches.push(`${where}: pages hold ${pageRows} rows, capture.json rows ${capture.rows}`);
  if (pages.length !== capture.pages) mismatches.push(`${where}: ${pages.length} pages, capture.json pages ${capture.pages}`);
  if (pageBytes !== capture.bytes) mismatches.push(`${where}: pages hold ${pageBytes} bytes, capture.json bytes ${capture.bytes}`);
  if (shortPages.length > 0) mismatches.push(`${where}: pages other than the last hold fewer than page_size rows: ${shortPages.join(", ")}`);
  if (pages.length > 0 && pages.at(-1).parsed_rows !== expectedLast) mismatches.push(`${where}: last page holds ${pages.at(-1).parsed_rows} rows, expected ${expectedLast}`);
  if (!checks.version_unchanged) mismatches.push(`${where}: rowsUpdatedAt changed during the capture`);
  if (!capture.consistent) mismatches.push(`${where}: capture.json says inconsistent`);
  return { checks, mismatches };
}

/**
 * Verify the whole window directory against its receipts and one run record.
 *
 * @param {object} params - Parameters.
 * @param {string} params.windowDir - Window directory (`data/travis/t3-window`).
 * @param {string} params.runStamp - Run record stamp under `<window>/runs/`.
 * @returns {Promise<Record<string, any>>} Report (`ok` true when nothing mismatches).
 */
export async function verifyWindow({ windowDir, runStamp }) {
  const run = JSON.parse(await readFile(path.join(windowDir, "runs", `${runStamp}.json`), "utf8"));
  const logs = (await findReceiptLogs(windowDir)).filter((log) => !log.includes(`${path.sep}runs${path.sep}`));
  const mismatches = [];
  const verifiedLogs = [];
  /** @type {Map<string, Record<string, any>>} */
  const digestByPath = new Map();
  for (const log of logs) {
    const sourceKey = path.relative(windowDir, log).split(path.sep)[0];
    const result = await verifyReceiptLog(log, { dialect: T3_SOURCES[sourceKey]?.csvDialect ?? "rfc4180" });
    mismatches.push(...result.mismatches);
    verifiedLogs.push(result);
    for (const file of result.files) digestByPath.set(`${result.dir}/${file.file}`, file);
  }
  // Metadata copied from the staging directory into the version directory: same digest.
  for (const result of verifiedLogs) {
    for (const file of result.files) {
      if (!file.copied_from) continue;
      // The note names the staging copy relative to the source directory (the version directory's parent).
      const staging = digestByPath.get(`${path.posix.dirname(result.dir)}/${file.copied_from}`);
      file.copy_matches_staging = staging ? staging.sha256 === file.sha256 : null;
      if (!staging) mismatches.push(`${result.dir}/${file.file}: staging copy ${file.copied_from} not found`);
      else if (staging.sha256 !== file.sha256) mismatches.push(`${result.dir}/${file.file}: differs from its staging copy ${file.copied_from}`);
    }
  }
  const sources = [];
  for (const source of run.sources) {
    const sourceDir = path.join(windowDir, source.key);
    const sourceLogs = verifiedLogs.filter((result) => result.absDir === path.resolve(sourceDir) || result.absDir.startsWith(`${path.resolve(sourceDir)}${path.sep}`));
    // The files this run recorded: a Socrata version directory's pages, the files the run names, or (a probe) the
    // receipts fetched during the run. Earlier captures in the same directory are verified above but not summed here.
    const captureDir = typeof source.detail?.capture === "string" ? path.resolve(RUNTIME_ROOT, source.detail.capture) : null;
    const named = new Set([...(Array.isArray(source.detail?.files) ? source.detail.files.map((entry) => entry.file) : []), ...(typeof source.detail?.file === "string" ? [source.detail.file] : [])]);
    const inRun = (file) => file.fetched_at >= run.started_at && file.fetched_at <= run.finished_at;
    const runLogs = captureDir ? sourceLogs.filter((result) => result.absDir === captureDir) : sourceLogs;
    const socrataCapture = captureDir !== null && existsSync(path.join(captureDir, "capture.json"));
    const dataFiles = runLogs.flatMap((result) =>
      result.files.filter((file) => (DATA_KINDS.has(file.kind) || file.kind === "probe") && (socrataCapture || captureDir === null || (named.size > 0 ? named.has(file.file) : inRun(file)))),
    );
    const csvFiles = dataFiles.filter((file) => file.class === "csv");
    const rows = csvFiles.reduce((sum, file) => sum + file.parsed_rows, 0);
    const bytes = dataFiles.reduce((sum, file) => sum + (file.bytes ?? 0), 0);
    /** @type {Record<string, any>} */
    const summary = {
      key: source.key,
      run_status: source.status,
      receipt_logs: sourceLogs.map((result) => result.dir),
      run_capture: captureDir ? relative(captureDir) : null,
      files_verified: sourceLogs.reduce((sum, result) => sum + result.files.length, 0),
      data_files: dataFiles.length,
      csv_files: csvFiles.length,
      not_csv_files: dataFiles.filter((file) => file.class === "not_csv").map((file) => file.file),
      rows_parsed: rows,
      bytes,
      run_record_rows: source.rows,
      run_record_bytes: source.bytes,
      attempts_not_answered: sourceLogs.reduce((sum, result) => sum + result.attempts_not_answered, 0),
    };
    if (source.status === "ok") {
      if (source.rows !== null && source.rows !== rows) mismatches.push(`${source.key}: run record rows ${source.rows}, receipts parse to ${rows}`);
      if (source.bytes !== null && source.bytes !== bytes) mismatches.push(`${source.key}: run record bytes ${source.bytes}, receipts hold ${bytes}`);
      summary.run_record_matches = (source.rows === null || source.rows === rows) && (source.bytes === null || source.bytes === bytes);
    } else {
      // A failed source: its bytes are verified as evidence; its rows are not CSV rows.
      summary.run_record_matches = source.bytes === null || source.bytes === bytes;
      if (!summary.run_record_matches) mismatches.push(`${source.key}: run record bytes ${source.bytes}, receipts hold ${bytes}`);
      summary.failed_detail = source.detail?.error ?? null;
    }
    const versionLogs = sourceLogs.filter((result) => existsSync(path.join(result.absDir, "capture.json")));
    if (versionLogs.length > 0) {
      summary.socrata = [];
      for (const { absDir: versionDir, files } of versionLogs) {
        const checked = await verifySocrataCapture(versionDir, files);
        mismatches.push(...checked.mismatches);
        summary.socrata.push({ capture: relative(versionDir), ...checked.checks, mismatches: checked.mismatches.length });
      }
    }
    if (Array.isArray(source.detail?.files)) {
      summary.files = source.detail.files.map((entry) => {
        const file = csvFiles.find((candidate) => candidate.file === entry.file);
        const match = file !== undefined && file.parsed_rows === entry.rows && file.bytes === entry.bytes;
        if (!match) mismatches.push(`${source.key}/${entry.file}: run record ${entry.rows} rows ${entry.bytes} bytes, receipts ${file?.parsed_rows} rows ${file?.bytes} bytes`);
        return { file: entry.file, link_text: entry.link_text, rows: file?.parsed_rows ?? null, bytes: file?.bytes ?? null, sha256: file?.sha256 ?? null, last_modified: entry.last_modified, matches_run_record: match };
      });
    }
    sources.push(summary);
  }
  const allFiles = verifiedLogs.flatMap((result) => result.files);
  return {
    kind: "travis-t3-window-verify",
    verifier_version: VERIFIER_VERSION,
    verified_at: new Date().toISOString(),
    window: relative(windowDir),
    run_record: `${relative(windowDir)}/runs/${runStamp}.json`,
    run: { started_at: run.started_at, finished_at: run.finished_at, seconds: run.seconds, egress: run.egress, egress_checks: run.egress_checks, requests: run.requests, counts: run.counts, exit_code: run.exit_code },
    totals: {
      receipt_logs: verifiedLogs.length,
      receipts: verifiedLogs.reduce((sum, result) => sum + result.receipts, 0),
      files_verified: allFiles.length,
      bytes_verified: allFiles.reduce((sum, file) => sum + (file.bytes ?? 0), 0),
      csv_files: allFiles.filter((file) => file.class === "csv").length,
      csv_rows_parsed: allFiles.filter((file) => file.class === "csv").reduce((sum, file) => sum + file.parsed_rows, 0),
      not_csv_files: allFiles.filter((file) => file.class === "not_csv").length,
      attempts_not_answered: verifiedLogs.reduce((sum, result) => sum + result.attempts_not_answered, 0),
    },
    sources,
    receipt_logs: verifiedLogs.map((result) => ({ dir: result.dir, receipts: result.receipts, attempts_not_answered: result.attempts_not_answered, files: result.files })),
    mismatches,
    ok: mismatches.length === 0,
  };
}

/** @param {string[]} argv @returns {Record<string, string>} */
function parseFlags(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument ${token}`);
    flags[token.slice(2)] = argv[index + 1];
    index += 1;
  }
  return flags;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const windowDir = path.resolve(flags.window ?? path.join(RUNTIME_ROOT, "data", "travis", "t3-window"));
  let runStamp = flags.run;
  if (!runStamp) {
    // The latest run that sent requests.
    const runs = (await readdir(path.join(windowDir, "runs"))).filter((name) => name.endsWith(".json")).sort();
    for (const name of runs.reverse()) {
      const record = JSON.parse(await readFile(path.join(windowDir, "runs", name), "utf8"));
      if (record.requests > 0) {
        runStamp = name.replace(/\.json$/, "");
        break;
      }
    }
  }
  if (!runStamp) throw new Error(`no run record with requests under ${windowDir}/runs`);
  const report = await verifyWindow({ windowDir, runStamp });
  if (flags.out) await writeFile(path.resolve(flags.out), `${JSON.stringify(report, null, 1)}\n`);
  for (const source of report.sources) {
    console.log(`[${source.key}] ${source.run_status}: ${source.files_verified} files verified, ${source.rows_parsed.toLocaleString("en-US")} CSV rows, ${(source.bytes / 1e6).toFixed(1)} MB${source.not_csv_files.length ? `, not CSV: ${source.not_csv_files.join(", ")}` : ""}; run record ${source.run_record_matches ? "matches" : "DIFFERS"}`);
  }
  console.log(`t3-verify: ${report.ok ? "OK" : `${report.mismatches.length} MISMATCHES`}; ${report.totals.files_verified} files, ${report.totals.receipts} receipts, ${report.totals.csv_rows_parsed.toLocaleString("en-US")} CSV rows, ${(report.totals.bytes_verified / 1e6).toFixed(1)} MB; run ${runStamp}`);
  for (const mismatch of report.mismatches) console.log(`  mismatch: ${mismatch}`);
  process.exit(report.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
