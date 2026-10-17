#!/usr/bin/env node
/**
 * T3 US-egress window fetch (assignment decisions.md section 23): one command, run by the operator with the VPN on.
 * It only downloads and records; every transform, load and match runs offline afterwards.
 *
 *   node src/counties/travis/t3-vpn-fetch.mjs [--out data/travis/t3-window] [--only a,b] [--page-size 50000]
 *                                             [--tdlr-all] [--probe-taxpayer <number>]
 *
 * Before every request it checks https://ipinfo.io/country and stops on anything but US: the request is not sent and
 * nothing starts after it (exit 3). Every request gets a receipt (request, fetched_at, status, bytes, SHA-256, rows,
 * egress). It is resumable (rerun the same command: intact files are not requested again) and fetches Socrata pages
 * concurrently. Sources:
 *
 *   tx-comptroller-franchise-tax      data.texas.gov 9cir-efmm, statewide (the private matching universe), paged by :id,
 *                                     with the dataset's update time and column metadata at start and end
 *   tx-comptroller-sales-tax          data.texas.gov jrea-zgmq, Travis outlets (outlet_county_code 227, read from the
 *                                     dataset's grouped county codes at run time), paged by :id
 *   tx-sos-veteran-owned-business     data.texas.gov 2vfr-72e4 (SOS Veteran Owned Business), statewide, paged by :id
 *   tdlr-license-files                TDLR daily license CSV files for the electrical and air conditioning/refrigeration
 *                                     trades, URLs resolved from tdlr.texas.gov/LicenseSearch/licfile.asp at run time
 *                                     (fallback when no link matches: the data.texas.gov copy 7358-krk7 for the same
 *                                     license types, resolved from its grouped license_type values)
 *   tsbpe-responsible-master-plumber  the Responsible Master Plumber CSV, URL resolved from TSBPE's free licensee list
 *                                     page at run time
 *   comptroller-taxpayer-detail-probe one GET of comptroller.texas.gov/taxes/franchise/account-status/search/<number>
 *                                     for one franchise-tax corporation, recording what the per-taxpayer URL returns
 *
 * Prints one progress line per source and a one-line summary; writes `<out>/runs/<stamp>.json` (counts only).
 *
 * @module counties/travis/t3-vpn-fetch
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { EgressStop, captureSocrataDataset, captureToFile, compactTimestamp, createCaptureContext, createEgressGuard, extractLinks, hostLimiter } from "./t3-fetch.mjs";
import { RUNTIME_ROOT, parseCsvRecordSpans } from "./t3-snapshot.mjs";
import { TRAVIS_COMPTROLLER_COUNTY_CODE } from "./t3-sources.mjs";

export const VPN_SOURCES = Object.freeze([
  "tx-comptroller-franchise-tax",
  "tx-comptroller-sales-tax",
  "tx-sos-veteran-owned-business",
  "tdlr-license-files",
  "tsbpe-responsible-master-plumber",
  "comptroller-taxpayer-detail-probe",
]);
export const TDLR_LICENSE_FILE_PAGE = "https://www.tdlr.texas.gov/LicenseSearch/licfile.asp";
export const TSBPE_FREE_LIST_PAGE = "https://tsbpe.texas.gov/free-licensee-list/";
export const TSBPE_HOME = "https://tsbpe.texas.gov/";
export const COMPTROLLER_DETAIL_PREFIX = "https://comptroller.texas.gov/taxes/franchise/account-status/search/";
/** Trades whose TDLR licenses can back a permit contractor (Texas issues no roofing license). */
export const TDLR_TRADES = /electric|air[\s-]*condition|\ba\/c\b|refrigerat/i;
const RMP = /responsible\s+master\s+plumber/i;
/** A download: a .csv path or TSBPE's /download-csv/<code>/ endpoint. The site menu also links each license type's description page under the same name. */
const CSV_DOWNLOAD_PATH = /\/download-csv\/|\.csv$/i;

const relative = (target) => {
  const rel = path.relative(RUNTIME_ROOT, target);
  return rel.startsWith("..") ? target : rel.split(path.sep).join("/");
};
const utcDate = (date) => date.toISOString().slice(0, 10).replace(/-/g, "");

/**
 * @typedef {object} SourceResult
 * @property {string} key - Source key.
 * @property {"ok" | "failed" | "inconsistent" | "stopped"} status - Outcome.
 * @property {number | null} rows - CSV data rows captured.
 * @property {number | null} bytes - Bytes captured (data files).
 * @property {number} requests - Requests sent.
 * @property {number} resumed - Files reused from an earlier run.
 * @property {number} seconds - Wall time.
 * @property {Record<string, unknown>} detail - Source-specific facts (paths relative to the runtime).
 */

