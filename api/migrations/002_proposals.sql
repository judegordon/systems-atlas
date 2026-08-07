-- 002_proposals.sql
--
-- Proposals, from docs/PROPOSALS.md §4. Build step 2 of that document's §8 is
-- the `break` type only, so the endpoint accepts only `break` — but the type
-- CHECK below carries all five names the document defines. A constraint that
-- has to be altered to add the next type is a constraint that will be altered
-- carelessly; the set is known now and writing it now costs nothing.
--
-- Comments (§5) are step 6 and are not created here.
--
-- As with 001, the runner wraps this file in a transaction with the row that
-- records it. To apply it by hand, keep that property:
--
--     psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 002_proposals.sql

SET LOCAL search_path = atlas, public;


-- Proposals -------------------------------------------------------------------

CREATE TABLE atlas.proposals (
  id               BIGSERIAL PRIMARY KEY,

  -- No ON DELETE CASCADE, and deliberately. docs/PROPOSALS.md §3: an account
  -- can be deleted and "published proposals and comments remain, with the
  -- author reattributed to Withdrawn". Withdrawal sets accounts.withdrawn_at
  -- and keeps the row, so the reference stays valid and the attribution is
  -- read off the account's state rather than off a copy taken at submission.
  account_id       BIGINT NOT NULL REFERENCES atlas.accounts(id),

  -- The slash-joined node ids the site renders at /atlas/<path>/, e.g.
  -- `academic/higher-education-structures`. Validated against the atlas at
  -- submit time, which the API can do only because scripts/atlas-paths.mjs
  -- writes the current set into api/atlas-paths.json. Not a foreign key:
  -- the atlas lives in YAML under version control, not in this database, and
  -- copying it here would create a second source of truth for the taxonomy.
  node_path        TEXT NOT NULL CHECK (char_length(node_path) BETWEEN 1 AND 400),

  type             TEXT NOT NULL CHECK (
                     type IN ('subdivide', 'redefine', 'relocate', 'merge', 'break')),

  display_as       TEXT NOT NULL CHECK (display_as IN ('name', 'anonymous')),

  -- The argument. 4000 chars, per §4.
  body             TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),

  -- Structured per type. For `break` this is {"case": "..."} — the case the
  -- division cannot classify, kept apart from the argument about why, so that
  -- the review queue can show the case on its own.
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- An array of citation strings. Empty is allowed and is a warning on the
  -- form rather than a refusal: a break can be a case nobody has written up.
  sources          JSONB NOT NULL DEFAULT '[]'::jsonb,

  status           TEXT NOT NULL DEFAULT 'pending' CHECK (
                     status IN ('pending', 'accepted', 'rejected', 'superseded')),

  -- §6: accept and reject both require a reason, and both are published.
  decision_reason  TEXT,
  -- Which of the six rules it failed, "if any" — so nullable even once decided.
  decision_rule    TEXT,
  decided_at       TIMESTAMPTZ,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A decision without a reason is the thing this project says it will not do.
  -- The constraint is here rather than in the review queue because the queue
  -- is not built yet, and this is the guarantee that has to hold before it is.
  CONSTRAINT proposals_decision_has_reason CHECK (
    (status = 'pending'  AND decision_reason IS     NULL AND decided_at IS     NULL)
    OR
    (status <> 'pending' AND decision_reason IS NOT NULL AND decided_at IS NOT NULL)
  ),

  -- payload and sources are given shapes rather than left as free JSON, so a
  -- malformed row cannot reach the queue and be discovered there.
  CONSTRAINT proposals_payload_is_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT proposals_sources_is_array  CHECK (jsonb_typeof(sources) = 'array')
);

-- The review queue reads pending, oldest first (§6).
CREATE INDEX proposals_pending_idx
  ON atlas.proposals (created_at)
  WHERE status = 'pending';

-- The per-account limit in §4 is 5 per day, counted off this table rather than
-- off auth_attempts: a proposal leaves a row of its own, so counting the rows
-- is exact where counting attempts would only be close.
CREATE INDEX proposals_account_created_idx
  ON atlas.proposals (account_id, created_at DESC);

-- Step 4 renders accepted and rejected proposals onto the node page they
-- target. Pending ones are never shown, so the index carries the status.
CREATE INDEX proposals_node_status_idx
  ON atlas.proposals (node_path, status);


-- Rate limiting ---------------------------------------------------------------
--
-- §4 sets 20 proposals per IP per day. The per-IP counter in src/rateLimit.js
-- reads atlas.auth_attempts, whose `action` is a closed set, so the new action
-- has to be admitted to it. Dropping and recreating the constraint is the only
-- way Postgres offers to widen an IN list.

ALTER TABLE atlas.auth_attempts
  DROP CONSTRAINT auth_attempts_action_check;

ALTER TABLE atlas.auth_attempts
  ADD CONSTRAINT auth_attempts_action_check CHECK (
    action IN ('signup', 'signin', 'reset', 'verify_resend', 'propose'));
