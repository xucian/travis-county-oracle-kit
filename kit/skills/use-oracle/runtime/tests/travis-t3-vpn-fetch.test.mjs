import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createCsvRowCounter, createEgressGuard, extractLinks, hostLimiter, sourceHttpRequest } from "../src/counties/travis/t3-fetch.mjs";
import { loadSnapshot } from "../src/counties/travis/t3-snapshot.mjs";
import { VPN_SOURCES, runVpnFetch } from "../src/counties/travis/t3-vpn-fetch.mjs";

const PAGES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "travis-t3", "pages");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const silent = () => {};
const noSleep = async () => {};

/** Synthetic Socrata datasets: header plus rows; `rowsUpdatedAt` per dataset. */
function datasets() {
  return {
    "9cir-efmm": {
      rowsUpdatedAt: 1792230000,
      header: ["taxpayer_number", "taxpayer_name", "taxpayer_county_code"],
      rows: [
        ["10000000001", "ACME ROOFING LLC", "227"],
        ["10000000002", "HILL COUNTRY EXTERIORS LLC", "246"],
        ["10000000003", "MULTI\nLINE NAME", "101"],
        ["10000000004", "CAPITAL ROOF CO", "227"],
        ["10000000005", "CAPITAL ROOF INC", "101"],
      ],
    },
    "jrea-zgmq": {
      rowsUpdatedAt: 1792230100,
      header: ["taxpayer_number", "outlet_number", "outlet_name", "outlet_county_code"],
      rows: [
        ["10000000001", "00001", "ACME ROOFING", "227"],
        ["10000000001", "00002", "ACME ROOFING NORTH", "246"],
        ["10000000006", "00001", "CORNER STORE", "227"],
      ],
      countyCodes: [
        { outlet_county_code: "226", n: "10" },
        { outlet_county_code: "227", n: "2" },
        { outlet_county_code: "246", n: "1" },
      ],
    },
    "2vfr-72e4": { rowsUpdatedAt: 1792230200, header: ["filing_number", "name"], rows: [["0800000001", "VETERAN ROOFING LLC"]] },
    "7358-krk7": {
      rowsUpdatedAt: 1790000000,
      header: ["license_number", "license_type", "business_name"],
      rows: [
        ["TECL1", "Electrical Contractor", "SPARK LLC"],
        ["B1", "Barber", "CUTS"],
        ["TACL1", "A/C Contractor", "COOL LLC"],
      ],
      licenseTypes: [{ license_type: "A/C Contractor", n: "1" }, { license_type: "Barber", n: "1" }, { license_type: "Electrical Contractor", n: "1" }],
    },
  };
}

