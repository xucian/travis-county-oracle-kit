#!/usr/bin/env node
/**
 * T5 pre-run fix (assignment `docs/progress.md` T5 row, oracle 2026-10-17): the TCAD export fields with a lexicon home
 * that T2 left unread, read offline from the receipted 2026 Certified Appraisal Export (no request is made; the archive's
 * size and SHA-256 are checked against `data/travis/export/download-receipts.jsonl` before anything is read).
 *
 * One pass per member, streamed with `unzip -p` (the 9.8 GB `PROP_ENT.TXT` is never held in memory), restricted to the
 * real-property accounts the seed carries, using the seed builder's own rule for an account printed with several owner
 * records (the first `R` record wins, `build-seed.mjs`), so every value belongs to the owner record the seed used:
 *
 * - `PROP.TXT`: `ten_percent_cap` (Ten Percent Homestead Cap Adjustment), `py_owner_id` and `sup_num` of that record;
 * - `PROP_ENT.TXT`: the taxable value of each taxing entity on that (prop, owner, supplement), classed by its printed
 *   name with the exact rules of {@link TAXING_ENTITY_CLASS_VERSION} (county, hospital district, college district, school
 *   district, city; everything else, special districts and reinvestment zones included, is counted and not classed);
 * - `IMP_ATR.TXT`: the printed codes of the `Roof Covering`, `Roof Style` and `Foundation` attributes, over every
 *   improvement detail of the account (the other attribute kinds are appraisal factors and are only counted);
 * - `LAND_DET.TXT`: the land segments' printed `size_acres` (four implied decimals) and `size_square_feet`, summed;
 * - `IMP_INFO.TXT`: the improvement type codes per account (inventory; no field is mapped from them).
 *
 * Output (gitignored `data/travis/tcad-extras/<version>/`): `extras.jsonl` (one line per seed account, in seed order),
 * `index.json` (the archive receipt, member sizes, counts, the entity table and the output's SHA-256). The transform maps
 * these values with exact-value tables (`counties/travis/transforms/transform.mjs`, `TCAD_EXTRAS_MAPPING_VERSION`).
 *
 *   node --max-old-space-size=8192 src/counties/travis/t5-tcad-extras.mjs [--seed data/seeds/travis.csv] [--archive <zip>] [--out <dir>]
 *
 * @module counties/travis/t5-tcad-extras
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { spawn } from "node:child_process";

import { decodePropId } from "./seed.mjs";
import { readField } from "./build-seed.mjs";
import { RUNTIME_ROOT } from "./t3-snapshot.mjs";
import { streamCsvFile } from "./t4-permit-links.mjs";

export const TCAD_EXTRAS_VERSION = "travis-tcad-extras-v1";
export const TAXING_ENTITY_CLASS_VERSION = "travis-taxing-entity-classes-v1";
export const DEFAULT_ARCHIVE = path.join(RUNTIME_ROOT, "data", "travis", "export", "2026 Certified Appraisal Export Supp 0_07182026.zip");
export const DEFAULT_RECEIPTS = path.join(RUNTIME_ROOT, "data", "travis", "export", "download-receipts.jsonl");
export const DEFAULT_SEED = path.join(RUNTIME_ROOT, "data", "seeds", "travis.csv");
export const DEFAULT_OUT_DIR = path.join(RUNTIME_ROOT, "data", "travis", "tcad-extras", TCAD_EXTRAS_VERSION);
export const EXTRAS_FILENAME = "extras.jsonl";

/** Fixed-width positions (1-based, inclusive) from `Legacy8.0.33-AppraisalExportLayout.xlsx`. */
export const PROP_EXTRA_FIELDS = Object.freeze({
  prop_type_cd: [13, 17, "text"],
  sup_num: [23, 34, "int"],
  py_owner_id: [597, 608, "int"],
  ten_percent_cap: [1931, 1945, "int"],
});
export const PROP_ENT_FIELDS = Object.freeze({
  prop_id: [1, 12, "int"],
  sup_num: [18, 29, "int"],
  owner_id: [30, 41, "int"],
  entity_cd: [54, 63, "text"],
  entity_name: [64, 113, "text"],
  taxable_val: [164, 178, "int"],
  partial_entity: [614, 614, "text"],
});
export const IMP_ATR_FIELDS = Object.freeze({
  prop_id: [1, 12, "int"],
  imprv_id: [17, 28, "int"],
  imprv_det_id: [29, 40, "int"],
  imprv_attr_desc: [53, 77, "text"],
  imprv_attr_cd: [78, 87, "text"],
});
export const LAND_DET_FIELDS = Object.freeze({
  prop_id: [1, 12, "int"],
  size_acres: [70, 83, "int"],
  size_square_feet: [84, 97, "int"],
});
export const IMP_INFO_FIELDS = Object.freeze({
  prop_id: [1, 12, "int"],
  imprv_id: [17, 28, "int"],
  imprv_type_cd: [29, 38, "text"],
  imprv_type_desc: [39, 63, "text"],
});

