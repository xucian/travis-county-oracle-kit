#!/usr/bin/env node
/**
 * T4 Socrata harvester for the City of Austin "Issued Construction Permits" export (data.austintexas.gov `3syk-w9eu`;
 * assignment decisions.md section 2 item 4). Downloads and records; never transforms.
 *
 * - Columns: every named column of the export except the personal applicant fields (the profile's privacy
 *   classification: not collected, so they are never requested) and the rolling `issued_in_last_30_days` flag (the
 *   publisher recomputes it every day, so it would change a permit's row hash with no change to the permit). The
 *   collected set is the versioned {@link PERMIT_COLUMNS_V1}; a dataset whose columns differ stops the harvest before
 *   any data request, so a new column (personal or not) is never collected silently.
 * - Partitions: one request per (`permittype`, `calendar_year_issued`), planned from the dataset's own group-by counts.
 *   A permit never moves between partitions (both fields come from the issue), so the request that captured a permit
 *   is the same request in every later run; that request is the permit's `source_http_request` (decisions.md
 *   section 3), and a page offset that shifts as rows are added is never part of it. A partition over the page limit
 *   is split by issue month. Every partition's row count must equal its planned count, and the plan's total the
 *   dataset count.
 * - Receipts: one JSON line per request (sha256, bytes, rows, status, timings) through the T3 capture library
 *   (`t3-fetch.mjs#captureToFile`); resumable: an intact earlier capture of the same request is not fetched again.
 * - Version: the capture lives under `v<rowsUpdatedAt>`; the metadata is read again at the end, and a change during
 *   the capture marks it inconsistent (rerun the same command).
 * - Throttle: at most {@link DEFAULT_CONCURRENCY} requests in flight on the host, Retry-After honoured, no app token.
 *   The host answers any country; the egress country is recorded once and does not gate.
 *
 *   node src/counties/travis/t4-permit-fetch.mjs [--out data/travis/permits] [--concurrency 2]
 *
 * @module counties/travis/t4-permit-fetch
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { EGRESS_URL, captureToFile, compactTimestamp, createCaptureContext, hostLimiter, receiptLog } from "./t3-fetch.mjs";
import { RUNTIME_ROOT } from "./t3-snapshot.mjs";

export const HARVEST_VERSION = "travis-t4-socrata-harvest.v1";
export const PERMIT_SOURCE_KEY = "austin-issued-construction-permits";
export const PERMIT_DOMAIN = "data.austintexas.gov";
export const PERMIT_DATASET_ID = "3syk-w9eu";
export const PERMIT_DATASET = `${PERMIT_SOURCE_KEY}/${PERMIT_DATASET_ID}`;
export const PERMIT_RESOURCE_URL = `https://${PERMIT_DOMAIN}/resource/${PERMIT_DATASET_ID}`;
export const PAGE_LIMIT = 50_000;
export const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_OUT = path.join(RUNTIME_ROOT, "data", "travis", "permits");
export const PERMIT_COLUMN_SET_VERSION = "travis-austin-permit-columns.v1";

/** Personal contact fields (travis-sources.yaml `permit_contact_privacy_classification.applicant_fields`): never requested. */
export const NOT_COLLECTED_PERSONAL = Object.freeze(["applicant_full_name", "applicant_org", "applicant_phone", "applicant_address1", "applicant_address2", "applicant_city", "applicantzip"]);
/** Rolling flags the publisher recomputes daily: never requested (they would change a row's hash with no change to the permit). */
export const NOT_COLLECTED_ROLLING = Object.freeze(["issued_in_last_30_days"]);

/** The collected columns, in the dataset's metadata order (2026-10-17). */
export const PERMIT_COLUMNS_V1 = Object.freeze([
  "permittype", "permit_type_desc", "permit_number", "permit_class_mapped", "permit_class", "work_class", "condominium",
  "permit_location", "description", "tcad_id", "legal_description", "applieddate", "issue_date", "day_issued",
  "calendar_year_issued", "fiscal_year_issued", "issue_method", "status_current", "statusdate", "expiresdate",
  "completed_date", "total_existing_bldg_sqft", "remodel_repair_sqft", "total_new_add_sqft", "total_valuation_remodel",
  "total_job_valuation", "number_of_floors", "housing_units", "building_valuation", "building_valuation_remodel",
  "electrical_valuation", "electrical_valuation_remodel", "mechanical_valuation", "mechanical_valuation_remodel",
  "plumbing_valuation", "plumbing_valuation_remodel", "medgas_valuation", "medgas_valuation_remodel", "original_address1",
  "original_city", "original_state", "original_zip", "council_district", "jurisdiction", "link", "project_id",
  "masterpermitnum", "latitude", "longitude", "location", "contractor_trade", "contractor_company_name",
  "contractor_full_name", "contractor_phone", "contractor_address1", "contractor_address2", "contractor_city",
  "contractor_zip", "certificate_of_occupancy", "total_lot_sq_ft",
]);

