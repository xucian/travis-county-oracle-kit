/**
 * Travis County (TX) permit transform: one parcel's linked Austin permits (from the T4 link pass over the bulk Socrata
 * capture) to the kit's per-property output contract for the Property Improvement data group
 * (`skills/build-county-transform/reference/output-contract.md`):
 *
 * - one `property_improvement` per permit and one `property_has_property_improvement` per permit (the carrying
 *   one-to-many link; assignment decisions.md section 16); no `parcel_has_property_improvement` (single-valued per root,
 *   and no permit is "the" parcel's permit),
 * - the Seed root with `address_has_parcel` only, and `property.json`, `address.json`, `parcel.json` and the Seed
 *   relationship copied byte for byte from the same parcel's appraisal transform, so the Seed root, and with it the
 *   property CID, is the same in the County and the Property Improvement archives (decisions.md section 22),
 * - the Property Improvement root named by the live manifest's schema CID.
 *
 * Fields (all printed facts; nothing classified from free text is published, decisions.md section 16):
 * `permit_number` as printed; `application_received_date` from `applieddate`, `permit_issue_date` from `issue_date` and
 * `completion_date` from `completed_date`, each only when the profile's date evidence is `confirmed_present`;
 * `permit_close_date` from `statusdate` only when `status_current` is `Final` (the profile's close-date rule). The four
 * enum properties the class requires (`improvement_type`, `improvement_status`, `improvement_action`,
 * `contractor_type`) come from the profile's exact-value tables (`travis-improvement-enums-v1`, decisions.md section
 * 25.7): an unlisted printed value is null. Provenance: `source_http_request` is the partition GET that captured the row (method, URL,
 * query; never reconstructed), `request_identifier` the linked parcel's PROP_ID as printed (decisions.md section 3).
 *
 * Everything without a lexicon home (description, printed status, expiry, permit class and work class, the printed
 * contractor fields, coordinates, the public permit page, valuations, the profile's classification and evidence, the
 * link and its evidence - for a `tcad_permit_listing` link, TCAD's listed entries on the linked account - and the row
 * digest and locator) goes to the sidecar `permit-source-payload.json` beside `data/`, never into the archive.
 *
 * A permit number printed on two rows that differ is `conflicting`: both rows stay in the sidecar and neither is
 * written into the group. Identical repeated rows are written once.
 *
 * @module counties/travis/transforms/permit-transform
 */

import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { IMPROVEMENT_ENUMS_VERSION, classifyDateEvidence, classifyLifecycleStatus, mapImprovementEnums } from "../../../src/counties/travis/permit-profile.mjs";

export const PERMIT_TRANSFORM_VERSION = "travis-permit-transform-v2";
export const PERMIT_SOURCE_PAYLOAD_FILENAME = "permit-source-payload.json";
export const PERMIT_DATA_DIRNAME = "permit-data";
/** Files the permit group copies from the parcel's appraisal output (byte for byte). */
export const COPIED_FROM_APPRAISAL = Object.freeze(["property.json", "address.json", "parcel.json", "relationship_address_has_parcel.json"]);
/** The enum properties the class requires, filled by {@link mapImprovementEnums} (null when the printed value is unlisted). */
export const REQUIRED_ENUMS = Object.freeze(["improvement_type", "improvement_status", "improvement_action", "contractor_type"]);

/**
 * Resolve the Property Improvement and Seed schema CIDs from a live manifest (or the `{entries}` wrapper).
 *
 * @param {Record<string, any>} manifest - Lexicon manifest.
 * @returns {{ propertyImprovementCid: string, seedCid: string }} Root names.
 */
export function resolvePermitGroupCids(manifest) {
  const entries = manifest && typeof manifest === "object" && "entries" in manifest ? manifest.entries : manifest;
  const group = entries?.Property_Improvement?.ipfsCid;
  const seed = entries?.Seed?.ipfsCid;
  if (typeof group !== "string" || typeof seed !== "string") throw new Error("lexicon manifest must carry Property_Improvement and Seed data-group entries");
  return { propertyImprovementCid: group, seedCid: seed };
}

/** @param {string} name @returns {{ "/": string }} */
const link = (name) => ({ "/": `./${name}` });

/**
 * @param {Record<string, any>} request - The partition receipt's `source_http_request`.
 * @returns {{ method: string, url: string, multiValueQueryString?: Record<string, string[]> }} Lexicon request.
 */
function lexiconRequest(request) {
  if (!request || typeof request.url !== "string" || request.url === "") throw new Error("permit row has no capture request (the partition GET actually made)");
  const result = { method: request.method ?? "GET", url: request.url };
  if (request.multiValueQueryString && Object.keys(request.multiValueQueryString).length > 0) result.multiValueQueryString = request.multiValueQueryString;
  return result;
}

/**
 * The lexicon dates of one permit row (confirmed evidence only).
 *
 * @param {Record<string, string>} row - Printed row.
 * @param {string} asOfDate - `YYYY-MM-DD`.
 * @returns {{ fields: Record<string, string | null>, evidence: Record<string, any> }} Dates and the evidence behind them.
 */
