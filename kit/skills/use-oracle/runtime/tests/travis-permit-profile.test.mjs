import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyRoofAgePermit,
  compileRoofAgeProfile,
  estimateRoofAge,
} from "../src/roof-age/estimator.js";
import {
  ACCESSORY_TERMS,
  CLOSED_STATUSES,
  EXCLUSION_TERMS,
  EXPIRED_STATUS,
  LINK_CONFIDENCE,
  LINK_METHODS,
  NEW_BUILDING_PERMIT_CLASSES,
  OBSERVED_UNMAPPED_STATUSES,
  OPEN_STATUSES,
  PARCEL_LINK_VERSION,
  REPAIR_TERMS,
  REPLACEMENT_TERMS,
  ROOFING_WORK_CLASSES,
  STATUS_GROUP_VERSION,
  TCAD_ID_EVIDENCE_VERSION,
  TCAD_PERMIT_LISTING_VERSION,
  TCAD_ID_NORMALIZATION_VERSION,
  TRAVIS_PERMIT_SOURCE_SYSTEM,
  TRAVIS_ROOF_AGE_PROFILE_VERSION,
  WORK_CLASSIFIER_VERSION,
  classifyDateEvidence,
  classifyLifecycleStatus,
  classifyRoofWork,
  classifyStatusGroup,
  compiledTravisRoofAgeProfile,
  linkPermitToParcel,
  normalizeSourceValue,
  normalizeWorkText,
  proveDigitsOnlyNormalization,
  summarizePermitRow,
  tcadIdEvidence,
  toRoofAgePermitEvidence,
  travisRoofAgeProfile,
} from "../src/counties/travis/permit-profile.mjs";

const RUNTIME_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_FIXTURES = path.join(RUNTIME_ROOT, "fixtures", "travis-permits", "profile");
const SOCRATA_FIXTURES = path.join(RUNTIME_ROOT, "fixtures", "travis-permits", "socrata");
const AS_OF_DATE = "2026-10-16";

async function loadJson(dir, name) {
  return JSON.parse(await readFile(path.join(dir, name), "utf8"));
}

function row(overrides = {}) {
  return {
    permit_number: "2021-015319 BP",
    permittype: "BP",
    description: "RE-ROOF RESIDENCE",
    work_class: "Repair",
    permit_class: "R- 435 Renovations/Remodel",
    status_current: "Final",
    applieddate: "2021-02-02T00:00:00.000",
    issue_date: "2021-02-02T00:00:00.000",
    statusdate: "2021-05-25T00:00:00.000",
    expiresdate: "2021-05-25T00:00:00.000",
    completed_date: "2021-05-25T00:00:00.000",
    tcad_id: "0403010404",
    ...overrides,
  };
}

describe("Travis status groups (api-contract.md)", () => {
  it("maps every fixture case exactly, with needs_review for anything unmapped", async () => {
    const fixture = await loadJson(PROFILE_FIXTURES, "status-group.json");
    expect(fixture.version).toBe(STATUS_GROUP_VERSION);
    for (const testCase of fixture.cases) {
      const result = classifyStatusGroup({
        statusCurrent: testCase.status_current,
        completedDateEvidence: { evidenceState: testCase.completed_date_evidence },
      });
      expect(result.statusGroup, `${JSON.stringify(testCase.status_current)} / ${testCase.completed_date_evidence}`).toBe(
        testCase.expected,
      );
      expect(result.version).toBe(STATUS_GROUP_VERSION);
    }
  });

  it("maps lifecycle for the estimator: only Final is completed", async () => {
    const fixture = await loadJson(PROFILE_FIXTURES, "status-group.json");
    for (const testCase of fixture.lifecycle_cases) {
      expect(classifyLifecycleStatus(testCase.status_current), JSON.stringify(testCase.status_current)).toBe(
        testCase.expected,
      );
    }
  });

  it("accounts for every status_current value observed in the export on 2026-10-16", async () => {
    const counts = await loadJson(SOCRATA_FIXTURES, "status_counts.json");
    const mapped = new Set([...OPEN_STATUSES, ...CLOSED_STATUSES, EXPIRED_STATUS].map(normalizeSourceValue));
    const unmapped = new Set(OBSERVED_UNMAPPED_STATUSES.map(normalizeSourceValue));
    const unknown = [];
    for (const entry of counts) {
      const value = normalizeSourceValue(entry.status_current);
      if (value === "") continue;
      if (!mapped.has(value) && !unmapped.has(value)) unknown.push(entry.status_current);
    }
    expect(unknown, "new status values need a mapping decision").toEqual([]);
    for (const value of OBSERVED_UNMAPPED_STATUSES) {
      expect(classifyStatusGroup({ statusCurrent: value }).statusGroup).toBe("needs_review");
      expect(classifyLifecycleStatus(value)).toBe("needs_review");
    }
  });
});

