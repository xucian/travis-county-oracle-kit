import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ELIGIBILITY_ENV } from "../src/counties/travis/eligibility.mjs";
import { harvestAustinPermits } from "../src/counties/travis/t4-permit-fetch.mjs";
import { buildTcadPermitListing } from "../src/counties/travis/t4-tcad-permit-listing.mjs";
import { IMP_ATR_FIELDS, IMP_INFO_FIELDS, LAND_DET_FIELDS, PROP_ENT_FIELDS, PROP_EXTRA_FIELDS, buildTcadExtras } from "../src/counties/travis/t5-tcad-extras.mjs";
import { STAGE_CODE, T5Run, armExitWatchdog, codeDigest, estimateEta, formatDuration, invalidPropertiesFromErrors, parseFlags, prepareNextRun, resolveOptions } from "../src/counties/travis/t5-run.mjs";
import { currentGeneration, loadHistory } from "../src/counties/travis/t5-loader.mjs";
import { digestOf } from "../src/counties/travis/t5-shards.mjs";
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

  it("starts the next run from a newer capture: County carried, only the changed shard's Property Improvement reruns, the earlier run untouched", async () => {
    await withOut(async (out) => {
      const flags = await setup(out);
      const first = await runInProcess(flags);
      const before = await markers(first.options.runDir);
      const beforeRecord = await readFile(path.join(first.options.runDir, "run.json"), "utf8");
      // Three days later the export holds every row again; 900001's electrical permit is now final.
      const changed = ROWS.map((row) => (row.permit_number === "2021-000002 EP" ? { ...row, status_current: "Final", completed_date: "2021-06-01T00:00:00.000", statusdate: "2021-06-01T00:00:00.000" } : row));
      const capture = await harvestAustinPermits({ out: path.join(out, "permits"), context: context(socrata({ data: changed, versionOf: () => 1792499798 })) });
      await new Promise((resolve) => setTimeout(resolve, 1100)); // a new run directory name (seconds)
      const at = flags.indexOf("--capture");
      const nextFlags = [...flags.slice(0, at), "--capture", capture.versionDir, ...flags.slice(at + 2), "--next-run", "latest"];
      const options = await resolveOptions(parseFlags(nextFlags));
      expect(options.nextOf).toBe(first.options.runDir);
      const previous = await prepareNextRun({ fromDir: options.nextOf, toDir: options.runDir, captureDir: options.captureDir });
      expect(previous.run_id).toBe(first.record.run_id);
      const run = new T5Run({ ...options, log: () => {}, installSignals: false, progressIntervalMs: 3_600_000 });
      const record = await run.run();
      // The earlier run is untouched.
      expect(await markers(first.options.runDir)).toEqual(before);
      expect(await readFile(path.join(first.options.runDir, "run.json"), "utf8")).toBe(beforeRecord);
      const after = await markers(options.runDir);
      const kept = (key) => after[key].attempt === before[key].attempt && after[key].input === before[key].input;
      for (const shard of ["s0001", "s0002"]) for (const step of ["validate", "hash", "car_validate", "export_tables"]) expect(kept(`shards/${shard}/county.${step}.done.json`), `${shard} county.${step}`).toBe(true);
      for (const step of ["validate", "hash", "car_validate", "export_tables"]) {
        expect(kept(`shards/s0002/property_improvement.${step}.done.json`), `s0002 ${step}`).toBe(true);
        expect(kept(`shards/s0001/property_improvement.${step}.done.json`), `s0001 ${step}`).toBe(false);
      }
      expect(after["shards/s0001/property_improvement.hash.done.json"].root).not.toBe(before["shards/s0001/property_improvement.hash.done.json"].root);
      expect(record.run_id).not.toBe(first.record.run_id);
      expect(record.previous_run).toMatchObject({ run_id: first.record.run_id });
      expect(record.changed_since_previous.groups).toEqual({
        county: { archives: 2, unchanged: 2, new_roots: 0, shards_with_new_roots: [] },
        property_improvement: { archives: 2, unchanged: 1, new_roots: 1, shards_with_new_roots: ["s0001"] },
      });
      expect(record.changed_since_previous.carried_stages).toMatchObject({ cli_county_validate: 2, cli_property_improvement_validate: 1 });
      expect(record.timings.stages.cli_county_validate).toBeUndefined();
      expect(record.timings.stages.cli_property_improvement_validate.shards).toBe(1);
      expect(record.attempts.map((attempt) => attempt.attempt)).toEqual([1]);
      expect(record.deltas.permits).toMatchObject({ new: 0, changed: 1, unchanged: 3, removed: 0 });
      expect(record.deltas.appraisal).toMatchObject({ new: 0, changed: 0, unchanged: 2, removed: 0 });
      expect(record.counts.appraisal).toEqual(first.record.counts.appraisal);
      expect(record.loader.prior_generation).toBe(first.record.run_id);
      expect(await loadHistory(path.join(out, "loader", "test"))).toHaveLength(2);
      // The finished next run verifies read-only, and a second --next-run of the earlier run is refused.
      const verify = new T5Run({ ...(await resolveOptions(parseFlags(flags.filter((flag, index) => index !== at && index !== at + 1)))), log: () => {}, installSignals: false });
      expect((await verify.verify({ full: false })).status).toBe("verified");
      await expect(resolveOptions(parseFlags([...nextFlags.slice(0, -2), "--next-run", first.options.runDir]))).rejects.toThrow(/is newer than/);
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

/** Every file and directory under `dirs`: relative path to size and mtime (what a run would change). */
async function snapshot(dirs) {
  const out = {};
  const walk = async (root, dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const info = await stat(full);
      out[`${path.basename(root)}/${path.relative(root, full)}`] = `${info.size}:${info.mtimeMs}`;
      if (entry.isDirectory()) await walk(root, full);
    }
  };
  for (const dir of dirs) await walk(dir, dir);
  return out;
}

const alivePid = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (check, ms) => {
  for (let waited = 0; waited < ms; waited += 100) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return check();
};

describe("T5 runner exit (decisions.md section 27: the full run printed done and did not exit)", () => {
  it("the exit watchdog stops a process still alive past its grace, with SIGKILL when SIGTERM is ignored", async () => {
    // A stand-in for a runner stuck after its exit: it ignores SIGTERM and keeps a timer; its command names t5-run.
    const stuck = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);", "t5-run-stand-in"], { stdio: "ignore" });
    const ended = new Promise((resolve) => stuck.on("exit", (code, signal) => resolve({ code, signal })));
    await waitFor(() => alivePid(stuck.pid), 2000);
    const watchdog = armExitWatchdog({ pid: stuck.pid, code: 0, graceSeconds: 1, termSeconds: 1 });
    expect(watchdog).toBeGreaterThan(0);
    const result = await Promise.race([ended, new Promise((resolve) => setTimeout(() => resolve("still alive"), 15000))]);
    expect(result).toEqual({ code: null, signal: "SIGKILL" });
  }, 20000);

  it("the exit watchdog leaves a process alone once its command no longer names the runner (a reused pid), and leaves when its target exits", async () => {
    const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);", "not-the-runner"], { stdio: "ignore" });
    try {
      await waitFor(() => alivePid(other.pid), 2000);
      const watchdog = armExitWatchdog({ pid: other.pid, code: 0, graceSeconds: 1, termSeconds: 1 });
      await new Promise((resolve) => setTimeout(resolve, 3500));
      expect(alivePid(other.pid)).toBe(true);
      expect(await waitFor(() => !alivePid(watchdog), 3000)).toBe(true);
    } finally {
      other.kill("SIGKILL");
    }
    const quick = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300);", "t5-run-stand-in"], { stdio: "ignore" });
    await waitFor(() => alivePid(quick.pid), 2000);
    const watchdog = armExitWatchdog({ pid: quick.pid, code: 0, graceSeconds: 30, termSeconds: 1 });
    expect(await waitFor(() => !alivePid(quick.pid), 5000)).toBe(true);
    expect(await waitFor(() => !alivePid(watchdog), 4000)).toBe(true);
  }, 20000);

  it("a real runner process exits with code 0 right after done, even with a handle left open; the same command then only verifies, read-only", async () => {
    await withOut(async (out) => {
      const flags = await setup(out);
      // A ref'd timer and interval loaded into the runner (--import): without the explicit exit they keep it alive.
      const leak = path.join(out, "leak.mjs");
      await writeFile(leak, "setInterval(() => {}, 1000);\nsetTimeout(() => {}, 1e9);\n");
      const launch = () => {
        const child = spawn(process.execPath, ["--import", leak, path.join(RUNTIME, "src", "counties", "travis", "t5-run.mjs"), ...flags, "--progress-seconds", "3600"], { env: { ...process.env, T5_EXIT_WATCHDOG_SECONDS: "5" }, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let doneAt = null;
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          if (doneAt === null && /\[t5\] done:|"travis_t5_verify"/.test(stdout)) doneAt = Date.now();
        });
        child.stderr.on("data", () => {});
        const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, at: Date.now() })));
        return { child, exited, output: () => stdout, doneAt: () => doneAt };
      };
      const first = launch();
      const status = await Promise.race([first.exited, new Promise((resolve) => setTimeout(() => resolve("timeout"), 90000))]);
      if (status === "timeout") first.child.kill("SIGKILL");
      expect(status).not.toBe("timeout");
      expect(status).toMatchObject({ code: 0, signal: null });
      expect(first.output()).toMatch(/"status":"finished"/);
      expect(status.at - first.doneAt()).toBeLessThan(4000);
      const runsDir = path.join(out, "runs");
      const runs = await readdir(runsDir);
      expect(runs).toHaveLength(1);
      // The same command on the finished run: a quick verification that writes nothing and exits 0.
      const before = await snapshot([path.join(runsDir, runs[0]), path.join(out, "loader", "test")]);
      const second = launch();
      const again = await Promise.race([second.exited, new Promise((resolve) => setTimeout(() => resolve("timeout"), 60000))]);
      if (again === "timeout") second.child.kill("SIGKILL");
      expect(again).toMatchObject({ code: 0, signal: null });
      const report = JSON.parse(second.output().trim().split("\n").at(-1));
      expect(report).toMatchObject({ travis_t5_verify: runs[0], mode: "quick", status: "verified", run_json: "equal", mismatch_count: 0, wrote: "nothing" });
      expect(report.stages_checked).toBeGreaterThan(20);
      expect(await readdir(runsDir)).toEqual(runs);
      expect(await snapshot([path.join(runsDir, runs[0]), path.join(out, "loader", "test")])).toEqual(before);
    });
  }, 180000);
});

