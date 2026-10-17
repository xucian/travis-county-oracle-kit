import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildPublishManifest, dagCheck, filebasePins, gatewayCheck, parseCid, pinByCid, pinFile, rawCid, readCarBlocks, rootBlock } from "../src/counties/travis/publish.mjs";

const RUN_RECORD = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "docs", "evidence", "travis-t2-run-20261017T072132Z.json");
const sha = (bytes) => createHash("sha256").update(bytes).digest();

/** A fake clock whose sleep advances time, so retry deadlines are exercised without waiting. */
function clock() {
  const start = Date.parse("2026-10-17T00:00:00Z");
  let t = start;
  return { now: () => new Date(t), sleepImpl: async (ms) => { t += ms; }, elapsed: () => t - start };
}

/** Binary CIDv1 (sha2-256) for `bytes` under `codec` (0x55 raw, 0x0129 dag-json). */
function cidBytes(bytes, codec) {
  const codecVarint = codec === 0x55 ? [0x55] : [0xa9, 0x02];
  return Uint8Array.from([0x01, ...codecVarint, 0x12, 0x20, ...sha(bytes)]);
}

/** A CARv1 with an opaque header and one section per block (`[bytes, codec, tamper?]`). */
function car(blocks) {
  const header = Buffer.from("header");
  const sections = blocks.map(([bytes, codec, tamper]) => {
    const body = Buffer.concat([cidBytes(bytes, codec), tamper ? Buffer.from(tamper) : bytes]);
    return Buffer.concat([Buffer.from([body.length]), body]);
  });
  return Buffer.concat([Buffer.from([header.length]), header, ...sections]);
}

