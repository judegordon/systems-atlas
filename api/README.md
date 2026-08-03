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

Not yet provisioned. What it needs:

1. A Railway project with a Postgres and a service rooted at `api/`.
2. `RESEND_API_KEY`, and `DATABASE_URL` referenced from the Postgres service.
3. `npm run migrate` once against the production database.
4. The custom domain `api.systemsatlasproject.com` on the service, and the
   CNAME for it at the registrar.

The cookie is host-only and set by `api.systemsatlasproject.com`. Because
SameSite is judged on the registrable domain, the site's fetches from
`systemsatlasproject.com` carry it without the cookie ever being widened to
`.systemsatlasproject.com`. Serving the API from anywhere else breaks that,
and the CSRF token becomes the only defence rather than the second one.
