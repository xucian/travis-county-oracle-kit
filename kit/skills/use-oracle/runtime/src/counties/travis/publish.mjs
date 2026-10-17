#!/usr/bin/env node
/**
 * T2 publication helpers (assignment runbook section 3, "Upload with readback"). They run only on the operator's
 * explicit go; the v1 pilot publication ran them on 2026-10-17.
 *
 *   filebase-pins  read-only Kubo RPC `pin/ls` on Filebase for every uploaded CID (the roots and each table part, all
 *                  added under one file name) plus a negative control that must come back unpinned
 *   pin            Pinata pin-by-CID of every root (requested together), then wait, bounded per root, until Pinata
 *                  lists it as pinned; a refusal, a failed job or a pin still pending at the bound is recorded with
 *                  its exact status, never thrown away
 *   gateway-check  per CID and gateway, the raw block (`?format=raw`) against the CID's multihash, and for every table
 *                  part of the run record the full bytes (`/ipfs/<cid>`) against the recorded size and sha256 (the
 *                  api-contract `gateway_checks[]` shape plus `check`); codecs differ, so digests are compared, never
 *                  CID strings; 404, 429, 5xx and timeouts are retried with backoff up to a per-object deadline,
 *                  after which the row stays `unverified`, never a mismatch
 *   dag-check      `?format=car` of a root from each gateway: every block must hash to its CID and every expected
 *                  block must be present (block order differs, so the stream's sha256 is never compared with a CAR's)
 *   pin-file       Pinata pinFileToIPFS (cidVersion 1) of one small file, refusing a CID other than the local raw CID
 *   manifest       write publish/<run_id>/manifest.json (decisions.md section 7.2) from the run record, the local
 *                  CARs and the upload, gateway and pin outputs; it refuses unpinned roots unless `--accept-unpinned
 *                  true` carries a recorded Pinata refusal into the manifest
 *
 * The Pinata JWT is read from PINATA_JWT_SECRET_ACCESS_TOKEN and never printed.
 *
 * @module counties/travis/publish
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const CODECS = Object.freeze({ 0x55: "raw", 0x70: "dag-pb", 0x0129: "dag-json", 0x71: "dag-cbor" });
const PINATA_API = "https://api.pinata.cloud";
const SHA2_256 = 0x12;
/**
 * Gateway answers that mean "not found yet", "slow down" or "try again" (fresh content, shared gateways, and every
 * 5xx including Cloudflare's 520-527 origin errors); anything else (400, 403, 410, ...) is final.
 *
 * @param {number} status - HTTP status.
 * @returns {boolean} Whether the request is retried.
 */
const retryable = (status) => status === 404 || status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
/** Pinata pin-job states after which the job will never pin. */
const TERMINAL_PIN_JOB = new Set(["expired", "over_free_limit", "over_max_size", "invalid_object", "bad_host_node"]);
const MINUTE = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * @param {string} text - RFC 4648 base32, lower case, no padding.
 * @returns {Uint8Array} Decoded bytes.
 */
