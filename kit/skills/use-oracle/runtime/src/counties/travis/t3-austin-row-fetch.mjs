#!/usr/bin/env node
/**
 * Capture the City of Austin "Active Right of Way Contractor License Holders" (data.austintexas.gov `8d92-wsiw`) with
 * a receipt per request (assignment decisions.md section 23). The host answers any country, so no egress gate applies;
 * the egress country is still recorded once in the capture summary. Downloads and records only.
 *
 *   node src/counties/travis/t3-austin-row-fetch.mjs [--out data/travis/austin-row]
 *
 * Then: node src/counties/travis/t3-snapshot.mjs load --source austin-row-contractor-licenses \
 *         --capture data/travis/austin-row/v<rowsUpdatedAt> --output data/travis/licensing --name austin-row-contractor-licenses
 *
 * @module counties/travis/t3-austin-row-fetch
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { EGRESS_URL, captureSocrataDataset, createCaptureContext } from "./t3-fetch.mjs";
import { RUNTIME_ROOT } from "./t3-snapshot.mjs";

/**
 * @param {object} [options] - Options.
 * @param {string} [options.out] - Output directory.
 * @param {Partial<import("./t3-fetch.mjs").CaptureContext>} [options.context] - Context overrides (tests).
 * @returns {Promise<Record<string, any>>} Capture summary.
 */
export async function captureAustinRowLicenses({ out = path.join(RUNTIME_ROOT, "data", "travis", "austin-row"), context = {} } = {}) {
  const ctx = createCaptureContext({ limit: (url, task) => task(), ...context });
  let egress = null;
  try {
    const response = await ctx.fetchImpl(EGRESS_URL);
    egress = { country: (await response.text()).trim(), checked_at: ctx.now().toISOString(), gating: false };
  } catch (error) {
    egress = { country: null, error: error instanceof Error ? error.message : String(error), gating: false };
  }
  const summary = await captureSocrataDataset(ctx, { source: "austin-row-contractor-licenses", domain: "data.austintexas.gov", id: "8d92-wsiw", dir: out });
  const result = { ...summary, egress, requests: ctx.state.requests, resumed: ctx.state.resumed };
  await writeFile(path.join(summary.versionDir, "capture.json"), `${JSON.stringify({ ...result, versionDir: undefined }, null, 1)}\n`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const outIndex = process.argv.indexOf("--out");
  const out = outIndex > 0 ? path.resolve(process.argv[outIndex + 1]) : undefined;
  captureAustinRowLicenses({ out })
    .then((summary) => {
      console.log(
        JSON.stringify({
          travis_t3_austin_row_capture: summary.consistent ? "ok" : "inconsistent",
          rows: summary.rows,
          expected_rows: summary.expected_rows,
          bytes: summary.bytes,
          rows_updated_at: summary.rows_updated_at.end_iso,
          capture: path.relative(RUNTIME_ROOT, summary.versionDir),
          requests: summary.requests,
          egress: summary.egress?.country,
        }),
      );
      process.exit(summary.consistent ? 0 : 1);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
