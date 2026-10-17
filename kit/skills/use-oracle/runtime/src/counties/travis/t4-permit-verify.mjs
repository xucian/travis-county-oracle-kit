#!/usr/bin/env node
/**
 * T4 permit capture verification: offline, no request is sent. A capture of the Austin export is checked against its
 * own receipts before anything reads it.
 *
 *   node src/counties/travis/t4-permit-verify.mjs [--capture data/travis/permits/v<rowsUpdatedAt>] [--out <report.json>]
 *
 * Without `--capture` the newest `v*` directory under `data/travis/permits` is verified. Checks:
 *   - every file's bytes and SHA-256 equal its latest answered receipt; every partition CSV is recounted with the
 *     capture's quote-aware counter and parsed in full (RFC 4180, every record as wide as the header), and both counts
 *     equal the receipt's `rows` (the T3 receipt verifier, `t3-verify.mjs#verifyReceiptLog`);
 *   - every partition's rows equal its planned count, the plan's total equals `count(*)`, and the partitions sum to it;
 *   - every planned partition (or each month of a split one) has exactly one CSV, and no CSV is outside the plan;
 *   - every header equals the versioned column set, so no applicant field and no rolling flag is in the capture;
 *   - the dataset's `rowsUpdatedAt` is equal at the start and the end, and `capture.json` agrees with the files.
 *
 * Exit 0 when nothing mismatches, 1 otherwise. The report holds file names, sizes, digests and counts only.
 *
 * @module counties/travis/t4-permit-verify
 */
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { RUNTIME_ROOT, parseCsvRecordSpans } from "./t3-snapshot.mjs";
import { verifyReceiptLog } from "./t3-verify.mjs";
import { DEFAULT_OUT, NOT_COLLECTED_PERSONAL, NOT_COLLECTED_ROLLING, PAGE_LIMIT, PERMIT_COLUMNS_V1, partitionFile, planPartitions } from "./t4-permit-fetch.mjs";

export const PERMIT_VERIFIER_VERSION = "travis-t4-permit-verify.v1";

/**
 * @param {string} root - Permit capture root.
 * @returns {Promise<string>} The newest `v<rowsUpdatedAt>` directory.
 */
export async function latestCapture(root = DEFAULT_OUT) {
  const versions = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^v\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
  if (versions.length === 0) throw new Error(`no capture under ${root}`);
  return path.join(root, versions.at(-1));
}

/**
 * @param {string} file - CSV file.
 * @returns {Promise<string[]>} Header fields.
 */
async function readHeader(file) {
  const text = await readFile(file, "utf8");
  const end = text.indexOf("\n");
  for (const record of parseCsvRecordSpans(end < 0 ? text : text.slice(0, end))) return record.fields.map((field) => field.value);
  return [];
}

/**
 * Verify one capture directory.
 *
 * @param {string} captureDir - `v<rowsUpdatedAt>` directory.
 * @returns {Promise<Record<string, any>>} Report (`ok` true when nothing mismatches).
 */