function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of text) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`not base32: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Uint8Array.from(out);
}

/**
 * @param {Uint8Array} bytes - Bytes.
 * @returns {string} RFC 4648 base32, lower case, no padding.
 */
function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * @param {Uint8Array} bytes - Buffer.
 * @param {number} offset - Start.
 * @returns {[number, number]} Unsigned varint value and the next offset.
 */
function varint(bytes, offset) {
  let value = 0;
  let shift = 0;
  let index = offset;
  for (;;) {
    if (index >= bytes.length) throw new Error("truncated varint");
    const byte = bytes[index];
    index += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [value, index];
    shift += 7;
  }
}

/**
 * @param {string} cid - CIDv1 in base32 (`b…`).
 * @returns {{ codec: string, multihashCode: number, digest: Uint8Array }} Codec name and multihash digest.
 */
export function parseCid(cid) {
  if (!/^b[a-z2-7]+$/.test(cid)) throw new Error(`not a base32 CIDv1: ${cid}`);
  const bytes = base32Decode(cid.slice(1));
  const [version, afterVersion] = varint(bytes, 0);
  if (version !== 1) throw new Error(`not CIDv1: ${cid}`);
  const [codec, afterCodec] = varint(bytes, afterVersion);
  const [multihashCode, afterCode] = varint(bytes, afterCodec);
  const [length, afterLength] = varint(bytes, afterCode);
  const digest = bytes.slice(afterLength, afterLength + length);
  if (digest.length !== length) throw new Error(`truncated CID: ${cid}`);
  return { codec: CODECS[codec] ?? `0x${codec.toString(16)}`, multihashCode, digest };
}

/**
 * @param {Uint8Array | string} content - File bytes.
 * @returns {string} CIDv1 raw sha2-256 of a single-block file (what `cidVersion: 1` returns for a small file).
 */
export function rawCid(content) {
  const digest = createHash("sha256").update(content).digest();
  return `b${base32Encode(Uint8Array.from([0x01, 0x55, SHA2_256, 0x20, ...digest]))}`;
}

/**
 * Read one binary CID (v1, or a v0 bare sha2-256 multihash) at `offset`.
 *
 * @param {Uint8Array} bytes - Buffer.
 * @param {number} offset - Start of the CID.
 * @returns {{ cid: string, codec: string, multihashCode: number, digest: Uint8Array, end: number }} The CID in base32 and where it ends.
 */
function readBinaryCid(bytes, offset) {
  if (bytes[offset] === SHA2_256 && bytes[offset + 1] === 0x20) {
    const end = offset + 34;
    return { cid: `b${base32Encode(Uint8Array.from([0x01, 0x70, ...bytes.subarray(offset, end)]))}`, codec: "dag-pb", multihashCode: SHA2_256, digest: bytes.slice(offset + 2, end), end };
  }
  const [version, afterVersion] = varint(bytes, offset);
  if (version !== 1) throw new Error(`unsupported CID version ${version} at byte ${offset}`);
  const [codec, afterCodec] = varint(bytes, afterVersion);
  const [multihashCode, afterCode] = varint(bytes, afterCodec);
  const [length, afterLength] = varint(bytes, afterCode);
  const end = afterLength + length;
  if (end > bytes.length) throw new Error(`truncated CID at byte ${offset}`);
  return { cid: `b${base32Encode(bytes.subarray(offset, end))}`, codec: CODECS[codec] ?? `0x${codec.toString(16)}`, multihashCode, digest: bytes.slice(afterLength, end), end };
}

/**
 * Every block of a CARv1 (the header is skipped; callers name the root they expect).
 *
 * @param {Uint8Array} bytes - CAR bytes.
 * @returns {{ cid: string, codec: string, multihashCode: number, digest: string, bytes: Uint8Array, verified: boolean }[]} Blocks in file order; `verified` = sha2-256 of the bytes equals the CID's digest.
 */
export function readCarBlocks(bytes) {
  const [headerLength, afterHeaderLength] = varint(bytes, 0);
  let offset = afterHeaderLength + headerLength;
  if (offset > bytes.length) throw new Error("truncated CAR header");
  const blocks = [];
  while (offset < bytes.length) {
    const [sectionLength, start] = varint(bytes, offset);
    const end = start + sectionLength;
    if (end > bytes.length) throw new Error(`truncated CAR section at byte ${offset}`);
    const cid = readBinaryCid(bytes, start);
    const data = bytes.subarray(cid.end, end);
    const digest = Buffer.from(cid.digest).toString("hex");
    blocks.push({ cid: cid.cid, codec: cid.codec, multihashCode: cid.multihashCode, digest, bytes: data, verified: cid.multihashCode === SHA2_256 && sha256Hex(data) === digest });
    offset = end;
  }
  return blocks;
}

/**
 * The root block of a local CAR, found by CID and verified against the CID's multihash.
 *
 * @param {Uint8Array} carBytes - CAR bytes.
 * @param {string} root - Root CID the run record names.
 * @returns {{ cid: string, size: number, sha256: string }} The root block's size and sha256.
 */
export function rootBlock(carBytes, root) {
  const expected = Buffer.from(parseCid(root).digest).toString("hex");
  const block = readCarBlocks(carBytes).find((candidate) => candidate.digest === expected);
  if (!block) throw new Error(`the CAR holds no block for ${root}`);
  if (!block.verified) throw new Error(`the CAR's block for ${root} does not hash to its CID`);
  return { cid: root, size: block.bytes.length, sha256: sha256Hex(block.bytes) };
}

/**
 * @param {Response} response - A refused response.
 * @param {number} nowMs - Current time, for an HTTP-date `Retry-After`.
 * @returns {number | null} The wait `Retry-After` asks for, in ms.
 */
