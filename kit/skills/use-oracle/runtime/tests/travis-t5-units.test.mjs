import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { findVmProcesses, parseDfAvailable, parseSwapUsage, parseVmStat, runPreflight } from "../src/counties/travis/t5-preflight.mjs";
import { DEFAULT_AGE_THRESHOLD, LISTING_ANCHOR_CAVEAT, countRoofAge, emptyRoofAgeCounts, estimateParcelRoofAge, sumRoofAgeCounts } from "../src/counties/travis/t5-roof-age.mjs";
import { checkMarker, dataDirDigest, digestOf, planShards, reserveAttempt, treeDigest, writeMarker } from "../src/counties/travis/t5-shards.mjs";
import { finalizeLoad, recordShardMerge } from "../src/counties/travis/t5-loader.mjs";

async function tmp(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "t5-units-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("t5-shards: plan, markers, attempts", () => {
  it("cuts the sorted seed into shards of at most N rows, keeps each row's bytes, and steps the extras with it", async () => {
    await tmp(async (dir) => {
      const rows = ["7", "12", "100", "101", "2000"].map((id) => `${id},"{""type"":""Polygon"",""a"":[1,2]}",x`);
      await writeFile(path.join(dir, "seed.csv"), `parcel_id,parcel_polygon,other\n${rows.join("\n")}\n`);
      await writeFile(path.join(dir, "extras.jsonl"), ["7", "12", "100", "101", "2000"].map((id) => JSON.stringify({ prop_id: id, x: 1 })).join("\n") + "\n");
      const plan = await planShards({ seedPath: path.join(dir, "seed.csv"), extrasFile: path.join(dir, "extras.jsonl"), shardsDir: path.join(dir, "shards"), shardSize: 2 });
      expect(plan.shards.map((shard) => [shard.id, shard.rows, shard.first, shard.last])).toEqual([["s0001", 2, "7", "12"], ["s0002", 2, "100", "101"], ["s0003", 1, "2000", "2000"]]);
      expect(await readFile(path.join(dir, "shards", "s0002", "seed.csv"), "utf8")).toBe(`parcel_id,parcel_polygon,other\n${rows[2]}\n${rows[3]}\n`);
      expect((await readFile(path.join(dir, "shards", "s0003", "extras.jsonl"), "utf8")).trim()).toBe(JSON.stringify({ prop_id: "2000", x: 1 }));
      const limited = await planShards({ seedPath: path.join(dir, "seed.csv"), extrasFile: null, shardsDir: path.join(dir, "limited"), shardSize: 2, maxShards: 1 });
      expect(limited).toMatchObject({ rows: 2, seed_rows_read: 2, shards: [{ id: "s0001", rows: 2, extras_sha256: null }] });
    });
  });

  it("refuses an unsorted seed and extras out of step with it", async () => {
    await tmp(async (dir) => {
      await writeFile(path.join(dir, "seed.csv"), "parcel_id\n10\n9\n");
      await expect(planShards({ seedPath: path.join(dir, "seed.csv"), extrasFile: null, shardsDir: path.join(dir, "a"), shardSize: 5 })).rejects.toThrow(/not sorted/);
      await writeFile(path.join(dir, "seed2.csv"), "parcel_id\n9\n10\n");
      await writeFile(path.join(dir, "extras.jsonl"), `${JSON.stringify({ prop_id: "10" })}\n`);
      await expect(planShards({ seedPath: path.join(dir, "seed2.csv"), extrasFile: path.join(dir, "extras.jsonl"), shardsDir: path.join(dir, "b"), shardSize: 5 })).rejects.toThrow(/out of step/);
    });
  });

  it("accepts a marker only while its input digest and its outputs still match", async () => {
    await tmp(async (dir) => {
      await mkdir(path.join(dir, "out"), { recursive: true });
      await writeFile(path.join(dir, "out", "a.car"), "car bytes");
      await mkdir(path.join(dir, "out", "tables"), { recursive: true });
      await writeFile(path.join(dir, "out", "tables", "p0.parquet"), "part");
      const tree = await treeDigest(path.join(dir, "out", "tables"));
      const { sha256File } = await import("../src/counties/travis/t5-shards.mjs");
      await writeMarker(dir, "hash", { input: { car: "x", cli: "1.58.1" }, output: { files: [{ path: "out/a.car", sha256: await sha256File(path.join(dir, "out", "a.car")) }, { path: "out/tables", sha256: tree.sha256, tree: true }] }, attempt: 1, started_at: "t", ms: 1 });
      expect(await checkMarker(dir, "hash", { cli: "1.58.1", car: "x" })).toMatchObject({ valid: true });
      expect(await checkMarker(dir, "hash", { car: "x", cli: "1.58.2" })).toMatchObject({ valid: false, reason: "input changed" });
      await writeFile(path.join(dir, "out", "tables", "p0.parquet"), "other");
      expect(await checkMarker(dir, "hash", { car: "x", cli: "1.58.1" })).toMatchObject({ valid: false, reason: "output out/tables changed" });
      expect(await checkMarker(dir, "missing", {})).toMatchObject({ valid: false, reason: "no marker" });
      expect(digestOf({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(digestOf({ a: [2, { c: 2, d: 1 }], b: 1 }));
    });
  });

  it("counts every output's bytes when shards are checked concurrently into one stats object", async () => {
    await tmp(async (dir) => {
      const { sha256File } = await import("../src/counties/travis/t5-shards.mjs");
      const shards = Array.from({ length: 8 }, (_, i) => path.join(dir, `s${i}`));
      for (const [i, shard] of shards.entries()) {
        await mkdir(path.join(shard, "out"), { recursive: true });
        await writeFile(path.join(shard, "out", "a.car"), "x".repeat(100 + i));
        await writeMarker(shard, "hash", { input: { car: "x" }, output: { files: [{ path: "out/a.car", sha256: await sha256File(path.join(shard, "out", "a.car")) }] }, attempt: 1, started_at: "t", ms: 1 });
      }
      const stats = { outputs: 0, files: 0, bytes: 0 };
      await Promise.all(shards.map((shard) => checkMarker(shard, "hash", { car: "x" }, { stats })));
      expect(stats).toEqual({ outputs: 8, files: 8, bytes: 8 * 100 + 28 });
    });
  });

  it("never hands out an attempt twice, across crashes and attempt directories", async () => {
    await tmp(async (dir) => {
      expect(await reserveAttempt(dir, "appraisal", "appraisal-a", null)).toBe(1);
      expect(await reserveAttempt(dir, "appraisal", "appraisal-a", null)).toBe(2);
      await mkdir(path.join(dir, "appraisal-a7"));
      expect(await reserveAttempt(dir, "appraisal", "appraisal-a", null)).toBe(8);
      expect(await reserveAttempt(dir, "county.hash", null, { attempt: 3 })).toBe(4);
      expect((await readdir(dir)).filter((name) => name.endsWith(".started")).sort()).toEqual(["appraisal.a1.started", "appraisal.a2.started", "appraisal.a8.started", "county.hash.a4.started"]);
    });
  });
});

describe("t5-preflight: warnings, never a block", () => {
  it("parses swap, vm_stat, ps and df", () => {
    expect(parseSwapUsage("vm.swapusage: total = 7168.00M  used = 5724.38M  free = 1443.62M  (encrypted)")).toEqual({ total_bytes: 7516192768, used_bytes: Math.round(5724.38 * 1024 ** 2), free_bytes: Math.round(1443.62 * 1024 ** 2) });
    expect(parseVmStat("Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:  1000.\nPages inactive:  2000.\nPages speculative:  500.\n")).toEqual({ page_size: 16384, free_bytes: 16384000, available_bytes: 3500 * 16384 });
    expect(findVmProcesses(" 1 1024 /opt/homebrew/bin/limactl hostagent\n 2 4194304 /System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine\n 3 10 /bin/zsh -c colima status\n 4 20 /Applications/Docker.app/Contents/MacOS/com.docker.backend\n").map((item) => item.pid)).toEqual([1, 2, 4]);
    expect(parseDfAvailable("Filesystem 1024-blocks Used Available Capacity\n/dev/disk3s5 1951000000 1700000000 242000000 88% /System/Volumes/Data\n")).toBe(242000000 * 1024);
  });

  it("warns on heavy swap, a running VM, low memory and a small disk, and does not block", async () => {
    const report = await runPreflight({
      runDir: "/tmp",
      properties: 441961,
      probes: { swap: "total = 7168.00M  used = 5724.38M  free = 1443.62M", vmStat: "page size of 16384 bytes\nPages free: 100.\nPages inactive: 100.\n", ps: " 9 4194304 /opt/homebrew/opt/colima/bin/colima start -f\n", df: "F 1 2 3 4\n/dev/x 100 50 50000000 50% /\n", colima: "colima is running" },
    });
    expect(report.blocking).toBe(false);
    expect(report.warnings.map((warning) => warning.split(":")[0].split(" ").slice(0, 2).join(" "))).toEqual(["swap heavily", "a VM", "only 0", "47.7 GB"]);
    const idle = await runPreflight({ runDir: "/tmp", properties: 10, probes: { swap: "total = 1024.00M  used = 10.00M  free = 1014.00M", vmStat: "page size of 16384 bytes\nPages free: 10000000.\n", ps: " 9 1000 /opt/homebrew/opt/colima/bin/colima start -f\n", df: "F 1 2 3 4\n/dev/x 100 50 500000000 50% /\n", colima: null } });
    expect(idle.warnings).toEqual([]);
    expect(idle.colima).toMatchObject({ vm_running: false, idle_supervisor_processes: [{ pid: 9 }] });
  });
});

const permit = (overrides) => ({ permit_number: "2010-1 BP", permittype: "BP", status_current: "Final", applieddate: "2010-01-01T00:00:00.000", issue_date: "2010-01-15T00:00:00.000", completed_date: "2010-03-01T00:00:00.000", statusdate: "2010-03-01T00:00:00.000", work_class: "Repair", permit_class: "R- 435 Renovations/Remodel", description: "RE-ROOF RESIDENCE", ...overrides });
const linked = (row, method = "exact") => ({ row, link: { propertyLink: { match_method: method } } });

describe("t5-roof-age: the kit's estimator with the Travis profile", () => {
  it("anchors on the latest completed re-roof (high), never on an open one, and marks a listing-linked anchor", () => {
    const record = estimateParcelRoofAge({ propId: "1", builtYear: 1980, asOfDate: "2026-10-17", permits: [linked(permit({})), linked(permit({ permit_number: "2024-9 BP", status_current: "Active", completed_date: "", applieddate: "2024-01-01T00:00:00.000" }))] });
    expect(record).toMatchObject({ roof_year: 2010, roof_age_years: 16, roof_age_basis: "completed_replacement", roof_age_confidence: "high", roof_age_anchor: { permit_id: "2010-1 BP", date: "2010-03-01", date_field: "completed_date" }, roof_age_caveats: ["partial_history"] });
    expect(record.estimator).toMatchObject({ estimated_age_years: 16, eligibility_reason: "accepted_completed_primary_roof_replacement", permit_count: 2, anchor_link_method: "exact" });
    expect(record.estimator.permit_outcome_counts.excludedOpenPrimaryRoofReplacement).toBe(1);
    const listed = estimateParcelRoofAge({ propId: "2", builtYear: null, asOfDate: "2026-10-17", permits: [linked(permit({}), "tcad_permit_listing")] });
    expect(listed.roof_age_caveats).toEqual(["partial_history", LISTING_ANCHOR_CAVEAT].sort());
  });

  it("falls back to the built year (low) without permits, and to no age without either", () => {
    expect(estimateParcelRoofAge({ propId: "3", builtYear: 1998, asOfDate: "2026-10-17", permits: [] })).toMatchObject({ roof_year: 1998, roof_age_years: 28, roof_age_basis: "year_built", roof_age_confidence: "low", roof_age_anchor: { source_field: "year_built" }, roof_age_caveats: ["history_unknown"] });
    expect(estimateParcelRoofAge({ propId: "4", builtYear: null, asOfDate: "2026-10-17", permits: [] })).toMatchObject({ roof_year: null, roof_age_years: null, roof_age_basis: null, roof_age_confidence: "none", roof_age_anchor: null });
  });

  it("counts by basis, confidence, caveat and the strict 15-year threshold, and sums shards", () => {
    const counts = emptyRoofAgeCounts();
    countRoofAge(counts, estimateParcelRoofAge({ propId: "1", builtYear: 1980, asOfDate: "2026-10-17", permits: [linked(permit({}))] }));
    countRoofAge(counts, estimateParcelRoofAge({ propId: "3", builtYear: 2011, asOfDate: "2026-10-17", permits: [] }));
    countRoofAge(counts, estimateParcelRoofAge({ propId: "4", builtYear: null, asOfDate: "2026-10-17", permits: [] }));
    expect(counts).toMatchObject({ parcels: 3, eligible: 2, ineligible: 1, by_basis: { completed_replacement: 1, year_built: 1, none: 1 }, older_than_threshold: { threshold_years: DEFAULT_AGE_THRESHOLD, total: 1, by_basis: { completed_replacement: 1 } } });
    expect(sumRoofAgeCounts([counts, counts])).toMatchObject({ parcels: 6, eligible: 4, older_than_threshold: { total: 2 } });
  });
});

describe("t5-loader: ready gate and tombstones", () => {
  it("refuses a shard whose data no longer matches its ready marker, and tombstones dead parcels", async () => {
    await tmp(async (dir) => {
      const data = path.join(dir, "run", "shards", "s0001", "appraisal-a1", "1", "data");
      await mkdir(data, { recursive: true });
      await writeFile(path.join(data, "property.json"), "{}");
      const hash = await dataDirDigest(data);
      const loaderDir = path.join(dir, "loader");
      const table = path.join(dir, "q.parquet");
      await writeFile(table, "parquet");
      const common = { loaderDir, runId: "r1", shard: "s0001", dead: [{ key: "2", reason: "permanent_failure", evidence: "no situs address" }], invalid: [], retryable: [], permitGroups: [], tables: { query_table: { file: table, rows: 1 } } };
      await expect(recordShardMerge({ ...common, ready: [{ key: "1", dir: data, artifact_hash: "0".repeat(64) }] })).rejects.toThrow(/ready-hash gate/);
      const first = await recordShardMerge({ ...common, ready: [{ key: "1", dir: data, artifact_hash: hash }] });
      expect(first.written).toBe(true);
      expect((await recordShardMerge({ ...common, ready: [{ key: "1", dir: data, artifact_hash: hash }] })).written).toBe(false);
      const capture = path.join(dir, "capture");
      await mkdir(capture, { recursive: true });
      await writeFile(path.join(dir, "permits.jsonl"), `${JSON.stringify({ permit_key: "P1", permit_number: "P1", row_sha256: "a".repeat(64), property_id: "1", capture_row_index: 0, is_roofing: true })}\n`);
      const state = await finalizeLoad({ loaderDir, runId: "r1", runDir: path.join(dir, "run"), shards: ["s0001"], wholeSeed: true, capture: { dir: capture, partitions: [{ file: "p.csv", sha256: "b".repeat(64) }] }, permitsRowsFile: path.join(dir, "permits.jsonl") });
      expect(state.tombstones_consumed).toEqual({ dead: 1, invalid: 0 });
      expect(state.counts).toMatchObject({ appraisal_ready: 1, dead: 1, permits_rows: 1, permits_linked: 1 });
      expect(state.deltas.appraisal).toEqual({ new: 1, changed: 0, unchanged: 0, removed: 0 });
      // Run 2 without parcel 1 (it left the seed): tombstoned, its stale row dropped from the new generation.
      await writeFile(table, "parquet2");
      await recordShardMerge({ ...common, runId: "r2", dead: [], ready: [] });
      const second = await finalizeLoad({ loaderDir, runId: "r2", runDir: path.join(dir, "run"), shards: ["s0001"], wholeSeed: true, capture: { dir: capture, partitions: [{ file: "p.csv", sha256: "b".repeat(64) }] }, permitsRowsFile: path.join(dir, "permits.jsonl") });
      expect(second.deltas.appraisal).toEqual({ new: 0, changed: 0, unchanged: 0, removed: 1 });
      expect(second.tombstones).toMatchObject({ total: 1, stale_rows_removed: 1, by_reason: { absent_from_seed: 1 } });
      expect(second.prior_generation).toBe("r1");
    });
  });
});

describe("t5-run: a resume after SIGKILL stops the elephant-cli processes the killed runner left behind", () => {
  it("reaps a recorded orphan whose command is elephant-cli, and leaves unrelated processes alone", async () => {
    const { spawn } = await import("node:child_process");
    const { T5Run } = await import("../src/counties/travis/t5-run.mjs");
    await tmp(async (dir) => {
      const script = path.join(dir, "orphan-elephant-cli.mjs");
      await writeFile(script, "setTimeout(() => {}, 60000);\n");
      const other = path.join(dir, "unrelated.mjs");
      await writeFile(other, "setTimeout(() => {}, 60000);\n");
      const orphan = spawn(process.execPath, [script], { detached: true, stdio: "ignore" });
      const bystander = spawn(process.execPath, [other], { detached: true, stdio: "ignore" });
      orphan.unref();
      bystander.unref();
      const alive = (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const runDir = path.join(dir, "run");
        await mkdir(runDir, { recursive: true });
        await writeFile(path.join(runDir, "run-state.json"), JSON.stringify({ version: "travis-t5-run.v1", run_id: "run", label: "x", attempts: [{ attempt: 1, pid: 999999, status: "running" }], children: { [orphan.pid]: { shard: "s0009", stage: "county.validate" }, [bystander.pid]: { shard: "s0010", stage: "county.validate" } }, status: "running" }));
        const run = new T5Run({ runDir, label: "x", log: () => {} });
        await run.open();
        expect(run.attempt.reaped_orphans.map((item) => item.pid)).toEqual([orphan.pid]);
        expect(alive(orphan.pid)).toBe(false);
        expect(alive(bystander.pid)).toBe(true);
        expect(run.attempt).toMatchObject({ attempt: 2, resumed: true });
        await run.unlock();
      } finally {
        for (const pid of [orphan.pid, bystander.pid]) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // gone
          }
        }
      }
    });
  });
});