describe("T5 runner verification of a finished run (read-only)", () => {
  it("the quick and the full verification pass and write nothing; the full one names a changed CAR's stage, the quick one sees its size in run.json", async () => {
    await withOut(async (out) => {
      const flags = await setup(out);
      const first = await runInProcess(flags);
      const dirs = [first.options.runDir, path.join(out, "loader", "test")];
      const before = await snapshot(dirs);
      const quickOptions = await resolveOptions(parseFlags(flags));
      expect(quickOptions).toMatchObject({ mode: "verify-quick", runDir: first.options.runDir });
      const quick = await new T5Run({ ...quickOptions, log: () => {} }).verify({ full: false });
      expect(quick).toMatchObject({ status: "verified", run_json: "equal", outputs_rehashed: { files: 0, bytes: 0 }, loader: { state_sha256_matches: true, in_history: true }, counts: { seed: 2, ready: 2, dead: 0, invalid: 0, reconciles: true } });
      const fullOptions = await resolveOptions(parseFlags([...flags, "--verify"]));
      expect(fullOptions.mode).toBe("verify-full");
      const full = await new T5Run({ ...fullOptions, log: () => {} }).verify({ full: true });
      expect(full).toMatchObject({ status: "verified", run_json: "equal", capture: { ok: true } });
      expect(full.outputs_rehashed.files).toBeGreaterThan(full.outputs_checked - 1);
      expect(await snapshot(dirs)).toEqual(before);
      // Change one archive CAR after the run: the full verification names the stage, the quick one cannot see content.
      const car = first.record.cars.find((item) => item.kind === "archive" && item.group === "county");
      await writeFile(path.join(RUNTIME, car.path), "changed after the run\n");
      const caught = await new T5Run({ ...fullOptions, log: () => {} }).verify({ full: true });
      expect(caught.status).toBe("mismatch");
      expect(caught.mismatches[0]).toMatchObject({ stage: "county.hash" });
      expect(caught.mismatches[0].reason).toMatch(/changed/);
      // The quick one re-hashes nothing, but the CAR's size is in run.json, so the rebuilt record no longer matches.
      const quickAfter = await new T5Run({ ...quickOptions, log: () => {} }).verify({ full: false });
      expect(quickAfter.status).toBe("mismatch");
      expect(quickAfter.run_json).toEqual({ differs: ["cars"] });
    });
  });

  it("refuses ambiguous flags: --new with --verify, --reopen on an unfinished run; --reopen on a finished run runs it in place", async () => {
    await withOut(async (out) => {
      const flags = await setup(out);
      await expect(resolveOptions(parseFlags([...flags, "--new", "--verify"]))).rejects.toThrow(/--new starts a fresh run/);
      await expect(resolveOptions(parseFlags([...flags, "--verify"]))).rejects.toThrow(/to verify/);
      const first = await runInProcess(flags);
      const reopen = await resolveOptions(parseFlags([...flags, "--reopen"]));
      expect(reopen).toMatchObject({ mode: "run", reopen: true, runDir: first.options.runDir });
      const statePath = path.join(first.options.runDir, "run-state.json");
      await writeFile(statePath, JSON.stringify({ ...JSON.parse(await readFile(statePath, "utf8")), status: "interrupted" }));
      await expect(resolveOptions(parseFlags([...flags, "--reopen"]))).rejects.toThrow(/--reopen applies to a finished run/);
      expect((await resolveOptions(parseFlags(flags))).mode).toBe("run");
    });
  });
});

