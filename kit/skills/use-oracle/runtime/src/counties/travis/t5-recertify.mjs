/**
 * T5 scoped rerun: re-certification of the stages a code change cannot reach (assignment decisions.md 27.9 option A,
 * ruled 2026-10-19). `t5-run.mjs --rerun-shards <ids>` reruns the named shards of a finished run in place; every other
 * shard keeps its outputs, and each of its markers whose input changed only through the code digest is re-certified:
 * rewritten with the new input and a `recertified` entry that keeps the old input digest, the code digests before and
 * after, the proof of every changed file and the shard facts that make the change unreachable. Nothing is assumed:
 *
 * - **Text proofs** (once per run): every file of the stage's code that differs from the run's kit commit must have a
 *   registered proof, and the proof must hold on the two texts ({@link CODE_CHANGE_PROOFS}):
 *   - `validate.mjs`, `validation_box_widened`: the only change is `TRAVIS_VALIDATION_BBOX` (its declaration and doc
 *     comment), and the new box contains the old one, so the guard refuses a subset of what it refused;
 *   - `transform.mjs`, `situs_columns_branch`: the file is the run's plus the blocks delimited by the
 *     `travis-situs-columns-v1` marker lines and one guard condition that gains `&& situsShift === null`; for a row with a
 *     situs street, `situsShift` is null, so the guard and the sidecar are the run's;
 *   - `t5-run.mjs`, `link_stage_unchanged`: the plan and link stages' text is the run's, byte for byte.
 * - **Shard facts** (per shard, from its own markers and seed): `validation_box_widened` needs no refusal by the guard in
 *   the shard (no dead account with the bbox evidence; no permits-stage failure), since a widened box changes a verdict
 *   only where the old one refused; `situs_columns_branch` needs every blank-street seed row of the shard to be a dead
 *   account with the run's evidence and to fail the shifted-columns pattern, so the new code throws the same error.
 * - **Outputs**: the marker's outputs are re-hashed (and for the appraisal and permits stages every parcel's `data/` and
 *   permit directory digest is recomputed and compared), so a re-certified stage keeps exactly what it wrote.
 *
 * Any other difference (an input other than the code, a file without a proof, a proof that fails, a shard fact that
 * fails) refuses the re-certification and stops the run with the shard to add to `--rerun-shards`.
 *
 * @module counties/travis/t5-recertify
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseCsvRecords } from "../../core/csv.mjs";
import { readShiftedSitusColumns, text as fieldText } from "../../../counties/travis/transforms/transform.mjs";
import { materializeParcelInput } from "./adapter.mjs";
import { RUNTIME_ROOT } from "./t3-snapshot.mjs";
import { atomicWrite, checkMarker, dataDirDigest, digestOf, markerPath, sha256Hex } from "./t5-shards.mjs";

export const RECERTIFY_VERSION = "travis-t5-recertify.v1";
export const GUARD_REFUSAL = /outside the Travis bbox/;
export const NO_SITUS = /^no situs address: the roll prints no situs street for this account$/;

/** The validation box declaration with its doc comment (the only text `validation_box_widened` lets change). */
const BOX_DECLARATION = /(\/\*\*(?:(?!\*\/)[\s\S])*\*\/\n)?export const TRAVIS_VALIDATION_BBOX = Object\.freeze\(\{\s*minLat: (-?[\d.]+),\s*maxLat: (-?[\d.]+),\s*minLng: (-?[\d.]+),\s*maxLng: (-?[\d.]+),?\s*\}\);/;

/**
 * `validate.mjs`: only the box changed, and it widened.
 *
 * @param {string} before - The file at the run's commit.
 * @param {string} now - The file now.
 * @returns {{ holds: boolean, detail: string, before_box?: Record<string, number>, now_box?: Record<string, number> }} Proof.
 */
