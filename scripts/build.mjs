#!/usr/bin/env node
/**
 * Builds the site into dist/.
 *
 *   node scripts/build.mjs            report validation, build anyway
 *   node scripts/build.mjs --strict   refuse to build if the atlas has errors
 *
 * Right now this copies the hand-written pages and static files, substitutes
 * the shared partials into them, emits a page per atlas node, and generates
 * the sitemap. The tree and the completeness figures on the homepage are not
 * generated yet — see the TODO at the bottom.
 *
 * Validation always runs and always reports. It does not block the build by
 * default, because the atlas has real unresolved problems and publishing them
 * is the point. Use --strict in CI once the atlas is clean enough that a new
 * error means someone broke something.
 */

import {
  readdirSync, readFileSync, writeFileSync, mkdirSync,
  cpSync, rmSync, existsSync, statSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { execFileSync } from "node:child_process";
import yaml from "js-yaml";

const SITE = "site";
const PAGES = join(SITE, "pages");
const PARTIALS = join(SITE, "templates", "partials");
const TEMPLATES = join(SITE, "templates");
const ATLAS = "atlas";
const LENSES = join("lenses", "lenses.yaml");
const DIAGNOSTICS = "diagnostics";
const DIST = "dist";
const ORIGIN = "https://systemsatlasproject.com";

// --- validate first --------------------------------------------------------

const strict = process.argv.includes("--strict");

try {
  execFileSync("node", ["scripts/validate.mjs"], { stdio: "inherit" });
} catch {
  if (strict) {
    console.error("\nBuild stopped: --strict, and the atlas has errors.\n");
    process.exit(1);
  }
  console.warn(
    "\nThe atlas has unresolved errors, listed above. Building anyway —\n" +
    "they are part of what the site publishes. Run with --strict to block.\n"
  );
}

// --- clean -----------------------------------------------------------------

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// --- static files ----------------------------------------------------------

for (const f of ["styles.css", "_headers", "robots.txt"]) {
  const src = join(SITE, f);
  if (existsSync(src)) cpSync(src, join(DIST, f));
}

if (existsSync(join(SITE, "assets"))) {
  cpSync(join(SITE, "assets"), join(DIST, "assets"), { recursive: true });
}

// --- partials --------------------------------------------------------------
//
// A page pulls in a shared fragment with a comment directive:
//
//     <!--#include masthead-->
//     <!--#include footer-tool name="Konki" slug="konki" terms="yes"-->
//
// Inside a partial, {{key}} is replaced by the value given in the directive,
// and {{#key}}…{{/key}} keeps its contents only when that key has a value.
// That is the whole language. It exists so the nav lives in one file; it is
// not meant to grow into a template engine.

const partialCache = new Map();

function partial(name) {
  if (!partialCache.has(name)) {
    const file = join(PARTIALS, `${name}.html`);
    if (!existsSync(file)) {
      throw new Error(`No partial named "${name}" in ${PARTIALS}/`);
    }
    partialCache.set(name, readFileSync(file, "utf8").trimEnd());
  }
  return partialCache.get(name);
}

function parseArgs(str) {
  const args = {};
  for (const [, key, value] of str.matchAll(/(\w+)="([^"]*)"/g)) args[key] = value;
  return args;
}

function fill(template, args) {
  return template
    .replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key, body) =>
      args[key] ? body : ""
    )
    .replace(/\{\{(\w+)\}\}/g, (match, key) => {
      if (!(key in args)) {
        throw new Error(`Partial expects "${key}", which the page did not give`);
      }
      return args[key];
    });
}

function expand(html, where) {
  return html.replace(
    /^[ \t]*<!--#include\s+([\w-]+)([^>]*?)-->[ \t]*$/gm,
    (_, name, rest) => {
      try {
        return fill(partial(name), parseArgs(rest));
      } catch (err) {
        throw new Error(`${where}: ${err.message}`);
      }
    }
  );
}

// --- pages -----------------------------------------------------------------

const urls = [];

function copyPages(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      copyPages(full);
      continue;
    }
    if (!entry.endsWith(".html")) continue;

    const rel = relative(PAGES, full);
    const out = join(DIST, rel);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, expand(readFileSync(full, "utf8"), rel));

    if (entry === "index.html") {
      const urlPath = dirname(rel) === "." ? "/" : `/${dirname(rel)}/`;
      urls.push(urlPath);
    }
  }
}

