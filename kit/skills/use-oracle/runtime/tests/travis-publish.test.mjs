import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildPublishManifest, gatewayCheck, parseCid, pinByCid, pinFile, rawCid } from "../src/counties/travis/publish.mjs";

const RUN_RECORD = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "docs", "evidence", "travis-t2-run-20261017T072132Z.json");

describe("T2 publication helpers (staged, never run by the agent)", () => {
  it("parses CIDs of both codecs into their sha2-256 digests", () => {
    const bytes = Buffer.from('{"a":1}');
    const digest = createHash("sha256").update(bytes).digest("hex");
    const raw = parseCid(rawCid(bytes));
    expect(raw.codec).toBe("raw");
    expect(Buffer.from(raw.digest).toString("hex")).toBe(digest);
    const dagJson = parseCid("baguqeerahe3ecgiyigcgdg6gmxqsmc5ylzlucf4kb3n5xcqi5tvtiebpv2ta");
    expect(dagJson).toMatchObject({ codec: "dag-json", multihashCode: 0x12 });
    expect(dagJson.digest).toHaveLength(32);
    expect(rawCid("")).toBe("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
  });

  it("checks a gateway by comparing the block's sha2-256 with the CID's multihash", async () => {
    const bytes = Buffer.from('{"b":2}');
    const cid = rawCid(bytes);
    const ok = await gatewayCheck({ cid, gateway: "https://ipfs.io", fetchImpl: async (url) => (expect(url).toBe(`https://ipfs.io/ipfs/${cid}?format=raw`), new Response(bytes)) });
    expect(ok).toMatchObject({ status: 200, size: bytes.length, multihash: "match", codec: "raw" });
    const bad = await gatewayCheck({ cid, gateway: "https://dweb.link", fetchImpl: async () => new Response("tampered") });
    expect(bad.multihash).toBe("mismatch");
    const down = await gatewayCheck({ cid, gateway: "https://dweb.link", fetchImpl: async () => { throw new Error("timeout"); } });
    expect(down).toMatchObject({ status: null, multihash: "unverified" });
  });

  it("pins by CID and waits for Pinata to list the pin", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push([url, init?.method ?? "GET", init?.body ?? null]);
      if (url.endsWith("/pinning/pinByHash")) return new Response(JSON.stringify({ id: "job", status: "prechecking" }));
      return new Response(JSON.stringify({ count: calls.length > 2 ? 1 : 0 }));
    };
    const pin = await pinByCid({ cid: "bafkreiexample", name: "travis-county", jwt: "test-token", fetchImpl, pollMs: 1, attempts: 5 });
    expect(pin).toMatchObject({ pinned: true, checks: 2 });
    expect(calls[0]).toEqual(["https://api.pinata.cloud/pinning/pinByHash", "POST", JSON.stringify({ hashToPin: "bafkreiexample", pinataMetadata: { name: "travis-county" } })]);
  });

  it("pins a small file with cidVersion 1 and refuses a CID other than its raw CID", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "travis-publish-"));
    try {
      const file = path.join(dir, "manifest.json");
      await writeFile(file, '{"c":3}');
      const expected = rawCid('{"c":3}');
      expect(await pinFile({ file, name: "m", jwt: "t", fetchImpl: async () => new Response(JSON.stringify({ IpfsHash: expected })) })).toMatchObject({ cid: expected });
      await expect(pinFile({ file, name: "m", jwt: "t", fetchImpl: async () => new Response(JSON.stringify({ IpfsHash: "bafybeiother" })) })).rejects.toThrow(/expected/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("builds publish/<run_id>/manifest.json from the run record, refusing unmatched roots or missing pins", async () => {
    const runRecord = JSON.parse(await readFile(RUN_RECORD, "utf8"));
    const archive = runRecord.cars.find((car) => car.kind === "archive").root_cid;
    const tables = runRecord.cars.find((car) => car.kind === "tables").root_cid;
    const inputs = {
      runRecord,
      carUpload: { root: archive, gatewayUrl: `https://ipfs.filebase.io/ipfs/${archive}` },
      tablesUpload: { root: tables, gatewayUrl: `https://ipfs.filebase.io/ipfs/${tables}` },
      gatewayChecks: [],
      pins: [{ cid: archive, pinned: true }, { cid: tables, pinned: true }],
      sampleExtract: { property_cid: "p", data_group_root_cid: "d" },
    };
    const manifest = buildPublishManifest(inputs);
    expect(manifest.objects).toHaveLength(2 + runRecord.tables.parts.length + 1);
    expect(manifest.objects.map((object) => object.name)).not.toContain("manifest.json");
    expect(manifest.indexes).toEqual({ county_index: archive, county_tables: tables });
    expect(manifest.cars.every((car) => car.readback_url)).toBe(true);
    expect(() => buildPublishManifest({ ...inputs, carUpload: { root: "bafkreiother" } })).toThrow(/not the recorded/);
    expect(() => buildPublishManifest({ ...inputs, pins: [] })).toThrow(/not pinned on Pinata/);
  });
});