describe("Travis date evidence", () => {
  it("classifies every fixture case into the kit's evidence states", async () => {
    const fixture = await loadJson(PROFILE_FIXTURES, "date-evidence.json");
    for (const testCase of fixture.cases) {
      const result = classifyDateEvidence(testCase.raw, {
        asOfDate: fixture.as_of_date,
        notBefore: testCase.not_before,
      });
      expect(result.evidenceState, JSON.stringify(testCase)).toBe(testCase.expected_state);
      expect(result.value, JSON.stringify(testCase)).toBe(testCase.expected_value);
      expect(result.reason, JSON.stringify(testCase)).toBe(testCase.reason);
    }
  });

  it("rejects a malformed as-of date instead of guessing", () => {
    expect(() => classifyDateEvidence("2021-05-25", { asOfDate: "10/16/2026" })).toThrow(/asOfDate/);
  });
});

describe("Travis work classification (exact terms, no regex at query time)", () => {
  it("normalizes punctuation and case into whole-word terms", () => {
    expect(normalizeWorkText("Re-Roof / re  roof")).toBe(" RE ROOF RE ROOF ");
    expect(normalizeWorkText(null)).toBe("");
  });

  it("keeps the term tables disjoint", () => {
    const all = [...REPLACEMENT_TERMS, ...REPAIR_TERMS, ...ACCESSORY_TERMS, ...EXCLUSION_TERMS];
    expect(new Set(all).size).toBe(all.length);
    for (const term of all) expect(term).toBe(normalizeWorkText(term).trim());
  });

  it("classifies every fixture case with the expected rule", async () => {
    const fixture = await loadJson(PROFILE_FIXTURES, "work-class.json");
    expect(fixture.version).toBe(WORK_CLASSIFIER_VERSION);
    for (const testCase of fixture.cases) {
      const result = classifyRoofWork({
        permitType: testCase.permittype,
        description: testCase.description,
        workClass: testCase.work_class,
        permitClass: testCase.permit_class,
      });
      expect(result.roofWorkClass, testCase.name).toBe(testCase.expected);
      expect(result.basis, testCase.name).toBe(testCase.basis);
      expect(result.version).toBe(WORK_CLASSIFIER_VERSION);
    }
  });

  it("retains the matched source terms as evidence", () => {
    const result = classifyRoofWork({
      permitType: "BP",
      description: "Re-roof and install solar panels",
      workClass: "Remodel",
      permitClass: "R- 435 Renovations/Remodel",
    });
    expect(result.matchedTerms.replacement).toEqual(["RE ROOF"]);
    expect(result.matchedTerms.exclusion).toEqual(["SOLAR"]);
    expect(result.termEvidence).toEqual([
      { field: "description", term: "SOLAR" },
      { field: "description", term: "RE ROOF" },
    ]);
  });

  it("only uses new-building permit classes that the export actually prints", async () => {
    const counts = await loadJson(SOCRATA_FIXTURES, "permit_class_counts.json");
    const observed = new Set(counts.map((entry) => normalizeSourceValue(entry.permit_class)).filter(Boolean));
    for (const permitClass of NEW_BUILDING_PERMIT_CLASSES) {
      expect(observed.has(normalizeSourceValue(permitClass)), permitClass).toBe(true);
    }
    expect(NEW_BUILDING_PERMIT_CLASSES).not.toContain("C-1000 Commercial Remodel");
    expect(NEW_BUILDING_PERMIT_CLASSES).not.toContain("R- 438 Residential Garage/Carport Addn");
  });

  it("derives is_roofing and is_reroof from the class only", () => {
    expect(ROOFING_WORK_CLASSES).toEqual([
      "primary_roof_replacement",
      "primary_roof_new_construction",
      "repair_or_coating",
      "accessory_roof",
    ]);
    const summary = summarizePermitRow(row(), { asOfDate: AS_OF_DATE });
    expect(summary.isRoofing).toBe(true);
    expect(summary.isReroof).toBe(true);
    const repair = summarizePermitRow(row({ description: "Roof repair" }), { asOfDate: AS_OF_DATE });
    expect(repair.isRoofing).toBe(true);
    expect(repair.isReroof).toBe(false);
    const review = summarizePermitRow(row({ description: "paint roof trim" }), { asOfDate: AS_OF_DATE });
    expect(review.roofWorkClass).toBe("needs_review");
    expect(review.isRoofing).toBe(false);
  });
});