if (existsSync(PAGES)) copyPages(PAGES);

// --- atlas node pages ------------------------------------------------------
//
// One page per node at /atlas/<path>/. Level is the node's depth in the tree
// and is computed here every time; the atlas never writes a level down,
// because a number you type is a number that can disagree with the structure
// it describes.
//
// The six required fields are rendered whether or not they hold anything. An
// empty field is a declared gap and is shown as one. Nothing is inferred to
// fill it.

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
           .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// A field is empty when it holds no content — not when the key is absent.
// A missing key is a different failure, and validate.mjs reports it.
const isEmpty = (v) =>
  v == null ||
  (typeof v === "string" && !v.trim()) ||
  (Array.isArray(v) && v.length === 0);

const text = (s) => esc(String(s).trim().replace(/\s+/g, " "));

const FIELDS = [
  ["definition",     "Definition",     "No definition has been written."],
  ["inclusion",      "Inclusion",      "No inclusion criteria have been written."],
  ["exclusion",      "Exclusion",      "No exclusions have been recorded."],
  ["sources",        "Sources",        "No sources have been cited."],
  ["boundary_cases", "Boundary cases", "No boundary cases have been recorded."],
  ["uncertainty",    "Uncertainty",    "No uncertainty has been recorded."],
];

// Every domain in atlas/ is rendered. The set is read off the directory
// rather than listed here, because a list you type is a list that can
// disagree with the directory it describes — the same reason no level number
// is written into the data.

const nodes = new Map();     // "a/b/c" -> { node, depth, trail }
const byId = new Map();      // "c"     -> "a/b/c"
const lensIds = new Set();

const domainFiles = existsSync(ATLAS)
  ? readdirSync(ATLAS).filter((f) => f.endsWith(".yaml"))
  : [];

const domains = [];

for (const f of domainFiles) {
  const root = yaml.load(readFileSync(join(ATLAS, f), "utf8"));
  domains.push(root);
  (function index(node, trail) {
    const path = [...trail, node.id].join("/");
    nodes.set(path, { node, depth: trail.length, trail });
    byId.set(node.id, path);
    for (const child of node.children ?? []) index(child, [...trail, node.id]);
  })(root, []);
}

domains.sort((a, b) => String(a.name).localeCompare(String(b.name)));

if (existsSync(LENSES)) {
  for (const lens of yaml.load(readFileSync(LENSES, "utf8")) ?? []) {
    lensIds.add(lens.id);
  }
}

// --- diagnostics -----------------------------------------------------------
//
// Loaded before the node pages are written, because a node page carries the
// entries that point at it. The link runs both ways: an entry names the nodes
// it applies to, and those nodes name the entry. Neither side is the record
// on its own.

const OUTCOME_LABEL = {
  "no-issue": "No issue",
  resolved: "Resolved",
  unresolved: "Unresolved, left standing",
};

// YAML reads an unquoted 2026-07-31 as a timestamp, so it arrives as a Date.
// Put it back to the date that was written, in UTC — the entry records a day,
// not a moment, and rendering it in the build machine's timezone would let
// the same file publish two different dates.
const isoDate = (d) =>
  d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? "");

const diagnostics = [];
const byNode = new Map();   // node path -> [entry, ...]

if (existsSync(DIAGNOSTICS)) {
  const files = readdirSync(DIAGNOSTICS).filter((f) => f.endsWith(".yaml")).sort();
  for (const f of files) {
    const d = yaml.load(readFileSync(join(DIAGNOSTICS, f), "utf8"));
    const slug = f.replace(/\.yaml$/, "");

    // The heading comes off the filename with the date removed. Nothing is
    // invented: the file is named by whoever wrote the entry, and the entry
    // itself carries no title field.
    const words = slug.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/-/g, " ");
    const heading = words.charAt(0).toUpperCase() + words.slice(1);

    // Resolve each path the way the validator does: a full slash path first,
    // then a bare id. An entry pointing nowhere is a finding the validator
    // reports, and it is shown here rather than dropped.
    const targets = (d.paths ?? []).map((p) => {
      const path = nodes.has(p) ? p : byId.get(String(p).split("/").pop());
      return { given: p, path: path ?? null, node: path ? nodes.get(path).node : null };
    });

    const entry = { ...d, date: isoDate(d.date), slug, heading, targets };
    diagnostics.push(entry);

    for (const t of targets) {
      if (!t.path) continue;
      if (!byNode.has(t.path)) byNode.set(t.path, []);
      byNode.get(t.path).push(entry);
    }
  }
  // Newest first, and stable within a date by slug.
  diagnostics.sort((a, b) =>
    String(b.date).localeCompare(String(a.date)) || a.slug.localeCompare(b.slug));
}

