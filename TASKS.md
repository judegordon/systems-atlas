# Handover brief

Read `CLAUDE.md` first, then `docs/SCHEMA.md`. Work through these in order,
running `npm run build` after each and checking `dist/`.

---

## 1. Shared partials

Extract the masthead and footer from the existing pages in `site/pages/` into
`site/templates/partials/`, and substitute them at build time. Nav currently
differs between pages and will keep drifting until this is done.

**New nav**, four items:

    Atlas · Tools · Contribute · About

`Map`, `Method`, `Lenses` and `Diagnostics` come out of the nav and stay as
scroll targets on the homepage.

No JavaScript, so `Tools` is a link to `/tools/`, not a dropdown.

---

## 2. Tools landing page — `site/pages/tools/index.html`

The four apps, each with icon, name, one line, and a link. Reuse the `.tool`
component already in `styles.css`. Do not attribute them to nodes.

---

## 3. Contribute page — `site/pages/contribute/index.html`

Draw the content from `docs/CONTRIBUTING.md`. It should say:

- The most useful contribution is a case that breaks a division
- Anything else is welcome: definitions, sources, code, design, corrections
- How it works: issue first, then PR against the YAML
- Link the repo and the two issue templates
- Content is CC BY 4.0, code MIT
- An open project currently led by one person
- Self-funded; conversations about funding welcome, no donate button

---

## 4. Atlas node pages

One page per node at `/atlas/<path>/`, e.g.
`/atlas/human-biological/nervous-system/central-nervous-system/`.

Each page carries:

- Breadcrumb up the taxonomy path
- The node's definition, inclusion, exclusion, sources, boundary cases,
  uncertainty — **with empty fields shown as declared gaps**, not omitted
- The rules governing this division, and whether it passes them
- Its children, with one-line definitions, as links
- Any diagnostics entries whose `paths` point here

Level is derived from depth. Never write a level number into the data.

---

## 5. Domain index pages

`/atlas/<domain>/` is the L0 node page plus the whole-domain tree.

---

## 6. Expandable tree

Nested `<details>` elements. Clicking a node reveals its children. No
JavaScript — this has to work under `script-src 'none'`.

Per domain, not one tree for everything.

---

## 7. Diagnostics pages

`/diagnostics/` index plus a page per entry. Cross-link both ways with the
nodes each entry's `paths` point at.

---

## 8. Homepage completeness figures

The domain ladder in §03 of the homepage is currently hand-written. Generate
it from the atlas so the bars cannot drift from what the atlas contains.
`validate.mjs --stats` already computes the numbers.

---

## 9. Sitemap

Already generated for hand-written pages. Extend to cover atlas and
diagnostics pages.

---

## Later, only if asked

An SVG view of a whole domain, and a click-to-expand graph where selecting a
node reveals what it connects to. Both need a decision from Jude before
starting.

---

## Do not

- Add JavaScript, inline styles, or any third-party origin
- Recolour the four apps
- Fill an empty field with plausible text to make a page look finished
- Edit the taxonomy to silence a validation error — those are findings, and
  they belong in `diagnostics/`
- Attribute an app to a node
