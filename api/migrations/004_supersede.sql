-- 004_supersede.sql
--
-- The third action in docs/PROPOSALS.md §6: "Supersede. For a proposal
-- overtaken by a later decision. Stays visible, marked, linked to whatever
-- replaced it."
--
-- `superseded` was already in the status CHECK from 002 — the states were
-- written out in full then. What was missing is the link. §4's table has no
-- column for it, so this adds one: "linked to whatever replaced it" is not a
-- thing that can be stored in a status.
--
--     psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 004_supersede.sql

SET LOCAL search_path = atlas, public;

ALTER TABLE atlas.proposals
  ADD COLUMN superseded_by BIGINT REFERENCES atlas.proposals(id);

-- The link belongs to exactly one state. A superseded proposal must say what
-- replaced it — that is the whole of what the action is for — and a proposal in
-- any other state must not carry a replacement, or the node page would render a
-- link that means nothing.
ALTER TABLE atlas.proposals
  ADD CONSTRAINT proposals_superseded_has_replacement CHECK (
    (status =  'superseded' AND superseded_by IS NOT NULL)
    OR
    (status <> 'superseded' AND superseded_by IS     NULL)
  );

-- A proposal cannot replace itself. Longer cycles are refused in the route,
-- which can walk the chain; this catches the one case a CHECK can see, and
-- catches it for anything that writes the table.
ALTER TABLE atlas.proposals
  ADD CONSTRAINT proposals_not_superseded_by_self CHECK (
    superseded_by IS NULL OR superseded_by <> id
  );

-- §7 renders a superseded proposal with a link to its replacement, so the
-- replacement is looked up by id per row on the page.
CREATE INDEX proposals_superseded_by_idx
  ON atlas.proposals (superseded_by)
  WHERE superseded_by IS NOT NULL;
