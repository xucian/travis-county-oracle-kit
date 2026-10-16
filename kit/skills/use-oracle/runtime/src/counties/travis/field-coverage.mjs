/**
 * Field coverage of the Travis appraisal transform (the T2 proof): every TCAD
 * export field the seed builder reads (`build-seed.mjs` PROP_FIELDS,
 * IMP_DET_FIELDS, ABS_SUBD_FIELDS) and where it lands: a lexicon `class.field`,
 * the per-parcel sidecar `source-payload.json` (lexicon gap, never in the
 * archive), or seed building only. `tests/travis-field-coverage.test.mjs`
 * fails when a read field has no entry or an entry names a target the
 * transform does not write.
 */

export const TRAVIS_FIELD_COVERAGE_VERSION = "travis-field-coverage-v1";

const entry = (lexicon, sidecar, seed, note) => Object.freeze({ lexicon: Object.freeze(lexicon), sidecar: Object.freeze(sidecar), seed, note });

/** @type {Readonly<Record<"PROP" | "IMP_DET" | "ABS_SUBD", Readonly<Record<string, { lexicon: readonly string[], sidecar: readonly string[], seed: string | null, note: string }>>>>} */
export const TRAVIS_FIELD_COVERAGE = Object.freeze({
  PROP: Object.freeze({
    prop_id: entry(["property.parcel_identifier", "parcel.parcel_identifier", "property_seed.parcel_id", "property.request_identifier"], ["prop_id"], "parcel_id", "int(12) printed zero-padded; the identifier is the integer (decisions 19, 21)"),
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
    situs_street_prefx: entry(["address.unnormalized_address", "unnormalized_address.full_address"], [], "address", ""),
    situs_street: entry(["address.unnormalized_address", "unnormalized_address.full_address"], [], "address", "blank street: permanent failure \"no situs address\" (25 roll rows)"),
    situs_street_suffix: entry(["address.unnormalized_address", "unnormalized_address.full_address"], [], "address", ""),
    situs_city: entry(["address.city_name", "address.unnormalized_address", "unnormalized_address.full_address"], ["situs_city"], "city", "blank on 58.9% of the roll: city_name null, never derived"),
    situs_zip: entry(["address.postal_code", "address.unnormalized_address", "unnormalized_address.full_address"], [], "zip", "first five digits"),
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
    situs_num: entry(["address.unnormalized_address", "unnormalized_address.full_address"], [], "address", ""),
    situs_unit: entry(["address.unnormalized_address", "unnormalized_address.full_address"], [], "address", ""),
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

/** Export fields with a lexicon home that v1 does not read (recorded, not lost). */
export const TRAVIS_EXPORT_FIELDS_NOT_READ = Object.freeze([
  Object.freeze({ file: "PROP.TXT", field: "ten_percent_cap", lexicon: "tax.homestead_cap_loss_amount" }),
  Object.freeze({ file: "PROP_ENT.TXT", field: "per-entity taxable values and exemptions", lexicon: "tax.property_taxable_value_amount, tax.<entity>_taxable_value_amount, tax.property_exemption_amount" }),
  Object.freeze({ file: "LAND_DET.TXT", field: "land segment size", lexicon: "lot.lot_area_sqft for platted lots printed with 0 legal acreage" }),
  Object.freeze({ file: "IMP_ATR.TXT", field: "improvement attributes (roof covering, exterior wall)", lexicon: "structure.roof_covering_material, structure.exterior_wall_material" }),
  Object.freeze({ file: "IMP_INFO.TXT", field: "improvement type and class", lexicon: "structure / property.structure_form" }),
]);