export function proveValidationBoxWidened(before, now) {
  const a = BOX_DECLARATION.exec(before);
  const b = BOX_DECLARATION.exec(now);
  if (!a || !b) return { holds: false, detail: "TRAVIS_VALIDATION_BBOX is not declared as a frozen min/max box in both versions" };
  const box = (match) => ({ minLat: Number(match[2]), maxLat: Number(match[3]), minLng: Number(match[4]), maxLng: Number(match[5]) });
  const old = box(a);
  const wide = box(b);
  const contains = wide.minLat <= old.minLat && wide.maxLat >= old.maxLat && wide.minLng <= old.minLng && wide.maxLng >= old.maxLng;
  const restUnchanged = before.replace(BOX_DECLARATION, "<box>") === now.replace(BOX_DECLARATION, "<box>");
  const holds = contains && restUnchanged;
  const detail = holds
    ? `only TRAVIS_VALIDATION_BBOX changed (${old.minLat}-${old.maxLat} N, ${old.minLng} to ${old.maxLng} W became ${wide.minLat}-${wide.maxLat} N, ${wide.minLng} to ${wide.maxLng} W) and the new box contains the old one: the guard refuses a subset of what it refused`
    : !contains
      ? "the new box does not contain the old one"
      : "validate.mjs changed outside the box declaration";
  return { holds, detail, before_box: old, now_box: wide };
}

export const SITUS_BLOCK_OPEN = /\/\/ \[travis-situs-columns-v1\b/;
export const SITUS_BLOCK_CLOSE = /\/\/ travis-situs-columns-v1\]/;
export const SITUS_GUARD = Object.freeze({ now: "  if (text(tcad.situs_street) === null && situsShift === null) {", before: "  if (text(tcad.situs_street) === null) {" });

/**
 * `transform.mjs`: the run's text plus the delimited situs-columns blocks and the one guard condition.
 *
 * @param {string} before - The file at the run's commit.
 * @param {string} now - The file now.
 * @returns {{ holds: boolean, detail: string, blocks?: number, lines_in_blocks?: number }} Proof.
 */
export function proveSitusColumnsBranch(before, now) {
  if (SITUS_BLOCK_OPEN.test(before)) return { holds: false, detail: "the run's transform already carries situs-columns blocks" };
  const kept = [];
  let open = false;
  let blocks = 0;
  let inBlocks = 0;
  for (const line of now.split("\n")) {
    if (!open && SITUS_BLOCK_OPEN.test(line)) {
      open = true;
      blocks += 1;
      inBlocks += 1;
      continue;
    }
    if (open) {
      inBlocks += 1;
      if (SITUS_BLOCK_CLOSE.test(line)) open = false;
      continue;
    }
    kept.push(line);
  }
  if (open) return { holds: false, detail: "a situs-columns block is not closed" };
  const rest = kept.join("\n");
  const guards = rest.split(SITUS_GUARD.now).length - 1;
  if (guards !== 1) return { holds: false, detail: `the situs guard condition appears ${guards} times outside the blocks, expected once` };
  const holds = rest.replace(SITUS_GUARD.now, SITUS_GUARD.before) === before;
  return {
    holds,
    detail: holds
      ? `the run's transform plus ${blocks} delimited blocks (${inBlocks} lines) and one guard condition that gains "&& situsShift === null"; situsShift is computed only for a blank situs street, so for every row with a street the guard, the output and the sidecar are the run's`
      : "transform.mjs changed outside the situs-columns blocks and the guard condition",
    blocks,
    lines_in_blocks: inBlocks,
  };
}

/**
 * `t5-run.mjs` (in the link stage's code): the plan and link stages are the run's (the text from `// Plan.` to
 * `this.link = linkMarker.output;`: the plan stage, the capture and listing it reads, the link input and the link task).
 *
 * @param {string} before - The file at the run's commit.
 * @param {string} now - The file now.
 * @returns {{ holds: boolean, detail: string }} Proof.
 */
export function proveLinkStageUnchanged(before, now) {
  const block = (source) => {
    const start = source.indexOf(LINK_BLOCK_START);
    const end = start < 0 ? -1 : source.indexOf(LINK_BLOCK_END, start);
    return start >= 0 && end > start ? source.slice(start, end) : null;
  };
  const a = block(before);
  const b = block(now);
  const holds = a !== null && a === b;
  return { holds, detail: holds ? `the plan and link stages (from "// Plan." to "this.link = linkMarker.output", ${a.length} characters) are the run's byte for byte; the rest of t5-run.mjs is the runner around the stages, not the link pass` : "the plan and link stages differ from the run's (or are not found)" };
}

export const LINK_BLOCK_START = "    // Plan.\n";
export const LINK_BLOCK_END = "    this.link = linkMarker.output;";

/** The code changes a scoped rerun may re-certify a stage across: file to its proof (the stages each touches come from `STAGE_CODE`). */
export const CODE_CHANGE_PROOFS = Object.freeze({
  "src/counties/travis/validate.mjs": Object.freeze({ proof: "validation_box_widened", check: proveValidationBoxWidened }),
  "counties/travis/transforms/transform.mjs": Object.freeze({ proof: "situs_columns_branch", check: proveSitusColumnsBranch }),
  "src/counties/travis/t5-run.mjs": Object.freeze({ proof: "link_stage_unchanged", check: proveLinkStageUnchanged }),
});

