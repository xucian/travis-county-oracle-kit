/**
 * Field coverage of the Travis appraisal transform (the T2 proof): every TCAD
 * export field the seed builder reads (`build-seed.mjs` PROP_FIELDS,
 * IMP_DET_FIELDS, ABS_SUBD_FIELDS) and where it lands: a lexicon `class.field`,
 * the per-parcel sidecar `source-payload.json` (lexicon gap, never in the
 * archive), or seed building only. `tests/travis-field-coverage.test.mjs`
 * fails when a read field has no entry or an entry names a target the
 * transform does not write.
 *
 * v2 (transform v3, decisions.md section 22): the Seed root is `address_has_parcel` only, so
 * `property_seed.parcel_id` and `unnormalized_address.full_address` are no longer targets. No
 * source field loses coverage: `prop_id` still lands on `parcel.parcel_identifier` and
 * `property.parcel_identifier`, and the situs fields on `address.unnormalized_address`.
 *
 * v3 (transform v4, the T5 pre-run fixes): the export fields with a lexicon home that v2 listed as
 * not read are read by `t5-tcad-extras.mjs` ({@link TRAVIS_EXTRAS_FIELD_COVERAGE}); what still has
 * no faithful member is listed with its reason ({@link TRAVIS_EXPORT_FIELDS_NOT_READ}); and the
 * TNR parcel feature is inventoried field by field ({@link TRAVIS_TNR_FEATURE_COVERAGE}).
 */

export const TRAVIS_FIELD_COVERAGE_VERSION = "travis-field-coverage-v3";

const entry = (lexicon, sidecar, seed, note) => Object.freeze({ lexicon: Object.freeze(lexicon), sidecar: Object.freeze(sidecar), seed, note });

/** @type {Readonly<Record<"PROP" | "IMP_DET" | "ABS_SUBD", Readonly<Record<string, { lexicon: readonly string[], sidecar: readonly string[], seed: string | null, note: string }>>>>} */
export const TRAVIS_FIELD_COVERAGE = Object.freeze({
  PROP: Object.freeze({
    prop_id: entry(["property.parcel_identifier", "parcel.parcel_identifier", "property.request_identifier"], ["prop_id"], "parcel_id", "int(12) printed zero-padded; the identifier is the integer (decisions 19, 21)"),
    prop_type_cd: entry([], ["prop_type_cd"], "filter", "only R (real property) accounts become seed rows"),
    prop_val_yr: entry(["tax.tax_year"], [], "tax_year", "appraisal year of the certified roll"),
    sup_num: entry([], [], "read", "supplement number; the certified export is supplement 0"),
    geo_id: entry([], ["geo_id"], "geo_id", "lexicon gap: no lexicon field; the permit link key (decision 16)"),
    py_owner_name: entry(["person.first_name", "person.last_name", "person.middle_name", "person.suffix_name", "company.name"], ["owner.printed_name", "owner.name_without_annotations", "owner.owner_key", "owner.classification"], null, "travis-owner-classification-v2; the printed string stays in the sidecar (decision 16)"),
    partial_owner: entry([], [], "fold", "additional owner records of one account are folded into its seed row and counted"),
    py_addr_line1: entry(["mailing_address.unnormalized_address"], [], null, "joined with lines 2-3 and the locality"),
    py_addr_line2: entry(["mailing_address.unnormalized_address"], [], null, ""),
    py_addr_line3: entry(["mailing_address.unnormalized_address"], [], null, ""),
    py_addr_city: entry(["mailing_address.city_name", "mailing_address.unnormalized_address"], [], null, ""),
    py_addr_state: entry(["mailing_address.state_code", "mailing_address.unnormalized_address"], [], null, "two-letter codes only"),
    py_addr_zip: entry(["mailing_address.postal_code", "mailing_address.unnormalized_address"], [], null, "first five digits"),
    py_confidential_flag: entry([], ["owner.classification"], "owner_confidential", "a confidential owner writes no owner entity or mailing address"),
    py_address_suppress_flag: entry([], ["owner.classification"], "owner_confidential", "treated like the confidential flag"),
    situs_street_prefx: entry(["address.unnormalized_address"], [], "address", ""),
    situs_street: entry(["address.unnormalized_address"], [], "address", "blank street: permanent failure \"no situs address\" (25 roll rows)"),
    situs_street_suffix: entry(["address.unnormalized_address"], [], "address", ""),
    situs_city: entry(["address.city_name", "address.unnormalized_address"], ["situs_city"], "city", "blank on 58.9% of the roll: city_name null, never derived"),
    situs_zip: entry(["address.postal_code", "address.unnormalized_address"], [], "zip", "first five digits"),
    legal_desc: entry(["property.property_legal_description_text"], [], null, ""),
    legal_desc2: entry(["property.property_legal_description_text"], [], null, "empty on every 2026 row"),
    legal_acreage: entry(["lot.lot_size_acre", "lot.lot_area_sqft"], ["legal_acreage"], null, "no lot entity when 0; sqft = acres x 43,560"),
    abs_subdv_cd: entry([], ["abs_subdv_cd"], null, "join key to ABS_SUBD.TXT"),
    hood_cd: entry([], ["hood_cd"], null, "lexicon gap: no neighborhood field on property"),
    block: entry(["address.block"], [], null, ""),
    tract_or_lot: entry(["address.lot"], [], null, ""),
    land_hstd_val: entry(["tax.property_land_amount"], [], null, "homestead plus non-homestead land value"),
    land_non_hstd_val: entry(["tax.property_land_amount"], [], null, ""),
    imprv_hstd_val: entry(["tax.property_building_amount", "property.build_status"], [], null, "homestead plus non-homestead improvement value"),
    imprv_non_hstd_val: entry(["tax.property_building_amount", "property.build_status"], [], null, ""),
    ag_use_val: entry(["tax.agricultural_valuation_amount"], [], null, "written when greater than 0"),
    appraised_val: entry(["tax.property_assessed_value_amount"], ["appraised_val"], null, "assessed-value fallback only when assessed_val is not printed"),
    assessed_val: entry(["tax.property_assessed_value_amount"], [], null, "taxable values are per entity (PROP_ENT.TXT, not read): property_taxable_value_amount omitted"),
    deed_book_id: entry([], ["deed_book_id"], null, "lexicon deed not written: book printed on 4 rows, a page alone names no instrument"),
    deed_book_page: entry([], ["deed_book_page"], null, ""),
    deed_dt: entry(["sales_history.ownership_transfer_date"], [], null, "MM-DD-YYYY; blank on 17,954 rows (no sales_history)"),
    imprv_state_cd: entry(["property.property_type", "property.property_usage_type"], ["imprv_state_cd", "state_cd", "state_cd_description"], "state_cd", "travis-state-code-v1 (STATE_CD.TXT); improvement code first"),
    land_state_cd: entry(["property.property_type", "property.property_usage_type"], ["land_state_cd", "state_cd", "state_cd_description"], "state_cd", "used when no improvement code is printed"),
    market_value: entry(["tax.property_market_value_amount"], [], null, ""),
    situs_num: entry(["address.unnormalized_address"], [], "address", ""),
    situs_unit: entry(["address.unnormalized_address"], [], "address", ""),
  }),
  IMP_DET: Object.freeze({
    prop_id: entry([], [], "join", "join key"),
    prop_val_yr: entry([], [], "read", ""),
    imprv_id: entry([], ["imprv_count"], null, "distinct improvements per account"),
    imprv_det_id: entry([], [], "read", ""),
    imprv_det_type_cd: entry(["property.livable_floor_area", "property.property_structure_built_year"], [], null, "living-area detail types 1ST, 2ND, 3RD, 4TH, 5TH, ADDL, 1/2, FBSMT"),
    yr_built: entry(["property.property_structure_built_year"], [], null, "earliest living-area year, else earliest of any detail; feeds the roof-age default"),
    imprv_det_area: entry(["property.livable_floor_area"], [], null, "sum of living-area details; written when 10 sqft or more"),
  }),
  ABS_SUBD: Object.freeze({
    abs_subdv_cd: entry([], [], "join", "join key"),
    abs_subdv_desc: entry(["property.subdivision"], [], null, ""),
  }),
});

