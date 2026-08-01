# Proposals and discussion

A specification, not an implementation. Nothing here is built yet.

Anyone with an account can propose a subdivision of any node, or comment on
any node. Everything is reviewed before it appears. Rejections are published
with their reasons, because a record of what was rejected and why is worth
more than a record of what was accepted.

---

## 1. Why this exists

The GitHub route filters for people who already write YAML and open pull
requests. That is a narrow filter, and early on the project needs breadth more
than it needs polish. Someone who knows how the endocrine system divides but
has never used git should be able to say so.

The form also teaches the method. Filling in definition, inclusion, exclusion,
sources and boundary cases with the six rules shown alongside is the fastest
way to understand what a division has to survive. Most weak proposals fail
their own reading before submission.

---

## 2. What stays static

The site remains static HTML with `script-src 'none'` everywhere **except**
three path prefixes:

    /account/*      sign up, sign in, settings
    /propose/*      the proposal form
    /discuss/*      comment threads

Node pages, the homepage, the tool pages and the atlas keep the strict policy.
Comments and proposals **render into the static build** — they are baked in at
build time, not fetched at runtime. A node page with forty comments is still a
plain HTML file with no JavaScript.

The consequence is that approved content appears at the next build, not
instantly. That is the correct trade. It also means the public site keeps
working if the backend is down.

`site/_headers` gains:

    /account/*
      Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self' https://api.systemsatlasproject.com; base-uri 'self'; form-action 'self' https://api.systemsatlasproject.com; frame-ancestors 'none'

Same block for `/propose/*` and `/discuss/*`.

---

## 3. Accounts

Reuse the existing Railway and Postgres backend that serves the apps. This is
the shared Systems Atlas identity layer — build it as that, not as a
site-specific login.

### Fields

| Field | Required | Notes |
|---|---|---|
| `email` | yes | Verified before anything can be submitted. |
| `password_hash` | yes | bcrypt, as elsewhere. |
| `display_name` | yes | Shown on published contributions. Not unique. |
| `bio` | no | One line. Lets a contributor state relevant expertise. |
| `created_at` | yes | |
| `verified_at` | yes | Null until the email link is followed. |
| `suspended_at` | no | Set rather than deleting, so their published record survives. |

### Anonymity

Per submission, a contributor chooses to publish under their display name or
as `Anonymous`. The account behind it is never exposed publicly. You can
always see it.

This is what makes "anonymous but published" coherent: the audience does not
know who wrote it, you do, and nobody can submit without being identifiable to
you.

### Deletion

An account can be deleted. Published proposals and comments **remain**, with
the author reattributed to `Withdrawn`. Say so plainly at sign-up. The reason
is the same one that applies to the diagnostics record: a public argument that
can be retracted after the fact is not a record.

---

## 4. Proposals

### Types

| Type | What it says |
|---|---|
| `subdivide` | This node should divide into these components. |
| `redefine` | This node's definition, inclusion or exclusion is wrong. |
| `relocate` | This node belongs under a different parent. |
| `merge` | These siblings are not distinct and should be one. |
| `break` | Here is a case this division cannot classify. |

`break` is the most valuable and the easiest to submit — it needs a case, not
a full replacement structure. Put it first in the form.

### Table

    proposals
      id
      account_id
      node_path            -- validated against the atlas at submit time
      type
      display_as           -- 'name' | 'anonymous'
      body                 -- the argument, markdown, 4000 chars
      payload              -- JSON, structured per type; see below
      sources              -- JSON array of citations
      status               -- 'pending' | 'accepted' | 'rejected' | 'superseded'
      decision_reason      -- required when not pending
      decision_rule        -- which of the six rules it failed, if any
      decided_at
      created_at

For `subdivide`, `payload` carries the proposed children, each with the same
six fields a node carries. The form renders one block per child and enforces
the bound client-side: adding an eighth child is refused with the reason,
adding a sixth warns.

### Client-side checks before submission

These are not security, they are teaching:

- More than 7 components — refused, with Rule 01 quoted
- More than 5 — warned
- Exactly 1 component — refused, Rule 05
- Any child missing a definition — warned
- No sources anywhere — warned, with the line from CONTRIBUTING about a
  definition without a source being an opinion with formatting

Every check restates the rule it comes from. Someone who fills this in twice
has learned the method.

### Server-side validation

- `node_path` resolves in the current atlas
- Rate limit: 5 proposals per account per day, 20 per IP per day
- Honeypot field plus minimum time-on-form of 20 seconds
- Body length within bounds
- Account verified and not suspended

---

## 5. Comments

Every node carries a thread. One level of replies, no deeper — nested argument
past that point wants to be a proposal.

    comments
      id
      account_id
      node_path
      parent_id            -- null for top level
      display_as
      body                 -- 2000 chars
      status               -- 'pending' | 'published' | 'rejected'
      decision_reason      -- required when rejected
      created_at

Same rate limits and honeypot. Same publish-at-build-time model.

---

## 6. The review queue

A private page at `/admin/queue`, behind your account with an admin flag.

Shows pending proposals and comments oldest first, each with: the node it
targets, the current state of that node, the submission, the account behind it
including submission history, and three actions.

**Accept.** Requires a reason. Generates the YAML diff and opens it as a commit
for you to confirm — the proposal does not write to `atlas/` unattended.

**Reject.** Requires a reason and, where one applies, which rule failed. Both
are published.

**Supersede.** For a proposal overtaken by a later decision. Stays visible,
marked, linked to whatever replaced it.

There is no bulk approve. Every decision is individual, because every decision
is published under your name.

### Canned rejection reasons

Prewritten per rule, each editable before sending. The point is that a
rejection should say *which rule* and *why this submission fails it*, not
"thanks but no". A vague rejection loses a contributor who might have been
right on their second attempt.

---

## 7. How it renders

At build time, `build.mjs` fetches accepted and rejected proposals and
published comments from the API and writes them into the static pages.

Each node page gains, below its justification:

**Proposals** — accepted ones summarised with a link to the full text and the
commit that implemented them. Rejected ones listed with their reason and the
rule that failed. Pending ones are not shown.

**Discussion** — published comments, threaded one level, each with display name
or Anonymous and a date.

**Two links** — propose a change, join the discussion. Both go to the dynamic
pages.

If the API is unreachable at build time, the build **uses the last successful
fetch, cached in the repo**, and warns. It never fails and never silently
drops contributions.

---

## 8. Build order

1. Accounts: sign up, verify, sign in, settings, delete. Nothing else works
   without this.
2. Proposal form for `break` only — the simplest type, and the most useful.
3. Review queue with accept and reject.
4. Rendering proposals into node pages at build time.
5. Remaining proposal types.
6. Comments.
7. Rendering comments.

Stop after step 4 and watch what arrives for a month before building the rest.
The volume and quality of `break` submissions will tell you whether the wider
surface is worth the moderation it costs.

---

## 9. What this costs

Worth being plain about, since it is the part that decides whether this
survives.

**Moderation is the real expense.** Not spam — that is handled by rate limits,
verification and a honeypot. The cost is plausible-but-wrong submissions:
someone proposes a division that violates equal abstraction, at length, with
citations, and rejecting it well takes half an hour of thought. Ten of those in
a week is a working day.

**Publishing rejections raises the stakes of each one.** Every rejection is a
public argument with your name on it. That is the right choice for a project
built on visible uncertainty, but it means no rejection can be careless.

**Deleted accounts leave published content.** Legally this needs saying at
sign-up, clearly, before the account is created.

**Email is personal data.** Verified addresses, held in the EU on Railway,
never shared, deletable on request. The existing app privacy policy already
covers this pattern and can be extended rather than rewritten.

If the moderation load becomes unmanageable, the lever to pull first is
narrowing which nodes accept comments — open questions and diagnostics entries
only — rather than closing submissions entirely.