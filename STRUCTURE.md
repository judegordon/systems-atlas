# Repository layout

One repo. Push to GitHub, point Cloudflare Pages at it, and the site builds
from the same source contributors edit.

    systems-atlas/
    │
    ├── atlas/                    THE TAXONOMY. One YAML file per L0 domain.
    │   ├── human-biological.yaml     This is what contributors edit.
    │   ├── academic.yaml
    │   ├── economic.yaml
    │   ├── healthcare.yaml
    │   ├── legal.yaml
    │   ├── meta.yaml
    │   ├── political.yaml
    │   ├── religious.yaml
    │   └── technological.yaml
    │
    ├── diagnostics/              One file per entry. Every wrong turn.
    │   └── YYYY-MM-DD-slug.yaml
    │
    ├── lenses/lenses.yaml        The eleven lenses.
    │
    ├── dictionary/               Empty for now. Term definitions go here.
    │
    ├── docs/
    │   ├── SCHEMA.md             Field reference. Read before editing YAML.
    │   └── CONTRIBUTING.md       How to open a PR.
    │
    ├── scripts/
    │   ├── validate.mjs          Checks the atlas against its own six rules.
    │   └── build.mjs             Generates dist/.
    │
    ├── site/
    │   ├── styles.css            One stylesheet for everything.
    │   ├── _headers              Cloudflare headers and CSP.
    │   ├── robots.txt
    │   ├── assets/
    │   │   ├── favicon-32.png    Site icons.
    │   │   ├── icon-128.png
    │   │   ├── icon-180.png
    │   │   ├── og.png
    │   │   ├── fonts/            ← .woff2 files go here
    │   │   └── tools/            ← konki.png shutoku.png kantetsu.png bottou.png
    │   ├── pages/                Hand-written pages, with partials
    │   │   ├── index.html            substituted in at build time.
    │   │   ├── 404.html
    │   │   ├── contribute/index.html
    │   │   └── tools/
    │   │       ├── index.html        the Tools landing page
    │   │       ├── konki/{index,privacy,support,terms}
    │   │       ├── shutoku/{index,privacy,support}
    │   │       ├── kantetsu/{index,privacy,support}
    │   │       └── bottou/{index,privacy,support}
    │   └── templates/
    │       └── partials/         masthead.html, footer.html,
    │                             footer-tool.html — pulled in with
    │                             <!--#include name-->. Templates for
    │                             generated pages join them when
    │                             build.mjs grows the atlas half.
    │
    ├── dist/                     BUILD OUTPUT. Gitignored. Never edit.
    │
    ├── .github/
    │   ├── workflows/validate.yml    runs validation on every PR
    │   └── ISSUE_TEMPLATE/           "break a division", "add justification"
    │
    ├── CLAUDE.md                 House rules. Claude Code reads this first.
    ├── TASKS.md                  What to build next, in order.
    ├── MIGRATION.md              One-time setup from the old folder.
    ├── package.json
    ├── README.md
    ├── LICENSE                   MIT, for code
    └── LICENSE-CONTENT           CC BY 4.0, for the taxonomy

## Running it

    npm install
    npm run validate -- --stats     what state the atlas is in
    npm run build                   writes dist/

## Cloudflare Pages settings

    Build command:      npm run build
    Output directory:   dist
    Node version:       20 or later

Pushing to `main` then rebuilds and deploys the site automatically. The same
push that merges a contributor's definition publishes it.

## What is missing

The generated half, in `scripts/build.mjs`: atlas node pages, the expandable
tree, diagnostics pages, and the homepage completeness figures. The TODO at
the bottom of that file lists them.

Until those land, the nav points at `/atlas/`, which does not resolve yet.
