/**
 * Travis exact-unique-normalized-name matcher (assignment decisions.md section 23).
 *
 * A printed name (a permit's contractor company or person, a roll owner) is normalized and looked up in an index of
 * official business or license rows. It yields a review candidate only when the normalized name maps to exactly one
 * entity key in the whole index (the matching universe); several keys give no candidate, and a missing or empty name
 * gives none. A candidate is never identity: callers label it `status: "candidate"` and never write a `company`,
 * `person` or `license` record or an identity edge from it.
 *
 * The universe decides uniqueness. For the Comptroller it is the statewide file, so a Travis name that a taxpayer
 * elsewhere in Texas shares has no candidate, and a unique name of a taxpayer outside Travis is a candidate flagged
 * `scope: "out_of_county"`.
 *
 * This module is pure ECMAScript with no imports, so the internal reconciliation run (the kit runtime) and the
 * deploy-time build (`packages/deploy-build` in the assignment repository, which imports it from the pinned kit
 * worktree) run the same versioned code, and their candidate counts reconcile.
 *
 * @module counties/travis/name-matcher
 */

export const MATCHER_VERSION = "travis-exact-unique-normalized-name.v1";
export const MATCH_METHOD = "exact_unique_normalized_name";

/**
 * Legal-form words removed before comparison (whole words, any position, optional trailing period). Removing them lets
 * a permit that prints "Acme Roofing" find "ACME ROOFING, LLC"; two entities that differ only by their legal form
 * collapse to one normalized name and therefore yield no candidate, which is the safe outcome.
 */
const LEGAL_FORM_WORDS = /\b(L\.?L\.?C|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|L\.?P|LLP|PLLC|P\.?C|PA|TRUST)\b\.?/g;
const COMBINING_MARKS = /[̀-ͯ]/g;
const NOT_ALPHANUMERIC = /[^A-Z0-9 ]/g;
const WHITESPACE_RUN = /\s+/g;

/**
 * Normalize a printed name for exact comparison: Unicode compatibility decomposition with accents removed, upper case,
 * legal-form words removed, every other character than A-Z, 0-9 and space turned into a space, spaces collapsed.
 *
 * @param {unknown} printed - The name as printed.
 * @returns {string | null} The normalized name, or null when nothing comparable remains.
 */
export function normalizeName(printed) {
  if (typeof printed !== "string") return null;
  const text = printed
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toUpperCase()
    .replace(LEGAL_FORM_WORDS, " ")
    .replace(NOT_ALPHANUMERIC, " ")
    .replace(WHITESPACE_RUN, " ")
    .trim();
  return text === "" ? null : text;
}

/**
 * @typedef {object} IndexEntry
 * @property {string} key - Entity key as printed (for example the taxpayer number).
 * @property {string} scope - `travis` or `out_of_county` (or another scope label the caller defines).
 * @property {string[]} printed_names - Distinct printed names of this key that normalize to the indexed name, sorted.
 * @property {number} rows - Source rows of this key under this name (a duplicated row counts twice, one key).
 * @property {Record<string, unknown>} payload - Caller fields of the first row seen (for example the record id).
 */

/**
 * @typedef {object} NameIndex
 * @property {string} matcher_version - {@link MATCHER_VERSION}.
 * @property {string} source - Source key the index was built from.
 * @property {Map<string, Map<string, IndexEntry>>} names - Normalized name to its entities by key.
 * @property {number} rows_indexed - Rows that produced at least one normalized name.
 * @property {number} rows_without_name - Rows with no comparable name.
 */

/**
 * Build the matching universe from source rows.
 *
 * @param {Iterable<Record<string, unknown>>} rows - Source rows (for example normalized snapshot rows).
 * @param {object} options - Index options.
 * @param {string} options.source - Source key (for example `tx-comptroller-franchise-tax`).
 * @param {readonly string[]} options.nameFields - Row fields holding names to index (each is indexed).
 * @param {(row: Record<string, unknown>) => string | null} options.keyOf - Entity key of a row; null skips the row.
 * @param {(row: Record<string, unknown>) => string} [options.scopeOf] - Scope label of a row (default `travis`).
 * @param {(row: Record<string, unknown>) => Record<string, unknown>} [options.payloadOf] - Fields carried to a candidate.
 * @returns {NameIndex} The index.
 */