/**
 * Make a finished test run look as if its link, appraisal and permits stages ran an earlier kit commit's code (the
 * markers' `code` inputs), with 900002 refused by that code's guard in s0002; the run record names that commit.
 */
async function asIfEarlierCode(runDir, { refuseInRun = "s0002", extraRefusalIn = null, tamperRerunDigest = false } = {}) {
  const patch = async (file, edit) => {
    const marker = JSON.parse(await readFile(file, "utf8"));
    edit(marker);
    marker.input_digest = digestOf(marker.input);
    await writeFile(file, `${JSON.stringify(marker, null, 1)}\n`);
  };
  await patch(path.join(runDir, "global", "link.done.json"), (marker) => (marker.input.code = "earlier-link"));
  for (const shard of ["s0001", "s0002"]) {
    await patch(path.join(runDir, "shards", shard, "appraisal.done.json"), (marker) => {
      marker.input.code = "earlier-appraisal";
      if (shard === refuseInRun) {
        const [key] = Object.keys(marker.output.parcels);
        if (tamperRerunDigest) marker.output.parcels[key] = "0".repeat(64);
        else {
          delete marker.output.parcels[key];
          marker.output.dead.push({ key, reason: "permanent_failure", evidence: "coordinate 30.64,-97.9 is outside the Travis bbox" });
        }
        marker.output.artifact_digest = digestOf(marker.output.parcels);
      }
      if (shard === extraRefusalIn) marker.output.dead.push({ key: "900099", reason: "permanent_failure", evidence: "coordinate 30.64,-97.9 is outside the Travis bbox" });
    });
    await patch(path.join(runDir, "shards", shard, "permits.done.json"), (marker) => (marker.input.code = "earlier-permits"));
  }
  const recordPath = path.join(runDir, "run.json");
  await writeFile(recordPath, JSON.stringify({ ...JSON.parse(await readFile(recordPath, "utf8")), kit_commit: "abc1234" }));
}