/** The `IMP_ATR.TXT` attribute descriptions with a lexicon home (`structure`), as printed. */
export const STRUCTURE_ATTRIBUTES = Object.freeze({ "Roof Covering": "roof_covering", "Roof Style": "roof_style", Foundation: "foundation" });

/**
 * Class of a taxing entity from its printed name ({@link TAXING_ENTITY_CLASS_VERSION}). Exact names for the three
 * countywide units; a name ending in ` ISD` is a school district; a name starting `CITY OF ` or `VILLAGE OF ` is a city.
 * Everything else (emergency services, municipal utility, water control, public improvement and road districts,
 * reinvestment zones, the appraisal district) is `other`: a property sits in several of them, and the lexicon's one
 * `special_district_taxable_value_amount` cannot hold that.
 *
 * @param {string} name - `entity_name` as printed (trimmed).
 * @returns {"county" | "hospital" | "college" | "school" | "city" | "other"} Class.
 */
export function classifyTaxingEntity(name) {
  const printed = String(name ?? "").trim().toUpperCase();
  if (printed === "TRAVIS COUNTY") return "county";
  if (printed === "TRAVIS COUNTY HEALTHCARE DISTRICT") return "hospital";
  if (printed === "AUSTIN COMM COLL DIST") return "college";
  if (/ ISD$/.test(printed)) return "school";
  if (/^(CITY|VILLAGE) OF /.test(printed)) return "city";
  return "other";
}
export const ENTITY_CLASSES = Object.freeze(["county", "hospital", "college", "school", "city"]);

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * SHA-256 of a file, streamed.
 *
 * @param {string} file - File.
 * @returns {Promise<string>} Hex digest.
 */
export async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { highWaterMark: 1 << 22 })) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Verify the archive against its download receipt (size and SHA-256), fail closed.
 *
 * @param {string} archive - Archive path.
 * @param {string} receiptsFile - `download-receipts.jsonl`.
 * @returns {Promise<{ url: string, bytes: number, sha256: string, fetched_at: string | null }>} The matching receipt.
 */
export async function verifyArchiveReceipt(archive, receiptsFile) {
  const receipts = (await readFile(receiptsFile, "utf8")).split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
  const encoded = encodeURIComponent(path.basename(archive)).replaceAll("%20", "%20");
  const receipt = receipts.find((item) => typeof item.url === "string" && (item.url.endsWith(`/${encoded}`) || decodeURIComponent(item.url).endsWith(`/${path.basename(archive)}`)));
  if (!receipt) throw new Error(`${path.basename(archive)}: no download receipt in ${path.basename(receiptsFile)}`);
  const bytes = (await stat(archive)).size;
  if (bytes !== receipt.bytes) throw new Error(`${path.basename(archive)}: ${bytes} bytes, the receipt says ${receipt.bytes}`);
  const sha256 = await sha256File(archive);
  if (sha256 !== receipt.sha256) throw new Error(`${path.basename(archive)}: SHA-256 ${sha256} differs from the receipt ${receipt.sha256}`);
  return { url: receipt.url, bytes, sha256, fetched_at: receipt.finishedAt ?? receipt.fetched_at ?? null };
}