export function buildNameIndex(rows, { source, nameFields, keyOf, scopeOf = () => "travis", payloadOf = () => ({}) }) {
  /** @type {Map<string, Map<string, IndexEntry>>} */
  const names = new Map();
  let rowsIndexed = 0;
  let rowsWithoutName = 0;
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null || key === undefined || key === "") continue;
    let indexed = false;
    const seenThisRow = new Set();
    for (const field of nameFields) {
      const printed = row[field];
      const normalized = normalizeName(printed);
      if (normalized === null || seenThisRow.has(normalized)) continue;
      seenThisRow.add(normalized);
      indexed = true;
      let byKey = names.get(normalized);
      if (!byKey) {
        byKey = new Map();
        names.set(normalized, byKey);
      }
      const existing = byKey.get(key);
      const printedText = String(printed).trim();
      if (existing) {
        existing.rows += 1;
        if (!existing.printed_names.includes(printedText)) {
          existing.printed_names.push(printedText);
          existing.printed_names.sort();
        }
      } else {
        byKey.set(key, { key, scope: scopeOf(row), printed_names: [printedText], rows: 1, payload: payloadOf(row) });
      }
    }
    if (indexed) rowsIndexed += 1;
    else rowsWithoutName += 1;
  }
  return { matcher_version: MATCHER_VERSION, source, names, rows_indexed: rowsIndexed, rows_without_name: rowsWithoutName };
}

/**
 * @typedef {object} MatchResult
 * @property {string} matcher_version - {@link MATCHER_VERSION}.
 * @property {string} match_method - {@link MATCH_METHOD}.
 * @property {string} source - Source key of the index.
 * @property {string | null} normalized_name - The query's normalized name.
 * @property {"candidate" | "no_candidate"} status - Whether a review candidate exists.
 * @property {"empty_name" | "no_match" | "not_unique" | null} reason - Why there is no candidate.
 * @property {number} candidate_count - Distinct entity keys under the normalized name.
 * @property {(IndexEntry & { status: "candidate" }) | null} candidate - The unique entity, never an identity.
 */

/**
 * Look one printed name up.
 *
 * @param {NameIndex} index - Index from {@link buildNameIndex}.
 * @param {unknown} printedName - The name as printed.
 * @returns {MatchResult} The match result.
 */
export function matchName(index, printedName) {
  const base = { matcher_version: MATCHER_VERSION, match_method: MATCH_METHOD, source: index.source };
  const normalized = normalizeName(printedName);
  if (normalized === null) {
    return { ...base, normalized_name: null, status: "no_candidate", reason: "empty_name", candidate_count: 0, candidate: null };
  }
  const byKey = index.names.get(normalized);
  if (!byKey || byKey.size === 0) {
    return { ...base, normalized_name: normalized, status: "no_candidate", reason: "no_match", candidate_count: 0, candidate: null };
  }
  if (byKey.size > 1) {
    return { ...base, normalized_name: normalized, status: "no_candidate", reason: "not_unique", candidate_count: byKey.size, candidate: null };
  }
  const [entry] = byKey.values();
  return {
    ...base,
    normalized_name: normalized,
    status: "candidate",
    reason: null,
    candidate_count: 1,
    candidate: { ...entry, printed_names: [...entry.printed_names], payload: { ...entry.payload }, status: "candidate" },
  };
}

/**
 * Collision summary of an index: how many normalized names map to more than one entity key.
 *
 * @param {NameIndex} index - Index from {@link buildNameIndex}.
 * @returns {{ matcher_version: string, source: string, normalized_names: number, entity_keys: number, unique_names: number, non_unique_names: number, keys_under_non_unique_names: number, rows_indexed: number, rows_without_name: number, by_scope: Record<string, number> }} Counts only.
 */
export function summarizeNameIndex(index) {
  let nonUnique = 0;
  let keysUnderNonUnique = 0;
  const keys = new Set();
  /** @type {Map<string, string>} */
  const scopeByKey = new Map();
  for (const byKey of index.names.values()) {
    if (byKey.size > 1) {
      nonUnique += 1;
      keysUnderNonUnique += byKey.size;
    }
    for (const entry of byKey.values()) {
      keys.add(entry.key);
      if (!scopeByKey.has(entry.key)) scopeByKey.set(entry.key, entry.scope);
    }
  }
  /** @type {Record<string, number>} */
  const byScope = {};
  for (const scope of scopeByKey.values()) byScope[scope] = (byScope[scope] ?? 0) + 1;
  return {
    matcher_version: index.matcher_version,
    source: index.source,
    normalized_names: index.names.size,
    entity_keys: keys.size,
    unique_names: index.names.size - nonUnique,
    non_unique_names: nonUnique,
    keys_under_non_unique_names: keysUnderNonUnique,
    rows_indexed: index.rows_indexed,
    rows_without_name: index.rows_without_name,
    by_scope: Object.fromEntries(Object.entries(byScope).sort(([a], [b]) => a.localeCompare(b))),
  };
}
