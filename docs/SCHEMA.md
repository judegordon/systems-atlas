# Data schema

Everything on systemsatlasproject.com is generated from the files in this
repository. Nobody writes HTML. A contributor edits a YAML file, opens a pull
request, and the site rebuilds.

There are three kinds of file: **domains**, **diagnostics**, and **lenses**.

---

## 1. Domains — `atlas/<domain>.yaml`

One file per L0 domain. The file is a single tree. Depth in the tree *is* the
level: the root is L0, its children are L1, and so on. Level is never written
down, because a number you type is a number that can disagree with the
structure it describes.

```yaml
id: human-biological
name: Human biological
definition: >
  The organised structures of the human organism...
inclusion:
  - anatomical structures and their standardised nomenclature
  - cellular and molecular organisation directly constituting tissues
exclusion:
  - text: institutions delivering healthcare
    goes_to: healthcare
  - text: technological tools used to measure or operate on biology
    goes_to: technological
    relation: instrumentation
sources: []
boundary_cases: []
uncertainty: []
children:
  - id: nervous-system
    name: Nervous system
    definition: ...
    children: [...]
```

### Fields on every node

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Slug, lowercase, hyphens. Unique across the whole atlas. Becomes the URL segment. |
| `name` | yes | Display name, sentence case. |
| `definition` | key required, may be empty | What this component is. |
| `inclusion` | key required, may be empty | List of what falls inside. |
| `exclusion` | key required, may be empty | List of what falls outside, each pointing somewhere. |
| `sources` | key required, may be empty | List of citations. |
| `boundary_cases` | key required, may be empty | Cases that could plausibly sit elsewhere, and why they sit here. |
| `uncertainty` | key required, may be empty | Genuine open questions. These generate diagnostics entries. |
| `children` | no | Sub-components. Absent means terminal. |
| `terminal` | no | `true` marks a deliberate endpoint node rather than an unfinished one. |

**The keys are required; the values are not.** An empty `sources: []` is a
declared gap and renders on the site as a visible gap. A missing `sources` key
is an error, because it is silent.

### `exclusion` entries

```yaml
exclusion:
  - text: hormonal signalling
    goes_to: human-biological/endocrine-system
  - text: normative judgements about health
    goes_to: ethics            # a lens, not a domain
    kind: lens
```

`goes_to` is validated. Pointing at something that does not exist fails the
build. This is deliberate: it is how you find out that you excluded something
into a category you never created.

### `sources` entries

```yaml
sources:
  - citation: Miller, G. A. (1956). The Magical Number Seven, Plus or Minus Two.
    where: Psychological Review, 63(2), 81–97
    doi: 10.1037/h0043158
  - citation: Terminologia Anatomica, 2nd ed.
    url: https://example.org/...
```

### `terminal`

A node either divides into two or more parts, or it is an endpoint. A node with
one child is a rule violation — a division that divides nothing. A node with no
children and no `terminal: true` is treated as unfinished, not as an endpoint,
and reported as such.

---

## 2. Diagnostics — `diagnostics/YYYY-MM-DD-<slug>.yaml`

One file per entry. Every wrong turn gets one.

```yaml
date: 2026-07-31
component_type: domain          # domain | lens | article | evidence | dictionary | code | meta
paths:
  - human-biological/nervous-system/peripheral-nervous-system
intent: stress-test             # application | stress-test | differentiation | modification | verification
issue: >
  Cranial nerves I and II are placed in the peripheral nervous system on
  anatomical grounds, but histologically both are central nervous tissue...
outcome: unresolved             # no-issue | resolved | unresolved
resolution: >
  Left standing. Anatomical placement is used consistently across the
  division; the histological objection is recorded rather than acted on.
```

`paths` are validated against the atlas. An entry pointing at a node that does
not exist fails the build.

---

## 3. Lenses — `lenses/lenses.yaml`

```yaml
- id: mechanism
  name: Mechanism
  question: What are the components of the real system, and how do they
    causally interact to produce outcomes?
  indicators:
    - You are naming real actors and components
    - You are describing cause and effect chains
  excludes:
    - text: abstract equations or formal assumptions
      goes_to: model
  example: >
    Patients seek care → GP triage → referral bottlenecks → ...
  status: defined               # defined | undefined
```

---

## What the validator enforces

Run `node scripts/validate.mjs`. It checks the method against itself:

1. **Miller's bound.** More than 7 children is an error. More than 5 is a warning.
2. **Decomposable or terminal.** Exactly one child is an error. No children and
   no `terminal: true` is a warning.
3. **Unique ids** across the whole atlas.
4. **Required keys present**, including empty ones.
5. **Every `goes_to` resolves** to a real node, domain or lens.
6. **Every diagnostics `path` resolves.**
7. **Completeness**, reported per domain — how many nodes have a definition,
   inclusion, exclusion, sources.

The completeness figures feed the homepage directly. The bars showing how far
each domain has been decomposed are generated from this, so they cannot drift
away from what the atlas actually contains.
