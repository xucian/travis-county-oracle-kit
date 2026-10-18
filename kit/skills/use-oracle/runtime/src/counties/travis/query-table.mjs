/**
 * Travis internal query-table row mapping (the `reconcile-export` working
 * table; never published). Reads the transformed `data/*.json` files and the
 * seed row, computes the internal roof-age lineage from the built year with
 * the frozen Travis profile (the transform does not write `structure.roof_date`
 * or `roof_age_years`; assignment decisions.md section 5), and keeps the
 * fields the deploy-time signals need (`geo_id`, mailing state/ZIP, deed date).
 *
 * @module counties/travis/query-table
 */

import { createHash } from "node:crypto";
import { mintSitusAddressIdentity } from "../../core/address-signature.mjs";
import { parseUnnormalizedAddress, toInteger, toNumber, toText } from "../../core/query-table.mjs";
import { resolveCanonicalRoofAge } from "../../roof-age/integration.ts";
import { travisRoofAgeProfile } from "./permit-profile.mjs";

export const SOURCE_SYSTEM = "travis_appraiser";
export const COUNTY_KEY = "travis";
export const COUNTY_NAME = "Travis";
export const STATE_CODE = "TX";

/**
 * Stable property id for a printed PROP_ID (sha256 of `travis:<PROP_ID>`, 32 hex characters).
 *
 * @param {string} propId - PROP_ID as printed.
 * @returns {string} Stable id.
 */
export function travisPropertyId(propId) {
  return createHash("sha256").update(`travis:${propId}`).digest("hex").slice(0, 32);
}

/**
 * @param {Record<string, unknown>} record - Owner entity (`person_1.json` or `company_1.json`).
 * @returns {string | null} Display name.
 */
