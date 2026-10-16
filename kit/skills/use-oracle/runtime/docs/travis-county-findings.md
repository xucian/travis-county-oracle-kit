# Travis County, TX - county findings

## 0. US egress window, 2026-10-16 (latest; supersedes the "pending" notes below)

Run under US egress (`ipinfo.io/country` = `US`, a datacenter VPN exit), checked immediately before
every request to traviscad.org, gis.traviscountytx.gov and data.texas.gov. No challenge was met on those
three hosts; nothing was solved or evaded anywhere; BBB was not contacted.

**TCAD exports: free.** The public-information page links direct downloads on
`traviscad.org/wp-content/largefiles/` with no login, account or fee (HTTP 200, sizes matching
`content-length`; receipts with sha256 in `docs/evidence/travis-tcad-downloads-2026-10-16.jsonl`):

| File | URL | Bytes |
| --- | --- | --- |
| 2026 Certified Appraisal Export (supplement 0, run 2026-07-18) | `https://traviscad.org/wp-content/largefiles/2026%20Certified%20Appraisal%20Export%20Supp%200_07182026.zip` | 557,228,168 |
| Export Layout (Legacy 8.0.33, PDF + XLSX) | `https://traviscad.org/wp-content/largefiles/Website_Legacy8.0.33-AppraisalExportLayout_06182026.zip` | 248,399 |
| Improvement Details Report 2026 (CSV, March 2026, pre-certification) | `https://traviscad.org/wp-content/largefiles/improvement_detail_2026.zip` | 69,367,317 |
| 2026 Certified Totals Report (PDF) | `https://traviscad.org/wp-content/uploads/totals_2026_AsOfRollCorr_0_RunID_6885_20260718_171007.pdf` | 3,428,565 |

Not downloaded but listed: the 2026 Supplemental Appraisal Roll Export (Supp 335, 2026-10-08), the JSON
"special" exports and the EARS submissions. Files sit in the gitignored `data/travis/export/`.

**Layout facts.** The certified export is the PACS "Legacy 8.0.33" fixed-width format, not delimited
text: `PROP.TXT` (4.9 GB, 493,324 records of 9,922 bytes), `IMP_DET.TXT` (2.1 GB, 3,310,160 records of
622 bytes), `IMP_INFO.TXT`, `LAND_DET.TXT`, `PROP_ENT.TXT` (9.8 GB), `STATE_CD.TXT` and others; field
positions come from `Legacy8.0.33-AppraisalExportLayout.xlsx`. `prop_id` is an `int(12)` field printed
zero-padded (`000000379828`); TCAD's property search, the TNR layer (integer field) and the layer's
hyperlinks all print the integer (`379828`), which is the identifier. `geo_id` is `char(50)` printed as
10 digits with leading zeros on every R and MH record. Living-area detail types in `IMP_DET.TXT`: `1ST`,
`2ND`, `3RD`, `4TH`, `5TH`, `ADDL`, `1/2`, `FBSMT`; `yr_built` is valid on 3,245,156 of 3,310,160 details.

**Counts** (evidence files `travis-tcad-prop-counts-2026-10-16.json`, `travis-tcad-state-code-counts-2026-10-16.json`,
`travis-gis-counts-2026-10-16.json`, `travis-comptroller-counts-2026-10-16.json`):

