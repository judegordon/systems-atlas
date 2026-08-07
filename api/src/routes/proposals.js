//
// GET  /atlas/proposals       decided proposals, public — what the build reads
// GET  /atlas/proposals/new   issue a form token
// POST /atlas/proposals       submit a proposal — `break` only, for now
//
// docs/PROPOSALS.md §8 step 2. The other four types are step 5 and are refused
// here by name rather than by omission, so that a client sending `subdivide`
// is told it is not built yet instead of being told it is invalid.
//
const express = require('express');
const pool = require('../db');
const proposals = require('../proposals');
const limits = require('../rateLimit');
const session = require('../middleware/session');

const router = express.Router();

// GET /atlas/proposals
//
// Step 4: scripts/build.mjs reads this at build time and writes the result into
// the static node pages. Public and unauthenticated, because everything it
// returns is already published — §7: accepted and rejected proposals appear on
// the node page they target, with their reasons.
//
// Declared before session.require below, so it is the one route here that does
// not need a session. Pending proposals are never included: §7 says so, and a
// pending proposal is an argument nobody has answered yet.
router.get('/', async (req, res, next) => {
    try {
        const { rows } = await pool.query(
            `SELECT p.id, p.node_path, p.type, p.body, p.payload, p.sources,
                    p.status, p.decision_reason, p.decision_rule, p.decided_at,
                    p.created_at, p.display_as,
                    a.display_name, a.withdrawn_at
               FROM atlas.proposals p
               JOIN atlas.accounts a ON a.id = p.account_id
              WHERE p.status IN ('accepted', 'rejected')
              ORDER BY p.decided_at ASC, p.id ASC`
        );

        // No paging. One person moderates this queue by hand and every row here
        // was read and decided individually, so the count is bounded by that
        // rather than by anything technical. If it ever needs paging it will
        // need it visibly, and this is the comment that says so.
        res.set('Cache-Control', 'public, max-age=300');

        return res.json({
            generatedAt: new Date().toISOString(),
            proposals: rows.map(publicDecided),
        });
    } catch (err) {
        return next(err);
    }
});

// The public shape. Nothing here identifies an account.
//
// §3 gives two ways a name is not shown, and the order matters: anonymous wins
// over withdrawn. Someone who chose anonymity and later deleted their account
// must not become "Withdrawn" on a page where they used to be "Anonymous" —
// the change itself would be the disclosure, to anyone who had read both.
function publicDecided(row) {
    let author;
    if (row.display_as === 'anonymous') author = 'Anonymous';
    else if (row.withdrawn_at) author = 'Withdrawn';
    else author = row.display_name;

    return {
        id: String(row.id),
        nodePath: row.node_path,
        type: row.type,
        status: row.status,
        author,
        summary: proposals.summarisePayload(row.type, row.payload),
        payload: row.payload,
        body: row.body,
        sources: row.sources || [],
        decisionReason: row.decision_reason,
        decisionRule: row.decision_rule,
        decidedAt: row.decided_at,
        createdAt: row.created_at,
    };
}

// Everything below needs a session. §4: "Account verified and not suspended".
// session.require covers suspension — attach refuses a suspended account on
// every request — and verification is checked in the handler, because an
// unverified account is signed in but may not submit.
router.use(session.require);

// All five types from §4 are open as of build step 5. `break` stays first
// wherever they are listed: it needs a case rather than a replacement
// structure, and it is the one most people can write.
const BUILT = new Set(['break', 'subdivide', 'redefine', 'relocate', 'merge']);

// §4: "5 proposals per account per day". The per-IP half of that line is 20 a
// day and lives in src/rateLimit.js with the others.
const PER_ACCOUNT_PER_DAY = 5;

// GET /atlas/proposals/new
//
// The token carries its own issue time, signed. It is not a credential and is
// not tied to the account: it says only that this form was asked for at a
// particular moment, which is the whole of what the 20-second rule needs.
router.get('/new', (req, res) => {
    res.json({
        formToken: proposals.issueFormToken(),
        minSeconds: proposals.MIN_SECONDS_ON_FORM,
        bodyMax: proposals.BODY_MAX,
        caseMax: proposals.CASE_MAX,
    });
});

// POST /atlas/proposals
router.post('/', session.requireCsrf, async (req, res, next) => {
    const body = req.body || {};
    const { type, nodePath, displayAs, formToken, sources } = body;

    // The honeypot. A field no person sees, named as something a form-filling
    // bot wants to complete. Anything in it and the submission is dropped —
    // with a 202 rather than a 4xx, because telling a bot which check it
    // failed is how the next version of it passes.
    if (typeof body.website === 'string' && body.website.trim() !== '') {
        return res.status(202).json({ status: 'accepted' });
    }

    if (!BUILT.has(type)) {
        return res.status(400).json({ error: 'Unknown proposal type.' });
    }

    // Verified before anything can be submitted (§3). Checked before the
    // cheap field validation so that an unverified account is told the one
    // thing it needs to do, rather than a list of form errors first.
    if (!req.account.verifiedAt) {
        return res.status(403).json({
            error: 'Verify your email address before submitting a proposal.',
        });
    }

    // node_path is validated before the payload, because two of the five types
    // are checked against the node itself — a merge names components that have
    // to be its children, and a relocation must not move a node under its own
    // descendant.
    const problem =
        proposals.nodePathProblem(nodePath)
        || proposals.displayAsProblem(displayAs)
        || proposals.payloadProblem(type, body, String(nodePath).trim())
        || proposals.bodyProblem(body.body)
        || proposals.sourcesProblem(sources)
        || proposals.formTokenProblem(formToken);

    if (problem) return res.status(400).json({ error: problem });

    try {
        // Per IP, out loud: §4 sets 20 a day, and an address is not an account,
        // so refusing it visibly discloses nothing.
        if (await limits.ipLimited(req, res, 'propose')) return;

        // Per account, counted off the proposals themselves rather than off
        // auth_attempts — a proposal leaves a row of its own, so the count is
        // exact. Unlike the sign-in limits this one is allowed to be visible:
        // the caller is already authenticated, so it cannot answer "does this
        // address exist?" for anyone who is not already the account holder.
        const { rows: recent } = await pool.query(
            `SELECT count(*)::int AS n FROM atlas.proposals
              WHERE account_id = $1 AND created_at > now() - interval '1 day'`,
            [req.account.id]
        );
        if (recent[0].n >= PER_ACCOUNT_PER_DAY) {
            res.set('Retry-After', String(24 * 60 * 60));
            return res.status(429).json({
                error: `That is ${PER_ACCOUNT_PER_DAY} proposals today. `
                     + 'The limit is per day, and it is there because each one is read by a person.',
            });
        }

        await limits.record('propose', { ip: req.ip, accountId: req.account.id, succeeded: true });

        const { rows } = await pool.query(
            `INSERT INTO atlas.proposals
                 (account_id, node_path, type, display_as, body, payload, sources)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
             RETURNING id, node_path, type, display_as, status, created_at`,
            [
                req.account.id,
                String(nodePath).trim(),
                type,
                displayAs,
                String(body.body).trim(),
                JSON.stringify(proposals.buildPayload(type, body)),
                JSON.stringify(proposals.cleanSources(sources)),
            ]
        );

        // 201 and the proposal's own shape. Nothing about when it will be
        // looked at, because that would be a promise the queue cannot keep.
        return res.status(201).json({
            proposal: proposals.publicProposal(rows[0]),
            message: 'Submitted. It is in the queue, and the decision will be published either way.',
        });
    } catch (err) {
        return next(err);
    }
});

module.exports = router;