/** @param {string[]} args @returns {Promise<Buffer | null>} */
const git = (args) => new Promise((resolve) => execFile("git", ["-C", RUNTIME_ROOT, ...args], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : stdout)));

/**
 * Every file of every stage's code that differs between the run's kit commit and the working tree, each with its proof.
 *
 * @param {{ commit: string, stageCode: Record<string, string[]>, readAtCommit?: (file: string) => Promise<Buffer | null>, readNow?: (file: string) => Promise<Buffer> }} options - The run's commit and `STAGE_CODE`.
 * @returns {Promise<{ commit: string, files: Record<string, { stages: string[], at_run_sha256: string | null, now_sha256: string, proof: string | null, holds: boolean, detail: string }>, stages: Record<string, string[]> }>} Changes.
 */
export async function codeChanges({ commit, stageCode, readAtCommit = (file) => git(["show", `${commit}:./${file}`]), readNow = (file) => readFile(path.join(RUNTIME_ROOT, file)) }) {
  const files = {};
  const stages = {};
  for (const [stage, list] of Object.entries(stageCode)) {
    stages[stage] = [];
    for (const file of list) {
      if (!files[file]) {
        const before = await readAtCommit(file);
        const now = await readNow(file);
        const atRun = before ? sha256Hex(before) : null;
        const nowSha = sha256Hex(now);
        if (atRun === nowSha) files[file] = { stages: [], at_run_sha256: atRun, now_sha256: nowSha, proof: null, holds: true, detail: "unchanged" };
        else {
          const registered = CODE_CHANGE_PROOFS[file];
          const result = !before ? { holds: false, detail: `${file} is not in kit ${commit}` } : registered ? registered.check(before.toString("utf8"), now.toString("utf8")) : { holds: false, detail: "no registered proof for a change to this file" };
          files[file] = { stages: [], at_run_sha256: atRun, now_sha256: nowSha, proof: registered?.proof ?? null, ...result };
        }
      }
      if (files[file].at_run_sha256 !== files[file].now_sha256) {
        files[file].stages.push(stage);
        stages[stage].push(file);
      }
    }
  }
  return { commit, files, stages };
}

/**
 * The shard facts a proof needs before it re-certifies one stage of one shard.
 *
 * @param {{ proof: string, stage: string, dir: string, marker: Record<string, any>, appraisalMarker?: Record<string, any> | null }} options - What to check.
 * @returns {Promise<{ holds: boolean, detail: string, facts?: Record<string, any> }>} Verdict.
 */
export async function shardFacts({ proof, stage, dir, marker, appraisalMarker = null }) {
  if (proof === "link_stage_unchanged") return { holds: stage === "link", detail: stage === "link" ? "the link stage reads no shard" : `link_stage_unchanged does not cover stage ${stage}` };
  if (proof === "validation_box_widened") {
    if (stage === "appraisal") {
      const refused = (marker.output?.dead ?? []).filter((item) => GUARD_REFUSAL.test(String(item.evidence ?? "")));
      return { holds: refused.length === 0, detail: refused.length === 0 ? "the guard refused no parcel of this shard, so a wider box changes no verdict" : `the guard refused ${refused.map((item) => item.key).join(", ")} here: rerun this shard`, facts: { guard_refusals: refused.length } };
    }
    if (stage === "permits") {
      const failed = marker.output?.counts?.failed_permanent ?? null;
      return { holds: failed === 0 && (marker.output?.failures ?? []).length === 0, detail: failed === 0 ? "no permit group of this shard failed a check, so a wider box changes no verdict" : `${failed} permit group(s) failed here: rerun this shard`, facts: { failed_permanent: failed } };
    }
    return { holds: false, detail: `validation_box_widened does not cover stage ${stage}` };
  }
  if (proof === "situs_columns_branch") {
    if (stage !== "appraisal") return { holds: false, detail: `situs_columns_branch does not cover stage ${stage}` };
    const dead = new Map((marker.output?.dead ?? []).map((item) => [String(item.key), String(item.evidence ?? "")]));
    const rows = parseCsvRecords(await readFile(path.join(dir, "seed.csv"), "utf8"));
    const problems = [];
    let blank = 0;
    for (const row of rows) {
      let tcad;
      try {
        tcad = materializeParcelInput(row).tcad;
      } catch {
        continue; // the adapter (unchanged) refuses such a row before the transform, as it did in the run
      }
      if (fieldText(tcad.situs_street) !== null) continue;
      blank += 1;
      const key = String(row.parcel_id).trim();
      if (readShiftedSitusColumns(tcad) !== null) problems.push(`${key} matches the shifted-columns pattern`);
      else if (!NO_SITUS.test(dead.get(key) ?? "")) problems.push(`${key} has a blank street but is not dead with the no-situs evidence`);
    }
    const holds = problems.length === 0;
    return { holds, detail: holds ? `${blank} blank-street row(s), each dead with the run's evidence and none in the shifted-columns pattern: the new code throws the same error for each` : `${problems.slice(0, 3).join("; ")}: rerun this shard`, facts: { seed_rows: rows.length, blank_street_rows: blank, shifted_pattern_rows: problems.filter((item) => /matches/.test(item)).length } };
  }
  return { holds: false, detail: `unknown proof ${proof}` };
}