/** The code changes of decisions.md 27.9 and 27.10 as the scoped rerun sees them (each with a proof that holds). */
const earlierChanges = (holds = true) => ({
  commit: "abc1234",
  files: {
    "counties/travis/transforms/transform.mjs": { stages: ["appraisal"], at_run_sha256: "a1", now_sha256: "a2", proof: "situs_columns_branch", holds: true, detail: "test: the situs-columns blocks" },
    "src/counties/travis/validate.mjs": { stages: ["appraisal", "permits"], at_run_sha256: "b1", now_sha256: "b2", proof: "validation_box_widened", holds, detail: holds ? "test: the box widened" : "test: validate.mjs changed outside the box declaration" },
    "src/counties/travis/t5-run.mjs": { stages: ["link"], at_run_sha256: "c1", now_sha256: "c2", proof: "link_stage_unchanged", holds: true, detail: "test: the plan and link stages are the run's" },
  },
  stages: { link: ["src/counties/travis/t5-run.mjs"], appraisal: ["counties/travis/transforms/transform.mjs", "src/counties/travis/validate.mjs"], permits: ["src/counties/travis/validate.mjs"], reconcile: [], loader: [] },
});

async function scopedRun(flags, shards, extra = {}) {
  const options = await resolveOptions(parseFlags([...flags, "--rerun-shards", shards]));
  const codeAtRun = { link: "earlier-link", appraisal: "earlier-appraisal", permits: "earlier-permits", reconcile: await codeDigest(STAGE_CODE.reconcile), loader: await codeDigest(STAGE_CODE.loader) };
  const run = new T5Run({ ...options, log: () => {}, installSignals: false, progressIntervalMs: 3_600_000, allowDirty: true, codeChanges: earlierChanges(), codeAtRun, ...extra });
  return { run, options, record: await run.run() };
}

