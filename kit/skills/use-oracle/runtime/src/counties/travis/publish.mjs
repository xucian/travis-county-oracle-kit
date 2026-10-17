#!/usr/bin/env node
/**
 * T2 publication helpers for the operator's go (assignment runbook section 3, "Upload with readback").
 * Nothing here runs unless the operator calls it; the agent never uploads or pins.
 *
 *   gateway-check  fetch each CID's raw block from each gateway and compare its sha2-256 with the CID's multihash
 *                  (the api-contract `gateway_checks[]` shape; codecs differ, so digests are compared, never CID strings)
 *   pin            Pinata pin-by-CID of each root, then wait until Pinata lists it as pinned
 *   pin-file       Pinata pinFileToIPFS (cidVersion 1) of one small file, refusing a CID other than the local raw CID
 *   manifest       write publish/<run_id>/manifest.json (decisions.md section 7.2) from the run record and the
 *                  upload, gateway and pin outputs
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
 * @param {Uint8Array} bytes - Buffer.
 * @param {number} offset - Start.
 * @returns {[number, number]} Unsigned varint value and the next offset.
 */
function varint(bytes, offset) {
  let value = 0;
  let shift = 0;
  let index = offset;
  for (;;) {
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
 * @param {{ cid: string, gateway: string, fetchImpl?: typeof fetch, now?: () => Date }} options - CID, gateway origin.
 * @returns {Promise<{ cid: string, codec: string, gateway: string, status: number | null, size: number | null, sha256: string | null, multihash: "match" | "mismatch" | "unverified", checked_at: string }>} One `gateway_checks[]` row.
 */
export async function gatewayCheck({ cid, gateway, fetchImpl = fetch, now = () => new Date() }) {
  const { codec, multihashCode, digest } = parseCid(cid);
  const row = { cid, codec, gateway, status: null, size: null, sha256: null, multihash: "unverified", checked_at: now().toISOString() };
  try {
    const response = await fetchImpl(`${gateway}/ipfs/${cid}?format=raw`, {
      headers: { accept: "application/vnd.ipld.raw" },
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });
    row.status = response.status;
    if (!response.ok) return row;
    const bytes = Buffer.from(await response.arrayBuffer());
    row.size = bytes.length;
    row.sha256 = createHash("sha256").update(bytes).digest("hex");
    if (multihashCode === 0x12) row.multihash = Buffer.from(digest).toString("hex") === row.sha256 ? "match" : "mismatch";
  } catch {
    // a timeout or network error leaves the row unverified, never a mismatch
  }
  return row;
}

/**
 * @param {Uint8Array | string} content - File bytes.
 * @returns {string} CIDv1 raw sha2-256 of a single-block file (what `cidVersion: 1` returns for a small file).
 */
export function rawCid(content) {
  const digest = createHash("sha256").update(content).digest();
  const bytes = Uint8Array.from([0x01, 0x55, 0x12, 0x20, ...digest]);
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
  return `b${out}`;
}

/**
 * Pin one CID on Pinata by CID and wait until Pinata lists it as pinned.
 *
 * @param {{ cid: string, name: string, jwt: string, fetchImpl?: typeof fetch, pollMs?: number, attempts?: number }} options - Root, pin name, JWT.
 * @returns {Promise<{ cid: string, name: string, requested: boolean, pinned: boolean, checks: number }>} Pin outcome.
 */
export async function pinByCid({ cid, name, jwt, fetchImpl = fetch, pollMs = 10_000, attempts = 60 }) {
  const headers = { authorization: `Bearer ${jwt}`, "content-type": "application/json" };
  const request = await fetchImpl(`${PINATA_API}/pinning/pinByHash`, { method: "POST", headers, body: JSON.stringify({ hashToPin: cid, pinataMetadata: { name } }) });
  if (!request.ok) throw new Error(`pinByHash ${cid}: HTTP ${request.status}`);
  for (let check = 1; check <= attempts; check += 1) {
    const list = await fetchImpl(`${PINATA_API}/data/pinList?hashContains=${cid}&status=pinned`, { headers });
    if (list.ok && ((await list.json())?.count ?? 0) > 0) return { cid, name, requested: true, pinned: true, checks: check };
    if (check < attempts) await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { cid, name, requested: true, pinned: false, checks: attempts };
}

/**
 * Pin one small file on Pinata (pinFileToIPFS, cidVersion 1) and refuse any CID but its local raw CID.
 *
 * @param {{ file: string, name: string, jwt: string, fetchImpl?: typeof fetch }} options - File path, pin name, JWT.
 * @returns {Promise<{ cid: string, name: string, size: number }>} The pinned CID.
 */
export async function pinFile({ file, name, jwt, fetchImpl = fetch }) {
  const bytes = await readFile(file);
  if (bytes.length > 256 * 1024) throw new Error(`${file} is larger than one block; pin it by CID instead`);
  const expected = rawCid(bytes);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "application/json" }), path.basename(file));
  form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
  form.append("pinataMetadata", JSON.stringify({ name }));
  const response = await fetchImpl(`${PINATA_API}/pinning/pinFileToIPFS`, { method: "POST", headers: { authorization: `Bearer ${jwt}` }, body: form });
  if (!response.ok) throw new Error(`pinFileToIPFS ${file}: HTTP ${response.status}`);
  const { IpfsHash: cid } = await response.json();
  if (cid !== expected) throw new Error(`Pinata returned ${cid} for ${file}, expected ${expected}`);
  return { cid, name, size: bytes.length };
}

