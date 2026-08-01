# Accounts

The identity layer for proposals and discussion. **Separate from the app
accounts** used by Konki, Shutoku, Kantetsu and Bottou — same Railway project,
same Postgres instance, same Resend setup, different schema and different
tokens.

## Why separate

The app account is private and sync-shaped: it exists so one person's data
follows them between their own devices. The atlas account is public-facing: it
carries a display name that appears on the site, a contribution record, and a
moderation state.

Merging them would give a fitness app a suspension concept it has no use for,
and would put shipped apps with live users at risk for a feature with no users
yet. If the two ever need joining, an `account_links` table can do it later.
That option stays open only while they are separate.

---

## Schema

Namespace everything under an `atlas` schema so it cannot collide with the app
tables in the same database.

```sql
CREATE SCHEMA IF NOT EXISTS atlas;

-- Accounts ------------------------------------------------------------------

CREATE TABLE atlas.accounts (
  id                BIGSERIAL PRIMARY KEY,
  email             CITEXT NOT NULL UNIQUE,
  password_hash     TEXT NOT NULL,
  display_name      TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 40),
  bio               TEXT CHECK (char_length(bio) <= 160),
  is_admin          BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at       TIMESTAMPTZ,
  suspended_at      TIMESTAMPTZ,
  suspended_reason  TEXT,
  withdrawn_at      TIMESTAMPTZ,       -- set on deletion; row is kept
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON atlas.accounts (lower(email));

-- Single-use tokens for email verification and password reset ---------------

CREATE TABLE atlas.tokens (
  id           BIGSERIAL PRIMARY KEY,
  account_id   BIGINT NOT NULL REFERENCES atlas.accounts(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('verify', 'reset')),
  token_hash   TEXT NOT NULL,          -- sha256 of the token; never the token
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON atlas.tokens (token_hash);
CREATE INDEX ON atlas.tokens (account_id, kind);

-- Sessions ------------------------------------------------------------------

CREATE TABLE atlas.sessions (
  id           BIGSERIAL PRIMARY KEY,
  account_id   BIGINT NOT NULL REFERENCES atlas.accounts(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  user_agent   TEXT,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON atlas.sessions (token_hash);
CREATE INDEX ON atlas.sessions (account_id);
```

### On deletion

`DELETE FROM accounts` is never issued. Deletion sets `withdrawn_at`, clears
`email`, `password_hash`, `bio` and sets `display_name` to `Withdrawn`.
Published proposals and comments survive with that attribution.

Say this at sign-up, plainly, before the account is created:

> Anything you publish here stays published if you delete your account. Your
> name is removed from it; the argument is not. A public record that can be
> retracted afterwards is not a record.

### On anonymity

`display_name` is what appears when a contributor chooses to be named.
Choosing anonymity is a **per-submission** flag stored on the proposal or
comment, not on the account. The account behind an anonymous submission is
always visible to an admin.

---

## Sessions, not JWTs

The apps use JWTs. Do not reuse that pattern here.

A JWT cannot be revoked before it expires. This system needs suspension to
take effect immediately, and needs a signed-out session to be genuinely dead.
Use opaque random tokens stored hashed, checked against the database on each
request.

- Token: 32 random bytes, base64url
- Stored: sha256 of the token, never the token itself
- Cookie: `atlas_session`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`
- Lifetime: 30 days, sliding — refresh `expires_at` on use if over a day old
- Sign-out revokes the row; "sign out everywhere" revokes all rows for the
  account

`SameSite=Lax` plus a CSRF token on every state-changing form. Do not rely on
`SameSite` alone.

---

## Endpoints

All under `https://api.systemsatlasproject.com/atlas/`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/accounts` | Sign up. Always returns 202, whether or not the email exists. |
| POST | `/accounts/verify` | Consume a verification token. |
| POST | `/accounts/verify/resend` | Re-send verification. Rate limited hard. |
| POST | `/sessions` | Sign in. |
| DELETE | `/sessions` | Sign out. |
| DELETE | `/sessions/all` | Sign out everywhere. |
| POST | `/passwords/reset` | Request a reset. Always returns 202. |
| POST | `/passwords/reset/confirm` | Consume a reset token, set a new password. |
| GET | `/me` | Current account, or 401. |
| PATCH | `/me` | Update display name, bio. |
| POST | `/me/password` | Change password. Requires the current one. |
| DELETE | `/me` | Withdraw. Requires password confirmation. |

### Enumeration

Sign-up and password reset always return the same response regardless of
whether the address is registered. Sign-in returns one message for both a
wrong password and an unknown address. This is not paranoia — an email
enumeration hole on a site where contributions are public is a way to link
pseudonymous accounts to real addresses.

### Rate limits

Per IP, and per account where one exists:

| Action | Limit |
|---|---|
| Sign up | 3 / hour / IP |
| Sign in | 10 / hour / IP, 5 / hour / account |
| Reset request | 3 / hour / IP, 3 / day / account |
| Verify resend | 3 / hour / account |

On repeated sign-in failure, delay the response rather than locking the
account — locking is itself a denial-of-service vector.

---

## Passwords

- bcrypt, cost 12, as the apps already use
- Minimum 10 characters, no composition rules
- Check against a compromised-password list if one is cheap to add; do not
  build one
- Never logged, never in an error message, never in a URL

---

## Email

Resend, as the apps already use. Two templates only:

**Verify your email** — one link, expires in 24 hours.
**Reset your password** — one link, expires in 1 hour, single use.

No marketing, no mailing list, no digest. If a notification system is ever
wanted for replies to comments, it is a separate decision with its own opt-in.

---

## CSP

Three path prefixes relax `script-src`. Everything else on the site keeps
`script-src 'none'`. Add to `site/_headers` **above** the existing `/*` block,
since first match wins:

```
/account/*
  Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; script-src 'self'; connect-src https://api.systemsatlasproject.com; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin

/propose/*
  (same)

/discuss/*
  (same)
```

The scripts on those pages are self-hosted files in `site/assets/js/`. No CDN,
no framework, no bundler. Form submission and fetch, nothing more.

### CORS

The API allows exactly one origin: `https://systemsatlasproject.com`. Credentials
allowed. No wildcard, ever.

---

## Build order

1. Schema and migration
2. Sign up, verify, sign in, sign out
3. Password reset
4. `/me`, settings page, withdrawal
5. Admin flag and an admin-only ping endpoint, to prove the check works

Stop there. Proposals are the next document, not this one.

---

## What to verify before calling it done

- A suspended account cannot sign in, and an existing session stops working
  within one request
- A used verification token cannot be used twice
- A reset token expires at one hour and cannot be replayed
- Withdrawal leaves published content attributed to `Withdrawn` and removes
  the email
- Sign-up with an existing address returns exactly what sign-up with a new one
  returns
- No endpoint returns a password hash, a token, or another account's email
- The static site still scores `script-src 'none'` everywhere outside the
  three prefixes