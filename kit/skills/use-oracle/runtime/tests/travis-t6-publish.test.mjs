import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rawCid, readCarBlocks } from "../src/counties/travis/publish.mjs";
import { buildPlan, buildShardManifest, cliLibraries, gatewayJobs, importFromCli, pinRoots, runGatewayChecks, summarizeGateways, unixfsCid, uploadAll, writeTablesCar } from "../src/counties/travis/t6-publish.mjs";

const CLI = process.env.ELEPHANT_CLI ?? "/Users/luti/dev/oracle-property-intelligence-platform-pipeline-travis-tx/node_modules/.bin/elephant-cli";
const hasCli = existsSync(CLI);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A one-block CAR of a dag-json block, as the CLI writes CountyIndex and CountyTables roots. */
async function dagJsonCar(libs, sha256, value, file) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const cid = libs.CID.create(1, 0x0129, await sha256.digest(bytes));
  const { writer, out } = libs.CarWriter.create([cid]);
  const chunks = [];
  const reading = (async () => { for await (const chunk of out) chunks.push(chunk); })();
  await writer.put({ cid, bytes });
  await writer.close();
  await reading;
  await writeFile(file, Buffer.concat(chunks));
  return cid.toString();
}

/** A sharded run of one shard: an archive, its tables (two parts, one of several chunks), a schema and a hash CSV. */
async function fixture() {
  const libs = await cliLibraries(CLI);
  const { sha256 } = await importFromCli(CLI, "multiformats/hashes/sha2");
  const runtime = await mkdtemp(path.join(tmpdir(), "travis-t6-"));
  const shardDir = "data/travis/runs/r1/shards/s0001/county-a1";
  await mkdir(path.join(runtime, shardDir, "tables", "parcel"), { recursive: true });
  await mkdir(path.join(runtime, shardDir, "tables", "properties"), { recursive: true });
  const schemaBytes = Buffer.from(JSON.stringify({ title: "County", properties: { label: {}, relationships: {} } }));
  const schemaCid = rawCid(schemaBytes);
  await mkdir(path.join(runtime, "schema-cache"));
  await writeFile(path.join(runtime, "schema-cache", `${schemaCid}.json`), schemaBytes);
  const archivePath = path.join(shardDir, "travis-county-s0001.car");
  const archiveRoot = await dagJsonCar(libs, sha256, { label: "CountyIndex", version: 1, properties: 1, shards: [] }, path.join(runtime, archivePath));
  const parts = [Buffer.alloc(300_000, 7), Buffer.from("small part")];
  const files = [path.join(shardDir, "tables", "parcel", "part-00000.parquet"), path.join(shardDir, "tables", "properties", "part-00000.parquet")];
  const cids = [];
  for (const [index, bytes] of parts.entries()) {
    await writeFile(path.join(runtime, files[index]), bytes);
    cids.push(await unixfsCid(libs.importer, bytes));
  }
  const tablesRoot = await dagJsonCar(libs, sha256, { label: "CountyTables", county_root: { "/": archiveRoot }, tables: { parcel: { parts: [{ bytes: parts[0].length, cid: { "/": cids[0] }, rows: 3 }], rows: 3 }, properties: { parts: [{ bytes: parts[1].length, cid: { "/": cids[1] }, rows: 1 }], rows: 1 } } }, path.join(runtime, shardDir, "tables", "tables.car"));
  await writeFile(path.join(runtime, shardDir, "hash.csv"), `propertyCid,dataGroupCid,dataCid\nbaguqeeraprop,${schemaCid},baguqeeradata\n`);
  const archiveBytes = await readFile(path.join(runtime, archivePath));
  const checks = { passed: true, integrity_errors: 0, root_errors: 0, index_errors: 0, graph_errors: 0, lexicon_errors: 0, orphans_errors: 0 };
  const run = {
    run_id: "r1",
    lexicon_manifest_url: "https://lexicon.example/api/manifest",
    lexicon_manifest: { sha256_start: "ab" },
    counts: { appraisal: { ready: 1 } },
    cars: [
      { root_cid: archiveRoot, group: "county", kind: "archive", shard: "s0001", schema_cid: schemaCid, block_count: 1, properties: 1, car_validation: checks, path: archivePath, size: archiveBytes.length, sha256: sha(archiveBytes) },
      { root_cid: tablesRoot, group: "county", kind: "tables", shard: "s0001", schema_cid: schemaCid, path: path.join(shardDir, "tables") },
    ],
  };
  await writeFile(path.join(runtime, "data/travis/runs/r1/run.json"), JSON.stringify(run));
  return { libs, runtime, run, archiveRoot, tablesRoot, cids, schemaCid, cleanup: () => rm(runtime, { recursive: true, force: true }) };
}

