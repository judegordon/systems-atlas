# Systems Atlas — working notes

Read this before doing anything. It encodes decisions already made, so they do
not get re-litigated or quietly reversed.

## What this project is

A decomposition of the systems that shape the world into their smallest
defensible parts, with the method stated and the uncertainty left visible.
The eventual aim is a model where changing one node propagates through the
connected parts — but the map is valuable on its own, and the structural work
comes first.

It is an open project currently led by one person. That is a description of
where it is, not of how it should stay.

## Non-negotiable constraints

These are not preferences. Breaking any of them breaks the site.

1. **No JavaScript on the public site.** The CSP is `script-src 'none'`.
   Interactive things are built with `<details>`, `:target`, checkbox hacks,
   or not at all. Do not reach for React, Alpine, htmx, or a `<script>` tag.
2. **No inline styles.** `style-src 'self'` — no `style="..."` attributes and
   no `<style>` blocks. Everything goes in `site/styles.css`.
3. **No third-party origins.** Fonts are self-hosted in
   `site/assets/fonts/`. No Google Fonts, no CDNs, no analytics.
4. **Never recolour the four apps.** Konki, Shutoku, Kantetsu and Bottou keep
   their own identities. Their accent colours are set by body class
   (`.t-konki` etc.) and are transcribed from the apps themselves.
5. **Static output only.** The build writes plain HTML to `dist/`. No server,
   no database, no runtime.

## The method

A division of a system has to survive six rules:

1. **Five parts, at most seven.** From Miller (1956), set at the cautious end.
2. **Mutually exclusive.** No shared elements; nothing derivable from siblings.
3. **Collectively exhaustive**, within that cognitive bound.
4. **Equal abstraction.** Components at one level answer the same question type.
5. **Decomposable or terminal.** Two or more parts, or a declared endpoint.
6. **Justified in writing.** Definition, inclusion, exclusion, sources,
   boundary cases.

Rules 1, 5 and 6 are enforced by `scripts/validate.mjs`. Rules 2, 3 and 4 are
judgements and cannot be automated.

**Lenses are separate from division.** The six rules govern how a system is cut
into parts. The eleven lenses govern what may then be asked of a part. Never
conflate them in copy or in structure.

## Layout

    atlas/          taxonomy, one YAML per L0 domain — the source of truth
    diagnostics/    one file per entry, every wrong turn
    lenses/         the eleven lenses
    docs/           SCHEMA.md is the field reference — read it before touching YAML
    scripts/        validate.mjs, build.mjs
    site/pages/     hand-written pages, copied to dist as-is
    site/templates/ templates for generated pages
    site/assets/    icons, fonts, app icons
    dist/           build output — gitignored, never edit by hand

Hand-written: homepage, 404, the four tool pages and their privacy/support/
terms pages, the Tools index, the contribute page.

Generated from `atlas/`: every node page, the trees, diagnostics pages, and
the completeness figures on the homepage.

## Workflow

    npm run validate -- --stats     state of the atlas
    npm run build                   writes dist/
    npm run build -- --strict       fails on atlas errors

Validation reports but does not block by default. The atlas has real
unresolved errors and publishing them is the point. Do not "fix" a validation
error by loosening the rule or editing the taxonomy to make the warning go
away — the errors are findings, and they belong in `diagnostics/`.

After any change to a page, run the build and confirm `dist/` looks right.

## Design system

Tokens live in `site/styles.css`. Do not invent new ones.

**Colours.** Night Field `#101820`, Structure `#F5F0E6`, Chart Paper `#F1EEE5`.
Four signal colours, each naming a kind of work, never an app or a mood:
Evidence Blue `#20A4FF`, Structural Orange `#FF6A00`, Applied Green `#19D18B`,
Revision Magenta `#FF2F87`. Derived tones are mixed from the two field colours
only — nothing else enters the palette.

**Fields alternate.** Night for hero, map, diagnostics. Chart Paper for method,
tools, long reading. The page is never wholly dark.

**Type.** IBM Plex Sans Condensed for display, Atkinson Hyperlegible Next for
body, IBM Plex Mono for data and labels. Reading width 720px, layout 1440px.
Spacing on a 4/8/16/24/32/48/64/96 interval.

**Excluded, permanently:** decorative contour lines, treasure-map X marks,
Japanese visual motifs on the parent site, drop shadows, gradients, rounded
cards, anything that implies terrain or data that does not exist.

## Voice

Plain, specific, unhurried. State what is true and what is not yet known.

- Never claim more completeness than the atlas has.
- Empty fields are declared gaps and are shown as gaps. Do not hide them,
  and do not fill them with plausible-sounding text.
- Do not attribute the apps to nodes. They were built from gaps noticed
  directly, before the decomposition could point at anything, and they cut
  across many parts. Any attribution offered now would be invented.
- "Slowly" describes the task, not a virtue and not an apology.
- "One person" describes the present, not an identity.
- No advertising, ever. Funding is not ruled out and is not solicited.

## Open problems, deliberately unresolved

Do not silently fix these. They are recorded in `diagnostics/`.

- Human biological divides into nine components against a ceiling of seven.
- Nervous system excludes hormonal signalling to an endocrine system that does
  not exist in the atlas.
- Courts and religious law are assigned by the analyst's question rather than
  by the entity, which makes placement depend on who is asking.
- Healthcare and Academic are defined with verbs and intent, failing the
  project's own structural test.
- Meta is a domain of representations rather than of the world, so every other
  domain has a meta shadow, and the atlas is itself a meta artefact.
- The parent of the nine domains is undefined, so "collectively exhaustive"
  has nothing to be exhaustive of.

## Licence

Content CC BY 4.0, code MIT. Contributors keep attribution in git history.

## When unsure

Ask rather than guess, particularly about the taxonomy. A wrong division that
looks finished is worse than an empty field that is honest about being empty.
