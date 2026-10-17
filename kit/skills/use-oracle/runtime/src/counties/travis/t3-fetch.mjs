/**
 * T3 capture library: downloads and records, never transforms (assignment decisions.md section 23).
 *
 * - Egress guard: before every request the guard asks `https://ipinfo.io/country`; anything but `US` (another
 *   country, an HTTP error, a timeout) stops the whole capture before the request is sent, and no later request starts.
 * - Receipts: every request appends one JSON line to its capture directory's `receipts.jsonl`: the request as sent
 *   (`url`, and `source_http_request` with `method`, `url` and `multiValueQueryString`), `fetched_at`, `status`,
 *   `bytes`, `sha256`, `rows` (CSV data rows, quote-aware), `content_type`, `final_url`, selected response headers,
 *   the egress country and check time, attempts and duration.
 * - Resumable: a file whose receipt says 200 and whose bytes still hash to the receipt is not requested again.
 *   Socrata pages live under a directory named after the dataset's `rowsUpdatedAt`, so a resumed capture never mixes
 *   two versions of a dataset; the dataset's metadata is read again at the end, and a version change during the
 *   capture marks it inconsistent (rerun the same command).
 * - Fast: Socrata pages are fetched concurrently under a per-host limit.
 *
 * @module counties/travis/t3-fetch
 */
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const EGRESS_URL = "https://ipinfo.io/country";
export const DEFAULT_PAGE_SIZE = 50_000;
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const RECORDED_HEADERS = ["content-length", "last-modified", "etag", "x-soda2-truth-last-modified", "x-soda2-data-out-of-date", "x-soda2-fields", "x-soda2-types"];

/** Raised when the egress check does not return US; nothing else is requested afterwards. */
export class EgressStop extends Error {
  /** @param {string} country - What the check returned. */
  constructor(country) {
    super(`egress is ${country}, not US: stopped before sending the request`);
    this.name = "EgressStop";
    this.country = country;
  }
}

/**
 * @param {typeof fetch} fetchImpl - Fetch implementation.
 * @param {string} url - URL.
 * @param {RequestInit} init - Init.
 * @param {number} timeoutMs - Timeout.
 * @returns {Promise<Response>} Response (headers received).
 */
async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The egress guard. `check()` resolves with the country only when it is US. A definite other country stops at once; an
 * answer that is not a country (an HTTP error such as a 429 from ipinfo, a timeout, an unexpected body) is asked again
 * up to `attempts` times, and if no country comes back the guard stops too. It fails closed: nothing is sent until US.
 *
 * @param {object} [options] - Options.
 * @param {typeof fetch} [options.fetchImpl] - Fetch implementation.
 * @param {string} [options.url] - Country endpoint.
 * @param {number} [options.timeoutMs] - Check timeout.
 * @param {number} [options.attempts] - Attempts for answers that are not a country.
 * @param {(ms: number) => Promise<void>} [options.sleep] - Sleep between attempts.
 * @param {() => Date} [options.now] - Clock.
 * @returns {{ check: () => Promise<{ country: string, checked_at: string }>, readonly checks: number }} Guard.
 */
export function createEgressGuard({ fetchImpl = fetch, url = EGRESS_URL, timeoutMs = 10_000, attempts = 3, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => new Date() } = {}) {
  let checks = 0;
  return {
    get checks() {
      return checks;
    },
    async check() {
      let answer = "no answer";
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        checks += 1;
        try {
          const response = await fetchWithTimeout(fetchImpl, url, { headers: { accept: "text/plain" } }, timeoutMs);
          const body = response.ok ? (await response.text()).trim() : "";
          if (response.ok && /^[A-Z]{2}$/.test(body)) {
            if (body !== "US") throw new EgressStop(body);
            return { country: body, checked_at: now().toISOString() };
          }
          answer = response.ok ? `unexpected answer ${JSON.stringify(body.slice(0, 40))}` : `HTTP ${response.status}`;
        } catch (error) {
          if (error instanceof EgressStop) throw error;
          answer = `unknown (${error instanceof Error ? error.message : String(error)})`;
        }
        if (attempt < attempts) await sleep(1000 * attempt);
      }
      throw new EgressStop(answer);
    },
  };
}

/**
 * Quote-aware CSV record counter over a byte stream (a newline inside a quoted field is not a record end).
 *
 * @returns {{ push: (chunk: Uint8Array) => void, rows: () => number }} Counter; `rows()` excludes the header.
 */