describe.skipIf(!hasCli)("T6 publication of a sharded run", () => {
  it("plans every root, part and schema, and refuses an archive whose recorded checks are not all 0", async () => {
    const f = await fixture();
    try {
      const plan = await buildPlan({ runDir: path.join(f.runtime, "data/travis/runs/r1"), runtimeDir: f.runtime, schemaCacheDir: path.join(f.runtime, "schema-cache") });
      expect(plan.problems).toEqual([]);
      expect(plan.tables[0].county_root).toBe(f.archiveRoot);
      expect(plan.tables[0].parts.map((part) => part.cid)).toEqual(f.cids);
      expect(plan.tables[0].parts[0].sha256).toBe(sha(Buffer.alloc(300_000, 7)));
      expect(plan.sample_extract).toEqual({ shard: "s0001", property_cid: "baguqeeraprop", data_group_root_cid: "baguqeeradata" });
      expect(plan.sizes.filebase_counted_bytes).toBe(2 * plan.sizes.distinct_bytes);
      expect(gatewayJobs(plan).map((job) => job.check)).toEqual(["raw", "raw", "raw", "file", "file"]);
      f.run.cars[0].car_validation.orphans_errors = 1;
      await writeFile(path.join(f.runtime, "data/travis/runs/r1/run.json"), JSON.stringify(f.run));
      const bad = await buildPlan({ runDir: path.join(f.runtime, "data/travis/runs/r1"), runtimeDir: f.runtime, schemaCacheDir: path.join(f.runtime, "schema-cache") });
      expect(bad.problems).toEqual(["county s0001: the recorded CAR checks are not all 0"]);
    } finally {
      await f.cleanup();
    }
  });

  it("writes a tables CAR of the CountyTables block and every part's blocks, and refuses a part the block does not link", async () => {
    const f = await fixture();
    try {
      const plan = await buildPlan({ runDir: path.join(f.runtime, "data/travis/runs/r1"), runtimeDir: f.runtime, schemaCacheDir: path.join(f.runtime, "schema-cache") });
      const outFile = path.join(f.runtime, "out", "tables.car");
      const made = await writeTablesCar({ entry: plan.tables[0], runtimeDir: f.runtime, outFile, libs: f.libs });
      const blocks = readCarBlocks(await readFile(outFile));
      expect(blocks[0].cid).toBe(f.tablesRoot);
      expect(blocks.every((block) => block.verified)).toBe(true);
      expect(blocks.map((block) => block.cid)).toEqual(expect.arrayContaining(f.cids));
      expect(made.block_count).toBe(blocks.length);
      expect(made.block_count).toBeGreaterThan(3);
      const tampered = { ...plan.tables[0], parts: [{ ...plan.tables[0].parts[0], cid: f.cids[1] }] };
      await expect(writeTablesCar({ entry: tampered, runtimeDir: f.runtime, outFile: path.join(f.runtime, "out", "bad.car"), libs: f.libs })).rejects.toThrow(/the CountyTables block links/);
    } finally {
      await f.cleanup();
    }
  });

  it("builds the manifest only when every root was uploaded and every gateway row matched", async () => {
    const f = await fixture();
    try {
      const plan = await buildPlan({ runDir: path.join(f.runtime, "data/travis/runs/r1"), runtimeDir: f.runtime, schemaCacheDir: path.join(f.runtime, "schema-cache") });
      const rows = gatewayJobs(plan).flatMap((job) => ["https://a", "https://b"].map((gateway) => ({ ...job, gateway, multihash: job.check === "raw" ? "match" : null, bytes: job.check === "file" ? "match" : undefined, size: 10, attempts: 1 })));
      const inputs = {
        plan,
        uploads: [{ kind: "archive", root: f.archiveRoot, gateway_url: "https://ipfs.filebase.io/ipfs/x" }, { kind: "tables", root: f.tablesRoot, gateway_url: null }],
        tablesCars: [{ root: f.tablesRoot, path: "/x/travis-county-s0001-tables.car", size: 1, sha256: "cd", block_count: 4, parts: 2 }],
        filebase: { checked_at: "t", rows: [{ pinned: true }], controls: [{ pinned: false }], all_pinned: true },
        gatewayRows: rows,
        gatewayFile: { path: "runs/r1.gateway-checks.json", sha256: "ef" },
        pins: [{ cid: f.archiveRoot, pinned: true }, { cid: f.tablesRoot, pinned: false, job_status: "retrieving", error: null }],
        release: { tag: "run-r1", status: "not created" },
      };
      const manifest = buildShardManifest(inputs);
      expect(manifest.objects.map((object) => object.codec)).toEqual(["directory", "directory", "file", "file", "file"]);
      expect(manifest.cars.map((car) => car.release_asset)).toEqual(["travis-county-s0001.car", "travis-county-s0001-tables.car"]);
      expect(manifest.second_pin.unpinned_roots).toEqual([{ cid: f.tablesRoot, job_status: "retrieving", request_status: undefined, error: null }]);
      expect(manifest.gateway_checks.per_gateway["https://a"]).toMatchObject({ rows: 5, match: 5, mismatch: 0, unverified: 0 });
      expect(() => buildShardManifest({ ...inputs, gatewayRows: [{ ...rows[0], multihash: "unverified" }, ...rows.slice(1)] })).toThrow(/1 gateway rows are not a match/);
      expect(() => buildShardManifest({ ...inputs, uploads: inputs.uploads.slice(1) })).toThrow(/was not uploaded/);
    } finally {
      await f.cleanup();
    }
  });
});

