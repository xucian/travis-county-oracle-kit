#!/usr/bin/env node
/**
 * The record-id key (decisions.md section 24.2): 32 random bytes that key the `business_record_id` of records whose key
 * is withheld. The key is never printed; only its fingerprint is.
 *
 *   node src/counties/travis/t3-record-id-key.mjs init         create the key file (mode 0600); refuses to overwrite
 *   node src/counties/travis/t3-record-id-key.mjs fingerprint  print the fingerprint of the key in force
 *
 * The file is `data/travis/keys/record-id.key` under the runtime (gitignored), or `TRAVIS_RECORD_ID_KEY_FILE`. Keep a
 * copy outside the machine: a lost key means every withheld record gets a new id on the next load (a recorded re-key).
 *
 * @module counties/travis/t3-record-id-key
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readRecordIdKey, recordIdKeyFile, recordIdKeyFingerprint } from "./record-ids.mjs";

/**
 * @param {string} [file] - Key file.
 * @returns {Promise<{ file: string, fingerprint: string, created: boolean }>} Result (no key material).
 */
export async function initRecordIdKey(file = recordIdKeyFile()) {
  if (existsSync(file)) return { file, fingerprint: recordIdKeyFingerprint(readRecordIdKey(file)), created: false };
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  await writeFile(file, `${key.toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  return { file, fingerprint: recordIdKeyFingerprint(key), created: true };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [command] = process.argv.slice(2);
  const run = async () => {
    if (command === "init") {
      const result = await initRecordIdKey();
      console.log(JSON.stringify({ record_id_key: result.created ? "created" : "exists (not overwritten)", file: result.file, fingerprint: result.fingerprint }));
    } else if (command === "fingerprint") {
      console.log(JSON.stringify({ file: recordIdKeyFile(), fingerprint: recordIdKeyFingerprint(readRecordIdKey()) }));
    } else {
      console.error("usage: t3-record-id-key.mjs init | fingerprint");
      process.exit(2);
    }
  };
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
