#!/usr/bin/env node
/**
 * T5 full run (assignment decisions.md section 2 item 5 and the approved design of section 25.9; kit `county-ingest-run`
 * sections 3-8, `query-db-loading-matching`): the whole Travis roll through the property-first stages, sharded, resumable
 * and offline except for the public lexicon manifest.
 *
 * Global stages (once per run, each with a done-marker under `global/`): the readiness validator (fail closed), the
 * lexicon manifest (its SHA-256 recorded at the start and checked again on every resume and at the end; a change stops the
 * run), the CLI version (pinned for the run), the shard plan (shards of at most 5,000 sorted PROP_IDs, decisions.md 25.9)
 * and the permit link pass over the verified capture (every row profiled and linked once, streamed to one file per shard
 * and to the internal permits table; nothing held in memory).
 *
 * Shard stages (up to `--concurrency` shards in flight, 8 by the ruling; each shard runs its stages in order, so at most
 * that many `elephant-cli` processes run at once): `appraisal` (the T2 adapter, transform v4 with the TCAD extras),
 * `permits` (eligibility and the permit transform), `reconcile` (the kit's roof-age estimator and the internal query
 * table), then per group (`county`, `property_improvement`) `validate`, `hash`, `car_validate` and `export_tables`, then
 * `cid_check` (every Property Improvement property is the same property in the County archive) and `merge` (the Loader's
 * per-shard merge, `t5-loader.mjs`). Each stage writes to an attempt-numbered staging location and, only after its checks
 * pass, an atomic `<stage>.done.json` with its input and output digests (`t5-shards.mjs`): a resume skips every stage
 * whose marker still matches and reruns the rest, so a crash, a SIGTERM, a SIGKILL or a sleep redoes only what was in
 * flight. When every shard is merged, the Loader finalizes (watermarks, tombstones, deltas) and the run record
 * `run.json` (the `runs/<run_id>.json` shape of `api-contract.md`) is written.
 *
 * Operation: the runner holds `caffeinate -dimsu -w <pid>` while it lives, sets `ELEPHANT_SKIP_UPDATE_CHECK=1` for every
 * CLI call, runs the free-memory preflight (warnings only), prints a progress and ETA line every minute (also in
 * `progress.txt` and `progress.jsonl`), and holds `run.lock` (one writer per run directory). Starting it again with the
 * same label resumes the newest run of that label while it is unfinished; once it is finished, the same command only
 * verifies it, read-only, in seconds (every marker's input recomputed, every output present, the Loader's generation,
 * and `run.json` equal to the record rebuilt from the markers) and writes nothing. `--verify` does the same and also
 * re-hashes every output a marker names; `--new` starts a fresh run; `--reopen` reruns a finished run in place (a
 * fix: only stages whose inputs changed run, and `run.json` is rewritten with a new attempt); `--resume <dir|latest>`
 * names the run. A verification compares the code each stage ran as of the run's kit commit (`run.json` `kit_commit`),
 * so a later commit is reported (`code_since_run`) and not mistaken for a changed input.
 *
 * Scoped rerun (`--rerun-shards s0039,s0040,...`, decisions.md 27.9 option A): a finished run is reopened in place, the
 * named shards rerun every stage whose input changed, and every other shard is re-certified, not recomputed
 * (`t5-recertify.mjs`): a marker whose input changed only through the code digest is rewritten with the new input once
 * the text proof of every changed file and the shard's own facts show the change cannot reach it, keeping its old input
 * digest; anything else stops the run and names the shard. The rerun shards go first, and no marker is re-certified
 * until each of them has shown that its earlier parcels came out byte for byte the same (`rerun_comparison`). The Loader
 * finalizes again and `run.json` is rewritten with the new attempt. The kit must be committed (the record names the
 * commit). A scoped rerun that stops resumes with the same command.
 *
 * Exit: after `done` (or a failure, or a signal) the runner flushes its output and exits explicitly, so no stray handle
 * can keep it alive, and first arms a detached exit watchdog: if the process is still there 30 seconds later (the T5
 * full run of 2026-10-18 printed `done` and then stalled inside Node's own teardown, the main thread joining a libuv
 * worker in `uv__threadpool_cleanup`, with every output written), the watchdog stops it with SIGTERM, then SIGKILL.
 *
 *   node --max-old-space-size=8192 src/counties/travis/t5-run.mjs --cli <elephant-cli> --eligibility __ALL__ \
 *     [--seed data/seeds/travis.csv] [--label full] [--shard-size 5000] [--concurrency 8] [--max-shards <n>] \
 *     [--loader-scope <name>] [--manifest <file>] [--resume <dir|latest>] [--new] [--verify] [--reopen] [--rerun-shards <ids>]
 *
 * No upload, pin or Atlas PR (T6). The only network request is the lexicon manifest (none when verifying).
 *
 * @module counties/travis/t5-run
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, link, mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseCsvRecords } from "../../core/csv.mjs";
import { writeQueryTableParquet } from "../../core/query-table.mjs";
import { COPIED_FROM_APPRAISAL, PERMIT_TRANSFORM_VERSION, partitionPermits, resolvePermitGroupCids, writeTravisPermitTransform } from "../../../counties/travis/transforms/permit-transform.mjs";
import { TRANSFORM_VERSION, resolveDataGroupCids } from "../../../counties/travis/transforms/transform.mjs";
import { captureAndTransform } from "./adapter.mjs";
import { decideEligibility, ELIGIBILITY_ENV, resolveEligibilityPolicy } from "./eligibility.mjs";
import { TRAVIS_QUERY_TABLE_SCHEMA_FIELDS } from "./enrichment-profile.mjs";
import { IMPROVEMENT_ENUMS_VERSION, PARCEL_LINK_VERSION, STATUS_GROUP_VERSION, TCAD_ID_EVIDENCE_VERSION, WORK_CLASSIFIER_VERSION, compiledTravisRoofAgeProfile, summarizePermitRow } from "./permit-profile.mjs";
import { mapTransformedFilesToQueryTableRow } from "./query-table.mjs";
import { compactTimestamp } from "./t3-fetch.mjs";
import { RUNTIME_ROOT } from "./t3-snapshot.mjs";
import { parseCliOutput } from "./t4-run.mjs";
import { DEFAULT_SEED, readRollGeoIndex, runLinkPass } from "./t4-permit-links.mjs";
import { latestCapture, verifyPermitCapture } from "./t4-permit-verify.mjs";
import { TCAD_PERMIT_LISTING_VERSION, resolveTcadPermitListing } from "./t4-tcad-permit-listing.mjs";
import { DEFAULT_LOADER_ROOT, bytesUnder, currentGeneration, finalizeLoad, loadHistory, recordShardMerge, t3Watermarks } from "./t5-loader.mjs";
import { runPreflight } from "./t5-preflight.mjs";
import { countRoofAge, emptyRoofAgeCounts, estimateParcelRoofAge, sumRoofAgeCounts, T5_ROOF_AGE_VERSION } from "./t5-roof-age.mjs";
import { atomicWrite, checkMarker, dataDirDigest, DEFAULT_SHARD_SIZE, digestOf, planShards, readLines, reserveAttempt, sha256File, sha256Hex, treeDigest, writeMarker } from "./t5-shards.mjs";
import { DEFAULT_OUT_DIR as DEFAULT_TCAD_EXTRAS_DIR, EXTRAS_FILENAME } from "./t5-tcad-extras.mjs";
import { TRAVIS_PERMIT_SOURCE_HOSTS, assertOutputContract, assertTravisIdentity } from "./validate.mjs";
import { buildRunRecord } from "./t5-record.mjs";
import { codeChanges, compareRerun, recertifyStage } from "./t5-recertify.mjs";

export const T5_RUN_VERSION = "travis-t5-run.v1";
export const LEXICON_MANIFEST_URL = "https://lexicon.elephant.xyz/api/manifest";
export const DEFAULT_CONCURRENCY = 8;
export const GROUPS = Object.freeze(["county", "property_improvement"]);
export const CLI_STEPS = Object.freeze(["validate", "hash", "car_validate", "export_tables"]);
export const PART_SIZE = "128m";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(RUNTIME_ROOT, "..", "..", "..");

/** The code each stage runs (its digest is part of the stage input, so a code change reruns the stage). */
export const STAGE_CODE = Object.freeze({
  link: ["src/counties/travis/t4-permit-links.mjs", "src/counties/travis/permit-profile.mjs", "src/counties/travis/t4-tcad-permit-listing.mjs", "src/counties/travis/t5-run.mjs"],
  appraisal: ["counties/travis/transforms/transform.mjs", "src/counties/travis/adapter.mjs", "src/counties/travis/validate.mjs", "src/counties/travis/seed.mjs"],
  permits: ["counties/travis/transforms/permit-transform.mjs", "src/counties/travis/permit-profile.mjs", "src/counties/travis/eligibility.mjs", "src/counties/travis/validate.mjs"],
  reconcile: ["src/counties/travis/t5-roof-age.mjs", "src/roof-age/estimator.ts", "src/counties/travis/permit-profile.mjs", "src/counties/travis/query-table.mjs", "src/counties/travis/enrichment-profile.mjs"],
  loader: ["src/counties/travis/t5-loader.mjs"],
});

/** The `STAGE_CODE` entry each stage's `code` input digests (stages without one take no code input). */
export const CODE_STAGE_OF = Object.freeze({ link: "link", appraisal: "appraisal", permits: "permits", reconcile: "reconcile", merge: "loader", loader: "loader" });
/** The stages a scoped rerun compares with the run's before anything is re-certified. */
export const COMPARED_STAGES = Object.freeze(["appraisal", "permits"]);

const rel = (target) => path.relative(RUNTIME_ROOT, target).split(path.sep).join("/");
const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const nowIso = () => new Date().toISOString();

/**
 * The state of one scoped rerun: which shards rerun, the code changes and their proofs, and the gate every
 * re-certification waits on (it opens once each rerun shard's appraisal and permits stages compared identical).
 */
export class ScopedRerun {
  /**
   * @param {{ shards: string[], commit: string, changes: Record<string, any>, codeAtRun: Record<string, string> }} options - Scope.
   */
  constructor({ shards, commit, changes, codeAtRun }) {
    this.shards = new Set(shards);
    this.commit = commit;
    this.changes = changes;
    this.codeAtRun = codeAtRun;
    this.settled = new Map();
    this.comparisons = {};
    this.recertified = { shards: new Set(), stages: {} };
    this.failure = null;
    this.gatePromise = new Promise((resolve, reject) => {
      this.open = resolve;
      this.close = reject;
    });
    this.gatePromise.catch(() => {});
    if (this.shards.size === 0) this.open(undefined);
  }

  /** @param {string | undefined} shard @returns {boolean} Whether the shard reruns. */
  reruns(shard) {
    return Boolean(shard) && this.shards.has(/** @type {string} */ (shard));
  }

  /**
   * Record a rerun shard's comparison of one stage; the gate opens when all are identical and closes on the first that is not.
   *
   * @param {string} shard - Shard id.
   * @param {string} stage - `appraisal` or `permits`.
   * @param {boolean} ok - Identical.
   * @param {Record<string, any> | string | null} detail - The comparison, or why it failed.
   */
  settle(shard, stage, ok, detail = null) {
    this.settled.set(`${shard}/${stage}`, ok);
    if (detail && typeof detail === "object") (this.comparisons[shard] ??= {})[stage] = detail;
    if (!ok && !this.failure) {
      this.failure = `${shard} ${stage}: ${typeof detail === "string" ? detail : "the rerun changed earlier parcels"}`;
      this.close(new Error(`the scoped rerun stops before re-certifying anything: ${this.failure}`));
      return;
    }
    const needed = [...this.shards].flatMap((id) => COMPARED_STAGES.map((name) => `${id}/${name}`));
    if (!this.failure && needed.every((key) => this.settled.get(key) === true)) this.open(undefined);
  }

  /** @returns {Promise<void>} Resolves once every rerun shard compared identical. */
  gate() {
    return this.gatePromise;
  }
}

/**
 * Digest of the files a stage runs.
 *
 * @param {string[]} files - Paths relative to the runtime root.
 * @returns {Promise<string>} Hex digest.
 */
export async function codeDigest(files) {
  const pairs = [];
  for (const file of files) pairs.push([file, await sha256File(path.join(RUNTIME_ROOT, file))]);
  return digestOf(pairs);
}

/**
 * The same digest over the files as committed at `commit` (`git show <commit>:./<file>` in the runtime), so a finished
 * run is verified against the code it ran, not the code checked out now.
 *
 * @param {string} commit - Kit commit (as `run.json` `kit_commit` records it).
 * @param {string[]} files - Paths relative to the runtime root.
 * @returns {Promise<string>} Hex digest.
 */