describe("T6 gateway checks and Pinata pins", () => {
  it("appends every row and on a rerun repeats only the rows without a definitive answer", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "travis-t6-gw-"));
    try {
      const jobs = [{ cid: "bafkreia", check: "raw" }, { cid: "bafybeib", check: "file", expected: { size: 3, sha256: "x" } }];
      const calls = [];
      let flaky = true;
      const check = async ({ cid, gateway, check: kind }) => {
        calls.push(`${gateway} ${cid}`);
        const unverified = flaky && cid === "bafybeib" && gateway === "https://g2";
        return kind === "raw" ? { cid, gateway, check: kind, multihash: "match", attempts: 1, url: "u", detail: null } : { cid, gateway, check: kind, multihash: null, bytes: unverified ? "unverified" : "match", size: 3, attempts: unverified ? 4 : 1, url: "u", detail: unverified ? "429" : null };
      };
      const jsonl = path.join(dir, "rows.jsonl");
      const first = await runGatewayChecks({ jobs, gateways: ["https://g1", "https://g2"], jsonl, check });
      expect(summarizeGateways(first)["https://g2"]).toMatchObject({ rows: 2, match: 1, unverified: 1, retried: 1 });
      flaky = false;
      calls.length = 0;
      const second = await runGatewayChecks({ jobs, gateways: ["https://g1", "https://g2"], jsonl, check });
      expect(calls).toEqual(["https://g2 bafybeib"]);
      expect(summarizeGateways(second)["https://g2"]).toMatchObject({ rows: 2, match: 2, unverified: 0 });
      expect((await readFile(jsonl, "utf8")).trim().split("\n")).toHaveLength(5);
      expect(JSON.parse((await readFile(jsonl, "utf8")).split("\n")[0]).url).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps a refusal and a pending job verbatim and marks a root pinned once Pinata lists it", async () => {
    let t = Date.parse("2026-10-19T00:00:00Z");
    const pinned = new Set();
    let polls = 0;
    const fetchImpl = async (url, options = {}) => {
      const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
      if (url.includes("/data/pinList")) {
        polls += 1;
        if (polls === 2) pinned.add("bafyA");
        return json(200, { rows: [...pinned].map((cid) => ({ ipfs_pin_hash: cid })) });
      }
      if (url.includes("/pinning/pinByHash")) {
        const { hashToPin } = JSON.parse(options.body);
        return hashToPin === "bafyB" ? json(403, { error: { reason: "PAID_FEATURE_ONLY" } }) : json(200, { id: `job-${hashToPin}`, status: "prechecking" });
      }
      if (url.includes("/pinning/pinJobs")) return json(200, { rows: [{ ipfs_pin_hash: "bafyC", status: "retrieving" }] });
      throw new Error(url);
    };
    const pins = await pinRoots({ roots: [{ cid: "bafyA", name: "a" }, { cid: "bafyB", name: "b" }, { cid: "bafyC", name: "c" }], jwt: "j", fetchImpl, waitMs: 3 * 60_000, pollMs: 60_000, now: () => new Date(t), sleepImpl: async (ms) => { t += ms; } });
    const by = Object.fromEntries(pins.map((pin) => [pin.cid, pin]));
    expect(by.bafyA).toMatchObject({ pinned: true, job_status: "pinned", request_status: 200 });
    expect(by.bafyB).toMatchObject({ pinned: false, request_status: 403 });
    expect(by.bafyB.error).toContain("PAID_FEATURE_ONLY");
    expect(by.bafyC).toMatchObject({ pinned: false, job_status: "retrieving", error: null });
  });

  it("records every failed upload, not only the last, and starts nothing new after one", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "travis-t6-up-"));
    try {
      const shards = ["s0001", "s0002", "s0003"];
      const plan = { archives: shards.map((shard) => ({ shard, group: "county", path: `${shard}.car`, root: `a-${shard}` })), tables: shards.map((shard) => ({ shard, group: "county", dir: `${shard}-tables`, root: `t-${shard}` })) };
      const started = [];
      const run = async (cli, args) => {
        started.push(path.basename(args[1]));
        const kind = args[1].endsWith("-tables") ? "t" : "a";
        const shard = path.basename(args[1]).slice(0, 5);
        if (kind === "t" && shard !== "s0001") {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return 1;
        }
        await writeFile(args[args.length - 1], JSON.stringify({ root: `${kind}-${shard}`, countyRoot: kind === "t" ? `a-${shard}` : undefined }));
        return 0;
      };
      const result = await uploadAll({ plan, out, cli: "cli", api: "https://rpc", concurrency: 1, runtimeDir: "/r", run });
      expect(result.failures.map((failure) => failure.shard)).toEqual(["s0002"]);
      expect(result.failed.shard).toBe("s0002");
      expect(started).not.toContain("s0003.car");
      const both = await uploadAll({ plan: { ...plan, archives: plan.archives.slice(1, 3) }, out: path.join(out, "again"), cli: "cli", api: "https://rpc", concurrency: 2, runtimeDir: "/r", run });
      expect(both.failures.map((failure) => failure.shard).sort()).toEqual(["s0002", "s0003"]);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
