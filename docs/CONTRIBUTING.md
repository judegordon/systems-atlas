# Contributing

This is an open project currently led by one person. That is a description of
where it is, not of how it should stay.

## The most useful contribution

**A case that breaks a division.** If you can name something that will not
classify cleanly, or that fits in two places at once, that is worth more than
a new category. Open an issue with the case and which node it breaks.

Everything else is welcome too: definitions, sources, boundary cases, code,
design, corrections to anything.

## How it works

1. **Open an issue first** for anything beyond a typo. It saves you writing
   something that turns out to conflict with a decision made elsewhere.
2. **Fork, edit the YAML, run the validator.**
3. **Open a pull request.** It will be reviewed on content, not markup.

    npm run validate

A pull request that fails validation will say exactly why.

## Writing a node

Read `docs/SCHEMA.md` first. The short version:

- Every node carries `definition`, `inclusion`, `exclusion`, `sources`,
  `boundary_cases` and `uncertainty`. An empty value is fine. A missing key
  is an error, because an empty field is a declared gap and a missing field is
  a silent one.
- Every `exclusion` says where the excluded thing goes. Excluding something
  without a destination leaves it nowhere.
- Cite the source. A definition without one is an opinion with formatting.
- If you are unsure, put it in `uncertainty` rather than resolving it
  confidently. Recorded uncertainty is worth more than false confidence.

## Writing a diagnostics entry

When a division fails — a case will not classify, two categories overlap, a
definition turns out circular — add a file to `diagnostics/`. Including when
the outcome is `unresolved`. Especially then.

## Review

Pull requests are reviewed against the six rules, and against whether the
justification actually supports the division. Expect to be asked for a source.
Expect disagreement to be recorded rather than settled quietly.

Anything merged keeps your attribution in the git history, which is the real
credit record.

## Getting in touch

hello@systemsatlasproject.com — particularly for anything larger than a pull
request, including working on this in a sustained way.
