import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ELIGIBILITY_ENV } from "../src/counties/travis/eligibility.mjs";
import { harvestAustinPermits } from "../src/counties/travis/t4-permit-fetch.mjs";
import { buildTcadPermitListing } from "../src/counties/travis/t4-tcad-permit-listing.mjs";
import { IMP_ATR_FIELDS, IMP_INFO_FIELDS, LAND_DET_FIELDS, PROP_ENT_FIELDS, PROP_EXTRA_FIELDS, buildTcadExtras } from "../src/counties/travis/t5-tcad-extras.mjs";
import { T5Run, estimateEta, formatDuration, invalidPropertiesFromErrors, parseFlags, resolveOptions } from "../src/counties/travis/t5-run.mjs";
import { currentGeneration, loadHistory } from "../src/counties/travis/t5-loader.mjs";
import { context, socrata, tcadAccount, withOut, writeSpecialExport } from "./travis-t4-socrata-mock.mjs";

const RUNTIME = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPLAY = path.join(RUNTIME, "fixtures", "travis-replay");
const FAKE_CLI = path.join(RUNTIME, "tests", "travis-t5-fake-elephant-cli.mjs");
const permit = (overrides) => ({ permittype: "BP", calendar_year_issued: "2021", issue_date: "2021-03-01T00:00:00.000", applieddate: "2021-02-01T00:00:00.000", status_current: "Final", completed_date: "2021-05-01T00:00:00.000", statusdate: "2021-05-01T00:00:00.000", work_class: "Repair", permit_class: "R- 435 Renovations/Remodel", description: "RE-ROOF RESIDENCE", ...overrides });
// 900001 (geo_id 0219080719): a completed re-roof and an active electrical permit; 900002: a re-roof on a retired id that
// TCAD's listing puts on it; one permit on another county's id.
const ROWS = [
  permit({ permit_number: "2021-000001 BP", tcad_id: "0219080719" }),
  permit({ permit_number: "2021-000002 EP", permittype: "EP", tcad_id: "0219080719", status_current: "Active", completed_date: "" }),
  permit({ permit_number: "2021-000003 BP", tcad_id: "R320021" }),
  permit({ permit_number: "2021-000004 BP", tcad_id: "0999999999" }),
];

const saved = process.env[ELIGIBILITY_ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[ELIGIBILITY_ENV];
  else process.env[ELIGIBILITY_ENV] = saved;
});

/** One fixed-width record (the extras builder's layout). */
function record(length, fields, values) {
  const chars = Array(length).fill(" ");
  for (const [name, value] of Object.entries(values)) {
    const [start, end, kind] = fields[name];
    const width = end - start + 1;
    const text = kind === "int" ? String(value).padStart(width, "0") : String(value).padEnd(width, " ");
    for (let index = 0; index < width; index += 1) chars[start - 1 + index] = text[index];
  }
  return chars.join("");
}