function retryAfterMs(response, nowMs) {
  const value = response.headers?.get?.("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : null;
}

/**
 * GET `url` until a success, a non-retryable status or the deadline; 404, 408, 425, 429, every 5xx, timeouts and
 * network errors are retried with exponential backoff (5 s doubling to 60 s), never sooner than `Retry-After` asks.
 *
 * @param {string} url - URL.
 * @param {{ headers?: Record<string, string>, fetchImpl: typeof fetch, deadlineMs: number, requestTimeoutMs: number, sleepImpl: (ms: number) => Promise<void>, clock: () => number }} options - Retry policy.
 * @returns {Promise<{ ok: boolean, status: number | null, bytes: Buffer | null, url: string, attempts: number, error: string | null, detail: string | null, retry_after_s: number | null }>} The last answer; `detail` is the start of a refusal's body.
 */
async function fetchWithRetry(url, { headers = {}, fetchImpl, deadlineMs, requestTimeoutMs, sleepImpl, clock }) {
  const started = clock();
  let attempts = 0;
  let delay = 5_000;
  for (;;) {
    attempts += 1;
    let last;
    let wait = delay;
    try {
      const remaining = deadlineMs - (clock() - started);
      const response = await fetchImpl(url, { headers, redirect: "follow", signal: AbortSignal.timeout(Math.max(5_000, Math.min(requestTimeoutMs, remaining))) });
      const finalUrl = response.url || url;
      if (response.ok) return { ok: true, status: response.status, bytes: Buffer.from(await response.arrayBuffer()), url: finalUrl, attempts, error: null, detail: null, retry_after_s: null };
      const asked = retryAfterMs(response, clock());
      const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200) || null;
      last = { ok: false, status: response.status, bytes: null, url: finalUrl, attempts, error: null, detail, retry_after_s: asked === null ? null : Math.round(asked / 1000) };
      if (!retryable(response.status)) return last;
      if (asked !== null) wait = Math.max(delay, asked);
    } catch (error) {
      last = { ok: false, status: null, bytes: null, url, attempts, error: error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : String(error?.message ?? error), detail: null, retry_after_s: null };
    }
    if (clock() - started + wait > deadlineMs) return last;
    await sleepImpl(wait);
    delay = Math.min(delay * 2, 60_000);
  }
}

/**
 * One `gateway_checks[]` row. `check: "raw"` fetches `?format=raw` and compares the block's sha2-256 with the CID's
 * multihash; `check: "file"` fetches `/ipfs/<cid>` in full and compares size and sha256 with `expected` (the run
 * record's part), and for a raw-codec CID also the multihash. A timeout or exhausted retries leave it `unverified`.
 *
 * @param {{ cid: string, gateway: string, check?: "raw" | "file", expected?: { size: number, sha256: string }, fetchImpl?: typeof fetch, now?: () => Date, sleepImpl?: (ms: number) => Promise<void>, deadlineMs?: number, requestTimeoutMs?: number }} options - CID, gateway origin, check kind.
 * @returns {Promise<object>} The row: `{cid, codec, gateway, check, url, status, size, sha256, multihash, bytes?, expected_size?, expected_sha256?, attempts, error, detail, retry_after_s, checked_at}`.
 */
export async function gatewayCheck({ cid, gateway, check = "raw", expected, fetchImpl = fetch, now = () => new Date(), sleepImpl = sleep, deadlineMs = 20 * MINUTE, requestTimeoutMs = 60_000 }) {
  const { codec, multihashCode, digest } = parseCid(cid);
  const url = check === "raw" ? `${gateway}/ipfs/${cid}?format=raw` : `${gateway}/ipfs/${cid}`;
  const headers = check === "raw" ? { accept: "application/vnd.ipld.raw" } : {};
  const answer = await fetchWithRetry(url, { headers, fetchImpl, deadlineMs, requestTimeoutMs, sleepImpl, clock: () => now().getTime() });
  const row = { cid, codec, gateway, check, url: answer.url, status: answer.status, size: null, sha256: null, multihash: "unverified" };
  if (check === "file") Object.assign(row, { bytes: "unverified", expected_size: expected?.size ?? null, expected_sha256: expected?.sha256 ?? null });
  if (answer.ok) {
    row.size = answer.bytes.length;
    row.sha256 = sha256Hex(answer.bytes);
    const digestMatches = multihashCode === SHA2_256 && Buffer.from(digest).toString("hex") === row.sha256;
    if (check === "raw") row.multihash = multihashCode === SHA2_256 ? (digestMatches ? "match" : "mismatch") : "unverified";
    else {
      row.multihash = codec === "raw" && multihashCode === SHA2_256 ? (digestMatches ? "match" : "mismatch") : null;
      row.bytes = expected ? (row.size === expected.size && row.sha256 === expected.sha256 ? "match" : "mismatch") : "unverified";
    }
  }
  return { ...row, attempts: answer.attempts, error: answer.error, detail: answer.detail, retry_after_s: answer.retry_after_s, checked_at: now().toISOString() };
}