describe("Travis tcad_id evidence, normalization proof and parcel link", () => {
  it("classifies every evidence fixture case", async () => {
    const fixture = await loadJson(PROFILE_FIXTURES, "tcad-id.json");
    expect(fixture.version).toBe(TCAD_ID_NORMALIZATION_VERSION);
    expect(fixture.evidence_version).toBe(TCAD_ID_EVIDENCE_VERSION);
    for (const testCase of fixture.evidence_cases) {
      const result = tcadIdEvidence(testCase.raw);
      expect(result.evidenceState, JSON.stringify(testCase.raw)).toBe(testCase.expected_state);
      expect(result.value, JSON.stringify(testCase.raw)).toBe(testCase.expected_value);
      if (testCase.reason) expect(result.reason, JSON.stringify(testCase.raw)).toBe(testCase.reason);
    }
  });

  it("proves or disproves the digits-only normalization over a roll", async () => {
    const fixture = await loadJson(PROFILE_FIXTURES, "tcad-id.json");
    for (const testCase of fixture.proof_cases) {
      const proof = proveDigitsOnlyNormalization(testCase.geo_ids);
      expect(proof.normalizationVersion).toBe(TCAD_ID_NORMALIZATION_VERSION);
      expect(proof.oneToOne, testCase.name).toBe(testCase.expected_one_to_one);
      if (testCase.expected_collisions !== undefined) {
        expect(proof.collisions, testCase.name).toHaveLength(testCase.expected_collisions);
      }
      if (testCase.expected_checked !== undefined) {
        expect(proof.checkedCount, testCase.name).toBe(testCase.expected_checked);
      }
    }
  });

  it("links exactly as printed first and never from a quarantined id", async () => {
    const fixture = await loadJson(PROFILE_FIXTURES, "tcad-id.json");
    for (const testCase of fixture.link_cases) {
      const result = linkPermitToParcel({
        tcadId: testCase.tcad_id,
        parcelsByGeoId: new Map(Object.entries(testCase.parcels_by_geo_id)),
      });
      expect(result.propertyId, testCase.name).toBe(testCase.expected_property_id);
      expect(result.propertyLink?.match_method ?? null, testCase.name).toBe(testCase.expected_match_method);
      expect(result.unlinkedReason, testCase.name).toBe(testCase.expected_unlinked_reason);
    }
  });

  it("uses the digits fallback only with a one-to-one proof and records the version", () => {
    const parcelsByGeoId = new Map([["0219080719", ["123456"]]]);
    const parcelsByDigits = new Map([["0219080719", ["123456"]]]);
    const withoutProof = linkPermitToParcel({ tcadId: "0219080719", parcelsByGeoId: new Map() });
    expect(withoutProof.unlinkedReason).toBe("no_candidate");

    const disproved = linkPermitToParcel({
      tcadId: "0219080719",
      parcelsByGeoId: new Map(),
      digitsFallback: { proof: proveDigitsOnlyNormalization(["0219080719", "02-1908-0719"]), parcelsByDigits },
    });
    expect(disproved.unlinkedReason).toBe("no_candidate");

    const proven = linkPermitToParcel({
      tcadId: "0219080719",
      parcelsByGeoId: new Map(),
      digitsFallback: { proof: proveDigitsOnlyNormalization(["0219080719"]), parcelsByDigits },
    });
    expect(proven.propertyId).toBe("123456");
    expect(proven.propertyLink).toEqual({
      match_method: "normalized_digits",
      normalization_version: TCAD_ID_NORMALIZATION_VERSION,
      confidence: "normalized",
    });

    const exact = linkPermitToParcel({ tcadId: "0219080719", parcelsByGeoId });
    expect(exact.propertyLink).toEqual({ match_method: "exact", normalization_version: null, confidence: "exact" });
  });

  it("reads TCAD's permit listing only for a retired id, and links only to exactly one current account (ruling 25.10)", async () => {
    const fixture = await loadJson(PROFILE_FIXTURES, "tcad-id.json");
    expect(fixture.parcel_link_version).toBe(PARCEL_LINK_VERSION);
    expect(fixture.listing_version).toBe(TCAD_PERMIT_LISTING_VERSION);
    expect(LINK_METHODS).toEqual(["exact", "normalized_digits", "tcad_permit_listing"]);
    const sourceSha256 = "a".repeat(64);
    for (const testCase of fixture.listing_cases) {
      const reads = [];
      const permitListing = {
        version: TCAD_PERMIT_LISTING_VERSION,
        sourceSha256,
        accountsFor: (number) => {
          reads.push(number);
          return testCase.listing[String(number).trim()] ?? [];
        },
        rollPropIds: new Set(testCase.roll),
      };
      const result = linkPermitToParcel({ tcadId: testCase.tcad_id, permitNumber: testCase.permit_number, parcelsByGeoId: new Map(Object.entries(testCase.parcels_by_geo_id)), permitListing });
      expect(result.propertyId, testCase.name).toBe(testCase.expected_property_id);
      expect(result.propertyLink?.match_method ?? null, testCase.name).toBe(testCase.expected_match_method);
      expect(result.unlinkedReason, testCase.name).toBe(testCase.expected_unlinked_reason);
      expect(result.listing, testCase.name).toEqual(testCase.expected_listing);
      // The listing is consulted only where the printed id names no current parcel.
      expect(reads.length > 0, testCase.name).toBe(testCase.expected_listing !== null);
      if (testCase.expected_match_method === "tcad_permit_listing") {
        expect(result.propertyLink, testCase.name).toEqual({ match_method: "tcad_permit_listing", normalization_version: null, confidence: LINK_CONFIDENCE.tcad_permit_listing, listing_version: TCAD_PERMIT_LISTING_VERSION, listing_source_sha256: sourceSha256 });
      }
    }
    expect(LINK_CONFIDENCE.tcad_permit_listing).toBe("official_listing");
    // Without the listing a retired id stays no_candidate (the v2 behaviour).
    expect(linkPermitToParcel({ tcadId: "0999999999", permitNumber: "2021-000003 BP", parcelsByGeoId: new Map() })).toMatchObject({ propertyId: null, unlinkedReason: "no_candidate", listing: null });
  });
});

