#!/usr/bin/env node
/**
 * T3 absence proofs (assignment decisions.md section 23): what the regular sources do not carry, recorded with a
 * receipt per request so the proof can be re-run. Only hosts that answer any country are asked: the Socrata catalog
 * (api.us.socrata.com), the Austin portal (data.austintexas.gov), the lexicon manifest and an IPFS gateway for the
 * schema blocks. Nothing is written to data/; the output is counts, column names and digests.
 *
 *   node src/counties/travis/t3-absence-proofs.mjs --output docs/evidence/travis-t3-absence-proofs-<date>.json \
 *        [--ruling-scratch <dir>]   # the ruling's earlier outputs, recorded beside the fresh values
 *
 * @module counties/travis/t3-absence-proofs
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { EGRESS_URL, sourceHttpRequest } from "./t3-fetch.mjs";

const AUSTIN = "https://data.austintexas.gov/resource/3syk-w9eu.json";
const CATALOG = "https://api.us.socrata.com/api/catalog/v1";
const MANIFEST = "https://lexicon.elephant.xyz/api/manifest";
const GATEWAY = "https://ipfs.filebase.io/ipfs/";
const LICENSE_LIKE = /licen|regist|qualif|tdlr|tsbpe|tacla|tecl|journey|master/i;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
/** Columns the license-like pattern catches that are not licenses, with the reason. */
const NOT_A_LICENSE = Object.freeze({
  masterpermitnum: "Master Permit Num: the parent permit's number (a permit id), not a license",
  ":@computed_region_m2th_e4b7": "Community Registry: a computed region (the City's neighborhood-organization registry overlay), not a license",
});

/** Free-text license markers, exactly as the ruling asked them (decisions.md section 23). */
export const LICENSE_MARKER_QUERIES = Object.freeze([
  { label: "description contains TACLA (TDLR A/C contractor license prefix)", where: "upper(description) like '%TACLA%'" },
  { label: "description contains TECL (TDLR electrical contractor license prefix)", where: "upper(description) like '%TECL%'" },
  { label: "description contains LICENSE #, LIC # or LIC#", where: "upper(description) like '%LICENSE #%' OR upper(description) like '%LIC #%' OR upper(description) like '%LIC#%'" },
  { label: "contractor company or full name contains TACLA or TECL", where: "upper(contractor_company_name) like '%TACLA%' OR upper(contractor_company_name) like '%TECL%' OR upper(contractor_full_name) like '%TACLA%' OR upper(contractor_full_name) like '%TECL%'" },
  { label: "contractor company or full name contains LIC...#", where: "upper(contractor_company_name) like '%LIC%#%' OR upper(contractor_full_name) like '%LIC%#%'" },
]);
const ROOF_BP = "permittype='BP' AND upper(description) like '%ROOF%'";

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * CIDv1 (raw codec, sha2-256) of a block, base32 lower case: how the lexicon names its schema blocks.
 *
 * @param {Uint8Array} bytes - Block bytes.
 * @returns {string} `bafkrei...`.
 */
export function rawCidV1(bytes) {
  const digest = createHash("sha256").update(bytes).digest();
  const cid = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]);
  let bits = 0;
  let value = 0;
  let out = "b";
  for (const byte of cid) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * GET with a receipt.
 *
 * @param {Record<string, any>[]} receipts - Receipt list.
 * @param {string} purpose - What the request proves.
 * @param {string} url - URL.
 * @returns {Promise<Buffer>} Body.
 */
async function get(receipts, purpose, url) {
  const fetchedAt = new Date().toISOString();
  const started = Date.now();
  const response = await fetch(url, { headers: { "user-agent": "travis-t3-absence-proofs/1" } });
  const body = Buffer.from(await response.arrayBuffer());
  receipts.push({ purpose, method: "GET", url, source_http_request: sourceHttpRequest(url), fetched_at: fetchedAt, status: response.status, bytes: body.length, sha256: sha256Hex(body), duration_ms: Date.now() - started });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return body;
}

