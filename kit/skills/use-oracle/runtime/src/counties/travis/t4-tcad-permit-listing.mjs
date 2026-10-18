#!/usr/bin/env node
/**
 * TCAD's own permit listing (assignment decisions.md section 25.10, option B, approved by the operator on 2026-10-18):
 * the permits TCAD records on each account (`permits[]` of the 2026 Certified Special Export, JSON), turned into a
 * permit-number index that the link pass reads as the evidence of the `tcad_permit_listing` link method
 * (`permit-profile.mjs` `linkPermitToParcel`: exact `geo_id` first; the listing only for a retired ten-digit id; exactly
 * one current account, else unlinked).
 *
 * Offline. The source is the capture already on disk with its receipt (`data/travis/t4-rulings/lineage/`, fetched
 * 2026-10-18 from traviscad.org for the 25.10 study): its byte count and SHA-256 are checked against the receipt before
 * anything is read, and nothing is fetched. The index keeps, per listed (permit, account) pair, the permit number exactly as
 * TCAD prints it (trimmed), the account's `pID`, TCAD's `refPropertyRoll` (the roll id the permit was imported under) and
 * the issue date, so the link pass can check each fallback link against the id the permit prints.
 *
 *   node --max-old-space-size=8192 src/counties/travis/t4-tcad-permit-listing.mjs [--zip <special-export.zip>] [--receipts <receipts.jsonl>] [--out-root <dir>]
 *
 * Output: `data/travis/tcad-permit-listing/<first 16 hex of the zip SHA-256>/{listing.tsv,index.json}`; `index.json` holds
 * the source receipt, the counts and the SHA-256 of `listing.tsv`, which {@link loadTcadPermitListing} rechecks.
 *
 * @module counties/travis/t4-tcad-permit-listing
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { TCAD_PERMIT_LISTING_VERSION } from "./permit-profile.mjs";
import { RUNTIME_ROOT } from "./t3-snapshot.mjs";

export { TCAD_PERMIT_LISTING_VERSION };
export const TCAD_PERMIT_LISTING_SCHEMA = "travis.tcad-permit-listing.v1";
export const LINEAGE_DIR = path.join(RUNTIME_ROOT, "data", "travis", "t4-rulings", "lineage");
export const SPECIAL_EXPORT_FILE = "2026-certified-json-supp-0.zip";
export const DEFAULT_ZIP = path.join(LINEAGE_DIR, SPECIAL_EXPORT_FILE);
export const DEFAULT_RECEIPTS = path.join(LINEAGE_DIR, "receipts.jsonl");
export const DEFAULT_LISTING_ROOT = path.join(RUNTIME_ROOT, "data", "travis", "tcad-permit-listing");
export const LISTING_FILE = "listing.tsv";
export const INDEX_FILE = "index.json";
export const LISTING_HEADER = ["permit_number", "prop_id", "ref_property_roll", "issue_date"];

const rel = (target) => path.relative(RUNTIME_ROOT, target).split(path.sep).join("/");

/**
 * Open one zip member through `tar -xOf` (libarchive reads zip64).
 *
 * @param {string} zipPath - Zip file.
 * @param {string | null} [member] - Member name (all members when null).
 * @returns {{ stream: import("node:stream").Readable, exited: Promise<number | null> }} Member bytes and tar's exit code.
 */
