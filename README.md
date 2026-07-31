# Systems Atlas

A decomposition of the systems that shape the world into their smallest
defensible parts, with the method stated and the uncertainty left visible.

This repository is the source of truth. Everything on
[systemsatlasproject.com](https://systemsatlasproject.com) is generated from
the files here. Nobody writes HTML.

## What is here

    atlas/          The taxonomy. One YAML file per domain.
    lenses/         The eleven lenses questions are asked through.
    diagnostics/    Every wrong turn, one file per entry.
    scripts/        Validation and site generation.
    docs/           Schema and contribution guide.
    site/           Templates and static assets.

## Quick start

    npm install
    npm run validate          # check the atlas against its own rules
    npm run validate -- --stats
    npm run build             # generate the site into dist/

## The method in one page

A division of a system has to survive six rules:

1. **Five parts, at most seven.** So the whole set can be compared at once.
2. **Mutually exclusive.** No shared elements; nothing derivable from siblings.
3. **Collectively exhaustive**, within that cognitive bound.
4. **Equal abstraction.** Components at one level answer the same question type.
5. **Decomposable or terminal.** Two or more parts, or a declared endpoint.
6. **Justified in writing.** Definition, inclusion, exclusion, sources,
   boundary cases.

`scripts/validate.mjs` enforces 1, 5 and 6 mechanically, and checks that every
exclusion points somewhere real. Rules 2, 3 and 4 are judgements and cannot be
checked by a script — they are what review is for.

## The atlas is not finished

It will not be finished soon, and the current state is deliberately visible.
Running the validator today reports real failures in the atlas as it stands.
Those are not bugs in the tooling. They are the work.

## Contributing

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md). The most useful thing you can
send is a case that breaks a division.

## Licence

Taxonomy, diagnostics and written content: **CC BY 4.0** — see LICENSE-CONTENT.
Code: **MIT** — see LICENSE.

Use it for anything, including commercially. Attribution is the only condition,
and it exists so the work can be traced back and argued with, not to restrict
what you do with it.
