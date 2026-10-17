#!/usr/bin/env node
/**
 * T4 permit link pass (assignment decisions.md section 5; kit `query-db-loading-matching` "Permit/property
 * matching"): one offline pass over a verified Austin permit capture and the parcel seed. Every permit is profiled
 * (`permit-profile.mjs`: status group, lifecycle, work class, date and `tcad_id` evidence) and linked to the roll on
 * `geo_id` exactly as printed (the permits' `tcad_id`); the digits-only fallback is enabled only with the roll proof
 * re-run here (`proveDigitsOnlyNormalization`, one-to-one or no fallback). A permit with zero or several candidates, or
 * a malformed `tcad_id`, stays valid-unlinked with its reason. `PROP_ID` is never a link key.
 *
 * The pass is the bulk path's "harvest by parcel": the same single pass that counts the link methods returns the rows
 * linked to any requested set of parcels (the pilot, the feasibility sample, or the whole roll in the full run).
 *
 *   node --max-old-space-size=8192 src/counties/travis/t4-permit-links.mjs [--capture <dir>] [--seed data/seeds/travis.csv] [--out <report.json>]
 *
 * The report holds counts, versions and digests; the only row text it carries is the most frequent normalized
 * `needs_review` work descriptions (public permit text, the operator's review list, decisions.md section 20).
 *
 * @module counties/travis/t4-permit-links
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { RUNTIME_ROOT, parseCsvRecordSpans } from "./t3-snapshot.mjs";
import { PERMIT_COLUMNS_V1 } from "./t4-permit-fetch.mjs";
import { latestCapture } from "./t4-permit-verify.mjs";
import {
  CLOSED_STATUSES,
  EXPIRED_STATUS,
  OBSERVED_UNMAPPED_STATUSES,
  OPEN_STATUSES,
  STATUS_GROUP_VERSION,
  LIFECYCLE_MAPPING_VERSION,
  WORK_CLASSIFIER_VERSION,
  DATE_EVIDENCE_VERSION,
  TCAD_ID_NORMALIZATION_VERSION,
  classifyDateEvidence,
  classifyRoofWork,
  linkPermitToParcel,
  normalizeSourceValue,
  normalizeTcadIdDigits,
  normalizeWorkText,
  proveDigitsOnlyNormalization,
  summarizePermitRow,
} from "./permit-profile.mjs";

export const LINK_PASS_VERSION = "travis-t4-link-pass.v1";
export const DEFAULT_SEED = path.join(RUNTIME_ROOT, "data", "seeds", "travis.csv");

const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");

/**
 * Stream a CSV file record by record (RFC 4180; a newline inside quotes is not a record end), with the header's field
 * names. Only the requested columns are returned.
 *
 * @param {string} file - CSV file.
 * @param {{ columns?: string[] | null }} [options] - Columns to keep (all when null).
 * @returns {AsyncGenerator<Record<string, string>>} Records.
 */
export async function* streamCsvFile(file, { columns = null } = {}) {
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
  let buffer = "";
  let scanned = 0;
  let inQuotes = false;
  /** @type {string[] | null} */
  let header = null;
  /** @type {number[] | null} */
  let keep = null;
  const emit = (recordText) => {
    for (const record of parseCsvRecordSpans(recordText)) {
      const values = record.fields.map((field) => field.value);
      if (header === null) {
        header = values;
        keep = (columns ?? header).map((name) => {
          const index = header.indexOf(name);
          if (index < 0) throw new Error(`${path.basename(file)}: no column ${name}`);
          return index;
        });
        return null;
      }
      /** @type {Record<string, string>} */
      const row = {};
      for (const index of keep) row[header[index]] = values[index] ?? "";
      return row;
    }
    return null;
  };
  for await (const chunk of stream) {
    buffer += chunk;
    let start = 0;
    for (let index = scanned; index < buffer.length; index += 1) {
      const code = buffer.charCodeAt(index);
      if (code === 34) inQuotes = !inQuotes;
      else if (code === 10 && !inQuotes) {
        const row = emit(buffer.slice(start, index));
        if (row) yield row;
        start = index + 1;
      }
    }
    buffer = buffer.slice(start);
    scanned = buffer.length;
  }
  if (buffer.trim() !== "") {
    const row = emit(buffer);
    if (row) yield row;
  }
}