describe("T5 scoped rerun (--rerun-shards, decisions.md 27.9 option A)", () => {
  it("reruns only the named shard, re-certifies the other shard and the link pass in place, and the record and a verification agree", async () => {
    await withOut(async (out) => {
      const flags = await setup(out);
      const first = await runInProcess(flags);
      await asIfEarlierCode(first.options.runDir);
      const before = await markers(first.options.runDir);
      const { run, record } = await scopedRun(flags, "s0002");
      const after = await markers(first.options.runDir);
      // s0001: every marker keeps its attempt and outputs; appraisal and permits are re-certified with the old digest kept.
      for (const key of Object.keys(before).filter((name) => name.startsWith("shards/s0001/"))) {
        expect(after[key].attempt, key).toBe(before[key].attempt);
        expect(after[key].files, key).toEqual(before[key].files);
      }
      const recertified = JSON.parse(await readFile(path.join(first.options.runDir, "shards", "s0001", "appraisal.done.json"), "utf8"));
      expect(recertified.recertified).toHaveLength(1);
      expect(recertified.recertified[0]).toMatchObject({ from_input_digest: before["shards/s0001/appraisal.done.json"].input, from_code: "earlier-appraisal", kit_commit_at_run: "abc1234", parcels_rehashed: 1 });
      expect(recertified.recertified[0].proofs.map((item) => item.proof).sort()).toEqual(["situs_columns_branch", "validation_box_widened"]);
      expect(recertified.input.code).toBe(await codeDigest(STAGE_CODE.appraisal));
      const link = JSON.parse(await readFile(path.join(first.options.runDir, "global", "link.done.json"), "utf8"));
      expect(link.attempt).toBe(1);
      expect(link.recertified[0].proofs.map((item) => item.proof)).toEqual(["link_stage_unchanged"]);
      // s0002 reran: the parcel the earlier guard refused is ready, and the comparison shows nothing else changed.
      const appraisal = JSON.parse(await readFile(path.join(first.options.runDir, "shards", "s0002", "appraisal.done.json"), "utf8"));
      expect(appraisal.attempt).toBe(2);
      expect(appraisal.output.rerun_comparison).toMatchObject({ identical: true, previously_ready: 0, newly_ready: ["900002"], newly_ready_were_dead: true, still_dead: [] });
      expect(after["shards/s0002/permits.done.json"].attempt).toBe(2);
      // Its CLI chain's inputs (the members and what produced them) equal the first run's here, so it is reused as is.
      expect(after["shards/s0002/county.validate.done.json"].attempt).toBe(before["shards/s0002/county.validate.done.json"].attempt);
      expect(run.stageCounts.recertified).toBe(3);
      expect(record.counts.appraisal).toMatchObject({ seed: 2, ready: 2, dead: 0, invalid: 0, reconciles: true });
      expect(record.attempts.map((item) => item.status)).toEqual(["finished", "finished"]);
      expect(record.scoped_reruns).toHaveLength(1);
      expect(record.scoped_reruns[0]).toMatchObject({ shards: ["s0002"], kit_commit_at_run: "abc1234", attempts: [2], recertified: { shards: 1, stages: { link: 1, appraisal: 1, permits: 1 } } });
      expect(record.scoped_reruns[0].comparisons.s0002.appraisal).toMatchObject({ identical: true, newly_ready: ["900002"] });
      expect(record.scoped_reruns[0].code_changes.map((item) => item.proof).sort()).toEqual(["link_stage_unchanged", "situs_columns_branch", "validation_box_widened"]);
      expect(record.shards.per_shard.map((item) => [item.id, item.rerun, item.recertified])).toEqual([["s0001", false, true], ["s0002", true, false]]);
      expect(record.timings.attempts_ms).toHaveLength(2);
      // Here the rerun's merge equals the first run's (the parcel's files never changed on disk), so the Loader's input
      // is unchanged and it is not finalized again; on the full run the 15 accounts change the merges and it is.
      expect(record.deltas.appraisal).toMatchObject({ new: 2, changed: 0, unchanged: 0, removed: 0 });
      expect(await loadHistory(path.join(out, "loader", "test"))).toHaveLength(1);
      // The finished run now verifies, quick and full.
      const quick = await new T5Run({ ...(await resolveOptions(parseFlags(flags))), log: () => {} }).verify({ full: false });
      expect(quick).toMatchObject({ status: "verified", run_json: "equal", mismatch_count: 0 });
      const full = await new T5Run({ ...(await resolveOptions(parseFlags([...flags, "--verify"]))), log: () => {} }).verify({ full: true });
      expect(full).toMatchObject({ status: "verified", run_json: "equal", mismatch_count: 0 });
    });
  });

  it("refuses to re-certify a shard the change can reach, and writes no re-certification", async () => {
    await withOut(async (out) => {
      const flags = await setup(out);
      const first = await runInProcess(flags);
      await asIfEarlierCode(first.options.runDir, { extraRefusalIn: "s0001" });
      const markerPath = path.join(first.options.runDir, "shards", "s0001", "appraisal.done.json");
      const before = await readFile(markerPath, "utf8");
      await expect(scopedRun(flags, "s0002")).rejects.toThrow(/s0001/);
      expect(await readFile(markerPath, "utf8")).toBe(before);
      const failures = (await readFile(path.join(first.options.runDir, "failures.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(failures.at(-1)).toMatchObject({ shard: "s0001" });
      expect(failures.at(-1).error).toMatch(/not re-certified .*validation_box_widened.*the guard refused 900099 here: rerun this shard/);
    });
  });

  it("re-certifies nothing when a rerun shard's earlier parcels do not come out the same", async () => {
    await withOut(async (out) => {
      const flags = await setup(out);
      const first = await runInProcess(flags);
      await asIfEarlierCode(first.options.runDir, { tamperRerunDigest: true });
      const markerPath = path.join(first.options.runDir, "shards", "s0001", "appraisal.done.json");
      const before = await readFile(markerPath, "utf8");
      await expect(scopedRun(flags, "s0002")).rejects.toThrow(/s0001, s0002|s0002, s0001/);
      expect(await readFile(markerPath, "utf8")).toBe(before);
      const failures = (await readFile(path.join(first.options.runDir, "failures.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(failures.find((item) => item.shard === "s0002").error).toMatch(/the rerun changed what the run had written/);
      expect(failures.find((item) => item.shard === "s0001").error).toMatch(/stops before re-certifying anything/);
    });
  });

  it("refuses before writing anything when a changed file's proof does not hold, and checks its flags", async () => {
    await withOut(async (out) => {
      const flags = await setup(out);
      const first = await runInProcess(flags);
      await asIfEarlierCode(first.options.runDir);
      const statePath = path.join(first.options.runDir, "run-state.json");
      const state = await readFile(statePath, "utf8");
      await expect(scopedRun(flags, "s0002", { codeChanges: earlierChanges(false) })).rejects.toThrow(/no proof holds .*validate\.mjs/);
      expect(await readFile(statePath, "utf8")).toBe(state);
      await expect(scopedRun(flags, "s0007")).rejects.toThrow(/not shards of this run's plan/);
      expect(await readFile(statePath, "utf8")).toBe(state);
      await expect(resolveOptions(parseFlags([...flags, "--rerun-shards", "s0002", "--new"]))).rejects.toThrow(/does not combine/);
      await expect(resolveOptions(parseFlags([...flags, "--rerun-shards", "s2"]))).rejects.toThrow(/distinct shard ids/);
      await writeFile(statePath, JSON.stringify({ ...JSON.parse(state), status: "interrupted" }));
      await expect(resolveOptions(parseFlags([...flags, "--rerun-shards", "s0002"]))).rejects.toThrow(/applies to a finished run/);
    });
  });
});
