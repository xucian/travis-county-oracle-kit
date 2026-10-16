# Lexicon request: add `Travis` to the county enums (draft, not submitted)

Status: **drafted 2026-10-16, not submitted.** Opening the pull request against
`https://github.com/elephant-xyz/lexicon` is an operator action; it is listed as a v1
blocker because without it no Travis property validates.

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

Consequence: the Seed data group every Travis archive must carry requires an
`unnormalized_address` entity with `county_jurisdiction`, so `elephant-cli validate` fails
on every Travis property until the enum includes `Travis`. The transform omits
`address.county_name` meanwhile (allowed, optional) and records the omission as a lexicon
gap; it cannot omit `county_jurisdiction`.

## Requested change

Add `"Travis"` to both enums (same position convention as the other Texas counties, after
`"Ellis"`), republish the two class schemas and the manifest. Optional, for the rest of the
Austin region later: `Williamson`, `Hays`, `Bastrop`, `Caldwell`.

Suggested pull-request title: `feat: add Travis County, TX to the county enums`.

Suggested body:

```text
Adds "Travis" to unnormalized_address.county_jurisdiction and address.county_name.
Travis County, TX (FIPS 48453) is being onboarded through the Oracle county pipeline;
the Seed data group requires county_jurisdiction, so every Travis property fails
validation until the enum carries the county. No other schema changes.
```

## Until it merges

- The Travis adapter keeps `county_jurisdiction: "Travis"` in the output (the correct value)
  and treats the resulting enum error as the known lexicon gap `lexicon-gap-county-enum`;
  the first `elephant-cli validate` of the pilot is expected to report it on every property
  and nothing else. The validation CSV is kept as evidence.
- No hash, upload or Atlas registration happens on an archive that failed validation.