/**
 * The roll's `geo_id` index from the seed (one row per real-property account).
 *
 * @param {string} seedPath - Seed CSV.
 * @returns {Promise<{ byGeoId: Map<string, string[]>, byDigits: Map<string, string[]>, situsByPropId: Map<string, string>, propIds: Set<string>, proof: ReturnType<typeof proveDigitsOnlyNormalization>, stats: Record<string, number>, seedSha256: string }>} Index.
 */
export async function readRollGeoIndex(seedPath) {
  /** @type {Map<string, string[]>} */
  const byGeoId = new Map();
  /** @type {Map<string, string[]>} */
  const byDigits = new Map();
  /** @type {Map<string, string>} */
  const situsByPropId = new Map();
  const propIds = new Set();
  const geoIds = [];
  let rows = 0;
  let blank = 0;
  let nonTenDigit = 0;
  const hash = createHash("sha256");
  const raw = createReadStream(seedPath);
  const hashing = (async () => {
    for await (const chunk of raw) hash.update(chunk);
  })();
  for await (const row of streamCsvFile(seedPath, { columns: ["parcel_id", "geo_id", "address"] })) {
    rows += 1;
    const propId = row.parcel_id.trim();
    if (propIds.has(propId)) throw new Error(`seed repeats PROP_ID ${propId}`);
    propIds.add(propId);
    situsByPropId.set(propId, row.address);
    const geoId = row.geo_id.trim();
    if (geoId === "") {
      blank += 1;
      continue;
    }
    geoIds.push(geoId);
    if (!/^\d{10}$/.test(geoId)) nonTenDigit += 1;
    (byGeoId.get(geoId) ?? byGeoId.set(geoId, []).get(geoId)).push(propId);
    const digits = normalizeTcadIdDigits(geoId);
    (byDigits.get(digits) ?? byDigits.set(digits, []).get(digits)).push(propId);
  }
  await hashing;
  const proof = proveDigitsOnlyNormalization(geoIds);
  let shared = 0;
  let accountsOnShared = 0;
  for (const members of byGeoId.values()) {
    if (members.length > 1) {
      shared += 1;
      accountsOnShared += members.length;
    }
  }
  return {
    byGeoId,
    byDigits,
    situsByPropId,
    propIds,
    proof,
    stats: { seed_rows: rows, blank_geo_ids: blank, non_ten_digit_geo_ids: nonTenDigit, distinct_geo_ids: byGeoId.size, shared_geo_ids: shared, accounts_on_shared_geo_ids: accountsOnShared },
    seedSha256: hash.digest("hex"),
  };
}

/**
 * The partition receipts of a capture (latest answered receipt per partition CSV).
 *
 * @param {string} captureDir - Capture directory.
 * @returns {Promise<Record<string, any>[]>} Receipts, by file name.
 */