/**
 * `?format=car` of a root from one gateway: every block must hash to its CID and every expected block must be present.
 * A short or truncated stream is retried and, at the deadline, `unverified`; a block whose bytes do not hash to its CID
 * is a `mismatch`.
 *
 * @param {{ root: string, gateway: string, expectedDigests: string[], fetchImpl?: typeof fetch, now?: () => Date, sleepImpl?: (ms: number) => Promise<void>, deadlineMs?: number, requestTimeoutMs?: number }} options - Root, gateway, the sha2-256 digests (hex) of every block the DAG must hold.
 * @returns {Promise<object>} `{root, gateway, check: "car", url, status, blocks, verified_blocks, bad_blocks, missing_blocks, extra_blocks, result, attempts, error, checked_at}`.
 */
export async function dagCheck({ root, gateway, expectedDigests, fetchImpl = fetch, now = () => new Date(), sleepImpl = sleep, deadlineMs = 20 * MINUTE, requestTimeoutMs = 120_000 }) {
  const clock = () => now().getTime();
  const started = clock();
  const expected = new Set(expectedDigests);
  let attempts = 0;
  let row;
  for (;;) {
    const remaining = Math.max(0, deadlineMs - (clock() - started));
    const answer = await fetchWithRetry(`${gateway}/ipfs/${root}?format=car&dag-scope=all`, { headers: { accept: "application/vnd.ipld.car" }, fetchImpl, deadlineMs: remaining, requestTimeoutMs, sleepImpl, clock });
    attempts += answer.attempts;
    row = { root, gateway, check: "car", url: answer.url, status: answer.status, blocks: null, verified_blocks: null, bad_blocks: null, missing_blocks: null, extra_blocks: null, result: "unverified", error: answer.error, detail: answer.detail, retry_after_s: answer.retry_after_s };
    if (!answer.ok) break;
    let blocks;
    try {
      blocks = readCarBlocks(answer.bytes);
    } catch (error) {
      row.error = `unreadable CAR stream: ${error instanceof Error ? error.message : String(error)}`;
      blocks = null;
    }
    if (blocks) {
      const fetched = new Set(blocks.map((block) => block.digest));
      Object.assign(row, {
        blocks: blocks.length,
        verified_blocks: blocks.filter((block) => block.verified).length,
        bad_blocks: blocks.filter((block) => !block.verified).length,
        missing_blocks: [...expected].filter((digest) => !fetched.has(digest)).length,
        extra_blocks: [...fetched].filter((digest) => !expected.has(digest)).length,
      });
      if (row.bad_blocks > 0) row.result = "mismatch";
      else if (row.missing_blocks === 0) row.result = "match";
      if (row.result !== "unverified") break;
    }
    if (clock() - started + 30_000 > deadlineMs) break;
    await sleepImpl(30_000);
  }
  return { ...row, attempts, checked_at: now().toISOString() };
}

/**
 * Pin one CID on Pinata by CID and wait, bounded, until Pinata lists it as pinned. Never throws on a Pinata answer:
 * a refusal (`request_status`, `error`), a terminal job state or a pin still pending at the bound is returned as is.
 *
 * @param {{ cid: string, name: string, jwt: string, fetchImpl?: typeof fetch, pollMs?: number, waitMs?: number, now?: () => Date, sleepImpl?: (ms: number) => Promise<void>, onChange?: (state: object) => void }} options - Root, pin name, JWT, wait bound.
 * @returns {Promise<{ cid: string, name: string, already_pinned: boolean, requested: boolean, request_status: number | null, job_id: string | null, job_status: string | null, pinned: boolean, checks: number, last_list_status: number | null, error: string | null, requested_at: string | null, pinned_at: string | null, finished_at: string }>} Pin outcome.
 */
