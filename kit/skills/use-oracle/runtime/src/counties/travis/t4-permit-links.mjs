#!/usr/bin/env node
/**
 * T4 permit link pass (assignment decisions.md section 5; kit `query-db-loading-matching` "Permit/property
 * matching"): one offline pass over a verified Austin permit capture and the parcel seed. Every permit is profiled
 * (`permit-profile.mjs`: status group, lifecycle, work class, date and `tcad_id` evidence) and linked to the roll on
 * `geo_id` exactly as printed (the permits' `tcad_id`); the digits-only fallback is enabled only with the roll proof
 * re-run here (`proveDigitsOnlyNormalization`, one-to-one or no fallback). A permit whose ten-digit `tcad_id` no current
 * account prints (a retired id) is then looked up in TCAD's own permit listing (`t4-tcad-permit-listing.mjs`, built from
 * the receipted capture; ruling 25.10) and links only when the listing records its permit number on exactly one current
 * account (`tcad_permit_listing`). A permit with zero or several candidates, or a malformed `tcad_id`, stays
 * valid-unlinked with its reason. The permit's own `PROP_ID` is never a link key (it prints none).
 *
 * The pass also measures the listing where both methods apply: on every exactly linked permit, how often TCAD lists it
 * on the same account (`tcad_permit_listing.overlap_with_exact`), and, on every listing link, whether TCAD's permit record
 * names the retired id the permit prints (`ref_property_roll`).
 *
 * The pass is the bulk path's "harvest by parcel": the same single pass that counts the link methods returns the rows
 * linked to any requested set of parcels (the pilot, the feasibility sample, or the whole roll in the full run).
 *
 *   node --max-old-space-size=12288 src/counties/travis/t4-permit-links.mjs [--capture <dir>] [--seed data/seeds/travis.csv] [--tcad-listing <dir>] [--out <report.json>]
 *
 * The TCAD listing defaults to the one built from the receipted special export (`t4-tcad-permit-listing.mjs`); the pass
 * stops when it is missing or no longer matches its index.
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
import { resolveTcadPermitListing } from "./t4-tcad-permit-listing.mjs";
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
  TCAD_ID_EVIDENCE_VERSION,
  PARCEL_LINK_VERSION,
  LINK_METHODS,
  classifyDateEvidence,
  classifyRoofWork,
  linkPermitToParcel,
  normalizeSourceValue,
  normalizeTcadIdDigits,
  normalizeWorkText,
  proveDigitsOnlyNormalization,
  summarizePermitRow,
} from "./permit-profile.mjs";

export const LINK_PASS_VERSION = "travis-t4-link-pass.v2";
/**
 * The README-impact measure of roof age (decisions.md section 25.10): a permit is anchor-eligible when the profile reads it
 * as a primary roof (replacement or new construction), its lifecycle is completed and its completion date is confirmed.
 * A parcel without one falls back to the built year (or to no age).
 */
export const ANCHOR_ELIGIBLE_RULE = "primary_roof_replacement or primary_roof_new_construction, lifecycle completed, completed_date confirmed_present";
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
 * @returns {Promise<{ byGeoId: Map<string, string[]>, byDigits: Map<string, string[]>, situsByPropId: Map<string, string>, geoIdByPropId: Map<string, string>, propIds: Set<string>, proof: ReturnType<typeof proveDigitsOnlyNormalization>, stats: Record<string, number>, seedSha256: string }>} Index.
 */
