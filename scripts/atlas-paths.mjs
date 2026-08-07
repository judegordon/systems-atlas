//
// Writes the set of valid node paths to api/atlas-paths.json.
//
//     node scripts/atlas-paths.mjs            write the file
//     node scripts/atlas-paths.mjs --check    fail if it is out of date
//
// docs/PROPOSALS.md §4 requires that a submitted `node_path` "resolves in the
// current atlas". The API cannot check that directly: it deploys from api/ as
// its root directory and cannot read ../atlas/, and putting the taxonomy in
// Postgres would give the project a second source of truth for the one thing
// it is most careful to keep singular.
//
// So the set is generated from the YAML and committed. It is a derived file
// and is checked in on purpose — the API has to carry it to production.
//
// The consequence, stated rather than hidden: a node added to the atlas cannot
// be proposed against until this is regenerated and the API redeployed. The
// --check mode exists so that going stale is noticed here rather than by a
// contributor whose submission is refused for a node they are looking at.
//
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

const ATLAS = "atlas";
const OUT = join("api", "atlas-paths.json");

const paths = [];

for (const file of readdirSync(ATLAS).filter((f) => f.endsWith(".yaml")).sort()) {
    const root = yaml.load(readFileSync(join(ATLAS, file), "utf8"));
    if (!root || !root.id) continue;

    (function walk(node, trail) {
        const path = [...trail, node.id].join("/");
        paths.push(path);
        for (const child of node.children ?? []) walk(child, [...trail, node.id]);
    })(root, []);
}

paths.sort();

// Sorted, so the file's diff shows what changed in the atlas rather than the
// order the walk happened to take.
const body = JSON.stringify({ paths }, null, 2) + "\n";

if (process.argv.includes("--check")) {
    // Compared as content rather than as bytes. core.autocrlf rewrites the
    // line endings of a checked-in file on Windows, so a byte-exact check
    // would report a file it had just written as out of date.
    let current = null;
    try {
        current = JSON.parse(readFileSync(OUT, "utf8")).paths;
    } catch {
        /* missing or unreadable counts as out of date */
    }

    const same =
        Array.isArray(current)
        && current.length === paths.length
        && current.every((p, i) => p === paths[i]);

    if (!same) {
        console.error(
            `${OUT} is out of date. Run \`npm run atlas:paths\` and commit the result.`
        );
        process.exit(1);
    }
    console.log(`${OUT} is current — ${paths.length} node paths.`);
} else {
    writeFileSync(OUT, body);
    console.log(`Wrote ${OUT} — ${paths.length} node paths.`);
}
