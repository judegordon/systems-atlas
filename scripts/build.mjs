#!/usr/bin/env node
/**
 * Builds the site into dist/.
 *
 *   node scripts/build.mjs            report validation, build anyway
 *   node scripts/build.mjs --strict   refuse to build if the atlas has errors
 *
 * Right now this copies the hand-written pages and static files, and
 * generates the sitemap. Atlas node pages, the tree, and the completeness
 * figures on the homepage are not generated yet — see the TODO at the bottom.
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

const SITE = "site";
const PAGES = join(SITE, "pages");
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
    writeFileSync(out, readFileSync(full, "utf8"));

    if (entry === "index.html") {
      const urlPath = dirname(rel) === "." ? "/" : `/${dirname(rel)}/`;
      urls.push(urlPath);
    }
  }
}

if (existsSync(PAGES)) copyPages(PAGES);

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
//   1. Read atlas/*.yaml and emit one page per node at /atlas/<path>/
//      carrying its justification, the rules governing its division, and its
//      children with one-line definitions.
//   2. Emit a nested <details> tree per domain. No JavaScript, so it works
//      under script-src 'none'.
//   3. Emit an SVG dendrogram per domain for the whole-descent view.
//   4. Emit diagnostics/ as pages, and cross-link them from the nodes their
//      `paths` point at.
//   5. Compute completeness per domain and inject it into the homepage
//      ladder, so the bars cannot drift from what the atlas contains.
//   6. Extract masthead and footer into site/templates/partials/ and
//      substitute them into pages at build time, so nav changes happen once.
// ---------------------------------------------------------------------------
