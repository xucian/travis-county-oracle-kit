# Lexicon request: add `Travis` to the county enums (submitted as elephant-xyz/lexicon#194)

Status: **submitted 2026-10-16** as https://github.com/elephant-xyz/lexicon/pull/194 from the operator's
fork (`xucian/lexicon`, branch `add-travis-county`): the same three-file change as Ellis (#171). The
repository's `tests/model/modelComposition.test.ts` fails on any lexicon edit since #189 pinned the
source digest; the pull request asks the maintainers to rebuild the composition or name the governed
Model route. Validation does not wait for it (assignment decisions.md section 22, 2026-10-17): once the
published manifest includes `Travis`, the county label is added in a new run with new CIDs. The pull
request stays open; its Why is to be replaced by the text in the suggested body below (operator
approval; not posted by the agent).

## Finding

The live manifest (`https://lexicon.elephant.xyz/api/manifest`, read 2026-10-16) resolves
`unnormalized_address` to `bafkreibrfkgavsypoiw5mzvaysuzjd62qaccvvnkbbhgcrtp2othnryhbm` and
`address` to `bafkreiebzvyy6prnwf3dcippii7yysrjesnbxpvcpyqmbs2b67hm2taf2a` (see
`docs/evidence/travis-lexicon-manifest-2026-10-16.json` for the exact map). Both schemas
constrain the county with the same 140-member enum:

- `unnormalized_address.county_jurisdiction` is **required** and enumerated.
- `address.county_name` is optional and enumerated (the Duval transform writes it).

The enum holds the Florida counties, fourteen Texas counties (`Dallas`, `Fort Bend`,
`Collin`, `Hunt`, `Wood`, `Burnet`, `San Patricio`, `Wise`, `Nacogdoches`, `Waller`,
`Cherokee`, `Navarro`, `Medina`, `Ellis`), the California counties and `Allegheny`; it does
**not** contain `Travis`. The source of the enum is `src/data/lexicon.json` in the lexicon
repository (`classes[17].properties.county_jurisdiction.enum` and
`classes[19].properties.county_name.enum` at the `main` revision read on 2026-10-16; no
occurrence of the string `"Travis"` in the file).

Consequence (corrected 2026-10-17): without `Travis` a Travis record cannot name its county.
`address.county_name` has to be omitted, and `unnormalized_address` cannot be written, because its
`county_jurisdiction` is required. Validation is not blocked: the Travis archives use the Seed root
that `elephant-cli transform` writes (`address_has_parcel` only), so they validate against the current
manifest (run of record `20261017T072132Z`: 25 of 25, 0 errors), but no field in them names the county.
The earlier premise, that the Seed group requires `unnormalized_address` and so every Travis property
fails validation until the enum merges, held only for a Seed root that carries it.

## Requested change

Add `"Travis"` to both enums (same position convention as the other Texas counties, after
`"Ellis"`), republish the two class schemas and the manifest. Optional, for the rest of the
Austin region later: `Williamson`, `Hays`, `Bastrop`, `Caldwell`.

Suggested pull-request title: `feat: add Travis County, TX to the county enums`.

Suggested body:

```text
Adds "Travis" to unnormalized_address.county_jurisdiction and address.county_name. No other schema changes.

**Why:** Travis County, TX (FIPS 48453) is being onboarded to an Oracle pipeline. Without `Travis` in these enums a Travis record cannot name its county: `address.county_name` has to be omitted, and `unnormalized_address` cannot be written, because its `county_jurisdiction` is required. The Travis archives use the Seed root that `elephant-cli transform` writes (`address_has_parcel` only), so they validate against the current manifest, but no field in them names the county. Source: the Travis Central Appraisal District's 2026 certified appraisal export (https://traviscad.org/publicinformation).
```

## Until it merges

- The archive omits `address.county_name` and writes no `unnormalized_address`; the adapter keeps
  `county_jurisdiction: "Travis"` internal (its seed files beside `data/`), and `assertTravisIdentity` fails
  closed on a wrong-county record (lexicon gap `lexicon-gap-county-enum`).
- `validate`, `hash`, CAR validation and `export-tables` run against the live manifest; the county is named
  by the Atlas page, the run record and the README manifest.
- After the merge, adding `address.county_name` is a new snapshot with new CIDs: a new run, prior CIDs
  untouched.