export async function codeDigestAtCommit(commit, files) {
  const pairs = [];
  for (const file of files) {
    const bytes = await new Promise((resolve, reject) =>
      execFile("git", ["-C", RUNTIME_ROOT, "show", `${commit}:./${file}`], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout))),
    );
    pairs.push([file, sha256Hex(bytes)]);
  }
  return digestOf(pairs);
}

/** The exit watchdog (POSIX sh): waits for `pid` to go, else stops it if its command still names `match`. */
const EXIT_WATCHDOG_SCRIPT = [
  'pid=$1; code=$2; grace=$3; term=$4; match=$5; i=0',
  'while kill -0 "$pid" 2>/dev/null; do',
  '  if [ "$i" -ge "$grace" ]; then',
  '    case "$(ps -o command= -p "$pid" 2>/dev/null)" in *"$match"*) ;; *) exit 0 ;; esac',
  '    echo "[t5] exit watchdog: pid $pid is still alive ${grace} s after it exited with code $code (a stall in the Node process teardown; everything was written before the exit); sending SIGTERM" >&2',
  '    kill -TERM "$pid" 2>/dev/null; j=0',
  '    while kill -0 "$pid" 2>/dev/null && [ "$j" -lt "$term" ]; do sleep 1; j=$((j+1)); done',
  '    if kill -0 "$pid" 2>/dev/null; then echo "[t5] exit watchdog: pid $pid ignored SIGTERM; sending SIGKILL" >&2; kill -KILL "$pid" 2>/dev/null; fi',
  "    exit 0",
  "  fi",
  "  sleep 1; i=$((i+1))",
  "done",
].join("\n");

/**
 * Arm a detached watchdog that stops `pid` if it is still alive `graceSeconds` after its exit was requested (SIGTERM,
 * then SIGKILL after `termSeconds`). It never touches a process whose command line no longer contains `match` (a reused
 * pid), and it exits as soon as the process is gone. Its notice goes to the runner's stderr (the log).
 *
 * @param {{ pid?: number, code?: number, graceSeconds?: number, termSeconds?: number, match?: string }} [options] - Target.
 * @returns {number | null} The watchdog's pid (null when it could not start).
 */
