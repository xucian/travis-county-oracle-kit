# Travis County, TX appraisal transform (custom code)

Runtime: Node 22.18+, no dependencies beyond the standard library. One parcel per call.

Input: a working directory holding `input.json` in the `travis.parcel-input.v1` shape the
adapter materializes from a seed row (`src/counties/travis/adapter.mjs#materializeParcelInput`):
`propId`, `geoId`, `request` (the TCAD bulk export GET actually made), `snapshot`, `tcad`
(the retained export columns), `situs`, and `geometry` (the TNR feature with the page query
that returned it, or null).

Command:

```bash
node counties/travis/transforms/transform.mjs --work-dir <parcel-dir> --manifest <lexicon-manifest.json>
```

Output: `<parcel-dir>/data/*.json` in the kit output contract: County entities and
relationships, the Seed entities (`property_seed.json`, `unnormalized_address.json`,
`relationship_address_has_parcel.json`, `relationship_property_seed_has_unnormalized_address.json`)
and both data-group roots named by the County and Seed schema CIDs of the manifest passed in
(resolved by the caller from `https://lexicon.elephant.xyz/api/manifest`; never hardcoded).

Known lexicon gaps (kept in `source_payload`, recorded in `docs/travis-county-findings.md`):
`geo_id`, the TCAD state code and neighborhood code, the printed owner string and owner key.
`address.county_name` is omitted and `unnormalized_address.county_jurisdiction` is `Travis`
although the live enum lacks it (`docs/travis-lexicon-county-enum-request.md`).

Acceptance is `elephant-cli validate`, `hash` and `validate <car>` on the output, as for any
transform; this README states the runtime, the command and the inputs so Oracle can run it
without the author.
