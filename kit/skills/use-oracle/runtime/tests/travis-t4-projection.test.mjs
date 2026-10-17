import { describe, expect, it } from "vitest";

import { GATE_SECONDS, projectFullRun } from "../src/counties/travis/t4-projection.mjs";

const run = (overrides = {}) => ({
  run_dir: "data/travis/runs/x-t4-feasibility-1000",
  seed: { rows: 1000 },
  permits: { permits_published: 4000 },
  groups: { property_improvement: 500 },
  timings: {
    stages: {
      verify_capture: { ms: 10_000, items: 1 },
      roll_index: { ms: 7_000, items: 441_961 },
      permit_link_pass: { ms: 90_000, items: 2_380_707 },
      appraisal_transform: { ms: 6_000, items: 1000 },
      cli_county_validate: { ms: 400_000, items: 1000 },
      permit_transform: { ms: 2_000, items: 1000 },
      cli_property_improvement_validate: { ms: 100_000, items: 500 },
      ...overrides,
    },
  },
});
const harvest = { elapsed_ms: 318_600, rows: 2_380_707, bytes: 1_813_784_373, requests: 274 };
const full = { rows: 2_380_707, linked: 1_978_992, linked_parcels: 232_640, seed_rows: 441_961 };

describe("T4 48-hour projection", () => {
  it("keeps once-per-run stages at their measured cost and scales the rest", () => {
    const projection = projectFullRun({ run: run(), harvest, full });
    const byStage = Object.fromEntries(projection.stages.map((line) => [line.stage, line]));
    expect(byStage.socrata_harvest).toMatchObject({ scale: 1, projected_s: 318.6 });
    expect(byStage.permit_link_pass).toMatchObject({ scale: 1, projected_s: 90 });
    expect(byStage.cli_county_validate.scale).toBeCloseTo(441.961, 3);
    expect(byStage.cli_county_validate.projected_s).toBeCloseTo(400 * 441.961, 0);
    // Permit stages use the larger ratio: 232,640 / 500 = 465.28 over 1,978,992 / 4,000 = 494.748.
    expect(projection.scales.permit_group_used).toBeCloseTo(494.748, 3);
    expect(byStage.cli_property_improvement_validate.projected_s).toBeCloseTo(100 * 494.748, 0);
    expect(projection.source_acquisition).toMatchObject({ within_gate: true });
    const total = projection.stages.reduce((sum, line) => sum + line.projected_s, 0);
    expect(projection.full_run.projected_s).toBeCloseTo(total, 0);
    expect(projection.full_run.within_gate).toBe(total <= GATE_SECONDS);
    expect(projection.slowest_stages[0].stage).toBe("cli_county_validate");
  });

  it("projects the sharded variant from a measured shard benchmark", () => {
    const projection = projectFullRun({ run: run(), harvest, full, shardBench: { county: { parcels: 1000, shards: 4, wall_ms: 100_000, all_passed: true }, property_improvement: { parcels: 500, shards: 4, wall_ms: 25_000, all_passed: false } } });
    const sequential = projection.full_run.projected_s;
    // The county validate line (400 s x 441.961) is replaced by 100 s x 441.961; the failed permit bench is ignored.
    expect(projection.full_run_sharded.projected_s).toBeCloseTo(sequential - 300 * 441.961, -1);
    expect(Object.keys(projection.full_run_sharded.groups)).toEqual(["county"]);
    expect(projectFullRun({ run: run(), harvest, full }).full_run_sharded).toBeNull();
  });

  it("flags a run past the gate", () => {
    const projection = projectFullRun({ run: run({ cli_county_validate: { ms: 1_000_000, items: 1000 } }), harvest, full });
    expect(projection.full_run.within_gate).toBe(false);
    expect(projection.full_run.margin_h).toBeLessThan(0);
  });
});
