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
| Socrata permits | 2,380,707 rows (2026-10-17) | one GET per (`permittype`, `calendar_year_issued`) partition, 270 requests, recorded as the `source_http_request` actually made | **measured (T4):** 318.6 s for the whole export at 2 requests in flight, no throttling; no per-parcel harvest |
| TCAD export | a handful of files, hundreds of MB | bulk download under US egress | minutes to download; seed build is a local join |
| TNR parcel layer | 386,682 polygons at 1,000 per request | paged REST queries (MapServer layer 0, geoJSON), concurrency 1, recorded per page | about 387 requests, well under an hour |
| Comptroller file | about 3M rows statewide, filter Travis | bulk download | minutes |
| Transform | per parcel, custom code, no browser | warm single process | **measured (T4):** 10,069 parcels per minute (appraisal), 74,593 permits per minute (permit transform) |
| elephant-cli validate, hash, CAR validate, export-tables | per group, local | one process per group, or K concurrent shards | **measured (T4):** sequential 0.39 s per parcel for the County chain (validate 0.36 s) and 0.14 s per permit-group parcel; on 8 shards 0.085 and 0.041 s |

The only source acquisition T4 adds, the Austin export, takes 5.3 minutes; the kit's 48-hour gate per
source holds. The full local pipeline projects to 59.97 hours sequentially and 15.47 hours with the CLI
chain on 8 concurrent shards per group (section 14).

## 8. Risks and findings that gate later steps

