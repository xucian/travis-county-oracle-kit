# Travis replay fixture (synthetic, offline)

Two **synthetic** parcels in the shape the Travis seed script writes
(`src/counties/travis/seed.mjs#SEED_COLUMNS`); no real TCAD or TNR bytes were available when
this fixture was built (egress outside the US on 2026-10-16), so every value is invented and
only shaped like the export: PROP_IDs `900001`/`900002`, `geo_id`s that follow the 10-digit
Geographic ID form, Austin situs addresses, a polygon inside the Travis bounding box.

- `seed.csv`: `900001` is an A1 single-family parcel with a person owner, a deed date and a
  TNR polygon; `900002` is an F1 commercial parcel with a company owner, an out-of-state
  mailing address, no deed date and no geometry.
- `html/900001.json`: a pre-materialized `travis.parcel-input.v1` input (the adapter uses it
  instead of materializing from the seed row; `900002` exercises the seed-row path).
- `lexicon-manifest.json`: a snapshot of `https://lexicon.elephant.xyz/api/manifest` taken on
  2026-10-16, used only so the offline replay can name the data-group roots. Real runs resolve
  the live manifest.
- `expected-row.json`: the internal query-table row the replay produces for `900001`.

Replace with a real one-parcel capture (under 1 MB) from the first US-egress-window run,
keeping the same file names.
