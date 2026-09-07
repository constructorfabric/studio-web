#!/usr/bin/env node
// Regenerate the domain-model UI's file set from the stored domain model.
//
// Goal #3 of the domain-model work: the model lives in Graph Storage as GTS
// types (the `studio-domain-model` gear); reading it back yields the
// domain-entity document, which is exactly the shape the model UI renders from.
// This script turns that document into the `entities.json` / `buckets.json` /
// `model-manifest.json` file set the UI's `app.js` loads — so once a type has
// been extended in the graph, the frontend can be regenerated from it.
//
// Input (a path, or stdin): either
//   * the gear's `GET /studio-domain-model/v1/types` response: { ontology: {…} }
//   * or a raw ontology document:                              { entities: […], bucket_def: {…} }
//   * or the embedded slice file (the default).
//
// Usage:
//   node regen-domain-frontend.mjs [ontology.json] [--out DIR] [--validate PATH_TO_schema-validator.js]
//
// With --validate pointing at studio-internal/domain-model-ui/schema-validator.js
// every regenerated entity is checked against the domain-entity contract, so the
// output is proven consumable by the UI, not merely plausible.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_INPUT = resolve(HERE, "../src/domain_model/ontology.core.json");

function parseArgs(argv) {
  const args = { input: DEFAULT_INPUT, out: resolve(process.cwd(), "regen-out"), validate: null };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = resolve(process.cwd(), argv[++i]);
    else if (a === "--validate") args.validate = resolve(process.cwd(), argv[++i]);
    else positionals.push(a);
  }
  if (positionals[0]) args.input = resolve(process.cwd(), positionals[0]);
  return args;
}

// Normalize any of the accepted input shapes to a single ontology document.
function toOntology(raw) {
  const doc = raw && typeof raw === "object" && raw.ontology ? raw.ontology : raw;
  if (!doc || !Array.isArray(doc.entities)) {
    throw new Error("input has no `entities` array (expected a /types response or an ontology document)");
  }
  // Bucket definitions: the full model carries `buckets: [...]`; the old
  // single-bucket slice carried `bucket` + `bucket_def`.
  const bucketDefs = Array.isArray(doc.buckets)
    ? doc.buckets
    : doc.bucket_def
      ? [doc.bucket_def]
      : [];
  return { bucketDefs, entities: doc.entities };
}

// Group entities by their `bucket` field.
function groupByBucket(entities) {
  const byBucket = new Map();
  for (const entity of entities) {
    const bucket = entity.bucket || "domain";
    if (!byBucket.has(bucket)) byBucket.set(bucket, []);
    byBucket.get(bucket).push(entity);
  }
  return byBucket;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = JSON.parse(readFileSync(args.input, "utf8"));
  const { bucketDefs, entities } = toOntology(raw);

  // The UI loads bare arrays per file, wired by the manifest (see app.js): one
  // `<bucket>/entities.json` + `<bucket>/buckets.json` per bucket.
  const byBucket = groupByBucket(entities);
  const definitionFiles = [];
  for (const [bucket, bucketEntities] of byBucket) {
    writeJson(join(args.out, bucket, "entities.json"), bucketEntities);
    const defs = bucketDefs.filter((b) => b.id === bucket);
    writeJson(join(args.out, bucket, "buckets.json"), defs);
    definitionFiles.push(`${bucket}/buckets.json`, `${bucket}/entities.json`);
  }
  const manifestPath = join(args.out, "model-manifest.json");
  writeJson(manifestPath, { metaFile: "core/meta.json", definitionFiles });

  console.log(`Regenerated ${byBucket.size} bucket(s), ${entities.length} entities from ${args.input}`);
  for (const [bucket, bucketEntities] of byBucket) {
    console.log(`  ${bucket}: ${bucketEntities.length} entities`);
  }
  console.log(`  manifest -> ${manifestPath}`);

  if (!args.validate) {
    console.log("\n(no --validate given; skipping the domain-entity contract check)");
    return;
  }

  const mod = await import(pathToFileURL(args.validate).href);
  const validate = mod.validateDomainEntity;
  if (typeof validate !== "function") {
    throw new Error(`${args.validate} does not export validateDomainEntity`);
  }
  let failed = 0;
  for (const entity of entities) {
    const errors = validate(entity);
    if (errors.length) {
      failed++;
      console.error(`  ✗ ${entity.id}: ${errors.join("; ")}`);
    }
  }
  if (failed === 0) {
    console.log(`\n✓ all ${entities.length} regenerated entities satisfy the domain-entity contract`);
  } else {
    console.error(`\n✗ ${failed}/${entities.length} entities failed the contract`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
