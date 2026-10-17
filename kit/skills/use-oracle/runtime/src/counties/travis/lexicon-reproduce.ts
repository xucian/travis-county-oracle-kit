// T2 evidence tool (docs/evidence/travis-t2-lexicon-reproduction-20261016.json); not part of the runtime.
// Usage, inside a scratch clone of elephant-xyz/lexicon (never the working fork):
//   mkdir .t2-repro && cp <kit>/skills/use-oracle/runtime/src/counties/travis/lexicon-reproduce.ts .t2-repro/reproduce.ts
//   npm ci --ignore-scripts && npx vite-node .t2-repro/reproduce.ts src/data/lexicon.json <out-dir>
// Writes <out-dir>/manifest.json ({name: {ipfsCid, type}}) and <out-dir>/schemas/<cid>.json.
// Reproduce the lexicon's published schemas and manifest from src/data/lexicon.json with the repository's own
// generator (vite-plugins/json-schema-generator: generateJSONSchemaFor{Class,Relationship,DataGroup} + canonicalize)
// in the publish order of the repository's former Pinata publisher (75979e7^: classes, then relationships with the
// class CIDs, then data groups with the relationship CIDs; examples as `<name>_example`,
// `relationship_<type>_example`). Pinata pinFileToIPFS with cidVersion 1 stores a single-chunk file as a raw leaf,
// so each CID is CIDv1 raw (0x55) sha2-256 of the canonical UTF-8 bytes; it is computed here, nothing is uploaded.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { canonicalize } from 'json-canonicalize';
import {
  generateJSONSchemaForClass,
  generateJSONSchemaForRelationship,
  generateJSONSchemaForDataGroup,
} from '../vite-plugins/json-schema-generator/index';
import type { LexiconData, DataGroupRelationship } from '../src/types/lexicon';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
export function rawCid(text: string): string {
  const digest = createHash('sha256').update(Buffer.from(text, 'utf-8')).digest();
  return `b${base32(Uint8Array.from([0x01, 0x55, 0x12, 0x20, ...digest]))}`;
}

const [lexiconPath, outDir] = process.argv.slice(2);
const lexicon: LexiconData = JSON.parse(await readFile(lexiconPath, 'utf-8'));
const tag = lexicon.tags.find(t => t.name === 'blockchain');
if (!tag) throw new Error('no blockchain tag');
const manifest: Record<string, { ipfsCid: string; type: 'class' | 'relationship' | 'dataGroup' }> = {};
const bodies: Record<string, string> = {};
const put = (name: string, type: 'class' | 'relationship' | 'dataGroup', text: string): string => {
  const cid = rawCid(text);
  manifest[name] = { ipfsCid: cid, type };
  bodies[cid] = text;
  return cid;
};

const classCids: Record<string, string> = {};
for (const className of tag.classes) {
  const lexiconClass = lexicon.classes.find(c => c.type === className);
  if (!lexiconClass) continue;
  classCids[className] = put(className, 'class', canonicalize(generateJSONSchemaForClass(lexiconClass)));
  if (lexiconClass.example) put(`${className}_example`, 'class', canonicalize(lexiconClass.example));
}

const unique = new Map<string, DataGroupRelationship>();
for (const dataGroup of lexicon.data_groups) {
  for (const relationship of dataGroup.relationships ?? []) {
    if (tag.classes.includes(relationship.from) && tag.classes.includes(relationship.to)) {
      const key = `${relationship.from}_to_${relationship.to}`;
      if (!unique.has(key)) unique.set(key, relationship);
    }
  }
}
const relationshipExamples = lexicon.classes.find(c => c.type === 'relationship')?.examples || [];
const relationshipCids: Record<string, string> = {};
const exampleQueue: [string, string][] = [];
for (const [key, relationship] of unique.entries()) {
  relationshipCids[key] = put(key, 'relationship', canonicalize(generateJSONSchemaForRelationship(relationship, classCids)));
  for (const example of relationshipExamples.filter(e => e.type === relationship.relationship_type || e.type === `has_${relationship.to}`)) {
    exampleQueue.push([`relationship_${example.type}_example`, canonicalize(example)]);
  }
}
for (const [name, text] of exampleQueue) put(name, 'class', text);

const labels = lexicon.data_groups.map(g => g.label);
for (const dataGroup of lexicon.data_groups) {
  const map: Record<string, { cid: string; relationshipType: string }> = {};
  for (const relationship of dataGroup.relationships ?? []) {
    const key = `${relationship.from}_to_${relationship.to}`;
    if (relationshipCids[key]) map[key] = { cid: relationshipCids[key], relationshipType: relationship.relationship_type || `has_${relationship.to}` };
  }
  if (Object.keys(map).length === 0) continue;
  const groupKey = dataGroup.label.replace(/\s+/g, '_');
  put(groupKey, 'dataGroup', canonicalize(generateJSONSchemaForDataGroup(dataGroup, map, labels)));
  if (dataGroup.example) put(`${groupKey}_example`, 'class', canonicalize(dataGroup.example));
}

await mkdir(path.join(outDir, 'schemas'), { recursive: true });
for (const [cid, text] of Object.entries(bodies)) await writeFile(path.join(outDir, 'schemas', `${cid}.json`), text, 'utf-8');
await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ entries: Object.keys(manifest).length, files: Object.keys(bodies).length }));
