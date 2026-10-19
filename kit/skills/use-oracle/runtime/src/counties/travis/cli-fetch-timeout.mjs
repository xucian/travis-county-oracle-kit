/**
 * Preload for the elephant-cli upload process only (assignment decisions.md 28.7, option (a)). Node's built-in fetch
 * gives up after 300 s by default (undici's headersTimeout and bodyTimeout), and the CLI sets no timeout of its own on
 * the Kubo RPC `dag/import`, so an import whose recursive root pin takes longer fails with "fetch failed". This raises
 * both to CLI_FETCH_TIMEOUT_MS (default 30 minutes) through the global dispatcher Node's fetch reads. The CLI's code
 * and parameters are unchanged. Loaded with `NODE_OPTIONS=--import=<this file>` by t6-publish.mjs `upload`.
 *
 * @module counties/travis/cli-fetch-timeout
 */
import { Agent, setGlobalDispatcher } from "undici";

const timeout = Number(process.env.CLI_FETCH_TIMEOUT_MS ?? 30 * 60_000);
setGlobalDispatcher(new Agent({ headersTimeout: timeout, bodyTimeout: timeout }));