/**
 * The fields `t5-tcad-extras.mjs` reads (its `PROP_EXTRA_FIELDS`, `PROP_ENT_FIELDS`, `IMP_ATR_FIELDS`, `LAND_DET_FIELDS`
 * and `IMP_INFO_FIELDS`) and where each lands. `seed` names the role of a join or filter field.
 */
export const TRAVIS_EXTRAS_FIELD_COVERAGE = Object.freeze({
  PROP: Object.freeze({
    prop_type_cd: entry([], [], "filter", "only the first R record of a seed account is read (the seed builder's rule)"),
    sup_num: entry([], [], "join", "selects the PROP_ENT rows of that record"),
    py_owner_id: entry([], [], "join", "selects the PROP_ENT rows of that record's owner"),
    ten_percent_cap: entry(["tax.homestead_cap_loss_amount"], ["tcad_extras.ten_percent_cap"], null, "Ten Percent Homestead Cap Adjustment; written when positive (34,774 accounts), like the agricultural value"),
  }),
  PROP_ENT: Object.freeze({
    prop_id: entry([], [], "join", "join key"),
    sup_num: entry([], [], "join", "the seed record's supplement"),
    owner_id: entry([], [], "join", "the seed record's owner"),
    entity_cd: entry([], ["tcad_extras.taxing_entities"], null, "kept with the entity"),
    entity_name: entry([], ["tcad_extras.taxing_entities"], "class", "travis-taxing-entity-classes-v1: county, hospital district, college district, ISD, city or village; every other entity counted"),
    taxable_val: entry(
      ["tax.county_taxable_value_amount", "tax.hospital_taxable_value_amount", "tax.college_taxable_value_amount", "tax.school_taxable_value_amount", "tax.city_taxable_value_amount"],
      ["tcad_extras.taxing_entities"],
      null,
      "the one entity of the class on the account; two entities of one class (a split account) leave the field out",
    ),
    partial_entity: entry([], ["tcad_extras.taxing_entities"], null, "T when the property is not wholly inside the entity"),
  }),
  IMP_ATR: Object.freeze({
    prop_id: entry([], [], "join", "join key"),
    imprv_id: entry([], [], "read", "every improvement of the account is read; one structure per property"),
    imprv_det_id: entry([], [], "read", ""),
    imprv_attr_desc: entry([], [], "select", "Roof Covering, Roof Style and Foundation have a lexicon home; Floor, Shape, Grade and Ceiling Factor, Location, Condo Floor and Unique Feature are appraisal factors (counted only)"),
    imprv_attr_cd: entry(
      ["structure.roof_covering_material", "structure.roof_material_type", "structure.roof_design_type", "structure.foundation_type"],
      ["tcad_extras.imp_atr"],
      null,
      "travis-tcad-extras-mapping-v1 exact-value tables; one printed code per attribute per account, else null",
    ),
  }),
  LAND_DET: Object.freeze({
    prop_id: entry([], [], "join", "join key"),
    size_acres: entry(["lot.lot_size_acre"], ["tcad_extras.land"], null, "four implied decimals, summed over segments; written only where the roll prints no legal acreage and it agrees with the square feet within 1%"),
    size_square_feet: entry(["lot.lot_area_sqft"], ["tcad_extras.land"], null, "summed over segments; written only where the roll prints no legal acreage (72,997 of 73,334 such accounts)"),
  }),
  IMP_INFO: Object.freeze({
    prop_id: entry([], [], "join", "join key"),
    imprv_id: entry([], [], "read", ""),
    imprv_type_cd: entry([], ["tcad_extras.improvement_types"], null, "inventory (106 type codes); see TRAVIS_EXPORT_FIELDS_NOT_READ"),
    imprv_type_desc: entry([], [], "read", "inventory only"),
  }),
});