const csvCell = (value) => `"${String(value).replaceAll('"', '""')}"`;
const toCsv = (header, rows) => `${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;

/**
 * A mocked internet: ipinfo, the Socrata endpoints, TDLR, TSBPE and the Comptroller page. Every request is logged with
 * the egress country in force when it was answered.
 *
 * @param {object} [options] - Options.
 * @param {(checks: number) => string} [options.country] - Country by egress-check number (1-based).
 * @param {Record<string, any>} [options.data] - Datasets.
 * @param {string} [options.tdlrPage] - TDLR page HTML.
 * @param {Set<string>} [options.failOnce] - URL substrings answered 429 once.
 * @param {(id: string, call: number) => number} [options.versionOf] - rowsUpdatedAt per metadata call.
 */
async function internet({ country = () => "US", data = datasets(), tdlrPage, failOnce = new Set(), versionOf } = {}) {
  const tdlr = tdlrPage ?? (await readFile(path.join(PAGES, "tdlr-licfile.html"), "utf8"));
  const tsbpe = await readFile(path.join(PAGES, "tsbpe-free-licensee-list.html"), "utf8");
  const comptroller = await readFile(path.join(PAGES, "comptroller-detail.html"), "utf8");
  const log = [];
  let checks = 0;
  let currentCountry = "US";
  const metadataCalls = {};
  const failed = new Set();
  const respond = (body, init = {}) => new Response(body, { status: 200, ...init });
  /** @param {string} url */
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === "ipinfo.io") {
      checks += 1;
      currentCountry = country(checks);
      log.push({ url, kind: "egress", country: currentCountry });
      return respond(`${currentCountry}\n`);
    }
    log.push({ url, kind: "data", country: currentCountry });
    for (const fragment of failOnce) {
      if (url.includes(fragment) && !failed.has(fragment)) {
        failed.add(fragment);
        return respond("slow down", { status: 429, headers: { "retry-after": "1" } });
      }
    }
    const view = /^\/api\/views\/([a-z0-9]{4}-[a-z0-9]{4})\.json$/.exec(parsed.pathname);
    if (view) {
      const id = view[1];
      metadataCalls[id] = (metadataCalls[id] ?? 0) + 1;
      const dataset = data[id];
      const rowsUpdatedAt = versionOf ? versionOf(id, metadataCalls[id]) : dataset.rowsUpdatedAt;
      return respond(JSON.stringify({ id, rowsUpdatedAt, viewLastModified: rowsUpdatedAt, columns: dataset.header.map((fieldName) => ({ fieldName, name: fieldName, dataTypeName: "text" })) }), { headers: { "content-type": "application/json" } });
    }
    const resource = /^\/resource\/([a-z0-9]{4}-[a-z0-9]{4})\.(json|csv)$/.exec(parsed.pathname);
    if (resource) {
      const [, id, format] = resource;
      const dataset = data[id];
      const select = parsed.searchParams.get("$select") ?? "";
      const where = parsed.searchParams.get("$where");
      let rows = dataset.rows;
      if (where) {
        const equal = /^(\w+)='([^']*)'$/.exec(where);
        const within = /^(\w+) in \((.*)\)$/.exec(where);
        if (equal) rows = rows.filter((row) => row[dataset.header.indexOf(equal[1])] === equal[2]);
        else if (within) {
          const values = [...within[2].matchAll(/'([^']*)'/g)].map((match) => match[1]);
          rows = rows.filter((row) => values.includes(row[dataset.header.indexOf(within[1])]));
        } else throw new Error(`mock cannot evaluate ${where}`);
      }
      if (format === "json" && select.startsWith("outlet_county_code")) return respond(JSON.stringify(dataset.countyCodes));
      if (format === "json" && select.startsWith("license_type")) return respond(JSON.stringify(dataset.licenseTypes));
      if (format === "json" && select.startsWith("count(*)")) return respond(JSON.stringify([{ n: String(rows.length) }]));
      const offset = Number(parsed.searchParams.get("$offset") ?? 0);
      const limit = Number(parsed.searchParams.get("$limit") ?? 1000);
      return respond(toCsv(dataset.header, rows.slice(offset, offset + limit)), { headers: { "content-type": "text/csv; charset=UTF-8" } });
    }
    if (parsed.hostname === "www.tdlr.texas.gov" && parsed.pathname === "/LicenseSearch/licfile.asp") return respond(tdlr, { headers: { "content-type": "text/html" } });
    if (parsed.hostname === "www.tdlr.texas.gov" && parsed.pathname.includes("/dbproduction2/")) {
      return respond(toCsv(["LICENSE NUMBER", "BUSINESS NAME"], [[`${path.basename(parsed.pathname)}-1`, "SPARK LLC"], ["X-2", "COOL\nLLC"]]), { headers: { "content-type": "text/csv", "last-modified": "Sat, 17 Oct 2026 05:00:00 GMT" } });
    }
    if (url === "https://tsbpe.texas.gov/free-licensee-list/") return respond(tsbpe, { headers: { "content-type": "text/html" } });
    if (parsed.hostname === "tsbpe.texas.gov" && parsed.pathname.endsWith(".csv")) return respond(toCsv(["License Number", "Name", "Company"], [["RMP-1", "PAT PLUMBER", "PIPES LLC"]]), { headers: { "content-type": "text/csv" } });
    if (parsed.hostname === "comptroller.texas.gov") return respond(comptroller, { headers: { "content-type": "text/html" } });
    return respond("not found", { status: 404 });
  };
  return { fetchImpl, log, checks: () => checks };
}

/** @param {string} dir @returns {Promise<string[]>} Every file under dir. */
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
}

async function withOut(run) {
  const out = await mkdtemp(path.join(tmpdir(), "t3-window-"));
  try {
    return await run(out);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

const options = (out, net, extra = {}) => ({ out, pageSize: 2, probeTaxpayer: "10000000001", context: { fetchImpl: net.fetchImpl, sleep: noSleep, log: silent }, ...extra });

describe("T3 VPN-only fetch", () => {
  it("counts CSV rows quote-aware and records the request in lexicon shape", () => {
    const counter = createCsvRowCounter();
    counter.push(Buffer.from('"a","b"\n"1","two\nlines"\n"3",'));
    counter.push(Buffer.from('"4"'));
    expect(counter.rows()).toBe(2);
    expect(sourceHttpRequest("https://data.texas.gov/resource/9cir-efmm.csv?%24order=%3Aid&%24limit=2&%24offset=0")).toEqual({
      method: "GET",
      url: "https://data.texas.gov/resource/9cir-efmm.csv",
      multiValueQueryString: { $order: [":id"], $limit: ["2"], $offset: ["0"] },
    });
    expect(extractLinks('<a href="/x/a.csv"><b>A</b> file</a><a href="#top">t</a><a href="mailto:x@y">m</a>', "https://h.example/p/q.asp")).toEqual([{ href: "https://h.example/x/a.csv", text: "A file" }]);
  });

  it("stops on a non-US country at once, and on no country after retries; never answers US by default", async () => {
    const answer = (body, status = 200) => async () => new Response(body, { status });
    const quiet = { sleep: noSleep };
    await expect(createEgressGuard({ fetchImpl: answer("US\n"), ...quiet }).check()).resolves.toMatchObject({ country: "US" });
    const ro = createEgressGuard({ fetchImpl: answer("RO\n"), ...quiet });
    await expect(ro.check()).rejects.toThrow(/egress is RO/);
    expect(ro.checks).toBe(1);
    const limited = createEgressGuard({ fetchImpl: answer("", 429), ...quiet });
    await expect(limited.check()).rejects.toThrow(/egress is HTTP 429/);
    expect(limited.checks).toBe(3);
    await expect(createEgressGuard({ fetchImpl: answer("<html>rate limited</html>"), ...quiet }).check()).rejects.toThrow(/unexpected answer/);
    await expect(createEgressGuard({ fetchImpl: async () => Promise.reject(new Error("offline")), ...quiet }).check()).rejects.toThrow(/unknown \(offline\)/);
    let calls = 0;
    const flaky = createEgressGuard({ fetchImpl: async () => (calls++ === 0 ? new Response("", { status: 429 }) : new Response("US")), ...quiet });
    await expect(flaky.check()).resolves.toMatchObject({ country: "US" });
    expect(flaky.checks).toBe(2);
  });

  it("sends nothing when egress is not US", async () => {
    await withOut(async (out) => {
      const net = await internet({ country: () => "RO" });
      const { exitCode, summary } = await runVpnFetch(options(out, net));
      expect(exitCode).toBe(3);
      expect(net.log.filter((entry) => entry.kind === "data")).toEqual([]);
      expect(summary).toMatchObject({ requests: 0, egress: "stopped: RO", egress_checks: 1 });
    });
  });

  it("fetches every source with a receipt per request, checking egress before each", async () => {
    await withOut(async (out) => {
      const net = await internet({ failOnce: new Set(["9cir-efmm.csv?%24order=%3Aid&%24limit=2&%24offset=2"]) });
      const lines = [];
      const { exitCode, results, summary } = await runVpnFetch({ ...options(out, net), context: { fetchImpl: net.fetchImpl, sleep: noSleep, log: (line) => lines.push(line) } });
      expect(exitCode).toBe(0);
      expect(results.map((result) => [result.key, result.status])).toEqual(VPN_SOURCES.map((key) => [key, "ok"]));
      const data = net.log.filter((entry) => entry.kind === "data");
      expect(data.every((entry) => entry.country === "US")).toBe(true);
      expect(net.checks()).toBe(data.length + 1);
      expect(summary.requests).toBe(data.length);

      const franchise = results.find((result) => result.key === "tx-comptroller-franchise-tax");
      expect(franchise).toMatchObject({ rows: 5, detail: { expected_rows: 5, pages: 3, rows_updated_at: new Date(1792230000 * 1000).toISOString(), columns: 3 } });
      const sales = results.find((result) => result.key === "tx-comptroller-sales-tax");
      expect(sales).toMatchObject({ rows: 2, detail: { where: "outlet_county_code='227'", prepared: { outlet_county_code: "227", travis_outlets_in_grouped_count: 2 } } });
      const tdlr = results.find((result) => result.key === "tdlr-license-files");
      expect(tdlr.detail.files.map((file) => file.link_text).sort()).toEqual(["Airconditioning Contractors", "All A/C Technicians", "Electrical Contractors", "Master Electricians"]);
      expect(tdlr.rows).toBe(8);
      expect(results.find((result) => result.key === "tsbpe-responsible-master-plumber")).toMatchObject({ rows: 1, detail: { link_text: "Responsible Master Plumber" } });
      const probe = results.find((result) => result.key === "comptroller-taxpayer-detail-probe");
      expect(probe.detail).toMatchObject({ status: 200, redirected: false, body_contains_taxpayer_number: false });
      const probeRecord = JSON.parse(await readFile(probe.detail.probe, "utf8"));
      expect(probeRecord).toMatchObject({ url_format: "https://comptroller.texas.gov/taxes/franchise/account-status/search/<taxpayer_number>", api_like_urls: ["https://comptroller.texas.gov/data-search/franchise-tax"], confirmed: false });

      // Every page and file is backed by a receipt whose digest and size match the bytes on disk.
      const receiptFiles = (await walk(out)).filter((file) => file.endsWith("receipts.jsonl"));
      let checked = 0;
      for (const receiptsFile of receiptFiles) {
        const receipts = (await readFile(receiptsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        for (const receipt of receipts.filter((entry) => entry.status === 200 && !entry.note)) {
          const bytes = await readFile(path.join(path.dirname(receiptsFile), receipt.file));
          expect([bytes.length, sha256(bytes)]).toEqual([receipt.bytes, receipt.sha256]);
          expect(receipt).toMatchObject({ method: "GET", egress: "US", source_http_request: { method: "GET" } });
          expect(typeof receipt.fetched_at).toBe("string");
          checked += 1;
        }
      }
      expect(checked).toBeGreaterThan(15);
      const retried = (await readFile(path.join(out, "tx-comptroller-franchise-tax", "v1792230000", "receipts.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((receipt) => receipt.file === "page-00001.csv");
      expect(retried.map((receipt) => receipt.status)).toEqual([429, 200]);

      expect(lines.filter((line) => line.startsWith("["))).toHaveLength(VPN_SOURCES.length);
      expect(lines.at(-1)).toMatch(/^t3-vpn-fetch: 6\/6 ok; .* rows, .* MB, \d+ requests \(0 resumed\), \d+ egress checks, /);

      // The capture loads offline with the T3 snapshot loader.
      const loaded = await loadSnapshot({ sourceKey: "tx-comptroller-franchise-tax", captureDir: path.join(out, "tx-comptroller-franchise-tax", "v1792230000"), outputDir: path.join(out, "registry"), name: "statewide", now: "2026-10-17T00:00:00.000Z" });
      expect(loaded.counts).toMatchObject({ rows: 5, distinct_keys: 5, by_scope: { out_of_county: 3, travis: 2 } });
      expect(loaded.names).toMatchObject({ non_unique_names: 1 });

      // Rerun: intact files are not requested again.
      const rerunNet = await internet();
      const rerun = await runVpnFetch(options(out, rerunNet));
      expect(rerun.exitCode).toBe(0);
      const pageRequests = rerunNet.log.filter((entry) => entry.kind === "data" && /\.csv/.test(entry.url));
      expect(pageRequests).toEqual([]);
      expect(rerun.summary.resumed).toBeGreaterThanOrEqual(5 + 1 + 1 + 4 + 1);
    });
  });

  it("checks egress immediately before each request, and stops the moment it turns non-US", async () => {
    await withOut(async (out) => {
      // One source, one request at a time: the log is check, request, check, request, ...
      const net = await internet({ country: (check) => (check <= 6 ? "US" : "RO") });
      const sequential = { fetchImpl: net.fetchImpl, sleep: noSleep, log: silent, limit: hostLimiter({ default: 1 }) };
      const { exitCode, results, summary } = await runVpnFetch({ ...options(out, net), only: ["tx-comptroller-franchise-tax"], context: sequential });
      expect(exitCode).toBe(3);
      net.log.forEach((entry, index) => {
        if (entry.kind === "data") expect(net.log[index - 1]).toMatchObject({ kind: "egress", country: "US" });
      });
      const flip = net.log.findIndex((entry) => entry.kind === "egress" && entry.country === "RO");
      expect(flip).toBe(net.log.length - 1);
      expect(net.log.filter((entry) => entry.kind === "data").map((entry) => new URL(entry.url).pathname)).toEqual([
        "/api/views/9cir-efmm.json",
        "/resource/9cir-efmm.json",
        "/resource/9cir-efmm.csv",
        "/resource/9cir-efmm.csv",
        "/resource/9cir-efmm.csv",
      ]);
      expect(results[0]).toMatchObject({ status: "stopped", detail: { error: expect.stringMatching(/egress is RO/) } });
      expect(summary.egress).toBe("stopped: RO");
    });
  });

  it("marks a dataset that changed during the capture inconsistent", async () => {
    await withOut(async (out) => {
      const net = await internet({ versionOf: (id, call) => (id === "2vfr-72e4" && call > 1 ? 1792239999 : datasets()[id].rowsUpdatedAt) });
      const { exitCode, results } = await runVpnFetch(options(out, net, { only: ["tx-sos-veteran-owned-business"] }));
      expect(exitCode).toBe(1);
      expect(results[0]).toMatchObject({ status: "inconsistent", detail: { inconsistency: "dataset updated during the capture; rerun the same command" } });
    });
  });

  it("reads a zero-padded outlet county code from the grouped codes", async () => {
    await withOut(async (out) => {
      const data = datasets();
      data["jrea-zgmq"].rows = data["jrea-zgmq"].rows.map((row) => [...row.slice(0, 3), row[3] === "227" ? "0227" : row[3]]);
      data["jrea-zgmq"].countyCodes = [{ outlet_county_code: "0227", n: "2" }];
      const net = await internet({ data });
      const { results } = await runVpnFetch(options(out, net, { only: ["tx-comptroller-sales-tax"] }));
      expect(results[0]).toMatchObject({ status: "ok", rows: 2, detail: { where: "outlet_county_code='0227'" } });
    });
  });

  it("falls back to the data.texas.gov copy when no TDLR link matches the trades", async () => {
    await withOut(async (out) => {
      const net = await internet({ tdlrPage: '<a href="/dbproduction2/ltbarber.csv">Barbers</a>' });
      const { results } = await runVpnFetch(options(out, net, { only: ["tdlr-license-files"] }));
      expect(results[0]).toMatchObject({ status: "ok", rows: 2, detail: { where: "license_type in ('A/C Contractor', 'Electrical Contractor')", fallback: expect.stringMatching(/7358-krk7/) } });
    });
  });

  it("refuses unknown sources", async () => {
    await expect(runVpnFetch({ only: ["bbb"] })).rejects.toThrow(/unknown source bbb/);
  });
});