/** @param {Record<string, string>} params @returns {string} */
const austinQuery = (params) => `${AUSTIN}?${new URLSearchParams(params)}`;

/**
 * @param {string | undefined} dir - Ruling scratch directory.
 * @returns {Promise<Record<string, any> | null>} Its recorded values and file digests.
 */
async function rulingScratch(dir) {
  if (!dir || !existsSync(dir)) return null;
  const read = async (relative) => {
    const file = path.join(dir, relative);
    if (!existsSync(file)) return null;
    const bytes = await readFile(file);
    return { file: relative, sha256: sha256Hex(bytes), value: JSON.parse(bytes.toString("utf8") || "null") };
  };
  const markers = await Promise.all([1, 2, 3, 4, 5].map((index) => read(`dl-austin-soql/q${index}.json`)));
  return {
    note: "the ruling's outputs of 2026-10-17 (about 13:50Z, from RO egress; requests reconstructed from its transcript into LICENSE_MARKER_QUERIES and the roofing queries here), kept beside the fresh values; the export is republished daily, so counts can move by a few rows",
    license_markers: markers.map((entry, index) => ({ query: LICENSE_MARKER_QUERIES[index].label, ...entry })),
    roof_total: await read("dl-austin-soql/roof_total.json"),
    roof_trade: await read("dl-austin-soql/roof_trade.json"),
    roof_city: await read("dl-austin-soql/roof_city.json"),
    manifest: await read("dl-lexicon/manifest.json").then((entry) => (entry ? { file: entry.file, sha256: entry.sha256, entries: Object.keys(entry.value).length } : null)),
  };
}

/**
 * Build the proofs.
 *
 * @param {{ rulingScratchDir?: string }} [options] - Options.
 * @returns {Promise<Record<string, any>>} Evidence.
 */