describe("T2 publication helpers", () => {
  it("parses CIDs of both codecs into their sha2-256 digests", () => {
    const bytes = Buffer.from('{"a":1}');
    const digest = createHash("sha256").update(bytes).digest("hex");
    const raw = parseCid(rawCid(bytes));
    expect(raw.codec).toBe("raw");
    expect(Buffer.from(raw.digest).toString("hex")).toBe(digest);
    const dagJson = parseCid("baguqeerahe3ecgiyigcgdg6gmxqsmc5ylzlucf4kb3n5xcqi5tvtiebpv2ta");
    expect(dagJson).toMatchObject({ codec: "dag-json", multihashCode: 0x12 });
    expect(dagJson.digest).toHaveLength(32);
    expect(rawCid("")).toBe("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
  });

  it("reads CAR blocks, verifies each against its CID and finds a root block by CID", () => {
    const leaf = Buffer.from("leaf bytes");
    const root = Buffer.from('{"label":"CountyIndex"}');
    const bytes = car([[leaf, 0x55], [root, 0x0129]]);
    const blocks = readCarBlocks(bytes);
    expect(blocks.map((block) => [block.codec, block.verified])).toEqual([["raw", true], ["dag-json", true]]);
    expect(blocks[0].cid).toBe(rawCid(leaf));
    const rootCid = blocks[1].cid;
    expect(parseCid(rootCid).codec).toBe("dag-json");
    expect(rootBlock(bytes, rootCid)).toEqual({ cid: rootCid, size: root.length, sha256: sha(root).toString("hex") });
    expect(() => rootBlock(car([[root, 0x0129, "tampered"]]), rootCid)).toThrow(/does not hash/);
    expect(() => rootBlock(car([[leaf, 0x55]]), rootCid)).toThrow(/holds no block/);
  });

  it("checks a gateway's raw block against the CID's multihash, retrying 429s and leaving timeouts unverified", async () => {
    const bytes = Buffer.from('{"b":2}');
    const cid = rawCid(bytes);
    const ok = await gatewayCheck({ cid, gateway: "https://ipfs.io", fetchImpl: async (url, init) => (expect(url).toBe(`https://ipfs.io/ipfs/${cid}?format=raw`), expect(init.headers.accept).toBe("application/vnd.ipld.raw"), new Response(bytes)) });
    expect(ok).toMatchObject({ check: "raw", status: 200, size: bytes.length, multihash: "match", codec: "raw", attempts: 1 });

    let calls = 0;
    const retried = await gatewayCheck({ cid, gateway: "https://dweb.link", ...clock(), fetchImpl: async () => ((calls += 1) < 3 ? new Response("slow down", { status: 429 }) : new Response(bytes)) });
    expect(retried).toMatchObject({ status: 200, multihash: "match", attempts: 3 });

    let origin = 0;
    const cloudflare = await gatewayCheck({ cid, gateway: "https://ipfs.io", ...clock(), fetchImpl: async () => ((origin += 1) < 2 ? new Response("SSL handshake failed", { status: 525 }) : new Response(bytes)) });
    expect(cloudflare).toMatchObject({ status: 200, multihash: "match", attempts: 2 });

    const bad = await gatewayCheck({ cid, gateway: "https://dweb.link", fetchImpl: async () => new Response("tampered") });
    expect(bad.multihash).toBe("mismatch");

    const late = clock();
    const timeout = async () => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      throw error;
    };
    const down = await gatewayCheck({ cid, gateway: "https://dweb.link", ...late, deadlineMs: 20 * 60_000, fetchImpl: timeout });
    expect(down).toMatchObject({ status: null, multihash: "unverified", error: "timeout" });
    expect(down.attempts).toBeGreaterThan(5);
    expect(late.elapsed()).toBeLessThanOrEqual(20 * 60_000);

    const gone = await gatewayCheck({ cid, gateway: "https://ipfs.io", ...clock(), fetchImpl: async () => new Response("blocked", { status: 410 }) });
    expect(gone).toMatchObject({ status: 410, multihash: "unverified", attempts: 1, detail: "blocked" });
  });

  it("waits as long as Retry-After asks and records the gateway's refusal text", async () => {
    const cid = rawCid("x");
    const fake = clock();
    const retired = await gatewayCheck({
      cid,
      gateway: "https://ipfs.io",
      ...fake,
      deadlineMs: 20 * 60_000,
      fetchImpl: async () => new Response("This IPFS gateway is switching to a service worker gateway only.\n See …", { status: 429, headers: { "retry-after": "900" } }),
    });
    expect(retired).toMatchObject({ status: 429, multihash: "unverified", attempts: 2, retry_after_s: 900, detail: "This IPFS gateway is switching to a service worker gateway only. See …" });
    expect(fake.elapsed()).toBe(900_000);
  });

  it("fetches a table part in full and compares size and sha256 with the run record", async () => {
    const bytes = Buffer.from("parquet part bytes");
    const cid = rawCid(bytes);
    const expected = { size: bytes.length, sha256: sha(bytes).toString("hex") };
    const fetchImpl = async (url) => (expect(url).toBe(`https://ipfs.io/ipfs/${cid}`), new Response(bytes));
    expect(await gatewayCheck({ cid, gateway: "https://ipfs.io", check: "file", expected, fetchImpl })).toMatchObject({ check: "file", bytes: "match", multihash: "match", size: bytes.length, expected_size: bytes.length });
    expect(await gatewayCheck({ cid, gateway: "https://ipfs.io", check: "file", expected: { ...expected, size: 1 }, fetchImpl })).toMatchObject({ bytes: "mismatch" });
  });

  it("checks a root's ?format=car stream block by block against the expected DAG", async () => {
    const leaf = Buffer.from("leaf");
    const root = Buffer.from('{"root":true}');
    const full = car([[leaf, 0x55], [root, 0x0129]]);
    const expectedDigests = [sha(leaf).toString("hex"), sha(root).toString("hex")];
    const rootCid = readCarBlocks(full)[1].cid;
    const match = await dagCheck({ root: rootCid, gateway: "https://ipfs.io", expectedDigests, fetchImpl: async (url) => (expect(url).toBe(`https://ipfs.io/ipfs/${rootCid}?format=car&dag-scope=all`), new Response(full)) });
    expect(match).toMatchObject({ result: "match", blocks: 2, verified_blocks: 2, bad_blocks: 0, missing_blocks: 0 });
    const short = await dagCheck({ root: rootCid, gateway: "https://ipfs.io", expectedDigests, ...clock(), deadlineMs: 120_000, fetchImpl: async () => new Response(car([[root, 0x0129]])) });
    expect(short).toMatchObject({ result: "unverified", missing_blocks: 1 });
    const tampered = await dagCheck({ root: rootCid, gateway: "https://ipfs.io", expectedDigests, fetchImpl: async () => new Response(car([[leaf, 0x55, "evil"], [root, 0x0129]])) });
    expect(tampered).toMatchObject({ result: "mismatch", bad_blocks: 1 });
  });

  it("pins by CID and waits for Pinata to list the pin", async () => {
    const calls = [];
    let lists = 0;
    const fetchImpl = async (url, init) => {
      calls.push([url, init?.method ?? "GET", init?.body ?? null]);
      if (url.endsWith("/pinning/pinByHash")) return new Response(JSON.stringify({ id: "job", status: "prechecking" }));
      if (url.includes("/pinning/pinJobs")) return new Response(JSON.stringify({ count: 1, rows: [{ status: "retrieving" }] }));
      lists += 1;
      return new Response(JSON.stringify({ count: lists > 2 ? 1 : 0 }));
    };
    const pin = await pinByCid({ cid: "bafkreiexample", name: "travis-county", jwt: "test-token", fetchImpl, ...clock(), pollMs: 1 });
    expect(pin).toMatchObject({ pinned: true, requested: true, already_pinned: false, request_status: 200, job_id: "job", job_status: "pinned", checks: 2 });
    expect(calls[0][0]).toBe("https://api.pinata.cloud/data/pinList?hashContains=bafkreiexample&status=pinned");
    expect(calls[1]).toEqual(["https://api.pinata.cloud/pinning/pinByHash", "POST", JSON.stringify({ hashToPin: "bafkreiexample", pinataMetadata: { name: "travis-county" } })]);
  });

  it("records a Pinata refusal, a pin still pending at the bound and a failed job instead of throwing", async () => {
    const answer = (job) => async (url) => {
      if (url.endsWith("/pinning/pinByHash")) return new Response(JSON.stringify({ id: "j", status: "prechecking" }));
      if (url.includes("pinJobs")) return new Response(JSON.stringify({ rows: [{ status: job }] }));
      return new Response(JSON.stringify({ count: 0 }));
    };
    const refused = await pinByCid({
      cid: "bafkreiexample",
      name: "n",
      jwt: "t",
      ...clock(),
      fetchImpl: async (url) => (url.endsWith("/pinning/pinByHash") ? new Response(JSON.stringify({ error: { reason: "NO_SCOPES_FOUND" } }), { status: 403 }) : new Response(JSON.stringify({ count: 0 }))),
    });
    expect(refused).toMatchObject({ requested: false, pinned: false, request_status: 403 });
    expect(refused.error).toContain("NO_SCOPES_FOUND");

    const fake = clock();
    const pending = await pinByCid({ cid: "bafkreiexample", name: "n", jwt: "t", ...fake, pollMs: 15_000, waitMs: 30 * 60_000, fetchImpl: answer("searching") });
    expect(pending).toMatchObject({ requested: true, pinned: false, job_status: "searching" });
    expect(fake.elapsed()).toBeLessThanOrEqual(30 * 60_000);

    const expired = await pinByCid({ cid: "bafkreiexample", name: "n", jwt: "t", ...clock(), fetchImpl: answer("expired") });
    expect(expired).toMatchObject({ pinned: false, job_status: "expired", checks: 1 });

    const unlisted = await pinByCid({
      cid: "bafkreiexample",
      name: "n",
      jwt: "t",
      ...clock(),
      fetchImpl: async (url) => (url.endsWith("/pinning/pinByHash") ? new Response(JSON.stringify({ id: "j" })) : new Response("forbidden", { status: 403 })),
    });
    expect(unlisted).toMatchObject({ requested: true, pinned: false, last_list_status: 403, checks: 1 });

    const already = await pinByCid({ cid: "bafkreiexample", name: "n", jwt: "t", fetchImpl: async () => new Response(JSON.stringify({ count: 1 })) });
    expect(already).toMatchObject({ already_pinned: true, pinned: true, requested: false });
  });

  it("asks Filebase's pin/ls for every CID and requires the negative control to come back unpinned", async () => {
    const pinned = new Set(["bafkreione", "bafkreitwo"]);
    const fetchImpl = async (url, init) => {
      expect(init).toMatchObject({ method: "POST", headers: { authorization: "Bearer tok" } });
      const cid = new URL(url).searchParams.get("arg");
      return new Response(JSON.stringify({ Keys: pinned.has(cid) ? { [cid]: { Type: "recursive" } } : {} }));
    };
    const all = await filebasePins({ cids: ["bafkreione", "bafkreitwo"], token: "tok", fetchImpl });
    expect(all).toMatchObject({ all_pinned: true, control: { pinned: false } });
    expect(all.rows).toEqual([{ cid: "bafkreione", status: 200, pinned: true, type: "recursive" }, { cid: "bafkreitwo", status: 200, pinned: true, type: "recursive" }]);
    expect((await filebasePins({ cids: ["bafkreione", "bafkreimissing"], token: "tok", fetchImpl })).all_pinned).toBe(false);
    const echoing = async (url) => new Response(JSON.stringify({ Keys: { [new URL(url).searchParams.get("arg")]: { Type: "recursive" } } }));
    expect((await filebasePins({ cids: ["bafkreione"], token: "tok", fetchImpl: echoing })).all_pinned).toBe(false);
  });

  it("pins a small file with cidVersion 1 and refuses a CID other than its raw CID", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "travis-publish-"));
    try {
      const file = path.join(dir, "manifest.json");
      await writeFile(file, '{"c":3}');
      const expected = rawCid('{"c":3}');
      expect(await pinFile({ file, name: "m", jwt: "t", fetchImpl: async () => new Response(JSON.stringify({ IpfsHash: expected })) })).toMatchObject({ cid: expected, size: 7 });
      await expect(pinFile({ file, name: "m", jwt: "t", fetchImpl: async () => new Response(JSON.stringify({ IpfsHash: "bafybeiother" })) })).rejects.toThrow(/expected/);
      await expect(pinFile({ file, name: "m", jwt: "t", fetchImpl: async () => new Response("no", { status: 401 }) })).rejects.toThrow(/HTTP 401/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("builds publish/<run_id>/manifest.json from the run record, refusing unmatched roots, missing pins or unverified root blocks", async () => {
    const runRecord = JSON.parse(await readFile(RUN_RECORD, "utf8"));
    const archive = runRecord.cars.find((car) => car.kind === "archive");
    const tables = runRecord.cars.find((car) => car.kind === "tables");
    const digest = (cid) => Buffer.from(parseCid(cid).digest).toString("hex");
    const inputs = {
      runRecord,
      carUpload: { root: archive.root_cid, gatewayUrl: `https://ipfs.filebase.io/ipfs/${archive.root_cid}` },
      tablesUpload: { root: tables.root_cid, countyRoot: archive.root_cid, gatewayUrl: `https://ipfs.filebase.io/ipfs/${tables.root_cid}` },
      rootBlocks: { [archive.root_cid]: { size: 132, sha256: digest(archive.root_cid) }, [tables.root_cid]: { size: 3369, sha256: digest(tables.root_cid) } },
      gatewayChecks: [{ cid: archive.schema_cid, check: "raw", multihash: "match", size: 4242, sha256: digest(archive.schema_cid) }],
      pins: [{ cid: archive.root_cid, pinned: true }, { cid: tables.root_cid, pinned: true }],
      sampleExtract: { property_cid: "p", data_group_root_cid: "d" },
    };
    const manifest = buildPublishManifest(inputs);
    expect(manifest.objects).toHaveLength(2 + runRecord.tables.parts.length + 1);
    expect(manifest.objects.map((object) => object.name)).not.toContain("manifest.json");
    expect(manifest.objects.every((object) => /^b[a-z2-7]+$/.test(object.cid) && ["file", "directory"].includes(object.codec) && !("origins" in object))).toBe(true);
    const [root, tablesRoot] = manifest.objects;
    expect(root).toMatchObject({ codec: "directory", size: 132, sha256: digest(archive.root_cid), digest_of: "root block" });
    expect(root.sha256).not.toBe(archive.sha256);
    expect(tablesRoot).toMatchObject({ codec: "directory", size: 3369 });
    expect(manifest.objects.at(-1)).toMatchObject({ cid: archive.schema_cid, size: 4242, sha256: digest(archive.schema_cid) });
    const fromFile = buildPublishManifest({ ...inputs, gatewayChecks: [], schemaBlock: { size: 14728, sha256: digest(archive.schema_cid) } });
    expect(fromFile.objects.at(-1)).toMatchObject({ size: 14728, sha256: digest(archive.schema_cid) });
    expect(buildPublishManifest({ ...inputs, gatewayChecks: [] }).objects.at(-1)).toMatchObject({ size: null, sha256: null });
    expect(() => buildPublishManifest({ ...inputs, schemaBlock: { size: 1, sha256: "00" } })).toThrow(/do not hash/);
    expect(manifest.indexes).toEqual({ county_index: archive.root_cid, county_tables: tables.root_cid });
    expect(manifest.cars.every((car) => car.readback_url)).toBe(true);
    expect(manifest.cars.find((car) => car.kind === "archive")).toMatchObject({ sha256: archive.sha256, size: archive.size });
    expect(() => buildPublishManifest({ ...inputs, carUpload: { root: "bafkreiother" } })).toThrow(/not the recorded/);
    expect(() => buildPublishManifest({ ...inputs, tablesUpload: { ...inputs.tablesUpload, countyRoot: "bafkreiother" } })).toThrow(/point at/);
    expect(() => buildPublishManifest({ ...inputs, rootBlocks: {} })).toThrow(/no verified root block/);
    expect(manifest.second_pin).toEqual({ vendor: "pinata", method: "pin-by-CID", all_roots_pinned: true, unpinned_roots: [] });

    const refused = [archive.root_cid, tables.root_cid].map((cid) => ({ cid, pinned: false, request_status: 403, error: "pinByHash HTTP 403: PAID_FEATURE_ONLY" }));
    expect(() => buildPublishManifest({ ...inputs, pins: [] })).toThrow(/no Pinata pin outcome recorded/);
    expect(() => buildPublishManifest({ ...inputs, pins: refused })).toThrow(/not pinned on Pinata/);
    expect(() => buildPublishManifest({ ...inputs, pins: refused.slice(0, 1), acceptUnpinned: true })).toThrow(/no Pinata pin outcome recorded/);
    const unpinned = buildPublishManifest({ ...inputs, pins: refused, acceptUnpinned: true });
    expect(unpinned.second_pin).toMatchObject({ all_roots_pinned: false, unpinned_roots: [archive.root_cid, tables.root_cid] });
    expect(unpinned.pins).toEqual(refused);
    expect(unpinned.notes.some((note) => note.startsWith("The second pin is missing"))).toBe(true);
  });
});
