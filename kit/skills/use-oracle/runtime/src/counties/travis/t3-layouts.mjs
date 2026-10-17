/**
 * Offline check of the Comptroller record layouts against the privacy rule (`PRIVACY_VERSION` in t3-sources.mjs;
 * assignment decisions.md section 24.4). The layouts (the Socrata attachments of `jrea-zgmq` and `9cir-efmm`) define the
 * organization type codes and the taxpayer number forms; the rule withholds the number of every sole-owner row
 * (`INDIVIDUAL_OWNER_TYPES`) and treats no other type as a natural person. The check reads the code table and the
 * number-form statements and reports any change: a sole-owner code the rule does not withhold, a withheld code described
 * otherwise, a code the data prints that the layout lacks, or a visible number with the SSN-based leading 2.
 *
 * Text comes from the DOCX's `word/document.xml` (adm-zip) or from `pdftotext -layout` (poppler) for a PDF. No request
 * is sent. Until the layouts are captured the check reports `awaiting_capture`.
 *
 * @module counties/travis/t3-layouts
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import AdmZip from "adm-zip";

import { INDIVIDUAL_OWNER_TYPES, PRIVACY_VERSION } from "./t3-sources.mjs";

export const LAYOUT_CHECK_VERSION = "travis-t3-layout-check.v1";
const execFileAsync = promisify(execFile);
const SOLE_OWNER = /\b(sole\s+(owner|proprietor(ship)?)|proprietorship|individual(?!s)\b(?!.*\b(partnership|corporation|trust|estate|association|company)\b))/i;
const MENTIONS_INDIVIDUALS = /\b(individuals?|natural\s+persons?|sole\s+(owner|proprietor\w*)|IND)\b/i;
const NUMBER_FORM = /(taxpayer\s+(id|number|no)|social\s+security|\bssn\b|\bfein\b|employer\s+identification|first\s+digit|comptroller[-\s]assigned)/i;
const SSN = /(social\s+security|\bssn\b)/i;

/**
 * @param {string} xml - WordprocessingML.
 * @returns {string} Its text, one paragraph or table row per line, cells separated by tabs.
 */
export function docxXmlToText(xml) {
  return xml
    .replace(/<w:tab\/>/g, "\t")
    // A paragraph that closes a table cell ends the cell, not the line.
    .replace(/<\/w:p>\s*<\/w:tc>/g, "</w:tc>")
    .replace(/<\/w:tc>/g, "\t")
    .replace(/<\/w:p>|<\/w:tr>|<w:br\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\t+\n/g, "\n")
    // Runs of spaces are kept: the layouts separate a code from its description by them.
    .replace(/\u00a0/g, " ");
}

/**
 * Text of a layout document.
 *
 * @param {string} file - PDF or DOCX.
 * @returns {Promise<{ text: string, method: string }>} Text and how it was read.
 */
export async function extractLayoutText(file) {
  const head = (await readFile(file)).subarray(0, 5);
  if (head.toString("latin1").startsWith("%PDF-")) {
    try {
      const { stdout } = await execFileAsync("pdftotext", ["-layout", file, "-"], { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
      return { text: stdout, method: "pdftotext -layout" };
    } catch (error) {
      throw new Error(`cannot read ${path.basename(file)} with pdftotext (poppler): ${error instanceof Error ? error.message : error}`);
    }
  }
  if (head[0] === 0x50 && head[1] === 0x4b) {
    const entry = new AdmZip(file).getEntry("word/document.xml");
    if (!entry) throw new Error(`${path.basename(file)} is a zip without word/document.xml`);
    return { text: docxXmlToText(entry.getData().toString("utf8")), method: "docx word/document.xml" };
  }
  throw new Error(`${path.basename(file)} is neither a PDF nor a DOCX`);
}

/** The heading of the organization code table in both Comptroller layouts. */
const ORGANIZATION_HEADING = /^\s*Taxpayer\s+Organi[sz]ation(?:al)?\s+Type\s*:\s*$/i;
/** A code row: a one- or two-letter code, then two or more spaces (or a tab, or a dash, equals sign or colon). */
const CODE_ROW = /^\s*([A-Z]{1,2})(?:\s{2,}|\t+|\s*[-\u2013\u2014=:]\s+)(\S.*?)\s*$/;

/**
 * The organization codes of a layout, read only from its "Taxpayer Organization(al) Type:" section: the rows after the
 * heading (blank lines skipped) until the first non-blank line that is not a code row. The later one-letter tables of the
 * same documents (record type, SOS status, inside city limits) are never read as organization codes.
 *
 * @param {string} text - Layout text.
 * @returns {Record<string, string>} Code to its description (whitespace collapsed); empty when there is no such section.
 */
export function findOrganizationCodes(text) {
  /** @type {Record<string, string>} */
  const codes = {};
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => ORGANIZATION_HEADING.test(line));
  if (start < 0) return codes;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") continue;
    const match = CODE_ROW.exec(line);
    if (!match || !/[A-Za-z]/.test(match[2])) break;
    codes[match[1]] ??= match[2].replace(/\s+/g, " ").trim();
  }
  return codes;
}