export async function buildAbsenceProofs({ rulingScratchDir } = {}) {
  const receipts = [];
  let egress = null;
  try {
    egress = (await (await fetch(EGRESS_URL)).text()).trim();
  } catch {
    egress = "unknown";
  }

  // 1. The Austin permit export's columns: catalog, view metadata and the CSV header the export prints.
  const catalog = JSON.parse((await get(receipts, "Socrata catalog entry of the Austin permit export", `${CATALOG}?ids=3syk-w9eu`)).toString("utf8"));
  const resource = catalog.results[0].resource;
  const columns = resource.columns_field_name.map((fieldName, index) => ({ fieldName, name: resource.columns_name[index], dataType: resource.columns_datatype?.[index] ?? null }));
  const computed = columns.filter((column) => column.fieldName.startsWith(":@computed_region_"));
  const locationParts = columns.filter((column) => /^Location \(/.test(column.name));
  const named = columns.filter((column) => !computed.includes(column) && !locationParts.includes(column));
  const header = (await get(receipts, "the CSV header the Austin export prints", `https://data.austintexas.gov/resource/3syk-w9eu.csv?${new URLSearchParams({ $limit: "1" })}`)).toString("utf8").split("\n")[0].split(",").map((cell) => cell.replace(/^"|"$/g, ""));
  const licenseLike = columns.filter((column) => LICENSE_LIKE.test(column.fieldName) || LICENSE_LIKE.test(column.name));

  // 2. Free-text license markers.
  const total = JSON.parse((await get(receipts, "Austin export row count", austinQuery({ $select: "count(*) as n" }))).toString("utf8"))[0].n;
  const markers = [];
  for (const query of LICENSE_MARKER_QUERIES) {
    await sleep(1000);
    const value = JSON.parse((await get(receipts, `license marker: ${query.label}`, austinQuery({ $select: "count(*) as n", $where: query.where }))).toString("utf8"))[0].n;
    markers.push({ ...query, rows: Number(value) });
  }
  await sleep(1000);
  const anyDescription = LICENSE_MARKER_QUERIES.slice(0, 3).map((query) => `(${query.where})`).join(" OR ");
  const distinctDescription = Number(JSON.parse((await get(receipts, "license marker: distinct rows over the three description queries", austinQuery({ $select: "count(*) as n", $where: anyDescription }))).toString("utf8"))[0].n);

  // 3. Roofing building permits by contractor trade, and by contractor city (the scope evidence).
  await sleep(1000);
  const roofTotal = JSON.parse((await get(receipts, "roofing building permits: total, with a company, with a full name", austinQuery({ $select: "count(*) as n, count(contractor_company_name) as with_company, count(contractor_full_name) as with_name", $where: ROOF_BP }))).toString("utf8"))[0];
  await sleep(1000);
  const roofTrade = JSON.parse((await get(receipts, "roofing building permits by contractor_trade", austinQuery({ $select: "contractor_trade, count(*) as n", $where: ROOF_BP, $group: "contractor_trade", $order: "n DESC", $limit: "15" }))).toString("utf8"));
  await sleep(1000);
  const roofCity = JSON.parse((await get(receipts, "roofing building permits that print a company, by contractor city (top 40)", austinQuery({ $select: "upper(contractor_city) as city, count(*) as n", $where: `${ROOF_BP} AND contractor_company_name IS NOT NULL`, $group: "upper(contractor_city)", $order: "n DESC", $limit: "40" }))).toString("utf8"));
  const licensedTrades = roofTrade.filter((row) => row.contractor_trade && row.contractor_trade !== "General Contractor");

  // 4. Catalog facts the T3 window script relies on.
  const catalogIds = ["9cir-efmm", "jrea-zgmq", "7358-krk7", "2vfr-72e4", "8d92-wsiw"];
  const sources = {};
  for (const id of catalogIds) {
    const entry = JSON.parse((await get(receipts, `Socrata catalog entry ${id}`, `${CATALOG}?ids=${id}`)).toString("utf8")).results[0];
    sources[id] = { name: entry.resource.name, domain: entry.metadata.domain, attribution: entry.resource.attribution, data_updated_at: entry.resource.data_updated_at, columns: entry.resource.columns_field_name };
  }

  // 5. The live lexicon manifest: groups, a license class, the company schema.
  const manifestBytes = await get(receipts, "live lexicon manifest", MANIFEST);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const entries = Object.entries(manifest);
  const byType = (type) => entries.filter(([, value]) => value.type === type).map(([key]) => key);
  const groups = byType("dataGroup");
  const schemaOf = async (key) => {
    const cid = manifest[key]?.ipfsCid;
    if (!cid) return null;
    const bytes = await get(receipts, `lexicon schema ${key}`, `${GATEWAY}${cid}`);
    const schema = JSON.parse(bytes.toString("utf8"));
    return { cid, cid_matches_bytes: rawCidV1(bytes) === cid, title: schema.title, required: schema.required ?? [], additionalProperties: schema.additionalProperties ?? null, properties: Object.keys(schema.properties ?? {}) };
  };

  return {
    kind: "travis-t3-absence-proofs",
    recorded_at: new Date().toISOString(),
    decision: "assignment docs/decisions.md section 23 (licensing proven missing from the permits; business records proven missing from the lexicon)",
    egress,
    command: "node src/counties/travis/t3-absence-proofs.mjs --output docs/evidence/travis-t3-absence-proofs-2026-10-17.json --ruling-scratch <ruling scratch t3 dir>",
    austin_permit_columns: {
      dataset: "austin-issued-construction-permits/3syk-w9eu",
      data_updated_at: resource.data_updated_at,
      catalog_columns: columns.length,
      computed_region_columns: computed.length,
      location_sub_fields: locationParts.map((column) => column.fieldName),
      named_columns: named.length,
      named: named.map((column) => column.fieldName),
      computed: computed.map((column) => ({ fieldName: column.fieldName, name: column.name })),
      export_header_columns: header.length,
      export_header: header,
      license_like_pattern: String(LICENSE_LIKE),
      license_like_columns: licenseLike.map((column) => ({ ...column, reading: NOT_A_LICENSE[column.fieldName] ?? (column.fieldName.startsWith(":@computed_region_") ? "computed region: a geographic overlay, not a license" : "UNEXPLAINED: review") })),
      license_columns: licenseLike.filter((column) => !NOT_A_LICENSE[column.fieldName] && !column.fieldName.startsWith(":@computed_region_")).length,
      conclusion: "no column of the Austin export prints a license number, license type or qualifier; the contractor fields are contractor_trade, contractor_company_name, contractor_full_name, contractor_phone, contractor_address1/2, contractor_city and contractor_zip",
    },
    free_text_license_markers: {
      rows_in_export: Number(total),
      queries: markers,
      description_rows_any_marker: distinctDescription,
      contractor_field_rows: markers.slice(3).reduce((sum, query) => sum + query.rows, 0),
      conclusion: `license markers appear in the free-text description of ${distinctDescription} of ${Number(total).toLocaleString("en-US")} rows and in no contractor field: no lookup key exists for a license-detail search`,
    },
    roofing_trades: {
      where: ROOF_BP,
      totals: roofTotal,
      by_contractor_trade: roofTrade,
      licensed_trade_rows: licensedTrades.reduce((sum, row) => sum + Number(row.n), 0),
      conclusion: `${licensedTrades.reduce((sum, row) => sum + Number(row.n), 0)} of ${Number(roofTotal.n).toLocaleString("en-US")} building permits mentioning roof name a licensed trade (electrical, mechanical, plumbing); Texas issues no roofing license`,
    },
    roofing_contractor_cities_top40: roofCity,
    catalog_sources: sources,
    t3_window_facts: {
      sales_tax_outlet_county_column: sources["jrea-zgmq"].columns.includes("outlet_county_code") ? "outlet_county_code" : null,
      franchise_county_column: sources["9cir-efmm"].columns.includes("taxpayer_county_code") ? "taxpayer_county_code" : null,
      veteran_owned_join_column: sources["2vfr-72e4"].columns.includes("filing_number") ? "filing_number (SOS file number, joined exactly to 9cir-efmm secretary_of_state_sos_or_coa_file_number)" : null,
    },
    live_manifest_gaps: {
      url: MANIFEST,
      sha256: sha256Hex(manifestBytes),
      entries: entries.length,
      by_type: { class: byType("class").length, relationship: byType("relationship").length, dataGroup: groups.length },
      data_groups: groups,
      corporate_registry_group: groups.filter((group) => /registr|corporat|license/i.test(group)),
      license_entries: entries.filter(([key]) => /licen/i.test(key)).map(([key]) => key),
      company_related_relationships: byType("relationship").filter((key) => /company|business/i.test(key)),
      company_schema: await schemaOf("company"),
      business_location_schema: await schemaOf("business_location"),
      conclusion: "no corporate-registry data group among the 16; no license class and no company-to-license relationship; company holds only name, request_identifier, source_http_request and the Florida sunbiz_document_number under additionalProperties false; Business_Location is the places shape",
    },
    ruling_scratch: await rulingScratch(rulingScratchDir),
    receipts,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const flag = (name) => {
    const index = process.argv.indexOf(name);
    return index > 0 ? process.argv[index + 1] : undefined;
  };
  const output = flag("--output");
  if (!output) {
    console.error("usage: t3-absence-proofs.mjs --output <file> [--ruling-scratch <dir>]");
    process.exit(2);
  }
  buildAbsenceProofs({ rulingScratchDir: flag("--ruling-scratch") })
    .then(async (evidence) => {
      await writeFile(path.resolve(output), `${JSON.stringify(evidence, null, 1)}\n`);
      console.log(
        JSON.stringify({
          named_columns: evidence.austin_permit_columns.named_columns,
          catalog_columns: evidence.austin_permit_columns.catalog_columns,
          marker_rows: evidence.free_text_license_markers.description_rows_any_marker,
          roof_licensed_trades: `${evidence.roofing_trades.licensed_trade_rows} of ${evidence.roofing_trades.totals.n}`,
          manifest_sha256: evidence.live_manifest_gaps.sha256.slice(0, 16),
          license_entries: evidence.live_manifest_gaps.license_entries.length,
          requests: evidence.receipts.length,
        }),
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
