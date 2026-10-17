/**
 * Travis post-transform validation helpers: geometry bbox, output-contract
 * structure (both data-group roots, resolvable links, no unused entity), run
 * manifest reconciliation and parcel-id uniqueness. Never calls
 * `@elephant-xyz/cli validate` (Global Constraint); the live-lexicon
 * validation is the operator's `elephant-cli validate` step.
 *
 * @module counties/travis/validate
 */

/** Travis County bounding box from the API contract (30.02-30.63 N, -98.17 to -97.37 W). */
export const TRAVIS_VALIDATION_BBOX = Object.freeze({
  minLat: 30.02,
  maxLat: 30.63,
  minLng: -98.17,
  maxLng: -97.37,
});

/** Every successful Travis parcel must have these entity files. */
export const REQUIRED_DATA_ARTIFACTS = Object.freeze(["property.json", "address.json", "parcel.json"]);

/**
 * @param {unknown} record - A transformed `data/*.json` object (geometry).
 * @returns {Array<{ latitude: number, longitude: number }>} Every finite lat/lon pair on the record or its `polygon`.
 */
export function collectGeometryPoints(record) {
  const points = [];
  if (!record || typeof record !== "object") return points;
  const body = /** @type {Record<string, unknown>} */ (record);
  const lat = Number(body.latitude);
  const lon = Number(body.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lon)) points.push({ latitude: lat, longitude: lon });
  if (Array.isArray(body.polygon)) {
    for (const vertex of body.polygon) {
      if (!vertex || typeof vertex !== "object") continue;
      const vertexLat = Number(/** @type {Record<string, unknown>} */ (vertex).latitude);
      const vertexLon = Number(/** @type {Record<string, unknown>} */ (vertex).longitude);
      if (Number.isFinite(vertexLat) && Number.isFinite(vertexLon)) points.push({ latitude: vertexLat, longitude: vertexLon });
    }
  }
  return points;
}

/**
 * Fail closed if any geometry point falls outside Travis County. A parcel
 * without geometry is allowed (the TNR layer does not cover every assessed
 * unit); it is counted, not failed.
 *
 * @param {Array<{ latitude: number, longitude: number }>} points - From {@link collectGeometryPoints}.
 * @returns {void}
 */
export function assertGeometryInCounty(points) {
  const { minLat, maxLat, minLng, maxLng } = TRAVIS_VALIDATION_BBOX;
  for (const point of points) {
    if (point.latitude < minLat || point.latitude > maxLat || point.longitude < minLng || point.longitude > maxLng) {
      throw new Error(`coordinate ${point.latitude},${point.longitude} is outside the Travis bbox`);
    }
  }
}

/** The county every Travis seed row and record must name (seed.mjs COUNTY_NAME, COUNTY_FIPS). */
export const TRAVIS_IDENTITY = Object.freeze({ county: "Travis", countyFips: "48453", stateCode: "TX" });

/**
 * Hosts an appraisal entity's `source_http_request` may name: the TCAD export and the TNR
 * parcel layer. T4's permit entities will add `data.austintexas.gov` (the Austin permit export).
 */
export const TRAVIS_APPRAISAL_SOURCE_HOSTS = Object.freeze(["traviscad.org", "gis.traviscountytx.gov"]);

/**
 * Fail closed unless one parcel's output is a Travis record: the seed row names Travis and FIPS
 * 48453, every entity's `request_identifier` is the row's `parcel_id`, every entity's
 * `source_http_request.url` is on an appraisal source host, the address is in TX and names no
 * other county, and every geometry point is inside the Travis bbox. The archive carries no county
 * label (decisions.md section 22), so this check is what keeps a wrong-county record out.
 *
 * @param {{ row: Record<string, string>, files: Record<string, Record<string, unknown>>, roots: { countyCid: string, seedCid: string }, sourceHosts?: readonly string[] }} options - Seed row, `data/*.json` keyed by basename, root CIDs, and allowed hosts.
 * @returns {void}
 */
export function assertTravisIdentity({ row, files, roots, sourceHosts = TRAVIS_APPRAISAL_SOURCE_HOSTS }) {
  const fail = (detail) => {
    throw new Error(`not a Travis record: ${detail}`);
  };
  const county = String(row?.county ?? "").trim();
  const fips = String(row?.county_fips ?? "").trim();
  if (county !== TRAVIS_IDENTITY.county || fips !== TRAVIS_IDENTITY.countyFips) {
    fail(`seed row names county ${JSON.stringify(county)} (FIPS ${JSON.stringify(fips)}), expected ${TRAVIS_IDENTITY.county} (${TRAVIS_IDENTITY.countyFips})`);
  }
  const parcelId = String(row?.parcel_id ?? "").trim();
  if (!parcelId) fail("seed row has no parcel_id");
  const rootNames = new Set([`${roots.countyCid}.json`, `${roots.seedCid}.json`]);
  for (const [name, body] of Object.entries(files)) {
    if (rootNames.has(name) || name_is_relationship(name)) continue;
    if (body?.request_identifier !== parcelId) fail(`${name} request_identifier ${JSON.stringify(body?.request_identifier)} is not the seed row's parcel_id ${parcelId}`);
    const url = /** @type {{ url?: unknown } | undefined} */ (body?.source_http_request)?.url;
    let host = null;
    try {
      host = typeof url === "string" ? new URL(url).hostname : null;
    } catch {
      host = null;
    }
    if (!host || !sourceHosts.includes(host)) fail(`${name} source_http_request host ${JSON.stringify(host)} is not an appraisal source (${sourceHosts.join(", ")})`);
  }
  const address = files["address.json"];
  if (!address) fail("no address.json");
  if (address.state_code !== TRAVIS_IDENTITY.stateCode) fail(`address.json state_code ${JSON.stringify(address.state_code)} is not ${TRAVIS_IDENTITY.stateCode}`);
  if (Object.hasOwn(address, "county_name") && address.county_name !== TRAVIS_IDENTITY.county) {
    fail(`address.json county_name ${JSON.stringify(address.county_name)} is not ${TRAVIS_IDENTITY.county}`);
  }
  if (files["geometry.json"]) assertGeometryInCounty(collectGeometryPoints(files["geometry.json"]));
}