// An exclusion names where the excluded thing goes. Link it when that place
// is in the atlas, and mark it when it exists nowhere — that second case is a
// finding about the atlas, not a formatting problem, so it is shown rather
// than smoothed over. Every domain is rendered now, so a destination inside
// the atlas always has a page to point at.
function destination(goesTo, isLens) {
  const id = String(goesTo).split("/").pop();
  const path = byId.get(id);
  if (path) return `<a href="/atlas/${path}/">${text(goesTo)}</a>`;
  // A lens is not part of the atlas tree and never gets a node page, so it is
  // named plainly. The "lens" label in front of it already says what it is.
  if (isLens) return lensIds.has(id)
    ? text(goesTo)
    : `${text(goesTo)} <span class="unresolved">is not one of the eleven lenses</span>`;
  return `${text(goesTo)} <span class="unresolved">does not exist in the atlas</span>`;
}

function renderList(items, render) {
  return `<ul>\n${items.map((i) => `            <li><span>${render(i)}</span></li>`).join("\n")}\n          </ul>`;
}

function renderSource(s) {
  if (typeof s === "string") return text(s);
  const bits = [`<strong>${text(s.citation ?? "")}</strong>`];
  if (s.where) bits.push(text(s.where));
  if (s.doi) bits.push(`doi:${text(s.doi)}`);
  if (s.url) bits.push(`<a href="${esc(s.url)}">${text(s.url)}</a>`);
  return bits.join(" · ");
}

function renderExclusion(ex) {
  if (typeof ex === "string") {
    return `${text(ex)} <span class="unresolved">no destination given</span>`;
  }
  const label = ex.kind === "lens" ? "lens" : "goes to";
  const extra = ex.relation
    ? ` <span class="relation">relation: ${text(ex.relation)}</span>`
    : "";
  if (!ex.goes_to) {
    return `${text(ex.text ?? "?")} <span class="unresolved">no destination given</span>${extra}`;
  }
  return `${text(ex.text ?? "?")} — ${label} ${destination(ex.goes_to, ex.kind === "lens")}${extra}`;
}

function renderField(node, [key, label, gapNote]) {
  const value = node[key];

  if (isEmpty(value)) {
    return `        <div class="node-field">
          <h3 class="node-field__label">${label}</h3>
          <p class="gap"><span class="gap__tag">Declared gap</span> ${gapNote}</p>
        </div>`;
  }

  let body;
  if (key === "definition") {
    body = `<p>${text(value)}</p>`;
  } else if (key === "exclusion") {
    body = renderList(value, renderExclusion);
  } else if (key === "sources") {
    body = renderList(value, renderSource);
  } else {
    body = renderList(value, text);
  }

  return `        <div class="node-field">
          <h3 class="node-field__label">${label}</h3>
          ${body}
        </div>`;
}