export function formatOwnerName(record) {
  if (!record || typeof record !== "object") return null;
  const direct = toText(record.name);
  if (direct !== null) return direct;
  const parts = [record.first_name, record.middle_name, record.last_name].map((part) => toText(part)).filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Flatten a roof-age lineage into the internal `roof_age_*` columns.
 *
 * @param {import("../../roof-age/integration.ts").CanonicalRoofAgeLineage | null} lineage - Lineage from the estimator.
 * @returns {Record<string, unknown>} Column values.
 */
export function roofAgeColumnsFromLineage(lineage) {
  return {
    roof_date: lineage?.roofDate ?? null,
    roof_date_precision: lineage?.roofDatePrecision ?? null,
    roof_age_years: lineage?.roofAgeYears ?? null,
    roof_age_source: lineage?.source ?? null,
    roof_age_confidence: lineage?.confidence ?? null,
    roof_age_policy_version: lineage?.policy.version ?? null,
    roof_age_profile_version: lineage?.policy.profileVersion ?? null,
    roof_age_profile_sha256: lineage?.policy.profileSha256 ?? null,
    roof_age_permit_source_system: lineage?.selectedPermit?.sourceSystem ?? null,
    roof_age_permit_id: lineage?.selectedPermit?.sourceRecordId ?? null,
    roof_age_historical_coverage_state: lineage?.historicalCoverage.state ?? null,
    roof_age_historical_coverage_caveats: lineage ? JSON.stringify(lineage.historicalCoverage.caveats) : null,
    roof_age_as_of_date: lineage?.asOfDate ?? null,
    roof_age_eligible: lineage?.eligibility.eligible ?? null,
    roof_age_eligibility_reason: lineage?.eligibility.reason ?? null,
  };
}

/**
 * The internal `roof_age_*` columns from a T5 estimate (`t5-roof-age.mjs`): the estimator ran with the parcel's linked
 * permits, so the source is the permit anchor or the built-year default, never an explicit roll roof date (TCAD prints none).
 *
 * @param {Record<string, any>} estimate - One parcel's record from `estimateParcelRoofAge`.
 * @returns {Record<string, unknown>} Column values.
 */
export function roofAgeColumnsFromT5(estimate) {
  const anchor = estimate.roof_age_anchor;
  const permitAnchor = anchor && "permit_id" in anchor;
  return {
    roof_date: permitAnchor ? anchor.date : estimate.roof_year === null ? null : String(estimate.roof_year),
    roof_date_precision: permitAnchor ? "day" : estimate.roof_year === null ? "none" : "year",
    roof_age_years: estimate.estimator.estimated_age_years,
    roof_age_source: permitAnchor ? "permit_updated" : anchor ? "construction_year_default" : "none",
    roof_age_confidence: estimate.roof_age_confidence,
    roof_age_policy_version: estimate.policy.version,
    roof_age_profile_version: estimate.policy.profile_version,
    roof_age_profile_sha256: estimate.policy.profile_sha256,
    roof_age_permit_source_system: permitAnchor ? "travis_austin_socrata_permits" : null,
    roof_age_permit_id: permitAnchor ? anchor.permit_id : null,
    roof_age_historical_coverage_state: estimate.estimator.historical_coverage,
    roof_age_historical_coverage_caveats: JSON.stringify(estimate.roof_age_caveats),
    roof_age_as_of_date: estimate.roof_age_as_of,
    roof_age_eligible: estimate.roof_age_basis !== null,
    roof_age_eligibility_reason: estimate.estimator.eligibility_reason,
  };
}

/**
 * Map one parcel's transformed files plus its seed row into a query-table row.
 *
 * @param {object} params - Mapping inputs.
 * @param {string} params.parcelId - PROP_ID as printed.
 * @param {Record<string, Record<string, unknown>>} params.files - `data/*.json` keyed by basename.
 * @param {Record<string, string> | null} params.seedRow - Matching seed row.
 * @param {Record<string, any> | null} [params.sourcePayload] - The parcel's lexicon-gap sidecar (`source-payload.json`), when present.
 * @param {string} params.asOfDate - Roof-age as-of date (`YYYY-MM-DD`).
 * @param {Record<string, any> | null} [params.roofAge] - The T5 estimate with the parcel's linked permits (`t5-roof-age.mjs`); without it the columns hold the built-year-only lineage.
 * @param {{ published: number } | null} [params.permits] - The parcel's published permits (T5); without it `has_permits` is false and `permit_count` 0.
 * @returns {Record<string, unknown>} Flat row.
 */
export function mapTransformedFilesToQueryTableRow({ parcelId, files, seedRow, sourcePayload = null, asOfDate, roofAge = null, permits = null }) {
  const property = files["property.json"] ?? {};
  const address = files["address.json"] ?? {};
  const geometry = files["geometry.json"] ?? {};
  const lot = files["lot.json"] ?? {};
  const mailing = files["mailing_address.json"] ?? {};
  const payload = /** @type {Record<string, any>} */ (sourcePayload ?? {});

  const situsText = toText(address.unnormalized_address) ?? toText(seedRow?.address);
  const parsed = parseUnnormalizedAddress(situsText);
  const addressZip = toText(address.postal_code) ?? parsed.postalCode ?? toText(seedRow?.zip);
  const identity = mintSitusAddressIdentity({ state: STATE_CODE, postalCode: addressZip, street: parsed.street });

  const taxes = Object.entries(files)
    .filter(([name]) => /^tax_\d+\.json$/.test(name))
    .map(([, record]) => record)
    .sort((left, right) => Number(right.tax_year ?? 0) - Number(left.tax_year ?? 0));
  const tax = taxes[0] ?? {};
  const sale = files["sales_history_1.json"] ?? null;
  const owner = files["person_1.json"] ?? files["company_1.json"] ?? null;
  const ownerName = formatOwnerName(owner);
  const builtYear = toInteger(property.property_structure_built_year);
  const lineage = resolveCanonicalRoofAge(
    {
      propertyId: parcelId,
      structureId: null,
      sourceSystem: SOURCE_SYSTEM,
      sourceRecordId: parcelId,
      builtYear,
      roofDate: null,
      roofAgeYears: null,
      sourcePayload: null,
      permits: [],
    },
    { asOfDate, historicalCoverage: { state: "unknown", caveats: ["history_unknown"] }, profile: travisRoofAgeProfile },
  );
  const latitude = toNumber(geometry.latitude) ?? toNumber(address.latitude);
  const longitude = toNumber(geometry.longitude) ?? toNumber(address.longitude);
  const lotAreaSqft = toNumber(lot.lot_area_sqft);

  return {
    property_id: travisPropertyId(parcelId),
    property_cid: null,
    request_identifier: toText(property.request_identifier) ?? parcelId,
    parcel_identifier: toText(property.parcel_identifier) ?? parcelId,
    geo_id: toText(payload.geo_id) ?? toText(seedRow?.geo_id),
    source_system: SOURCE_SYSTEM,
    county_name: COUNTY_NAME,
    state_code: STATE_CODE,
    address_street: parsed.street,
    address_city: toText(address.city_name) ?? parsed.city ?? toText(seedRow?.city),
    address_zip: addressZip,
    elephant_uuid: identity?.elephantUuid ?? null,
    elephant_token: identity?.elephantToken ?? null,
    latitude,
    longitude,
    coordinate_basis: latitude === null ? null : "parcel_centroid",
    lot_size_acre: toNumber(lot.lot_size_acre) ?? (lotAreaSqft !== null ? lotAreaSqft / 43_560 : null),
    lot_area_sqft: lotAreaSqft,
    exterior_wall_material: null,
    roof_covering_material: null,
    ...(roofAge ? roofAgeColumnsFromT5(roofAge) : roofAgeColumnsFromLineage(lineage)),
    property_type: toText(property.property_type),
    property_usage_type: toText(property.property_usage_type),
    state_cd: toText(payload.state_cd) ?? toText(seedRow?.source_state_cd),
    built_year: builtYear,
    livable_floor_area: toNumber(property.livable_floor_area),
    total_area: toNumber(property.total_area),
    assessed_value: toNumber(tax.property_assessed_value_amount),
    market_value: toNumber(tax.property_market_value_amount),
    land_value: toNumber(tax.property_land_amount),
    avm_value: null,
    owner_name: ownerName,
    owner_kind: owner ? (files["person_1.json"] ? "person" : "company") : null,
    owners_text: toText(payload.owner?.printed_name),
    owner_count: owner ? 1 : 0,
    owner_occupied: null,
    owner_mailing_state: toText(mailing.state_code),
    owner_mailing_zip: toText(mailing.postal_code),
    last_sale_date: sale ? toText(sale.ownership_transfer_date) : null,
    last_sale_price: sale ? toNumber(sale.purchase_price_amount) : null,
    subdivision: toText(property.subdivision),
    has_permits: (permits?.published ?? 0) > 0,
    permit_count: permits?.published ?? 0,
    has_sunbiz_tenant: false,
    has_bbb_contractor: false,
    has_pa_corp_tenant: false,
    hoa_flag: null,
    hoa_cid: null,
    hoa_name: null,
    hoa_sunbiz_document_number: null,
    property_manager_cid: null,
    property_manager_name: null,
    property_manager_sunbiz_document_number: null,
    hoa_pm_status: null,
  };
}
