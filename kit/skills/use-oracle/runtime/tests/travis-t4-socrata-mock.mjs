/**
 * Shared test helpers for the T4 permit tests: a mocked data.austintexas.gov for 3syk-w9eu (metadata, count, group-by
 * plan, partition pages) over a handful of synthetic permits. Not a test file itself.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { NOT_COLLECTED_PERSONAL, NOT_COLLECTED_ROLLING, PERMIT_COLUMNS_V1 } from "../src/counties/travis/t4-permit-fetch.mjs";

export const silent = () => {};
export const noSleep = async () => {};
export const ALL_COLUMNS = [...PERMIT_COLUMNS_V1.slice(0, 16), NOT_COLLECTED_ROLLING[0], ...PERMIT_COLUMNS_V1.slice(16), ...NOT_COLLECTED_PERSONAL];

/** Synthetic permits: [permittype, year, month, permit_number]. */
export function permits() {
  const rows = [];
  let serial = 0;
  const add = (type, year, month, count) => {
    for (let index = 0; index < count; index += 1) {
      serial += 1;
      rows.push({ permittype: type, calendar_year_issued: String(year), issue_date: `${year}-${String(month).padStart(2, "0")}-15T00:00:00.000`, permit_number: `${year}-${String(serial).padStart(6, "0")} ${type}`, applicant_full_name: "PRIVATE PERSON", description: serial === 2 ? 'RE-ROOF "TEAR OFF",\nTWO LINES' : "REMODEL" });
    }
  };
  add("BP", 2021, 3, 2);
  add("BP", 2022, 1, 3);
  add("BP", 2022, 7, 2);
  add("EP", 2021, 5, 1);
  return rows;
}

const csvCell = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;

/**
 * Mocked Socrata host for 3syk-w9eu: metadata, count, group-by plan, partition pages.
 *
 * @param {object} [options] - Options.
 * @param {string[]} [options.columns] - Metadata columns.
 * @param {(call: number) => number} [options.versionOf] - rowsUpdatedAt per metadata call.
 * @param {Set<string>} [options.failOnce] - File-name fragments answered 429 once.
 * @param {number} [options.dropRowFrom] - Partition year whose page loses one row.
 * @param {Record<string, string>[]} [options.data] - Permit rows (each needs permittype, calendar_year_issued, issue_date).
 */
export function socrata({ columns = ALL_COLUMNS, versionOf = () => 1792243463, failOnce = new Set(), dropRowFrom = null, data = permits() } = {}) {
  const requests = [];
  let metadataCalls = 0;
  const failed = new Set();
  const respond = (body, init = {}) => new Response(body, { status: 200, ...init });
  const matches = (where) => {
    const type = /permittype = '([^']*)'/.exec(where)?.[1];
    const tcad = /tcad_id = '([^']*)'/.exec(where)?.[1];
    const year = /calendar_year_issued = (\d+)/.exec(where)?.[1];
    const from = /issue_date >= '([^']*)'/.exec(where)?.[1];
    const to = /issue_date < '([^']*)'/.exec(where)?.[1];
    return (row) => (type === undefined || row.permittype === type) && (tcad === undefined || row.tcad_id === tcad) && (year === undefined || row.calendar_year_issued === year) && (from === undefined || row.issue_date >= from) && (to === undefined || row.issue_date < to);
  };
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === "ipinfo.io") return respond("RO\n");
    requests.push(url);
    for (const fragment of failOnce) {
      if (url.includes(fragment) && !failed.has(fragment)) {
        failed.add(fragment);
        return respond("slow down", { status: 429, headers: { "retry-after": "1" } });
      }
    }
    if (parsed.pathname === "/api/views/3syk-w9eu.json") {
      metadataCalls += 1;
      const version = versionOf(metadataCalls);
      return respond(JSON.stringify({ id: "3syk-w9eu", rowsUpdatedAt: version, viewLastModified: version, columns: [...columns, ":@computed_region_8spj_utxs"].map((fieldName) => ({ fieldName, name: fieldName, dataTypeName: "text" })) }));
    }
    if (parsed.pathname === "/resource/3syk-w9eu.json") {
      const select = parsed.searchParams.get("$select") ?? "";
      const where = parsed.searchParams.get("$where");
      const rows = where ? data.filter(matches(where)) : data;
      if (select.startsWith("permittype,calendar_year_issued,count")) {
        const groups = new Map();
        for (const row of rows) groups.set(`${row.permittype}|${row.calendar_year_issued}`, (groups.get(`${row.permittype}|${row.calendar_year_issued}`) ?? 0) + 1);
        return respond(JSON.stringify([...groups].map(([key, n]) => ({ permittype: key.split("|")[0], calendar_year_issued: key.split("|")[1], n: String(n) }))));
      }
      if (select.startsWith("count(*)")) return respond(JSON.stringify([{ n: String(rows.length) }]));
    }
    if (parsed.pathname === "/resource/3syk-w9eu.csv") {
      const fields = (parsed.searchParams.get("$select") ?? "").split(",");
      let rows = data.filter(matches(parsed.searchParams.get("$where") ?? ""));
      if (dropRowFrom !== null && rows[0]?.calendar_year_issued === String(dropRowFrom)) rows = rows.slice(1);
      const limit = Number(parsed.searchParams.get("$limit"));
      const body = [fields.map(csvCell).join(","), ...rows.slice(0, limit).map((row) => fields.map((field) => csvCell(row[field])).join(","))].join("\n");
      return respond(`${body}\n`, { headers: { "content-type": "text/csv; charset=UTF-8" } });
    }
    return respond("not found", { status: 404 });
  };
  return { fetchImpl, requests };
}

export async function withOut(run) {
  const out = await mkdtemp(path.join(tmpdir(), "t4-permits-"));
  try {
    return await run(out);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

export const context = (net) => ({ fetchImpl: net.fetchImpl, sleep: noSleep, log: silent });