// Rules 1, 5 and 6 are what validate.mjs can check. Rules 2, 3 and 4 are
// judgements about meaning; no state is claimed for them here.
function checkRules(node) {
  const kids = node.children ?? [];
  const n = kids.length;
  const rules = [];

  if (n === 0) {
    rules.push(["01", "Five parts, at most seven", "na",
      "Not applicable. This node is not a division."]);
  } else if (n > 7) {
    rules.push(["01", "Five parts, at most seven", "fail",
      `Divides into ${n} components, above the stated ceiling of seven.`]);
  } else if (n > 5) {
    rules.push(["01", "Five parts, at most seven", "warning",
      `Divides into ${n} components, above the target of five and within the ceiling of seven.`]);
  } else {
    rules.push(["01", "Five parts, at most seven", "pass",
      `Divides into ${n} component${n === 1 ? "" : "s"}.`]);
  }

  rules.push(["02", "Mutually exclusive", "none",
    "A judgement about whether the parts overlap. Not automated."]);
  rules.push(["03", "Collectively exhaustive", "none",
    "A judgement about what the parts leave out. Not automated."]);
  rules.push(["04", "Equal abstraction", "none",
    "A judgement about whether the parts answer the same question type. Not automated."]);

  if (n === 1) {
    rules.push(["05", "Decomposable or terminal", "fail",
      "Has exactly one child — a division that divides nothing."]);
  } else if (n === 0 && node.terminal === true) {
    rules.push(["05", "Decomposable or terminal", "pass",
      "A declared endpoint."]);
  } else if (n === 0) {
    rules.push(["05", "Decomposable or terminal", "warning",
      "No children and not marked terminal — unfinished, rather than an endpoint."]);
  } else {
    rules.push(["05", "Decomposable or terminal", "pass",
      `Divides into ${n} parts.`]);
  }

  // The rule is that a category carries its justification, not merely that
  // the keys exist. A node with six empty fields is unfinished, whatever the
  // file looks like, so an empty field is not reported as a pass.
  const missing = FIELDS.map(([k]) => k).filter((k) => !(k in node));
  const filled = FIELDS.filter(([k]) => !isEmpty(node[k])).length;

  if (missing.length) {
    rules.push(["06", "Justified in writing", "fail",
      `Missing required field${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. ` +
      `A missing key is a silent gap rather than a declared one.`]);
  } else if (filled === 0) {
    rules.push(["06", "Justified in writing", "fail",
      "All six fields are present and all six are empty. Nothing has been written down."]);
  } else if (filled < FIELDS.length) {
    rules.push(["06", "Justified in writing", "warning",
      `${filled} of the six fields carry content. The rest are declared gaps.`]);
  } else {
    rules.push(["06", "Justified in writing", "pass",
      "All six fields carry content."]);
  }

  return rules;
}

const STATE_LABEL = {
  pass: "Passes",
  warning: "Warning",
  fail: "Fails",
  na: "Not applicable",
  none: "Not checked",
};

function renderChecks(node) {
  return checkRules(node).map(([no, name, state, detail]) =>
    `        <div class="check">
          <span class="check__no">Rule ${no}</span>
          <div>
            <h3 class="check__name">${name}</h3>
            <p class="check__detail">${detail}</p>
          </div>
          <span class="check__state check__state--${state}">${STATE_LABEL[state]}</span>
        </div>`
  ).join("\n");
}

// Ancestors only, and nothing at all for a domain root. The parent of the
// nine domains is undefined — it is one of the atlas's open problems — so the
// breadcrumb must not invent one by putting "Atlas" above an L0 node.
function renderBreadcrumb(trail) {
  if (!trail.length) return "";
  const links = trail.map((_, i) => {
    const path = trail.slice(0, i + 1).join("/");
    const name = nodes.get(path)?.node.name ?? path;
    return `<a href="/atlas/${path}/">${text(name)}</a>`;
  });
  return `      <nav class="crumb" aria-label="Breadcrumb">\n` +
    `        ${links.join('\n        <span class="crumb__sep" aria-hidden="true">/</span>\n        ')}\n` +
    `      </nav>`;
}