- Assessed parcel count **441,961** = distinct `prop_id` with `prop_type_cd` `R` (real property) in
  `PROP.TXT`; 442,039 R records, the 78 extra being partial-owner records. Outside the parcel population:
  11,744 `MH` mobile-home accounts (their `geo_id` is the host parcel's), 39,536 `P` business personal
  property accounts, 5 `MN` mineral accounts.
- TNR GIS feature count **386,682** (`returnCountOnly` on `TCAD_public/MapServer/0`, "TCAD Parcels";
  the FeatureServer endpoint the design named is not enabled); 13,130 polygons carry no `PROP_ID`.
- Comptroller Active Franchise Taxpayers: **342,338** rows with `taxpayer_county_code` 227 (Travis) of
  3,486,216 statewide.
- Discrepancy: GIS is 55,279 (12.51%) below the assessed accounts, above the 2% threshold. Explanation:
  57,567 condominium accounts (A4 54,675, F4 2,892) have no polygon of their own (0 of 40 sampled found
  in the layer; 20 of 20 sampled A1 found; 16 of 20 sampled C1 vacant lots found, recent splits). Geo_ids
  are shared: 431,536 distinct geo_ids for 441,961 real accounts (1,164 geo_ids carry several accounts),
  so an exact `tcad_id` link can return several candidates.

**Identifier proof.** 5 PROP_IDs across A1, A4, C1, F1 and B2 resolved on the TCAD property search
(`https://travis.prodigycad.com/property-detail/<PROP_ID>`) with the export's Geographic ID, type R, state
code and situs (`travis-identifier-spot-check-2026-10-16.json`); `identifier_proven: true`.

**Readiness: still BLOCKED, on the parcel gate only** (`docs/travis-readiness-2026-10-16-us-egress.json`):
"GIS 386682 vs assessed 441961 is approximately 12.5% (threshold 2.0%); unresolved material discrepancy".
The kit requires the cause, canonical denominator, seed decision, excluded population and coverage effect
to be documented **and approved** above the threshold. They are documented as a proposed exception in
`travis-sources.yaml` (`gate: parcel-pending-operator-approval`), which the validator ignores until the
operator approves it; a dry run on a temporary copy with the gate approved returns `PASS` with
`seed_allowed: true`. The seed was therefore **not built**.

**Portal re-probes under US egress** (`travis-portal-reprobe-us-2026-10-16.txt`): Cedar Park and Leander
still answer the Cloudflare "Attention Required" block page (so not a geo-block; a WAF/IP-reputation rule
against the datacenter exit); Sunset Valley GovBuilt now answers a Cloudflare challenge (recorded, not
attempted) and its city site Akamai "Access Denied"; Pflugerville is unchanged (login + reCAPTCHA);
Round Rock's `permits.roundrocktexas.gov/portal` answers with an account login card (vendor unidentified);
Lakeway's city page now loads and links `https://lakewaytx-energovweb.tylerhost.net/apps/selfservice`
(Tyler EnerGov "SelfService Public Site", HTTP 200), a candidate for the kit's `tyler-civic-access` adapter
in T4. All six stay `blocked`. TDLR license search, TSBPE, the SOSDirect subscriber login and the
Comptroller account-status search (`mycpa.cpa.state.tx.us/coa/` now redirects to
`comptroller.texas.gov/taxes/franchise/account-status/search`) all answer HTTP 200 under US egress.

Written 2026-10-16 during the v1 preparation window (egress outside the US all day: `curl -s
ipinfo.io/country` returned `RO` before every probe). Everything that needs
`traviscad.org`, `gis.traviscountytx.gov` or `data.texas.gov` is recorded as **pending the US
egress window** and was not requested. No `bbb.org` host was contacted from this machine.

Companion files: `docs/travis-sources.yaml` (the machine-readable catalog the readiness
validator reads), `docs/travis-readiness-2026-10-16.json` (the validator's report),
`docs/travis-bbb-access-request.md`, `docs/travis-lexicon-county-enum-request.md`,
`docs/evidence/` (probe log, lexicon manifest snapshot, the fixture validate run) and
`fixtures/travis-permits/socrata/` (sampled permit records and vocabulary counts).

Preparation built while the readiness gate is BLOCKED (allowed by `county-readiness-preflight`;
labelled "preparation, not T2" in the assignment's `docs/progress.md`): the Travis adapter
(`src/counties/travis/`), the custom transform (`counties/travis/transforms/`), the permit
profile with fixtures, the synthetic replay fixture (`fixtures/travis-replay/`), the
seed-producing script (`src/counties/travis/build-seed.mjs`, not run), the `data/` ignore
line, and `elephant-county replay --county travis` green under `npm test`.

## 1. Intake (onboard-county), restated

| Item | Answer |
| --- | --- |
| County | Travis County, Texas, FIPS `48453`, slug `travis` |
| Scope | v1 = pilot of about 25 representative parcels, **appraisal-only** (`__NONE__` permit eligibility); the 1,000-parcel feasibility run and the full run are v2 (assignment `docs/decisions.md` sections 2, 3 and 15) |
| Seed | Official parcel roll: TCAD 2026 Certified Appraisal Export joined to the Travis County TNR parcel layer for centroids/polygons; produced by `src/counties/travis/build-seed.mjs` during the US egress window; never committed |
| Appraiser source | TCAD public bulk exports (`https://traviscad.org/publicinformation`): Certified Appraisal Export, Supplemental Appraisal Roll Exports, Improvement Details, Export Layout. **Bulk-first**: no per-parcel appraiser-page capture unless a required field is absent from every bulk source |
| Permit sources | City of Austin "Issued Construction Permits" Socrata export `3syk-w9eu` (reachable worldwide, public domain); every other Travis jurisdiction catalogued in `travis-sources.yaml` (section 4 below) |
| Corporate registry | Texas Secretary of State (official, paid SOSDirect); the Comptroller "Active Franchise Tax Permit Holders" file `9cir-efmm` on data.texas.gov is recorded as an **approved exception** and loads registry candidates only (no identity) |
| Licensing authorities | TDLR (electrical, HVAC) and TSBPE (plumbing) for trade permits that print a license number; **Texas issues no roofing license** (gap recorded). The Socrata export prints **no license-number column** (verified in the dataset metadata: 78 columns, none license-related), so the DBPR-style lookup route has no key in Austin permit rows; contractor fields stay source-name attribution |
| Excluded sources | BBB from this machine (approved AWS US-egress runtime only, after the API access request); geocoders; any CAPTCHA/challenge bypass; vendor sites whose terms prohibit automation |
| Execution mode | The shipped `elephant-county` CLI runtime on the operator's machine (decisions.md section 15): `ingest --live-fetch` smoke on a one-row seed, the same command on the 25-row seed for the pilot, `reconcile-export` for the internal working table. No Restate, Postgres, Docker or AWS in v1 |
| US egress and access constraints | TCAD file host, TNR GIS server and data.texas.gov reject non-US clients; the operator opens a US VPN window for discovery counts, seed, smoke and pilot. Austin Build + Connect (AMANDA) public search sits behind Incapsula with reCAPTCHA on the citizen portal; MyGovernmentOnline portals require a login; neither is bypassed |
| Internal destination | No `DATABASE_URL` in v1. The internal working store is the CLI's `reconcile-export` output (Parquet + coverage JSON) under the gitignored `data/` directory; the catalog records `destination.writes_in_scope: false` so the destination gate is `NOT_APPLICABLE` until a Query DB is introduced (v2) |
| Existing assets | None: no Travis adapter, flow, transform or findings exist in the kit at `99c7bff` and the public `Counties-trasform-scripts` repository has no `travis` or `austin` folder (checked 2026-10-16) |
| Publication scope | v1: the pilot `county` group through `validate -> hash -> validate CAR -> export-tables`, then `upload` of the CAR and tables with CID readback once the operator maps the Filebase variables and sets the bucket; **no Atlas PR** in v1 (the PR is v2, T6). Label: "pilot scope, uploaded with readback, no Atlas PR" |

Source boundary: TCAD export + TNR layer (parcels, ownership, values, year built, deed date,
geometry) and the Austin Socrata export (permits) are the v1/v2 sources of record; municipal
portals outside Austin are catalogued with records requests, not harvested. Job id for the
pilot: `travis-v1-pilot`. Stages in order: readiness -> seed -> one-parcel smoke -> pilot ->
transform proof -> reconcile-export -> pilot publication steps (upload with readback only).

## 2. Appraiser portal and bulk data (pending US egress)

- Public information page: `https://traviscad.org/publicinformation` (page reachable earlier
  from outside the US; the file host answered 403, which is either a geo-block or a paywall and
  is resolved first thing in the US window).
- Expected layout: the Travis CAD export follows the PACS appraisal-export convention (fixed-width
  or delimited files with a layout document): property records keyed by `PROP_ID` with `geo_id`,
  owner name and mailing address, situs address fields, legal description, state/property class
  code, land and improvement values, deed information, plus an Improvement Details file with
  year built and improvement types. **Column names are confirmed against the Export Layout zip
  before the seed script runs**; the seed script fails loudly when an expected column is missing
  and never guesses.
- Cost: not stated on the page. If the files are paid, the purchase is a human payment decision
  recorded in the run record; if declined, the GIS-only contingency in `travis-sources.yaml`
  (`approved_exceptions`, inactive entry) is activated by moving it to `gate: parcel`.
- Per-parcel detail page (only a fallback for fields absent from every bulk file): the TCAD
  property search is a Prodigy CAD portal; the per-parcel URL pattern is recorded when first
  observed under US egress, never guessed.
- Coordinates, in order: (1) TNR parcel layer
  `https://gis.traviscountytx.gov/server1/rest/services/Boundaries_and_Jurisdictions/TCAD_public/MapServer/0`
  (the FeatureServer path first assumed is not enabled; fields include `PROP_ID` and `geo_id`;
  maxRecordCount 2,000, paged at 1,000 per request), paged by the seed script
  with the request actually made recorded per feature page; (2) the county GIS parcel shapefile if
  the service blocks paging; (3) the City of Austin parcel layer. Secondary for parcels without
  geometry: the permit `latitude`/`longitude` (present on 2,018,731 of 2,380,507 permit rows).
  No geocoding.
- Counts that gate readiness (assessed parcel count from the roll, GIS feature count from the
  layer) are **null** in the catalog until the window; that is the only blocker the validator
  reports today.

## 3. Parcel identifier

| Identifier | Form | Where |
| --- | --- | --- |
| Property ID (`PROP_ID`) | integer-like string as printed; leading zeros preserved if any appear (none expected) | TCAD export and TNR layer; the lexicon `parcel_identifier`, the seed `parcel_id`, the kit `request_identifier` |
| Geographic ID (`geo_id`) | 10-digit string as printed (for example `0222210299`) | TCAD export and TNR layer; Austin permits print it as `tcad_id` |

Permits link to parcels on `geo_id` exactly as printed. The Socrata `tcad_id` column: 2,213,446
rows are 10 characters, 103,843 are 7 characters, 63,019 are blank, 199 have other lengths
(evidence states `confirmed_present`, `invalid_quarantined` for non-10-character values,
`unknown` for blank). The digits-only comparison stays disabled until the Travis permit profile
proves it one-to-one over the roll (`proveDigitsOnlyNormalization` in
`src/counties/travis/permit-profile.mjs`, run during the window) and the version is recorded.
`geo_id` has no lexicon home: it is kept in `source_payload` on the property and on the permit
(assignment decisions.md section 16).

## 4. Permit sources

### Austin (Socrata export of the AMANDA system behind Austin Build + Connect)

- Dataset: `https://data.austintexas.gov/resource/3syk-w9eu` ("Issued Construction Permits",
  City of Austin). Reachable from outside the US. License in the dataset metadata: Public Domain
  U.S. Government (`USGOV_WORKS`), attribution "City of Austin, Texas - data.austintexas.gov".
- Size on 2026-10-16: 2,380,507 rows; `rowsUpdatedAt` 2026-10-16 (daily). Types: EP 689,064,
  PP 546,969, BP 521,306, MP 506,523, DS 116,645. Applied dates from 1921-09-20; completed dates
  from 1900-05-03 (impossible early values exist and are quarantined) to 2026-10-15.
- **`:updated_at` is the publish time for every row** (every sampled row, old or new, carried
  `2026-10-16T11:36:42.748Z`), so the dataset is republished whole each day and `:updated_at`
  cannot serve as a per-row change signal. Incremental runs watermark on content (row hash per
  `permit_number`) plus `statusdate`/`applieddate` windows; the Socrata `:id` is a stable row id.
- Jurisdiction coverage: `AUSTIN FULL PURPOSE` 2,117,985; `AUSTIN 2 MILE ETJ` 127,608;
  `AUSTIN LTD` 68,517; blank 25,721; `AUSTIN 5 MILE ETJ` 5,945; small-city rows (Lakeway 6,825,
  West Lake Hills 5,113, Bee Cave 4,822, Rollingwood 1,996, The Hills 1,253, Sunset Valley 1,127,
  Pflugerville 1,117, Round Rock ETJ 2,662, others under 100). The small-city rows are Austin-issued
  trade permits (EP/MP/PP from 1980 onward, with building permits that stop around 2005):
  for example West Lake Hills 3,214 EP, 1,592 MP, 217 PP, 88 BP (last 2019). **They are not those
  cities' building-permit ledgers**, so no jurisdiction is classified `delegated`; each city keeps
  its own row and its own portal/records route, and the catalog records the Austin-feed row count
  per city as context only. `assumes_unified_countywide_history` is false.
- Fields (78): permit identity (`permit_number`, `permittype`, `permit_type_desc`,
  `permit_class`, `permit_class_mapped`, `work_class`, `description`, `project_id`,
  `masterpermitnum`, `condominium`), location (`original_address1/city/state/zip`,
  `tcad_id`, `legal_description`, `council_district`, `jurisdiction`, `latitude`,
  `longitude`, `location`), lifecycle (`applieddate`, `issue_date`, `issue_method`,
  `status_current`, `statusdate`, `expiresdate`, `completed_date`, `certificate_of_occupancy`,
  calendar/fiscal year), valuation and area columns, `link` (the permit's public page on
  `abc.austintexas.gov`), contractor (`contractor_trade`, `contractor_company_name`,
  `contractor_full_name`, `contractor_phone`, `contractor_address1/2`, `contractor_city`,
  `contractor_zip`) and applicant (`applicant_full_name`, `applicant_org`, `applicant_phone`,
  `applicant_address1/2`, `applicant_city`, `applicantzip`). **No license-number column.**
- Presence: `tcad_id` 2,317,488; `completed_date` 2,182,013; `contractor_company_name`
  1,191,571; `contractor_full_name` 1,243,046; `contractor_phone` 1,363,655; `expiresdate`
  2,379,720; `issue_date` 2,380,507.
- Roofing signal size: 33,343 BP rows mention "roof" in `description`, spanning 22,405 distinct
  `tcad_id`.
- Status vocabulary (`status_current`, counts): Final 2,010,089; Expired 169,695; VOID 153,347;
  Active 27,891; Withdrawn 17,795; Cancelled 675; Pending 237; Cancelled - Contractor Required
  132; Closed 129; Aborted 121; Inactive Pending Revision 97; On Hold 70; Pending Permit 57;
  Re Review 55; Denied but Closed 43; Suspended 26; blank 14; Expired - License 13;
  Cancelled - New Permit Required 9; New Permit Required 3; Inactive Contractor 3; Revoked 2;
  Application Incomplete 2; Rejected 1; Awaiting Upload 1. The profile maps the contract's
  exact set; everything else (including `Pending`, `Closed`, `Denied but Closed`,
  `Expired - License`, `Revoked`, blank) is `needs_review` and counted.
- `work_class` (BP): New 193,684; Remodel 187,681; Repair 51,080; Addition 29,442; Addition and
  Remodel 22,339; Demolition 21,446; blank 5,510; Interior Demo Non-Structural 4,309; Life Safety
  2,499; Relocation 1,889; Shell 1,417; Remodel Mobile Home 9; Fireline 1. `permit_class` (BP) has
  51 values of the form `R- 101 Single Family Houses`, `C-1000 Commercial Remodel`, ... (counts in
  the fixtures). Re-roofs are filed as `work_class` Repair/Remodel with the roofing scope in
  `description`, so the classifier reads exact terms from `description` first.
- Detail source (not used in v1): the permit's public page
  `https://abc.austintexas.gov/web/permit/public-search-other?t_detail=1&t_selected_folderrsn=<id>`
  answered 200 from outside the US with Incapsula markers; the citizen portal home shows
  reCAPTCHA. Live status refresh is a recorded v1 limitation.
- Privacy classification (also in the catalog): `contractor_*` fields are business contact
  fields printed on a public record and are kept as printed, as source-name attribution;
  `applicant_*` and `applicantzip` are personal contact fields and are **not collected**
  (stripped from the fixtures too).

### Other jurisdictions (probed 2026-10-16 from non-US egress; see `docs/evidence/travis-portal-probes-2026-10-16.txt`)

Classification of the probe outcomes: **bot challenge** = Cloudflare `cf-mitigated: challenge`
with a "Just a moment" page (a JavaScript challenge, not a country rule); **block page** =
Cloudflare "Attention Required" or Akamai "Access Denied" (a WAF rule, which may be a geo-block
or IP reputation; re-probed under US egress before it is called a geo-block); **unresolved** =
the hostname did not resolve or timed out from here; **reachable** = 200.

| Jurisdiction | Permit system | Probe from RO | Classification |
| --- | --- | --- | --- |
| Unincorporated Travis County | TNR Development Services; "My Permit Now" (MyGovernmentOnline) since January 2014, account required; pre-2014 records on `tcobweb.traviscountytx.gov/PublicAccess/TNR/` | county pages reachable; tcobweb timed out | `blocked` (login); records route = TNR Open Records online form. Texas counties issue development, floodplain, OSSF and driveway permits, **not building or roofing permits**, so this row is `unsupported` for roofing signals even after records arrive |
| Pflugerville | `ams.pflugervilletx.gov/PublicAccess` (IIS, login route, reCAPTCHA; vendor not identified) | reachable login page | `blocked` (login + CAPTCHA) |
| Round Rock (Travis part) | `permits.roundrocktexas.gov` (new portal, CAPTCHA before search; vendor unnamed) replacing eTRAKiT (`etrakit.roundrocktexas.gov` now a redirect notice) | new portal timed out; eTRAKiT reachable | `blocked` (CAPTCHA, unverified search) |
| Cedar Park (Travis part) | MyGovernmentOnline (MGO Connect), login | city site: Cloudflare block page | `blocked` |
| Leander (Travis part) | "Development Hub" (vendor unverified) | city site: Cloudflare block page | `blocked` |
| Lakeway | Tyler "Civic Self Service" since 2025-11-12 (predecessor Civic Access; guessed tylerhost name did not resolve) | city site: Cloudflare challenge | `blocked` |
| Bee Cave | MyGovernmentOnline, login | city page 404/403 variants | `blocked` |
| Manor | GovWell (`app.govwell.com/manor`, single-page app; public search unverified) | GovWell reachable; city site challenge | `blocked` (search unverified) |
| Lago Vista | MyGovernmentOnline ("MGO Project Permitting Portal"), login | reachable city pages | `blocked` |
| Jonestown | MyGovernmentOnline, login | city site: Cloudflare challenge | `blocked` |
| Elgin (Travis part) | MyGovernmentOnline, login; `permits@elgintexas.gov` | reachable | `blocked` |
| Rollingwood | MyGovernmentOnline, login; `developmentservices@rollingwoodtx.gov` | city page 404 (moved) | `blocked` |
| Sunset Valley | GovBuilt (`sunsetvalleytx.govbuilt.com`) | GovBuilt: Cloudflare block page; city site: Akamai Access Denied | `blocked` (block pages) |
| West Lake Hills | Building & Development page; no online search found; NextRequest for records | reachable | `custodian-only` |
| Creedmoor | paper permit packet | city site: Cloudflare challenge | `custodian-only` |
| Mustang Ridge (Travis part) | paper forms and checklists | reachable | `custodian-only` |
| Webberville | no website reachable (`webberville.org` refused); phone only | unresolved | `custodian-only` |
| San Leanna | board packets list permits; no portal | reachable | `custodian-only` |
| Point Venture | village office intake (`vopv.org`) | timed out | `custodian-only` |
| Briarcliff | village office; site shows "Service not Available" | reachable (error page) | `custodian-only` |
| The Hills | city administrator; online special-permit form only | reachable | `custodian-only` |
| Volente | paper building permit application | reachable | `custodian-only` |
| Austin | Socrata export + AB+C public search | reachable | `supported` (bulk) |

Vendor library additions for the catalog notes: MyGovernmentOnline/MGO Connect (dominant in
central Texas: Travis County, Cedar Park, Bee Cave, Lago Vista, Jonestown, Elgin, Rollingwood),
GovWell (Manor), GovBuilt (Sunset Valley), Tyler Civic Self Service (Lakeway), an unidentified
"PublicAccess" IIS portal (Pflugerville), Round Rock's new in-house-branded portal.
Bear Creek (one row in the Austin feed) is a Hays County village and is excluded.

## 5. Usage-type vocabulary

The TCAD export carries a state/property class code per property (A1 single-family, A2
mobile home on land, B multifamily, C vacant lot, D/E rural, F1 commercial, F2 industrial,
J utilities, L personal property, M mobile home, O inventory, S special, X exempt, with
sub-codes). The mapping to lexicon `property_usage_type` and `property_type` is finished from
the Export Layout and a code frequency count during the window; unmapped codes keep the raw
code in `source_payload` with a warning and never abort a parcel. Eligibility for the pilot is
the `__NONE__` sentinel (appraisal only).

## 6. Additional data sources

| Source | Status |
| --- | --- |
| Texas Comptroller Active Franchise Tax Permit Holders (`data.texas.gov` `9cir-efmm`) | pending US egress; approved exception for the SOS registry; candidates only; the live lexicon has no `corporate_registry` group and `company` carries only `sunbiz_document_number` (no taxpayer-number property), so rows stay in the internal store |
| Texas SOS (SOSDirect, paid) | official registry; human payment decision; hostnames did not resolve from here |
| TDLR license search, TSBPE | official licensing authorities for electrical/HVAC and plumbing; hostnames did not resolve from here (DNS from this egress); re-probed in the window; Austin permits print no license number, so the lookup has no key |
| BBB | not contacted; access request drafted (`docs/travis-bbb-access-request.md`); coverage ships `blocked` with `incomplete_reason: http_403_source_block` from the AWS probe once run |
| Travis County Clerk official records | deeds; not in v1 scope |
| Austin open data | parcels layer fallback for geometry; permits already covered |

## 7. Source feasibility (estimates, to be replaced by measured values)

| Source | Volume | Mode | Estimate |
| --- | --- | --- | --- |
| Socrata permits | 2,380,507 rows | one bulk GET per run (CSV export endpoint, or SODA pages of 50,000 with `$offset`), recorded as the `source_http_request` actually made | minutes; no per-parcel harvest |
| TCAD export | a handful of files, hundreds of MB | bulk download under US egress | minutes to download; seed build is a local join |
| TNR parcel layer | 386,682 polygons at 1,000 per request | paged REST queries (MapServer layer 0, geoJSON), concurrency 1, recorded per page | about 387 requests, well under an hour |
| Comptroller file | about 3M rows statewide, filter Travis | bulk download | minutes |
| Transform | per parcel, custom code, no browser | warm single process | thousands of parcels per minute class |

Nothing in v1 or v2 projects past the kit's 48-hour gate; the measured pilot timings go into the
run record.

## 8. Risks and findings that gate later steps

1. **Lexicon county enum (blocker for T2 validation).** The live `unnormalized_address.county_jurisdiction`
   (required) and `address.county_name` enums (140 members) do not include `Travis`; see
   `docs/travis-lexicon-county-enum-request.md`. Until the enum merges every Travis property
   fails `elephant-cli validate` on exactly that error; no hash or upload happens before it
   validates.
2. **`source_payload` does not survive `elephant-cli validate`** (decisions.md section 5,
   option (ii)). Every live class schema is `additionalProperties: false` without a
   `source_payload` property, and `elephant-cli validate` 1.58.1 (commit `44bb182`) on the
   synthetic replay output reported `unexpected property 'source_payload'` on `property`
   (`docs/evidence/travis-fixture-validate-2026-10-16.{csv,txt}`). The Travis transform
   therefore writes lexicon-gap fields (`geo_id`, state code, printed owner string and owner
   key, neighborhood code) to a per-parcel sidecar `source-payload.json` beside `data/`, which
   the internal reconciliation reads and the archive never carries; option (iii) (the deploy
   re-reads the public exports for the non-lexicon columns) is the path for the hosted layer.
   `tax.property_taxable_value_amount` is a non-nullable number in the live schema; the
   transform writes the roll's assessed value as the pre-exemption taxable basis.
3. After that change the same validate run reports **exactly one error per property, the
   county enum** (item 1): the Seed and County roots, every relationship, the person and
   company owners, the address, tax, lot, geometry and sales-history entities all validate
   against the live lexicon through the CLI's own schema resolution (the `tax` and
   `property_improvement` class CIDs were not retrievable from the public gateways by hand
   that day, but the CLI resolved them).
4. Geo-blocks and challenges as tabulated above; nothing is bypassed.
5. TCAD export cost unknown (payment decision), and whether the export prints deed dates and
   mailing addresses for every parcel (owner tenure and out-of-area signals) is confirmed from
   the layout.
6. `tcad_id` 7-character rows (103,843) are quarantined, and blank ids (63,019) stay
   valid-unlinked; both are counted on `/v1/meta`.
7. Contractor identity: no license numbers in the export and no Texas roofing license, so v1/v2
   publish no `company`, `person` or `license` for contractors and no
   `property_improvement_has_contractor` edge.
8. Unincorporated Travis County has no roofing-permit ledger at all (county authority), which
   the API reports as `availability: unsupported` for that jurisdiction.

## 9. T1 completion under US egress (2026-10-16, 21:23)

- The operator approved the parcel exception; the readiness validator printed `PASS` (`seed_allowed: true`) before and
  again right after seeding.
- Seed: `data/seeds/travis.csv`, 441,961 rows = the assessed real-property count; 441,961 distinct `parcel_id`, no
  duplicates, all digits, no leading zeros; 373,513 rows (84.5%) carry a TNR feature with the page query that
  returned it, 68,448 do not (at least the 57,567 condo units, plus recent splits). TNR paged in 387 pages;
  11 TNR features carry a PROP_ID absent from the roll. `tcad_id` digits-only normalization proven one-to-one over
  431,536 distinct geographic ids (no collisions). Pilot seed: 25 rows, all in the seed, 13 with geometry.
  Summary: `docs/evidence/travis-seed-manifest-2026-10-16.json`.
- Comptroller cache for T3: 342,338 Travis rows (`taxpayer_county_code = '227'`) in 7 pages under
  `data/travis/comptroller/`, each with its request, time, status, SHA-256 and row count in
  `docs/evidence/travis-comptroller-cache-receipts-2026-10-16.jsonl`. No further VPN window is needed until run 2.