/**
 * Stream the lines of one export member through `unzip -p` (or from an extracted directory) with backpressure: chunks
 * are read with the stream's own async iterator and split here, so memory stays bounded however large the member is
 * (`readline`'s iterator queues lines faster than they are consumed on the 9.8 GB `PROP_ENT.TXT`).
 *
 * @param {{ exportDir?: string | null, exportArchive?: string | null, member: string }} options - Sources.
 * @returns {AsyncGenerator<string>} Lines without terminators (latin-1), empty lines skipped.
 */
export async function* streamMemberLines({ exportDir = null, exportArchive = null, member }) {
  const direct = exportDir ? path.join(exportDir, member) : null;
  let input;
  let child = null;
  let stderr = "";
  if (direct && existsSync(direct)) input = createReadStream(direct, { highWaterMark: 1 << 20 });
  else if (exportArchive && existsSync(exportArchive)) {
    child = spawn("unzip", ["-p", exportArchive, member], { stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    input = child.stdout;
  } else throw new Error(`${member}: not found under ${exportDir ?? "(no directory)"} and no readable archive`);
  const exited = child ? new Promise((resolve) => child.on("close", (code) => resolve(code))) : Promise.resolve(0);
  let rest = "";
  let finished = false;
  try {
    for await (const chunk of input) {
      const text = rest + chunk.toString("latin1");
      const lines = text.split("\n");
      rest = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (line.length > 0) yield line;
      }
    }
    if (rest.length > 0) yield rest.endsWith("\r") ? rest.slice(0, -1) : rest;
    finished = true;
  } finally {
    if (!finished) {
      if (child) child.kill();
      else input.destroy();
    }
  }
  const code = await exited;
  if (code !== 0) throw new Error(`unzip -p ${member} exited ${code}: ${stderr.trim().slice(0, 300)}`);
}

/**
 * An interned, flat copy of a short string read from a line. A substring of a chunk is a V8 sliced string that keeps
 * the whole chunk alive; a code kept per account must not pin the 9.8 GB `PROP_ENT.TXT` in memory.
 */
const interned = new Map();
const intern = (value) => {
  const known = interned.get(value);
  if (known !== undefined) return known;
  const flat = Buffer.from(value, "latin1").toString("latin1");
  interned.set(flat, flat);
  return flat;
};

/** @param {Record<string, number>} counts @param {string} key */
const bump = (counts, key, by = 1) => {
  counts[key] = (counts[key] ?? 0) + by;
};

/**
 * Build the extras index.
 *
 * @param {object} options - Options.
 * @param {string} [options.seedPath] - Seed CSV (its PROP_IDs are the accounts kept).
 * @param {string} [options.archive] - Export archive.
 * @param {string} [options.receipts] - Download receipts.
 * @param {string} [options.exportDir] - A directory of extracted members (tests; read before the archive).
 * @param {string} [options.outDir] - Output directory.
 * @param {boolean} [options.skipReceipt] - Skip the receipt check (tests only).
 * @returns {Promise<Record<string, any>>} The index (also written as `index.json`).
 */
export async function buildTcadExtras({ seedPath = DEFAULT_SEED, archive = DEFAULT_ARCHIVE, receipts = DEFAULT_RECEIPTS, exportDir = null, outDir = DEFAULT_OUT_DIR, skipReceipt = false } = {}) {
  const started = performance.now();
  const receipt = skipReceipt ? null : await verifyArchiveReceipt(archive, receipts);
  const timings = {};
  const time = async (stage, task) => {
    const stageStarted = performance.now();
    const result = await task();
    timings[stage] = Math.round(performance.now() - stageStarted);
    return result;
  };
  const source = { exportDir, exportArchive: archive };

  // The seed's accounts, in seed order.
  /** @type {string[]} */
  const order = [];
  /** @type {Map<string, any>} */
  const accounts = new Map();
  await time("seed", async () => {
    for await (const row of streamCsvFile(seedPath, { columns: ["parcel_id"] })) {
      const propId = row.parcel_id.trim();
      order.push(propId);
      accounts.set(propId, {
        prop_id: propId,
        prop: null,
        entities: { classes: {}, other: 0, conflicting: [] },
        imp_atr: { roof_covering: [], roof_style: [], foundation: [], other_attributes: 0 },
        land: { segments: 0, size_acres_4dp: 0, size_square_feet: 0 },
        imp_info: { improvements: 0, types: [] },
      });
    }
  });

  // PROP.TXT: the first R record of each seed account.
  const propCounts = { records: 0, real: 0, first_records: 0, later_owner_records: 0, not_in_seed: 0, ten_percent_cap_positive: 0 };
  await time("prop", async () => {
    for await (const line of streamMemberLines({ ...source, member: "PROP.TXT" })) {
      propCounts.records += 1;
      if (readField(line, PROP_EXTRA_FIELDS.prop_type_cd) !== "R") continue;
      propCounts.real += 1;
      const propId = decodePropId(line.slice(0, 12));
      const account = propId ? accounts.get(propId) : undefined;
      if (!account) {
        propCounts.not_in_seed += 1;
        continue;
      }
      if (account.prop) {
        propCounts.later_owner_records += 1;
        continue;
      }
      propCounts.first_records += 1;
      const cap = readField(line, PROP_EXTRA_FIELDS.ten_percent_cap);
      if (Number(cap) > 0) propCounts.ten_percent_cap_positive += 1;
      account.prop = { sup_num: intern(readField(line, PROP_EXTRA_FIELDS.sup_num)), owner_id: intern(readField(line, PROP_EXTRA_FIELDS.py_owner_id)), ten_percent_cap: intern(cap) };
    }
  });

  // PROP_ENT.TXT: the entity rows of that (prop, owner, supplement).
  /** @type {Map<string, { entity_cd: string, entity_name: string, class: string, rows: number, partial_rows: number }>} */
  const entityTable = new Map();
  const entCounts = { records: 0, matched: 0, other_owner_or_supplement: 0, not_in_seed: 0, by_class: {} };
  await time("prop_ent", async () => {
    for await (const line of streamMemberLines({ ...source, member: "PROP_ENT.TXT" })) {
      entCounts.records += 1;
      const propId = decodePropId(line.slice(0, 12));
      const account = propId ? accounts.get(propId) : undefined;
      if (!account || !account.prop) {
        entCounts.not_in_seed += 1;
        continue;
      }
      if (readField(line, PROP_ENT_FIELDS.owner_id) !== account.prop.owner_id || readField(line, PROP_ENT_FIELDS.sup_num) !== account.prop.sup_num) {
        entCounts.other_owner_or_supplement += 1;
        continue;
      }
      entCounts.matched += 1;
      const entityCd = intern(readField(line, PROP_ENT_FIELDS.entity_cd));
      const entityName = intern(readField(line, PROP_ENT_FIELDS.entity_name));
      const entityClass = classifyTaxingEntity(entityName);
      const key = `${entityCd}|${entityName}`;
      const table = entityTable.get(key) ?? entityTable.set(key, { entity_cd: entityCd, entity_name: entityName, class: entityClass, rows: 0, partial_rows: 0 }).get(key);
      table.rows += 1;
      const partial = readField(line, PROP_ENT_FIELDS.partial_entity) === "T";
      if (partial) table.partial_rows += 1;
      bump(entCounts.by_class, entityClass);
      if (entityClass === "other") {
        account.entities.other += 1;
        continue;
      }
      const entry = { entity_cd: entityCd, entity_name: entityName, taxable_val: intern(readField(line, PROP_ENT_FIELDS.taxable_val)), partial_entity: partial };
      const list = account.entities.classes[entityClass] ?? (account.entities.classes[entityClass] = []);
      list.push(entry);
    }
  });

  // IMP_ATR.TXT: the three attribute kinds with a lexicon home.
  const atrCounts = { records: 0, matched: 0, not_in_seed: 0, by_description: {} };
  await time("imp_atr", async () => {
    for await (const line of streamMemberLines({ ...source, member: "IMP_ATR.TXT" })) {
      atrCounts.records += 1;
      const propId = decodePropId(line.slice(0, 12));
      const account = propId ? accounts.get(propId) : undefined;
      const description = intern(readField(line, IMP_ATR_FIELDS.imprv_attr_desc));
      bump(atrCounts.by_description, description);
      if (!account) {
        atrCounts.not_in_seed += 1;
        continue;
      }
      atrCounts.matched += 1;
      const kind = STRUCTURE_ATTRIBUTES[description];
      if (!kind) {
        account.imp_atr.other_attributes += 1;
        continue;
      }
      const code = intern(readField(line, IMP_ATR_FIELDS.imprv_attr_cd));
      if (!account.imp_atr[kind].includes(code)) account.imp_atr[kind].push(code);
    }
  });

  // LAND_DET.TXT: segment sizes.
  const landCounts = { records: 0, matched: 0, not_in_seed: 0 };
  await time("land_det", async () => {
    for await (const line of streamMemberLines({ ...source, member: "LAND_DET.TXT" })) {
      landCounts.records += 1;
      const propId = decodePropId(line.slice(0, 12));
      const account = propId ? accounts.get(propId) : undefined;
      if (!account) {
        landCounts.not_in_seed += 1;
        continue;
      }
      landCounts.matched += 1;
      account.land.segments += 1;
      account.land.size_acres_4dp += Number(readField(line, LAND_DET_FIELDS.size_acres) || "0");
      account.land.size_square_feet += Number(readField(line, LAND_DET_FIELDS.size_square_feet) || "0");
    }
  });

  // IMP_INFO.TXT: improvement types (inventory only).
  const infoCounts = { records: 0, matched: 0, not_in_seed: 0, by_type: {} };
  await time("imp_info", async () => {
    for await (const line of streamMemberLines({ ...source, member: "IMP_INFO.TXT" })) {
      infoCounts.records += 1;
      const propId = decodePropId(line.slice(0, 12));
      const account = propId ? accounts.get(propId) : undefined;
      const type = intern(`${readField(line, IMP_INFO_FIELDS.imprv_type_cd)}|${readField(line, IMP_INFO_FIELDS.imprv_type_desc)}`);
      bump(infoCounts.by_type, type);
      if (!account) {
        infoCounts.not_in_seed += 1;
        continue;
      }
      infoCounts.matched += 1;
      account.imp_info.improvements += 1;
      const code = intern(readField(line, IMP_INFO_FIELDS.imprv_type_cd));
      if (!account.imp_info.types.includes(code)) account.imp_info.types.push(code);
    }
  });

  // Write in seed order; sort the code lists so a line is a function of the archive alone.
  await mkdir(outDir, { recursive: true });
  const target = path.join(outDir, EXTRAS_FILENAME);
  const partial = `${target}.partial`;
  const out = createWriteStream(partial);
  const hash = createHash("sha256");
  const presence = {
    accounts: 0,
    without_prop_record: 0,
    roof_covering: { one_code: 0, several_codes: 0, none: 0 },
    roof_style: { one_code: 0, several_codes: 0, none: 0 },
    foundation: { one_code: 0, several_codes: 0, none: 0 },
    land_segments: { none: 0, one: 0, several: 0 },
    entity_class_on_account: Object.fromEntries(ENTITY_CLASSES.map((name) => [name, { none: 0, one: 0, several: 0 }])),
  };
  await time("write", async () => {
    for (const propId of order) {
      const account = accounts.get(propId);
      presence.accounts += 1;
      if (!account.prop) presence.without_prop_record += 1;
      for (const kind of ["roof_covering", "roof_style", "foundation"]) {
        account.imp_atr[kind].sort();
        const n = account.imp_atr[kind].length;
        presence[kind][n === 0 ? "none" : n === 1 ? "one_code" : "several_codes"] += 1;
      }
      account.imp_info.types.sort();
      presence.land_segments[account.land.segments === 0 ? "none" : account.land.segments === 1 ? "one" : "several"] += 1;
      for (const name of ENTITY_CLASSES) {
        const n = account.entities.classes[name]?.length ?? 0;
        presence.entity_class_on_account[name][n === 0 ? "none" : n === 1 ? "one" : "several"] += 1;
      }
      const line = `${JSON.stringify(account)}\n`;
      hash.update(line);
      if (!out.write(line)) await new Promise((resolve) => out.once("drain", resolve));
    }
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve(undefined))));
  });
  await rename(partial, target);
  const index = {
    schemaVersion: "travis.tcad-extras-index.v1",
    version: TCAD_EXTRAS_VERSION,
    taxing_entity_class_version: TAXING_ENTITY_CLASS_VERSION,
    built_at: new Date().toISOString(),
    source: receipt ? { archive: path.relative(RUNTIME_ROOT, archive).split(path.sep).join("/"), ...receipt, receipt_checked: true } : { archive: exportDir ?? archive, receipt_checked: false },
    seed: { path: path.relative(RUNTIME_ROOT, path.resolve(seedPath)).split(path.sep).join("/"), sha256: await sha256File(seedPath), rows: order.length },
    rule: "the first R record of an account printed with several owner records wins (build-seed.mjs); PROP_ENT rows of that record's owner and supplement only",
    counts: { prop: propCounts, prop_ent: entCounts, imp_atr: atrCounts, land_det: landCounts, imp_info: infoCounts },
    presence,
    taxing_entities: [...entityTable.values()].sort((left, right) => right.rows - left.rows || left.entity_cd.localeCompare(right.entity_cd)),
    imp_info_types: Object.entries(infoCounts.by_type).sort((left, right) => right[1] - left[1]).map(([type, rows]) => ({ type, rows })),
    output: { file: path.relative(RUNTIME_ROOT, target).split(path.sep).join("/"), sha256: hash.digest("hex"), lines: order.length },
    timings_ms: { ...timings, total: Math.round(performance.now() - started) },
  };
  delete index.counts.imp_info.by_type;
  await writeFile(path.join(outDir, "index.json"), `${JSON.stringify(index, null, 1)}\n`);
  return index;
}