/**
 * @param {string} text - Layout text.
 * @returns {string[]} Lines that state number forms (taxpayer number, SSN, FEIN, first digit), trimmed to 240 characters.
 */
export function findNumberForms(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "" && NUMBER_FORM.test(line))
    .map((line) => line.slice(0, 240));
}

/**
 * Compare one layout with the privacy rule and the codes the data prints.
 *
 * @param {object} params - Inputs.
 * @param {string} params.datasetId - Dataset id.
 * @param {Record<string, string>} params.codes - Codes from {@link findOrganizationCodes}.
 * @param {string[]} params.numberForms - Lines from {@link findNumberForms}.
 * @param {Record<string, number>} params.observed - Organization codes the loaded data prints, with row counts.
 * @param {boolean} params.governsTheRule - Whether this dataset is the one the rule classes (the sales-tax file).
 * @param {Record<string, Record<string, number>>} [params.firstDigits] - Rows by organization code and first digit of the
 *   printed taxpayer number, for the codes the rule does not withhold (from the snapshot, where those numbers are kept).
 * @returns {Record<string, any>} Findings and `changes[]` (empty when consistent).
 */
export function compareLayout({ datasetId, codes, numberForms, observed, governsTheRule, firstDigits = {} }) {
  const soleOwnerCodes = Object.entries(codes).filter(([, description]) => SOLE_OWNER.test(description)).map(([code]) => code).sort();
  const mentionsIndividuals = Object.entries(codes).filter(([, description]) => MENTIONS_INDIVIDUALS.test(description)).map(([code, description]) => ({ code, description }));
  const observedMissing = Object.keys(observed).filter((code) => code !== "(null)" && !(code in codes)).sort();
  const ssnLines = numberForms.filter((line) => SSN.test(line));
  const changes = [];
  if (Object.keys(codes).length === 0) changes.push("no organization code table found in the layout text (read it by hand)");
  if (governsTheRule) {
    for (const code of soleOwnerCodes) if (!INDIVIDUAL_OWNER_TYPES.includes(code)) changes.push(`${code} is described as a sole owner or individual (${codes[code]}) but the rule does not withhold it`);
    for (const code of INDIVIDUAL_OWNER_TYPES) if (code in codes && !soleOwnerCodes.includes(code)) changes.push(`${code} is described as "${codes[code]}", not as a sole owner`);
    for (const code of INDIVIDUAL_OWNER_TYPES) if (!(code in codes) && Object.keys(codes).length > 0) changes.push(`${code} is not in the layout's code table`);
  } else {
    for (const code of soleOwnerCodes) if ((observed[code] ?? 0) > 0) changes.push(`${code} is described as a sole owner or individual (${codes[code]}) and the data prints ${observed[code]} rows of it`);
  }
  if (observedMissing.length > 0 && Object.keys(codes).length > 0) changes.push(`codes the data prints but the layout does not list: ${observedMissing.join(", ")}`);
  // A number the rule leaves visible must not have the SSN-based form (leading 2).
  const ssnFormVisible = Object.entries(firstDigits).filter(([code, digits]) => !INDIVIDUAL_OWNER_TYPES.includes(code) && (digits["2"] ?? 0) > 0);
  for (const [code, digits] of ssnFormVisible) changes.push(`${digits["2"]} ${code} rows print a taxpayer number with the leading 2 of SSN-based numbers and are not withheld`);
  return {
    dataset_id: datasetId,
    governs_the_rule: governsTheRule,
    codes_found: Object.keys(codes).length,
    codes,
    sole_owner_codes: soleOwnerCodes,
    codes_mentioning_individuals: mentionsIndividuals,
    observed_codes: Object.keys(observed).filter((code) => code !== "(null)").length,
    observed_codes_missing_from_layout: observedMissing,
    number_form_lines: numberForms,
    ssn_lines: ssnLines,
    first_digits_of_visible_numbers: firstDigits,
    changes,
  };
}