export async function pinByCid({ cid, name, jwt, fetchImpl = fetch, pollMs = 15_000, waitMs = 30 * MINUTE, now = () => new Date(), sleepImpl = sleep, onChange = () => {} }) {
  const headers = { authorization: `Bearer ${jwt}`, "content-type": "application/json" };
  const state = { cid, name, already_pinned: false, requested: false, request_status: null, job_id: null, job_status: null, pinned: false, checks: 0, last_list_status: null, error: null, requested_at: null, pinned_at: null };
  const describe = async (response) => {
    const text = await response.text().catch(() => "");
    try {
      const body = JSON.parse(text);
      return JSON.stringify(body?.error ?? body).slice(0, 300);
    } catch {
      return text.slice(0, 300);
    }
  };
  const listed = async () => {
    const response = await fetchImpl(`${PINATA_API}/data/pinList?hashContains=${cid}&status=pinned`, { headers });
    state.last_list_status = response.status;
    if (!response.ok) {
      state.error = `pinList HTTP ${response.status}: ${await describe(response)}`;
      return false;
    }
    return ((await response.json())?.count ?? 0) > 0;
  };
  const finish = () => ({ ...state, finished_at: now().toISOString() });

  if (await listed()) {
    Object.assign(state, { already_pinned: true, pinned: true, pinned_at: now().toISOString(), error: null });
    return finish();
  }
  state.error = null;
  state.requested_at = now().toISOString();
  const request = await fetchImpl(`${PINATA_API}/pinning/pinByHash`, { method: "POST", headers, body: JSON.stringify({ hashToPin: cid, pinataMetadata: { name } }) });
  state.request_status = request.status;
  if (!request.ok) {
    state.error = `pinByHash HTTP ${request.status}: ${await describe(request)}`;
    return finish();
  }
  const job = await request.json().catch(() => ({}));
  Object.assign(state, { requested: true, job_id: job?.id ?? null, job_status: job?.status ?? null });
  onChange(state);
  const started = now().getTime();
  for (;;) {
    state.checks += 1;
    if (await listed()) {
      Object.assign(state, { pinned: true, pinned_at: now().toISOString(), job_status: "pinned", error: null });
      onChange(state);
      return finish();
    }
    // A key without the pinList scope can never confirm the pin; record that instead of waiting out the bound.
    if (state.last_list_status === 401 || state.last_list_status === 403) return finish();
    const jobs = await fetchImpl(`${PINATA_API}/pinning/pinJobs?ipfs_pin_hash=${cid}`, { headers });
    if (jobs.ok) {
      const status = (await jobs.json())?.rows?.[0]?.status ?? null;
      if (status && status !== state.job_status) {
        state.job_status = status;
        onChange(state);
      }
      if (TERMINAL_PIN_JOB.has(status)) return finish();
    } else {
      await jobs.body?.cancel?.();
    }
    if (now().getTime() - started + pollMs > waitMs) return finish();
    await sleepImpl(pollMs);
  }
}

/**
 * Read-only: ask a Kubo RPC API (Filebase's) whether each CID is pinned there (`pin/ls?arg=<cid>&type=all`), plus one
 * negative control (the raw CID of timestamped bytes that were never uploaded) that must come back unpinned.
 *
 * @param {{ cids: string[], token: string, api?: string, fetchImpl?: typeof fetch, now?: () => Date }} options - CIDs, bearer token (never printed).
 * @returns {Promise<{ api: string, checked_at: string, rows: { cid: string, status: number | null, pinned: boolean, type: string | null }[], control: { cid: string, status: number | null, pinned: boolean }, all_pinned: boolean }>} Pin state per CID.
 */
export async function filebasePins({ cids, token, api = "https://rpc.filebase.io", fetchImpl = fetch, now = () => new Date() }) {
  const ask = async (cid) => {
    try {
      const response = await fetchImpl(`${api}/api/v0/pin/ls?arg=${cid}&type=all`, { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
      const body = await response.json().catch(() => ({}));
      const entry = Object.entries(body?.Keys ?? {}).find(([key]) => key === cid);
      return { cid, status: response.status, pinned: Boolean(entry), type: entry?.[1]?.Type ?? null };
    } catch {
      return { cid, status: null, pinned: false, type: null };
    }
  };
  const rows = [];
  for (const cid of cids) rows.push(await ask(cid));
  const { cid: controlCid, status, pinned } = await ask(rawCid(`travis negative control ${now().toISOString()}`));
  return { api, checked_at: now().toISOString(), rows, control: { cid: controlCid, status, pinned }, all_pinned: rows.every((row) => row.pinned) && !pinned };
}

/**
 * Pin one small file on Pinata (pinFileToIPFS, cidVersion 1) and refuse any CID but its local raw CID.
 *
 * @param {{ file: string, name: string, jwt: string, fetchImpl?: typeof fetch, now?: () => Date }} options - File path, pin name, JWT.
 * @returns {Promise<{ cid: string, name: string, size: number, sha256: string, is_duplicate: boolean | null, pinned_at: string }>} The pinned CID.
 */
export async function pinFile({ file, name, jwt, fetchImpl = fetch, now = () => new Date() }) {
  const bytes = await readFile(file);
  if (bytes.length > 256 * 1024) throw new Error(`${file} is larger than one block; pin it by CID instead`);
  const expected = rawCid(bytes);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "application/json" }), path.basename(file));
  form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
  form.append("pinataMetadata", JSON.stringify({ name }));
  const response = await fetchImpl(`${PINATA_API}/pinning/pinFileToIPFS`, { method: "POST", headers: { authorization: `Bearer ${jwt}` }, body: form });
  if (!response.ok) throw new Error(`pinFileToIPFS ${file}: HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 300)}`);
  const { IpfsHash: cid, isDuplicate } = await response.json();
  if (cid !== expected) throw new Error(`Pinata returned ${cid} for ${file}, expected ${expected}`);
  return { cid, name, size: bytes.length, sha256: sha256Hex(bytes), is_duplicate: isDuplicate ?? null, pinned_at: now().toISOString() };
}

