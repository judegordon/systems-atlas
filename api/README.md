# Systems Atlas API

Accounts for the atlas: sign up, verify, sign in, reset, settings, withdrawal,
and an admin flag. Build steps 1 to 5 of `docs/ACCOUNTS.md`.

Plus the first step of `docs/PROPOSALS.md`: step 2 of its build order, the
`break` proposal type and nothing else. The review queue, the other four types,
comments, and rendering any of it into the static build are later steps and are
not here. `break` is first because it is the one that needs a case rather than
a replacement structure.

Separate from the app accounts used by Konki, Shutoku, Kantetsu and Bottou —
different database, different schema, different tokens. `docs/ACCOUNTS.md`
says why, and the reasoning survives the fact that the apps turned out to have
four backends rather than one.

## Layout

    migrations/      numbered SQL, applied in filename order
    scripts/         migrate.js
    src/db.js        one pool
    src/accounts.js  passwords, single-use tokens, the one public shape
    src/proposals.js the bounds for a break, and the signed form token
    src/rateLimit.js
    src/mail.js      two templates, and no third
    src/deferred.js  work moved off the request's clock, so that how long an
                     answer takes does not disclose whether an address exists
    src/middleware/session.js
    src/routes/
    test/
    atlas-manifest.json generated — see below

## The atlas manifest

Two things need the atlas, and neither can read it. This service deploys with
`api/` as its root directory and cannot see `../atlas/`, and putting the
taxonomy in Postgres would give the project a second source of truth for the
one thing it is most careful to keep singular.

    docs/PROPOSALS.md §4   a submitted node_path must "resolve in the current atlas"
    docs/PROPOSALS.md §6   the review queue shows "the current state of that node"

So the parts the API needs — the set of paths, and each node's name,
definition, inclusion, exclusion, children and terminal flag — are generated
from the YAML and committed:

    npm run atlas:manifest          # at the repository root
    npm run atlas:manifest:check    # fails if it is out of date

It is a derived file that is checked in on purpose, because the API has to
carry it to production. The consequence, stated rather than hidden: **a node
added or reworded in the atlas is stale here until this is regenerated and the
API redeployed** — a new node cannot be proposed against, and the queue shows
an old wording. `--check` runs in CI so that is caught there rather than by a
contributor whose submission is refused for a node they are reading.

The queue links every proposal to its live node page for the same reason. If
the manifest and the page disagree, the page is right.

## Proposals

    GET  /atlas/proposals/new    issue a form token
    POST /atlas/proposals        submit — type must be `break`

Both require a session. `POST` additionally requires the account to be
verified, a CSRF token, a `node_path` that resolves, and a form token at least
20 seconds old.

The form token is what makes that last rule a check rather than a decoration.
`docs/PROPOSALS.md` §4 asks for a "minimum time-on-form of 20 seconds", but the
form is a static page and the server has no other way to know when it was
opened. `GET /atlas/proposals/new` returns `<issuedAt>.<hmac>`; the submission
carries it back. An elapsed-milliseconds number sent by the page would have
been simpler and would have checked nothing, because the value a script sends
is the value it wants to send.

The honeypot answers `202` rather than a `4xx`, and stores nothing. Telling a
bot which check it failed is how the next version of it passes.

The other four types are refused by name — `subdivide` is told it is not open
yet, not that it is invalid — so that the message is true when step 5 arrives.

## The review queue

    GET  /atlas/admin/queue                   pending proposals, oldest first
    POST /atlas/admin/proposals/:id/accept    requires a reason
    POST /atlas/admin/proposals/:id/reject    requires a reason, may name a rule

Step 3 of `docs/PROPOSALS.md` §8, at `/admin/queue`. Admin-only, and a
signed-in non-admin gets `404` rather than `403` — the endpoint is invisible
rather than forbidden, as `docs/ACCOUNTS.md` asks.

Accept and reject both require a reason and both publish it. Reject may name
one of the six rules; §6 says "where one applies", so a rejection that is about
the case rather than the division names none. The rules are served with the
queue so the page cannot invent a seventh, and their numbers are the ones every
node page prints.

There is no bulk endpoint and there is not going to be one. §6: "Every decision
is individual, because every decision is published under your name."

Two departures from §6, both deliberate:

- **Supersede is not built.** §8 puts the queue's third action after this step,
  and nothing exists yet for a proposal to be superseded by.
- **Accepting does not generate a YAML diff or open a commit.** It could not:
  this service has no access to the repository, and a `break` produces no diff
  in any case — it is a case the division cannot classify, not a replacement
  structure. What it implies for `atlas/` is a judgement, and the same section
  is emphatic that a proposal "does not write to `atlas/` unattended".
  Recording the decision is the part that belongs to the API.