export async function verifyPermitCapture(captureDir) {
  const mismatches = [];
  const log = await verifyReceiptLog(path.join(captureDir, "receipts.jsonl"));
  mismatches.push(...log.mismatches);
  const capture = JSON.parse(await readFile(path.join(captureDir, "capture.json"), "utf8"));
  const count = Number.parseInt(JSON.parse(await readFile(path.join(captureDir, "count.json"), "utf8"))[0]?.n ?? "NaN", 10);
  const plan = planPartitions(JSON.parse(await readFile(path.join(captureDir, "plan.json"), "utf8")), capture.page_limit ?? PAGE_LIMIT);
  const plannedRows = plan.reduce((sum, partition) => sum + partition.expected_rows, 0);
  const receipts = (await readFile(path.join(captureDir, "receipts.jsonl"), "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
  /** @type {Map<string, Record<string, any>>} */
  const pageReceipts = new Map();
  for (const receipt of receipts) if (receipt.kind === "page" && receipt.status === 200 && !receipt.retried) pageReceipts.set(receipt.file, receipt);
  const csvFiles = log.files.filter((file) => file.class === "csv");
  const expectedFiles = new Map();
  for (const partition of plan) {
    if (!partition.split) expectedFiles.set(partitionFile(partition), partition.expected_rows);
    else {
      for (let month = 1; month <= 12; month += 1) {
        const sub = { permittype: partition.permittype, year: partition.year, month };
        const countFile = path.join(captureDir, partitionFile(sub).replace(/\.csv$/, ".count.json"));
        const subRows = existsSync(countFile) ? Number.parseInt(JSON.parse(await readFile(countFile, "utf8"))[0]?.n ?? "NaN", 10) : Number.NaN;
        expectedFiles.set(partitionFile(sub), subRows);
      }
      const monthSum = [...expectedFiles.entries()].filter(([file]) => file.startsWith(partitionFile(partition).replace(/\.csv$/, "-"))).reduce((sum, [, rows]) => sum + rows, 0);
      if (monthSum !== partition.expected_rows) mismatches.push(`${partitionFile(partition)}: its months hold ${monthSum} rows, the plan ${partition.expected_rows}`);
    }
  }
  let headerMismatches = 0;
  const collected = new Set(PERMIT_COLUMNS_V1);
  for (const [file, expected] of expectedFiles) {
    const verified = csvFiles.find((entry) => entry.file === file);
    if (!verified) {
      mismatches.push(`${file}: planned partition has no verified CSV`);
      continue;
    }
    if (verified.parsed_rows !== expected) mismatches.push(`${file}: ${verified.parsed_rows} rows, planned ${expected}`);
    if (pageReceipts.get(file)?.expected_rows !== undefined && pageReceipts.get(file).expected_rows !== expected) mismatches.push(`${file}: receipt expected_rows ${pageReceipts.get(file).expected_rows}, plan ${expected}`);
    const header = await readHeader(path.join(captureDir, file));
    if (header.length !== PERMIT_COLUMNS_V1.length || header.some((name, index) => name !== PERMIT_COLUMNS_V1[index])) {
      headerMismatches += 1;
      mismatches.push(`${file}: header is not the versioned column set`);
    }
    for (const name of header) if (!collected.has(name)) mismatches.push(`${file}: column ${name} is not collected by the profile`);
  }
  for (const file of csvFiles) if (!expectedFiles.has(file.file)) mismatches.push(`${file.file}: CSV outside the plan`);
  const rows = csvFiles.filter((file) => expectedFiles.has(file.file)).reduce((sum, file) => sum + (file.parsed_rows ?? 0), 0);
  const bytes = csvFiles.filter((file) => expectedFiles.has(file.file)).reduce((sum, file) => sum + (file.bytes ?? 0), 0);
  if (plannedRows !== count) mismatches.push(`plan holds ${plannedRows} rows, count.json ${count}`);
  if (rows !== count) mismatches.push(`partitions hold ${rows} rows, count.json ${count}`);
  if (capture.rows !== rows) mismatches.push(`capture.json rows ${capture.rows}, files ${rows}`);
  if (capture.bytes !== bytes) mismatches.push(`capture.json bytes ${capture.bytes}, files ${bytes}`);
  if (capture.expected_rows !== count) mismatches.push(`capture.json expected_rows ${capture.expected_rows}, count.json ${count}`);
  if (capture.rows_updated_at?.start !== capture.rows_updated_at?.end) mismatches.push("rowsUpdatedAt changed during the capture");
  if (!capture.consistent) mismatches.push("capture.json says inconsistent");
  if (path.basename(captureDir) !== `v${capture.rows_updated_at?.start}`) mismatches.push(`directory ${path.basename(captureDir)} is not v${capture.rows_updated_at?.start}`);
  const notCollected = [...NOT_COLLECTED_PERSONAL, ...NOT_COLLECTED_ROLLING];
  return {
    verifier_version: PERMIT_VERIFIER_VERSION,
    capture: path.relative(RUNTIME_ROOT, captureDir).split(path.sep).join("/"),
    dataset: capture.dataset,
    rows_updated_at: capture.rows_updated_at,
    count_json: count,
    planned_rows: plannedRows,
    partitions_planned: plan.length,
    partition_files: expectedFiles.size,
    csv_files_verified: csvFiles.length,
    receipts: log.receipts,
    attempts_not_answered: log.attempts_not_answered,
    rows_parsed: rows,
    bytes,
    header_mismatches: headerMismatches,
    not_collected_columns_absent: notCollected,
    files: log.files.map((file) => ({ file: file.file, kind: file.kind, bytes: file.bytes ?? null, sha256: file.sha256 ?? null, rows: file.parsed_rows ?? null })),
    mismatches,
    ok: mismatches.length === 0,
  };
}

/** @param {string[]} argv @returns {Record<string, string>} */
function parseFlags(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith("--") || argv[index + 1] === undefined) throw new Error("usage: t4-permit-verify.mjs [--capture <dir>] [--out <report.json>]");
    flags[argv[index].slice(2)] = argv[index + 1];
  }
  return flags;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const captureDir = flags.capture ? path.resolve(flags.capture) : await latestCapture();
  const report = await verifyPermitCapture(captureDir);
  if (flags.out) await writeFile(path.resolve(flags.out), `${JSON.stringify(report, null, 1)}\n`);
  console.log(
    `t4-permit-verify: ${report.ok ? "OK" : `${report.mismatches.length} MISMATCHES`}; ${report.partition_files} partitions, ${report.receipts} receipts, ${report.rows_parsed.toLocaleString("en-US")} CSV rows, ${(report.bytes / 1e6).toFixed(1)} MB; ${path.basename(captureDir)} (rowsUpdatedAt ${report.rows_updated_at?.end_iso})`,
  );
  for (const mismatch of report.mismatches.slice(0, 20)) console.log(`  mismatch: ${mismatch}`);
  process.exit(report.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