1. **Lexicon county enum (a county-label gap, not a validation blocker).** The live
   `unnormalized_address.county_jurisdiction` (required) and `address.county_name` enums (140 members)
   do not include `Travis`; see `docs/travis-lexicon-county-enum-request.md` (lexicon#194). Corrected
   2026-10-17 (assignment decisions.md section 22): the earlier premise that every Travis property
   fails `validate` until the enum merges held only while the Seed root carried `unnormalized_address`.
   The Travis archive now uses the Seed root `elephant-cli transform` writes (`address_has_parcel`
   only), omits `address.county_name` and writes no `unnormalized_address`, and validates against the
   live manifest with 0 errors (run of record `20261017T072132Z`). No field in it names the county;
   the Atlas page, the run record and the README manifest do.
2. **`source_payload` does not survive `elephant-cli validate`** (decisions.md section 5,
   option (ii)). Every live class schema is `additionalProperties: false` without a
   `source_payload` property, and `elephant-cli validate` 1.58.1 (commit `44bb182`) on the
   synthetic replay output reported `unexpected property 'source_payload'` on `property`
   (`docs/evidence/travis-fixture-validate-2026-10-16.{csv,txt}`). The Travis transform
   therefore writes lexicon-gap fields (`geo_id`, state code, printed owner string and owner
   key, neighborhood code) to a per-parcel sidecar `source-payload.json` beside `data/`, which
   the internal reconciliation reads and the archive never carries; option (iii) (the deploy
   re-reads the public exports for the non-lexicon columns) is the path for the hosted layer.
   `tax.property_taxable_value_amount` is an optional, non-nullable number in the live
   schema. Taxable values are per taxing entity in the export (`PROP_ENT.TXT`, not read in
   v1), so from transform v2 (T2, 2026-10-17) the field is omitted rather than proxied from
   the assessed value (v1 wrote the assessed value there).
3. After that change the same validate run reported **exactly one error per property, the
   county enum** (item 1), because the Seed root then carried `unnormalized_address`; with the Seed
   root `address_has_parcel` only it reports none (section 11): the Seed and County roots, every relationship, the person and
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

## 10. T2 transform proof (2026-10-16 UTC, offline, CLI 1.58.1 at `44bb182`)

- **Validation by class.** Pilot attempt 1 (`20261016T214212Z`, transform v1): 31 error rows on 25 of 25
  properties: 25 `county_jurisdiction` (the enum, expected), 3 `property.total_area` pattern `.*\d{2,}.*`
  (value `"0"`), 3 `lot.lot_area_sqft` minimum 1 (value 0). Final pilot (`20261016T215528Z`, transform v2):
  25 error rows, one per property, all `/relationships/property_seed/to/county_jurisdiction` (value `Travis`).
  The County group validates on every property; the enum is the only error class left. Superseded
  2026-10-17 (section 11): with the Seed root `address_has_parcel` only, the run of record validates
  with 0 errors against the live manifest.
- **Transform v2** (`travis-transform-v2`): `total_area` is building area and stays null (v1 wrote the lot area);
  no `lot` when the roll prints 0 legal acreage (73,334 roll rows); `livable_floor_area` only from 10 sqft
  (554 rows print 1-9 sqft); `tax.property_taxable_value_amount` omitted (see 8.2); TCAD's own state-code table
  (`travis-state-code-v1`, quoted from the export's `STATE_CD.TXT`) replaces the Florida-style one; `address.block`
  and `address.lot` from `block` and `tract_or_lot`; a row with no situs street fails permanently ("no situs
  address", 25 rows) instead of seeding the PROP_ID as an address.
- **Field coverage** (`docs/evidence/travis-t2-field-coverage-20261016.json`, enforced by
  `tests/travis-field-coverage.test.mjs`): 51 export fields read (42 `PROP.TXT`, 7 `IMP_DET.TXT`, 2 `ABS_SUBD.TXT`):
  29 to lexicon fields, 7 to lexicon fields plus the sidecar, 9 to the sidecar only (lexicon gaps: `geo_id`,
  `prop_type_cd`, `hood_cd`, `abs_subdv_cd`, `deed_book_id`, `deed_book_page`, `imprv_id` as `imprv_count`, and the
  two confidentiality flags as the owner classification), 6 for seed building only (`sup_num`, `partial_owner`,
  `IMP_DET` `prop_id`, `prop_val_yr` and `imprv_det_id`, and the `ABS_SUBD` join key). Export fields with a lexicon home that v1 does not read are listed there (`ten_percent_cap`,
  `PROP_ENT.TXT` taxable values, `LAND_DET.TXT` land size, `IMP_ATR.TXT` roof covering, `IMP_INFO.TXT`).
- **Unmapped-code inventory.** 31 state codes occur in the roll, all mapped; 0 rows unmapped, 0 blank. Table
  codes absent from the roll: B5, C2, D3, J7, J8. `STATE_CD.TXT` codes outside the table (personal property,
  minerals, rolling stock; never R accounts): G1-G3, J9, L1, L2, M2, N1, N2.
- **Owners** (`travis-owner-classification-v2`, whole roll): 97,689 company, 343,972 person, 300 unsplittable
  (printed string in the sidecar only), 0 confidential. v1 had put ESTATE (1,765), LIFE (1,567) and ETAL (1,213)
  into middle names; v2 removes the roll's annotations on whole words first, and its added company words come from
  the roll itself (words that sit almost only in company-classified strings, excluding common given names and
  surnames). The roll's owner field is cut at 30 characters ("... REVOCABLE", "... MUNICIPAL UTILITY D").
- **Blank situs city (58.9% of the roll).** `address.json` uses the lexicon's unnormalized branch, where
  `city_name` is optional: written only when the roll prints a situs city, otherwise null; never derived from the
  ZIP, the mailing address or the GIS layer; the structured branch (city required) is not used.

## 11. T2 option B (2026-10-17): the run of record against the live manifest

- **Seed root** `address_has_parcel` only, as `elephant-cli transform` writes it (#251); `property_seed` and
  `unnormalized_address` are not written into `data/` (transform v3; assignment decisions.md section 22).
  The full Seed root validated only against an amended lexicon served locally, and `export-tables` at
  `44bb182` refuses it ("table property_seed has two schemas in this car").
- **Run of record `20261017T072132Z`** (live manifest sha256 `7084b933…`, no overrides): smoke (830704) 1 of 1;
  pilot 25 = 25 + 0 + 0, 13 with geometry; `validate` 25 of 25, 0 errors; `travis-county.car` 471 blocks, root
  `baguqeerahe3ecgiyigcgdg6gmxqsmc5ylzlucf4kb3n5xcqi5tvtiebpv2ta`, CAR checks integrity, root, index, graph,
  lexicon and orphans 0; `export-tables --part-size 128m` 23 tables in 23 parts, 444 rows, root
  `baguqeeram5hefoyihxelublnx3hzdmbdxg5gavyukspzevkwnii7b5zexipq`; every emitted class and relationship key has a
  table. Evidence: `docs/evidence/travis-t2-run-20261017T072132Z.json`.
- **v1 pilot publication (2026-10-17, on the operator's go).** Public-sequence step 5 only: both roots uploaded to
  Filebase over Kubo RPC and read back as recorded (archive 471 blocks; tables 23 parts pointing back at the archive);
  Filebase `pin/ls` holds all 25 CIDs and cid.contact lists its provider records. Pinata pin-by-CID is refused on this
  account's plan (HTTP 403 `PAID_FEATURE_ONLY`), so there is no second pin. ipfs.io and dweb.link left every check
  unverified, nothing mismatched: both stopped serving backend clients (retired 2026-09-21; 429 or a redirect to a
  failing `trustless-gateway.link`). Manifest CID `bafkreiaasx5bscxhvcpfyza2hzlwyfrmqrss6roa4btefom2usxopm2a44`. No
  Atlas PR. Evidence: the run record's `publication`; helper `src/counties/travis/publish.mjs`.
- **County label gap.** `address.county_name` is omitted until lexicon#194 is live; the wrong-county guard is
  `assertTravisIdentity` (seed county and FIPS, request identifiers, source hosts, address state and county,
  geometry bbox).

## 12. T3 official identity baseline (2026-10-17): offline part done, one US window staged

Assignment decisions.md section 23 (approved by the operator). Section 9's "No further VPN window is needed until run 2"
no longer holds: T3 needs one short US window, staged as one command (`node src/counties/travis/t3-vpn-fetch.mjs`).

- **Registry equivalent.** The Comptroller Active Franchise Taxpayers file (`9cir-efmm`) is the profile's official
  corporate-registry equivalent (`travis-sources.yaml` `official_identity.corporate_registry`); the SOS is the authority
  of record. The Travis cache (7 pages, verified against their receipts) is loaded into a private Parquet snapshot on the
  registry track: 342,338 rows = 342,337 taxpayers + 1 duplicate (one taxpayer with two SOS status rows, A of 2001 and R
  of 2003); SOS file number on 335,980 (98.14%). A re-load finds 0 new and 0 changed and rewrites nothing. Evidence
  `docs/evidence/travis-t3-registry-load-2026-10-17.json`.
- **Licensing.** No Austin permit prints a license number (68 named columns, 82 in the catalog; markers in free text on
  14 of 2,380,707 rows, none in a contractor field); 18 of 33,351 roofing building permits name a licensed trade; Texas
  issues no roofing license; historical qualification is closed for v1. The Austin right-of-way contractor licenses
  (`8d92-wsiw`, 469 rows) are captured and snapshotted; the TDLR and TSBPE files wait for the window. Evidence
  `docs/evidence/travis-t3-absence-proofs-2026-10-17.json`, `docs/evidence/travis-t3-austin-row-2026-10-17.json`.
- **Matcher.** `travis-exact-unique-normalized-name.v1` (`src/counties/travis/name-matcher.mjs`): exact unique
  normalized name gives a review candidate, never identity; 628 normalized names map to several taxpayers within Travis
  alone, and the statewide file is the matching universe.
- **Run record (prepared).** `docs/evidence/travis-t3-prepared-2026-10-17.json`: sources, watermarks, counts,
  limitations, the window command and its estimate. No permit has been read.

## 13. T3 window results (2026-10-17): every receipt verified, loads offline, TSBPE pending one re-run

Window run `20261017T160716Z` (US egress at all 104 checks, 103 requests, 170 s). Everything below ran offline from that
capture; the run record is `docs/evidence/travis-t3-run-2026-10-17.json`.

- **Verification.** `t3-verify.mjs` rechecked 106 files against their 106 receipts (bytes, SHA-256, CSV rows by the
  capture counter and a full parse, Socrata count = expected rows = pages, `rowsUpdatedAt` unchanged during the capture,
  staging metadata copies, run-record sums): 0 mismatches, 4,451,607 CSV rows, 885.7 MB.
- **TDLR quoting.** TDLR wraps values in quotes without escaping the quotes inside them (4 rows in 3 files, for example a
  business name with a nickname in quotes). The parser's opt-in `unescaped-quotes` dialect reads them as printed; strict
  RFC 4180 stays the default for every other source.
- **Franchise universe.** 3,487,662 rows, 3,487,631 taxpayers statewide (rowsUpdatedAt 2026-10-17T10:35:29Z; the
  2026-10-16 estimate was 3,486,216). The Travis subset derived from it: 342,334 rows, 342,333 taxpayers; against the
  2026-10-16 Travis snapshot 290 new, 1,418 changed (all real value changes, 1,100 of them in the right-to-transact code),
  294 tombstoned (232 moved to another mailing county, 62 left the file). Re-load: no-op, identical bytes.
- **Sales tax.** 49,025 Travis outlets of 42,216 taxpayers. Sole owners (`IS`, 9,471 outlets) are `individual_owner`:
  their taxpayer number is withheld from every derived store and its row hash covers the row with that cell emptied.
- **Veteran-owned.** The franchise file prints SOS file numbers zero-padded to 10 digits, the SOS veteran file 9 digits;
  printed equality joins nothing, the padded key joins 25,466 of 27,205 (taxid agrees on 24,868). Travis subset 2,343.
- **Licensing.** TDLR: 16 files, 887,715 rows, 459,993 licenses, one 23-column header (`tdlr-licfile-columns.v1`);
  35,981 contractor licenses can back a permit contractor, none for roofing. TSBPE: the run saved the menu's description
  page; the loader waits for the `/download-csv/RMP/` capture (one window re-run).
- **Matcher index.** Statewide 33,159 of 3,450,553 normalized names are shared; Travis alone 628; 336,439 Travis
  taxpayers hold a statewide-unique name.
- **Detail URL.** `…/taxes/franchise/account-status/search/<taxpayer_number>` answers 200 without a redirect for a
  franchise taxpayer but renders the record in the browser from a JSON endpoint that was not requested: a link for
  `BusinessRecord.detail_url` on franchise rows, never provenance.
- **Rulings (assignment decisions.md section 24, 2026-10-17).** The padded SOS file number is the exact veteran join
  key. A sole owner's `business_record_id` is a keyed digest (HMAC-SHA256 under the record-id key over taxpayer and
  outlet number) and its `row_sha256` hashes the row with the number emptied: the plain recipe with the number emptied
  would have given 9,471 outlets 22 ids. TDLR licenses are keyed by type, subtype and number. The two Comptroller record
  layouts come in the next window with TSBPE (`--only tsbpe-responsible-master-plumber,comptroller-record-layouts`) and
  are checked offline against the privacy rule.
- **Second window (run `20261017T192341Z`).** TSBPE's Responsible Master Plumber list: 9,378 licenses, 278 in Travis
  (`PLUMB_COMPANY` is the company; `INSURANCE_COMPANY` the insurer). Both record layouts print the same 79 organization
  codes, one-letter codes included, with two sole-owner types (`IS`, `S`) and no SSN statement; the privacy rule became
  `travis-t3-privacy.v2` (`IS`, `S`; 0 rows changed). Partnerships (`PI`, `PZ`), estates and trusts stay visible.

## 14. T4 permit profile, pilot and feasibility (2026-10-17)

Everything ran from one Socrata capture and the T1 seed; the only other requests were the public lexicon manifest and
the Socrata cross-checks. Run record `docs/evidence/travis-t4-run-2026-10-17.json`; harvest
`travis-t4-harvest-v1792239863.json`; link proof `travis-t4-link-proof-v1792239863.json`.

- **Harvest.** `t4-permit-fetch.mjs` captured the whole Austin export from RO egress (the host answers any country):
  2,380,707 rows = `count(*)` = plan total, 270 partitions, 1,813,784,373 bytes, 274 requests, no 429 and no retry,
  318.6 s, `rowsUpdatedAt` 2026-10-17T12:24:23Z at start and end. `t4-permit-verify.mjs` rechecks every byte count, digest,
  recount and header offline. The capture's artifact hash (sorted partition digests) is `05a9be10…`.
- **Stable provenance.** One request per (`permittype`, `calendar_year_issued`) partition (the largest holds 21,926 rows,
  under the 50,000 limit; a larger one would be split by issue month). A permit never moves between partitions, so the
  request that captured it is the same request in every run and is its `source_http_request`; page offsets, which shift as
  rows are added, are never part of it.
- **Columns.** 60 collected (`travis-austin-permit-columns.v1`); the 7 applicant fields are never requested (privacy
  classification) and neither is `issued_in_last_30_days`, a flag the publisher recomputes daily. A changed column set
  stops the harvest before any data request.
- **Link proof (`geo_id` exact).** 1,978,992 of 2,380,707 permits (83.13%) link exactly to 232,640 of 441,961 accounts;
  `normalized_digits` 0 (the digits-only proof holds over the roll, but every roll `geo_id` and every usable `tcad_id` is
  already 10 digits). Unlinked: `no_candidate` 259,419 (63,019 blank; 196,400 on 6,260 ten-digit ids no 2026 account
  prints), `multiple_candidates` 38,249 (1,164 `geo_id`s shared by 11,589 accounts, mostly condominium regimes),
  `invalid_quarantined` 104,047. No permit number is printed twice.
- **Williamson County rows.** The "seven-character" `tcad_id` values of 2026-10-16 are the Williamson Central Appraisal
  District account form, `R` and six digits (103,848 rows, plus 21 printed `WCAD`); 89,550 of the 89,564 with coordinates
  lie north of latitude 30.40, in the Austin limits that are in Williamson County. They are another county's parcels:
  `travis-tcad-id-evidence-v2` names the reason; they stay unlinked.
- **Retired `geo_id`s.** The 196,400 ten-digit ids absent from the 2026 roll sit inside Travis (latitude p1-p99
  30.126-30.441) and grow in recent decades (3.6% of the 1980s permits, 14.6% of the 2020s), consistent with tracts
  subdivided after the permit. They stay `no_candidate`; nothing in the 2026 export maps an old `geo_id` to its successors.
- **Profile.** 25 status values, none new (447 rows `needs_review`: 433 unmapped, 14 blank); `completed_date` 2,180,217
  confirmed, 198,488 unknown, 2,002 quarantined (before the applied date). Work classifier v2: a new building's own permit
  is new construction even when its text mentions an attached carport or covered porch (v1 read 42,287 of them as
  accessory roofs); `primary_roof_new_construction` 155,327, `primary_roof_replacement` 23,290, `accessory_roof` 26,193,
  `repair_or_coating` 1,321, `needs_review` 5,735 (4,929 distinct descriptions, the top 40 in the link proof).
- **Pilot (`__ALL__`, run `20261017T213138Z`).** 25 = 25 + 0 + 0 appraisal; permit path 5 parcels, 145 permits;
  permit-less path 20 parcels, 4 of them on shared `geo_id`s (83 permits unlinked as `multiple_candidates`). County CAR
  and tables roots equal T2's run of record; Property Improvement validate 5/5, CAR 322 blocks, six checks 0, 7 tables;
  the same property CIDs in both archives; Socrata cross-check 25/25 equal through 2026-10-16. `__NONE__`
  (`20261017T213346Z`): 25 `not_eligible`, no roll index, no link pass, no permit artifact. Fault drill
  (`20261017T213411Z`): an injected permanent failure stays `failed_permanent` on `--resume`; an injected timeout is
  `failed_retryable` and completes on `--resume`.
- **Feasibility (1,000 parcels, `20261017T213812Z`).** A uniform sample (`travis-t4-feasibility-v1`): 1,000 = 1,000 +
  0 + 0; 530 parcels with 4,151 permits, 470 permit-less; both groups validate with 0 errors and pass the six CAR checks;
  the same property CIDs in both archives; Socrata cross-check 998/998 `geo_id`s equal (p50 295 ms per lookup). The
  sample tracks the roll: 4.15 permits per parcel against 4.48, 53% of parcels with permits against 52.6%.
- **Projection.** Source acquisition 0.09 hours (the kit's 48-hour gate per source holds). Full run sequential 59.97
  hours, past the gate: `elephant-cli validate` of the County group alone is 44.2 hours. With the CLI chain on 8
  concurrent shards per group (measured: County 85.2 s per 1,000 parcels, Property Improvement 21.9 s per 530) the full
  run projects to 15.47 hours; on 4 County shards 19.41 hours.
- **Bulk versus runtime retrieval.** The bulk harvest costs 270 requests and 5.3 minutes per run; a per-parcel lookup costs
  about 0.3 s, so the roll would take 441,961 requests and about 18 hours at 2 in flight. The bulk path stays; nothing
  needs runtime retrieval.

### 14.1 Operator rulings of 2026-10-18 and the follow-up measures

- **25.6 out of county (approved).** `travis-parcel-link-v2`: the 103,869 Williamson-CAD-form permits are `out_of_county`;
  `invalid_quarantined` keeps 178.
- **25.7 published enums (approved, double-checked, reconciled with `mew`).** `travis-improvement-enums-v1`, exact printed
  values only: `improvement_type` from `permittype` (DS is `RightOfWayPermit`: Austin TPW lists Driveway/Sidewalk among its
  right-of-way permit types; 2,452 DS rows are sidewalk, curb or gutter only); `improvement_status` from `status_current`
  (Final, Active, On Hold, the Cancelled values; 85.65% filled); `improvement_action` from the work class of building permits
  only (a trade permit carries its parent's work class 89.8-99.1% of the time; 92.72% of BP rows filled); `contractor_type`
  from `contractor_trade` (60.14% filled). Pilot and feasibility validate with 0 errors under permit transform v2.
- **25.9 shards (measured, then approved on 2026-10-18).** All five permit types are published (every linked permit);
  the CLI runs per shard of at most 5,000 properties, 8 shards in flight per group. The T5 design notes (done-markers with
  input and output digests, `ELEPHANT_SKIP_UPDATE_CHECK=1`, memory freed first, `caffeinate -i`) are in assignment
  decisions.md 25.9. Measured: the CLI chain on 8, 10 and 12 concurrent shards: 8 is fastest when memory is free;
  with the swap file nearly full the times double; every sharded variant measured stays inside 48 hours (15.5-33.3 h).
  Every `elephant-cli` call checks npm for a newer version and exits if one exists (`ELEPHANT_SKIP_UPDATE_CHECK=1`).
  Projected published size per run: about 8.8 GB distinct, 17.5 GB as counted by Filebase; 74% of a permit record is its
  partition request.
- **25.10 retired geo_ids (proof).** The ids are on no 2026 account of any type. Austin's past parcel snapshots (2021, 2022,
  2026) pair them with the account ids they had; TCAD's JSON `links` and land comments tie those old accounts to current
  ones, but mostly to several split lots. TCAD's own permit listing names one current account for 7,531 of the permits
  (97.4% agreement with exact links); point-in-polygon is 99.8% precise but reaches 4,618; a unique street line is 99.07%
  precise and reaches 25,641; together 35,713 of 196,400. TNR history is not checkable from RO.
- **25.10 ruled (option B, approved on 2026-10-18).** `travis-parcel-link-v3` adds one fallback, `tcad_permit_listing`
  (confidence `official_listing`): after exact `geo_id` and the digits-only path, a permit whose ten-digit id no current
  account prints links to the one current account on which TCAD's permit listing records its number. The listing is read
  offline from the receipted special export (`t4-tcad-permit-listing.mjs`; bytes and SHA-256 checked against the receipt,
  nothing re-fetched). Result over the whole capture: linked 1,978,992 -> 1,986,523 (83.13% -> 83.44%) on 232,640 -> 237,533
  parcels; 7,531 recovered (4,024 roofing, 21 open and 142 stalled roofing, 3,658 roof-age anchor-eligible; 3,070 parcels
  gain an anchor); `no_candidate` 259,419 -> 251,888 (463 listed on several current accounts, 26 on other accounts only,
  188,380 not listed, 63,019 blank). On the 222,931 exactly linked permits TCAD lists on one current account it names the
  same account 97.30% of the time; TCAD's own record names the printed retired id on 4,468 of the 7,531 listing links.
  Under `query-db-loading-matching` it is a link (explicit fallback on official evidence), not a candidate; the
  reasoning is in `docs/evidence/travis-t4-ruling-10-tcad-listing-2026-10-18.json` and assignment decisions.md 25.10.


## 15. T5 full run (2026-10-18/19): speed and constraints measured on the whole roll

Run `20261018T143520Z-t5-full`, 89 shards of at most 5,000 accounts, 8 in flight, on the operator's Mac with swap at 5.5
of 7 GB at the start. The whole record is kit `docs/evidence/travis-t5-run-20261018T143520Z.json`; the assignment's
decisions.md section 27 rules on it.

- **Wall time: 12.23 h to the run record** (projection 14.5 h). Stage time summed over the shards:
  - `elephant-cli validate` of the County group: 65.9 h, 44.4 minutes per full shard. It is the bottleneck, as T4
    measured.
  - Property Improvement validate: 12.3 h.
  - County hash: 5.3 h.
  - The appraisal transform: 3.0 h; the permit transform: 1.7 h.
  - The Loader merges: 2.5 h, serialized.
  - Everything else: under 2 h together.

  Source acquisition is none: every stage reads the T1–T4 captures; the only request is the lexicon manifest.
- **Memory.** Peak 12.2 GB for the 8 CLI processes and 12.8 GB with the runner; the estimate was about 9 GB. Swap did
  not grow (5.5 GB at the start, 4.9 GB at the end).
- **Finalize.** 27 minutes, of which 25 count the run directory's bytes for the record (about 50 million entries, 569,504 in one full shard, one
  `stat` each). That is a cost of the record, not of the data.
- **Disk.** 125.8 GB allocated (du) for 66.1 GB of file bytes, plus 2.5 GB for the Loader scope; 44 GiB of the disk is left
  free.
- **Source constraints found on the whole roll:**
  - 3 accounts print their situs street one column to the right: the name in the suffix column, the suffix in the unit
    column.
  - The 1,961 newest accounts (PROP_IDs from 1012767) are on no linked permit: each of the 7 geo_ids their permits print
    is shared with an older account.
- **A pipeline constraint found:** 12 county-line accounts fall outside the adapter's rounded validation box, although
  the TNR layer draws them.

### 15.1 Rulings of 2026-10-19 applied: a scoped rerun of 7 shards (attempt 2)

The assignment's decisions.md 27.9 to 27.11 were ruled; the record is the same evidence file, `rulings_27`.

- **Validation box.** The adapter now validates against the seed builder's box (29.95-30.75 N, -98.25 to -97.30 W). No
  point of the roll's 373,513 TNR geometries lies outside it.
  The Census county line was weighed and not taken:
  - 56 accounts TCAD appraises lie wholly outside the line (by up to 46 m);
  - county-line parcels cross it by up to 2.35 km.

  TCAD's parcel fabric does not follow the Census line.
- **Shifted situs columns.** The 3 accounts that print the street one column to the right are read from those columns
  (situs columns v1, exactly that pattern; the sidecar flags it). On the roll it matches those 3 rows and no other.
- **Scoped rerun** (`t5-run.mjs --rerun-shards`): 7 shards reran (s0039, s0040, s0066, s0067, s0068, s0081, s0084) in
  1 h 55 min, and 82 shards were re-certified in place.
  - Each re-certified shard's appraisal and permits markers were rewritten only after three checks passed: a text
    proof per changed file, the shard's own facts, and a re-hash of its outputs.
  - The rerun shards' 34,984 earlier parcels came out byte for byte the same.
  - The County validate took 48.5-49.9 minutes per shard, as in the full run.
  - The Property Improvement CARs came out identical, so their tables were kept from attempt 1.
- **Result.** 441,961 = 441,939 ready + 22 dead + 0 invalid. The 22 dead are source facts: 21 print no situs part,
  1 only a house number.
  - 7 County roots changed, with their tables roots; the other 340 of 354 roots are unchanged.
  - The rerun allocated 8.8 GiB.
  - The Node teardown stalled again after `done`, and the exit watchdog ended the process.