/**
 * Read the extras of some accounts (all when `propIds` is null), checking the file against its index.
 *
 * @param {{ dir?: string, propIds?: Set<string> | null, verify?: boolean }} [options] - Directory, accounts wanted, digest check.
 * @returns {Promise<{ index: Record<string, any>, byPropId: Map<string, any> }>} Index and the extras by PROP_ID.
 */
export async function readTcadExtras({ dir = DEFAULT_OUT_DIR, propIds = null, verify = true } = {}) {
  const indexPath = path.join(dir, "index.json");
  if (!existsSync(indexPath)) throw new Error(`no TCAD extras index at ${path.relative(RUNTIME_ROOT, indexPath)}; run node src/counties/travis/t5-tcad-extras.mjs first`);
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  if (index.version !== TCAD_EXTRAS_VERSION) throw new Error(`TCAD extras ${index.version} is not ${TCAD_EXTRAS_VERSION}; rebuild it`);
  const hash = createHash("sha256");
  /** @type {Map<string, any>} */
  const byPropId = new Map();
  const { createInterface } = await import("node:readline");
  const lines = createInterface({ input: createReadStream(path.join(dir, EXTRAS_FILENAME), { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line === "") continue;
    if (verify) hash.update(`${line}\n`);
    const propId = line.slice(12, line.indexOf('"', 12));
    if (propIds && !propIds.has(propId)) continue;
    byPropId.set(propId, JSON.parse(line));
  }
  if (verify && hash.digest("hex") !== index.output.sha256) throw new Error(`${EXTRAS_FILENAME} no longer matches its index (sha256 ${index.output.sha256.slice(0, 12)}…); rebuild it`);
  return { index, byPropId };
}

/** @param {string[]} argv @returns {Record<string, string>} */
function parseFlags(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith("--") || argv[index + 1] === undefined) throw new Error("usage: t5-tcad-extras.mjs [--seed <csv>] [--archive <zip>] [--out <dir>]");
    flags[argv[index].slice(2)] = argv[index + 1];
  }
  return flags;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const flags = parseFlags(process.argv.slice(2));
  buildTcadExtras({ seedPath: path.resolve(flags.seed ?? DEFAULT_SEED), archive: path.resolve(flags.archive ?? DEFAULT_ARCHIVE), outDir: path.resolve(flags.out ?? DEFAULT_OUT_DIR) })
    .then((index) => {
      console.log(
        JSON.stringify({
          travis_tcad_extras: index.output.file,
          sha256: index.output.sha256,
          accounts: index.presence.accounts,
          roof_covering: index.presence.roof_covering,
          land_segments: index.presence.land_segments,
          ten_percent_cap_positive: index.counts.prop.ten_percent_cap_positive,
          entity_class_on_account: index.presence.entity_class_on_account,
          total_s: Math.round(index.timings_ms.total / 100) / 10,
        }),
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : error);
      process.exit(1);
    });
}