export function createCsvRowCounter() {
  let inQuotes = false;
  let records = 0;
  let last = -1;
  let any = false;
  return {
    push(chunk) {
      for (let index = 0; index < chunk.length; index += 1) {
        const byte = chunk[index];
        if (byte === 0x22) inQuotes = !inQuotes;
        else if (byte === 0x0a && !inQuotes) records += 1;
      }
      if (chunk.length > 0) {
        any = true;
        last = chunk[chunk.length - 1];
      }
    },
    rows() {
      const total = records + (any && last !== 0x0a ? 1 : 0);
      return Math.max(0, total - 1);
    },
  };
}

/**
 * @param {string} url - Request URL as sent.
 * @returns {{ method: "GET", url: string, multiValueQueryString: Record<string, string[]> }} Lexicon-shaped request.
 */
export function sourceHttpRequest(url) {
  const parsed = new URL(url);
  /** @type {Record<string, string[]>} */
  const query = {};
  for (const [key, value] of parsed.searchParams) (query[key] ??= []).push(value);
  return { method: "GET", url: `${parsed.origin}${parsed.pathname}`, multiValueQueryString: query };
}

/**
 * @param {string} file - File path.
 * @returns {Promise<string | null>} SHA-256 of the file, or null when it is missing.
 */
async function fileSha256(file) {
  if (!existsSync(file)) return null;
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

/**
 * Serialized append-only receipt log for one directory.
 *
 * @param {string} dir - Capture directory.
 * @returns {{ path: string, append: (receipt: Record<string, unknown>) => Promise<void>, read: () => Promise<Record<string, any>[]> }} Log.
 */
export function receiptLog(dir) {
  const file = path.join(dir, "receipts.jsonl");
  let chain = Promise.resolve();
  return {
    path: file,
    append(receipt) {
      chain = chain.then(async () => {
        await mkdir(dir, { recursive: true });
        await appendFile(file, `${JSON.stringify(receipt)}\n`);
      });
      return chain;
    },
    async read() {
      if (!existsSync(file)) return [];
      return (await readFile(file, "utf8"))
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line));
    },
  };
}

/**
 * Bounded concurrency per host.
 *
 * @param {Record<string, number>} limits - Host to limit; `default` for the rest.
 * @returns {(url: string, task: () => Promise<any>) => Promise<any>} Runner.
 */
export function hostLimiter(limits) {
  /** @type {Map<string, { active: number, queue: (() => void)[] }>} */
  const hosts = new Map();
  return async (url, task) => {
    const host = new URL(url).hostname;
    const limit = limits[host] ?? limits.default ?? 2;
    let state = hosts.get(host);
    if (!state) {
      state = { active: 0, queue: [] };
      hosts.set(host, state);
    }
    const slot = state;
    if (slot.active >= limit) await new Promise((resolve) => slot.queue.push(() => resolve(undefined)));
    slot.active += 1;
    try {
      return await task();
    } finally {
      slot.active -= 1;
      slot.queue.shift()?.();
    }
  };
}

/**
 * @typedef {object} CaptureContext
 * @property {typeof fetch} fetchImpl - Fetch implementation.
 * @property {{ check: () => Promise<{ country: string, checked_at: string }> } | null} guard - Egress guard (null: no check, recorded as such).
 * @property {(url: string, task: () => Promise<any>) => Promise<any>} limit - Per-host limiter.
 * @property {{ stopped: EgressStop | null, requests: number, resumed: number }} state - Shared run state.
 * @property {() => Date} now - Clock.
 * @property {(ms: number) => Promise<void>} sleep - Sleep (mocked in tests).
 * @property {number} timeoutMs - Per-request timeout (headers and body).
 * @property {number} maxAttempts - Attempts per request on network errors, 408/425/429 and 5xx.
 * @property {(line: string) => void} log - Progress output.
 * @property {{ requests: number, resumed: number }} [stats] - Per-source counters (one context per source).
 */

/**
 * @param {Partial<CaptureContext>} [overrides] - Overrides.
 * @returns {CaptureContext} Context.
 */
export function createCaptureContext(overrides = {}) {
  return {
    fetchImpl: fetch,
    guard: null,
    limit: hostLimiter({ "data.texas.gov": 4, default: 2 }),
    state: { stopped: null, requests: 0, resumed: 0 },
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeoutMs: 300_000,
    maxAttempts: 4,
    log: (line) => console.log(line),
    ...overrides,
  };
}