/**
 * Re-hash what a stage wrote: its marker's files, and for `appraisal` and `permits` every parcel directory's digest.
 *
 * @param {{ dir: string, stage: string, marker: Record<string, any>, appraisalMarker?: Record<string, any> | null }} options - Stage.
 * @returns {Promise<{ ok: boolean, detail: string, parcels?: number }>} Verdict.
 */
export async function verifyOutputs({ dir, stage, marker, appraisalMarker = null }) {
  const check = await checkMarker(dir, stage, marker.input);
  if (!check.valid) return { ok: false, detail: `the marker no longer matches its own outputs: ${check.reason}` };
  if (stage === "appraisal") {
    const base = path.join(dir, marker.output.dir);
    for (const [key, digest] of Object.entries(marker.output.parcels ?? {})) {
      const dataDir = path.join(base, key, "data");
      if (!existsSync(dataDir) || (await dataDirDigest(dataDir)) !== digest) return { ok: false, detail: `${key}: data/ differs from the marker` };
    }
    return { ok: true, detail: "every parcel's data/ digest equals the marker", parcels: Object.keys(marker.output.parcels ?? {}).length };
  }
  if (stage === "permits") {
    const base = path.join(dir, appraisalMarker?.output?.dir ?? "");
    let parcels = 0;
    for (const [key, state] of Object.entries(marker.output.states ?? {})) {
      if (state.status !== "done") continue;
      const permitDir = path.join(base, key, marker.output.data_dir);
      if (!existsSync(permitDir) || (await dataDirDigest(permitDir)) !== state.artifact_hash) return { ok: false, detail: `${key}: ${marker.output.data_dir} differs from the marker` };
      parcels += 1;
    }
    return { ok: true, detail: "every permit group's digest equals the marker", parcels };
  }
  return { ok: true, detail: "every output file equals the marker" };
}

/**
 * Re-certify one stage, or explain why not (throws). Writes the marker atomically; never touches an output.
 *
 * @param {object} options - Options.
 * @param {string} options.dir - Shard (or global) directory.
 * @param {string} options.stage - Stage name.
 * @param {Record<string, any>} options.input - The stage's input now.
 * @param {Record<string, any>} options.marker - Its marker (input changed).
 * @param {string} options.codeStage - The `STAGE_CODE` entry of the stage (`appraisal`, `permits`, `link`, ...).
 * @param {string} options.codeAtRun - That code's digest at the run's kit commit.
 * @param {Awaited<ReturnType<typeof codeChanges>>} options.changes - The run's code changes.
 * @param {number} options.attempt - The run attempt re-certifying.
 * @param {string} options.label - Shard id or `global` (for messages).
 * @param {Record<string, any> | null} [options.appraisalMarker] - The shard's appraisal marker (for `permits`).
 * @returns {Promise<Record<string, any>>} The re-certified marker.
 */