export function armExitWatchdog({ pid = process.pid, code = 0, graceSeconds = 30, termSeconds = 5, match = "t5-run" } = {}) {
  try {
    const child = spawn("/bin/sh", ["-c", EXIT_WATCHDOG_SCRIPT, "t5-exit-watchdog", String(pid), String(code), String(graceSeconds), String(termSeconds), match], { detached: true, stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", () => {});
    child.unref();
    return child.pid ?? null;
  } catch {
    return null;
  }
}

/**
 * Leave the process now: flush stdout and stderr, arm the exit watchdog, then `process.exit(code)`. The explicit exit
 * means no open handle can keep a finished runner alive; the watchdog covers a stall after that, inside Node's teardown.
 *
 * @param {number} code - Exit code.
 * @param {{ graceSeconds?: number }} [options] - Watchdog delay.
 * @returns {Promise<never>} Never returns.
 */
export async function exitProcess(code, { graceSeconds = Number(process.env.T5_EXIT_WATCHDOG_SECONDS ?? 30) } = {}) {
  const flush = (stream) => new Promise((resolve) => (stream.writableLength === 0 && !stream.writableNeedDrain ? resolve(undefined) : stream.write("", () => resolve(undefined))));
  await Promise.race([Promise.all([flush(process.stdout), flush(process.stderr)]), new Promise((resolve) => setTimeout(resolve, 5000).unref())]);
  armExitWatchdog({ code, graceSeconds });
  process.exit(code);
}

/**
 * Parse the CLI's validate error CSV into the failing property directories (PROP_IDs).
 *
 * @param {string} text - CSV text (`property_cid,data_group_cid,file_path,error_path,error_message,currentValue,timestamp`).
 * @param {string} groupDirName - The group directory's name as passed to the CLI.
 * @returns {Map<string, string>} PROP_ID to its first error message.
 */
export function invalidPropertiesFromErrors(text, groupDirName) {
  const rows = parseCsvRecords(text);
  /** @type {Map<string, string>} */
  const invalid = new Map();
  for (const row of rows) {
    const parts = String(row.file_path ?? "").split(/[\\/]/).filter(Boolean);
    const at = parts.lastIndexOf(groupDirName);
    const candidate = at >= 0 ? parts[at + 1] : parts.find((part) => /^\d{1,12}$/.test(part));
    if (candidate && /^\d{1,12}$/.test(candidate) && !invalid.has(candidate)) invalid.set(candidate, `${row.error_path ?? ""}: ${row.error_message ?? ""}`.trim());
  }
  return invalid;
}

/**
 * ETA from the parcels finished since the pool started (shards finish out of order, so parcels are the unit).
 *
 * @param {{ parcelsDone: number, parcelsTotal: number, poolElapsedMs: number }} input - Progress.
 * @returns {{ eta_ms: number | null, parcels_per_hour: number | null }} Estimate.
 */
export function estimateEta({ parcelsDone, parcelsTotal, poolElapsedMs }) {
  if (parcelsDone <= 0 || poolElapsedMs <= 0) return { eta_ms: null, parcels_per_hour: null };
  const rate = parcelsDone / poolElapsedMs;
  return { eta_ms: Math.round((parcelsTotal - parcelsDone) / rate), parcels_per_hour: Math.round(rate * 3_600_000) };
}

/** @param {number | null} ms @returns {string} `3h12m`. */
export function formatDuration(ms) {
  if (ms === null || !Number.isFinite(ms)) return "?";
  const minutes = Math.max(0, Math.round(ms / 60000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}

/**
 * Whether a process id is alive.
 *
 * @param {number} pid - Process id.
 * @returns {boolean} Alive.
 */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The command line of a process (null when gone).
 *
 * @param {number} pid - Process id.
 * @returns {Promise<string | null>} Command.
 */
function commandOf(pid) {
  return new Promise((resolve) => execFile("ps", ["-o", "command=", "-p", String(pid)], (error, stdout) => resolve(error ? null : String(stdout).trim() || null)));
}

/**
 * Resident memory of every running elephant-cli process and of this runner (one `ps` call).
 *
 * @returns {Promise<{ cli_rss_bytes: number, cli_processes: number }>} Memory.
 */
function sampleCli() {
  return new Promise((resolve) =>
    execFile("ps", ["-axo", "rss=,command="], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      let total = 0;
      let processes = 0;
      if (!error) {
        for (const line of String(stdout).split("\n")) {
          if (!line.includes("elephant-cli") || line.includes("t5-run")) continue;
          const rss = Number.parseInt(line.trim().split(/\s+/)[0], 10);
          if (Number.isFinite(rss)) {
            total += rss * 1024;
            processes += 1;
          }
        }
      }
      resolve({ cli_rss_bytes: total, cli_processes: processes });
    }),
  );
}

/** Swap in use (`sysctl vm.swapusage`), bytes; null when unknown. */
function sampleSwap() {
  return new Promise((resolve) =>
    execFile("sysctl", ["vm.swapusage"], (error, stdout) => {
      const match = /used = ([\d.]+)M/.exec(String(stdout ?? ""));
      resolve(error || !match ? null : Math.round(Number(match[1]) * 1024 * 1024));
    }),
  );
}

/**
 * The run: state, lock, children, signals, progress and every stage.
 */
export class T5Run {
  /**
   * @param {Record<string, any>} options - Resolved options (see `main`).
   */
  constructor(options) {
    this.options = options;
    this.runDir = options.runDir;
    this.globalDir = path.join(this.runDir, "global");
    this.shardsDir = path.join(this.runDir, "shards");
    /** @type {Map<number, { shard: string, stage: string, started_at: string }>} */
    this.children = new Map();
    this.stopping = false;
    this.stopSignal = null;
    this.stageCounts = { run: 0, skipped: 0, failed: 0 };
    this.inFlight = new Map();
    this.shardResults = new Map();
    this.peak = { cli_rss_bytes: 0, cli_processes: 0, runner_rss_bytes: 0, swap_used_bytes: 0 };
    this.mergeChain = Promise.resolve();
    this.log = options.log ?? ((line) => console.log(line));
    this.codeDigests = {};
  }

  /** Paths of the run's state files. */
  get statePath() {
    return path.join(this.runDir, "run-state.json");
  }

  /** Write `run-state.json` atomically (children included, for a resume after SIGKILL). */
  async saveState() {
    this.state.children = Object.fromEntries([...this.children].map(([pid, info]) => [pid, info]));
    this.state.updated_at = nowIso();
    await atomicWrite(this.statePath, `${JSON.stringify(this.state, null, 1)}\n`);
  }

  /** Take `run.lock` (refuse while another live runner holds it; a stale lock from a killed run is taken over). */
  async lock() {
    const lockPath = path.join(this.runDir, "run.lock");
    if (existsSync(lockPath)) {
      const holder = Number.parseInt((await readFile(lockPath, "utf8")).trim(), 10);
      if (Number.isInteger(holder) && holder !== process.pid && alive(holder) && /t5-run/.test((await commandOf(holder)) ?? "")) {
        throw new Error(`run ${rel(this.runDir)} is held by live runner pid ${holder}; stop it first (kill -TERM ${holder})`);
      }
      await rename(lockPath, `${lockPath}.stale-${Date.now()}`);
    }
    const handle = await open(lockPath, "wx");
    await handle.writeFile(`${process.pid}\n`);
    await handle.close();
    this.lockPath = lockPath;
  }

  /** Release the lock (normal exit and signal paths). */
  async unlock() {
    if (!this.lockPath) return;
    try {
      const holder = Number.parseInt((await readFile(this.lockPath, "utf8")).trim(), 10);
      if (holder === process.pid) await rename(this.lockPath, `${this.lockPath}.released-${Date.now()}`);
    } catch {
      // already gone
    }
  }

  /** Kill elephant-cli processes a killed predecessor left running (recorded in `run-state.json`). */
  async reapOrphans() {
    const recorded = this.state?.children ?? {};
    const reaped = [];
    for (const pidText of Object.keys(recorded)) {
      const pid = Number(pidText);
      if (!alive(pid)) continue;
      const command = (await commandOf(pid)) ?? "";
      if (!/elephant-cli/.test(command)) continue;
      process.kill(pid, "SIGTERM");
      for (let wait = 0; wait < 50 && alive(pid); wait += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      if (alive(pid)) process.kill(pid, "SIGKILL");
      reaped.push({ pid, ...recorded[pidText] });
    }
    return reaped;
  }

  /** Hold a no-sleep assertion for as long as this process lives (`caffeinate -dimsu -w <pid>`). */
  holdNoSleep() {
    if (this.options.noCaffeinate || process.platform !== "darwin") return { held: false, reason: this.options.noCaffeinate ? "disabled (--no-caffeinate)" : `platform ${process.platform}` };
    try {
      const child = spawn("caffeinate", ["-dimsu", "-w", String(process.pid)], { detached: true, stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
      return { held: true, command: `caffeinate -dimsu -w ${process.pid}`, pid: child.pid };
    } catch (error) {
      return { held: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** SIGINT, SIGTERM and SIGHUP: stop starting stages, stop the CLI children, record, exit. */
  installSignals() {
    const handler = (signal) => {
      if (this.stopping) return;
      this.stopping = true;
      this.stopSignal = signal;
      this.log(`[t5] ${signal}: stopping; ${this.children.size} elephant-cli process(es) stopped; completed stages keep their markers. Resume with the same command.`);
      for (const pid of this.children.keys()) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // gone
        }
      }
      setTimeout(() => {
        for (const pid of this.children.keys()) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // gone
          }
        }
      }, 10000).unref();
      // A stage that runs no CLI (a shard's transform) finishes first; past 30 s, exit anyway: markers are atomic, so a
      // hard exit loses only the work in flight, exactly like a crash.
      setTimeout(() => {
        this.unlock().finally(() => exitProcess(signal === "SIGINT" ? 130 : 143));
      }, 30000).unref();
    };
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => handler(signal));
  }

  /**
   * Run one elephant-cli command (tracked as a child for signals and orphan reaping).
   *
   * @param {string[]} args - Arguments.
   * @param {string} cwd - Working directory.
   * @param {string} logFile - Log file.
   * @param {{ shard: string, stage: string }} info - What it runs for.
   * @returns {Promise<{ code: number | null, signal: string | null, ms: number, output: string }>} Result.
   */
  async cli(args, cwd, logFile, info) {
    if (this.stopping) throw new Error("interrupted");
    const started = performance.now();
    await mkdir(path.dirname(logFile), { recursive: true });
    const result = await new Promise((resolve, reject) => {
      const child = spawn(this.options.cli, args, { cwd, env: { ...process.env, ELEPHANT_SKIP_UPDATE_CHECK: "1" } });
      this.children.set(child.pid, { ...info, started_at: nowIso() });
      this.saveState().catch(() => {});
      const chunks = [];
      child.stdout.on("data", (chunk) => chunks.push(chunk));
      child.stderr.on("data", (chunk) => chunks.push(chunk));
      child.on("error", (error) => {
        this.children.delete(child.pid);
        reject(error);
      });
      child.on("close", (code, signal) => {
        this.children.delete(child.pid);
        resolve({ code, signal, output: Buffer.concat(chunks).toString("utf8") });
      });
    });
    await writeFile(logFile, result.output);
    return { ...result, ms: performance.now() - started };
  }

  /**
   * Run (or skip) one stage under its done-marker.
   *
   * @param {string} dir - Shard or global directory.
   * @param {string} stage - Stage name.
   * @param {Record<string, any>} input - Stage input (digested).
   * @param {(attempt: number) => Promise<Record<string, any>>} task - Does the work into attempt-numbered locations; returns the output (with `files[]` to re-hash on resume).
   * @param {{ attemptPrefix?: string, shard?: string }} [meta] - Attempt directory prefix and the shard (for progress).
   * @returns {Promise<Record<string, any>>} The marker (existing or new).
   */
  async stage(dir, stage, input, task, meta = {}) {
    if (this.verifying) {
      // Verification: check the marker against the input recomputed now; never run the task, never write.
      const verdict = await checkMarker(dir, stage, input, { rehash: this.verifying.full, stats: this.verifying });
      this.verifying.stages += 1;
      if (!verdict.valid) {
        this.verifying.mismatches.push({ dir: rel(dir), stage, reason: verdict.reason });
        throw Object.assign(new Error(`${rel(dir)} ${stage}: ${verdict.reason}`), { verifyMismatch: true });
      }
      return { ...verdict.marker, skipped: true };
    }
    const check = await checkMarker(dir, stage, input);
    const scoped = this.scoped ?? null;
    // In a scoped rerun, a rerun shard's appraisal and permits stages are compared with the run's (the gate).
    const compared = Boolean(scoped?.reruns(meta.shard)) && COMPARED_STAGES.includes(stage);
    if (check.valid) {
      this.stageCounts.skipped += 1;
      if (compared) scoped.settle(meta.shard, stage, check.marker.output?.rerun_comparison ? check.marker.output.rerun_comparison.identical === true : true, check.marker.output?.rerun_comparison ?? null);
      return { ...check.marker, skipped: true };
    }
    // Outside the scope (another shard, or the link pass) a stage is re-certified, never recomputed; the Loader's finalize reruns.
    if (scoped && !scoped.reruns(meta.shard) && !(meta.shard === undefined && stage === "loader")) {
      const label = meta.shard ?? "global";
      if (check.reason !== "input changed") throw Object.assign(new Error(`${label} ${stage} is outside --rerun-shards and its marker does not hold (${check.reason}); add the shard to --rerun-shards or repair it`), { recertifyRefused: true });
      if (meta.shard) await scoped.gate();
      const codeStage = CODE_STAGE_OF[stage] ?? null;
      const marker = await recertifyStage({ dir, stage, input, marker: check.marker, codeStage: codeStage ?? stage, codeAtRun: codeStage ? scoped.codeAtRun[codeStage] : "", changes: scoped.changes, attempt: this.attempt.attempt, label, appraisalMarker: meta.appraisalMarker ?? null });
      this.stageCounts.recertified = (this.stageCounts.recertified ?? 0) + 1;
      scoped.recertified.stages[stage] = (scoped.recertified.stages[stage] ?? 0) + 1;
      if (meta.shard) scoped.recertified.shards.add(meta.shard);
      await appendFile(path.join(this.runDir, "stages.jsonl"), `${JSON.stringify({ at: nowIso(), dir: rel(dir), stage, attempt: marker.attempt, recertified: true, from_input_digest: marker.recertified.at(-1).from_input_digest, pid: process.pid })}\n`);
      return { ...marker, skipped: true };
    }
    if (this.stopping) throw new Error("interrupted");
    const attempt = await reserveAttempt(dir, stage, meta.attemptPrefix ?? null, check.marker);
    const started = performance.now();
    const startedAt = nowIso();
    if (meta.shard) this.inFlight.set(meta.shard, stage);
    // A task that returns has finished its work (a CLI task throws when its process was stopped), so its marker is
    // written even while the run is stopping: that work is never redone.
    let output;
    try {
      output = await task(attempt);
    } catch (error) {
      if (compared) scoped.settle(meta.shard, stage, false, error instanceof Error ? error.message : String(error));
      throw error;
    }
    if (compared) {
      // The rerun's own evidence: every parcel the run had ready comes out byte for byte the same; only parcels that were dead change.
      const comparison = check.marker ? await compareRerun({ dir, stage, before: check.marker, after: { output } }) : { stage, identical: false, reason: "no earlier marker to compare with" };
      output.rerun_comparison = comparison;
      scoped.settle(meta.shard, stage, comparison.identical === true, comparison);
      if (comparison.identical !== true) throw new Error(`${meta.shard} ${stage}: the rerun changed what the run had written (${JSON.stringify(comparison.changed ?? comparison.reason ?? null).slice(0, 300)}); nothing is re-certified`);
    }
    const marker = await writeMarker(dir, stage, { input, output, attempt, started_at: startedAt, ms: Math.round(performance.now() - started), redone_because: check.reason });
    this.stageCounts.run += 1;
    await appendFile(path.join(this.runDir, "stages.jsonl"), `${JSON.stringify({ at: marker.finished_at, dir: rel(dir), stage, attempt, ms: marker.ms, redone_because: check.reason, pid: process.pid })}\n`);
    return marker;
  }

  /** Initialize or reload the run state; returns whether this is a resume. */
  async open() {
    await mkdir(this.runDir, { recursive: true });
    const resumed = existsSync(this.statePath);
    this.state = resumed
      ? JSON.parse(await readFile(this.statePath, "utf8"))
      : { version: T5_RUN_VERSION, run_id: path.basename(this.runDir), label: this.options.label, created_at: nowIso(), options: this.persistedOptions(), attempts: [], children: {}, status: "running" };
    await this.lock();
    const reaped = resumed ? await this.reapOrphans() : [];
    this.state.children = {};
    this.attempt = { attempt: this.state.attempts.length + 1, pid: process.pid, started_at: nowIso(), resumed, reaped_orphans: reaped, status: "running" };
    this.state.attempts.push(this.attempt);
    this.state.status = "running";
    await this.saveState();
    return resumed;
  }

  /** The options a resume reuses. */
  persistedOptions() {
    const { seedPath, label, shardSize, concurrency, maxShards, loaderScope, manifestFile, cli, eligibility, captureDir, tcadExtrasDir, tcadListingDir, tcadListingReceipts, rollSeed } = this.options;
    return { seed: rel(seedPath), label, shard_size: shardSize, concurrency, max_shards: maxShards, loader_scope: loaderScope, manifest_file: manifestFile ? path.resolve(manifestFile) : null, cli, eligibility, capture: captureDir ? rel(captureDir) : null, tcad_extras: rel(tcadExtrasDir), tcad_listing: tcadListingDir ? rel(tcadListingDir) : null, tcad_listing_receipts: tcadListingReceipts ? rel(tcadListingReceipts) : null, roll_seed: rel(rollSeed) };
  }

  /** Fetch (or copy) the lexicon manifest and return its bytes. */
  async fetchManifest() {
    if (this.options.manifestFile) return readFile(this.options.manifestFile);
    let lastError = null;
    for (let tries = 0; tries < 5; tries += 1) {
      try {
        const response = await fetch(LEXICON_MANIFEST_URL, { headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(`lexicon manifest HTTP ${response.status}`);
        return Buffer.from(await response.arrayBuffer());
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 2000 * (tries + 1)));
      }
    }
    throw new Error(`lexicon manifest unreachable: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  /** Global stages: readiness, manifest, CLI version, plan, link pass. */
  async globalStages() {
    if (this.verifying) return this.globalStagesVerified();
    const o = this.options;
    // Readiness (kit county-readiness-preflight: stop on a non-zero gate).
    const readiness = await new Promise((resolve) =>
      execFile("python3", [path.join(KIT_ROOT, "skills", "use-oracle", "scripts", "validate-county-readiness.py"), path.join(RUNTIME_ROOT, "docs", "travis-sources.yaml")], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
        try {
          resolve({ exit: error ? (error.code ?? 1) : 0, report: JSON.parse(String(stdout)) });
        } catch {
          resolve({ exit: error ? (error.code ?? 1) : 0, report: null });
        }
      }),
    );
    const gates = readiness.report?.gates;
    this.readiness = { exit: readiness.exit, overall: readiness.report?.overall ?? null, seed_allowed: readiness.report?.seed_allowed ?? null, ingest_allowed: readiness.report?.ingest_allowed ?? null, gates: Array.isArray(gates) ? Object.fromEntries(gates.map((gate) => [gate.gate ?? gate.name, gate.status])) : (gates ?? null) };
    if (readiness.exit !== 0 || this.readiness.overall !== "PASS") throw new Error(`readiness validator: ${this.readiness.overall ?? "no report"} (exit ${readiness.exit}); the full run stops on a non-zero gate`);

    // Lexicon manifest: recorded at the start; every resume and the end compare against it.
    const manifestBytes = await this.fetchManifest();
    const manifestSha = sha256Hex(manifestBytes);
    const manifestPath = path.join(this.globalDir, "lexicon-manifest.json");
    if (existsSync(manifestPath)) {
      const recorded = await sha256File(manifestPath);
      if (recorded !== manifestSha) throw new Error(`the lexicon manifest changed since this run started (${recorded.slice(0, 12)}… then, ${manifestSha.slice(0, 12)}… now): the outputs of this run were validated against the old one; start a new run (--new)`);
    } else await atomicWrite(manifestPath, manifestBytes);
    this.manifestSha = manifestSha;
    this.lexicon = JSON.parse(manifestBytes.toString("utf8"));
    this.roots = { ...resolveDataGroupCids(this.lexicon), ...resolvePermitGroupCids(this.lexicon) };
    this.state.lexicon_manifest = { url: o.manifestFile ? `file:${o.manifestFile}` : LEXICON_MANIFEST_URL, sha256_start: this.state.lexicon_manifest?.sha256_start ?? manifestSha, checks: [...(this.state.lexicon_manifest?.checks ?? []), { at: nowIso(), sha256: manifestSha, attempt: this.attempt.attempt }] };

    // CLI version: pinned for the run.
    const version = await new Promise((resolve) => execFile(o.cli, ["--version"], { env: { ...process.env, ELEPHANT_SKIP_UPDATE_CHECK: "1" } }, (error, stdout) => resolve(error ? null : String(stdout).trim())));
    if (!version) throw new Error(`elephant-cli at ${o.cli} does not answer --version`);
    const cliMarker = await this.stage(this.globalDir, "cli", { cli: o.cli }, async () => ({ version, files: [] }));
    if (cliMarker.output.version !== version) throw new Error(`elephant-cli is ${version}, the run started with ${cliMarker.output.version}; start a new run (--new)`);
    this.cliVersion = version;

    // Preflight (warnings only).
    this.preflight = await runPreflight({ runDir: this.runDir, properties: o.maxShards ? o.maxShards * o.shardSize : 441961 });
    await atomicWrite(path.join(this.runDir, `preflight-a${this.attempt.attempt}.json`), `${JSON.stringify(this.preflight, null, 1)}\n`);
    for (const warning of this.preflight.warnings) this.log(`[t5] preflight warning: ${warning}`);

    await this.planAndLink();
  }

  /**
   * The global stages of a verification: the manifest as recorded (no request), the CLI version (reported, not a
   * mismatch), no readiness run and no preflight, then the plan and link markers; the full mode also re-verifies the
   * permit capture against its receipts.
   */
  async globalStagesVerified() {
    const o = this.options;
    const manifestPath = path.join(this.globalDir, "lexicon-manifest.json");
    if (!existsSync(manifestPath)) {
      this.verifying.mismatches.push({ dir: rel(this.globalDir), stage: "lexicon-manifest", reason: "no recorded manifest" });
      throw Object.assign(new Error("no recorded lexicon manifest"), { verifyMismatch: true });
    }
    const manifestBytes = await readFile(manifestPath);
    const manifestSha = sha256Hex(manifestBytes);
    const recorded = this.state.lexicon_manifest ?? {};
    for (const [name, value] of [["sha256_start", recorded.sha256_start], ["sha256_end", recorded.sha256_end]]) {
      if (value && value !== manifestSha) this.verifying.mismatches.push({ dir: rel(this.globalDir), stage: "lexicon-manifest", reason: `the recorded manifest's SHA-256 differs from run-state ${name}` });
    }
    this.manifestSha = manifestSha;
    this.lexicon = JSON.parse(manifestBytes.toString("utf8"));
    this.roots = { ...resolveDataGroupCids(this.lexicon), ...resolvePermitGroupCids(this.lexicon) };
    const version = await new Promise((resolve) => execFile(o.cli, ["--version"], { env: { ...process.env, ELEPHANT_SKIP_UPDATE_CHECK: "1" } }, (error, stdout) => resolve(error ? null : String(stdout).trim())));
    const cliMarker = await this.stage(this.globalDir, "cli", { cli: o.cli }, null);
    this.cliVersion = cliMarker.output.version;
    this.verifying.cli = { recorded: cliMarker.output.version, now: version, since_run: version === cliMarker.output.version ? "same" : "changed" };
    await this.planAndLink();
    if (this.verifying.full) {
      const verified = await verifyPermitCapture(this.captureDir);
      this.verifying.capture = { ok: verified.ok, mismatches: verified.mismatches.length };
      if (!verified.ok) this.verifying.mismatches.push({ dir: rel(this.captureDir), stage: "capture", reason: verified.mismatches.slice(0, 3).join("; ") });
    }
  }

  /** The plan and link stages (shared by a run and a verification). */
  async planAndLink() {
    const o = this.options;
    // Plan.
    const extrasIndex = JSON.parse(await readFile(path.join(o.tcadExtrasDir, "index.json"), "utf8"));
    const seedSha = await sha256File(o.seedPath);
    const planInput = { version: "plan", seed_sha256: seedSha, extras_sha256: extrasIndex.output.sha256, shard_size: o.shardSize, max_shards: o.maxShards };
    const planMarker = await this.stage(this.globalDir, "plan", planInput, async () => {
      const extrasFile = path.join(o.tcadExtrasDir, EXTRAS_FILENAME);
      if ((await sha256File(extrasFile)) !== extrasIndex.output.sha256) throw new Error("the TCAD extras file no longer matches its index; rebuild it (t5-tcad-extras.mjs)");
      const plan = await planShards({ seedPath: o.seedPath, extrasFile, shardsDir: this.shardsDir, shardSize: o.shardSize, maxShards: o.maxShards });
      return { ...plan, extras: { dir: rel(o.tcadExtrasDir), sha256: extrasIndex.output.sha256, archive_sha256: extrasIndex.source?.sha256 ?? null }, seed: { path: rel(o.seedPath), sha256: seedSha }, files: plan.shards.flatMap((shard) => [{ path: `../shards/${shard.id}/seed.csv`, sha256: shard.seed_sha256 }, { path: `../shards/${shard.id}/extras.jsonl`, sha256: shard.extras_sha256 }]) };
    });
    this.plan = planMarker.output;
    this.wholeSeed = o.maxShards === null && this.plan.seed_rows_read === this.plan.rows;

    // The link pass over the verified capture, streamed per shard.
    const capture = o.captureDir ?? (await latestCapture());
    this.captureDir = capture;
    const captureSummary = JSON.parse(await readFile(path.join(capture, "capture.json"), "utf8"));
    this.asOfDate = String(captureSummary.rows_updated_at.end_iso).slice(0, 10);
    this.captureSummary = captureSummary;
    const listing = await resolveTcadPermitListing({ dir: o.tcadListingDir, ...(o.tcadListingReceipts ? { receiptsPath: o.tcadListingReceipts } : {}) });
    this.listing = { version: TCAD_PERMIT_LISTING_VERSION, dir: rel(listing.dir), listing_sha256: listing.index.listing.sha256, source_sha256: listing.index.source.sha256, source_url: listing.index.source.url, fetched_at: listing.index.source.fetched_at };
    const linkInput = {
      capture: { dir: rel(capture), json_sha256: await sha256File(path.join(capture, "capture.json")), receipts_sha256: await sha256File(path.join(capture, "receipts.jsonl")) },
      roll_seed_sha256: await sha256File(o.rollSeed),
      listing_sha256: listing.index.listing.sha256,
      plan_digest: digestOf(this.plan.shards.map((shard) => [shard.id, shard.first, shard.last, shard.rows])),
      as_of_date: this.asOfDate,
      code: (this.codeDigests.link ??= await codeDigest(STAGE_CODE.link)),
    };
    const linkMarker = await this.stage(
      this.globalDir,
      "link",
      linkInput,
      async (attempt) => {
        const verified = await verifyPermitCapture(capture);
        if (!verified.ok) throw new Error(`capture ${rel(capture)} does not verify: ${verified.mismatches.slice(0, 3).join("; ")}`);
        const roll = await readRollGeoIndex(o.rollSeed);
        const outDir = path.join(this.globalDir, `link-a${attempt}`);
        await mkdir(outDir, { recursive: true });
        const ranges = this.plan.shards.map((shard) => ({ id: shard.id, first: Number(shard.first), last: Number(shard.last) }));
        const shardOf = (propId) => {
          const value = Number(propId);
          let low = 0;
          let high = ranges.length - 1;
          while (low <= high) {
            const middle = (low + high) >> 1;
            if (value < ranges[middle].first) high = middle - 1;
            else if (value > ranges[middle].last) low = middle + 1;
            else return ranges[middle].id;
          }
          return null;
        };
        const writers = new Map();
        const writerOf = async (id) => {
          if (!writers.has(id)) {
            const handle = await open(path.join(outDir, `${id}.jsonl.partial`), "w");
            writers.set(id, { handle, buffer: [], size: 0, rows: 0 });
          }
          return writers.get(id);
        };
        const flush = async (writer) => {
          if (writer.buffer.length === 0) return;
          await writer.handle.write(writer.buffer.join(""));
          writer.buffer = [];
          writer.size = 0;
        };
        const internal = await open(path.join(outDir, "permits-internal.jsonl.partial"), "w");
        let internalBuffer = [];
        const requests = {};
        let selected = 0;
        const pass = await runLinkPass({
          captureDir: capture,
          roll,
          asOfDate: this.asOfDate,
          tcadListing: listing,
          onRow: async ({ entry, link: linkResult, profile, listingEntries }) => {
            requests[entry.file] ??= entry.request;
            const number = String(entry.row.permit_number ?? "").trim();
            internalBuffer.push(
              `${JSON.stringify({
                permit_key: number || `row:${entry.rowSha256}`,
                permit_number: number,
                row_sha256: entry.rowSha256,
                capture_file: entry.file,
                capture_row_index: entry.index,
                fetched_at: entry.fetchedAt,
                permittype: entry.row.permittype,
                permit_class: entry.row.permit_class,
                work_class: entry.row.work_class,
                status_current: entry.row.status_current,
                status_group: profile.statusGroup,
                lifecycle_status: profile.lifecycleStatus,
                roof_work_class: profile.roofWorkClass,
                is_roofing: profile.isRoofing,
                is_reroof: profile.isReroof,
                completed_date_evidence: profile.completedDateEvidence.evidenceState,
                tcad_id: entry.row.tcad_id,
                tcad_id_evidence: profile.tcadIdEvidence.evidenceState,
                property_id: linkResult.propertyId ?? null,
                match_method: linkResult.propertyLink?.match_method ?? null,
                link_confidence: linkResult.propertyLink?.confidence ?? null,
                unlinked_reason: linkResult.propertyId ? null : linkResult.unlinkedReason,
                applieddate: entry.row.applieddate,
                issue_date: entry.row.issue_date,
                completed_date: entry.row.completed_date,
                expiresdate: entry.row.expiresdate,
                statusdate: entry.row.statusdate,
                jurisdiction: entry.row.jurisdiction,
              })}\n`,
            );
            if (internalBuffer.length >= 2000) {
              await internal.write(internalBuffer.join(""));
              internalBuffer = [];
            }
            if (!linkResult.propertyId) return;
            const id = shardOf(linkResult.propertyId);
            if (!id) return;
            const writer = await writerOf(id);
            const line = `${JSON.stringify({ row: entry.row, file: entry.file, index: entry.index, rowSha256: entry.rowSha256, fetchedAt: entry.fetchedAt, receiptSha256: entry.receiptSha256, link: linkResult, listingEntries: listingEntries ?? null })}\n`;
            writer.buffer.push(line);
            writer.size += line.length;
            writer.rows += 1;
            selected += 1;
            if (writer.size > 1 << 20) await flush(writer);
          },
        });
        await internal.write(internalBuffer.join(""));
        await internal.close();
        const files = [];
        const perShard = {};
        for (const shard of this.plan.shards) {
          const writer = await writerOf(shard.id);
          await flush(writer);
          await writer.handle.close();
          const final = path.join(outDir, `${shard.id}.jsonl`);
          await rename(`${final}.partial`, final);
          const sha = await sha256File(final);
          perShard[shard.id] = { rows: writer.rows, sha256: sha };
          files.push({ path: `link-a${attempt}/${shard.id}.jsonl`, sha256: sha });
        }
        await rename(path.join(outDir, "permits-internal.jsonl.partial"), path.join(outDir, "permits-internal.jsonl"));
        await atomicWrite(path.join(outDir, "requests.json"), JSON.stringify(requests));
        await atomicWrite(path.join(outDir, "conflicting-numbers.json"), JSON.stringify([...pass.conflictingNumbers].sort()));
        // The summary's bytes are a function of the inputs alone (its timing goes into the marker), so reruns compare.
        const { elapsed_ms: linkElapsedMs, rows_per_minute: linkRowsPerMinute, ...summary } = pass.summary;
        await atomicWrite(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, 1)}\n`);
        for (const name of ["permits-internal.jsonl", "requests.json", "conflicting-numbers.json", "summary.json"]) files.push({ path: `link-a${attempt}/${name}`, sha256: await sha256File(path.join(outDir, name)) });
        return { dir: `link-a${attempt}`, capture_verified: verified.ok, elapsed_ms: linkElapsedMs, rows_per_minute: linkRowsPerMinute, rows: pass.summary.rows, linked: pass.summary.linked, selected_for_shards: selected, per_shard: perShard, roll: { seed_rows: roll.stats.seed_rows, sha256: roll.seedSha256 }, files };
      },
      { attemptPrefix: "link-a" },
    );
    this.link = linkMarker.output;
    const linkDir = path.join(this.globalDir, this.link.dir);
    this.linkDir = linkDir;
    this.requests = JSON.parse(await readFile(path.join(linkDir, "requests.json"), "utf8"));
    this.conflictingNumbers = new Set(JSON.parse(await readFile(path.join(linkDir, "conflicting-numbers.json"), "utf8")));
    this.linkSummary = JSON.parse(await readFile(path.join(linkDir, "summary.json"), "utf8"));
    this.policy = resolveEligibilityPolicy(process.env);
    for (const name of ["appraisal", "permits", "reconcile"]) this.codeDigests[name] ??= await codeDigest(STAGE_CODE[name]);
  }

  /**
   * One shard's linked permits, grouped by PROP_ID (the capture request and the profile restored).
   *
   * @param {string} shard - Shard id.
   * @returns {Promise<Map<string, any[]>>} Entries by PROP_ID.
   */
  async shardPermits(shard) {
    /** @type {Map<string, any[]>} */
    const byParcel = new Map();
    for await (const line of readLines(path.join(this.linkDir, `${shard}.jsonl`))) {
      const entry = JSON.parse(line);
      entry.request = this.requests[entry.file];
      entry.profile = summarizePermitRow(entry.row, { asOfDate: this.asOfDate });
      const propId = entry.link.propertyId;
      (byParcel.get(propId) ?? byParcel.set(propId, []).get(propId)).push(entry);
    }
    return byParcel;
  }

  /**
   * One shard through every stage.
   *
   * @param {Record<string, any>} shard - Plan entry.
   * @returns {Promise<Record<string, any>>} Shard result.
   */
  async runShard(shard) {
    const dir = path.join(this.shardsDir, shard.id);
    const shardStarted = performance.now();
    const common = { manifest_sha256: this.manifestSha, as_of_date: this.asOfDate };

    // Appraisal.
    const appraisal = await this.stage(
      dir,
      "appraisal",
      { ...common, seed_sha256: shard.seed_sha256, extras_sha256: shard.extras_sha256, transform: TRANSFORM_VERSION, code: this.codeDigests.appraisal },
      async (attempt) => {
        const outDir = path.join(dir, `appraisal-a${attempt}`);
        const seedRows = parseCsvRecords(await readFile(path.join(dir, "seed.csv"), "utf8"));
        /** @type {Map<string, any>} */
        const extras = new Map();
        if (existsSync(path.join(dir, "extras.jsonl"))) for await (const line of readLines(path.join(dir, "extras.jsonl"))) extras.set(line.slice(12, line.indexOf('"', 12)), JSON.parse(line));
        const result = await captureAndTransform({ seedRows, htmlDir: path.join(outDir, "html"), outputDir: outDir, jobId: `${this.state.run_id}-${shard.id}`, asOfDate: this.asOfDate, tcadExtras: extras, lexiconManifest: this.lexicon });
        const parcels = {};
        const dead = [];
        const retryable = [];
        for (const item of result.results) {
          if (item.classification === "success") parcels[item.parcelId] = await dataDirDigest(path.join(outDir, item.parcelId, "data"));
          else if (item.classification === "permanent_failure") dead.push({ key: item.parcelId, reason: "permanent_failure", evidence: item.error });
          else retryable.push({ key: item.parcelId, reason: "retryable_failure", evidence: item.error });
        }
        if (retryable.length > 0) throw Object.assign(new Error(`${retryable.length} parcel(s) failed retryably (${retryable[0].evidence}); resume to retry`), { retryable });
        return { dir: `appraisal-a${attempt}`, reconciled: result.reconciled, geometry: result.geometryCount, parcels, dead, artifact_digest: digestOf(parcels), timings: { total_ms: result.timings.totalMs, per_stage: result.timings.perStage }, files: [] };
      },
      { attemptPrefix: "appraisal-a", shard: shard.id },
    );
    const appraisalDir = path.join(dir, appraisal.output.dir);
    const ready = Object.keys(appraisal.output.parcels).sort((left, right) => Number(left) - Number(right));

    // Permits (eligibility and the permit transform per parcel).
    const linkShard = this.link.per_shard[shard.id];
    const permits = await this.stage(
      dir,
      "permits",
      { ...common, appraisal: appraisal.output.artifact_digest, link_sha256: linkShard.sha256, conflicting: digestOf([...this.conflictingNumbers].sort()), policy: this.policy.fingerprint, permit_transform: PERMIT_TRANSFORM_VERSION, parcel_link: PARCEL_LINK_VERSION, listing: this.listing.listing_sha256, code: this.codeDigests.permits },
      async (attempt) => {
        const byParcel = await this.shardPermits(shard.id);
        const states = {};
        const counts = { done: 0, done_zero_permits: 0, not_eligible: 0, failed_permanent: 0 };
        let linked = 0;
        let published = 0;
        let conflicting = 0;
        const byMethod = {};
        const failures = [];
        for (const propId of ready) {
          const parcelDir = path.join(appraisalDir, propId);
          const property = JSON.parse(await readFile(path.join(parcelDir, "data", "property.json"), "utf8"));
          const decision = decideEligibility(this.policy, property);
          if (!decision.eligible) {
            states[propId] = { status: "not_eligible", reason: decision.reason };
            counts.not_eligible += 1;
            continue;
          }
          const entries = byParcel.get(propId) ?? [];
          linked += entries.length;
          for (const entry of entries) byMethod[entry.link.propertyLink.match_method] = (byMethod[entry.link.propertyLink.match_method] ?? 0) + 1;
          const dataDirName = `permit-data-a${attempt}`;
          try {
            const written = await writeTravisPermitTransform({ parcelDir, propId, entries, manifest: this.lexicon, asOfDate: this.asOfDate, conflictingNumbers: this.conflictingNumbers, dataDirName: `${dataDirName}.partial` });
            conflicting += written.conflicting;
            if (written.dataDir) {
              const names = await readdir(written.dataDir);
              const files = Object.fromEntries(await Promise.all(names.map(async (name) => [name, JSON.parse(await readFile(path.join(written.dataDir, name), "utf8"))])));
              assertOutputContract(files, { countyCid: this.roots.propertyImprovementCid, seedCid: this.roots.seedCid });
              const seedRow = { parcel_id: propId, county: "Travis", county_fips: "48453" };
              assertTravisIdentity({ row: seedRow, files, roots: { countyCid: this.roots.propertyImprovementCid, seedCid: this.roots.seedCid }, sourceHosts: TRAVIS_PERMIT_SOURCE_HOSTS });
              for (const name of COPIED_FROM_APPRAISAL) {
                if (sha256Hex(await readFile(path.join(written.dataDir, name))) !== sha256Hex(await readFile(path.join(parcelDir, "data", name)))) throw new Error(`${name} differs from the appraisal output`);
              }
              await rename(written.dataDir, path.join(parcelDir, dataDirName));
              states[propId] = { status: "done", linked: entries.length, published: written.published, artifact_hash: await dataDirDigest(path.join(parcelDir, dataDirName)) };
              published += written.published;
              counts.done += 1;
            } else {
              states[propId] = { status: "done_zero_permits", linked: entries.length, published: 0 };
              counts.done_zero_permits += 1;
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            states[propId] = { status: "failed_permanent", error: message };
            counts.failed_permanent += 1;
            failures.push({ key: propId, error: message });
          }
        }
        return { data_dir: `permit-data-a${attempt}`, counts, linked, published, conflicting, by_link_method: byMethod, states, failures, artifact_digest: digestOf(states), files: [] };
      },
      { attemptPrefix: null, shard: shard.id, appraisalMarker: appraisal },
    );

    // Roof age and the internal query table.
    const reconcile = await this.stage(
      dir,
      "reconcile",
      { ...common, appraisal: appraisal.output.artifact_digest, permits: permits.output.artifact_digest, link_sha256: linkShard.sha256, roof_age: T5_ROOF_AGE_VERSION, profile: compiledTravisRoofAgeProfile.sha256, code: this.codeDigests.reconcile },
      async (attempt) => {
        const outDir = path.join(dir, `reconcile-a${attempt}`);
        await mkdir(outDir, { recursive: true });
        const byParcel = await this.shardPermits(shard.id);
        const seedRows = new Map(parseCsvRecords(await readFile(path.join(dir, "seed.csv"), "utf8")).map((row) => [String(row.parcel_id).trim(), row]));
        const counts = emptyRoofAgeCounts();
        const lines = [];
        const rows = [];
        for (const propId of ready) {
          const parcelDir = path.join(appraisalDir, propId);
          const names = (await readdir(path.join(parcelDir, "data"))).filter((name) => name.endsWith(".json"));
          const files = Object.fromEntries(await Promise.all(names.map(async (name) => [name, JSON.parse(await readFile(path.join(parcelDir, "data", name), "utf8"))])));
          const state = permits.output.states[propId];
          const publishedEntries = state?.status === "done" || state?.status === "done_zero_permits" ? partitionPermits(byParcel.get(propId) ?? [], this.conflictingNumbers).publishable : [];
          const builtYear = files["property.json"]?.property_structure_built_year;
          const record = estimateParcelRoofAge({ propId, builtYear: Number.isInteger(builtYear) ? builtYear : null, permits: publishedEntries, asOfDate: this.asOfDate });
          countRoofAge(counts, record);
          lines.push(`${JSON.stringify(record)}\n`);
          let sourcePayload = null;
          try {
            sourcePayload = JSON.parse(await readFile(path.join(parcelDir, "source-payload.json"), "utf8"));
          } catch {
            sourcePayload = null;
          }
          rows.push(mapTransformedFilesToQueryTableRow({ parcelId: propId, files, seedRow: seedRows.get(propId) ?? null, sourcePayload, asOfDate: this.asOfDate, roofAge: record, permits: { published: state?.published ?? 0 } }));
        }
        await atomicWrite(path.join(outDir, "roof-age.jsonl"), lines.join(""));
        const parquetPath = path.join(outDir, "query-table.parquet");
        await writeQueryTableParquet({ parquetPath: `${parquetPath}.partial`, schemaFields: TRAVIS_QUERY_TABLE_SCHEMA_FIELDS, rows });
        await rename(`${parquetPath}.partial`, parquetPath);
        return {
          dir: `reconcile-a${attempt}`,
          roof_age: counts,
          query_table_rows: rows.length,
          files: [
            { path: `reconcile-a${attempt}/roof-age.jsonl`, sha256: await sha256File(path.join(outDir, "roof-age.jsonl")) },
            { path: `reconcile-a${attempt}/query-table.parquet`, sha256: await sha256File(parquetPath) },
          ],
        };
      },
      { attemptPrefix: "reconcile-a", shard: shard.id },
    );

    // The elephant-cli chain per group.
    const permitParcels = Object.entries(permits.output.states).filter(([, state]) => state.status === "done").map(([propId]) => propId).sort((left, right) => Number(left) - Number(right));
    const groups = {};
    let countyInvalid = new Set();
    for (const group of GROUPS) {
      // A parcel the County validation drops is left out of its Property Improvement group too: the permit archive's
      // properties must all be properties of the County archive (cid_check).
      const members = group === "county" ? ready : permitParcels.filter((propId) => !countyInvalid.has(propId));
      if (members.length === 0) {
        groups[group] = { skipped: "no parcel in this group" };
        continue;
      }
      groups[group] = await this.runGroup(shard, dir, group, members, group === "county" ? (propId) => path.join(appraisalDir, propId, "data") : (propId) => path.join(appraisalDir, propId, permits.output.data_dir), group === "county" ? appraisal.output.artifact_digest : permits.output.artifact_digest);
      if (group === "county") countyInvalid = new Set((groups.county.validate?.output?.invalid ?? []).map((item) => item.key));
    }
    const permitInvalid = new Set((groups.property_improvement?.validate?.output?.invalid ?? []).map((item) => item.key));
    const permitMembers = permitParcels.filter((propId) => !countyInvalid.has(propId) && !permitInvalid.has(propId));

    // Every Property Improvement property is the same property in the County archive.
    const cidCheck = await this.stage(
      dir,
      "cid_check",
      { county: groups.county?.hash?.output?.hash_csv_sha256 ?? null, property_improvement: groups.property_improvement?.hash?.output?.hash_csv_sha256 ?? null },
      async () => {
        const cids = async (group) => {
          const marker = groups[group]?.hash;
          if (!marker) return [];
          const rows = parseCsvRecords(await readFile(path.join(dir, marker.output.chain_dir, "hash.csv"), "utf8"));
          return [...new Set(rows.filter((row) => row.dataGroupCid === this.roots.seedCid).map((row) => row.propertyCid))].sort();
        };
        const county = new Set(await cids("county"));
        const permitCids = await cids("property_improvement");
        const missing = permitCids.filter((cid) => !county.has(cid));
        if (missing.length > 0) throw new Error(`${missing.length} Property Improvement properties are not in the County archive`);
        return { county_properties: county.size, permit_properties: permitCids.length, same_property_cid: missing.length === 0 && permitCids.length === permitMembers.length, files: [] };
      },
      { attemptPrefix: null, shard: shard.id },
    );

    // The Loader's merge (single writer: serialized across shards).
    const invalid = groups.county?.validate?.output?.invalid ?? [];
    const invalidKeys = new Set(invalid.map((item) => item.key));
    const merge = await this.stage(
      dir,
      "merge",
      { appraisal: appraisal.output.artifact_digest, permits: permits.output.artifact_digest, reconcile: reconcile.output.files, invalid: [...invalidKeys].sort(), scope: this.options.loaderScope, code: (this.codeDigests.loader ??= await codeDigest(STAGE_CODE.loader)) },
      async () => {
        const run = async () =>
          recordShardMerge({
            loaderDir: this.loaderDir,
            runId: this.state.run_id,
            shard: shard.id,
            ready: ready.filter((key) => !invalidKeys.has(key)).map((key) => ({ key, dir: path.join(appraisalDir, key, "data"), artifact_hash: appraisal.output.parcels[key] })),
            dead: appraisal.output.dead,
            invalid,
            retryable: [],
            permitGroups: permitMembers.map((key) => ({ key, dir: path.join(appraisalDir, key, permits.output.data_dir), artifact_hash: permits.output.states[key].artifact_hash, permits: permits.output.states[key].published })),
            tables: { query_table: { file: path.join(dir, reconcile.output.dir, "query-table.parquet"), rows: reconcile.output.query_table_rows }, roof_age: { file: path.join(dir, reconcile.output.dir, "roof-age.jsonl"), rows: reconcile.output.roof_age.parcels } },
          });
        const result = await (this.mergeChain = this.mergeChain.then(run, run));
        return { record: rel(path.join(this.loaderDir, "merges", this.state.run_id, `${shard.id}.json`)), digest: result.record.digest, written: result.written, files: [] };
      },
      { attemptPrefix: null, shard: shard.id },
    );
    this.inFlight.delete(shard.id);
    const result = { shard: shard.id, rows: shard.rows, ms: Math.round(performance.now() - shardStarted), appraisal, permits, reconcile, groups, cid_check: cidCheck, merge };
    this.shardResults.set(shard.id, result);
    return result;
  }

  /**
   * The CLI chain of one group in one shard: validate (excluding invalid properties if any fail), hash, CAR validate,
   * export-tables, each under its own done-marker; staging names renamed only on success.
   *
   * @param {Record<string, any>} shard - Plan entry.
   * @param {string} dir - Shard directory.
   * @param {string} group - `county` or `property_improvement`.
   * @param {string[]} members - PROP_IDs in the group.
   * @param {(propId: string) => string} dataDirOf - Each member's data directory.
   * @param {string} inputDigest - The digest of what produced the members' files.
   * @returns {Promise<Record<string, any>>} The four markers.
   */
  async runGroup(shard, dir, group, members, dataDirOf, inputDigest) {
    const name = `travis-${group}-${shard.id}`;
    const cliInput = { cli_version: this.cliVersion, manifest_sha256: this.manifestSha };
    const validate = await this.stage(
      dir,
      `${group}.validate`,
      { ...cliInput, members: digestOf(members), produced_by: inputDigest },
      async (attempt) => {
        let current = members;
        const invalid = [];
        let chain = null;
        let parsed = null;
        let pass = attempt;
        for (let round = 0; round < 2; round += 1) {
          chain = `${group}-a${pass}`;
          const chainDir = path.join(dir, chain);
          const groupDir = path.join(chainDir, group);
          for (const propId of current) {
            const target = path.join(groupDir, propId, "data");
            await mkdir(target, { recursive: true });
            for (const file of await readdir(dataDirOf(propId))) {
              if (!existsSync(path.join(target, file))) await link(path.join(dataDirOf(propId), file), path.join(target, file));
            }
          }
          const result = await this.cli(["validate", `./${group}`, "--output-csv", "./errors.partial.csv"], chainDir, path.join(chainDir, "logs", "validate.log"), { shard: shard.id, stage: `${group}.validate` });
          parsed = parseCliOutput(result.output);
          if (result.signal || this.stopping) throw new Error("interrupted");
          if (!parsed.processed) throw new Error(`validate printed no summary (exit ${result.code}); see ${rel(path.join(chainDir, "logs", "validate.log"))}`);
          const errorsText = existsSync(path.join(chainDir, "errors.partial.csv")) ? await readFile(path.join(chainDir, "errors.partial.csv"), "utf8") : "";
          if (parsed.processed.failed === 0 && result.code === 0) {
            await rename(path.join(chainDir, "errors.partial.csv"), path.join(chainDir, "errors.csv")).catch(async () => writeFile(path.join(chainDir, "errors.csv"), ""));
            return { chain_dir: chain, processed: parsed.processed, invalid, members: current.length, files: [{ path: `${chain}/errors.csv`, sha256: await sha256File(path.join(chainDir, "errors.csv")) }] };
          }
          const failing = invalidPropertiesFromErrors(errorsText, group);
          if (failing.size === 0) throw new Error(`validate failed ${parsed.processed.failed} properties but named none (exit ${result.code})`);
          for (const [key, evidence] of failing) invalid.push({ key, reason: "elephant_cli_validate", evidence: evidence.slice(0, 300) });
          current = current.filter((propId) => !failing.has(propId));
          if (current.length === 0) return { chain_dir: null, processed: parsed.processed, invalid, members: 0, files: [] };
          pass += 1;
        }
        throw new Error(`validate still fails after excluding ${invalid.length} invalid properties`);
      },
      { attemptPrefix: `${group}-a`, shard: shard.id },
    );
    if (validate.output.members === 0) return { validate, skipped: "every property failed validation" };
    const chainDir = path.join(dir, validate.output.chain_dir);
    const step = async (stepName, input, args, outputs, check) =>
      this.stage(
        dir,
        `${group}.${stepName}`,
        { ...cliInput, ...input },
        async (attempt) => {
          const suffix = `p${attempt}`; // unique: reserveAttempt never hands out an attempt twice
          const staged = outputs.map((item) => ({ ...item, staging: item.final.replace(/(\.[a-z]+)?$/, (ext) => `.${suffix}.partial${ext ?? ""}`) }));
          const result = await this.cli(args(Object.fromEntries(staged.map((item) => [item.key, item.staging]))), chainDir, path.join(chainDir, "logs", `${stepName}-${suffix}.log`), { shard: shard.id, stage: `${group}.${stepName}` });
          if (result.signal || this.stopping) throw new Error("interrupted");
          const parsed = parseCliOutput(result.output);
          const verdict = check(result, parsed);
          if (verdict) throw new Error(`${group} ${stepName} in ${shard.id}: ${verdict} (exit ${result.code}); see ${rel(path.join(chainDir, "logs", `${stepName}-${suffix}.log`))}`);
          const files = [];
          for (const item of staged) {
            const final = path.join(chainDir, item.final);
            if (existsSync(final)) await rename(final, `${final}.stale-${Date.now()}`);
            await rename(path.join(chainDir, item.staging), final);
            const isDir = (await stat(final)).isDirectory();
            files.push({ path: `${validate.output.chain_dir}/${item.final}`, sha256: isDir ? (await treeDigest(final)).sha256 : await sha256File(final), ...(isDir ? { tree: true } : {}) });
          }
          return { chain_dir: validate.output.chain_dir, ...parsed, exit: result.code, ms: Math.round(result.ms), files };
        },
        { attemptPrefix: null, shard: shard.id },
      );
    const hash = await step(
      "hash",
      { validated: validate.input_digest, members: validate.output.members },
      (out) => ["hash", `./${group}`, "--output-zip", `./${out.hashed}`, "--output-csv", out.csv, "--output-car", out.car],
      [
        { key: "hashed", final: "hashed" },
        { key: "csv", final: "hash.csv" },
        { key: "car", final: `${name}.car` },
      ],
      (result, parsed) => (result.code !== 0 ? "hash failed" : !parsed.car ? "no CAR line" : null),
    );
    hash.output.hash_csv_sha256 = hash.output.files.find((item) => item.path.endsWith("hash.csv")).sha256;
    const carSha = hash.output.files.find((item) => item.path.endsWith(".car")).sha256;
    const carValidate = await step(
      "car_validate",
      { car_sha256: carSha },
      (out) => ["validate", `${name}.car`, "--output-csv", out.csv],
      [{ key: "csv", final: "car-errors.csv" }],
      (result, parsed) => (!parsed.car_validation?.passed ? "the CAR did not pass every check" : result.code !== 0 ? "CAR validate failed" : null),
    );
    const exportTables = await step(
      "export_tables",
      { car_sha256: carSha, part_size: PART_SIZE },
      (out) => ["export-tables", `${name}.car`, "--output", `./${out.tables}`, "--part-size", PART_SIZE, "--output-json", out.json],
      [
        { key: "tables", final: "tables" },
        { key: "json", final: "tables-export.json" },
      ],
      (result, parsed) => (result.code !== 0 ? "export-tables failed" : !parsed.tables ? "no Tables line" : null),
    );
    // A rerun whose CAR comes out byte for byte the same keeps the CAR validation and the tables of the earlier chain
    // (their inputs, the CAR's SHA-256, are unchanged), so the tables are read where export-tables wrote them.
    const tablesChain = path.join(dir, exportTables.output.chain_dir ?? validate.output.chain_dir);
    return { validate, hash, car_validate: carValidate, export_tables: exportTables, car: { path: rel(path.join(chainDir, `${name}.car`)), sha256: carSha, bytes: (await stat(path.join(chainDir, `${name}.car`))).size }, tables: { dir: rel(path.join(tablesChain, "tables")), export_json: rel(path.join(tablesChain, "tables-export.json")) } };
  }

  /** The Loader finalize stage's input: every shard's merge digest, the scope, the seed coverage and the code. */
  loaderInput() {
    return { merges: this.plan.shards.map((shard) => this.shardResults.get(shard.id)?.merge.output.digest), scope: this.options.loaderScope, whole_seed: this.wholeSeed, code: this.codeDigests.loader };
  }

  /**
   * Verify the run without writing anything (no lock, no state, no progress file, no request). Every done-marker is
   * checked against its input recomputed now, with each stage's code as of the run's kit commit; outputs must exist
   * (`full`: and still hash to their recorded SHA-256); the Loader's generation must match its marker and be in the
   * Loader history; `run.json` must equal the record rebuilt from the markers (except the fields that only the live run
   * could sample: memory, disk, preflight, no-sleep, readiness and the kit commit, which are taken as recorded).
   *
   * @param {{ full?: boolean }} [options] - `full` re-hashes every output.
   * @returns {Promise<Record<string, any>>} The verification report.
   */
  async verify({ full = false } = {}) {
    const started = performance.now();
    this.started = started;
    this.phase = "verify";
    this.verifying = { full, stages: 0, outputs: 0, files: 0, bytes: 0, mismatches: [], cli: null, capture: null };
    if (!existsSync(this.statePath)) throw new Error(`no T5 run state at ${rel(this.statePath)}`);
    this.state = JSON.parse(await readFile(this.statePath, "utf8"));
    const lockPath = path.join(this.runDir, "run.lock");
    if (existsSync(lockPath)) {
      const holder = Number.parseInt((await readFile(lockPath, "utf8")).trim(), 10);
      if (Number.isInteger(holder) && holder !== process.pid && alive(holder) && /t5-run/.test((await commandOf(holder)) ?? "")) throw new Error(`run ${rel(this.runDir)} is being written by live runner pid ${holder}; verify it after that runner stops`);
    }
    this.attempt = this.state.attempts.at(-1) ?? { started_at: this.state.created_at };
    this.loaderDir = path.join(this.options.loaderRoot, this.options.loaderScope);
    const recordPath = path.join(this.runDir, "run.json");
    const saved = existsSync(recordPath) ? JSON.parse(await readFile(recordPath, "utf8")) : null;
    // The code each stage ran: as of the run's kit commit when run.json names a clean one, else the working tree.
    const commit = typeof saved?.kit_commit === "string" && /^[0-9a-f]{7,40}$/.test(saved.kit_commit) ? saved.kit_commit : null;
    const codeSinceRun = {};
    let codeBasis = commit ? `kit ${commit}` : "working tree (no clean kit commit recorded)";
    for (const [name, files] of Object.entries(STAGE_CODE)) {
      const now = await codeDigest(files);
      let atRun = now;
      if (commit) {
        try {
          atRun = await codeDigestAtCommit(commit, files);
        } catch {
          codeBasis = `working tree (kit ${commit} unreadable)`;
        }
      }
      this.codeDigests[name] = atRun;
      codeSinceRun[name] = atRun === now ? "same" : "changed";
    }
    let loaderReport = null;
    let runJson = saved ? "not compared" : "missing";
    try {
      await this.globalStages();
      const queue = [...this.plan.shards];
      const worker = async () => {
        while (queue.length > 0) {
          const shard = queue.shift();
          try {
            await this.runShard(shard);
          } catch (error) {
            if (!error?.verifyMismatch) this.verifying.mismatches.push({ dir: rel(path.join(this.shardsDir, shard.id)), stage: "shard", reason: error instanceof Error ? error.message : String(error) });
          }
        }
      };
      await Promise.all(Array.from({ length: full ? Math.min(this.options.concurrency, queue.length) : 1 }, () => worker()));
      if (this.shardResults.size === this.plan.shards.length) {
        const loader = await this.stage(this.globalDir, "loader", this.loaderInput(), null);
        const generationDir = path.join(RUNTIME_ROOT, loader.output.generation_dir);
        const stateSha = existsSync(path.join(generationDir, "state.json")) ? await sha256File(path.join(generationDir, "state.json")) : null;
        const history = await loadHistory(this.loaderDir);
        const at = history.findIndex((item) => item.run_id === this.state.run_id && item.state_sha256 === loader.output.state_sha256);
        const current = existsSync(path.join(this.loaderDir, "CURRENT")) ? (await readFile(path.join(this.loaderDir, "CURRENT"), "utf8")).trim() : null;
        loaderReport = { generation: loader.output.generation_dir, state_sha256_matches: stateSha === loader.output.state_sha256, in_history: at >= 0, current_generation: current, later_loads: at >= 0 ? history.length - at - 1 : null };
        if (stateSha !== loader.output.state_sha256) this.verifying.mismatches.push({ dir: loader.output.generation_dir, stage: "loader", reason: "the generation's state.json no longer matches the finalize marker" });
        if (at < 0) this.verifying.mismatches.push({ dir: rel(this.loaderDir), stage: "loader", reason: "loads.jsonl holds no finalize of this run with that state" });
        if (saved && this.verifying.mismatches.length === 0) {
          this.readiness = saved.readiness_report;
          this.preflight = saved.preflight;
          this.noSleep = saved.no_sleep;
          const rebuilt = await buildRunRecord({ run: this, loader: loader.output, history: history.slice(0, at + 1), t3: await t3Watermarks([path.join(RUNTIME_ROOT, "data", "travis", "registry"), path.join(RUNTIME_ROOT, "data", "travis", "licensing")]), diskBytes: 0 });
          for (const key of ["memory", "disk", "preflight", "no_sleep", "readiness_report", "kit_commit"]) rebuilt[key] = saved[key];
          const differs = [...new Set([...Object.keys(saved), ...Object.keys(rebuilt)])].filter((key) => digestOf(saved[key] ?? null) !== digestOf(rebuilt[key] ?? null));
          runJson = differs.length === 0 ? "equal" : { differs };
          if (differs.length > 0) this.verifying.mismatches.push({ dir: rel(recordPath), stage: "run.json", reason: `differs from the record rebuilt from the markers in ${differs.join(", ")}` });
        }
      }
    } catch (error) {
      if (!error?.verifyMismatch) this.verifying.mismatches.push({ dir: rel(this.runDir), stage: "verify", reason: error instanceof Error ? error.message : String(error) });
    }
    const v = this.verifying;
    const counts = saved ? { seed: saved.counts.appraisal.seed, ready: saved.counts.appraisal.ready, dead: saved.counts.appraisal.dead, invalid: saved.counts.appraisal.invalid, reconciles: saved.counts.appraisal.reconciles, shards: saved.shards.total, cars: saved.cars.length, permits_published: saved.counts.permits.published, roof_age_eligible: saved.roof_age.eligible } : null;
    return {
      travis_t5_verify: this.state.run_id,
      mode: full ? "full" : "quick",
      status: v.mismatches.length > 0 ? "mismatch" : this.state.status === "finished" ? "verified" : "unfinished",
      run_status: this.state.status,
      stages_checked: v.stages,
      outputs_checked: v.outputs,
      outputs_rehashed: { files: v.files, bytes: v.bytes },
      code_basis: codeBasis,
      code_since_run: codeSinceRun,
      cli: v.cli,
      capture: v.capture,
      loader: loaderReport,
      run_json: runJson,
      counts,
      mismatch_count: v.mismatches.length,
      mismatches: v.mismatches.slice(0, 20),
      wrote: "nothing",
      seconds: round((performance.now() - started) / 1000, 1),
    };
  }

  /** One progress line (stdout, `progress.txt`, `progress.jsonl`). */
  async progress() {
    const sample = await sampleCli();
    const swap = await sampleSwap();
    const runnerRss = process.memoryUsage().rss;
    this.peak.cli_rss_bytes = Math.max(this.peak.cli_rss_bytes, sample.cli_rss_bytes);
    this.peak.cli_processes = Math.max(this.peak.cli_processes, sample.cli_processes);
    this.peak.runner_rss_bytes = Math.max(this.peak.runner_rss_bytes, runnerRss);
    this.peak.combined_rss_bytes = Math.max(this.peak.combined_rss_bytes ?? 0, sample.cli_rss_bytes + runnerRss);
    if (swap !== null) this.peak.swap_used_bytes = Math.max(this.peak.swap_used_bytes, swap);
    const total = this.plan?.shards.length ?? 0;
    const done = this.shardResults.size;
    const parcelsTotal = this.plan?.rows ?? 0;
    const parcelsDone = [...this.shardResults.values()].reduce((sum, item) => sum + item.rows, 0);
    const parcelsSkipped = this.skippedParcels ?? 0;
    const eta = estimateEta({ parcelsDone: parcelsDone - parcelsSkipped, parcelsTotal: parcelsTotal - parcelsSkipped, poolElapsedMs: this.poolStarted ? performance.now() - this.poolStarted : 0 });
    const flight = [...this.inFlight].map(([shard, stage]) => `${shard} ${stage}`).join(", ");
    const elapsed = performance.now() - this.started;
    const finishAt = eta.eta_ms === null ? null : new Date(Date.now() + eta.eta_ms);
    const gb = (bytes) => Math.round((bytes / 1024 ** 3) * 10) / 10;
    const line = `[t5 ${nowIso().slice(0, 19)}Z] ${this.phase} | shards ${done}/${total} done, ${this.inFlight.size} in flight${flight ? ` (${flight})` : ""} | parcels ${parcelsDone}/${parcelsTotal} | elapsed ${formatDuration(elapsed)} | ETA ${formatDuration(eta.eta_ms)}${finishAt ? ` (about ${finishAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} local)` : ""} | elephant-cli ${sample.cli_processes} procs ${gb(sample.cli_rss_bytes)} GB, runner ${gb(runnerRss)} GB, swap ${swap === null ? "?" : gb(swap)} GB`;
    this.log(line);
    await writeFile(path.join(this.runDir, "progress.txt"), `${line}\n`);
    await appendFile(path.join(this.runDir, "progress.jsonl"), `${JSON.stringify({ at: nowIso(), phase: this.phase, shards_done: done, shards_total: total, in_flight: Object.fromEntries(this.inFlight), parcels_done: parcelsDone, parcels_total: parcelsTotal, elapsed_ms: Math.round(elapsed), eta_ms: eta.eta_ms, parcels_per_hour: eta.parcels_per_hour, cli_processes: sample.cli_processes, cli_rss_bytes: sample.cli_rss_bytes, runner_rss_bytes: runnerRss, swap_used_bytes: swap })}\n`);
  }

  /**
   * Prepare a scoped rerun (`--rerun-shards`, or the one a stopped attempt left active), read-only: the run's kit commit,
   * a committed Travis tree, the code changes since that commit with their proofs, and the code each stage ran. A refusal
   * here writes nothing, so a finished run stays finished.
   */
  async prepareScope() {
    const state = existsSync(this.statePath) ? JSON.parse(await readFile(this.statePath, "utf8")) : null;
    const active = state?.scoped_rerun?.active ? state.scoped_rerun : null;
    const asked = this.options.rerunShards ?? null;
    if (!active && !asked) return;
    if (active && asked && digestOf([...active.shards].sort()) !== digestOf([...asked].sort())) throw new Error(`run ${rel(this.runDir)} has a scoped rerun of ${active.shards.join(",")} in progress; resume it with those shards`);
    const shards = [...(active?.shards ?? asked)].sort();
    const planMarker = path.join(this.globalDir, "plan.done.json");
    const planned = existsSync(planMarker) ? new Set(JSON.parse(await readFile(planMarker, "utf8")).output.shards.map((shard) => shard.id)) : new Set();
    const unknown = shards.filter((id) => !planned.has(id));
    if (unknown.length > 0) throw new Error(`--rerun-shards names ${unknown.join(", ")}, not shards of this run's plan`);
    let commit = active?.kit_commit_at_run ?? null;
    if (!commit) {
      const saved = existsSync(path.join(this.runDir, "run.json")) ? JSON.parse(await readFile(path.join(this.runDir, "run.json"), "utf8")) : null;
      commit = typeof saved?.kit_commit === "string" && /^[0-9a-f]{7,40}$/.test(saved.kit_commit) ? saved.kit_commit : null;
      if (!commit) throw new Error(`run.json of ${rel(this.runDir)} names no clean kit commit (${String(saved?.kit_commit ?? "none")}): a scoped rerun re-certifies against the code the run ran`);
    }
    if (!this.options.allowDirty) {
      const dirty = await new Promise((resolve) => execFile("git", ["-C", RUNTIME_ROOT, "status", "--porcelain", "--", "src/counties/travis", "counties/travis", "src/roof-age"], (error, stdout) => resolve(error ? "git status failed" : String(stdout).trim())));
      if (dirty) throw new Error(`the Travis code has uncommitted changes (${dirty.split("\n").slice(0, 3).join("; ")}): commit them first; the record names the commit the rerun ran and every proof compares with it`);
    }
    const changes = this.options.codeChanges ?? (await codeChanges({ commit, stageCode: STAGE_CODE }));
    const unproven = Object.entries(changes.files).filter(([, item]) => item.at_run_sha256 !== item.now_sha256 && !item.holds);
    if (unproven.length > 0) throw new Error(`the stage code changed since kit ${commit} where no proof holds (${unproven.map(([file, item]) => `${file}: ${item.detail}`).join("; ")}); nothing was rerun`);
    const codeAtRun = this.options.codeAtRun ?? Object.fromEntries(await Promise.all(Object.entries(STAGE_CODE).map(async ([name, files]) => [name, await codeDigestAtCommit(commit, files)])));
    this.scoped = new ScopedRerun({ shards, commit, changes, codeAtRun });
    this.scopeState = active ?? { active: true, shards, kit_commit_at_run: commit, started_at: nowIso(), attempts: [] };
  }

  /** The scoped rerun's summary for the record: the shards, the commits and every changed file with its proof. */
  scopeSummary() {
    const files = Object.entries(this.scoped.changes.files)
      .filter(([, item]) => item.at_run_sha256 !== item.now_sha256)
      .map(([file, item]) => ({ file, stages: item.stages, proof: item.proof, holds: item.holds, at_run_sha256: item.at_run_sha256, now_sha256: item.now_sha256, detail: item.detail }));
    return { shards: [...this.scoped.shards], kit_commit_at_run: this.scoped.commit, started_at: this.scopeState.started_at, ended_at: this.attempt.ended_at, attempts: this.state.scoped_rerun.attempts, code_changes: files };
  }

  /** The whole run. Returns the run record (or throws; markers keep what finished). */
  async run() {
    this.started = performance.now();
    this.phase = "starting";
    await this.prepareScope();
    const resumed = await this.open();
    if (this.scoped) {
      this.state.scoped_rerun = { ...this.scopeState, attempts: [...(this.scopeState.attempts ?? []), this.attempt.attempt] };
      await this.saveState();
      this.log(`[t5] scoped rerun of ${[...this.scoped.shards].join(", ")}: every other shard is re-certified against kit ${this.scoped.commit} (${Object.values(this.scoped.changes.files).filter((item) => item.at_run_sha256 !== item.now_sha256).length} changed file(s), each with a proof that holds)`);
    }
    if (this.options.installSignals !== false) this.installSignals();
    this.noSleep = this.holdNoSleep();
    process.env.ELEPHANT_SKIP_UPDATE_CHECK = "1";
    this.loaderDir = path.join(this.options.loaderRoot, this.options.loaderScope);
    this.log(`[t5] ${resumed ? "resuming" : "starting"} ${rel(this.runDir)} (attempt ${this.attempt.attempt}, pid ${process.pid}); no-sleep ${this.noSleep.held ? this.noSleep.command : `not held: ${this.noSleep.reason}`}; ELEPHANT_SKIP_UPDATE_CHECK=1; loader scope ${this.options.loaderScope}`);
    if (this.attempt.reaped_orphans.length > 0) this.log(`[t5] stopped ${this.attempt.reaped_orphans.length} elephant-cli process(es) a killed runner left behind`);
    const ticker = setInterval(() => this.progress().catch(() => {}), this.options.progressIntervalMs);
    ticker.unref();
    try {
      this.phase = "global stages";
      await this.globalStages();
      await this.saveState();
      this.phase = "shards";
      // Shards whose merge marker already matches are skipped by their stages; count them for the ETA.
      this.poolStarted = performance.now();
      // A scoped rerun starts its rerun shards first: every re-certification waits on their comparisons.
      const queue = this.scoped ? [...this.plan.shards.filter((shard) => this.scoped.reruns(shard.id)), ...this.plan.shards.filter((shard) => !this.scoped.reruns(shard.id))] : [...this.plan.shards];
      const failures = [];
      const worker = async () => {
        while (queue.length > 0 && !this.stopping) {
          const shard = queue.shift();
          try {
            const result = await this.runShard(shard);
            const skippedAll = [result.appraisal, result.permits, result.reconcile, result.merge].every((marker) => marker.skipped);
            if (skippedAll) this.skippedParcels = (this.skippedParcels ?? 0) + shard.rows;
            await this.progress();
          } catch (error) {
            this.inFlight.delete(shard.id);
            const message = error instanceof Error ? error.message : String(error);
            if (message !== "interrupted") {
              failures.push({ shard: shard.id, error: message, retryable: Boolean(error?.retryable) || !/fails the ready-hash gate|still fails/.test(message) });
              this.stageCounts.failed += 1;
              this.log(`[t5] ${shard.id} failed: ${message}`);
              await appendFile(path.join(this.runDir, "failures.jsonl"), `${JSON.stringify({ at: nowIso(), shard: shard.id, error: message, attempt: this.attempt.attempt })}\n`);
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.options.concurrency, this.plan.shards.length) }, () => worker()));
      if (this.stopping) throw Object.assign(new Error(`stopped by ${this.stopSignal}`), { exitCode: this.stopSignal === "SIGINT" ? 130 : 143 });
      if (failures.length > 0) {
        this.attempt.failures = failures;
        throw Object.assign(new Error(`${failures.length} shard(s) failed (${failures.map((item) => item.shard).join(", ")}); fix the cause if needed and run the same command again to resume`), { exitCode: 2 });
      }

      // Finalize: the Loader, the manifest at the end, the run record.
      this.phase = "finalize";
      const loader = await this.stage(
        this.globalDir,
        "loader",
        this.loaderInput(),
        async () => {
          const partitions = (await readFile(path.join(this.captureDir, "receipts.jsonl"), "utf8"))
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) => JSON.parse(line))
            .filter((receipt) => receipt.kind === "page" && receipt.status === 200 && !receipt.retried)
            .map((receipt) => ({ file: receipt.file, sha256: receipt.sha256, rows: receipt.rows ?? null }));
          const state = await finalizeLoad({ loaderDir: this.loaderDir, runId: this.state.run_id, runDir: this.runDir, shards: this.plan.shards.map((shard) => shard.id), wholeSeed: this.wholeSeed, capture: { dir: this.captureDir, partitions }, permitsRowsFile: path.join(this.linkDir, "permits-internal.jsonl") });
          return { ...state, files: [] };
        },
      );
      const endBytes = await this.fetchManifest();
      const endSha = sha256Hex(endBytes);
      this.state.lexicon_manifest.sha256_end = endSha;
      if (endSha !== this.manifestSha) throw new Error(`the lexicon manifest changed during the run (${this.manifestSha.slice(0, 12)}… at the start, ${endSha.slice(0, 12)}… at the end); the run record is not written`);
      this.attempt.status = "finished";
      this.attempt.ended_at = nowIso();
      this.state.status = "finished";
      this.state.finished_at = this.attempt.ended_at;
      if (this.scoped) {
        this.state.scoped_reruns = [...(this.state.scoped_reruns ?? []), this.scopeSummary()];
        this.state.scoped_rerun = null;
      }
      await this.saveState();
      const record = await buildRunRecord({ run: this, loader: loader.output, history: await loadHistory(this.loaderDir), t3: await t3Watermarks([path.join(RUNTIME_ROOT, "data", "travis", "registry"), path.join(RUNTIME_ROOT, "data", "travis", "licensing")]), diskBytes: await bytesUnder(this.runDir) });
      await atomicWrite(path.join(this.runDir, "run.json"), `${JSON.stringify(record, null, 1)}\n`);
      this.phase = "done";
      await this.progress();
      return record;
    } catch (error) {
      this.attempt.status = this.stopping ? `stopped (${this.stopSignal})` : "failed";
      this.attempt.ended_at = nowIso();
      this.attempt.error = error instanceof Error ? error.message : String(error);
      this.state.status = this.stopping ? "interrupted" : "failed";
      await this.saveState().catch(() => {});
      throw error;
    } finally {
      clearInterval(ticker);
      await this.unlock();
    }
  }
}

/**
 * The newest unfinished T5 run directory with this label (null when none).
 *
 * @param {string} runsDir - Runs root.
 * @param {string} label - Label.
 * @returns {Promise<string | null>} Run directory.
 */
export async function latestUnfinished(runsDir, label) {
  if (!existsSync(runsDir)) return null;
  const names = (await readdir(runsDir)).filter((name) => name.endsWith(`-t5-${label}`)).sort().reverse();
  for (const name of names) {
    const statePath = path.join(runsDir, name, "run-state.json");
    if (!existsSync(statePath)) continue;
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (state.status !== "finished") return path.join(runsDir, name);
  }
  return null;
}

/**
 * The newest T5 run directory with this label, finished or not (null when none).
 *
 * @param {string} runsDir - Runs root.
 * @param {string} label - Label.
 * @returns {Promise<{ dir: string, status: string } | null>} Run.
 */
export async function latestRun(runsDir, label) {
  if (!existsSync(runsDir)) return null;
  const names = (await readdir(runsDir)).filter((name) => name.endsWith(`-t5-${label}`)).sort().reverse();
  for (const name of names) {
    const statePath = path.join(runsDir, name, "run-state.json");
    if (!existsSync(statePath)) continue;
    return { dir: path.join(runsDir, name), status: JSON.parse(await readFile(statePath, "utf8")).status };
  }
  return null;
}

/** @param {string[]} argv @returns {Record<string, string | boolean>} */
export function parseFlags(argv) {
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument ${token}`);
    const name = token.slice(2);
    if (["new", "no-caffeinate", "verify", "reopen"].includes(name)) flags[name] = true;
    else {
      if (argv[index + 1] === undefined) throw new Error(`missing value for ${token}`);
      flags[name] = argv[index + 1];
      index += 1;
    }
  }
  return flags;
}

/**
 * Resolve the options (a resume reuses the ones the run started with).
 *
 * @param {Record<string, string | boolean>} flags - Flags.
 * @returns {Promise<Record<string, any>>} Options.
 */
export async function resolveOptions(flags) {
  const runsDir = path.resolve(typeof flags["runs-dir"] === "string" ? flags["runs-dir"] : path.join(RUNTIME_ROOT, "data", "travis", "runs"));
  const label = typeof flags.label === "string" ? flags.label : "full";
  if (flags.new && (flags.verify || flags.reopen || typeof flags.resume === "string")) throw new Error("--new starts a fresh run; it does not combine with --verify, --reopen or --resume");
  if (flags.verify && flags.reopen) throw new Error("--verify is read-only; it does not combine with --reopen");
  const rerunShards = typeof flags["rerun-shards"] === "string" ? flags["rerun-shards"].split(",").map((id) => id.trim()).filter(Boolean) : null;
  if (flags["rerun-shards"] !== undefined) {
    if (flags.new || flags.verify || flags.reopen) throw new Error("--rerun-shards reruns some shards of an existing run in place; it does not combine with --new, --verify or --reopen");
    if (!rerunShards || rerunShards.length === 0 || !rerunShards.every((id) => /^s\d{4}$/.test(id)) || new Set(rerunShards).size !== rerunShards.length) throw new Error("--rerun-shards takes distinct shard ids separated by commas (s0039,s0040)");
  }
  let runDir = null;
  if (typeof flags.resume === "string") runDir = flags.resume === "latest" ? await latestUnfinished(runsDir, label) : path.resolve(flags.resume);
  else if (!flags.new) runDir = (await latestRun(runsDir, label))?.dir ?? null;
  if (typeof flags.resume === "string" && !runDir) throw new Error(`no unfinished T5 run with label ${label} under ${rel(runsDir)}`);
  let savedState = null;
  if (runDir && existsSync(path.join(runDir, "run-state.json"))) savedState = JSON.parse(await readFile(path.join(runDir, "run-state.json"), "utf8"));
  const saved = savedState?.options ?? null;
  // A finished run is only verified (read-only) unless --reopen asks to rerun it in place; --verify verifies any run.
  const finished = savedState?.status === "finished";
  if (flags.verify && !savedState) throw new Error(`no T5 run with label ${label} under ${rel(runsDir)} to verify`);
  if (flags.reopen && !finished) throw new Error("--reopen applies to a finished run; an unfinished one resumes with the same command");
  const activeScope = savedState?.scoped_rerun?.active ? [...savedState.scoped_rerun.shards].sort() : null;
  if (rerunShards && !finished && !(activeScope && activeScope.join(",") === [...rerunShards].sort().join(","))) throw new Error(`--rerun-shards applies to a finished run (or resumes the scoped rerun in progress with the same shards)${savedState ? "" : `; no T5 run with label ${label} under ${rel(runsDir)}`}`);
  const mode = flags.verify ? "verify-full" : finished && !flags.reopen && !rerunShards ? "verify-quick" : "run";
  const pick = (flag, savedKey, fallback) => (typeof flags[flag] === "string" ? flags[flag] : saved?.[savedKey] ?? fallback);
  const eligibility = pick("eligibility", "eligibility", process.env[ELIGIBILITY_ENV] ?? null);
  if (!eligibility) throw new Error(`--eligibility is required (${ELIGIBILITY_ENV}): __ALL__ for the full run (decisions.md 25.9)`);
  process.env[ELIGIBILITY_ENV] = eligibility;
  const cli = pick("cli", "cli", null);
  if (!cli) throw new Error("--cli <path to elephant-cli> is required");
  const seedPath = path.resolve(RUNTIME_ROOT, pick("seed", "seed", rel(DEFAULT_SEED)));
  const options = {
    runsDir,
    label,
    seedPath,
    cli: path.resolve(cli),
    eligibility,
    shardSize: Number(pick("shard-size", "shard_size", DEFAULT_SHARD_SIZE)),
    concurrency: Number(pick("concurrency", "concurrency", DEFAULT_CONCURRENCY)),
    maxShards: (() => {
      const value = pick("max-shards", "max_shards", null);
      return value === null || value === undefined ? null : Number(value);
    })(),
    loaderScope: pick("loader-scope", "loader_scope", label),
    loaderRoot: path.resolve(typeof flags["loader-root"] === "string" ? flags["loader-root"] : DEFAULT_LOADER_ROOT),
    manifestFile: pick("manifest", "manifest_file", null),
    captureDir: (() => {
      const value = pick("capture", "capture", null);
      return value ? path.resolve(RUNTIME_ROOT, value) : null;
    })(),
    tcadExtrasDir: path.resolve(RUNTIME_ROOT, pick("tcad-extras", "tcad_extras", rel(DEFAULT_TCAD_EXTRAS_DIR))),
    tcadListingDir: (() => {
      const value = pick("tcad-listing", "tcad_listing", null);
      return value ? path.resolve(RUNTIME_ROOT, value) : null;
    })(),
    tcadListingReceipts: (() => {
      const value = pick("tcad-listing-receipts", "tcad_listing_receipts", null);
      return value ? path.resolve(RUNTIME_ROOT, value) : null;
    })(),
    rollSeed: path.resolve(RUNTIME_ROOT, pick("roll-seed", "roll_seed", rel(DEFAULT_SEED))),
    progressIntervalMs: Number(typeof flags["progress-seconds"] === "string" ? flags["progress-seconds"] : 60) * 1000,
    noCaffeinate: flags["no-caffeinate"] === true,
    mode,
    reopen: flags.reopen === true || Boolean(rerunShards),
    rerunShards: rerunShards ? [...rerunShards].sort() : null,
  };
  if (!Number.isInteger(options.shardSize) || options.shardSize < 1 || options.shardSize > DEFAULT_SHARD_SIZE) throw new Error(`--shard-size must be 1-${DEFAULT_SHARD_SIZE} (the kit's CAR cap)`);
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error("--concurrency must be a positive integer");
  options.runDir = runDir ?? path.join(runsDir, `${compactTimestamp(new Date())}-t5-${label}`);
  return options;
}

async function main() {
  let options = null;
  let code = 0;
  try {
    options = await resolveOptions(parseFlags(process.argv.slice(2)));
    const run = new T5Run(options);
    if (options.mode !== "run") {
      if (options.mode === "verify-quick") console.log(`[t5] ${rel(options.runDir)} is finished: checking it read-only (no stage runs, nothing is written). --verify also re-hashes every output; --new starts a new run.`);
      const report = await run.verify({ full: options.mode === "verify-full" });
      console.log(JSON.stringify(report));
      code = report.status === "verified" ? 0 : 3;
    } else {
      if (options.rerunShards) console.log(`[t5] scoped rerun of ${options.rerunShards.join(", ")} in ${rel(options.runDir)} (--rerun-shards): those shards rerun the stages whose inputs changed, every other shard is re-certified (never recomputed) or the run stops, and run.json is rewritten with a new attempt`);
      else if (options.reopen) console.log(`[t5] reopening finished run ${rel(options.runDir)} (--reopen): stages whose inputs changed rerun and run.json is rewritten with a new attempt`);
      const record = await run.run();
      const county = record.counts.appraisal;
      console.log(
        JSON.stringify({
          travis_t5_run: record.run_id,
          status: "finished",
          seed: county.seed,
          ready: county.ready,
          dead: county.dead,
          invalid: county.invalid,
          reconciles: county.reconciles,
          shards: record.shards.total,
          cars: record.cars.length,
          permits_published: record.counts.permits.published,
          roof_age_eligible: record.roof_age.eligible,
          wall_h: round(record.timings.wall_ms / 3_600_000, 2),
          last_attempt_h: round(record.timings.last_attempt_ms / 3_600_000, 2),
          ...(record.scoped_reruns?.length ? { scoped_rerun: { shards: record.scoped_reruns.at(-1).shards, recertified: record.scoped_reruns.at(-1).recertified } } : {}),
          run_record: rel(path.join(options.runDir, "run.json")),
        }),
      );
      console.log(`[t5] done: ${rel(path.join(options.runDir, "run.json"))}`);
    }
  } catch (error) {
    console.error(`[t5] ${error instanceof Error ? error.message : String(error)}`);
    if (options?.runDir && options.mode === "run") console.error(`[t5] run directory ${rel(options.runDir)}; to resume, run the same command again`);
    code = error?.exitCode ?? 1;
  }
  // Exit explicitly (decisions.md section 27): nothing may keep a finished runner alive.
  await exitProcess(code);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
