import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createAmendedLexiconServer, rawCid } from "../src/counties/travis/amended-lexicon-server.mjs";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

async function fixtureDir(schemas) {
  const dir = await mkdtemp(path.join(tmpdir(), "travis-amended-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "schemas"));
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ County: { ipfsCid: rawCid(schemas[0]), type: "dataGroup" } }));
  for (const body of schemas) await writeFile(path.join(dir, "schemas", `${rawCid(body)}.json`), body);
  return dir;
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

describe("amended lexicon server", () => {
  it("computes the lexicon's raw CIDs", () => {
    // The live County schema bytes are not in the repo; check the encoding on a known vector instead.
    expect(rawCid("")).toBe("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
  });

  it("serves the amended manifest and schemas, and falls back to the gateways for other CIDs with hash checks", async () => {
    const amended = '{"title":"County"}';
    const unchanged = '{"title":"parcel"}';
    const dir = await fixtureDir([amended]);
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.startsWith("https://bad.example")) return new Response("tampered", { status: 200 });
      return new Response(unchanged, { status: 200 });
    };
    const { server, stats } = await createAmendedLexiconServer({ dir, gateways: ["https://bad.example", "https://good.example"], fetchImpl });
    const base = await listen(server);
    expect(await (await fetch(`${base}/api/manifest`)).json()).toEqual({ County: { ipfsCid: rawCid(amended), type: "dataGroup" } });
    expect(await (await fetch(`${base}/ipfs/${rawCid(amended)}?format=raw`)).text()).toBe(amended);
    expect(await (await fetch(`${base}/ipfs/${rawCid(unchanged)}?format=raw`)).text()).toBe(unchanged);
    expect(calls).toEqual([`https://bad.example/ipfs/${rawCid(unchanged)}?format=raw`, `https://good.example/ipfs/${rawCid(unchanged)}?format=raw`]);
    expect((await fetch(`${base}/ipfs/not-a-cid`)).status).toBe(404);
    expect(stats).toMatchObject({ local: 1, gateway: 1, manifest: 1 });
  });

  it("answers 502 when no gateway returns bytes that hash to the CID", async () => {
    const dir = await fixtureDir(['{"a":1}']);
    const { server } = await createAmendedLexiconServer({ dir, gateways: ["https://bad.example"], fetchImpl: async () => new Response("tampered") });
    const base = await listen(server);
    expect((await fetch(`${base}/ipfs/${rawCid('{"b":2}')}`)).status).toBe(502);
  });

  it("refuses to start when a schema file does not hash to its name", async () => {
    const dir = await fixtureDir(['{"a":1}']);
    await writeFile(path.join(dir, "schemas", `${rawCid('{"a":1}')}.json`), '{"a":2}');
    await expect(createAmendedLexiconServer({ dir })).rejects.toThrow(/does not hash to its CID/);
  });
});
