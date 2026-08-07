//
// GET  /atlas/admin/ping                     prove the admin check works
// GET  /atlas/admin/queue                    pending proposals, oldest first
// POST /atlas/admin/proposals/:id/accept     requires a reason
// POST /atlas/admin/proposals/:id/reject     requires a reason, may name a rule
//
// docs/PROPOSALS.md §6, build step 3: the review queue with accept and reject.
// Supersede is not here — §8 puts the queue's third action after this step, and
// there is nothing yet for a proposal to be superseded by.
//
// Comments are step 6 and do not exist, so the queue is proposals only. It is
// written to say so rather than to silently show half of what §6 describes.
//
// There is no bulk action and no endpoint that could become one. §6: "Every
// decision is individual, because every decision is published under your name."
//
const express = require('express');
const pool = require('../db');
const proposals = require('../proposals');
const session = require('../middleware/session');

const router = express.Router();

// Every route here is admin-only. requireAdmin answers 404 rather than 403 to a
// signed-in non-admin — docs/ACCOUNTS.md wants the endpoint to be invisible
// rather than forbidden, and the accounts test suite asserts it.
router.use(session.requireAdmin);

// How many of an account's own past submissions to list beside a proposal.
// §6 wants "the account behind it including submission history"; the counts
// below are the whole history, this is the readable tail of it.
const HISTORY_LIMIT = 10;

// GET /atlas/admin/ping
router.get('/ping', (req, res) => {
    res.json({
        ok: true,
        account: req.account.displayName,
        checkedAt: new Date().toISOString(),
    });
});

// GET /atlas/admin/queue
//
// Oldest first, because the queue is a queue. Pending only: §7 says pending
// proposals are never shown publicly, and here they are the only thing worth
// showing — a decided one is a record, not work.
router.get('/queue', async (req, res, next) => {
    try {
        const { rows } = await pool.query(
            `SELECT p.id, p.node_path, p.type, p.display_as, p.body, p.payload,
                    p.sources, p.status, p.created_at,
                    a.id AS account_id, a.email, a.display_name, a.bio,
                    a.verified_at, a.created_at AS account_created_at
               FROM atlas.proposals p
               JOIN atlas.accounts a ON a.id = p.account_id
              WHERE p.status = 'pending'
              ORDER BY p.created_at ASC, p.id ASC`
        );

        // One query for every author on the page rather than one per row.
        const accountIds = [...new Set(rows.map((r) => r.account_id))];
        const history = new Map();

        if (accountIds.length) {
            const { rows: tally } = await pool.query(
                `SELECT account_id, status, count(*)::int AS n
                   FROM atlas.proposals
                  WHERE account_id = ANY($1::bigint[])
                  GROUP BY account_id, status`,
                [accountIds]
            );
            for (const row of tally) {
                if (!history.has(row.account_id)) history.set(row.account_id, {});
                history.get(row.account_id)[row.status] = row.n;
            }
        }

        const items = rows.map((r) => ({
            id: String(r.id),
            type: r.type,
            nodePath: r.node_path,

            // §6: "the current state of that node". Read from the generated
            // manifest, so it is as current as the last deploy — null when the
            // path has left the atlas since the proposal was made, which the
            // page reports rather than hiding.
            node: proposals.nodeState(r.node_path),

            submission: {
                // `summary` is one line whatever the type proposes; `payload`
                // is the whole of it, because a subdivision cannot be reviewed
                // from a summary. The page decides how much to show.
                summary: proposals.summarisePayload(r.type, r.payload),
                payload: r.payload,
                body: r.body,
                sources: r.sources || [],
                displayAs: r.display_as,
                createdAt: r.created_at,
            },

            // §3: "The account behind it is never exposed publicly. You can
            // always see it." This is the endpoint where that second half is
            // true, and it is admin-only for exactly that reason.
            account: {
                id: String(r.account_id),
                email: r.email,
                displayName: r.display_name,
                bio: r.bio,
                verified: Boolean(r.verified_at),
                createdAt: r.account_created_at,
                history: history.get(r.account_id) || {},
            },
        }));

        return res.json({ pending: items.length, items, rules: proposals.RULES });
    } catch (err) {
        return next(err);
    }
});

// The two decisions differ only in the status they write and whether a rule may
// be named, so they share the write and not the validation.
async function decide(req, res, next, status) {
    const id = req.params.id;
    if (!/^\d+$/.test(String(id))) {
        return res.status(400).json({ error: 'Not a proposal id.' });
    }

    const reason = req.body && req.body.reason;
    const rule = req.body ? req.body.rule : undefined;

    const problem =
        proposals.decisionReasonProblem(reason)
        || (status === 'rejected' ? proposals.decisionRuleProblem(rule) : null);
    if (problem) return res.status(400).json({ error: problem });

    try {
        // The WHERE clause carries `status = 'pending'`, so deciding a proposal
        // twice is refused by the database rather than by a check that read the
        // row a moment earlier. Two tabs open on the same queue is the ordinary
        // way this happens.
        const { rows } = await pool.query(
            `UPDATE atlas.proposals
                SET status = $1,
                    decision_reason = $2,
                    decision_rule = $3,
                    decided_at = now()
              WHERE id = $4 AND status = 'pending'
              RETURNING id, node_path, type, display_as, status, decision_reason,
                        decision_rule, decided_at, created_at`,
            [status, String(reason).trim(), status === 'rejected' && rule ? rule : null, id]
        );

        if (!rows.length) {
            // Either it is not there or it is already decided. Both are the
            // same instruction to the person looking at it: reload the queue.
            const { rows: found } = await pool.query(
                'SELECT status FROM atlas.proposals WHERE id = $1', [id]
            );
            if (!found.length) {
                return res.status(404).json({ error: 'No such proposal.' });
            }
            return res.status(409).json({
                error: `Already ${found[0].status}. Reload the queue.`,
            });
        }

        const row = rows[0];
        return res.json({
            proposal: {
                ...proposals.publicProposal(row),
                decisionReason: row.decision_reason,
                decisionRule: row.decision_rule,
                decidedAt: row.decided_at,
            },
        });
    } catch (err) {
        return next(err);
    }
}

// POST /atlas/admin/proposals/:id/accept
//
// §6 also asks that accepting "generates the YAML diff and opens it as a commit
// for you to confirm". It does not do that, and could not: this service has no
// access to the repository, and a `break` produces no diff in any case — it is
// a case the division cannot classify, not a replacement structure. What it
// implies for atlas/ is a judgement, and the same section is emphatic that the
// proposal "does not write to atlas/ unattended". Recording the decision is the
// part that belongs to the API; the commit stays a thing a person makes.
router.post('/proposals/:id/accept', session.requireCsrf, (req, res, next) =>
    decide(req, res, next, 'accepted'));

// POST /atlas/admin/proposals/:id/reject
router.post('/proposals/:id/reject', session.requireCsrf, (req, res, next) =>
    decide(req, res, next, 'rejected'));

module.exports = router;
