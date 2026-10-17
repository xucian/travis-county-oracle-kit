/**
 * Record ids of the business and license records (assignment api-contract.md `business_record_id`,
 * `license_record_id`; decisions.md section 24.2 and 24.3), shared by the internal reconciliation and the deploy-time
 * build (`packages/deploy-build` imports this module from the pinned kit worktree), so both compute the same ids.
 *
 * `travis-record-id.v1`:
 *   - a record whose key is printed: the first 32 hex characters of SHA-256 over the UTF-8 of the source key and the
 *     record's key parts as printed (trimmed), joined by U+001F;
 *   - a record whose key is withheld (`record_id_withheld`, a sole owner's sales-tax outlet): the first 32 hex
 *     characters of HMAC-SHA256 under the deployment's record-id key over the same message. The message still holds
 *     the dataset's own unique key (taxpayer and outlet number), so no two outlets share an id, and without the key
 *     the id cannot be searched for the number.
 *
 * The record-id key is 32 random bytes kept on the operator's machine, where both the kit loader and the deploy build
 * run (decisions.md section 21), in `data/travis/keys/record-id.key` (gitignored; `TRAVIS_RECORD_ID_KEY_FILE`
 * overrides). It is created once (`t3-record-id-key.mjs init`), never printed, and identified by its fingerprint,
 * which the watermark records: a missing or different key stops the load instead of silently changing ids.
 *
 * @module counties/travis/record-ids
 */
import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RECORD_ID_VERSION = "travis-record-id.v1";
const SEPARATOR = "\u001f";
const RUNTIME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const DEFAULT_RECORD_ID_KEY_FILE = path.join(RUNTIME_ROOT, "data", "travis", "keys", "record-id.key");

/**
 * @param {string} sourceKey - Source key.
 * @param {(string | null | undefined)[]} keyParts - Key parts as printed (trimmed); null is the empty string.
 * @returns {string} The message both digests cover.
 */
export function recordIdMessage(sourceKey, keyParts) {
  return [sourceKey, ...keyParts.map((part) => (part === null || part === undefined ? "" : String(part)))].join(SEPARATOR);
}

/**
 * @param {string} sourceKey - Source key.
 * @param {(string | null | undefined)[]} keyParts - Printed key parts.
 * @returns {string} `business_record_id` / `license_record_id` of a record with a printed key.
 */
export function recordIdOf(sourceKey, keyParts) {
  return createHash("sha256").update(recordIdMessage(sourceKey, keyParts), "utf8").digest("hex").slice(0, 32);
}

/**
 * @param {Buffer} key - Record-id key (32 bytes).
 * @param {string} sourceKey - Source key.
 * @param {(string | null | undefined)[]} keyParts - Key parts as printed, the withheld ones included.
 * @returns {string} `business_record_id` of a record whose key is withheld.
 */
export function withheldRecordIdOf(key, sourceKey, keyParts) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("the record-id key must be 32 bytes");
  return createHmac("sha256", key).update(recordIdMessage(sourceKey, keyParts), "utf8").digest("hex").slice(0, 32);
}

/**
 * @param {Buffer} key - Record-id key.
 * @returns {string} Its fingerprint (16 hex characters; reveals nothing usable about a 32-byte random key).
 */
export function recordIdKeyFingerprint(key) {
  return createHash("sha256").update(`travis-record-id-key-fingerprint.v1${SEPARATOR}${key.toString("hex")}`, "utf8").digest("hex").slice(0, 16);
}

/** @returns {string} The key file in force. */
export function recordIdKeyFile() {
  return process.env.TRAVIS_RECORD_ID_KEY_FILE ? path.resolve(process.env.TRAVIS_RECORD_ID_KEY_FILE) : DEFAULT_RECORD_ID_KEY_FILE;
}

/**
 * Read the record-id key; fails closed when it is missing or malformed.
 *
 * @param {string} [file] - Key file (default {@link recordIdKeyFile}).
 * @returns {Buffer} The key.
 */
export function readRecordIdKey(file = recordIdKeyFile()) {
  if (!existsSync(file)) throw new Error(`no record-id key at ${file}: create it once with node src/counties/travis/t3-record-id-key.mjs init, and keep a backup (decisions.md section 24.2)`);
  const text = readFileSync(file, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${file} is not a 32-byte hex key`);
  return Buffer.from(text, "hex");
}
