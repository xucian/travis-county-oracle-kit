/**
 * Travis enrichment profile: the internal query-table schema and the
 * enrichment pointers in the kit's shape.
 *
 * Not registered in `src/counties/enrichment-profiles.mjs` on purpose: the
 * registry test pins its keys to Duval, and no Travis enrichment command runs
 * in v1. The `sunbiz` block is the kit's name for the corporate-registry ZIP
 * filter; for Travis it carries the county's ZIP prefixes for the Comptroller
 * file (Texas has no Sunbiz). The BBB category URLs follow BBB's Austin
 * market path pattern and are unreviewed: BBB is blocked and nothing from
 * this machine has visited them (`docs/travis-bbb-access-request.md`).
 *
 * @module counties/travis/enrichment-profile
 */

import { validateEnrichmentProfile } from "../enrichment-profile.mjs";
import { ROOF_AGE_QUERY_TABLE_SCHEMA_FIELDS } from "../../roof-age/integration.ts";

export const TRAVIS_QUERY_TABLE_SCHEMA_FIELDS = Object.freeze({
  property_id: { type: "UTF8" },
  property_cid: { type: "UTF8", optional: true },
  request_identifier: { type: "UTF8", optional: true },
  parcel_identifier: { type: "UTF8", optional: true },
  geo_id: { type: "UTF8", optional: true },
  source_system: { type: "UTF8", optional: true },
  county_name: { type: "UTF8", optional: true },
  state_code: { type: "UTF8", optional: true },
  address_street: { type: "UTF8", optional: true },
  address_city: { type: "UTF8", optional: true },
  address_zip: { type: "UTF8", optional: true },
  elephant_uuid: { type: "UTF8", optional: true },
  elephant_token: { type: "UTF8", optional: true },
  latitude: { type: "DOUBLE", optional: true },
  longitude: { type: "DOUBLE", optional: true },
  coordinate_basis: { type: "UTF8", optional: true },
  lot_size_acre: { type: "DOUBLE", optional: true },
  lot_area_sqft: { type: "DOUBLE", optional: true },
  exterior_wall_material: { type: "UTF8", optional: true },
  roof_covering_material: { type: "UTF8", optional: true },
  ...ROOF_AGE_QUERY_TABLE_SCHEMA_FIELDS,
  property_type: { type: "UTF8", optional: true },
  property_usage_type: { type: "UTF8", optional: true },
  state_cd: { type: "UTF8", optional: true },
  built_year: { type: "INT64", optional: true },
  livable_floor_area: { type: "DOUBLE", optional: true },
  total_area: { type: "DOUBLE", optional: true },
  assessed_value: { type: "DOUBLE", optional: true },
  market_value: { type: "DOUBLE", optional: true },
  land_value: { type: "DOUBLE", optional: true },
  avm_value: { type: "DOUBLE", optional: true },
  owner_name: { type: "UTF8", optional: true },
  owner_kind: { type: "UTF8", optional: true },
  owners_text: { type: "UTF8", optional: true },
  owner_count: { type: "INT64", optional: true },
  owner_occupied: { type: "BOOLEAN", optional: true },
  owner_mailing_state: { type: "UTF8", optional: true },
  owner_mailing_zip: { type: "UTF8", optional: true },
  last_sale_date: { type: "UTF8", optional: true },
  last_sale_price: { type: "DOUBLE", optional: true },
  subdivision: { type: "UTF8", optional: true },
  has_permits: { type: "BOOLEAN", optional: true },
  permit_count: { type: "INT64", optional: true },
  has_sunbiz_tenant: { type: "BOOLEAN", optional: true },
  has_bbb_contractor: { type: "BOOLEAN", optional: true },
  has_pa_corp_tenant: { type: "BOOLEAN", optional: true },
  hoa_flag: { type: "BOOLEAN", optional: true },
  hoa_cid: { type: "UTF8", optional: true },
  hoa_name: { type: "UTF8", optional: true },
  hoa_sunbiz_document_number: { type: "UTF8", optional: true },
  property_manager_cid: { type: "UTF8", optional: true },
  property_manager_name: { type: "UTF8", optional: true },
  property_manager_sunbiz_document_number: { type: "UTF8", optional: true },
  hoa_pm_status: { type: "UTF8", optional: true },
});

export const travisEnrichmentProfile = validateEnrichmentProfile({
  countyKey: "travis",
  countyName: "Travis",
  stateCode: "TX",
  sunbiz: {
    zipPrefixes: ["786", "787"],
  },
  bbb: {
    categories: [
      {
        key: "roofing-contractors",
        url: "https://www.bbb.org/us/tx/austin/category/roofing-contractors",
        reviewedPath: "/us/tx/austin/category/roofing-contractors",
      },
      {
        key: "solar-energy-contractors",
        url: "https://www.bbb.org/us/tx/austin/category/solar-energy-contractors",
        reviewedPath: "/us/tx/austin/category/solar-energy-contractors",
      },
      {
        key: "heating-and-air-conditioning",
        url: "https://www.bbb.org/us/tx/austin/category/heating-and-air-conditioning",
        reviewedPath: "/us/tx/austin/category/heating-and-air-conditioning",
      },
    ],
  },
  queryTable: {
    schemaFields: TRAVIS_QUERY_TABLE_SCHEMA_FIELDS,
  },
  publication: {
    bucket: "elephant-oracle-query-table",
    queryTableIpnsLabel: "oracle-query-table-travis",
    coverageIpnsLabel: "oracle-dataset-coverage-travis",
  },
});
