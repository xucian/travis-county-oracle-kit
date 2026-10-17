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
relationships, `relationship_address_has_parcel.json` (the County group's `address.json` to
`parcel.json`), and both data-group roots named by the County and Seed schema CIDs of the
manifest passed in (resolved by the caller from `https://lexicon.elephant.xyz/api/manifest`;
never hardcoded). The Seed root carries `address_has_parcel` only, the root
`elephant-cli transform` writes itself (`writeSeedGroup`, elephant-cli #251). `property_seed`
and `unnormalized_address` are never written into `data/`; the adapter keeps both beside
`data/` for internal reconciliation (assignment decisions.md section 22).

Known lexicon gaps (kept in the `source-payload.json` sidecar beside `data/`, recorded in
`docs/travis-county-findings.md`): `geo_id`, the TCAD state code and neighborhood code, the
printed owner string and owner key. No field in the archive names the county:
`address.county_name` is omitted because the live enum lacks `Travis`
(`docs/travis-lexicon-county-enum-request.md`); the county is named by the Atlas page, the run
record and the README manifest.

Acceptance is `elephant-cli validate`, `hash` and `validate <car>` on the output, as for any
transform; this README states the runtime, the command and the inputs so Oracle can run it
without the author.
