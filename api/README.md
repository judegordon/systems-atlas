# Systems Atlas API

Accounts for the atlas: sign up, verify, sign in, reset, settings, withdrawal,
and an admin flag. Build steps 1 to 5 of `docs/ACCOUNTS.md`. Proposals are the
next document, not this one.

Separate from the app accounts used by Konki, Shutoku, Kantetsu and Bottou —
different database, different schema, different tokens. `docs/ACCOUNTS.md`
says why, and the reasoning survives the fact that the apps turned out to have
four backends rather than one.

## Layout

    migrations/     numbered SQL, applied in filename order
    scripts/        migrate.js
    src/db.js       one pool
    src/accounts.js passwords, single-use tokens, the one public shape
    src/rateLimit.js
    src/mail.js     two templates, and no third
    src/deferred.js work moved off the request's clock, so that how long an
                    answer takes does not disclose whether an address exists
    src/middleware/session.js
    src/routes/
    test/

## Running it

    npm install
    cp .env.example .env          # fill in DATABASE_URL
    npm run migrate
    npm start

    npm run migrate:status        # what is applied, what is not

## Tests

The suite needs a real Postgres with `citext` available. It creates nothing:
point it at an empty database and it will migrate and truncate as it goes.

    TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/atlas_test npm test

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
| `PORT` | no | Railway sets this. |

## Deploying

The database exists; the service does not yet.

Railway project `systems-atlas-backend`, its own Postgres, in the same
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

Still to do:

3. A service in that project rooted at `api/`, with `RESEND_API_KEY` set and
   `DATABASE_URL` referenced from the Postgres service.
4. The custom domain `api.systemsatlasproject.com` on the service, and the
   CNAME for it at the registrar.

`atlas_test` on the same instance is what the suite runs against. It is on the
production Postgres because there was nowhere else to put it, and the suite
truncates every table it finds — so once production holds anything, the test
database belongs somewhere production is not reachable from.

The cookie is host-only and set by `api.systemsatlasproject.com`. Because
SameSite is judged on the registrable domain, the site's fetches from
`systemsatlasproject.com` carry it without the cookie ever being widened to
`.systemsatlasproject.com`. Serving the API from anywhere else breaks that,
and the CSRF token becomes the only defence rather than the second one.