/**
 * Export fields with a lexicon home that the transform still does not write, each with the reason (recorded, not lost).
 * v2 listed `ten_percent_cap`, the `PROP_ENT.TXT` taxable values, `LAND_DET.TXT` and `IMP_ATR.TXT` here; v3 writes them.
 */
export const TRAVIS_EXPORT_FIELDS_NOT_READ = Object.freeze([
  Object.freeze({ file: "PROP_ENT.TXT", field: "taxable_val of special districts (ESD, MUD, WCID, PID, road and utility districts)", lexicon: "tax.special_district_taxable_value_amount", reason: "an account sits in several special districts and the class holds one value; counted in the sidecar (tcad_extras.taxing_entities_other)" }),
  Object.freeze({ file: "PROP_ENT.TXT", field: "per-entity exemption amounts (hs_amt, ov65_amt, dv_amt, ex_amt, ...)", lexicon: "tax.property_exemption_amount", reason: "exemptions are granted per entity; the account-wide amount is not printed and is not derived" }),
  Object.freeze({ file: "PROP_ENT.TXT", field: "account-wide taxable value", lexicon: "tax.property_taxable_value_amount", reason: "not printed: taxable values are per entity; the per-class fields carry them" }),
  Object.freeze({ file: "IMP_INFO.TXT", field: "improvement type (imprv_type_cd, imprv_type_desc)", lexicon: "property.structure_form, structure.number_of_buildings", reason: "a type describes one improvement of several on an account (houses, garage apartments, detail-only rows); no printed value names the property's form or its building count one to one; the codes are kept in the sidecar" }),
  Object.freeze({ file: "IMP_ATR.TXT", field: "exterior wall", lexicon: "structure.exterior_wall_material_primary", reason: "the 2026 export prints no exterior-wall attribute (0 of 2,609,059 attribute rows)" }),
]);

/**
 * The TNR "TCAD Parcels" feature (`TCAD_public/MapServer/0`, the cached pages the seed joined), field by field.
 */
export const TRAVIS_TNR_FEATURE_COVERAGE = Object.freeze({
  OBJECTID: entry([], ["tnr.object_id"], "tnr_object_id", "the layer's row id, kept beside the archive"),
  PROP_ID: entry(["parcel.parcel_identifier"], [], "join", "the join key to the roll (the identifier itself comes from the roll)"),
  geo_id: entry([], [], "read", "not written: the roll's geo_id is the one kept (sidecar geo_id); its agreement with the layer's is counted in the coverage record"),
  "geometry (outer rings)": entry(["geometry.polygon"], ["geometry.parts", "geometry.parts_written"], "parcel_polygon", "one geometry per polygon part (transform v4); a single-part parcel keeps point and polygon in geometry.json"),
  "geometry (centroid)": entry(["geometry.latitude", "geometry.longitude", "address.latitude", "address.longitude"], [], "latitude", "area-weighted centroid of the outer rings, computed by the seed builder"),
  "geometry (inner rings)": entry([], ["geometry.inner_rings_dropped"], null, "lexicon gap: geometry.polygon has no holes"),
});
