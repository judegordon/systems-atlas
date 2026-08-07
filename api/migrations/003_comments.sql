-- 003_comments.sql
--
-- Comments, from docs/PROPOSALS.md §5. Build step 6.
--
-- "Every node carries a thread. One level of replies, no deeper — nested
-- argument past that point wants to be a proposal." That sentence is the whole
-- design, and the depth limit is enforced below rather than left to the form.
--
--     psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 003_comments.sql

SET LOCAL search_path = atlas, public;


-- Comments --------------------------------------------------------------------

CREATE TABLE atlas.comments (
  id               BIGSERIAL PRIMARY KEY,

  -- As with proposals: no cascade. §3 keeps published contributions when an
  -- account is deleted and reattributes them to Withdrawn, and withdrawal
  -- keeps the account row.
  account_id       BIGINT NOT NULL REFERENCES atlas.accounts(id),

  node_path        TEXT NOT NULL CHECK (char_length(node_path) BETWEEN 1 AND 400),

  -- Null for a top-level comment. A reply points at one.
  --
  -- ON DELETE CASCADE here and nowhere else in this schema: a reply to a
  -- comment that no longer exists is not a record of anything, it is a
  -- fragment. Nothing deletes a comment today — rejection sets a status — so
  -- this is the shape being declared, not a path anything currently takes.
  parent_id        BIGINT REFERENCES atlas.comments(id) ON DELETE CASCADE,

  display_as       TEXT NOT NULL CHECK (display_as IN ('name', 'anonymous')),

  body             TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),

  status           TEXT NOT NULL DEFAULT 'pending' CHECK (
                     status IN ('pending', 'published', 'rejected')),

  -- §5: required when rejected. Unlike a proposal, a published comment carries
  -- no reason — there is nothing to explain about letting an argument stand.
  decision_reason  TEXT,
  decided_at       TIMESTAMPTZ,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT comments_rejection_has_reason CHECK (
    (status <> 'rejected' AND decision_reason IS NULL)
    OR
    (status =  'rejected' AND decision_reason IS NOT NULL AND decided_at IS NOT NULL)
  )
);

-- One level of replies, no deeper.
--
-- The rule cannot be written as a CHECK, because a CHECK cannot read another
-- row. A trigger is the only place it can live where the form, the API and a
-- hand-written UPDATE are all held to it — and the form is the one of those
-- three most likely to be rewritten by someone who has not read §5.
CREATE OR REPLACE FUNCTION atlas.comments_depth_limit() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  parent_parent BIGINT;
  parent_node   TEXT;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT parent_id, node_path INTO parent_parent, parent_node
    FROM atlas.comments WHERE id = NEW.parent_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'parent comment % does not exist', NEW.parent_id;
  END IF;

  IF parent_parent IS NOT NULL THEN
    RAISE EXCEPTION 'comments nest one level only; % is already a reply', NEW.parent_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- A reply on a different node's thread would appear under a node its author
  -- never read. The two have to agree.
  IF parent_node IS DISTINCT FROM NEW.node_path THEN
    RAISE EXCEPTION 'a reply must be on the same node as the comment it answers'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS comments_depth_limit ON atlas.comments;
CREATE TRIGGER comments_depth_limit
  BEFORE INSERT OR UPDATE OF parent_id ON atlas.comments
  FOR EACH ROW EXECUTE FUNCTION atlas.comments_depth_limit();

-- The review queue reads pending, oldest first, alongside proposals (§6).
CREATE INDEX comments_pending_idx
  ON atlas.comments (created_at)
  WHERE status = 'pending';

-- Step 7 renders published comments onto the node page, threaded one level.
CREATE INDEX comments_node_status_idx
  ON atlas.comments (node_path, status, created_at);

-- The per-account limit is counted off this table, as proposals are.
CREATE INDEX comments_account_created_idx
  ON atlas.comments (account_id, created_at DESC);

CREATE INDEX comments_parent_idx
  ON atlas.comments (parent_id)
  WHERE parent_id IS NOT NULL;


-- Rate limiting ---------------------------------------------------------------
--
-- §5: "Same rate limits and honeypot." The per-IP counter reads
-- atlas.auth_attempts, whose action is a closed set.

ALTER TABLE atlas.auth_attempts
  DROP CONSTRAINT auth_attempts_action_check;

ALTER TABLE atlas.auth_attempts
  ADD CONSTRAINT auth_attempts_action_check CHECK (
    action IN ('signup', 'signin', 'reset', 'verify_resend', 'propose', 'comment'));