/**
 * Fetch one URL into one file with a receipt, or reuse an intact earlier capture of the same request.
 *
 * @param {CaptureContext} ctx - Capture context.
 * @param {object} request - Request.
 * @param {string} request.source - Source key.
 * @param {string} request.kind - `metadata`, `count`, `page`, `file`, `resolve` or `probe`.
 * @param {string} request.dir - Capture directory (receipts and files).
 * @param {string} request.file - File name inside `dir`.
 * @param {string} request.url - URL as sent.
 * @param {boolean} [request.csv] - Count CSV data rows.
 * @param {boolean} [request.resume] - Reuse an intact earlier capture (default true).
 * @param {boolean} [request.allowHttpError] - Record a non-2xx answer instead of throwing (probes).
 * @param {Record<string, unknown>} [request.extra] - Extra receipt fields.
 * @returns {Promise<Record<string, any>>} The receipt (with `resumed: true` when nothing was requested).
 */
export async function captureToFile(ctx, { source, kind, dir, file, url, csv = false, resume = true, allowHttpError = false, extra = {} }) {
  const log = receiptLog(dir);
  const target = path.join(dir, file);
  if (resume) {
    const prior = (await log.read()).filter((receipt) => receipt.file === file && receipt.url === url && receipt.status >= 200 && receipt.status < 300).at(-1);
    if (prior && (await fileSha256(target)) === prior.sha256) {
      ctx.state.resumed += 1;
      if (ctx.stats) ctx.stats.resumed += 1;
      return { ...prior, resumed: true };
    }
  }
  return ctx.limit(url, async () => {
    let lastError = null;
    for (let attempt = 1; attempt <= ctx.maxAttempts; attempt += 1) {
      if (ctx.state.stopped) throw ctx.state.stopped;
      let egress = { country: "not checked (host answers any country)", checked_at: null };
      if (ctx.guard) {
        try {
          egress = await ctx.guard.check();
        } catch (error) {
          if (error instanceof EgressStop) ctx.state.stopped ??= error;
          throw error;
        }
      }
      if (ctx.state.stopped) throw ctx.state.stopped;
      const started = Date.now();
      const fetchedAt = ctx.now().toISOString();
      ctx.state.requests += 1;
      if (ctx.stats) ctx.stats.requests += 1;
      const base = { source, kind, file, method: "GET", url, source_http_request: sourceHttpRequest(url), fetched_at: fetchedAt, egress: egress.country, egress_checked_at: egress.checked_at, attempt, ...extra };
      let result;
      try {
        result = await downloadTo(ctx, url, target, csv);
      } catch (error) {
        // No response (network error or timeout): recorded, then retried while attempts remain.
        lastError = error;
        await log.append({ ...base, status: null, error: error instanceof Error ? error.message : String(error), duration_ms: Date.now() - started, retried: attempt < ctx.maxAttempts });
        await rm(`${target}.part`, { force: true });
        if (attempt < ctx.maxAttempts) await ctx.sleep(2000 * 2 ** (attempt - 1));
        continue;
      }
      const retry = RETRYABLE.has(result.status) && attempt < ctx.maxAttempts;
      const receipt = {
        ...base,
        status: result.status,
        bytes: result.bytes,
        sha256: result.sha256,
        rows: csv && result.status === 200 ? result.rows : null,
        content_type: result.contentType,
        final_url: result.finalUrl,
        headers: result.headers,
        duration_ms: Date.now() - started,
        ...(retry ? { retried: true } : {}),
      };
      await log.append(receipt);
      if (retry) {
        lastError = new Error(`${url}: HTTP ${result.status}`);
        const retryAfter = Number.parseInt(result.headers["retry-after"] ?? "", 10);
        await ctx.sleep(Math.min(60_000, Number.isFinite(retryAfter) ? retryAfter * 1000 : 2000 * 2 ** (attempt - 1)));
        continue;
      }
      if ((result.status < 200 || result.status >= 300) && !allowHttpError) throw Object.assign(new Error(`${url}: HTTP ${result.status}`), { receipt });
      return receipt;
    }
    throw lastError ?? new Error(`${url}: failed`);
  });
}

/**
 * Stream a response body to `target` (atomically through `<target>.part`), hashing and counting as it goes.
 *
 * @param {CaptureContext} ctx - Context.
 * @param {string} url - URL.
 * @param {string} target - Destination.
 * @param {boolean} csv - Count CSV rows.
 * @returns {Promise<{ status: number, bytes: number, sha256: string, rows: number, contentType: string | null, finalUrl: string, headers: Record<string, string> }>} Result.
 */