export async function partitionReceipts(captureDir) {
  const receipts = (await readFile(path.join(captureDir, "receipts.jsonl"), "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
  /** @type {Map<string, Record<string, any>>} */
  const latest = new Map();
  for (const receipt of receipts) if (receipt.kind === "page" && receipt.status === 200 && !receipt.retried) latest.set(receipt.file, receipt);
  return [...latest.values()].sort((left, right) => left.file.localeCompare(right.file));
}

/**
 * Every captured permit row with its locator, row digest and the request that captured it.
 *
 * @param {string} captureDir - Verified capture directory.
 * @returns {AsyncGenerator<{ row: Record<string, string>, file: string, index: number, rowSha256: string, request: Record<string, any>, fetchedAt: string, receiptSha256: string }>} Rows.
 */
export async function* streamCapturedPermits(captureDir) {
  for (const receipt of await partitionReceipts(captureDir)) {
    const text = await readFile(path.join(captureDir, receipt.file), "utf8");
    if (sha256Hex(Buffer.from(text, "utf8")) !== receipt.sha256) throw new Error(`${receipt.file}: bytes differ from the receipt; run t4-permit-verify first`);
    /** @type {string[] | null} */
    let header = null;
    let index = -1;
    for (const record of parseCsvRecordSpans(text)) {
      const values = record.fields.map((field) => field.value);
      if (header === null) {
        header = values;
        if (header.join(",") !== PERMIT_COLUMNS_V1.join(",")) throw new Error(`${receipt.file}: header is not the versioned column set`);
        continue;
      }
      index += 1;
      /** @type {Record<string, string>} */
      const row = {};
      header.forEach((name, column) => {
        row[name] = values[column] ?? "";
      });
      yield { row, file: receipt.file, index, rowSha256: sha256Hex(Buffer.from(text.slice(record.start, record.end), "utf8")), request: receipt.source_http_request, fetchedAt: receipt.fetched_at, receiptSha256: receipt.sha256 };
    }
  }
}

/** @param {Record<string, number>} counts @param {string} key */
const bump = (counts, key, by = 1) => {
  counts[key] = (counts[key] ?? 0) + by;
};

/**
 * One pass over the capture: profile, link and count every permit; return the rows linked to the requested parcels.
 *
 * @param {object} options - Inputs.
 * @param {string} options.captureDir - Verified capture directory.
 * @param {Awaited<ReturnType<typeof readRollGeoIndex>>} options.roll - Roll index.
 * @param {string} options.asOfDate - `YYYY-MM-DD` for the date evidence.
 * @param {Set<string> | null} [options.select] - PROP_IDs whose linked rows are returned (null: none).
 * @param {number} [options.reviewSamples] - Most frequent `needs_review` descriptions to report.
 * @param {Set<string> | null} [options.countTcadIds] - Printed `tcad_id` values whose rows are counted whatever their link (cross-checks).
 * @returns {Promise<{ summary: Record<string, any>, selected: Map<string, any[]>, conflictingNumbers: Set<string>, tcadCounts: Map<string, { rows: number, by_unlinked_reason: Record<string, number> }> }>} Counts, the selected rows, the permit numbers printed on differing rows and the per-`tcad_id` counts.
 */
export async function runLinkPass({ captureDir, roll, asOfDate, select = null, reviewSamples = 40, countTcadIds = null }) {
  const started = performance.now();
  const digitsFallback = roll.proof.oneToOne ? { proof: roll.proof, parcelsByDigits: roll.byDigits } : null;
  /** @type {Map<string, any[]>} */
  const selected = new Map();
  /** @type {Map<string, { rows: number, by_unlinked_reason: Record<string, number> }>} */
  const tcadCounts = new Map();
  const counts = {
    rows: 0,
    by_permittype: {},
    link_method: { exact: 0, normalized_digits: 0 },
    unlinked_reasons: { no_candidate: 0, multiple_candidates: 0, invalid_quarantined: 0 },
    no_candidate_detail: { blank_tcad_id: 0, ten_digit_not_in_roll: 0 },
    by_permittype_link: {},
    tcad_id: { confirmed_present: 0, unknown: 0, invalid_quarantined: 0 },
    tcad_id_quarantine_reasons: {},
    evidence_states: { completed_date: { confirmed_present: 0, unknown: 0, invalid_quarantined: 0 }, status_current: { confirmed_present: 0, unknown: 0 }, tcad_id: { confirmed_present: 0, unknown: 0, invalid_quarantined: 0 } },
    date_reasons: { applieddate: {}, issue_date: {}, completed_date: {}, expiresdate: {}, statusdate_final: {} },
    status_current: {},
    status_group: {},
    status_group_basis: {},
    lifecycle: {},
    roof_work_class: {},
    roof_work_basis: {},
    roofing: { permits: 0, linked: 0, by_status_group: {}, by_class_linked: {}, bp_rows: 0 },
    jurisdiction_of_unlinked: {},
  };
  /** @type {Map<string, number>} */
  const permitNumberRows = new Map();
  /** @type {Map<string, string>} */
  const firstRowDigest = new Map();
  let identicalDuplicates = 0;
  /** @type {Set<string>} */
  const conflictingNumbers = new Set();
  /** @type {string | null} */
  let issueDateMax = null;
  /** @type {Map<string, number>} */
  const reviewTexts = new Map();
  /** @type {Set<string>} */
  const linkedParcels = new Set();
  /** @type {Map<string, number>} */
  const permitsPerParcel = new Map();
  const williamson = { account_form_rows: 0, marker_rows: 0, with_coordinates: 0, north_of_30_40: 0, jurisdictions: {} };
  const notInRoll = { rows: 0, distinct: new Set(), by_issue_decade: {} };
  const mappedStatuses = new Set([...OPEN_STATUSES, ...CLOSED_STATUSES, EXPIRED_STATUS].map(normalizeSourceValue));
  const observedUnmapped = new Set(OBSERVED_UNMAPPED_STATUSES.map(normalizeSourceValue));

  for await (const entry of streamCapturedPermits(captureDir)) {
    const { row } = entry;
    counts.rows += 1;
    const type = row.permittype || "(blank)";
    bump(counts.by_permittype, type);
    const summary = summarizePermitRow(row, { asOfDate });
    const link = linkPermitToParcel({ tcadId: row.tcad_id, parcelsByGeoId: roll.byGeoId, digitsFallback });
    const tcad = summary.tcadIdEvidence;
    if (countTcadIds?.has(row.tcad_id.trim())) {
      const tally = tcadCounts.get(row.tcad_id.trim()) ?? tcadCounts.set(row.tcad_id.trim(), { rows: 0, by_unlinked_reason: {} }).get(row.tcad_id.trim());
      tally.rows += 1;
      if (!link.propertyId) bump(tally.by_unlinked_reason, link.unlinkedReason);
    }
    counts.tcad_id[tcad.evidenceState] += 1;
    counts.evidence_states.tcad_id[tcad.evidenceState] += 1;
    if (tcad.evidenceState === "invalid_quarantined") bump(counts.tcad_id_quarantine_reasons, tcad.reason);
    counts.evidence_states.completed_date[summary.completedDateEvidence.evidenceState] += 1;
    counts.evidence_states.status_current[row.status_current.trim() === "" ? "unknown" : "confirmed_present"] += 1;
    const applied = classifyDateEvidence(row.applieddate, { asOfDate });
    bump(counts.date_reasons.applieddate, applied.reason);
    const issued = classifyDateEvidence(row.issue_date, { asOfDate });
    bump(counts.date_reasons.issue_date, issued.reason);
    if (issued.evidenceState === "confirmed_present" && (issueDateMax === null || issued.value > issueDateMax)) issueDateMax = issued.value;
    bump(counts.date_reasons.completed_date, summary.completedDateEvidence.reason);
    // The export prints future expiry dates for open permits: expiry is checked for form only, not against the as-of date.
    bump(counts.date_reasons.expiresdate, classifyDateEvidence(row.expiresdate, { asOfDate: "9999-12-31" }).reason);
    if (summary.lifecycleStatus === "completed") bump(counts.date_reasons.statusdate_final, classifyDateEvidence(row.statusdate, { asOfDate, notBefore: applied.evidenceState === "confirmed_present" ? applied.value : null }).reason);
    bump(counts.status_current, row.status_current);
    bump(counts.status_group, summary.statusGroup);
    bump(counts.status_group_basis, summary.statusGroupBasis);
    bump(counts.lifecycle, summary.lifecycleStatus);
    bump(counts.roof_work_class, summary.roofWorkClass);
    if (type === "BP") counts.roofing.bp_rows += 1;
    const workBasis = classifyRoofWork({ permitType: row.permittype, description: row.description, workClass: row.work_class, permitClass: row.permit_class }).basis;
    bump(counts.roof_work_basis, `${summary.roofWorkClass}:${workBasis}`);
    if (summary.roofWorkClass === "needs_review" && type === "BP") {
      const key = normalizeWorkText(row.description).trim().slice(0, 120);
      reviewTexts.set(key, (reviewTexts.get(key) ?? 0) + 1);
    }
    if (summary.isRoofing) {
      counts.roofing.permits += 1;
      bump(counts.roofing.by_status_group, summary.statusGroup);
      if (link.propertyId) {
        counts.roofing.linked += 1;
        bump(counts.roofing.by_class_linked, summary.roofWorkClass);
      }
    }
    const typeLink = (counts.by_permittype_link[type] ??= { exact: 0, normalized_digits: 0, no_candidate: 0, multiple_candidates: 0, invalid_quarantined: 0 });
    if (link.propertyId) {
      counts.link_method[link.propertyLink.match_method] += 1;
      typeLink[link.propertyLink.match_method] += 1;
      linkedParcels.add(link.propertyId);
      permitsPerParcel.set(link.propertyId, (permitsPerParcel.get(link.propertyId) ?? 0) + 1);
      if (select?.has(link.propertyId)) {
        (selected.get(link.propertyId) ?? selected.set(link.propertyId, []).get(link.propertyId)).push({ ...entry, link, profile: summary });
      }
    } else {
      counts.unlinked_reasons[link.unlinkedReason] += 1;
      typeLink[link.unlinkedReason] += 1;
      bump(counts.jurisdiction_of_unlinked, `${link.unlinkedReason}:${row.jurisdiction || "(blank)"}`);
      if (link.unlinkedReason === "no_candidate") {
        if (tcad.evidenceState === "unknown") counts.no_candidate_detail.blank_tcad_id += 1;
        else counts.no_candidate_detail.ten_digit_not_in_roll += 1;
      }
    }
    if (tcad.reason === "williamson_cad_account_form" || tcad.reason === "williamson_cad_marker") {
      if (tcad.reason === "williamson_cad_account_form") williamson.account_form_rows += 1;
      else williamson.marker_rows += 1;
      bump(williamson.jurisdictions, row.jurisdiction || "(blank)");
      const latitude = row.latitude.trim() === "" ? Number.NaN : Number(row.latitude);
      if (Number.isFinite(latitude)) {
        williamson.with_coordinates += 1;
        if (latitude > 30.4) williamson.north_of_30_40 += 1;
      }
    }
    const decade = `${String(row.calendar_year_issued).slice(0, 3)}0s`;
    if (tcad.evidenceState === "confirmed_present") {
      const bucket = (notInRoll.by_issue_decade[decade] ??= { not_in_roll: 0, in_roll: 0 });
      if (roll.byGeoId.has(tcad.value)) bucket.in_roll += 1;
      else {
        bucket.not_in_roll += 1;
        notInRoll.rows += 1;
        notInRoll.distinct.add(tcad.value);
      }
    }
    const number = row.permit_number.trim();
    const seen = permitNumberRows.get(number) ?? 0;
    permitNumberRows.set(number, seen + 1);
    const digest = entry.rowSha256.slice(0, 16);
    if (seen === 0) firstRowDigest.set(number, digest);
    else if (firstRowDigest.get(number) === digest) identicalDuplicates += 1;
    else if (number !== "") conflictingNumbers.add(number);
  }

  let duplicateNumbers = 0;
  let duplicateRows = 0;
  const blankNumbers = permitNumberRows.get("") ?? 0;
  for (const [number, rows] of permitNumberRows) {
    if (number === "" || rows < 2) continue;
    duplicateNumbers += 1;
    duplicateRows += rows;
  }
  const perParcel = [...permitsPerParcel.values()].sort((left, right) => left - right);
  const pick = (q) => (perParcel.length === 0 ? null : perParcel[Math.min(perParcel.length - 1, Math.ceil(q * perParcel.length) - 1)]);
  const newStatuses = Object.keys(counts.status_current).filter((value) => {
    const normalized = normalizeSourceValue(value);
    return normalized !== "" && !mappedStatuses.has(normalized) && !observedUnmapped.has(normalized);
  });
  const elapsedMs = performance.now() - started;
  const linked = counts.link_method.exact + counts.link_method.normalized_digits;
  const summary = {
    link_pass_version: LINK_PASS_VERSION,
    versions: { status_group: STATUS_GROUP_VERSION, lifecycle: LIFECYCLE_MAPPING_VERSION, work_classifier: WORK_CLASSIFIER_VERSION, date_evidence: DATE_EVIDENCE_VERSION, tcad_id_normalization: TCAD_ID_NORMALIZATION_VERSION },
    as_of_date: asOfDate,
    roll: { ...roll.stats, seed_sha256: roll.seedSha256, digits_only_proof: { ...roll.proof, collisions: roll.proof.collisions.length }, digits_fallback_enabled: digitsFallback !== null },
    ...counts,
    linked,
    unlinked: counts.rows - linked,
    linked_share: counts.rows === 0 ? null : Math.round((linked / counts.rows) * 10000) / 10000,
    linked_parcels: linkedParcels.size,
    issue_date_max: issueDateMax,
    permits_per_linked_parcel: { p50: pick(0.5), p90: pick(0.9), p99: pick(0.99), max: perParcel.at(-1) ?? null, mean: perParcel.length === 0 ? null : Math.round((linked / perParcel.length) * 100) / 100 },
    status_vocabulary: { distinct: Object.keys(counts.status_current).length, new_unmapped_values: newStatuses, needs_review_rows: counts.status_group.needs_review ?? 0 },
    permit_number: { distinct: permitNumberRows.size, blank_rows: blankNumbers, printed_more_than_once: duplicateNumbers, rows_under_repeated_numbers: duplicateRows, repeated_rows_identical_to_first: identicalDuplicates, printed_on_differing_rows: conflictingNumbers.size },
    williamson_cad_tcad_id: {
      ...williamson,
      note: "tcad_id printed in the Williamson CAD account form (R + 6 digits) or as WCAD: another county's parcel id, invalid_quarantined, outside the Travis parcel population; north_of_30_40 counts the rows with coordinates north of latitude 30.40",
    },
    ten_digit_not_in_roll: {
      rows: notInRoll.rows,
      distinct_geo_ids: notInRoll.distinct.size,
      by_issue_decade: notInRoll.by_issue_decade,
      note: "a 10-digit tcad_id that no 2026 roll account prints (no_candidate): a geo_id retired since the permit, for example a tract later subdivided; it stays unlinked (decisions.md section 5 links on geo_id only)",
    },
    needs_review_descriptions_top: [...reviewTexts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, reviewSamples).map(([text, rows]) => ({ normalized_description: text, rows })),
    needs_review_distinct_descriptions: reviewTexts.size,
    elapsed_ms: Math.round(elapsedMs),
    rows_per_minute: elapsedMs > 0 ? Math.round((counts.rows / elapsedMs) * 60_000) : null,
  };
  return { summary, selected, conflictingNumbers, tcadCounts };
}

/** @param {string[]} argv @returns {Record<string, string>} */
function parseFlags(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith("--") || argv[index + 1] === undefined) throw new Error("usage: t4-permit-links.mjs [--capture <dir>] [--seed <csv>] [--as-of YYYY-MM-DD] [--out <report.json>]");
    flags[argv[index].slice(2)] = argv[index + 1];
  }
  return flags;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const captureDir = flags.capture ? path.resolve(flags.capture) : await latestCapture();
  const seedPath = path.resolve(flags.seed ?? DEFAULT_SEED);
  const capture = JSON.parse(await readFile(path.join(captureDir, "capture.json"), "utf8"));
  const asOfDate = flags["as-of"] ?? String(capture.rows_updated_at?.end_iso ?? new Date().toISOString()).slice(0, 10);
  const rollStarted = performance.now();
  const roll = await readRollGeoIndex(seedPath);
  const rollMs = performance.now() - rollStarted;
  const { summary } = await runLinkPass({ captureDir, roll, asOfDate });
  const report = {
    ...summary,
    capture: { dir: path.relative(RUNTIME_ROOT, captureDir).split(path.sep).join("/"), dataset: capture.dataset, rows_updated_at: capture.rows_updated_at, rows: capture.rows, bytes: capture.bytes },
    seed: { path: path.relative(RUNTIME_ROOT, seedPath).split(path.sep).join("/"), sha256: roll.seedSha256, rows: roll.stats.seed_rows, read_ms: Math.round(rollMs) },
  };
  if (flags.out) await writeFile(path.resolve(flags.out), `${JSON.stringify(report, null, 1)}\n`);
  console.log(
    JSON.stringify({
      travis_t4_link_pass: "complete",
      rows: report.rows,
      linked: report.linked,
      link_method: report.link_method,
      unlinked_reasons: report.unlinked_reasons,
      linked_parcels: report.linked_parcels,
      digits_fallback_enabled: report.roll.digits_fallback_enabled,
      new_unmapped_statuses: report.status_vocabulary.new_unmapped_values,
      elapsed_s: Math.round(report.elapsed_ms / 100) / 10,
    }),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}