/**
 * Build `publish/<run_id>/manifest.json` (assignment decisions.md section 7.2): every kit-eligible object of the run,
 * never the manifest itself. A directory entry's size and sha256 are its root block's (api-contract.md, "the run's
 * artifact manifest"), the bytes a gateway returns for `?format=raw`; the CAR exports are listed under `cars[]`.
 *
 * Every root must be pinned on Pinata, unless `acceptUnpinned` is set: then every root still needs a recorded pin
 * outcome (a refusal or a pending job, kept verbatim in `pins`), and the manifest says that the second pin is missing.
 *
 * The schema's size and sha256 come from `schemaBlock` (local bytes that hash to the schema CID) or else from a raw
 * gateway row whose multihash matched.
 *
 * @param {{ runRecord: object, carUpload: object, tablesUpload: object, rootBlocks: Record<string, { size: number, sha256: string }>, schemaBlock?: { size: number, sha256: string }, gatewayChecks: object[], dagChecks?: object[], pins: object[], sampleExtract: { property_cid: string, data_group_root_cid: string }, acceptUnpinned?: boolean }} inputs - Run record, local root blocks and operator outputs.
 * @returns {object} The manifest.
 */
export function buildPublishManifest({ runRecord, carUpload, tablesUpload, rootBlocks, schemaBlock, gatewayChecks, dagChecks = [], pins, sampleExtract, acceptUnpinned = false }) {
  const archive = runRecord.cars.find((car) => car.kind === "archive");
  const tables = runRecord.cars.find((car) => car.kind === "tables");
  if (carUpload.root !== archive.root_cid) throw new Error(`uploaded archive root ${carUpload.root} is not the recorded ${archive.root_cid}`);
  if (tablesUpload.root !== tables.root_cid) throw new Error(`uploaded tables root ${tablesUpload.root} is not the recorded ${tables.root_cid}`);
  if (tablesUpload.countyRoot !== undefined && tablesUpload.countyRoot !== archive.root_cid) throw new Error(`the uploaded tables point at ${tablesUpload.countyRoot}, not the archive ${archive.root_cid}`);
  const roots = [archive.root_cid, tables.root_cid];
  const unrecorded = roots.filter((cid) => !pins.some((pin) => pin.cid === cid));
  if (unrecorded.length > 0) throw new Error(`no Pinata pin outcome recorded for: ${unrecorded.join(", ")}`);
  const unpinned = roots.filter((cid) => !pins.some((pin) => pin.cid === cid && pin.pinned));
  if (unpinned.length > 0 && !acceptUnpinned) throw new Error(`not pinned on Pinata: ${unpinned.join(", ")}`);
  for (const cid of [archive.root_cid, tables.root_cid]) {
    const block = rootBlocks?.[cid];
    if (!block || block.sha256 !== Buffer.from(parseCid(cid).digest).toString("hex")) throw new Error(`no verified root block for ${cid}`);
  }
  if (schemaBlock && schemaBlock.sha256 !== Buffer.from(parseCid(archive.schema_cid).digest).toString("hex")) throw new Error(`the schema bytes do not hash to ${archive.schema_cid}`);
  const schema = schemaBlock ?? gatewayChecks.find((row) => row.cid === archive.schema_cid && row.check === "raw" && row.multihash === "match");
  const directory = (cid, name) => ({ cid, name, size: rootBlocks[cid].size, codec: "directory", sha256: rootBlocks[cid].sha256, digest_of: "root block" });
  const objects = [
    directory(archive.root_cid, "county archive (CountyIndex root)"),
    directory(tables.root_cid, "county tables (CountyTables root)"),
    ...runRecord.tables.parts.map((part) => ({ cid: part.cid, name: `tables/${part.part}`, size: part.bytes, codec: "file", sha256: part.sha256 })),
    { cid: archive.schema_cid, name: "County data-group schema (live lexicon)", size: schema?.size ?? null, codec: "file", sha256: schema?.sha256 ?? null },
  ];
  return {
    schemaVersion: "travis.publish-manifest.v1",
    label: "pilot scope, uploaded with readback, no Atlas PR",
    run_id: runRecord.run_id,
    county: { key: "travis", state: "TX", fips: "48453" },
    lexicon_manifest: { url: runRecord.lexicon_manifest_url, sha256: runRecord.sources.find((source) => source.dataset === "elephant-lexicon-manifest")?.sha256 ?? null },
    groups: runRecord.groups,
    objects,
    coverage: runRecord.counts,
    indexes: { county_index: archive.root_cid, county_tables: tables.root_cid },
    sample_extract: sampleExtract,
    cars: runRecord.cars.map((car) => ({ ...car, readback_url: car.kind === "archive" ? carUpload.gatewayUrl ?? null : tablesUpload.gatewayUrl ?? null })),
    uploads: { archive: carUpload, tables: tablesUpload },
    second_pin: { vendor: "pinata", method: "pin-by-CID", all_roots_pinned: unpinned.length === 0, unpinned_roots: unpinned },
    pins,
    gateway_checks: gatewayChecks,
    dag_checks: dagChecks,
    notes: [
      "A directory entry's size and sha256 are its root block's: the bytes a gateway returns for /ipfs/<cid>?format=raw. The DAG under each root is exported as the CAR in cars[] (path, size, sha256), which is not a separately pinned object.",
      "No origins are listed: no candidate-operated node serves these blocks. Filebase (the upload) and Pinata (the second pin) are pinning vendors; their gateway URLs are locators, never identities.",
      ...(unpinned.length > 0 ? [`The second pin is missing: Pinata did not pin ${unpinned.join(", ")} (outcomes verbatim in pins[]); Filebase is the only provider pinning these roots.`] : []),
      "The manifest does not list itself; its CID is recorded in the run record.",
      "Consumers read the global elephant-atlas IPNS; this pilot has no Atlas PR, so no IPNS name or index CID applies to it.",
    ],
  };
}