// The whole descent below a domain root. Only an L0 page carries it: below
// that the same list would be a fragment of a tree whose top is off the page,
// which reads as the whole thing and is not.
//
// Expanding is <details>, so it works under script-src 'none'. A node that
// divides is a <summary> that opens; the link to its own page sits inside,
// separate from the toggle, because one control doing two things with no
// JavaScript to disambiguate them is a control that does neither reliably.
function renderTree(root, sectionNo, count) {
  const leaf = (node, path, depth) =>
    `<li class="twig">` +
    `<a class="twig__link" href="/atlas/${path}/">` +
    `<span class="twig__name">${text(node.name)}</span>` +
    `<span class="twig__level">L${depth}</span></a></li>`;

  const branch = (node, path, depth) => {
    const kids = node.children ?? [];
    if (!kids.length) return leaf(node, path, depth);
    const inner = kids
      .map((k) => branch(k, `${path}/${k.id}`, depth + 1))
      .join("");
    // The root opens by default. Everything below it starts closed, so the
    // page arrives at one level rather than at all of them at once.
    const open = depth === 0 ? " open" : "";
    return `<li class="twig">` +
      `<details class="branch"${open}>` +
      `<summary class="branch__head">` +
      `<span class="twig__name">${text(node.name)}</span>` +
      `<span class="twig__level">L${depth}</span>` +
      `<span class="branch__count">${kids.length} component${kids.length === 1 ? "" : "s"}</span>` +
      `</summary>` +
      `<p class="branch__self"><a href="/atlas/${path}/">Open ${text(node.name)} &rarr;</a></p>` +
      `<ul class="twigs">${inner}</ul>` +
      `</details></li>`;
  };

  return `
  <!-- The whole domain ===================================================== -->
  <section class="field--night band">
    <div class="wrap">
      <p class="eyebrow"><span class="eyebrow__no">§ ${sectionNo}</span> The whole domain</p>
      <h2 class="section-title">${count} nodes, every level of the descent.</h2>
      <div class="prose">
        <p>
          The full descent below this domain. A node that divides opens to show
          its parts; a node that does not is a link and nothing more. Every
          entry is a page, and a page existing says nothing about whether
          anything has been written on it.
        </p>
      </div>
      <ul class="twigs twigs--root">${branch(root, root.id, 0)}</ul>
    </div>
  </section>
`;
}

// The entries that point at this node. Absent when there are none — a node
// with no diagnostics has not been stress-tested, and an empty section
// announcing that would read as a clean bill of health.
function renderNodeDiagnostics(entries, sectionNo) {
  if (!entries.length) return "";

  const cards = entries.map((e) => `          <a class="kid" href="/diagnostics/${e.slug}/">
            <span class="kid__head">
              <span class="kid__name">${text(e.heading)}</span>
              <span class="kid__level">${text(e.date)}</span>
            </span>
            <p class="kid__def">${text(e.issue ?? "")}</p>
            <span class="kid__level"><span class="outcome outcome--${esc(e.outcome)}">${
              text(OUTCOME_LABEL[e.outcome] ?? e.outcome)}</span></span>
          </a>`).join("\n");

  return `
  <!-- Diagnostics ========================================================== -->
  <section class="field--night band">
    <div class="wrap">
      <p class="eyebrow"><span class="eyebrow__no">§ ${sectionNo}</span> Diagnostics</p>
      <h2 class="section-title">${entries.length} entr${entries.length === 1 ? "y" : "ies"} against this node.</h2>
      <div class="prose">
        <p>
          Where this division has been put under pressure and what happened.
          An entry is not a task list — some record that the question is open
          and that leaving it open was the decision.
        </p>
      </div>
      <div class="kids">
${cards}
      </div>
    </div>
  </section>
`;
}

function renderChildren(node, path, depth, sectionNo) {
  const kids = node.children ?? [];
  if (!kids.length) return "";

  const cards = kids.map((kid) => {
    const gloss = isEmpty(kid.definition)
      ? `<p class="kid__gap"><span class="gap__tag">Declared gap</span> No definition has been written.</p>`
      : `<p class="kid__def">${text(kid.definition)}</p>`;
    return `          <a class="kid" href="/atlas/${path}/${kid.id}/">
            <span class="kid__head">
              <span class="kid__name">${text(kid.name)}</span>
              <span class="kid__level">Level ${depth + 1}</span>
            </span>
            ${gloss}
          </a>`;
  }).join("\n");

  return `
  <!-- Divides into ========================================================= -->
  <section class="field--night band">
    <div class="wrap">
      <p class="eyebrow"><span class="eyebrow__no">§ ${sectionNo}</span> Divides into</p>
      <h2 class="section-title">${kids.length} component${kids.length === 1 ? "" : "s"} at level ${depth + 1}.</h2>
      <div class="kids">
${cards}
      </div>
    </div>
  </section>
`;
}

const nodeShell = readFileSync(join(TEMPLATES, "node.html"), "utf8");

// How big a domain is and how deep it goes. Walked, never written down.
function measure(root) {
  let count = 0, maxDepth = 0, defined = 0, sourced = 0;
  (function walk(node, depth) {
    count++;
    maxDepth = Math.max(maxDepth, depth);
    if (!isEmpty(node.definition)) defined++;
    if (!isEmpty(node.sources)) sourced++;
    for (const child of node.children ?? []) walk(child, depth + 1);
  })(root, 0);
  return { count, maxDepth, defined, sourced };
}