async function downloadTo(ctx, url, target, csv) {
  await mkdir(path.dirname(target), { recursive: true });
  const partial = `${target}.part`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${ctx.timeoutMs} ms`)), ctx.timeoutMs);
  const hash = createHash("sha256");
  const counter = createCsvRowCounter();
  let bytes = 0;
  const out = createWriteStream(partial);
  /** @type {Response} */
  let response;
  try {
    response = await ctx.fetchImpl(url, { redirect: "follow", signal: controller.signal, headers: { "user-agent": "travis-t3-capture/1 (public records snapshot)" } });
    if (response.body) {
      for await (const chunk of response.body) {
        const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        hash.update(view);
        if (csv) counter.push(view);
        bytes += view.length;
        if (!out.write(view)) await new Promise((resolve) => out.once("drain", resolve));
      }
    }
  } finally {
    clearTimeout(timer);
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve(undefined))));
  }
  await rename(partial, target);
  /** @type {Record<string, string>} */
  const headers = {};
  for (const name of [...RECORDED_HEADERS, "retry-after"]) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return { status: response.status, bytes, sha256: hash.digest("hex"), rows: counter.rows(), contentType: response.headers.get("content-type"), finalUrl: response.url || url, headers };
}

/**
 * @param {Date} date - Time.
 * @returns {string} `YYYYMMDDTHHMMSSZ`.
 */
export function compactTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/**
 * Capture a Socrata dataset: metadata (start and end), the row count, then every CSV page in a stable order.
 *
 * @param {CaptureContext} ctx - Context.
 * @param {object} spec - Dataset.
 * @param {string} spec.source - Source key.
 * @param {string} spec.domain - Socrata domain.
 * @param {string} spec.id - Dataset id.
 * @param {string} spec.dir - Source directory (a `v<rowsUpdatedAt>` directory is created under it).
 * @param {string | null} [spec.where] - SoQL `$where`.
 * @param {(versionDir: string) => Promise<{ where: string | null, detail?: Record<string, unknown> }>} [spec.prepare] - Resolves `$where` after the metadata (for example the outlet county code).
 * @param {number} [spec.pageSize] - Rows per page.
 * @returns {Promise<Record<string, any>>} Capture summary (also written to `<versionDir>/capture.json`).
 */
export async function captureSocrataDataset(ctx, { source, domain, id, dir, where = null, prepare, pageSize = DEFAULT_PAGE_SIZE }) {
  const startedAt = ctx.now();
  const metadataUrl = `https://${domain}/api/views/${id}.json`;
  const stagingDir = path.join(dir, "_metadata");
  const startStamp = compactTimestamp(startedAt);
  const metaStart = await captureToFile(ctx, { source, kind: "metadata", dir: stagingDir, file: `metadata-${startStamp}-start.json`, url: metadataUrl, resume: false });
  const metadata = JSON.parse(await readFile(path.join(stagingDir, metaStart.file), "utf8"));
  const version = String(metadata.rowsUpdatedAt ?? metadata.viewLastModified ?? "unknown");
  const versionDir = path.join(dir, `v${version}`);
  await mkdir(versionDir, { recursive: true });
  await writeFile(path.join(versionDir, `metadata-${startStamp}-start.json`), await readFile(path.join(stagingDir, metaStart.file)));
  await receiptLog(versionDir).append({ ...metaStart, note: `copied from _metadata/${metaStart.file}` });

  let effectiveWhere = where;
  let prepared = null;
  if (prepare) {
    prepared = await prepare(versionDir);
    effectiveWhere = prepared.where;
  }
  const countParams = new URLSearchParams({ $select: "count(*) as n" });
  if (effectiveWhere) countParams.set("$where", effectiveWhere);
  const countUrl = `https://${domain}/resource/${id}.json?${countParams}`;
  const countReceipt = await captureToFile(ctx, { source, kind: "count", dir: versionDir, file: "count.json", url: countUrl });
  const expectedRows = Number.parseInt(JSON.parse(await readFile(path.join(versionDir, "count.json"), "utf8"))[0]?.n ?? "0", 10);
  const pageCount = Math.max(1, Math.ceil(expectedRows / pageSize));
  const width = Math.max(5, String(pageCount).length);
  let done = 0;
  const pageReceipts = await Promise.all(
    Array.from({ length: pageCount }, async (_, index) => {
      const params = new URLSearchParams();
      if (effectiveWhere) params.set("$where", effectiveWhere);
      params.set("$order", ":id");
      params.set("$limit", String(pageSize));
      params.set("$offset", String(index * pageSize));
      const receipt = await captureToFile(ctx, { source, kind: "page", dir: versionDir, file: `page-${String(index).padStart(width, "0")}.csv`, url: `https://${domain}/resource/${id}.csv?${params}`, csv: true, extra: { dataset_rows_updated_at: version } });
      done += 1;
      if (pageCount >= 10 && done % 10 === 0 && done < pageCount) ctx.log(`[${source}] ${done}/${pageCount} pages`);
      return receipt;
    }),
  );
  const metaEnd = await captureToFile(ctx, { source, kind: "metadata", dir: versionDir, file: `metadata-${compactTimestamp(ctx.now())}-end.json`, url: metadataUrl, resume: false });
  const metadataEnd = JSON.parse(await readFile(path.join(versionDir, metaEnd.file), "utf8"));
  const rows = pageReceipts.reduce((sum, receipt) => sum + (receipt.rows ?? 0), 0);
  const mismatches = pageReceipts
    .map((receipt, index) => ({ file: receipt.file, rows: receipt.rows, expected: index < pageCount - 1 ? pageSize : expectedRows - pageSize * (pageCount - 1) }))
    .filter((page) => page.rows !== page.expected && !(expectedRows === 0 && page.rows === 0));
  const versionEnd = String(metadataEnd.rowsUpdatedAt ?? metadataEnd.viewLastModified ?? "unknown");
  const summary = {
    source,
    domain,
    dataset_id: id,
    where: effectiveWhere,
    prepared: prepared?.detail ?? null,
    page_size: pageSize,
    expected_rows: expectedRows,
    rows,
    pages: pageCount,
    bytes: pageReceipts.reduce((sum, receipt) => sum + receipt.bytes, 0),
    rows_updated_at: { start: version, end: versionEnd, start_iso: toIso(metadata.rowsUpdatedAt), end_iso: toIso(metadataEnd.rowsUpdatedAt) },
    view_last_modified_iso: toIso(metadataEnd.viewLastModified),
    columns: (metadataEnd.columns ?? []).map((column) => ({ fieldName: column.fieldName, name: column.name, dataTypeName: column.dataTypeName })),
    consistent: version === versionEnd && mismatches.length === 0,
    inconsistency: version !== versionEnd ? "dataset updated during the capture; rerun the same command" : mismatches.length > 0 ? { page_row_mismatches: mismatches } : null,
    receipts: path.join(path.basename(dir), path.basename(versionDir), "receipts.jsonl"),
    count_receipt_sha256: countReceipt.sha256,
    started_at: startedAt.toISOString(),
    finished_at: ctx.now().toISOString(),
  };
  await writeFile(path.join(versionDir, "capture.json"), `${JSON.stringify(summary, null, 1)}\n`);
  return { ...summary, versionDir };
}