/**
 * @param {unknown} link - `{"/": "./file.json"}`.
 * @returns {string | null} The relative file name, or null when not a link.
 */
function linkTarget(link) {
  if (!link || typeof link !== "object") return null;
  const target = /** @type {Record<string, unknown>} */ (link)["/"];
  return typeof target === "string" ? target.replace(/^\.\//, "") : null;
}

/**
 * Structural check of one parcel's `data/` files against the kit output
 * contract: the Seed and County roots exist and are named by the given
 * schema CIDs, every root relationship resolves to a relationship file, every
 * relationship resolves both ends to entity files, and no entity file is
 * left unreferenced (the CLI reports those as `Unused data JSON file`).
 *
 * @param {Record<string, Record<string, unknown>>} files - `data/*.json` keyed by basename (relationships included).
 * @param {{ countyCid: string, seedCid: string }} roots - Data-group schema CIDs the roots must be named by.
 * @returns {{ rootKeys: string[], relationshipFiles: string[], entityFiles: string[] }} What was checked.
 */
export function assertOutputContract(files, { countyCid, seedCid }) {
  const names = new Set(Object.keys(files));
  for (const required of REQUIRED_DATA_ARTIFACTS) {
    if (!names.has(required)) throw new Error(`missing data/${required}`);
  }
  const rootNames = [`${countyCid}.json`, `${seedCid}.json`];
  const referencedRelationships = new Set();
  const rootKeys = [];
  for (const rootName of rootNames) {
    const root = files[rootName];
    if (!root) throw new Error(`missing data-group root ${rootName}`);
    if (typeof root.label !== "string" || !root.relationships || typeof root.relationships !== "object") {
      throw new Error(`${rootName} must carry label and relationships`);
    }
    for (const [key, value] of Object.entries(root.relationships)) {
      rootKeys.push(key);
      const links = Array.isArray(value) ? value : [value];
      for (const link of links) {
        const target = linkTarget(link);
        if (!target || !names.has(target)) throw new Error(`${rootName}.${key} links to missing ${String(target)}`);
        referencedRelationships.add(target);
      }
    }
  }
  const referencedEntities = new Set();
  for (const relationshipName of referencedRelationships) {
    const relationship = files[relationshipName];
    const from = linkTarget(relationship?.from);
    const to = linkTarget(relationship?.to);
    if (!from || !to || !names.has(from) || !names.has(to)) {
      throw new Error(`${relationshipName} must link two existing entity files (from=${String(from)}, to=${String(to)})`);
    }
    if (Object.keys(relationship).length !== 2) throw new Error(`${relationshipName} must carry only from and to`);
    referencedEntities.add(from);
    referencedEntities.add(to);
  }
  const entityFiles = [...names].filter((name) => !rootNames.includes(name) && !referencedRelationships.has(name));
  for (const entity of entityFiles) {
    if (name_is_relationship(entity)) throw new Error(`relationship file ${entity} is not referenced by any root`);
    if (!referencedEntities.has(entity)) throw new Error(`entity file ${entity} is not linked by any relationship`);
  }
  return { rootKeys, relationshipFiles: [...referencedRelationships], entityFiles };
}

/**
 * @param {string} name - File basename.
 * @returns {boolean} Whether the name follows the relationship convention.
 */
function name_is_relationship(name) {
  return name.startsWith("relationship_");
}

/**
 * @typedef {object} ManifestReconciliation
 * @property {number} seedRows
 * @property {number} success
 * @property {number} permanentFailure
 * @property {number} retryableFailure
 */

/**
 * Fail closed unless every seed row landed in exactly one outcome bucket
 * (Global Constraint: `seed = success + permanent_failure + retryable_failure`).
 *
 * @param {ManifestReconciliation} reconciled - Manifest outcome counts.
 * @returns {void}
 */
export function assertManifestReconciled(reconciled) {
  const total = reconciled.success + reconciled.permanentFailure + reconciled.retryableFailure;
  if (reconciled.seedRows !== total) {
    throw new Error(
      `manifest seedRows ${reconciled.seedRows} != success ${reconciled.success} + permanentFailure ${reconciled.permanentFailure} + retryableFailure ${reconciled.retryableFailure}`,
    );
  }
}

/**
 * Fail closed on a duplicate `parcelId` across an ingest run's results.
 *
 * @param {readonly { parcelId: string }[]} results - Per-parcel ingest results.
 * @returns {void}
 */
export function assertUniqueParcelIds(results) {
  const ids = results.map((result) => result.parcelId);
  const distinct = new Set(ids);
  if (distinct.size !== ids.length) {
    throw new Error(`manifest results have duplicate parcelId values (${ids.length} rows, ${distinct.size} distinct)`);
  }
}
