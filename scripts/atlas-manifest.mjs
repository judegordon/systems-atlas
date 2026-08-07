//
// Writes what the API needs to know about the atlas to api/atlas-manifest.json.
//
//     node scripts/atlas-manifest.mjs            write the file
//     node scripts/atlas-manifest.mjs --check    fail if it is out of date
//
// Two things need it, from docs/PROPOSALS.md:
//
//   §4  a submitted `node_path` must "resolve in the current atlas"
//   §6  the review queue shows "the current state of that node"
//
// The API cannot read the YAML: it deploys with api/ as its root directory,
// and putting the taxonomy in Postgres would give the project a second source
// of truth for the one thing it is most careful to keep singular. So the parts
// it needs are generated from the YAML and committed.
//
// It is a derived file, checked in on purpose, because the API has to carry it
// to production. The consequence, stated rather than hidden: a node added or
// reworded in the atlas is stale here until this is regenerated and the API
// redeployed. `--check` runs in CI so that is noticed there.
//
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

const ATLAS = "atlas";
const OUT = join("api", "atlas-manifest.json");

const paths = [];
const nodes = {};

// The queue is a page someone makes a published decision on, so it carries the
// fields a break is an argument against — the definition it fails, what the
// node claims to include and exclude, and what it divides into. Not sources or
// boundary cases: those belong to the node page, which the queue links to.
function summarise(node) {
    return {
        name: node.name ?? node.id,
        definition: typeof node.definition === "string" ? node.definition.trim() : "",
        inclusion: Array.isArray(node.inclusion) ? node.inclusion : [],
        exclusion: Array.isArray(node.exclusion)
            ? node.exclusion.map((e) =>
                typeof e === "string" ? { text: e } : { text: e.text ?? "", goesTo: e.goes_to ?? null })
            : [],
        terminal: node.terminal === true,
        children: (node.children ?? []).map((c) => ({ id: c.id, name: c.name ?? c.id })),
    };
}

for (const file of readdirSync(ATLAS).filter((f) => f.endsWith(".yaml")).sort()) {
    const root = yaml.load(readFileSync(join(ATLAS, file), "utf8"));
    if (!root || !root.id) continue;

    (function walk(node, trail) {
        const path = [...trail, node.id].join("/");
        paths.push(path);
        nodes[path] = summarise(node);
        for (const child of node.children ?? []) walk(child, [...trail, node.id]);
    })(root, []);
}

paths.sort();

// Sorted, so the diff shows what changed in the atlas rather than the order the
// walk happened to take.
const ordered = {};
for (const p of paths) ordered[p] = nodes[p];

const body = JSON.stringify({ paths, nodes: ordered }, null, 2) + "\n";

if (process.argv.includes("--check")) {
    // Compared as content rather than as bytes. core.autocrlf rewrites the line
    // endings of a checked-in file on Windows, so a byte-exact check would
    // report a file it had just written as out of date.
    let current = null;
    try {
        current = JSON.parse(readFileSync(OUT, "utf8"));
    } catch {
        /* missing or unreadable counts as out of date */
    }

    const same =
        current
        && Array.isArray(current.paths)
        && JSON.stringify(current.paths) === JSON.stringify(paths)
        && JSON.stringify(current.nodes) === JSON.stringify(ordered);

    if (!same) {
        console.error(
            `${OUT} is out of date. Run \`npm run atlas:manifest\` and commit the result.`
        );
        process.exit(1);
    }
    console.log(`${OUT} is current — ${paths.length} nodes.`);
} else {
    writeFileSync(OUT, body);
    console.log(`Wrote ${OUT} — ${paths.length} nodes.`);
}
