#!/usr/bin/env node
/**
 * Serve an amended lexicon to `elephant-cli` on this machine only (T2; assignment decisions.md section 22).
 *
 *   GET /api/manifest              -> <dir>/manifest.json (the amended manifest)
 *   GET /ipfs/<cid>[?format=raw]   -> <dir>/schemas/<cid>.json when present (the amended schemas); otherwise the same
 *                                     trustless raw request to the public gateways in order (the unchanged schemas)
 *
 * Binds 127.0.0.1 only. Every byte served is checked against its CID (CIDv1, raw codec, sha2-256), at start-up for
 * the local files and per response for the gateway fallback. Nothing is pinned or uploaded.
 *
 * Usage:
 *   node src/counties/travis/amended-lexicon-server.mjs --dir data/travis/lexicon-amended/a0c05c5-plus-travis [--port 8790]
 *   export ELEPHANT_SCHEMA_MANIFEST_URL=http://127.0.0.1:8790/api/manifest
 *   export ELEPHANT_IPFS_GATEWAYS=http://127.0.0.1:8790
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The CLI's own default schema gateways (`@elephant-xyz/cli` 1.58.1 `DEFAULT_IPFS_GATEWAYS`), in its order. */
export const PUBLIC_SCHEMA_GATEWAYS = Object.freeze(["https://ipfs.filebase.io", "https://gateway.pinata.cloud", "https://trustless-gateway.link"]);

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * @param {Uint8Array} bytes - Bytes to encode.
 * @returns {string} RFC 4648 base32, lower case, no padding.
 */
function base32(bytes) {
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
 * @param {Uint8Array | string} content - Block bytes (a string is taken as UTF-8).
 * @returns {string} CIDv1 (base32), raw codec, sha2-256: the CID the lexicon publishes for a schema file.
 */
export function rawCid(content) {
  const digest = createHash("sha256").update(content).digest();
  return `b${base32(Uint8Array.from([0x01, 0x55, 0x12, 0x20, ...digest]))}`;
}

const CID_PATTERN = /^b[a-z2-7]{50,120}$/;

/**
 * Load the amended manifest and schemas, refusing any schema whose bytes do not hash to its file name.
 *
 * @param {string} dir - Directory with `manifest.json` and `schemas/<cid>.json`.
 * @returns {Promise<{ manifest: Buffer, schemas: Map<string, Buffer> }>} Served content.
 */
export async function loadAmendedLexicon(dir) {
  const manifest = await readFile(path.join(dir, "manifest.json"));
  JSON.parse(manifest.toString("utf8"));
  const schemas = new Map();
  for (const name of (await readdir(path.join(dir, "schemas"))).sort()) {
    if (!name.endsWith(".json")) continue;
    const cid = name.slice(0, -".json".length);
    const bytes = await readFile(path.join(dir, "schemas", name));
    if (rawCid(bytes) !== cid) throw new Error(`schemas/${name} does not hash to its CID`);
    schemas.set(cid, bytes);
  }
  return { manifest, schemas };
}

/**
 * @param {{ dir: string, gateways?: readonly string[], fetchImpl?: typeof fetch, log?: (event: object) => void }} options - Content directory, fallback gateways, fetch and log hooks.
 * @returns {Promise<{ server: import("node:http").Server, stats: { local: number, gateway: number, failed: number, manifest: number } }>} An unstarted server and its counters.
 */
export async function createAmendedLexiconServer({ dir, gateways = PUBLIC_SCHEMA_GATEWAYS, fetchImpl = fetch, log = () => {} }) {
  const { manifest, schemas } = await loadAmendedLexicon(dir);
  const cache = new Map();
  const stats = { local: 0, gateway: 0, failed: 0, manifest: 0 };

  const fromGateways = async (cid) => {
    if (cache.has(cid)) return cache.get(cid);
    for (const gateway of gateways) {
      try {
        const response = await fetchImpl(`${gateway}/ipfs/${cid}?format=raw`, {
          headers: { accept: "application/vnd.ipld.raw" },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) continue;
        const bytes = Buffer.from(await response.arrayBuffer());
        if (rawCid(bytes) !== cid) continue;
        cache.set(cid, { bytes, gateway });
        return { bytes, gateway };
      } catch {
        // try the next gateway
      }
    }
    return null;
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    if (url.pathname === "/api/manifest") {
      stats.manifest += 1;
      log({ event: "manifest" });
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(manifest);
      return;
    }
    const match = /^\/ipfs\/([^/]+)$/.exec(url.pathname);
    if (!match || !CID_PATTERN.test(match[1])) {
      response.writeHead(404).end();
      return;
    }
    const cid = match[1];
    const local = schemas.get(cid);
    if (local) {
      stats.local += 1;
      log({ event: "schema", cid, source: "amended" });
      response.writeHead(200, { "content-type": "application/vnd.ipld.raw" }).end(local);
      return;
    }
    const fetched = await fromGateways(cid);
    if (!fetched) {
      stats.failed += 1;
      log({ event: "schema", cid, source: "none" });
      response.writeHead(502).end();
      return;
    }
    stats.gateway += 1;
    log({ event: "schema", cid, source: fetched.gateway });
    response.writeHead(200, { "content-type": "application/vnd.ipld.raw" }).end(fetched.bytes);
  });
  return { server, stats };
}

async function main(argv) {
  const flags = { port: "8790" };
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith("--") || argv[index + 1] === undefined) throw new Error("usage: --dir <amended lexicon dir> [--port <port>]");
    flags[argv[index].slice(2)] = argv[index + 1];
  }
  if (!flags.dir) throw new Error("usage: --dir <amended lexicon dir> [--port <port>]");
  const { server, stats } = await createAmendedLexiconServer({ dir: path.resolve(flags.dir), log: (event) => console.log(JSON.stringify(event)) });
  server.listen(Number(flags.port), "127.0.0.1", () => {
    const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
    console.log(JSON.stringify({ event: "listening", manifest: `http://127.0.0.1:${port}/api/manifest`, gateway: `http://127.0.0.1:${port}` }));
  });
  const stop = () => {
    console.log(JSON.stringify({ event: "stopped", stats }));
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