/**
 * Check the dataset's columns against the versioned set. Computed regions (`:@computed_region_*`) are Socrata's
 * derived geography joins, not columns of the export, and are ignored.
 *
 * @param {{ fieldName: string }[]} columns - Metadata columns.
 * @returns {{ ok: boolean, named: string[], unexpected: string[], missing: string[] }} Comparison.
 */
export function compareColumns(columns) {
  const named = columns.map((column) => column.fieldName).filter((name) => !name.startsWith(":"));
  const known = new Set([...PERMIT_COLUMNS_V1, ...NOT_COLLECTED_PERSONAL, ...NOT_COLLECTED_ROLLING]);
  const unexpected = named.filter((name) => !known.has(name));
  const missing = [...known].filter((name) => !named.includes(name));
  return { ok: unexpected.length === 0 && missing.length === 0, named, unexpected, missing };
}

/** @param {string | null} value - Partition value. @returns {string} SoQL literal for a text column. */
const textLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;

/**
 * The SoQL `$where` of one partition (and optionally one issue month).
 *
 * @param {{ permittype: string | null, year: number | null, month?: number | null }} partition - Partition.
 * @returns {string} `$where`.
 */
export function partitionWhere({ permittype, year, month = null }) {
  const parts = [permittype === null ? "permittype IS NULL" : `permittype = ${textLiteral(permittype)}`, year === null ? "calendar_year_issued IS NULL" : `calendar_year_issued = ${year}`];
  if (month !== null && month !== undefined) {
    if (year === null) throw new Error("a month split needs a year");
    const start = `${year}-${String(month).padStart(2, "0")}-01T00:00:00`;
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    const end = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00`;
    parts.push(`issue_date >= '${start}' AND issue_date < '${end}'`);
  }
  return parts.join(" AND ");
}

/**
 * @param {{ permittype: string | null, year: number | null, month?: number | null }} partition - Partition.
 * @returns {string} Partition file name (`partition-BP-2021.csv`, `partition-BP-2021-03.csv`).
 */
export function partitionFile({ permittype, year, month = null }) {
  const type = permittype === null ? "NULL" : permittype.replace(/[^A-Za-z0-9]+/g, "_");
  const yearPart = year === null ? "NULL" : String(year);
  return `partition-${type}-${yearPart}${month ? `-${String(month).padStart(2, "0")}` : ""}.csv`;
}

/**
 * The partition request (stable across runs for an unchanged plan; no offset).
 *
 * @param {{ permittype: string | null, year: number | null, month?: number | null }} partition - Partition.
 * @param {number} [limit] - `$limit` (the page limit; a partition must hold fewer rows).
 * @returns {string} URL as sent.
 */
export function partitionUrl(partition, limit = PAGE_LIMIT) {
  const params = new URLSearchParams();
  params.set("$select", PERMIT_COLUMNS_V1.join(","));
  params.set("$where", partitionWhere(partition));
  params.set("$order", ":id");
  params.set("$limit", String(limit));
  return `${PERMIT_RESOURCE_URL}.csv?${params}`;
}

/**
 * Turn the group-by answer into partitions; a partition at or above the limit is marked for a month split.
 *
 * @param {{ permittype?: string | null, calendar_year_issued?: string | number | null, n: string | number }[]} groups - Group-by rows.
 * @param {number} [limit] - Page limit.
 * @returns {{ permittype: string | null, year: number | null, expected_rows: number, split: boolean }[]} Partitions, sorted.
 */
export function planPartitions(groups, limit = PAGE_LIMIT) {
  const partitions = groups.map((group) => {
    const year = group.calendar_year_issued === null || group.calendar_year_issued === undefined || group.calendar_year_issued === "" ? null : Number(group.calendar_year_issued);
    if (year !== null && !Number.isInteger(year)) throw new Error(`calendar_year_issued is not an integer: ${JSON.stringify(group.calendar_year_issued)}`);
    const expected = Number.parseInt(String(group.n), 10);
    if (!Number.isInteger(expected) || expected < 0) throw new Error(`group count is not a count: ${JSON.stringify(group.n)}`);
    return { permittype: group.permittype ?? null, year, expected_rows: expected, split: expected >= limit };
  });
  const keys = new Set(partitions.map((partition) => `${partition.permittype}|${partition.year}`));
  if (keys.size !== partitions.length) throw new Error("the group-by answer repeats a (permittype, year) pair");
  return partitions.sort((left, right) => String(left.permittype).localeCompare(String(right.permittype)) || (left.year ?? -1) - (right.year ?? -1));
}

/**
 * @param {string} file - JSON file.
 * @returns {Promise<any>} Parsed JSON.
 */
async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

/**
 * @param {unknown} epochSeconds - Socrata epoch seconds.
 * @returns {string | null} ISO time.
 */
const toIso = (epochSeconds) => (typeof epochSeconds === "number" ? new Date(epochSeconds * 1000).toISOString() : null);

/**
 * Harvest the whole export into `<out>/v<rowsUpdatedAt>/`.
 *
 * @param {object} [options] - Options.
 * @param {string} [options.out] - Output root.
 * @param {number} [options.concurrency] - Requests in flight on the host.
 * @param {number} [options.limit] - Page limit per partition request.
 * @param {Partial<import("./t3-fetch.mjs").CaptureContext>} [options.context] - Context overrides (tests).
 * @returns {Promise<Record<string, any>>} Capture summary (also `<versionDir>/capture.json`).
 */
export async function harvestAustinPermits({ out = DEFAULT_OUT, concurrency = DEFAULT_CONCURRENCY, limit = PAGE_LIMIT, context = {} } = {}) {
  const ctx = createCaptureContext({ limit: hostLimiter({ [PERMIT_DOMAIN]: concurrency, default: 1 }), maxAttempts: 6, ...context });
  const startedAt = ctx.now();
  const started = Date.now();
  let egress;
  try {
    const response = await ctx.fetchImpl(EGRESS_URL);
    egress = { country: (await response.text()).trim(), checked_at: ctx.now().toISOString(), gating: false };
  } catch (error) {
    egress = { country: null, error: error instanceof Error ? error.message : String(error), gating: false };
  }
  const source = PERMIT_SOURCE_KEY;
  const metadataUrl = `https://${PERMIT_DOMAIN}/api/views/${PERMIT_DATASET_ID}.json`;
  const stagingDir = path.join(out, "_metadata");
  const startStamp = compactTimestamp(startedAt);
  // The metadata request is also the reachability check: nothing else is sent if it fails.
  const metaStart = await captureToFile(ctx, { source, kind: "metadata", dir: stagingDir, file: `metadata-${startStamp}-start.json`, url: metadataUrl, resume: false });
  const metadata = await readJson(path.join(stagingDir, metaStart.file));
  const version = String(metadata.rowsUpdatedAt ?? "unknown");
  const versionDir = path.join(out, `v${version}`);
  await mkdir(versionDir, { recursive: true });
  await writeFile(path.join(versionDir, metaStart.file), await readFile(path.join(stagingDir, metaStart.file)));
  await receiptLog(versionDir).append({ ...metaStart, note: `copied from _metadata/${metaStart.file}` });

  const columns = compareColumns(metadata.columns ?? []);
  if (!columns.ok) {
    const stop = { harvest_version: HARVEST_VERSION, stopped: "column set differs from the versioned set; update the profile before collecting", column_set_version: PERMIT_COLUMN_SET_VERSION, unexpected: columns.unexpected, missing: columns.missing };
    await writeFile(path.join(versionDir, "capture-stopped.json"), `${JSON.stringify(stop, null, 1)}\n`);
    throw new Error(`${PERMIT_DATASET}: ${stop.stopped} (unexpected ${columns.unexpected.join(", ") || "none"}; missing ${columns.missing.join(", ") || "none"})`);
  }

  const countUrl = `${PERMIT_RESOURCE_URL}.json?${new URLSearchParams({ $select: "count(*) as n" })}`;
  const countReceipt = await captureToFile(ctx, { source, kind: "count", dir: versionDir, file: "count.json", url: countUrl });
  const expectedRows = Number.parseInt((await readJson(path.join(versionDir, "count.json")))[0]?.n ?? "NaN", 10);

  const planParams = new URLSearchParams({
    $select: "permittype,calendar_year_issued,count(*) as n",
    $group: "permittype,calendar_year_issued",
    $order: "permittype,calendar_year_issued",
    $limit: "50000",
  });
  const planReceipt = await captureToFile(ctx, { source, kind: "plan", dir: versionDir, file: "plan.json", url: `${PERMIT_RESOURCE_URL}.json?${planParams}` });
  const planned = planPartitions(await readJson(path.join(versionDir, "plan.json")), limit);
  const plannedRows = planned.reduce((sum, partition) => sum + partition.expected_rows, 0);

  // Month splits for partitions at the limit: count each month first, then fetch it whole.
  /** @type {{ permittype: string | null, year: number | null, month: number | null, expected_rows: number }[]} */
  const requests = [];
  for (const partition of planned) {
    if (!partition.split) {
      requests.push({ permittype: partition.permittype, year: partition.year, month: null, expected_rows: partition.expected_rows });
      continue;
    }
    if (partition.year === null) throw new Error(`partition ${partition.permittype}/NULL holds ${partition.expected_rows} rows (at or above ${limit}) and has no year to split by`);
    for (let month = 1; month <= 12; month += 1) {
      const sub = { permittype: partition.permittype, year: partition.year, month };
      const subCountUrl = `${PERMIT_RESOURCE_URL}.json?${new URLSearchParams({ $select: "count(*) as n", $where: partitionWhere(sub) })}`;
      const subFile = partitionFile(sub).replace(/\.csv$/, ".count.json");
      await captureToFile(ctx, { source, kind: "count", dir: versionDir, file: subFile, url: subCountUrl });
      const subRows = Number.parseInt((await readJson(path.join(versionDir, subFile)))[0]?.n ?? "NaN", 10);
      if (!(subRows < limit)) throw new Error(`partition ${partitionFile(sub)} holds ${subRows} rows, at or above ${limit}`);
      requests.push({ ...sub, expected_rows: subRows });
    }
  }

  let done = 0;
  const receipts = await Promise.all(
    requests.map(async (request) => {
      const file = partitionFile(request);
      const receipt = await captureToFile(ctx, {
        source,
        kind: "page",
        dir: versionDir,
        file,
        url: partitionUrl(request, limit),
        csv: true,
        extra: { dataset_rows_updated_at: version, partition: { permittype: request.permittype, year: request.year, month: request.month }, expected_rows: request.expected_rows },
      });
      done += 1;
      if (done % 25 === 0 && done < requests.length) ctx.log(`[${source}] ${done}/${requests.length} partitions`);
      return { request, receipt };
    }),
  );

  const metaEnd = await captureToFile(ctx, { source, kind: "metadata", dir: versionDir, file: `metadata-${compactTimestamp(ctx.now())}-end.json`, url: metadataUrl, resume: false });
  const metadataEnd = await readJson(path.join(versionDir, metaEnd.file));
  const versionEnd = String(metadataEnd.rowsUpdatedAt ?? "unknown");
  const rows = receipts.reduce((sum, entry) => sum + (entry.receipt.rows ?? 0), 0);
  const mismatches = receipts.filter((entry) => entry.receipt.rows !== entry.request.expected_rows).map((entry) => ({ file: entry.receipt.file, rows: entry.receipt.rows, expected: entry.request.expected_rows }));
  const atLimit = receipts.filter((entry) => (entry.receipt.rows ?? 0) >= limit).map((entry) => entry.receipt.file);
  const durations = receipts.map((entry) => entry.receipt.duration_ms ?? 0).filter((value) => value > 0).sort((left, right) => left - right);
  const quantile = (q) => (durations.length === 0 ? null : durations[Math.min(durations.length - 1, Math.ceil(q * durations.length) - 1)]);
  const elapsedMs = Date.now() - started;
  const inconsistency = [];
  if (version !== versionEnd) inconsistency.push("dataset updated during the capture; rerun the same command");
  if (plannedRows !== expectedRows) inconsistency.push(`plan holds ${plannedRows} rows, count(*) says ${expectedRows}`);
  if (rows !== expectedRows) inconsistency.push(`partitions hold ${rows} rows, count(*) says ${expectedRows}`);
  if (mismatches.length > 0) inconsistency.push({ partition_row_mismatches: mismatches });
  if (atLimit.length > 0) inconsistency.push({ partitions_at_limit: atLimit });
  const summary = {
    harvest_version: HARVEST_VERSION,
    source,
    dataset: PERMIT_DATASET,
    domain: PERMIT_DOMAIN,
    dataset_id: PERMIT_DATASET_ID,
    column_set_version: PERMIT_COLUMN_SET_VERSION,
    columns_collected: PERMIT_COLUMNS_V1,
    columns_not_collected: { personal: NOT_COLLECTED_PERSONAL, rolling: NOT_COLLECTED_ROLLING, computed_regions: (metadataEnd.columns ?? []).map((column) => column.fieldName).filter((name) => name.startsWith(":")) },
    page_limit: limit,
    expected_rows: expectedRows,
    planned_rows: plannedRows,
    rows,
    partitions: requests.length,
    partitions_split_by_month: planned.filter((partition) => partition.split).map((partition) => partitionFile(partition)),
    bytes: receipts.reduce((sum, entry) => sum + (entry.receipt.bytes ?? 0), 0),
    rows_updated_at: { start: version, end: versionEnd, start_iso: toIso(metadata.rowsUpdatedAt), end_iso: toIso(metadataEnd.rowsUpdatedAt) },
    view_last_modified_iso: toIso(metadataEnd.viewLastModified),
    consistent: inconsistency.length === 0,
    inconsistency: inconsistency.length === 0 ? null : inconsistency,
    count_receipt_sha256: countReceipt.sha256,
    plan_receipt_sha256: planReceipt.sha256,
    egress,
    requests: ctx.state.requests,
    resumed: ctx.state.resumed,
    concurrency,
    throughput: {
      elapsed_ms: elapsedMs,
      rows_per_minute: elapsedMs > 0 ? Math.round((rows / elapsedMs) * 60_000) : null,
      bytes_per_second: elapsedMs > 0 ? Math.round((receipts.reduce((sum, entry) => sum + (entry.receipt.bytes ?? 0), 0) / elapsedMs) * 1000) : null,
      partition_request_ms: { p50: quantile(0.5), p95: quantile(0.95), max: durations.at(-1) ?? null, fetched: durations.length },
      note: ctx.state.resumed > 0 ? "some partitions were resumed from an earlier capture, so elapsed time undercounts a fresh harvest" : "every partition fetched in this run",
    },
    receipts: path.join(path.basename(versionDir), "receipts.jsonl"),
    started_at: startedAt.toISOString(),
    finished_at: ctx.now().toISOString(),
  };
  await writeFile(path.join(versionDir, "capture.json"), `${JSON.stringify(summary, null, 1)}\n`);
  return { ...summary, versionDir };
}

/**
 * @param {string[]} argv - Arguments.
 * @returns {{ out?: string, concurrency?: number }} Options.
 */
function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === "--out") options.out = path.resolve(value);
    else if (flag === "--concurrency") options.concurrency = Number.parseInt(value, 10);
    else throw new Error(`unknown flag ${flag}; usage: t4-permit-fetch.mjs [--out <dir>] [--concurrency <n>]`);
  }
  if (options.concurrency !== undefined && !(options.concurrency >= 1 && options.concurrency <= 4)) throw new Error("--concurrency must be 1 to 4 (Socrata politeness)");
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  harvestAustinPermits(parseArgs(process.argv.slice(2)))
    .then((summary) => {
      console.log(
        JSON.stringify({
          travis_t4_permit_harvest: summary.consistent ? "ok" : "inconsistent",
          rows: summary.rows,
          expected_rows: summary.expected_rows,
          partitions: summary.partitions,
          bytes: summary.bytes,
          rows_updated_at: summary.rows_updated_at.end_iso,
          capture: path.relative(RUNTIME_ROOT, summary.versionDir),
          requests: summary.requests,
          resumed: summary.resumed,
          elapsed_s: Math.round(summary.throughput.elapsed_ms / 100) / 10,
          egress: summary.egress?.country,
          inconsistency: summary.inconsistency,
        }),
      );
      process.exit(summary.consistent ? 0 : 1);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