async function setup(out) {
  const capture = await harvestAustinPermits({ out: path.join(out, "permits"), context: context(socrata({ data: ROWS })) });
  const lineage = await writeSpecialExport(path.join(out, "lineage"), [tcadAccount(900001, [["2021-000001 BP", "0219080719"]]), tcadAccount(900002, [["2021-000004 BP", "0999999999", "2021-03-01 00:00:00"]])]);
  const { dir: listing } = await buildTcadPermitListing({ ...lineage, outRoot: path.join(out, "listing"), log: () => {} });
  const exportDir = path.join(out, "export");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(exportDir, { recursive: true });
  const PROP_ID = [1, 12, "int"];
  await writeFile(path.join(exportDir, "PROP.TXT"), [900001, 900002].map((id) => record(9922, { prop_id: PROP_ID, ...PROP_EXTRA_FIELDS }, { prop_id: id, prop_type_cd: "R", sup_num: 0, py_owner_id: id + 1, ten_percent_cap: 0 })).join("\n"));
  await writeFile(path.join(exportDir, "PROP_ENT.TXT"), [900001, 900002].map((id) => record(953, PROP_ENT_FIELDS, { prop_id: id, sup_num: 0, owner_id: id + 1, entity_cd: "03", entity_name: "TRAVIS COUNTY", taxable_val: 100000, partial_entity: "F" })).join("\n"));
  await writeFile(path.join(exportDir, "IMP_ATR.TXT"), record(87, IMP_ATR_FIELDS, { prop_id: 900001, imprv_id: 1, imprv_det_id: 1, imprv_attr_desc: "Roof Covering", imprv_attr_cd: "COMPOSITIO" }));
  await writeFile(path.join(exportDir, "LAND_DET.TXT"), record(199, LAND_DET_FIELDS, { prop_id: 900002, size_acres: 5000, size_square_feet: 21780 }));
  await writeFile(path.join(exportDir, "IMP_INFO.TXT"), record(114, IMP_INFO_FIELDS, { prop_id: 900001, imprv_id: 1, imprv_type_cd: "01", imprv_type_desc: "1 FAM DWELLING" }));
  const extrasDir = path.join(out, "extras");
  await buildTcadExtras({ seedPath: path.join(REPLAY, "seed.csv"), exportDir, archive: path.join(out, "none.zip"), outDir: extrasDir, skipReceipt: true });
  return [
    "--cli", FAKE_CLI,
    "--eligibility", "__ALL__",
    "--seed", path.join(REPLAY, "seed.csv"),
    "--roll-seed", path.join(REPLAY, "seed.csv"),
    "--manifest", path.join(REPLAY, "lexicon-manifest.json"),
    "--capture", capture.versionDir,
    "--tcad-listing", listing,
    "--tcad-listing-receipts", lineage.receiptsPath,
    "--tcad-extras", extrasDir,
    "--shard-size", "1",
    "--concurrency", "2",
    "--runs-dir", path.join(out, "runs"),
    "--loader-root", path.join(out, "loader"),
    "--label", "test",
    "--no-caffeinate",
  ];
}

async function runInProcess(flags, extra = {}) {
  const options = await resolveOptions(parseFlags(flags));
  const run = new T5Run({ ...options, log: () => {}, installSignals: false, progressIntervalMs: 3_600_000, ...extra });
  const result = await run.run();
  return { run, record: result, options };
}

/** Every stage marker of a run: `dir/stage` to `{attempt, input_digest, output digests}`. */
async function markers(runDir) {
  const out = {};
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && /^(global|shards|s\d{4})$/.test(entry.name)) await walk(full);
      else if (entry.name.endsWith(".done.json")) {
        const marker = JSON.parse(await readFile(full, "utf8"));
        out[path.relative(runDir, full)] = { attempt: marker.attempt, input: marker.input_digest, files: (marker.output.files ?? []).map((file) => file.sha256), root: marker.output.car?.root ?? marker.output.tables?.root ?? null };
      }
    }
  };
  await walk(runDir);
  return out;
}

describe("T5 runner helpers", () => {
  it("reads the failing properties from the CLI's error CSV, and estimates the ETA from finished parcels", () => {
    const csv = 'property_cid,data_group_cid,file_path,error_path,error_message,currentValue,timestamp\n,bafk,"county/900001/data/property.json",/property_type,"bad",X,t\n,bafk,"x/county/900002/data/tax_2026.json",/tax_year,"bad",1,t\n';
    expect([...invalidPropertiesFromErrors(csv, "county").keys()]).toEqual(["900001", "900002"]);
    expect(estimateEta({ parcelsDone: 0, parcelsTotal: 10, poolElapsedMs: 1000 })).toEqual({ eta_ms: null, parcels_per_hour: null });
    expect(estimateEta({ parcelsDone: 100, parcelsTotal: 400, poolElapsedMs: 3_600_000 })).toEqual({ eta_ms: 10_800_000, parcels_per_hour: 100 });
    expect(formatDuration(10_800_000)).toBe("3h00m");
    expect(formatDuration(125_000)).toBe("2m");
    expect(formatDuration(null)).toBe("?");
  });

  it("refuses to start without an explicit eligibility policy or a CLI", async () => {
    delete process.env[ELIGIBILITY_ENV];
    await expect(resolveOptions(parseFlags(["--cli", FAKE_CLI, "--runs-dir", "/nonexistent-t5"]))).rejects.toThrow(/--eligibility is required/);
    await expect(resolveOptions(parseFlags(["--eligibility", "__ALL__", "--runs-dir", "/nonexistent-t5"]))).rejects.toThrow(/--cli/);
  });
});