/**
 * @param {unknown} epochSeconds - Socrata epoch seconds.
 * @returns {string | null} ISO time.
 */
function toIso(epochSeconds) {
  return typeof epochSeconds === "number" ? new Date(epochSeconds * 1000).toISOString() : null;
}

/**
 * Links of an HTML page with their text, resolved against the page URL.
 *
 * @param {string} html - Page HTML.
 * @param {string} baseUrl - Page URL (after redirects).
 * @returns {{ href: string, text: string }[]} Links in page order.
 */
export function extractLinks(html, baseUrl) {
  const links = [];
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchor)) {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[1]);
    const raw = href?.[1] ?? href?.[2] ?? href?.[3];
    if (!raw || raw.startsWith("#") || /^javascript:/i.test(raw) || /^mailto:/i.test(raw)) continue;
    let resolved;
    try {
      resolved = new URL(raw.replace(/&amp;/g, "&"), baseUrl).href;
    } catch {
      continue;
    }
    const text = match[2]
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
    links.push({ href: resolved, text });
  }
  return links;
}

/**
 * @param {string} file - File path.
 * @returns {Promise<boolean>} Whether a non-empty file exists.
 */
export async function nonEmptyFile(file) {
  try {
    return (await stat(file)).size > 0;
  } catch {
    return false;
  }
}