/**
 * Run `task` over `items` with at most `limit` in flight, keeping the input order in the result.
 *
 * @template T, R
 * @param {T[]} items - Inputs.
 * @param {number} limit - Concurrency.
 * @param {(item: T) => Promise<R>} task - Work.
 * @returns {Promise<R[]>} Results in input order.
 */
async function mapLimited(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let index = 0; index < rest.length; index += 2) flags[rest[index].replace(/^--/, "")] = rest[index + 1];
  const jwt = () => {
    const value = process.env.PINATA_JWT_SECRET_ACCESS_TOKEN;
    if (!value) throw new Error("PINATA_JWT_SECRET_ACCESS_TOKEN is not set in this shell");
    return value;
  };
  const read = async (file) => JSON.parse(await readFile(file, "utf8"));
  const write = async (file, value) => {
    await mkdir(path.dirname(path.resolve(file)), { recursive: true });
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  };
  const list = (value) => (value ? value.split(",").filter(Boolean) : []);
  const deadlineMs = Number(flags["deadline-minutes"] ?? 20) * MINUTE;
  if (command === "gateway-check") {
    const parts = flags["run-record"] ? new Map((await read(flags["run-record"])).tables.parts.map((part) => [part.cid, { size: part.bytes, sha256: part.sha256 }])) : new Map();
    const gateways = list(flags.gateways);
    const jobs = list(flags.cids).flatMap((cid) => [{ cid, check: "raw" }, ...(parts.has(cid) ? [{ cid, check: "file", expected: parts.get(cid) }] : [])]);
    const checkOne = async (job, gateway) => {
      const row = await gatewayCheck({ ...job, gateway, deadlineMs });
      console.error(JSON.stringify({ at: row.checked_at, cid: row.cid, gateway, check: row.check, status: row.status, result: row.check === "file" ? row.bytes : row.multihash, attempts: row.attempts }));
      return row;
    };
    const perGateway = await Promise.all(gateways.map((gateway) => mapLimited(jobs, Number(flags.concurrency ?? 4), (job) => checkOne(job, gateway))));
    const rows = jobs.flatMap((_, index) => perGateway.map((gatewayRows) => gatewayRows[index]));
    await write(flags.output, rows);
    console.log(JSON.stringify(rows.map(({ cid, gateway, check, status, multihash, bytes, attempts }) => ({ cid, gateway, check, status, result: check === "file" ? bytes : multihash, attempts }))));
    if (rows.some((row) => row.multihash === "mismatch" || row.bytes === "mismatch")) process.exitCode = 1;
  } else if (command === "dag-check") {
    const blocks = readCarBlocks(await readFile(flags.car));
    const expectedDigests = [...blocks.map((block) => block.digest), ...list(flags["expect-cids"]).map((cid) => Buffer.from(parseCid(cid).digest).toString("hex"))];
    const rows = await Promise.all(list(flags.gateways).map((gateway) => dagCheck({ root: flags.root, gateway, expectedDigests, deadlineMs })));
    await write(flags.output, rows);
    console.log(JSON.stringify(rows.map(({ root, gateway, status, blocks: count, missing_blocks, bad_blocks, result }) => ({ root, gateway, status, blocks: count, missing_blocks, bad_blocks, result }))));
    if (rows.some((row) => row.result === "mismatch")) process.exitCode = 1;
  } else if (command === "pin") {
    const waitMs = Number(flags["wait-minutes"] ?? 30) * MINUTE;
    const pollMs = Number(flags["poll-seconds"] ?? 15) * 1000;
    const onChange = ({ cid, requested, job_status, pinned }) => console.error(JSON.stringify({ at: new Date().toISOString(), cid, requested, job_status, pinned }));
    const pins = await Promise.all(list(flags.cids).map((cid) => pinByCid({ cid, name: `${flags["name-prefix"]}-${cid.slice(-8)}`, jwt: jwt(), waitMs, pollMs, onChange })));
    await write(flags.output, pins);
    console.log(JSON.stringify(pins));
    if (pins.some((pin) => !pin.pinned)) process.exitCode = 1;
  } else if (command === "filebase-pins") {
    const { FILEBASE_ACCESS_KEY: key, FILEBASE_SECRET_KEY: secret, FILEBASE_BUCKET: bucket } = process.env;
    if (!key || !secret || !bucket) throw new Error("FILEBASE_ACCESS_KEY, FILEBASE_SECRET_KEY and FILEBASE_BUCKET are not all set in this shell");
    const result = await filebasePins({ cids: list(flags.cids), token: Buffer.from(`${key}:${secret}:${bucket}`).toString("base64") });
    await write(flags.output, result);
    console.log(JSON.stringify({ all_pinned: result.all_pinned, pinned: result.rows.filter((row) => row.pinned).length, total: result.rows.length, control_pinned: result.control.pinned }));
    if (!result.all_pinned) process.exitCode = 1;
  } else if (command === "pin-file") {
    const pinned = await pinFile({ file: flags.file, name: flags.name, jwt: jwt() });
    if (flags.output) await write(flags.output, pinned);
    console.log(JSON.stringify(pinned));
  } else if (command === "manifest") {
    const runRecord = await read(flags["run-record"]);
    const hashRows = (await readFile(flags["hash-csv"], "utf8")).trim().split("\n").slice(1).map((line) => line.split(","));
    const countyRow = hashRows.find((row) => row[1] === runRecord.groups.county.schema);
    if (!countyRow) throw new Error("the hash CSV has no county data-group row");
    const archive = runRecord.cars.find((car) => car.kind === "archive");
    const tables = runRecord.cars.find((car) => car.kind === "tables");
    const rootBlocks = {
      [archive.root_cid]: rootBlock(await readFile(flags["archive-car"]), archive.root_cid),
      [tables.root_cid]: rootBlock(await readFile(flags["tables-car"]), tables.root_cid),
    };
    const manifest = buildPublishManifest({
      runRecord,
      carUpload: await read(flags["car-upload"]),
      tablesUpload: await read(flags["tables-upload"]),
      rootBlocks,
      gatewayChecks: await read(flags["gateway-checks"]),
      dagChecks: flags["dag-checks"] ? await read(flags["dag-checks"]) : [],
      pins: await read(flags.pins),
      sampleExtract: { property_cid: countyRow[0], data_group_root_cid: countyRow[2] },
      acceptUnpinned: flags["accept-unpinned"] === "true",
      schemaBlock: flags["schema-file"] ? await (async () => {
        const bytes = await readFile(flags["schema-file"]);
        if (rawCid(bytes) !== archive.schema_cid) throw new Error(`${flags["schema-file"]} is not the bytes of ${archive.schema_cid}`);
        return { size: bytes.length, sha256: sha256Hex(bytes) };
      })() : undefined,
    });
    await write(flags.output, manifest);
    console.log(JSON.stringify({ output: flags.output, objects: manifest.objects.length, local_raw_cid: rawCid(await readFile(flags.output)) }));
  } else {
    throw new Error("usage: publish.mjs <filebase-pins|gateway-check|dag-check|pin|pin-file|manifest> ...");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