export function permitDates(row, asOfDate) {
  const applied = classifyDateEvidence(row.applieddate, { asOfDate });
  const notBefore = applied.evidenceState === "confirmed_present" ? applied.value : null;
  const issued = classifyDateEvidence(row.issue_date, { asOfDate, notBefore });
  const completed = classifyDateEvidence(row.completed_date, { asOfDate, notBefore });
  const final = classifyLifecycleStatus(row.status_current) === "completed";
  const closed = final ? classifyDateEvidence(row.statusdate, { asOfDate, notBefore }) : null;
  const value = (evidence) => (evidence && evidence.evidenceState === "confirmed_present" ? evidence.value : null);
  return {
    fields: { application_received_date: value(applied), permit_issue_date: value(issued), completion_date: value(completed), permit_close_date: value(closed) },
    evidence: { applieddate: applied, issue_date: issued, completed_date: completed, statusdate_final: closed },
  };
}

/**
 * Group one parcel's linked rows by permit number: identical repeats collapse, differing repeats are conflicting.
 *
 * @param {{ row: Record<string, string>, rowSha256: string }[]} entries - Linked rows.
 * @param {Set<string>} [conflictingNumbers] - Numbers the link pass found on differing rows anywhere in the capture.
 * @returns {{ publishable: any[], conflicting: any[], identicalRepeats: number }} Partition of the rows.
 */
export function partitionPermits(entries, conflictingNumbers = new Set()) {
  /** @type {Map<string, any[]>} */
  const byNumber = new Map();
  for (const entry of entries) {
    const number = String(entry.row.permit_number ?? "").trim();
    (byNumber.get(number) ?? byNumber.set(number, []).get(number)).push(entry);
  }
  const publishable = [];
  const conflicting = [];
  let identicalRepeats = 0;
  for (const [number, group] of byNumber) {
    const digests = new Set(group.map((entry) => entry.rowSha256));
    if (number === "") conflicting.push(...group.map((entry) => ({ ...entry, excluded: "blank_permit_number" })));
    else if (digests.size > 1 || conflictingNumbers.has(number)) conflicting.push(...group.map((entry) => ({ ...entry, excluded: "conflicting_permit_number" })));
    else {
      publishable.push(group[0]);
      identicalRepeats += group.length - 1;
    }
  }
  publishable.sort((left, right) => String(left.row.permit_number).localeCompare(String(right.row.permit_number)) || left.file.localeCompare(right.file) || left.index - right.index);
  return { publishable, conflicting, identicalRepeats };
}

/**
 * Build the Property Improvement files of one parcel (without the copied appraisal files).
 *
 * @param {object} input - Inputs.
 * @param {string} input.propId - PROP_ID as printed.
 * @param {any[]} input.entries - The parcel's linked rows from the link pass (`row`, `rowSha256`, `request`, `fetchedAt`, `file`, `index`, `link`, `profile`).
 * @param {Record<string, any>} input.manifest - Lexicon manifest.
 * @param {string} input.seedRootName - The Seed root file name of the appraisal output (`<seedCid>.json`).
 * @param {string} input.asOfDate - `YYYY-MM-DD`.
 * @param {Set<string>} [input.conflictingNumbers] - Conflicting permit numbers of the whole capture.
 * @returns {{ files: Record<string, object>, sourcePayload: object, roots: { propertyImprovementCid: string, seedCid: string }, published: number, conflicting: number, identicalRepeats: number }} Output.
 */
export function buildTravisPermitOutput({ propId, entries, manifest, seedRootName, asOfDate, conflictingNumbers = new Set() }) {
  if (!/^\d{1,12}$/.test(String(propId))) throw new Error(`propId must be the printed PROP_ID, got ${String(propId)}`);
  const roots = resolvePermitGroupCids(manifest);
  if (seedRootName !== `${roots.seedCid}.json`) throw new Error(`appraisal Seed root ${seedRootName} is not the manifest's Seed ${roots.seedCid}`);
  for (const entry of entries) {
    if (entry.link?.propertyId !== propId) throw new Error(`permit ${entry.row?.permit_number} is linked to ${entry.link?.propertyId}, not ${propId}`);
  }
  const { publishable, conflicting, identicalRepeats } = partitionPermits(entries, conflictingNumbers);
  /** @type {Record<string, object>} */
  const files = {};
  const relationships = [];
  const payloadPermits = [];
  publishable.forEach((entry, position) => {
    const ordinal = position + 1;
    const name = `property_improvement_${ordinal}.json`;
    const { fields, evidence } = permitDates(entry.row, asOfDate);
    files[name] = {
      permit_number: String(entry.row.permit_number).trim(),
      application_received_date: fields.application_received_date,
      permit_issue_date: fields.permit_issue_date,
      completion_date: fields.completion_date,
      permit_close_date: fields.permit_close_date,
      final_inspection_date: null,
      ...mapImprovementEnums(entry.row),
      source_http_request: lexiconRequest(entry.request),
      request_identifier: propId,
    };
    const relationshipName = `relationship_property_has_property_improvement_${ordinal}.json`;
    files[relationshipName] = { from: link("property.json"), to: link(name) };
    relationships.push(link(relationshipName));
    payloadPermits.push({ file: name, ...payloadOf(entry, evidence) });
  });
  if (publishable.length > 0) {
    files[`${roots.propertyImprovementCid}.json`] = { label: "Property Improvement", relationships: { property_has_property_improvement: relationships } };
  }
  const sourcePayload = {
    schemaVersion: "travis.permit-source-payload.v1",
    permit_transform_version: PERMIT_TRANSFORM_VERSION,
    improvement_enums_version: IMPROVEMENT_ENUMS_VERSION,
    prop_id: propId,
    as_of_date: asOfDate,
    published: payloadPermits,
    excluded: conflicting.map((entry) => ({ excluded: entry.excluded, ...payloadOf(entry, permitDates(entry.row, asOfDate).evidence) })),
    identical_repeats_collapsed: identicalRepeats,
  };
  return { files, sourcePayload, roots, published: publishable.length, conflicting: conflicting.length, identicalRepeats };
}