`/admin/` is a fourth scripted prefix. §2 names three, and the queue cannot be
a static page — it reads a queue and writes decisions. The list in
`scripts/build.mjs` is the enforcement point, so the fourth is admitted there
deliberately rather than arrived at by a page happening to carry a `<script>`.

## Running it

    npm install
    cp .env.example .env          # fill in DATABASE_URL
    npm run migrate
    npm start

    npm run migrate:status        # what is applied, what is not

## Tests

The suite runs against `atlas_test` on the `Postgres-6dNn` Railway service —
a separate instance from the one the API uses, sharing nothing with it. It
creates no database of its own: point it at an empty one and it will migrate
and truncate as it goes. `citext` must be available.

`Postgres-6dNn` has no public URL, so it is reached through a tunnel. Leave
this running in another terminal:

    railway connect Postgres-6dNn --tunnel-only -P 5433

`--tunnel-only` binds an ephemeral port unless `-P` is given, and the port is
part of the connection string, so pinning it is worth the flag. Then either put
`TEST_DATABASE_URL` in `.env` and run `npm test`, or pass it inline:

    TEST_DATABASE_URL=postgres://postgres:PASSWORD@127.0.0.1:5433/atlas_test npm test

There is no default. `test/helpers.js` refuses to run unless the database is
named `atlas_test` and the host is loopback, and checks `current_database()`
again once connected, before migrating. Both Railway Postgres services answer
as `postgres` on a database named `railway`, and a tunnel to either lands on
loopback — so the database name is the only part of the string that separates
them, which is why the test database is not simply `railway` on the test
instance.

`test/checklist.test.js` follows "What to verify before calling it done" in
`docs/ACCOUNTS.md`, one describe block per line and in the same order.
`test/sessions.test.js` covers what the rest of that document asks for.

The files must not run concurrently — they share a database and a per-IP rate
limit, and 127.0.0.1 is the same address in both. `npm test` sets
`--test-concurrency=1` for that reason.

## Environment

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Postgres. SSL is enabled when `NODE_ENV=production`. |
| `RESEND_API_KEY` | yes in production | Absent, a send fails and is logged; the request still returns what it would have. |
| `SITE_ORIGIN` | no | The one allowed CORS origin and the host in emailed links. Defaults to `https://systemsatlasproject.com`. |
| `MAIL_TRANSPORT` | no | `log` collects mail in memory instead of sending it. |
| `FORM_SECRET` | no, but set it | Signs the proposal form token that enforces the 20-second minimum. Unset, a random per-process value is used and tokens stop working across a restart — the person is asked to reload, so it degrades rather than breaks. |
| `PORT` | no | Railway sets this — 8080 in practice. `server.js` reads it and falls back to 3000 when run by hand. A public domain routes to a target port that is set separately from this variable, and the two have to agree. |

## Deploying

The service is up at `https://api.systemsatlasproject.com`.

Railway project `systemsatlas`, its own Postgres, in the same
workspace as the four app backends and sharing nothing with them. ACCOUNTS.md
was written expecting one shared Postgres with an `atlas` schema beside the app
tables in `public`. There is no shared Postgres — the apps have four, one each
— so the atlas has its own, and the `atlas` schema is now a namespace within a
database it does not share rather than a fence inside one it does. The
reasoning in ACCOUNTS.md wanted the smaller blast radius and gets it either
way; `public` is empty and every query still names its schema.

Done:

1. Postgres provisioned, with a volume and a public TCP proxy.
2. `001_atlas_accounts.sql` applied to the production database.
3. A service rooted at `api/`, with `RESEND_API_KEY` set and `DATABASE_URL`
   referenced from the Postgres service as `${{Postgres.DATABASE_URL}}`. The
   reference matters: pasting a literal is how it briefly came to point at the
   test instance instead.
4. The custom domain `api.systemsatlasproject.com` on the service, and the
   CNAME for it at the registrar.

The domain's target port must match the port the app is listening on. Railway
injects `PORT=8080`; the domain was created defaulting to 3000, and every
request returned 502 while the app itself logged a clean start. Neither the
logs nor the service status showed it — only `railway domain status` did.

The test database is no longer on this instance. It was `atlas_test` on the
production Postgres because there was nowhere else to put it; the suite
truncates every table it finds, and production now has a service in front of
it. `atlas_test` has been dropped from the production instance and the suite
runs against the separate `Postgres-6dNn` service, which has no public URL.
See "Tests" above.

The cookie is host-only and set by `api.systemsatlasproject.com`. Because
SameSite is judged on the registrable domain, the site's fetches from
`systemsatlasproject.com` carry it without the cookie ever being widened to
`.systemsatlasproject.com`. Serving the API from anywhere else breaks that,
and the CSRF token becomes the only defence rather than the second one.