/** @type {Record<string, (ctx: import("./t3-fetch.mjs").CaptureContext, options: Record<string, any>) => Promise<Omit<SourceResult, "key" | "requests" | "resumed" | "seconds">>>} */
const RUNNERS = {
  async "tx-comptroller-franchise-tax"(ctx, options) {
    const summary = await captureSocrataDataset(ctx, { source: "tx-comptroller-franchise-tax", domain: "data.texas.gov", id: "9cir-efmm", dir: path.join(options.out, "tx-comptroller-franchise-tax"), pageSize: options.pageSize });
    return socrataResult(summary);
  },

  async "tx-comptroller-sales-tax"(ctx, options) {
    const source = "tx-comptroller-sales-tax";
    const summary = await captureSocrataDataset(ctx, {
      source,
      domain: "data.texas.gov",
      id: "jrea-zgmq",
      dir: path.join(options.out, source),
      pageSize: options.pageSize,
      prepare: async (versionDir) => {
        const params = new URLSearchParams({ $select: "outlet_county_code, count(*) as n", $group: "outlet_county_code", $order: "outlet_county_code", $limit: "1000" });
        await captureToFile(ctx, { source, kind: "resolve", dir: versionDir, file: "outlet-county-codes.json", url: `https://data.texas.gov/resource/jrea-zgmq.json?${params}` });
        const codes = JSON.parse(await readFile(path.join(versionDir, "outlet-county-codes.json"), "utf8"));
        const match =
          codes.find((row) => String(row.outlet_county_code) === TRAVIS_COMPTROLLER_COUNTY_CODE) ??
          codes.find((row) => new RegExp(`^0*${TRAVIS_COMPTROLLER_COUNTY_CODE}$`).test(String(row.outlet_county_code ?? "").trim()));
        if (!match) throw new Error(`jrea-zgmq prints no outlet_county_code ${TRAVIS_COMPTROLLER_COUNTY_CODE}; the grouped codes are in ${relative(path.join(versionDir, "outlet-county-codes.json"))}`);
        const code = String(match.outlet_county_code);
        return { where: `outlet_county_code='${code.replace(/'/g, "''")}'`, detail: { outlet_county_code: code, travis_outlets_in_grouped_count: Number(match.n), county_codes_listed: codes.length } };
      },
    });
    return socrataResult(summary);
  },

  async "tx-sos-veteran-owned-business"(ctx, options) {
    const summary = await captureSocrataDataset(ctx, { source: "tx-sos-veteran-owned-business", domain: "data.texas.gov", id: "2vfr-72e4", dir: path.join(options.out, "tx-sos-veteran-owned-business"), pageSize: options.pageSize });
    return socrataResult(summary);
  },

  async "tdlr-license-files"(ctx, options) {
    const source = "tdlr-license-files";
    const dir = path.join(options.out, source, `d${utcDate(ctx.now())}`);
    const stamp = compactTimestamp(ctx.now());
    const page = await captureToFile(ctx, { source, kind: "resolve", dir, file: `licfile-${stamp}.html`, url: TDLR_LICENSE_FILE_PAGE, resume: false });
    const links = extractLinks(await readFile(path.join(dir, page.file), "utf8"), page.final_url ?? TDLR_LICENSE_FILE_PAGE);
    const csvLinks = dedupeByHref(links.filter((link) => /\.(csv|txt)$/i.test(new URL(link.href).pathname)));
    const selected = options.tdlrAll ? csvLinks : csvLinks.filter((link) => TDLR_TRADES.test(link.text) || TDLR_TRADES.test(new URL(link.href).pathname));
    const copyMeta = await captureToFile(ctx, { source, kind: "metadata", dir, file: `data-texas-gov-7358-krk7-metadata-${stamp}.json`, url: "https://data.texas.gov/api/views/7358-krk7.json", resume: false });
    const copyMetadata = JSON.parse(await readFile(path.join(dir, copyMeta.file), "utf8"));
    const resolution = { page: page.file, page_url: TDLR_LICENSE_FILE_PAGE, final_url: page.final_url, csv_links_found: csvLinks, pattern: options.tdlrAll ? "all CSV links (--tdlr-all)" : String(TDLR_TRADES), selected, data_texas_gov_copy_rows_updated_at: toIso(copyMetadata.rowsUpdatedAt) };
    await writeFile(path.join(dir, `resolution-${stamp}.json`), `${JSON.stringify(resolution, null, 1)}\n`);
    if (selected.length === 0) {
      // Fallback: the data.texas.gov copy, restricted to the same trades through its printed license types.
      const fallbackDir = path.join(options.out, source, "data-texas-gov-7358-krk7");
      const summary = await captureSocrataDataset(ctx, {
        source,
        domain: "data.texas.gov",
        id: "7358-krk7",
        dir: fallbackDir,
        pageSize: options.pageSize,
        prepare: async (versionDir) => {
          const params = new URLSearchParams({ $select: "license_type, count(*) as n", $group: "license_type", $order: "license_type", $limit: "5000" });
          await captureToFile(ctx, { source, kind: "resolve", dir: versionDir, file: "license-types.json", url: `https://data.texas.gov/resource/7358-krk7.json?${params}` });
          const types = JSON.parse(await readFile(path.join(versionDir, "license-types.json"), "utf8"))
            .map((row) => String(row.license_type ?? ""))
            .filter((type) => TDLR_TRADES.test(type));
          if (types.length === 0) throw new Error("no TDLR CSV link and no 7358-krk7 license_type matched the electrical or A/C trades");
          return { where: `license_type in (${types.map((type) => `'${type.replace(/'/g, "''")}'`).join(", ")})`, detail: { license_types: types } };
        },
      });
      return { ...socrataResult(summary), detail: { ...socrataResult(summary).detail, resolution: relative(path.join(dir, `resolution-${stamp}.json`)), fallback: "no CSV link on licfile.asp matched; the data.texas.gov copy 7358-krk7 was captured for the same trades" } };
    }
    const files = await Promise.all(
      selected.map((link) => captureToFile(ctx, { source, kind: "file", dir, file: safeFileName(link.href), url: link.href, csv: true, extra: { link_text: link.text } })),
    );
    const notCsv = files.filter((receipt) => /text\/html/i.test(receipt.content_type ?? ""));
    return {
      status: notCsv.length > 0 ? "failed" : "ok",
      rows: files.reduce((sum, receipt) => sum + (receipt.rows ?? 0), 0),
      bytes: files.reduce((sum, receipt) => sum + receipt.bytes, 0),
      detail: {
        capture: relative(dir),
        resolution: relative(path.join(dir, `resolution-${stamp}.json`)),
        files: files.map((receipt) => ({ file: receipt.file, link_text: receipt.link_text, rows: receipt.rows, bytes: receipt.bytes, last_modified: receipt.headers?.["last-modified"] ?? null })),
        data_texas_gov_copy_rows_updated_at: resolution.data_texas_gov_copy_rows_updated_at,
        ...(notCsv.length > 0 ? { error: `HTML instead of CSV: ${notCsv.map((receipt) => receipt.file).join(", ")}` } : {}),
      },
    };
  },

  async "tsbpe-responsible-master-plumber"(ctx, options) {
    const source = "tsbpe-responsible-master-plumber";
    const dir = path.join(options.out, source, `d${utcDate(ctx.now())}`);
    const stamp = compactTimestamp(ctx.now());
    const visited = [];
    let link = null;
    const page = await captureToFile(ctx, { source, kind: "resolve", dir, file: `free-licensee-list-${stamp}.html`, url: TSBPE_FREE_LIST_PAGE, resume: false, allowHttpError: true });
    visited.push({ url: TSBPE_FREE_LIST_PAGE, status: page.status, file: page.file });
    if (page.status === 200) link = findRmpLink(extractLinks(await readFile(path.join(dir, page.file), "utf8"), page.final_url ?? TSBPE_FREE_LIST_PAGE));
    if (!link) {
      // The list page moved: find it from the home page (one hop), then look again.
      const home = await captureToFile(ctx, { source, kind: "resolve", dir, file: `home-${stamp}.html`, url: TSBPE_HOME, resume: false });
      visited.push({ url: TSBPE_HOME, status: home.status, file: home.file });
      const listLink = extractLinks(await readFile(path.join(dir, home.file), "utf8"), home.final_url ?? TSBPE_HOME).find((candidate) => /licensee\s+list/i.test(candidate.text));
      if (listLink) {
        const list = await captureToFile(ctx, { source, kind: "resolve", dir, file: `licensee-list-${stamp}.html`, url: listLink.href, resume: false });
        visited.push({ url: listLink.href, status: list.status, file: list.file });
        link = findRmpLink(extractLinks(await readFile(path.join(dir, list.file), "utf8"), list.final_url ?? listLink.href));
      }
    }
    const resolution = { visited, selected: link, pattern: String(RMP) };
    await writeFile(path.join(dir, `resolution-${stamp}.json`), `${JSON.stringify(resolution, null, 1)}\n`);
    if (!link) return { status: "failed", rows: null, bytes: null, detail: { capture: relative(dir), resolution: relative(path.join(dir, `resolution-${stamp}.json`)), error: "no Responsible Master Plumber link on the free licensee list" } };
    const receipt = await captureToFile(ctx, { source, kind: "file", dir, file: `responsible-master-plumber-${safeFileName(link.href)}`, url: link.href, csv: true, extra: { link_text: link.text } });
    const html = /text\/html/i.test(receipt.content_type ?? "");
    return {
      status: html ? "failed" : "ok",
      rows: receipt.rows,
      bytes: receipt.bytes,
      detail: { capture: relative(dir), resolution: relative(path.join(dir, `resolution-${stamp}.json`)), file: receipt.file, link_text: link.text, content_type: receipt.content_type, last_modified: receipt.headers?.["last-modified"] ?? null, ...(html ? { error: "the link returned HTML, not a CSV" } : {}) },
    };
  },

  async "comptroller-taxpayer-detail-probe"(ctx, options) {
    const source = "comptroller-taxpayer-detail-probe";
    const dir = path.join(options.out, source);
    const taxpayer = options.probeTaxpayer ?? (await firstCorporationTaxpayer(options.travisCache));
    if (!taxpayer) return { status: "failed", rows: null, bytes: null, detail: { error: "no probe taxpayer: pass --probe-taxpayer or keep the Travis cache" } };
    const url = `${COMPTROLLER_DETAIL_PREFIX}${encodeURIComponent(taxpayer)}`;
    const stamp = compactTimestamp(ctx.now());
    const receipt = await captureToFile(ctx, { source, kind: "probe", dir, file: `detail-${stamp}.html`, url, resume: false, allowHttpError: true });
    const body = await readFile(path.join(dir, receipt.file), "utf8");
    const analysis = {
      url_format: `${COMPTROLLER_DETAIL_PREFIX}<taxpayer_number>`,
      probe_taxpayer_source: options.probeTaxpayer ? "--probe-taxpayer" : "first franchise-tax corporation (organizational type CT) in the Travis cache",
      status: receipt.status,
      final_url: receipt.final_url,
      redirected: receipt.final_url !== url,
      content_type: receipt.content_type,
      bytes: receipt.bytes,
      sha256: receipt.sha256,
      title: /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.replace(/\s+/g, " ").trim() ?? null,
      body_contains_taxpayer_number: body.includes(taxpayer),
      api_like_urls: [...new Set([...body.matchAll(/https?:\/\/[^"'\s<>()]*(?:api|data-search)[^"'\s<>()]*/gi)].map((match) => match[0]))].slice(0, 20),
      script_srcs: [...body.matchAll(/<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]).slice(0, 20),
      confirmed: false,
      confirmation_rule: "confirmed offline after the window only if the page (or the API it calls, recorded here) serves this taxpayer's record at this URL; until then no company carries a per-taxpayer source_http_request",
    };
    await writeFile(path.join(dir, `probe-${stamp}.json`), `${JSON.stringify(analysis, null, 1)}\n`);
    return { status: receipt.status >= 200 && receipt.status < 300 ? "ok" : "failed", rows: null, bytes: receipt.bytes, detail: { capture: relative(dir), probe: relative(path.join(dir, `probe-${stamp}.json`)), status: receipt.status, redirected: analysis.redirected, body_contains_taxpayer_number: analysis.body_contains_taxpayer_number } };
  },
};

/**
 * @param {Record<string, any>} summary - Socrata capture summary.
 * @returns {Omit<SourceResult, "key" | "requests" | "resumed" | "seconds">} Result.
 */
function socrataResult(summary) {
  return {
    status: summary.consistent ? "ok" : "inconsistent",
    rows: summary.rows,
    bytes: summary.bytes,
    detail: {
      capture: relative(summary.versionDir),
      expected_rows: summary.expected_rows,
      pages: summary.pages,
      where: summary.where,
      prepared: summary.prepared,
      rows_updated_at: summary.rows_updated_at.end_iso,
      columns: summary.columns.length,
      ...(summary.inconsistency ? { inconsistency: summary.inconsistency } : {}),
    },
  };
}

/** @param {{ href: string, text: string }[]} links @returns {{ href: string, text: string }[]} */
function dedupeByHref(links) {
  const seen = new Set();
  return links.filter((link) => (seen.has(link.href) ? false : (seen.add(link.href), true)));
}

/** @param {{ href: string, text: string }[]} links @returns {{ href: string, text: string } | null} */
function findRmpLink(links) {
  const matches = links.filter((link) => RMP.test(link.text) || RMP.test(decodeURIComponent(link.href).replace(/[-_+]/g, " ")));
  return matches.find((link) => CSV_DOWNLOAD_PATH.test(new URL(link.href).pathname)) ?? null;
}

/** @param {string} href @returns {string} A file name from the URL path. */
function safeFileName(href) {
  const base = decodeURIComponent(new URL(href).pathname.split("/").filter(Boolean).at(-1) ?? "download");
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, "_");
  return /\.(csv|txt)$/i.test(clean) ? clean : `${clean}.csv`;
}

/** @param {unknown} epochSeconds @returns {string | null} */
function toIso(epochSeconds) {
  return typeof epochSeconds === "number" ? new Date(epochSeconds * 1000).toISOString() : null;
}

/**
 * @param {string} cacheDir - Travis Comptroller cache.
 * @returns {Promise<string | null>} Taxpayer number of the first CT (Texas profit corporation) row with an SOS file number.
 */
async function firstCorporationTaxpayer(cacheDir) {
  const file = path.join(cacheDir, "page-000.csv");
  if (!existsSync(file)) return null;
  let header = null;
  for (const record of parseCsvRecordSpans(await readFile(file, "utf8"))) {
    const values = record.fields.map((field) => field.value.trim());
    if (!header) {
      header = values;
      continue;
    }
    const row = Object.fromEntries(header.map((column, index) => [column, values[index]]));
    if (row.taxpayer_organizational_type === "CT" && row.secretary_of_state_sos_or_coa_file_number) return row.taxpayer_number;
  }
  return null;
}

/**
 * Run the window fetch.
 *
 * @param {object} [options] - Options.
 * @param {string} [options.out] - Output directory.
 * @param {string[]} [options.only] - Source keys (default: all).
 * @param {number} [options.pageSize] - Socrata rows per page.
 * @param {boolean} [options.tdlrAll] - Take every TDLR CSV file, not only the electrical and A/C trades.
 * @param {string} [options.probeTaxpayer] - Taxpayer number for the detail-URL probe.
 * @param {string} [options.travisCache] - Travis Comptroller cache (probe taxpayer).
 * @param {Partial<import("./t3-fetch.mjs").CaptureContext>} [options.context] - Context overrides (tests).
 * @returns {Promise<{ exitCode: number, results: SourceResult[], summary: Record<string, unknown> }>} Outcome.
 */
export async function runVpnFetch({
  out = path.join(RUNTIME_ROOT, "data", "travis", "t3-window"),
  only = [...VPN_SOURCES],
  pageSize = 50_000,
  tdlrAll = false,
  probeTaxpayer,
  travisCache = path.join(RUNTIME_ROOT, "data", "travis", "comptroller"),
  context = {},
} = {}) {
  const unknown = only.filter((key) => !VPN_SOURCES.includes(key));
  if (unknown.length > 0) throw new Error(`unknown source ${unknown.join(", ")}; known: ${VPN_SOURCES.join(", ")}`);
  const shared = createCaptureContext({ limit: hostLimiter({ "data.texas.gov": 4, default: 2 }), ...context });
  const guard = shared.guard ?? createEgressGuard({ fetchImpl: shared.fetchImpl, now: shared.now, sleep: shared.sleep });
  const started = Date.now();
  const startedAt = shared.now();
  await mkdir(out, { recursive: true });

  /** @type {SourceResult[]} */
  let results = [];
  let stopped = null;
  try {
    await guard.check();
  } catch (error) {
    if (!(error instanceof EgressStop)) throw error;
    stopped = error;
  }
  if (!stopped) {
    const options = { out, pageSize, tdlrAll, probeTaxpayer, travisCache };
    results = await Promise.all(
      only.map(async (key) => {
        const stats = { requests: 0, resumed: 0 };
        const ctx = { ...shared, guard, stats };
        const t0 = Date.now();
        /** @type {SourceResult} */
        let result;
        try {
          const outcome = await RUNNERS[key](ctx, options);
          result = { key, ...outcome, requests: stats.requests, resumed: stats.resumed, seconds: (Date.now() - t0) / 1000 };
        } catch (error) {
          const isStop = error instanceof EgressStop;
          result = { key, status: isStop ? "stopped" : "failed", rows: null, bytes: null, requests: stats.requests, resumed: stats.resumed, seconds: (Date.now() - t0) / 1000, detail: { error: error instanceof Error ? error.message : String(error) } };
        }
        shared.log(progressLine(result));
        return result;
      }),
    );
    stopped = shared.state.stopped;
  }
  const seconds = (Date.now() - started) / 1000;
  const counts = Object.fromEntries(["ok", "failed", "inconsistent", "stopped"].map((status) => [status, results.filter((result) => result.status === status).length]));
  const exitCode = stopped ? 3 : counts.failed > 0 || counts.inconsistent > 0 ? 1 : 0;
  const summary = {
    kind: "travis-t3-vpn-fetch",
    started_at: startedAt.toISOString(),
    finished_at: shared.now().toISOString(),
    seconds,
    out: relative(out),
    egress: stopped ? `stopped: ${stopped.country}` : "US at every check",
    egress_checks: guard.checks,
    requests: shared.state.requests,
    resumed: shared.state.resumed,
    sources: results,
    counts,
    exit_code: exitCode,
  };
  await mkdir(path.join(out, "runs"), { recursive: true });
  const record = path.join(out, "runs", `${compactTimestamp(startedAt)}.json`);
  await writeFile(record, `${JSON.stringify(summary, null, 1)}\n`);
  const rows = results.reduce((sum, result) => sum + (result.rows ?? 0), 0);
  const bytes = results.reduce((sum, result) => sum + (result.bytes ?? 0), 0);
  shared.log(
    stopped && results.length === 0
      ? `t3-vpn-fetch: STOPPED before any request: ${stopped.message}; record ${relative(record)}`
      : `t3-vpn-fetch: ${counts.ok}/${only.length} ok${counts.failed ? `, ${counts.failed} failed` : ""}${counts.inconsistent ? `, ${counts.inconsistent} inconsistent` : ""}${stopped ? `, STOPPED (egress ${stopped.country})` : ""}; ${rows.toLocaleString("en-US")} rows, ${(bytes / 1e6).toFixed(1)} MB, ${shared.state.requests} requests (${shared.state.resumed} resumed), ${guard.checks} egress checks, ${formatSeconds(seconds)}; record ${relative(record)}`,
  );
  return { exitCode, results, summary };
}

/** @param {SourceResult} result @returns {string} */
function progressLine(result) {
  const rows = result.rows === null ? "" : ` ${result.rows.toLocaleString("en-US")} rows`;
  const bytes = result.bytes === null ? "" : ` ${(result.bytes / 1e6).toFixed(1)} MB`;
  const reason = result.status === "ok" ? null : (result.detail?.error ?? result.detail?.inconsistency ?? null);
  const why = reason === null ? "" : ` (${typeof reason === "string" ? reason : JSON.stringify(reason)})`;
  return `[${result.key}] ${result.status}${rows}${bytes}, ${result.requests} requests, ${result.resumed} resumed, ${formatSeconds(result.seconds)}${why}`;
}

/** @param {number} seconds @returns {string} */
function formatSeconds(seconds) {
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, "0")}s` : `${seconds.toFixed(1)}s`;
}

/**
 * @param {string[]} argv - CLI arguments.
 * @returns {Record<string, any>} Options.
 */
export function parseArgs(argv) {
  /** @type {Record<string, any>} */
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--tdlr-all") options.tdlrAll = true;
    else if (flag === "--out") options.out = path.resolve(argv[(index += 1)]);
    else if (flag === "--only") options.only = argv[(index += 1)].split(",").map((key) => key.trim()).filter(Boolean);
    else if (flag === "--page-size") options.pageSize = Number.parseInt(argv[(index += 1)], 10);
    else if (flag === "--probe-taxpayer") options.probeTaxpayer = argv[(index += 1)];
    else if (flag === "--travis-cache") options.travisCache = path.resolve(argv[(index += 1)]);
    else throw new Error(`unknown argument ${flag}`);
  }
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runVpnFetch(parseArgs(process.argv.slice(2)))
    .then(({ exitCode }) => process.exit(exitCode))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