/**
 * The sidecar record of one row: everything printed, the profile's view, the link and the capture locator.
 *
 * @param {any} entry - Linked row.
 * @param {Record<string, any>} dateEvidence - From {@link permitDates}.
 * @returns {object} Sidecar record.
 */
function payloadOf(entry, dateEvidence) {
  return {
    permit_number: String(entry.row.permit_number ?? "").trim(),
    printed: entry.row,
    profile: entry.profile ?? null,
    date_evidence: dateEvidence,
    link: { property_id: entry.link.propertyId, property_link: entry.link.propertyLink, tcad_id_evidence: entry.link.tcadIdEvidence, listing: entry.link.listing ?? null, listing_entries: entry.listingEntries ?? null },
    capture: { file: entry.file, row_index: entry.index, row_sha256: entry.rowSha256, receipt_sha256: entry.receiptSha256 ?? null, fetched_at: entry.fetchedAt, source_http_request: entry.request },
  };
}

/**
 * Write one parcel's Property Improvement group under `<parcelDir>/permit-data/` (copying the appraisal files) and the
 * sidecar beside it. A parcel with no publishable permit gets no `permit-data/` directory.
 *
 * @param {object} options - Options.
 * @param {string} options.parcelDir - The parcel's run directory (holds the appraisal `data/`).
 * @param {string} options.propId - PROP_ID.
 * @param {any[]} options.entries - Linked rows.
 * @param {Record<string, any>} options.manifest - Lexicon manifest.
 * @param {string} options.asOfDate - `YYYY-MM-DD`.
 * @param {Set<string>} [options.conflictingNumbers] - Conflicting permit numbers.
 * @param {string} [options.dataDirName] - Directory name for the group under `parcelDir` (a runner writes a staging name and renames it once the checks pass).
 * @returns {Promise<{ dataDir: string | null, files: string[], published: number, conflicting: number, identicalRepeats: number, roots: { propertyImprovementCid: string, seedCid: string }, sourcePayloadPath: string }>} Result.
 */
export async function writeTravisPermitTransform({ parcelDir, propId, entries, manifest, asOfDate, conflictingNumbers, dataDirName = PERMIT_DATA_DIRNAME }) {
  const appraisalData = path.join(parcelDir, "data");
  const roots = resolvePermitGroupCids(manifest);
  const seedRootName = `${roots.seedCid}.json`;
  const present = new Set(await readdir(appraisalData));
  for (const name of [...COPIED_FROM_APPRAISAL, seedRootName]) if (!present.has(name)) throw new Error(`appraisal output of ${propId} has no data/${name}`);
  const built = buildTravisPermitOutput({ propId, entries, manifest, seedRootName, asOfDate, conflictingNumbers });
  const sourcePayloadPath = path.join(parcelDir, PERMIT_SOURCE_PAYLOAD_FILENAME);
  await writeFile(sourcePayloadPath, `${JSON.stringify(built.sourcePayload, null, 2)}\n`, "utf8");
  if (built.published === 0) return { dataDir: null, files: [], published: 0, conflicting: built.conflicting, identicalRepeats: built.identicalRepeats, roots: built.roots, sourcePayloadPath };
  const dataDir = path.join(parcelDir, dataDirName);
  await mkdir(dataDir, { recursive: true });
  for (const name of [...COPIED_FROM_APPRAISAL, seedRootName]) await copyFile(path.join(appraisalData, name), path.join(dataDir, name));
  for (const [name, body] of Object.entries(built.files)) await writeFile(path.join(dataDir, name), `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return { dataDir, files: [...COPIED_FROM_APPRAISAL, seedRootName, ...Object.keys(built.files)].sort(), published: built.published, conflicting: built.conflicting, identicalRepeats: built.identicalRepeats, roots: built.roots, sourcePayloadPath };
}
