//
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

// §4: "Account verified and not suspended". session.require covers suspension
// — attach refuses a suspended account on every request — and verification is
// checked below, because an unverified account is signed in but may not submit.
router.use(session.require);

const BUILT = new Set(['break']);
const PLANNED = new Set(['subdivide', 'redefine', 'relocate', 'merge']);

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
        if (PLANNED.has(type)) {
            return res.status(400).json({
                error: 'Only break proposals are open at the moment.',
            });
        }
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

    const problem =
        proposals.nodePathProblem(nodePath)
        || proposals.displayAsProblem(displayAs)
        || proposals.caseProblem(body.case)
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
             VALUES ($1, $2, 'break', $3, $4, $5::jsonb, $6::jsonb)
             RETURNING id, node_path, type, display_as, status, created_at`,
            [
                req.account.id,
                String(nodePath).trim(),
                displayAs,
                String(body.body).trim(),
                JSON.stringify({ case: String(body.case).trim() }),
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