/**
 * Build `publish/<run_id>/manifest.json` (assignment decisions.md section 7.2): every kit-eligible object of the run,
 * never the manifest itself.
 *
 * @param {{ runRecord: object, carUpload: object, tablesUpload: object, gatewayChecks: object[], pins: object[], sampleExtract: { property_cid: string, data_group_root_cid: string } }} inputs - Run record and operator outputs.
 * @returns {object} The manifest.
 */
export function buildPublishManifest({ runRecord, carUpload, tablesUpload, gatewayChecks, pins, sampleExtract }) {
  const archive = runRecord.cars.find((car) => car.kind === "archive");
  const tables = runRecord.cars.find((car) => car.kind === "tables");
  if (carUpload.root !== archive.root_cid) throw new Error(`uploaded archive root ${carUpload.root} is not the recorded ${archive.root_cid}`);
  if (tablesUpload.root !== tables.root_cid) throw new Error(`uploaded tables root ${tablesUpload.root} is not the recorded ${tables.root_cid}`);
  const unpinned = [archive.root_cid, tables.root_cid].filter((cid) => !pins.some((pin) => pin.cid === cid && pin.pinned));
  if (unpinned.length > 0) throw new Error(`not pinned on Pinata: ${unpinned.join(", ")}`);
  const objects = [
    { cid: archive.root_cid, name: "county archive (CountyIndex root)", size: archive.size, codec: "directory", sha256: archive.sha256, origins: [carUpload.gatewayUrl].filter(Boolean) },
    { cid: tables.root_cid, name: "county tables (CountyTables root)", size: tables.size, codec: "directory", sha256: tables.sha256, origins: [tablesUpload.gatewayUrl].filter(Boolean) },
    ...runRecord.tables.parts.map((part) => ({ cid: part.cid, name: `tables/${part.part}`, size: part.bytes, codec: "file", sha256: part.sha256 })),
    { cid: archive.schema_cid, name: "County data-group schema (live lexicon)", size: null, codec: "file", sha256: null },
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
    gateway_checks: gatewayChecks,
    pins,
  };
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
  const write = async (file, value) => {
    await mkdir(path.dirname(path.resolve(file)), { recursive: true });
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  };
  if (command === "gateway-check") {
    const rows = [];
    for (const cid of flags.cids.split(",")) for (const gateway of flags.gateways.split(",")) rows.push(await gatewayCheck({ cid, gateway }));
    await write(flags.output, rows);
    console.log(JSON.stringify(rows.map(({ cid, gateway, status, multihash }) => ({ cid, gateway, status, multihash }))));
    if (rows.some((row) => row.multihash === "mismatch")) process.exitCode = 1;
  } else if (command === "pin") {
    const pins = [];
    for (const cid of flags.cids.split(",")) pins.push(await pinByCid({ cid, name: `${flags["name-prefix"]}-${cid.slice(-8)}`, jwt: jwt() }));
    await write(flags.output, pins);
    console.log(JSON.stringify(pins));
    if (pins.some((pin) => !pin.pinned)) process.exitCode = 1;
  } else if (command === "pin-file") {
    const pinned = await pinFile({ file: flags.file, name: flags.name, jwt: jwt() });
    console.log(JSON.stringify(pinned));
  } else if (command === "manifest") {
    const read = async (file) => JSON.parse(await readFile(file, "utf8"));
    const runRecord = await read(flags["run-record"]);
    const hashRows = (await readFile(flags["hash-csv"], "utf8")).trim().split("\n").slice(1).map((line) => line.split(","));
    const countyRow = hashRows.find((row) => row[1] === runRecord.groups.county.schema);
    if (!countyRow) throw new Error("the hash CSV has no county data-group row");
    const manifest = buildPublishManifest({
      runRecord,
      carUpload: await read(flags["car-upload"]),
      tablesUpload: await read(flags["tables-upload"]),
      gatewayChecks: await read(flags["gateway-checks"]),
      pins: await read(flags.pins),
      sampleExtract: { property_cid: countyRow[0], data_group_root_cid: countyRow[2] },
    });
    await write(flags.output, manifest);
    console.log(JSON.stringify({ output: flags.output, objects: manifest.objects.length }));
  } else {
    throw new Error("usage: publish.mjs <gateway-check|pin|pin-file|manifest> ...");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
