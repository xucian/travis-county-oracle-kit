import { describe, expect, it } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { RECORD_ID_VERSION, readRecordIdKey, recordIdKeyFingerprint, recordIdMessage, recordIdOf, withheldRecordIdOf } from "../src/counties/travis/record-ids.mjs";
import { initRecordIdKey } from "../src/counties/travis/t3-record-id-key.mjs";

describe("Travis record ids (travis-record-id.v1)", () => {
  it("hashes the source key and the trimmed key parts joined by U+001F", () => {
    expect(RECORD_ID_VERSION).toBe("travis-record-id.v1");
    expect(recordIdMessage("tdlr-license-files", ["A/C Technician", null, "123"])).toBe("tdlr-license-files\u001fA/C Technician\u001f\u001f123");
    const expected = createHash("sha256").update("tx-comptroller-franchise-tax\u001f32000000001").digest("hex").slice(0, 32);
    expect(recordIdOf("tx-comptroller-franchise-tax", ["32000000001"])).toBe(expected);
    expect(recordIdOf("tx-comptroller-franchise-tax", ["32000000001"])).toHaveLength(32);
  });

  it("keys a withheld record's id: distinct per outlet, unsearchable without the key, never the plain digest", () => {
    const key = Buffer.alloc(32, 1);
    const one = withheldRecordIdOf(key, "tx-comptroller-sales-tax", ["32055555555", "1"]);
    const two = withheldRecordIdOf(key, "tx-comptroller-sales-tax", ["32055555555", "2"]);
    expect(one).not.toBe(two);
    expect(one).toBe(createHmac("sha256", key).update("tx-comptroller-sales-tax\u001f32055555555\u001f1").digest("hex").slice(0, 32));
    expect(one).not.toBe(recordIdOf("tx-comptroller-sales-tax", ["32055555555", "1"]));
    expect(withheldRecordIdOf(Buffer.alloc(32, 2), "tx-comptroller-sales-tax", ["32055555555", "1"])).not.toBe(one);
    expect(() => withheldRecordIdOf(Buffer.alloc(16), "x", ["1"])).toThrow(/32 bytes/);
    expect(recordIdKeyFingerprint(key)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("creates the key once with mode 0600, never overwrites it, and fails closed without it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "t3-key-"));
    try {
      const file = path.join(dir, "keys", "record-id.key");
      expect(() => readRecordIdKey(file)).toThrow(/no record-id key/);
      const created = await initRecordIdKey(file);
      expect(created.created).toBe(true);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      const text = await readFile(file, "utf8");
      const again = await initRecordIdKey(file);
      expect(again).toMatchObject({ created: false, fingerprint: created.fingerprint });
      expect(await readFile(file, "utf8")).toBe(text);
      expect(recordIdKeyFingerprint(readRecordIdKey(file))).toBe(created.fingerprint);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
