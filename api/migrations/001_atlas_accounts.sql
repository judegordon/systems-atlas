-- 001_atlas_accounts.sql
--
-- The identity layer for proposals and discussion, from docs/ACCOUNTS.md.
--
-- Everything lives in the `atlas` schema. Nothing here touches the app tables
-- in `public`, and nothing here may be given a name that already exists there.
-- The only object created outside `atlas` is the citext extension, and only if
-- the database does not already have it.
--
-- Three deliberate departures from the DDL in docs/ACCOUNTS.md are marked
-- DEPARTURE below. Each one is a contradiction or a redundancy in that
-- document rather than a preference.
--
-- The runner wraps this file in a transaction together with the row that
-- records it as applied, so the two cannot come apart. To apply it by hand
-- instead, keep that property with psql's single-transaction flag:
--
--     psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 001_atlas_accounts.sql
--
-- SET LOCAL below is what scopes the search_path to that transaction, so
-- running this file with no transaction at all will not work.

CREATE SCHEMA IF NOT EXISTS atlas;

-- citext is resolved through the search_path, so it does not matter which
-- schema owns it — only that it exists exactly once in this database.
CREATE EXTENSION IF NOT EXISTS citext;

SET LOCAL search_path = atlas, public;


-- Accounts -------------------------------------------------------------------

CREATE TABLE atlas.accounts (
  id                BIGSERIAL PRIMARY KEY,

  -- DEPARTURE 1. docs/ACCOUNTS.md declares email and password_hash NOT NULL,
  -- and then says withdrawal "clears email, password_hash, bio". Both cannot
  -- hold. Nullable columns plus the check below keep the guarantee that
  -- actually matters: a live account always has an address and a password, a
  -- withdrawn one never does. UNIQUE still permits many NULLs, so any number
  -- of accounts can be withdrawn.
  email             CITEXT UNIQUE,
  password_hash     TEXT,

  display_name      TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 40),
  bio               TEXT CHECK (char_length(bio) <= 160),
  is_admin          BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at       TIMESTAMPTZ,
  suspended_at      TIMESTAMPTZ,
  suspended_reason  TEXT,
  withdrawn_at      TIMESTAMPTZ,       -- set on deletion; row is kept
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT accounts_credentials_match_state CHECK (
    (withdrawn_at IS     NULL AND email IS NOT NULL AND password_hash IS NOT NULL)
    OR
    (withdrawn_at IS NOT NULL AND email IS     NULL AND password_hash IS     NULL)
  ),

  CONSTRAINT accounts_suspension_has_reason CHECK (
    suspended_at IS NULL OR suspended_reason IS NOT NULL
  )
);

-- DEPARTURE 2. docs/ACCOUNTS.md adds `CREATE INDEX ON atlas.accounts
-- (lower(email))`. A UNIQUE constraint on a citext column is already a
-- case-insensitive index and is what `WHERE email = $1` will use. The second
-- index could never be chosen, and would be maintained on every write. Its
-- purpose — case-insensitive lookup in one seek — is met without it.


-- Single-use tokens for email verification and password reset -----------------

CREATE TABLE atlas.tokens (
  id           BIGSERIAL PRIMARY KEY,
  account_id   BIGINT NOT NULL REFERENCES atlas.accounts(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('verify', 'reset')),
  token_hash   TEXT NOT NULL,          -- sha256 of the token; never the token
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tokens_token_hash_idx ON atlas.tokens (token_hash);
CREATE INDEX tokens_account_kind_idx ON atlas.tokens (account_id, kind);

-- Per-account rate limits in docs/ACCOUNTS.md are counted off this table:
-- reset requests per day, verification resends per hour.
CREATE INDEX tokens_account_kind_created_idx
  ON atlas.tokens (account_id, kind, created_at DESC);


-- Sessions --------------------------------------------------------------------

CREATE TABLE atlas.sessions (
  id           BIGSERIAL PRIMARY KEY,
  account_id   BIGINT NOT NULL REFERENCES atlas.accounts(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,

  -- ADDITION. docs/ACCOUNTS.md requires "a CSRF token on every state-changing
  -- form" but gives it nowhere to live. It is held per session rather than
  -- derived, so that revoking a session revokes its CSRF token with it. This
  -- value is not a credential on its own: it is handed to the page in a
  -- response body and is useless without the session cookie.
  csrf_token   TEXT NOT NULL,

  user_agent   TEXT,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- DEPARTURE 3. docs/ACCOUNTS.md adds `CREATE INDEX ON atlas.sessions
-- (token_hash)` alongside `token_hash TEXT NOT NULL UNIQUE`. UNIQUE already
-- builds that index; the second one is the same index again.
CREATE INDEX sessions_account_id_idx ON atlas.sessions (account_id);


-- Rate limiting ---------------------------------------------------------------
--
-- ADDITION. docs/ACCOUNTS.md sets limits per IP and per account but names no
-- store. In-process counters were rejected: they reset on every deploy, and
-- Railway can run more than one instance, so the limit would be per instance.
-- Sign-in is the case that cannot be counted off any other table, because a
-- failed sign-in leaves no trace anywhere else.
--
-- `ip` is the client address as resolved through Railway's proxy, so the
-- application must set `trust proxy` or every request will share one address.

CREATE TABLE atlas.auth_attempts (
  id           BIGSERIAL PRIMARY KEY,
  account_id   BIGINT REFERENCES atlas.accounts(id) ON DELETE CASCADE,
  ip           INET NOT NULL,
  action       TEXT NOT NULL CHECK (
                 action IN ('signup', 'signin', 'reset', 'verify_resend')),
  succeeded    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX auth_attempts_ip_idx ON atlas.auth_attempts (ip, action, created_at DESC);
CREATE INDEX auth_attempts_account_idx
  ON atlas.auth_attempts (account_id, action, created_at DESC)
  WHERE account_id IS NOT NULL;


-- updated_at ------------------------------------------------------------------
--
-- ADDITION. `DEFAULT now()` sets the column once, at insert, and never again.
-- Without this the field would be a second copy of created_at.

CREATE OR REPLACE FUNCTION atlas.set_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounts_set_updated_at ON atlas.accounts;
CREATE TRIGGER accounts_set_updated_at
  BEFORE UPDATE ON atlas.accounts
  FOR EACH ROW EXECUTE FUNCTION atlas.set_updated_at();
