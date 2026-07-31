#!/usr/bin/env node
/**
 * Checks the atlas against its own stated method.
 *
 *   node scripts/validate.mjs           report and exit non-zero on error
 *   node scripts/validate.mjs --stats   also print completeness per domain
 *
 * Only dependency is js-yaml.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

const ATLAS = "atlas";
const DIAGNOSTICS = "diagnostics";
const LENSES = "lenses/lenses.yaml";

const MILLER_TARGET = 5;   // stated default
const MILLER_MAX = 7;      // stated ceiling

const REQUIRED_KEYS = [
  "definition", "inclusion", "exclusion",
  "sources", "boundary_cases", "uncertainty",
];

const errors = [];
const warnings = [];
const byId = new Map();     // id -> { node, path }
const byPath = new Map();   // slash path -> node

const err = (where, msg) => errors.push(`${where}\n    ${msg}`);
const warn = (where, msg) => warnings.push(`${where}\n    ${msg}`);

// --- load ------------------------------------------------------------------

function loadYaml(file) {
  try {
    return yaml.load(readFileSync(file, "utf8"));
  } catch (e) {
    err(file, `could not be parsed: ${e.message}`);
    return null;
  }
}

const domainFiles = existsSync(ATLAS)
  ? readdirSync(ATLAS).filter((f) => f.endsWith(".yaml"))
  : [];

if (!domainFiles.length) {
  console.error(`No domain files found in ${ATLAS}/`);
  process.exit(1);
}

const domains = [];
for (const f of domainFiles) {
  const doc = loadYaml(join(ATLAS, f));
  if (doc) domains.push({ file: join(ATLAS, f), root: doc });
}

// --- walk ------------------------------------------------------------------

function walk(node, trail, file, depth, visit) {
  const path = [...trail, node.id].join("/");
  visit(node, path, file, depth);
  for (const child of node.children ?? []) {
    walk(child, [...trail, node.id], file, depth + 1, visit);
  }
}

// pass 1: index and structural checks
for (const { file, root } of domains) {
  walk(root, [], file, 0, (node, path, f, depth) => {
    const where = `${f} → ${path}`;

    if (!node.id) { err(where, "missing `id`"); return; }
    if (!node.name) err(where, "missing `name`");
    if (!/^[a-z0-9-]+$/.test(node.id))
      err(where, `id "${node.id}" must be lowercase letters, numbers and hyphens`);

    if (byId.has(node.id)) {
      err(where, `duplicate id "${node.id}", already used at ${byId.get(node.id).path}`);
    } else {
      byId.set(node.id, { node, path, file: f, depth });
    }
    byPath.set(path, node);

    for (const key of REQUIRED_KEYS) {
      if (!(key in node)) err(where, `missing required key \`${key}\` (an empty value is fine, a missing key is not)`);
    }

    const kids = node.children ?? [];

    // Rule: decomposable into 2+, or terminal
    if (kids.length === 1)
      err(where, "has exactly one child — a division that divides nothing. Either add siblings or mark it `terminal: true`.");
    if (kids.length === 0 && node.terminal !== true)
      warn(where, "has no children and is not marked `terminal: true` — treated as unfinished, not as an endpoint node.");

    // Rule: Miller's bound
    if (kids.length > MILLER_MAX)
      err(where, `divides into ${kids.length} components, above the stated ceiling of ${MILLER_MAX}.`);
    else if (kids.length > MILLER_TARGET)
      warn(where, `divides into ${kids.length} components, above the stated target of ${MILLER_TARGET} but within the ceiling of ${MILLER_MAX}.`);
  });
}

// pass 2: resolve exclusion pointers
const lensIds = new Set();
if (existsSync(LENSES)) {
  const lenses = loadYaml(LENSES) ?? [];
  for (const l of lenses) lensIds.add(l.id);
}

for (const { file, root } of domains) {
  walk(root, [], file, 0, (node, path, f) => {
    for (const ex of node.exclusion ?? []) {
      if (typeof ex === "string") {
        warn(`${f} → ${path}`, `exclusion "${ex}" is a bare string with no \`goes_to\`. Excluding something without saying where it goes leaves it nowhere.`);
        continue;
      }
      if (!ex.goes_to) {
        warn(`${f} → ${path}`, `exclusion "${ex.text ?? "?"}" has no \`goes_to\`.`);
        continue;
      }
      const target = ex.goes_to.split("/").pop();
      const known = byId.has(target) || (ex.kind === "lens" && lensIds.has(target));
      if (!known)
        err(`${f} → ${path}`, `exclusion points to "${ex.goes_to}", which does not exist in the atlas or the lens list.`);
    }
  });
}

// pass 3: diagnostics
if (existsSync(DIAGNOSTICS)) {
  for (const f of readdirSync(DIAGNOSTICS).filter((x) => x.endsWith(".yaml"))) {
    const file = join(DIAGNOSTICS, f);
    const d = loadYaml(file);
    if (!d) continue;
    const VALID_INTENT = ["application", "stress-test", "differentiation", "modification", "verification"];
    const VALID_OUTCOME = ["no-issue", "resolved", "unresolved"];
    if (!VALID_INTENT.includes(d.intent))
      err(file, `intent "${d.intent}" is not one of: ${VALID_INTENT.join(", ")}`);
    if (!VALID_OUTCOME.includes(d.outcome))
      err(file, `outcome "${d.outcome}" is not one of: ${VALID_OUTCOME.join(", ")}`);
    for (const p of d.paths ?? []) {
      if (!byPath.has(p) && !byId.has(p.split("/").pop()))
        err(file, `path "${p}" does not resolve to a node in the atlas.`);
    }
  }
}

// --- completeness ----------------------------------------------------------

function stats() {
  console.log("\nCompleteness\n" + "-".repeat(64));
  for (const { file, root } of domains) {
    let total = 0, defined = 0, sourced = 0, maxDepth = 0;
    walk(root, [], file, 0, (node, _p, _f, depth) => {
      total++;
      if (node.definition && node.definition.trim()) defined++;
      if ((node.sources ?? []).length) sourced++;
      maxDepth = Math.max(maxDepth, depth);
    });
    const pct = (n) => String(Math.round((n / total) * 100)).padStart(3);
    console.log(
      `${root.name.padEnd(24)} L${maxDepth}  ` +
      `${String(total).padStart(4)} nodes  ` +
      `${pct(defined)}% defined  ${pct(sourced)}% sourced`
    );
  }
}

// --- report ----------------------------------------------------------------

const label = (s, n) => `${n} ${s}${n === 1 ? "" : "s"}`;

if (warnings.length) {
  console.log(`\n${label("warning", warnings.length)}\n` + "-".repeat(64));
  for (const w of warnings) console.log("  " + w);
}

if (errors.length) {
  console.log(`\n${label("error", errors.length)}\n` + "-".repeat(64));
  for (const e of errors) console.log("  " + e);
}

if (process.argv.includes("--stats")) stats();

console.log(
  `\n${byId.size} nodes across ${domains.length} domain file${domains.length === 1 ? "" : "s"}. ` +
  `${errors.length} error${errors.length === 1 ? "" : "s"}, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}.\n`
);

process.exit(errors.length ? 1 : 0);