const domainStats = new Map(domains.map((d) => [d.id, measure(d)]));

for (const [path, { node, depth, trail }] of nodes) {
  const kids = node.children ?? [];
  const description = isEmpty(node.definition)
    ? `${node.name} — a level ${depth} node in the Systems Atlas taxonomy. No definition has been written yet.`
    : String(node.definition).trim().replace(/\s+/g, " ").slice(0, 180);

  // Sections are numbered in the order they appear, and which ones appear
  // depends on the node: a leaf has no "Divides into", and only a domain root
  // carries the whole-domain tree.
  let section = 1;
  const nextNo = () => String(++section).padStart(2, "0");
  const childrenNo = kids.length ? nextNo() : null;
  const treeNo = depth === 0 && kids.length ? nextNo() : null;
  const entries = byNode.get(path) ?? [];

  const html = expand(fill(nodeShell, {
    title: `${node.name} — Systems Atlas`,
    description,
    name: text(node.name),
    path,
    level: String(depth),
    breadcrumb: renderBreadcrumb(trail),
    fields: FIELDS.map((f) => renderField(node, f)).join("\n"),
    children: renderChildren(node, path, depth, childrenNo),
    tree: treeNo ? renderTree(node, treeNo, domainStats.get(node.id).count) : "",
    rulesNo: nextNo(),
    checks: renderChecks(node),
    diagnostics: renderNodeDiagnostics(entries, entries.length ? nextNo() : null),
  }), `atlas/${path}`);

  const out = join(DIST, "atlas", ...path.split("/"), "index.html");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  urls.push(`/atlas/${path}/`);
}

// --- atlas index -----------------------------------------------------------
//
// /atlas/ lists the nine domains. It is not a node page, because the nine
// have no parent — that is one of the atlas's open problems — and a page
// standing above them would quietly invent one.

const atlasShell = readFileSync(join(TEMPLATES, "atlas-index.html"), "utf8");

const domainCards = domains.map((d) => {
  const { count, maxDepth } = domainStats.get(d.id);
  const gloss = isEmpty(d.definition)
    ? `<p class="dcard__gap"><span class="gap__tag">Declared gap</span> No definition has been written.</p>`
    : `<p class="dcard__def">${text(d.definition)}</p>`;
  const divided = maxDepth === 0
    ? "Not divided"
    : `Divided to level ${maxDepth}`;
  return `        <a class="dcard" href="/atlas/${d.id}/">
          <span class="dcard__head">
            <span class="dcard__name">${text(d.name)}</span>
            <span class="dcard__level">L${maxDepth}</span>
          </span>
          ${gloss}
          <span class="dcard__meta">${divided} · ${count} node${count === 1 ? "" : "s"}</span>
        </a>`;
}).join("\n");

const totalNodes = [...domainStats.values()].reduce((n, s) => n + s.count, 0);

writeFileSync(
  join(DIST, "atlas", "index.html"),
  expand(fill(atlasShell, {
    description:
      `The Systems Atlas taxonomy: ${domains.length} domains and ${totalNodes} nodes, ` +
      `with empty fields shown as declared gaps rather than hidden.`,
    domainCount: String(domains.length),
    nodeCount: String(totalNodes),
    cards: domainCards,
  }), "atlas/index.html")
);

urls.push("/atlas/");

// --- diagnostics pages -----------------------------------------------------