export function openZipMember(zipPath, member = null) {
  const child = spawn("tar", ["-xOf", zipPath, ...(member ? [member] : [])], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  return { stream: child.stdout, exited };
}

/**
 * Stream one zip member through `tar -xOf`.
 *
 * @param {string} zipPath - Zip file.
 * @param {string | null} [member] - Member name (all members when null).
 * @returns {import("node:stream").Readable} Member bytes.
 */
export const zipMemberStream = (zipPath, member = null) => openZipMember(zipPath, member).stream;

/**
 * Split a top-level JSON array into its element texts (string-aware brace depth), calling `onObject` for each.
 *
 * @param {import("node:stream").Readable} stream - JSON text.
 * @param {(text: string) => void} onObject - Element handler.
 * @returns {Promise<number>} Elements seen.
 */
export async function forEachArrayElement(stream, onObject) {
  stream.setEncoding("utf8");
  let depth = 0;
  let inString = false;
  let escaped = false;
  let buffer = "";
  let start = -1;
  let count = 0;
  for await (const chunk of stream) {
    const base = buffer.length;
    buffer += chunk;
    for (let index = base; index < buffer.length; index += 1) {
      const code = buffer.charCodeAt(index);
      if (inString) {
        if (escaped) escaped = false;
        else if (code === 92) escaped = true;
        else if (code === 34) inString = false;
        continue;
      }
      if (code === 34) inString = true;
      else if (code === 123 || code === 91) {
        depth += 1;
        if (depth === 2 && code === 123) start = index;
      } else if (code === 125 || code === 93) {
        if (depth === 2 && code === 125 && start >= 0) {
          onObject(buffer.slice(start, index + 1));
          count += 1;
          start = -1;
        }
        depth -= 1;
      }
    }
    if (start >= 0) {
      buffer = buffer.slice(start);
      start = 0;
    } else buffer = "";
  }
  if (depth !== 0 || inString) throw new Error("the JSON array ends early (truncated stream)");
  return count;
}

/**
 * The receipt of a captured file: the last answered (HTTP 200) whole-file receipt naming it.
 *
 * @param {string} receiptsPath - `receipts.jsonl`.
 * @param {string} file - File name as the receipt records it.
 * @returns {Promise<Record<string, any>>} Receipt.
 */
export async function receiptFor(receiptsPath, file) {
  const receipts = (await readFile(receiptsPath, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
    .filter((receipt) => receipt.file === file && receipt.status === 200 && receipt.kind === "file" && !receipt.range);
  const receipt = receipts.at(-1);
  if (!receipt) throw new Error(`${path.basename(receiptsPath)} has no answered receipt for ${file}`);
  if (typeof receipt.sha256 !== "string" || !Number.isInteger(receipt.bytes)) throw new Error(`the receipt for ${file} has no sha256 or byte count`);
  return receipt;
}

/**
 * Check a captured file against its receipt (byte count, then the SHA-256 of every byte).
 *
 * @param {string} filePath - Captured file.
 * @param {Record<string, any>} receipt - Its receipt.
 * @returns {Promise<{ bytes: number, sha256: string }>} The verified size and digest.
 */
export async function verifyAgainstReceipt(filePath, receipt) {
  const { size } = await stat(filePath);
  if (size !== receipt.bytes) throw new Error(`${path.basename(filePath)}: ${size} bytes on disk, the receipt says ${receipt.bytes}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath, { highWaterMark: 1 << 22 })) hash.update(chunk);
  const sha256 = hash.digest("hex");
  if (sha256 !== receipt.sha256) throw new Error(`${path.basename(filePath)}: SHA-256 ${sha256} differs from the receipt's ${receipt.sha256}`);
  return { bytes: size, sha256 };
}

/** @param {unknown} value @returns {string} One TSV cell (tabs and line breaks become spaces). */
const cell = (value) => String(value ?? "").trim().replace(/[\t\r\n]+/g, " ");

/**
 * The listing directory of a source digest.
 *
 * @param {string} sha256 - Source zip SHA-256.
 * @param {string} [outRoot] - Listing root.
 * @returns {string} Directory.
 */
export const listingDirFor = (sha256, outRoot = DEFAULT_LISTING_ROOT) => path.join(outRoot, sha256.slice(0, 16));

/**
 * Build the permit-number index from the receipted special export.
 *
 * @param {object} [options] - Inputs.
 * @param {string} [options.zipPath] - Special export zip.
 * @param {string} [options.receiptsPath] - Its `receipts.jsonl`.
 * @param {string} [options.outRoot] - Listing root.
 * @param {(line: string) => void} [options.log] - Progress.
 * @returns {Promise<{ dir: string, index: Record<string, any> }>} Where it was written and its index.
 */
export async function buildTcadPermitListing({ zipPath = DEFAULT_ZIP, receiptsPath = DEFAULT_RECEIPTS, outRoot = DEFAULT_LISTING_ROOT, log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const started = performance.now();
  const receipt = await receiptFor(receiptsPath, path.basename(zipPath));
  const verified = await verifyAgainstReceipt(zipPath, receipt);
  log(`[tcad-listing] ${path.basename(zipPath)} matches its receipt (${verified.bytes} bytes, ${verified.sha256.slice(0, 12)}…)`);
  /** @type {Set<string>} */
  const lines = new Set();
  const counts = { accounts: 0, accounts_listing_permits: 0, permits_listed: 0, blank_permit_numbers: 0, cells_cleaned: 0, account_types_listing: {} };
  const member = openZipMember(zipPath);
  const elements = await forEachArrayElement(member.stream, (text) => {
    const account = JSON.parse(text);
    counts.accounts += 1;
    if (counts.accounts % 100_000 === 0) log(`[tcad-listing] ${counts.accounts} accounts, ${Math.round((performance.now() - started) / 1000)} s`);
    const permits = Array.isArray(account.permits) ? account.permits : [];
    if (permits.length === 0) return;
    const propId = String(account.pID ?? "").trim();
    if (!/^\d{1,12}$/.test(propId)) throw new Error(`special export account with pID ${JSON.stringify(account.pID)}`);
    counts.accounts_listing_permits += 1;
    const type = String(account.propType ?? "").trim() || "(blank)";
    counts.account_types_listing[type] = (counts.account_types_listing[type] ?? 0) + 1;
    for (const permit of permits) {
      const raw = String(permit?.permitNumber ?? "");
      const number = cell(raw);
      if (number === "") {
        counts.blank_permit_numbers += 1;
        continue;
      }
      if (number !== raw.trim()) counts.cells_cleaned += 1;
      counts.permits_listed += 1;
      lines.add([number, String(Number(propId)), cell(permit?.refPropertyRoll), cell(permit?.issueDate).slice(0, 10)].join("\t"));
    }
  });
  const exitCode = await member.exited;
  if (exitCode !== 0) throw new Error(`tar -xOf ${path.basename(zipPath)} exited ${exitCode}`);
  const sorted = [...lines].sort();
  const body = `${LISTING_HEADER.join("\t")}\n${sorted.map((line) => `${line}\n`).join("")}`;
  const bodyBytes = Buffer.from(body, "utf8");
  const permitNumbers = new Set(sorted.map((line) => line.slice(0, line.indexOf("\t"))));
  const dir = listingDirFor(verified.sha256, outRoot);
  const index = {
    schemaVersion: TCAD_PERMIT_LISTING_SCHEMA,
    listing_version: TCAD_PERMIT_LISTING_VERSION,
    built_at: new Date().toISOString(),
    source: {
      dataset: "tcad-2026-certified-special-export-json",
      url: receipt.url,
      file: path.basename(zipPath),
      fetched_at: receipt.fetched_at,
      bytes: verified.bytes,
      sha256: verified.sha256,
      receipts: rel(receiptsPath),
      last_modified: receipt.headers?.["last-modified"] ?? null,
      etag: receipt.headers?.etag ?? null,
    },
    counts: { ...counts, array_elements: elements, listed_pairs: sorted.length, permit_numbers: permitNumbers.size },
    listing: { file: LISTING_FILE, columns: LISTING_HEADER, rows: sorted.length, bytes: bodyBytes.length, sha256: createHash("sha256").update(bodyBytes).digest("hex") },
    elapsed_s: Math.round((performance.now() - started) / 100) / 10,
  };
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${LISTING_FILE}.partial`), bodyBytes);
  await writeFile(path.join(dir, `${INDEX_FILE}.partial`), `${JSON.stringify(index, null, 1)}\n`);
  await rename(path.join(dir, `${LISTING_FILE}.partial`), path.join(dir, LISTING_FILE));
  await rename(path.join(dir, `${INDEX_FILE}.partial`), path.join(dir, INDEX_FILE));
  return { dir, index };
}

/**
 * @typedef {object} TcadPermitListing
 * @property {string} version - {@link TCAD_PERMIT_LISTING_VERSION}.
 * @property {string} dir - Listing directory.
 * @property {Record<string, any>} index - `index.json`.
 * @property {(permitNumber: unknown) => readonly { propId: string, refPropertyRoll: string, issueDate: string }[]} entriesFor - Listed entries of a permit number (exact, trimmed).
 * @property {(permitNumber: unknown) => readonly string[]} accountsFor - Distinct accounts listing the permit, sorted.
 */

/**
 * Load a built listing, rechecking `listing.tsv` against the SHA-256 its index records.
 *
 * @param {string} dir - Listing directory.
 * @param {{ expectSourceSha256?: string | null }} [options] - The source digest the caller requires (its receipt's).
 * @returns {Promise<TcadPermitListing>} Listing.
 */
export async function loadTcadPermitListing(dir, { expectSourceSha256 = null } = {}) {
  const indexPath = path.join(dir, INDEX_FILE);
  if (!existsSync(indexPath)) throw new Error(`no TCAD permit listing at ${rel(dir)}; build it from the receipted capture: node --max-old-space-size=8192 src/counties/travis/t4-tcad-permit-listing.mjs`);
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  if (index.listing_version !== TCAD_PERMIT_LISTING_VERSION) throw new Error(`${rel(indexPath)} is ${index.listing_version}, expected ${TCAD_PERMIT_LISTING_VERSION}; rebuild it`);
  if (expectSourceSha256 && index.source?.sha256 !== expectSourceSha256) throw new Error(`${rel(indexPath)} was built from ${index.source?.sha256}, not ${expectSourceSha256}`);
  const bytes = await readFile(path.join(dir, index.listing.file));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== index.listing.sha256 || bytes.length !== index.listing.bytes) throw new Error(`${rel(path.join(dir, index.listing.file))} differs from its index (SHA-256 ${sha256}); rebuild it`);
  const text = bytes.toString("utf8");
  /** @type {Map<string, { propId: string, refPropertyRoll: string, issueDate: string }[]>} */
  const byNumber = new Map();
  let rows = 0;
  let position = text.indexOf("\n") + 1;
  if (text.slice(0, position - 1) !== LISTING_HEADER.join("\t")) throw new Error(`${index.listing.file} has an unexpected header`);
  while (position < text.length) {
    const end = text.indexOf("\n", position);
    const line = text.slice(position, end < 0 ? text.length : end);
    position = end < 0 ? text.length : end + 1;
    if (line === "") continue;
    const [number, propId, refPropertyRoll, issueDate] = line.split("\t");
    rows += 1;
    (byNumber.get(number) ?? byNumber.set(number, []).get(number)).push({ propId, refPropertyRoll, issueDate });
  }
  if (rows !== index.listing.rows) throw new Error(`${index.listing.file} holds ${rows} rows, its index says ${index.listing.rows}`);
  /** @type {Map<string, readonly string[]>} */
  const accounts = new Map();
  const none = Object.freeze([]);
  const key = (permitNumber) => String(permitNumber ?? "").trim();
  return {
    version: index.listing_version,
    dir,
    index,
    entriesFor: (permitNumber) => byNumber.get(key(permitNumber)) ?? none,
    accountsFor(permitNumber) {
      const number = key(permitNumber);
      const cached = accounts.get(number);
      if (cached) return cached;
      const entries = byNumber.get(number);
      if (!entries) return none;
      const distinct = Object.freeze([...new Set(entries.map((entry) => entry.propId))].sort());
      accounts.set(number, distinct);
      return distinct;
    },
  };
}

/**
 * The listing built from the receipted capture on disk (fails closed when it is missing or stale).
 *
 * @param {object} [options] - Locations.
 * @param {string | null} [options.dir] - An explicit listing directory.
 * @param {string} [options.receiptsPath] - Receipts of the capture.
 * @param {string} [options.zipFile] - The capture's file name.
 * @param {string} [options.outRoot] - Listing root.
 * @returns {Promise<TcadPermitListing>} Listing.
 */
export async function resolveTcadPermitListing({ dir = null, receiptsPath = DEFAULT_RECEIPTS, zipFile = SPECIAL_EXPORT_FILE, outRoot = DEFAULT_LISTING_ROOT } = {}) {
  const receipt = await receiptFor(receiptsPath, zipFile);
  return loadTcadPermitListing(dir ?? listingDirFor(receipt.sha256, outRoot), { expectSourceSha256: receipt.sha256 });
}

/** @param {string[]} argv @returns {Record<string, string>} */
function parseFlags(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith("--") || argv[index + 1] === undefined) throw new Error("usage: t4-tcad-permit-listing.mjs [--zip <special-export.zip>] [--receipts <receipts.jsonl>] [--out-root <dir>]");
    flags[argv[index].slice(2)] = argv[index + 1];
  }
  return flags;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const { dir, index } = await buildTcadPermitListing({
    zipPath: path.resolve(flags.zip ?? DEFAULT_ZIP),
    receiptsPath: path.resolve(flags.receipts ?? DEFAULT_RECEIPTS),
    outRoot: path.resolve(flags["out-root"] ?? DEFAULT_LISTING_ROOT),
  });
  console.log(JSON.stringify({ travis_tcad_permit_listing: rel(dir), listing_version: index.listing_version, source_sha256: index.source.sha256, accounts: index.counts.accounts, accounts_listing_permits: index.counts.accounts_listing_permits, permit_numbers: index.counts.permit_numbers, listed_pairs: index.counts.listed_pairs, listing_sha256: index.listing.sha256, elapsed_s: index.elapsed_s }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}
