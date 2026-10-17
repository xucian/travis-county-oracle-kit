# Kit gap reports from the Travis T2 assessment (draft, not filed)

Drafted 2026-10-17 from the read-only oracle assessment behind assignment decisions.md section 22. Each gap names the
kit file and line at the `travis` branch's base and a one-line fix. Reporting them is the operator's decision.

1. **Seed layout.** `skills/build-county-transform/reference/output-contract.md` 22-25 and 50-52 list
   `property_seed.json`, `unnormalized_address.json` and `address_has_parcel.json` in `data/` and call the Seed group
   mandatory without saying what its root holds. Fix: document the Seed root `elephant-cli transform` writes
   (`address_has_parcel` only, #251) as the contract, and say that a root carrying `property_seed` breaks
   `export-tables` at `44bb182`.
2. **County-label rule.** `skills/build-county-transform/reference/coverage-proof.md` 38 and
   `skills/build-county-transform/SKILL.md` 110 require `county_jurisdiction` and `county_name` to match the county on
   every sample, which cannot hold for a county the lexicon enums lack. Fix: require the match when the enum lists the
   county; otherwise omit both, record the label gap and require a fail-closed wrong-county check.
3. **Columbia safeguard.** `skills/county-appraisal-onboarding/SKILL.md` 188-190 verifies the county only through
   `county_jurisdiction` in the output, which an unlabelled county does not have. Fix: verify the seed row's county and
   FIPS, every `request_identifier`, the source hosts and the geometry bbox (as Travis's `assertTravisIdentity` does).
4. **No enum check in readiness.** `skills/county-readiness-preflight/SKILL.md` 19-48 (rules) and
   `skills/use-oracle/scripts/validate-county-readiness.py` can PASS a county the lexicon county enums lack. Fix: add
   a check of the county against the live manifest's `unnormalized_address.county_jurisdiction` and
   `address.county_name` enums that reports the label gap before seeding.
5. **Unlabelled county.** `skills/use-oracle/reference/car-publication.md` 278-279 notes that the county index records
   no county key, but not that an archive from an unlisted county names its county nowhere. Fix: say that the Atlas
   page and the run evidence then carry the county, and that adding the label later is a new snapshot with new CIDs.
6. **Registry uniqueness.** `skills/use-oracle/reference/car-publication.md` 169 says every CID is unique across the
   registry, but Atlas's `scripts/validate-entry.mjs` checks only `cid` and `tables`, and `schema` repeats by design
   (every county group shares the live County schema CID). Fix: "every archive and tables root is unique; `schema`
   repeats".
7. **Where to report a CLI bug.** `skills/build-county-transform/SKILL.md` 148-150 says a suspected CLI bug is
   reported with a reproduction, but not where or against what. Fix: file it on `elephant-xyz/elephant-cli` against
   the installed commit and main HEAD, with a reproduction from a kit replay fixture against the live manifest (as
   `docs/travis-elephant-cli-issue-property-seed-table-collision.md` does).
8. **Licensing snapshot gate (Travis T3, assignment decisions.md section 23).** `skills/county-permit-adapter/SKILL.md`
   9-13 and `skills/county-ingest-run/SKILL.md` 9-18 block permit harvest until an adequate licensing snapshot exists,
   while `skills/use-oracle/reference/permit-evidence-preflight.md` 221-231, 284-287 and 313-317 block only historical
   qualification of permits without a license number. Fix: state the preflight's rule in both skills (a county whose
   permits print no license number, and a state with no license for the trade, may harvest once the official registry
   and the available licensing snapshots are loaded). Travis follows the preflight, which county-permit-adapter 16-17
   names as the identity procedure.