describe("T5 runner (fake elephant-cli, the replay seed in two shards)", () => {
  it("runs every stage, reconciles seed = ready + dead + invalid, merges both shards and writes the run record", async () => {
    await withOut(async (out) => {
      const flags = await setup(out);
      const { record, options } = await runInProcess(flags);
      expect(record.counts.appraisal).toMatchObject({ seed: 2, ready: 2, dead: 0, invalid: 0, retryable: 0, reconciles: true });
      expect(record.shards.total).toBe(2);
      expect(record.counts.permits).toMatchObject({ captured: 4, linked: 3, by_link_method: { exact: 2, normalized_digits: 0, tcad_permit_listing: 1 }, published: 3, parcels_with_permits: 2 });
      expect(record.unlinked_reasons).toMatchObject({ out_of_county: 1 });
      expect(record.cars.filter((car) => car.kind === "archive").map((car) => [car.group, car.shard])).toEqual([["county", "s0001"], ["property_improvement", "s0001"], ["county", "s0002"], ["property_improvement", "s0002"]]);
      expect(record.counts.tables.county).toEqual({ property: 2, parcel: 2 });
      expect(record.counts.tables.internal).toMatchObject({ permits: 4, query_table: 2, roof_age: 2 });
      // Roof age: the completed re-roof anchors 900001 (high); the listing-linked re-roof anchors 900002 with its caveat.
      expect(record.roof_age).toMatchObject({ parcels: 2, eligible: 2, by_basis: { completed_replacement: 2 }, by_confidence: { high: 2 }, anchor_link_method: { exact: 1, tcad_permit_listing: 1 }, caveats: { partial_history: 2, anchor_link_tcad_permit_listing: 1 } });
      expect(record.loader_watermarks.slice(0, 3).map((item) => item.track)).toEqual(["appraisal", "permits", "permits"]);
      expect(record.loader_watermarks[0]).toMatchObject({ merged_count: 2, merged_rows: 2 });
      expect(record.tombstones_consumed).toEqual({ dead: 0, invalid: 0 });
      expect(record.deltas.appraisal).toMatchObject({ new: 2, changed: 0, unchanged: 0 });
      expect(record.limitations.length).toBeGreaterThan(10);
      expect(record.readiness_report.overall).toBe("PASS");
      expect(record.lexicon_manifest.sha256_start).toBe(record.lexicon_manifest.sha256_end);
      // Transform v4 and the extras: 900001's structure, 900002's lot from its land segment.
      const appraisal = JSON.parse(await readFile(path.join(options.runDir, "shards", "s0001", "appraisal.done.json"), "utf8"));
      const structure = JSON.parse(await readFile(path.join(options.runDir, "shards", "s0001", appraisal.output.dir, "900001", "data", "structure.json"), "utf8"));
      expect(structure).toMatchObject({ roof_material_type: "Composition", roof_age_years: null });
      const query = await readdir(path.join(options.runDir, "shards", "s0002"));
      expect(query.some((name) => name.startsWith("reconcile-a"))).toBe(true);
      expect(await loadHistory(path.join(out, "loader", "test"))).toHaveLength(1);
    });
  });

  it("resumes without redoing anything when every marker matches, and a second finalize of the same merges is a no-op", async () => {
    await withOut(async (out) => {
      const flags = await setup(out);
      const first = await runInProcess(flags);
      const before = await markers(first.options.runDir);
      const loaderDir = path.join(out, "loader", "test");
      const generation = await currentGeneration(loaderDir);
      // The run finished, so the same command would start a new run; --resume names the finished one to rerun it in place.
      const statePath = path.join(first.options.runDir, "run-state.json");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      await writeFile(statePath, JSON.stringify({ ...state, status: "interrupted" }));
      const second = await runInProcess([...flags, "--resume", first.options.runDir]);
      expect(second.run.stageCounts.run).toBe(0);
      expect(await markers(first.options.runDir)).toEqual(before);
      expect(second.record.counts).toEqual(first.record.counts);
      // The Loader again over the same merges: nothing new, nothing changed, the watermark does not move.
      const { finalizeLoad } = await import("../src/counties/travis/t5-loader.mjs");
      const loaderMarker = JSON.parse(await readFile(path.join(first.options.runDir, "global", "loader.done.json"), "utf8"));
      const capture = second.run.captureDir;
      const partitions = (await readFile(path.join(capture, "receipts.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((receipt) => receipt.kind === "page" && receipt.status === 200 && !receipt.retried).map((receipt) => ({ file: receipt.file, sha256: receipt.sha256 }));
      const again = await finalizeLoad({ loaderDir, runId: second.run.state.run_id, runDir: first.options.runDir, shards: ["s0001", "s0002"], wholeSeed: true, capture: { dir: capture, partitions }, permitsRowsFile: path.join(second.run.linkDir, "permits-internal.jsonl") });
      expect(again.deltas.appraisal).toEqual({ new: 0, changed: 0, unchanged: 2, removed: 0 });
      expect(again.deltas.permits).toMatchObject({ new: 0, changed: 0, unchanged: 4 });
      expect(again.watermarks.map((item) => [item.artifact_hash, item.last_merged_at])).toEqual(generation.state.watermarks.map((item) => [item.artifact_hash, item.last_merged_at]));
      expect(loaderMarker.output.watermarks.map((item) => item.artifact_hash)).toEqual(again.watermarks.map((item) => item.artifact_hash));
      expect(await loadHistory(loaderDir)).toHaveLength(2);
    });
  });

  it("redoes only the stage whose marker is gone or no longer matches its output, with identical digests", async () => {
    await withOut(async (out) => {
      const flags = await setup(out);
      const first = await runInProcess(flags);
      const before = await markers(first.options.runDir);
      const shard = path.join(first.options.runDir, "shards", "s0002");
      // A crash between the CLI's exit and the marker: the hash output exists, its marker does not.
      await rename(path.join(shard, "county.hash.done.json"), path.join(shard, "county.hash.done.json.lost"));
      // An output changed after its marker was written: the tables are rebuilt.
      const exported = JSON.parse(await readFile(path.join(shard, "property_improvement.export_tables.done.json"), "utf8"));
      await writeFile(path.join(shard, exported.output.chain_dir, "tables", "part-0.parquet"), "tampered");
      const statePath = path.join(first.options.runDir, "run-state.json");
      await writeFile(statePath, JSON.stringify({ ...JSON.parse(await readFile(statePath, "utf8")), status: "interrupted" }));
      const second = await runInProcess([...flags, "--resume", first.options.runDir]);
      const after = await markers(first.options.runDir);
      const changed = Object.keys(after).filter((key) => after[key].attempt !== before[key]?.attempt).sort();
      // The two damaged stages rerun; every later stage still matches (same CAR, same tables), and so does the Loader.
      expect(changed).toEqual(["shards/s0002/county.hash.done.json", "shards/s0002/property_improvement.export_tables.done.json"]);
      expect(second.run.stageCounts.run).toBe(2);
      for (const key of Object.keys(before)) expect(after[key].files, key).toEqual(before[key].files);
      expect(second.record.counts.appraisal.reconciles).toBe(true);
    });
  });

  it("drops the properties elephant-cli validate fails, tombstones them as invalid and still reconciles", async () => {
    await withOut(async (out) => {
      const flags = await setup(out);
      process.env.FAKE_CLI_INVALID = "900002";
      try {
        const { record } = await runInProcess(flags);
        expect(record.counts.appraisal).toMatchObject({ seed: 2, ready: 1, dead: 0, invalid: 1, reconciles: true });
        expect(record.tombstones_consumed).toEqual({ dead: 0, invalid: 1 });
        expect(record.cars.filter((car) => car.kind === "archive" && car.group === "county").map((car) => car.shard)).toEqual(["s0001"]);
      } finally {
        delete process.env.FAKE_CLI_INVALID;
      }
    });
  });

  for (const signal of ["SIGTERM", "SIGKILL"]) {
    it(`after ${signal} mid-shard, the same command resumes, redoes only the stages in flight and ends with identical digests`, async () => {
      await withOut(async (out) => {
        const flags = await setup(out);
        // The uninterrupted run, in its own runs and loader directories.
        const baseline = await runInProcess([...flags.map((value) => value.replace(path.join(out, "runs"), path.join(out, "runs-base")).replace(path.join(out, "loader"), path.join(out, "loader-base")))]);
        const reference = await markers(baseline.options.runDir);
        // The interrupted run: one shard at a time, each CLI call slowed, killed while the second shard's CLI runs.
        const pidDir = path.join(out, "cli-pids");
        const interrupted = [...flags.map((value) => (value === "2" ? "1" : value))];
        const child = spawn(process.execPath, [path.join(RUNTIME, "src", "counties", "travis", "t5-run.mjs"), ...interrupted, "--progress-seconds", "3600"], { env: { ...process.env, FAKE_CLI_SLEEP_MS: "700", FAKE_CLI_PID_DIR: pidDir }, stdio: "ignore" });
        const exited = new Promise((resolve) => child.on("exit", (code, sig) => resolve({ code, sig })));
        const runsDir = path.join(out, "runs");
        let runDir = null;
        for (let wait = 0; wait < 600; wait += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (!existsSync(runsDir)) continue;
          const names = await readdir(runsDir);
          runDir = names.length ? path.join(runsDir, names[0]) : null;
          if (runDir && existsSync(path.join(runDir, "shards", "s0001", "merge.done.json")) && existsSync(path.join(runDir, "shards", "s0002", "appraisal.done.json"))) break;
        }
        expect(existsSync(path.join(runDir, "shards", "s0001", "merge.done.json"))).toBe(true);
        // Wait until a CLI process of shard s0002 is running, then kill the runner.
        for (let wait = 0; wait < 100; wait += 1) {
          const files = existsSync(pidDir) ? await readdir(pidDir) : [];
          const running = [];
          for (const file of files) {
            const info = JSON.parse(await readFile(path.join(pidDir, file), "utf8"));
            if (info.args[0] !== "--version" && info.args.some((arg) => arg.includes("county") || arg.includes(".car"))) running.push(info);
          }
          if (running.length > 0 && existsSync(path.join(runDir, "shards", "s0002", "reconcile.done.json"))) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        child.kill(signal);
        const status = await exited;
        expect(signal === "SIGKILL" ? status.sig : status.code).toBe(signal === "SIGKILL" ? "SIGKILL" : 143);
        const beforeResume = await markers(runDir);
        expect(Object.keys(beforeResume)).toContain("shards/s0001/merge.done.json");
        expect(Object.keys(beforeResume)).not.toContain("shards/s0002/merge.done.json");
        // The same command again: it finds the unfinished run of this label and resumes it.
        const resumed = await runInProcess(interrupted);
        expect(resumed.options.runDir).toBe(runDir);
        const after = await markers(runDir);
        // Nothing that had finished ran again ...
        for (const [key, value] of Object.entries(beforeResume)) expect(after[key].attempt, key).toBe(value.attempt);
        // ... and every output equals the uninterrupted run's.
        for (const [key, value] of Object.entries(reference)) {
          if (key === "global/loader.done.json" || key === "global/plan.done.json") continue;
          expect(after[key]?.files, key).toEqual(value.files);
        }
        expect(resumed.record.shards.per_shard.map((item) => [item.county_car_sha256, item.property_improvement_car_sha256])).toEqual(baseline.record.shards.per_shard.map((item) => [item.county_car_sha256, item.property_improvement_car_sha256]));
        expect(resumed.record.attempts.map((item) => item.status)).toEqual([signal === "SIGKILL" ? "running" : "stopped (SIGTERM)", "finished"]);
        await rm(pidDir, { recursive: true, force: true });
      });
    }, 120000);
  }
});