export async function readRollGeoIndex(seedPath) {
  /** @type {Map<string, string[]>} */
  const byGeoId = new Map();
  /** @type {Map<string, string[]>} */
  const byDigits = new Map();
  /** @type {Map<string, string>} */
  const situsByPropId = new Map();
  /** @type {Map<string, string>} */
  const geoIdByPropId = new Map();
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
    geoIdByPropId.set(propId, geoId);
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
    geoIdByPropId,
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
 * @param {import("./t4-tcad-permit-listing.mjs").TcadPermitListing | null} [options.tcadListing] - TCAD's permit listing (the `tcad_permit_listing` fallback); null disables it and is recorded.
 * @param {((item: { entry: any, link: any, profile: any, listingEntries: any }) => (void | Promise<void>)) | null} [options.onRow] - Called for every captured row, in capture order, after it is profiled and linked (the T5 full run streams the rows to disk here instead of selecting them in memory).
 * @returns {Promise<{ summary: Record<string, any>, selected: Map<string, any[]>, conflictingNumbers: Set<string>, tcadCounts: Map<string, { rows: number, by_unlinked_reason: Record<string, number> }> }>} Counts, the selected rows, the permit numbers printed on differing rows and the per-`tcad_id` counts.
 */
export async function runLinkPass({ captureDir, roll, asOfDate, select = null, reviewSamples = 40, countTcadIds = null, tcadListing = null, onRow = null }) {
  const started = performance.now();
  const digitsFallback = roll.proof.oneToOne ? { proof: roll.proof, parcelsByDigits: roll.byDigits } : null;
  const permitListing = tcadListing ? { version: tcadListing.version, sourceSha256: tcadListing.index.source.sha256, accountsFor: tcadListing.accountsFor, rollPropIds: roll.propIds } : null;
  /** @type {Map<string, any[]>} */
  const selected = new Map();
  /** @type {Map<string, { rows: number, by_unlinked_reason: Record<string, number> }>} */
  const tcadCounts = new Map();
  const counts = {
    rows: 0,
    by_permittype: {},
    link_method: Object.fromEntries(LINK_METHODS.map((method) => [method, 0])),
    unlinked_reasons: { no_candidate: 0, multiple_candidates: 0, invalid_quarantined: 0, out_of_county: 0 },
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
    roofing: { permits: 0, linked: 0, by_status_group: {}, by_status_group_linked: {}, by_class_linked: {}, linked_by_method: Object.fromEntries(LINK_METHODS.map((method) => [method, 0])), bp_rows: 0 },
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
  // The listing fallback (retired ids), its agreement with exact links, and the README-impact counters (decisions.md 25.10).
  // linked_ref_property_roll: what TCAD's own permit record on the linked account prints as `refPropertyRoll` (the roll id
  // the permit was imported under): the retired id the permit prints (the link reconciles to the printed target), the
  // linked account's current geo_id, blank, or another id.
  const retired = { permits: 0, linked: 0, listed_on_several_current_accounts: 0, listed_on_other_accounts_only: 0, not_listed: 0, linked_ref_property_roll: { printed: 0, linked_account_geo_id: 0, blank: 0, other: 0 }, linked_issue_date_equal: 0, linked_by_permittype: {} };
  const overlap = { exact_links: 0, listed_on_one_current_account: 0, agree: 0, listed_on_several_current_accounts: 0, several_include_the_linked_account: 0, listed_on_other_accounts_only: 0, not_listed: 0, ref_property_roll_equals_printed_when_listed_on_one: 0, agree_when_ref_property_roll_equals_printed: 0, by_permittype: {}, roofing: { listed_on_one_current_account: 0, agree: 0 } };
  const retiredRoofing = { permits: 0, linked: 0, open: 0, open_linked: 0, stalled: 0, stalled_linked: 0, anchor_eligible: 0, anchor_eligible_linked: 0 };
  /** @type {Set<string>} */
  const anchoredByGeoId = new Set();
  /** @type {Set<string>} */
  const anchoredByListing = new Set();
  /** @type {Set<string>} */
  const parcelsByGeoIdLink = new Set();
  /** @type {Set<string>} */
  const parcelsByListingLink = new Set();
  const currentAccounts = (number) => (tcadListing ? tcadListing.accountsFor(number).filter((propId) => roll.propIds.has(propId)) : []);
  const mappedStatuses = new Set([...OPEN_STATUSES, ...CLOSED_STATUSES, EXPIRED_STATUS].map(normalizeSourceValue));
  const observedUnmapped = new Set(OBSERVED_UNMAPPED_STATUSES.map(normalizeSourceValue));

  for await (const entry of streamCapturedPermits(captureDir)) {
    const { row } = entry;
    counts.rows += 1;
    const type = row.permittype || "(blank)";
    bump(counts.by_permittype, type);
    const summary = summarizePermitRow(row, { asOfDate });
    const link = linkPermitToParcel({ tcadId: row.tcad_id, parcelsByGeoId: roll.byGeoId, digitsFallback, permitNumber: row.permit_number, permitListing });
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
        bump(counts.roofing.by_status_group_linked, summary.statusGroup);
        bump(counts.roofing.by_class_linked, summary.roofWorkClass);
        counts.roofing.linked_by_method[link.propertyLink.match_method] += 1;
      }
    }
    /** @type {readonly { propId: string, refPropertyRoll: string, issueDate: string }[] | null} */
    let linkEvidence = null;
    const anchorEligible = (summary.roofWorkClass === "primary_roof_replacement" || summary.roofWorkClass === "primary_roof_new_construction") && summary.lifecycleStatus === "completed" && summary.completedDateEvidence.evidenceState === "confirmed_present";
    const method = link.propertyLink?.match_method ?? null;
    if (method === "exact" || method === "normalized_digits") {
      parcelsByGeoIdLink.add(link.propertyId);
      if (anchorEligible) anchoredByGeoId.add(link.propertyId);
      if (tcadListing) {
        overlap.exact_links += 1;
        const byType = (overlap.by_permittype[type] ??= { listed_on_one_current_account: 0, agree: 0 });
        const current = currentAccounts(row.permit_number);
        if (current.length === 1) {
          overlap.listed_on_one_current_account += 1;
          byType.listed_on_one_current_account += 1;
          if (summary.isRoofing) overlap.roofing.listed_on_one_current_account += 1;
          if (current[0] === link.propertyId) {
            overlap.agree += 1;
            byType.agree += 1;
            if (summary.isRoofing) overlap.roofing.agree += 1;
          }
          if (tcadListing.entriesFor(row.permit_number).some((item) => item.propId === current[0] && item.refPropertyRoll === tcad.value)) {
            overlap.ref_property_roll_equals_printed_when_listed_on_one += 1;
            if (current[0] === link.propertyId) overlap.agree_when_ref_property_roll_equals_printed += 1;
          }
        } else if (current.length > 1) {
          overlap.listed_on_several_current_accounts += 1;
          if (current.includes(link.propertyId)) overlap.several_include_the_linked_account += 1;
        } else if (tcadListing.accountsFor(row.permit_number).length > 0) overlap.listed_on_other_accounts_only += 1;
        else overlap.not_listed += 1;
      }
    }
    if (link.listing) {
      // A retired ten-digit id, read against the listing.
      retired.permits += 1;
      if (link.propertyId) {
        retired.linked += 1;
        parcelsByListingLink.add(link.propertyId);
        if (anchorEligible) anchoredByListing.add(link.propertyId);
        bump(retired.linked_by_permittype, type);
        const entries = tcadListing.entriesFor(row.permit_number).filter((item) => item.propId === link.propertyId);
        const refs = new Set(entries.map((item) => item.refPropertyRoll));
        if (refs.has(tcad.value)) retired.linked_ref_property_roll.printed += 1;
        else if (refs.has(roll.geoIdByPropId.get(link.propertyId) ?? "")) retired.linked_ref_property_roll.linked_account_geo_id += 1;
        else if ([...refs].every((ref) => ref === "")) retired.linked_ref_property_roll.blank += 1;
        else retired.linked_ref_property_roll.other += 1;
        if (entries.some((item) => item.issueDate !== "" && item.issueDate === row.issue_date.slice(0, 10))) retired.linked_issue_date_equal += 1;
        linkEvidence = entries;
      } else if (link.listing.current_accounts > 1) retired.listed_on_several_current_accounts += 1;
      else if (link.listing.listed_accounts > 0) retired.listed_on_other_accounts_only += 1;
      else retired.not_listed += 1;
      if (summary.isRoofing) {
        retiredRoofing.permits += 1;
        if (link.propertyId) retiredRoofing.linked += 1;
        if (summary.statusGroup === "open") {
          retiredRoofing.open += 1;
          if (link.propertyId) retiredRoofing.open_linked += 1;
        }
        if (summary.statusGroup === "stalled") {
          retiredRoofing.stalled += 1;
          if (link.propertyId) retiredRoofing.stalled_linked += 1;
        }
      }
      if (anchorEligible) {
        retiredRoofing.anchor_eligible += 1;
        if (link.propertyId) retiredRoofing.anchor_eligible_linked += 1;
      }
    }
    const typeLink = (counts.by_permittype_link[type] ??= { ...Object.fromEntries(LINK_METHODS.map((name) => [name, 0])), no_candidate: 0, multiple_candidates: 0, invalid_quarantined: 0, out_of_county: 0 });
    if (link.propertyId) {
      counts.link_method[link.propertyLink.match_method] += 1;
      typeLink[link.propertyLink.match_method] += 1;
      linkedParcels.add(link.propertyId);
      permitsPerParcel.set(link.propertyId, (permitsPerParcel.get(link.propertyId) ?? 0) + 1);
      if (select?.has(link.propertyId)) {
        (selected.get(link.propertyId) ?? selected.set(link.propertyId, []).get(link.propertyId)).push({ ...entry, link, profile: summary, listingEntries: linkEvidence });
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
    if (onRow) await onRow({ entry, link, profile: summary, listingEntries: linkEvidence });
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
  const linked = LINK_METHODS.reduce((sum, name) => sum + counts.link_method[name], 0);
  const anchored = new Set([...anchoredByGeoId, ...anchoredByListing]);
  const share = (part, whole) => (whole === 0 ? null : Math.round((part / whole) * 10000) / 10000);
  const roofingOpen = counts.roofing.by_status_group.open ?? 0;
  const roofingStalled = counts.roofing.by_status_group.stalled ?? 0;
  const listingSummary = tcadListing
    ? {
        listing_version: tcadListing.version,
        source: tcadListing.index.source,
        listing: { dir: path.relative(RUNTIME_ROOT, tcadListing.dir).split(path.sep).join("/"), sha256: tcadListing.index.listing.sha256, rows: tcadListing.index.listing.rows, permit_numbers: tcadListing.index.counts.permit_numbers, accounts_listing_permits: tcadListing.index.counts.accounts_listing_permits },
        precedence: "exact geo_id, then normalized_digits; the listing only for a ten-digit tcad_id that no current account prints, and only when it names exactly one current account; anything else stays no_candidate",
        retired: { ...retired, linked_parcels: parcelsByListingLink.size, parcels_linked_only_through_listing: [...parcelsByListingLink].filter((propId) => !parcelsByGeoIdLink.has(propId)).length },
        overlap_with_exact: { ...overlap, agreement_share: share(overlap.agree, overlap.listed_on_one_current_account), roofing: { ...overlap.roofing, agreement_share: share(overlap.roofing.agree, overlap.roofing.listed_on_one_current_account) } },
      }
    : { enabled: false, note: "no listing supplied: retired ids stay no_candidate" };
  const readmeImpact = {
    definitions: {
      not_on_a_property: "loaded internally and counted under limitations, never published on a property (README.md 13, 105, 110)",
      anchor_eligible: ANCHOR_ELIGIBLE_RULE,
    },
    roofing: { permits: counts.roofing.permits, linked: counts.roofing.linked, not_on_a_property: counts.roofing.permits - counts.roofing.linked, not_on_a_property_retired_geo_id: retiredRoofing.permits - retiredRoofing.linked },
    open_roofing: { permits: roofingOpen, linked: counts.roofing.by_status_group_linked.open ?? 0, not_on_a_property: roofingOpen - (counts.roofing.by_status_group_linked.open ?? 0), not_on_a_property_retired_geo_id: retiredRoofing.open - retiredRoofing.open_linked },
    stalled_roofing: { permits: roofingStalled, linked: counts.roofing.by_status_group_linked.stalled ?? 0, not_on_a_property: roofingStalled - (counts.roofing.by_status_group_linked.stalled ?? 0), not_on_a_property_retired_geo_id: retiredRoofing.stalled - retiredRoofing.stalled_linked },
    retired_geo_id_roofing: retiredRoofing,
    recovered_by_tcad_permit_listing: { permits: retired.linked, roofing: retiredRoofing.linked, open_roofing: retiredRoofing.open_linked, stalled_roofing: retiredRoofing.stalled_linked, anchor_eligible: retiredRoofing.anchor_eligible_linked },
    roof_age_anchor: {
      seed_parcels: roll.stats.seed_rows,
      parcels_with_an_anchor_through_geo_id: anchoredByGeoId.size,
      parcels_with_an_anchor: anchored.size,
      parcels_whose_anchor_comes_only_through_the_listing: anchored.size - anchoredByGeoId.size,
      parcels_without_a_permit_anchor: roll.stats.seed_rows - anchored.size,
      anchor_eligible_permits_unlinked_on_retired_geo_ids: retiredRoofing.anchor_eligible - retiredRoofing.anchor_eligible_linked,
      note: "a parcel without a permit anchor falls back to the built year (low confidence) or to no age; the anchor-eligible permits that stay unlinked sit on parcels no public source names, so at most that many more parcels fall back because of them",
    },
  };
  const summary = {
    link_pass_version: LINK_PASS_VERSION,
    versions: { status_group: STATUS_GROUP_VERSION, lifecycle: LIFECYCLE_MAPPING_VERSION, work_classifier: WORK_CLASSIFIER_VERSION, date_evidence: DATE_EVIDENCE_VERSION, tcad_id_normalization: TCAD_ID_NORMALIZATION_VERSION, tcad_id_evidence: TCAD_ID_EVIDENCE_VERSION, parcel_link: PARCEL_LINK_VERSION, tcad_permit_listing: tcadListing ? tcadListing.version : null },
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
      note: "tcad_id printed in the Williamson CAD account form (R + 6 digits) or as WCAD: another county's parcel id; tcad_id evidence invalid_quarantined, unlinked reason out_of_county (travis-parcel-link-v2, decisions.md section 25.6), outside the Travis parcel population; north_of_30_40 counts the rows with coordinates north of latitude 30.40",
    },
    ten_digit_not_in_roll: {
      rows: notInRoll.rows,
      distinct_geo_ids: notInRoll.distinct.size,
      by_issue_decade: notInRoll.by_issue_decade,
      note: "a 10-digit tcad_id that no 2026 roll account prints: a geo_id retired since the permit, for example a tract later subdivided; it links only through TCAD's permit listing when that names exactly one current account (tcad_permit_listing, travis-parcel-link-v3, decisions.md section 25.10), else it stays no_candidate; rows counts every such permit, linked or not",
    },
    tcad_permit_listing: listingSummary,
    readme_impact: readmeImpact,
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
    if (!argv[index].startsWith("--") || argv[index + 1] === undefined) throw new Error("usage: t4-permit-links.mjs [--capture <dir>] [--seed <csv>] [--tcad-listing <dir>] [--as-of YYYY-MM-DD] [--out <report.json>]");
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
  const tcadListing = await resolveTcadPermitListing({ dir: flags["tcad-listing"] ? path.resolve(flags["tcad-listing"]) : null });
  const rollStarted = performance.now();
  const roll = await readRollGeoIndex(seedPath);
  const rollMs = performance.now() - rollStarted;
  const { summary } = await runLinkPass({ captureDir, roll, asOfDate, tcadListing });
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
      tcad_permit_listing: { retired: report.tcad_permit_listing.retired.permits, linked: report.tcad_permit_listing.retired.linked, overlap_agreement: report.tcad_permit_listing.overlap_with_exact.agreement_share },
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