/**
 * The newest captured layout of each dataset under the window directory.
 *
 * @param {string} windowDir - Window directory.
 * @returns {Promise<{ dir: string, files: Record<string, any>[] } | null>} Capture, or null when none exists.
 */
export async function latestLayoutCapture(windowDir) {
  const base = path.join(windowDir, "comptroller-record-layouts");
  if (!existsSync(base)) return null;
  const dirs = (await readdir(base, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^d\d{8}$/.test(entry.name)).map((entry) => entry.name).sort().reverse();
  for (const name of dirs) {
    const dir = path.join(base, name);
    const resolutions = (await readdir(dir)).filter((file) => /^resolution-.*\.json$/.test(file)).sort().reverse();
    for (const resolution of resolutions) {
      const record = JSON.parse(await readFile(path.join(dir, resolution), "utf8"));
      const files = record.datasets.flatMap((entry) => entry.files.filter((file) => file.kept).map((file) => ({ dataset_id: entry.dataset_id, file: file.kept })));
      if (files.length > 0) return { dir, files };
    }
  }
  return null;
}

/**
 * Run the check.
 *
 * @param {object} params - Inputs.
 * @param {string} params.windowDir - Window directory.
 * @param {Record<string, Record<string, number>>} params.observedByDataset - Organization codes per dataset id.
 * @param {Record<string, Record<string, Record<string, number>>>} [params.firstDigitsByDataset] - Visible numbers' first
 *   digits by organization code, per dataset id.
 * @returns {Promise<Record<string, any>>} `status`: `awaiting_capture`, `partial`, `unreadable`, `consistent` or `differs`.
 */
export async function checkRecordLayouts({ windowDir, observedByDataset, firstDigitsByDataset = {} }) {
  const base = { check_version: LAYOUT_CHECK_VERSION, privacy_rule: PRIVACY_VERSION, individual_owner_types: [...INDIVIDUAL_OWNER_TYPES] };
  const capture = await latestLayoutCapture(windowDir);
  if (!capture) return { ...base, status: "awaiting_capture", detail: "no record layout captured yet; the window command fetches them with the TSBPE re-run" };
  const layouts = [];
  const unreadable = [];
  for (const { dataset_id: datasetId, file } of capture.files) {
    try {
      const { text, method } = await extractLayoutText(path.join(capture.dir, file));
      layouts.push({ file, method, characters: text.length, ...compareLayout({ datasetId, codes: findOrganizationCodes(text), numberForms: findNumberForms(text), observed: observedByDataset[datasetId] ?? {}, governsTheRule: datasetId === "jrea-zgmq", firstDigits: firstDigitsByDataset[datasetId] ?? {} }) });
    } catch (error) {
      unreadable.push({ dataset_id: datasetId, file, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const missing = Object.keys(observedByDataset).filter((id) => !capture.files.some((file) => file.dataset_id === id));
  const changes = layouts.flatMap((layout) => layout.changes.map((change) => `${layout.dataset_id}: ${change}`));
  const status = unreadable.length > 0 ? "unreadable" : missing.length > 0 ? "partial" : changes.length > 0 ? "differs" : "consistent";
  return { ...base, status, capture: capture.dir, layouts, unreadable, datasets_without_layout: missing, changes };
}