if (diagnostics.length) {
  const entryShell = readFileSync(join(TEMPLATES, "diagnostic.html"), "utf8");

  for (const e of diagnostics) {
    // Where an entry points nowhere, say so. The validator reports it as an
    // error; hiding it on the page would leave the error visible only to
    // whoever runs the build.
    const targetCards = e.targets.map((t) => {
      if (!t.path) {
        return `        <div class="kid">
          <span class="kid__head">
            <span class="kid__name">${text(t.given)}</span>
          </span>
          <p class="kid__gap"><span class="gap__tag">Unresolved</span> This path does not resolve to a node in the atlas.</p>
        </div>`;
      }
      const gloss = isEmpty(t.node.definition)
        ? `<p class="kid__gap"><span class="gap__tag">Declared gap</span> No definition has been written.</p>`
        : `<p class="kid__def">${text(t.node.definition)}</p>`;
      return `        <a class="kid" href="/atlas/${t.path}/">
          <span class="kid__head">
            <span class="kid__name">${text(t.node.name)}</span>
            <span class="kid__level">Level ${nodes.get(t.path).depth}</span>
          </span>
          ${gloss}
          <span class="kid__level">${esc(t.path)}</span>
        </a>`;
    }).join("\n");

    const n = e.targets.length;
    const html = expand(fill(entryShell, {
      title: `${e.heading} — Systems Atlas diagnostics`,
      description: String(e.issue ?? "").trim().replace(/\s+/g, " ").slice(0, 180),
      slug: e.slug,
      heading: text(e.heading),
      date: text(e.date ?? ""),
      componentType: text(e.component_type ?? ""),
      intent: text(e.intent ?? ""),
      outcome: esc(e.outcome ?? ""),
      outcomeLabel: text(OUTCOME_LABEL[e.outcome] ?? e.outcome ?? ""),
      issue: text(e.issue ?? ""),
      resolution: isEmpty(e.resolution)
        ? `<p class="gap"><span class="gap__tag">Declared gap</span> No resolution has been written.</p>`
        : `<p>${text(e.resolution)}</p>`,
      pathCount: `${n} node${n === 1 ? "" : "s"}`,
      paths: targetCards,
    }), `diagnostics/${e.slug}`);

    const out = join(DIST, "diagnostics", e.slug, "index.html");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, html);
    urls.push(`/diagnostics/${e.slug}/`);
  }

  const indexShell = readFileSync(join(TEMPLATES, "diagnostics-index.html"), "utf8");

  // The nodes an entry applies to are named here but not linked: the row is
  // itself a link, and an anchor inside an anchor is not allowed. The links
  // are on the entry's own page, one click away.
  const rows = diagnostics.map((e) => {
    const where = e.targets
      .map((t) => (t.path ? text(t.node.name) : `${text(t.given)} (does not resolve)`))
      .join(", ");
    return `        <a class="entry" href="/diagnostics/${e.slug}/">
          <span class="entry__head">
            <span class="entry__date">${text(e.date)}</span>
            <span class="outcome outcome--${esc(e.outcome)}">${text(OUTCOME_LABEL[e.outcome] ?? e.outcome)}</span>
          </span>
          <span class="entry__name">${text(e.heading)}</span>
          <p class="entry__issue">${text(e.issue ?? "")}</p>
          <span class="entry__meta">${text(e.intent ?? "")} · ${text(e.component_type ?? "")} · ${where}</span>
        </a>`;
  }).join("\n");

  const unresolvedCount = diagnostics.filter((e) => e.outcome === "unresolved").length;

  writeFileSync(
    join(DIST, "diagnostics", "index.html"),
    expand(fill(indexShell, {
      description:
        `The Systems Atlas diagnostics record: ${diagnostics.length} entries, ` +
        `${unresolvedCount} of them unresolved and left standing.`,
      count: String(diagnostics.length),
      unresolved: String(unresolvedCount),
      entries: rows,
    }), "diagnostics/index.html")
  );

  urls.push("/diagnostics/");
}

// --- sitemap ---------------------------------------------------------------

const priority = (u) =>
  u === "/" ? "1.0" : u.split("/").filter(Boolean).length <= 2 ? "0.8" : "0.4";

const sitemap =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.sort().map((u) =>
    `  <url><loc>${ORIGIN}${u}</loc><priority>${priority(u)}</priority></url>`
  ).join("\n") +
  `\n</urlset>\n`;

writeFileSync(join(DIST, "sitemap.xml"), sitemap);

console.log(`Built ${urls.length} pages into ${DIST}/`);

// ---------------------------------------------------------------------------
// TODO — the generated half
//
//   1. Emit diagnostics/ as pages, and cross-link them from the nodes their
//      `paths` point at.
//   2. Compute completeness per domain and inject it into the homepage
//      ladder, so the bars cannot drift from what the atlas contains.
//
// Not started, and not to be started without asking first: an SVG dendrogram
// per domain for the whole-descent view.
// ---------------------------------------------------------------------------