export async function recertifyStage({ dir, stage, input, marker, codeStage, codeAtRun, changes, attempt, label, appraisalMarker = null }) {
  const refuse = (why) => {
    throw Object.assign(new Error(`${label} ${stage}: not re-certified (${why}); rerun it with --rerun-shards`), { recertifyRefused: true });
  };
  if (!marker?.input) refuse("its marker records no input");
  const keys = [...new Set([...Object.keys(marker.input), ...Object.keys(input)])];
  const otherKeys = keys.filter((key) => key !== "code" && digestOf(marker.input[key] ?? null) !== digestOf(input[key] ?? null));
  if (otherKeys.length > 0) refuse(`its input changed in ${otherKeys.join(", ")}, not only in its code`);
  if (marker.input.code !== codeAtRun) refuse(`it ran code ${String(marker.input.code).slice(0, 12)}…, not the run's kit ${changes.commit} code ${codeAtRun.slice(0, 12)}…`);
  const files = changes.stages[codeStage] ?? [];
  if (files.length === 0) refuse(`its code digest changed but no file of ${codeStage} differs from kit ${changes.commit}`);
  const proofs = [];
  for (const file of files) {
    const change = changes.files[file];
    if (!change.holds) refuse(`${file}: ${change.detail}`);
    const facts = await shardFacts({ proof: change.proof, stage, dir, marker, appraisalMarker });
    if (!facts.holds) refuse(`${file} (${change.proof}): ${facts.detail}`);
    proofs.push({ file, proof: change.proof, at_run_sha256: change.at_run_sha256, now_sha256: change.now_sha256, text: change.detail, shard: facts.detail, ...(facts.facts ? { facts: facts.facts } : {}) });
  }
  const outputs = await verifyOutputs({ dir, stage, marker, appraisalMarker });
  if (!outputs.ok) refuse(outputs.detail);
  const entry = { version: RECERTIFY_VERSION, at: new Date().toISOString(), attempt, from_input_digest: marker.input_digest, from_code: marker.input.code, to_code: input.code, kit_commit_at_run: changes.commit, proofs, outputs: outputs.detail, ...(outputs.parcels !== undefined ? { parcels_rehashed: outputs.parcels } : {}) };
  const next = { ...marker, input, input_digest: digestOf(input), recertified: [...(marker.recertified ?? []), entry] };
  await atomicWrite(markerPath(dir, stage), `${JSON.stringify(next, null, 1)}\n`);
  return next;
}

/**
 * Compare a rerun stage's output with the run's (the scoped rerun's own evidence that the new code changes nothing it
 * was not meant to): `appraisal` per parcel (`data/` digest and sidecar bytes), `permits` per parcel state.
 *
 * @param {{ dir: string, stage: string, before: Record<string, any>, after: Record<string, any> }} options - The two markers.
 * @returns {Promise<Record<string, any>>} Comparison (`identical` true when every earlier parcel is unchanged).
 */
export async function compareRerun({ dir, stage, before, after }) {
  if (stage === "appraisal") {
    const old = before.output.parcels ?? {};
    const now = after.output.parcels ?? {};
    const changed = [];
    let sidecarsCompared = 0;
    for (const [key, digest] of Object.entries(old)) {
      if (now[key] !== digest) {
        changed.push({ key, why: now[key] ? "data/ differs" : "no longer ready" });
        continue;
      }
      const a = path.join(dir, before.output.dir, key, "source-payload.json");
      const b = path.join(dir, after.output.dir, key, "source-payload.json");
      if (existsSync(a) || existsSync(b)) {
        sidecarsCompared += 1;
        if (!existsSync(a) || !existsSync(b) || sha256Hex(await readFile(a)) !== sha256Hex(await readFile(b))) changed.push({ key, why: "sidecar differs" });
      }
    }
    const newlyReady = Object.keys(now).filter((key) => !Object.hasOwn(old, key)).sort((x, y) => Number(x) - Number(y));
    const deadBefore = new Set((before.output.dead ?? []).map((item) => item.key));
    return { stage, previously_ready: Object.keys(old).length, unchanged: Object.keys(old).length - changed.length, sidecars_compared: sidecarsCompared, changed, newly_ready: newlyReady, newly_ready_were_dead: newlyReady.every((key) => deadBefore.has(key)), still_dead: (after.output.dead ?? []).map((item) => item.key), identical: changed.length === 0 && newlyReady.every((key) => deadBefore.has(key)) };
  }
  if (stage === "permits") {
    const old = before.output.states ?? {};
    const now = after.output.states ?? {};
    const changed = Object.keys(old).filter((key) => digestOf(old[key]) !== digestOf(now[key] ?? null));
    const added = Object.keys(now).filter((key) => !Object.hasOwn(old, key));
    return { stage, previous_states: Object.keys(old).length, unchanged: Object.keys(old).length - changed.length, changed, added: added.map((key) => ({ key, status: now[key].status })), identical: changed.length === 0 };
  }
  return { stage, identical: true };
}
