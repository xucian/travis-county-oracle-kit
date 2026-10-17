# Draft issue for elephant-xyz/elephant-cli (not filed)

Drafted 2026-10-17 for the operator during the Travis County, TX onboarding (assignment decisions.md section 22).
Filing it is the operator's decision; nothing below has been posted.

---

**Title:** `export-tables` refuses an archive whose Seed root carries `property_seed`: "table property_seed has two schemas in this car"

## Summary

`export-tables` names a relationship table after its data-group key and a class table after the class schema title.
The Seed data group's key for the `property_seed` to `unnormalized_address` relationship is `property_seed`, which is
also the `property_seed` class table's name. Any county archive whose Seed root carries that relationship validates,
hashes and passes CAR validation, then `export-tables` stops before writing a row:

```text
❌ Failed to export tables: table property_seed has two schemas in this car: relationship property_seed and bafkreifeyjufurzvdpoanqk43o55fpa534nczvzutd6qq3j6gka7ixbkxi
```

The Seed root that `elephant-cli transform` writes itself (`address_has_parcel` only, #251) is not affected, which is
why the one published county with tables (Jackson, FL) exports.

## Environment

- `@elephant-xyz/cli` 1.58.1 at `44bb182` (main HEAD, 2026-09-25), Node v22.22.0, macOS.
- Live manifest `https://lexicon.elephant.xyz/api/manifest` (sha256 `7084b9334e66eb525d729e2d399f7216960abf30900081aaed194210be760640`):
  Seed `bafkreibhurphpjdq33ysit57jtzmdldgngepsdbsw4vm7esawth2ezgaxu` (keys `address_has_parcel`, `property_seed`),
  `property_seed` class `bafkreifeyjufurzvdpoanqk43o55fpa534nczvzutd6qq3j6gka7ixbkxi`. No `ELEPHANT_*` overrides.

## Reproduction

One property in scripts mode, from the Duval replay fixture of the Soofi kit
(`skills/use-oracle/runtime/fixtures/duval-replay`, parcel `0969250000`):

```bash
# 1. The fixture parcel's capture (input.html, property_seed.json, unnormalized_address.json)
node bin/elephant-county.mjs replay --county duval --fixture fixtures/duval-replay --output ./replay
P=./replay/ingest/0969250000
zip -j county-input.zip $P/input.html $P/property_seed.json $P/unnormalized_address.json
(cd counties/duval/transforms && zip -j ../../../county-scripts.zip ownerMapping.js structureMapping.js layoutMapping.js utilityMapping.js data_extractor.js)
elephant-cli transform --input-zip county-input.zip --scripts-zip county-scripts.zip --output-zip county-transformed.zip
mkdir -p full/0969250000 && unzip -q county-transformed.zip -d full/0969250000

# 2. Add property_seed -> unnormalized_address to the Seed root, with lexicon-valid seed entities
python3 - full/0969250000/data <<'PY'
import json, sys
d = sys.argv[1]
req = {"method": "GET", "url": "https://paopropertysearch.coj.net/Basic/Detail.aspx", "multiValueQueryString": {"RE": ["0969250000R"]}}
json.dump({"parcel_id": "0969250000", "source_http_request": req, "request_identifier": "0969250000R"}, open(f"{d}/property_seed.json", "w"))
json.dump({"full_address": "4200 RIVERSIDE AVE, JACKSONVILLE FL 32205", "county_jurisdiction": "Duval", "latitude": 30.31,
           "longitude": -81.72, "source_http_request": req, "request_identifier": "0969250000R"}, open(f"{d}/unnormalized_address.json", "w"))
json.dump({"from": {"/": "./property_seed.json"}, "to": {"/": "./unnormalized_address.json"}},
          open(f"{d}/relationship_property_seed_has_unnormalized_address.json", "w"))
p = f"{d}/bafkreibhurphpjdq33ysit57jtzmdldgngepsdbsw4vm7esawth2ezgaxu.json"
seed = json.load(open(p))
seed["relationships"]["property_seed"] = {"/": "./relationship_property_seed_has_unnormalized_address.json"}
json.dump(seed, open(p, "w"))
PY

# 3. Validate, hash, validate the CAR, export the tables
elephant-cli validate ./full --output-csv errors.csv
elephant-cli hash ./full --output-zip ./hashed --output-csv hash.csv --output-car full.car
elephant-cli validate full.car --output-csv car-errors.csv
elephant-cli export-tables full.car --output ./tables --part-size 128m --output-json tables.json
```

Observed:

```text
validate:      Properties processed: 1, succeeded: 1, failed: 0
hash:          CAR written: full.car (38 blocks, root baguqeeraqz5hz3qywuzcau56ch2eobbhmydotdfxmhblvw6se3puodapnhka)
validate car:  Blocks 38, Properties 1, Data groups validated 2; integrity, root, index, graph, lexicon, orphans errors 0
               ✅ CAR passed every check
export-tables: ❌ Failed to export tables: table property_seed has two schemas in this car: relationship property_seed and bafkreifeyjufurzvdpoanqk43o55fpa534nczvzutd6qq3j6gka7ixbkxi
```

Control: the same property with the Seed root `transform` wrote (step 2 skipped) hashes to 35 blocks, passes every
CAR check and exports 29 tables in 29 parts, `address_has_parcel` among them.

## Cause

`dist/services/tables-export.service.js` at `44bb182` (source `src/services/tables-export.service.ts`, since #249):

- a class table is named `snake(schema.title)` (lines 40 and 279), so the `property_seed` class becomes table `property_seed`;
- a relationship table is named by its data-group key (lines 421-423: `name: key`, `source: relationship ${key}`), so
  the Seed group's `property_seed` relationship also becomes table `property_seed`;
- the writer refuses a second definition with other columns under one name (lines 322-326), by design.

## Suggested fix

Rename on collision only: when a relationship key equals a class table name (or `properties`), write that
relationship table under a distinct name, for example `property_seed_relationship`, and record the key it came from in
the table's part metadata and in `tables.car`. No other table changes name, so archives already exported keep their
layout (Jackson's published `address_has_parcel` table among them). A test with the full Seed root would pin it.

## Why it matters

The kit's publication reference says the Seed root rides inside every county archive, and its output contract lists
`property_seed` and `unnormalized_address` in it. With the full root, no county can export tables. The Travis pilot
moved to the root `transform` writes and exports 23 tables against the live manifest (decisions.md section 22).
