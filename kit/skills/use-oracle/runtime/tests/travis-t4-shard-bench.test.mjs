import { describe, expect, it } from "vitest";

import { splitShards } from "../src/counties/travis/t4-shard-bench.mjs";

describe("T4 shard benchmark", () => {
  it("splits parcels round-robin in sorted order and drops empty shards", () => {
    expect(splitShards(["5", "1", "3", "2", "4"], 2)).toEqual([["1", "3", "5"], ["2", "4"]]);
    expect(splitShards(["1"], 4)).toEqual([["1"]]);
  });
});