describe("Travis roof-age profile through the bundled estimator", () => {
  it("compiles deterministically and fails closed on unmapped vocabulary", () => {
    expect(compiledTravisRoofAgeProfile.version).toBe(TRAVIS_ROOF_AGE_PROFILE_VERSION);
    expect(compiledTravisRoofAgeProfile.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(compileRoofAgeProfile(travisRoofAgeProfile).sha256).toBe(compiledTravisRoofAgeProfile.sha256);
    expect(compiledTravisRoofAgeProfile.sources).toHaveLength(1);
    expect(compiledTravisRoofAgeProfile.sources[0].sourceSystem).toBe(TRAVIS_PERMIT_SOURCE_SYSTEM);

    const finalReroof = classifyRoofAgePermit(toRoofAgePermitEvidence(row(), { asOfDate: AS_OF_DATE }), compiledTravisRoofAgeProfile);
    expect(finalReroof).toMatchObject({ status: "completed", workClassification: "primary_roof_replacement" });

    const pending = classifyRoofAgePermit(
      toRoofAgePermitEvidence(row({ status_current: "Pending" }), { asOfDate: AS_OF_DATE }),
      compiledTravisRoofAgeProfile,
    );
    expect(pending.status).toBe("needs_review");

    const ambiguous = classifyRoofAgePermit(
      toRoofAgePermitEvidence(row({ description: "paint roof trim" }), { asOfDate: AS_OF_DATE }),
      compiledTravisRoofAgeProfile,
    );
    expect(ambiguous.workClassification).toBe("needs_review");
  });

  it("uses statusdate as the close date only when the permit is Final", () => {
    const finalEvidence = toRoofAgePermitEvidence(row(), { asOfDate: AS_OF_DATE });
    expect(finalEvidence.completionDate).toEqual({ value: "2021-05-25", evidenceState: "confirmed_present" });
    expect(finalEvidence.closeDate).toEqual({ value: "2021-05-25", evidenceState: "confirmed_present" });
    expect(finalEvidence.chronologyStartDate).toEqual({ value: "2021-02-02", evidenceState: "confirmed_present" });

    const active = toRoofAgePermitEvidence(
      row({ status_current: "Active", completed_date: "", statusdate: "2026-09-01T00:00:00.000" }),
      { asOfDate: AS_OF_DATE },
    );
    expect(active.completionDate).toEqual({ value: null, evidenceState: "unknown" });
    expect(active.closeDate).toEqual({ value: null, evidenceState: "unknown" });

    const artifact = toRoofAgePermitEvidence(row({ completed_date: "1900-05-03T00:00:00.000" }), { asOfDate: AS_OF_DATE });
    expect(artifact.completionDate.evidenceState).toBe("invalid_quarantined");
  });

  function estimatorInput(permits, builtYear = 1998) {
    return {
      asOfDate: AS_OF_DATE,
      builtYear: {
        year: builtYear,
        evidenceState: "confirmed_present",
        sourceSystem: "travis_appraiser",
        sourceRecordId: "123456",
        field: "property_structure_built_year",
      },
      permits,
      historicalCoverage: { state: "partial", caveats: ["partial_history"] },
    };
  }

  it("anchors on the latest completed re-roof with high confidence", () => {
    const estimate = estimateRoofAge(
      estimatorInput([
        toRoofAgePermitEvidence(row(), { asOfDate: AS_OF_DATE }),
        toRoofAgePermitEvidence(
          row({ permit_number: "2010-000001 BP", applieddate: "2010-01-04T00:00:00.000", statusdate: "2010-03-01T00:00:00.000", completed_date: "2010-03-01T00:00:00.000" }),
          { asOfDate: AS_OF_DATE },
        ),
      ]),
      travisRoofAgeProfile,
    );
    expect(estimate.anchor).toMatchObject({
      type: "permit_terminal_date",
      date: "2021-05-25",
      source: { sourceSystem: TRAVIS_PERMIT_SOURCE_SYSTEM, sourceRecordId: "2021-015319 BP", dateField: "completionDate" },
    });
    expect(estimate.confidence).toBe("high");
    expect(estimate.estimatedAgeYears).toBe(5);
    expect(estimate.historicalCoverage).toEqual({ state: "partial", caveats: ["partial_history"] });
    expect(estimate.policy.profileVersion).toBe(TRAVIS_ROOF_AGE_PROFILE_VERSION);
    expect(estimate.policy.profileSha256).toBe(compiledTravisRoofAgeProfile.sha256);
  });

  it("never resets age from an open, expired, repair or accessory permit", () => {
    const estimate = estimateRoofAge(
      estimatorInput([
        toRoofAgePermitEvidence(row({ permit_number: "open", status_current: "Active", completed_date: "" }), { asOfDate: AS_OF_DATE }),
        toRoofAgePermitEvidence(row({ permit_number: "expired", status_current: "Expired", completed_date: "" }), { asOfDate: AS_OF_DATE }),
        toRoofAgePermitEvidence(row({ permit_number: "repair", description: "Roof repair" }), { asOfDate: AS_OF_DATE }),
        toRoofAgePermitEvidence(row({ permit_number: "carport", description: "New carport" }), { asOfDate: AS_OF_DATE }),
        toRoofAgePermitEvidence(row({ permit_number: "review", status_current: "Pending" }), { asOfDate: AS_OF_DATE }),
      ]),
      travisRoofAgeProfile,
    );
    expect(estimate.anchor).toMatchObject({ type: "property_built_year", year: 1998 });
    expect(estimate.confidence).toBe("low");
    expect(estimate.evidence.permitOutcomeCounts).toMatchObject({
      excludedOpenPrimaryRoofReplacement: 1,
      excludedNonCompletedResettingWork: 1,
      excludedNonResettingWork: 2,
      excludedNeedsReview: 1,
    });
  });

  it("falls back to a completed new-construction permit with medium confidence", () => {
    const estimate = estimateRoofAge(
      estimatorInput([
        toRoofAgePermitEvidence(
          row({
            permit_number: "2015-000002 BP",
            description: "New single family residence",
            work_class: "New",
            permit_class: "R- 101 Single Family Houses",
            applieddate: "2015-01-05T00:00:00.000",
            statusdate: "2015-11-20T00:00:00.000",
            completed_date: "2015-11-20T00:00:00.000",
          }),
          { asOfDate: AS_OF_DATE },
        ),
      ]),
      travisRoofAgeProfile,
    );
    expect(estimate.anchor).toMatchObject({ type: "permit_terminal_date", date: "2015-11-20" });
    expect(estimate.confidence).toBe("medium");
    expect(estimate.workClassification).toBe("primary_roof_new_construction");
  });

  it("summarizes the sampled export rows without throwing", async () => {
    const sample = await loadJson(SOCRATA_FIXTURES, "sample-records.json");
    expect(sample.record_count).toBeGreaterThan(0);
    for (const record of sample.records) {
      expect(Object.keys(record).some((key) => key.startsWith("applicant"))).toBe(false);
      const summary = summarizePermitRow(record, { asOfDate: AS_OF_DATE });
      expect(["open", "stalled", "closed", "needs_review"]).toContain(summary.statusGroup);
      expect(summary.versions.roofAgeProfileSha256).toBe(compiledTravisRoofAgeProfile.sha256);
    }
    const byNumber = Object.fromEntries(sample.records.map((record) => [record.permit_number, record]));
    expect(summarizePermitRow(byNumber["2021-015319 BP"], { asOfDate: AS_OF_DATE })).toMatchObject({
      statusGroup: "closed",
      lifecycleStatus: "completed",
      roofWorkClass: "primary_roof_replacement",
      isReroof: true,
      completedDateEvidence: { value: "2021-05-25", evidenceState: "confirmed_present" },
      tcadIdEvidence: { value: "0403010404", evidenceState: "confirmed_present" },
    });
  });
});

describe("Travis property_improvement enum tables (decisions.md section 25.7)", async () => {
  const { CONTRACTOR_TYPE_BY_TRADE, IMPROVEMENT_ACTION_BY_WORK_CLASS, IMPROVEMENT_ENUMS_VERSION, IMPROVEMENT_STATUS_BY_STATUS, IMPROVEMENT_TYPE_BY_PERMITTYPE, mapImprovementEnums } = await import("../src/counties/travis/permit-profile.mjs");
  it("maps every fixture case exactly and leaves unlisted values null", async () => {
    const fixture = await loadJson(PROFILE_FIXTURES, "improvement-enums.json");
    expect(fixture.version).toBe(IMPROVEMENT_ENUMS_VERSION);
    for (const testCase of fixture.cases) expect(mapImprovementEnums(testCase.row), JSON.stringify(testCase.row)).toEqual(testCase.expected);
  });

  it("only names members of the live schema", async () => {
    const { live_members: members } = await loadJson(PROFILE_FIXTURES, "improvement-enums.json");
    for (const member of Object.values(IMPROVEMENT_TYPE_BY_PERMITTYPE)) expect(members.improvement_type).toContain(member);
    for (const member of Object.values(IMPROVEMENT_STATUS_BY_STATUS)) expect(members.improvement_status).toContain(member);
    for (const member of Object.values(IMPROVEMENT_ACTION_BY_WORK_CLASS)) expect(members.improvement_action).toContain(member);
    for (const member of Object.values(CONTRACTOR_TYPE_BY_TRADE)) expect(members.contractor_type).toContain(member);
    expect(Object.values(IMPROVEMENT_STATUS_BY_STATUS)).not.toContain("InProgress");
  });
});
