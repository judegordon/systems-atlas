//
// GET  /atlas/comments       published comments, public — what the build reads
// GET  /atlas/comments/new   issue a form token
// POST /atlas/comments       post a comment, or a reply one level deep
//
// docs/PROPOSALS.md §5, build step 6. "Same rate limits and honeypot. Same
// publish-at-build-time model." So this file is deliberately close to
// routes/proposals.js — the differences are the ones §5 asks for and no others.
//
const express = require('express');
const pool = require('../db');
const comments = require('../comments');
const proposals = require('../proposals');
const limits = require('../rateLimit');
const session = require('../middleware/session');

const router = express.Router();

// §5 says "same rate limits" and §4's are 5 per account per day, 20 per IP.
const PER_ACCOUNT_PER_DAY = 5;

// GET /atlas/comments
//
// Public. Published only — a pending comment is not on the site and a rejected
// one never will be. Ordered so a thread can be assembled without a second
// pass: top-level oldest first, and a reply straight after the comment it
// answers is the build's job, not this query's.
router.get('/', async (req, res, next) => {
    try {
        const { rows } = await pool.query(
            `SELECT c.id, c.node_path, c.parent_id, c.display_as, c.body, c.created_at,
                    a.display_name, a.withdrawn_at
               FROM atlas.comments c
               JOIN atlas.accounts a ON a.id = c.account_id
              WHERE c.status = 'published'
              ORDER BY c.created_at ASC, c.id ASC`
        );

        res.set('Cache-Control', 'public, max-age=300');
        return res.json({
            generatedAt: new Date().toISOString(),
            comments: rows.map(comments.publicComment),
        });
    } catch (err) {
        return next(err);
    }
});

// Everything below needs a session.
router.use(session.require);

// GET /atlas/comments/new
router.get('/new', (req, res) => {
    res.json({
        formToken: proposals.issueFormToken(),
        minSeconds: proposals.MIN_SECONDS_ON_FORM,
        bodyMax: comments.BODY_MAX,
    });
});

// POST /atlas/comments
router.post('/', session.requireCsrf, async (req, res, next) => {
    const body = req.body || {};
    const { nodePath, displayAs, formToken, parentId } = body;

    // Same honeypot, same 202. Telling a bot which check it failed is how the
    // next version of it passes.
    if (typeof body.website === 'string' && body.website.trim() !== '') {
        return res.status(202).json({ status: 'accepted' });
    }

    if (!req.account.verifiedAt) {
        return res.status(403).json({
            error: 'Verify your email address before commenting.',
        });
    }

    const problem =
        proposals.nodePathProblem(nodePath)
        || proposals.displayAsProblem(displayAs)
        || comments.parentProblem(parentId)
        || comments.bodyProblem(body.body)
        || proposals.formTokenProblem(formToken);

    if (problem) return res.status(400).json({ error: problem });

    try {
        if (await limits.ipLimited(req, res, 'comment')) return;

        const { rows: recent } = await pool.query(
            `SELECT count(*)::int AS n FROM atlas.comments
              WHERE account_id = $1 AND created_at > now() - interval '1 day'`,
            [req.account.id]
        );
        if (recent[0].n >= PER_ACCOUNT_PER_DAY) {
            res.set('Retry-After', String(24 * 60 * 60));
            return res.status(429).json({
                error: `That is ${PER_ACCOUNT_PER_DAY} comments today. `
                     + 'The limit is per day, and every one of them is read by a person.',
            });
        }

        await limits.record('comment', { ip: req.ip, accountId: req.account.id, succeeded: true });

        let rows;
        try {
            ({ rows } = await pool.query(
                `INSERT INTO atlas.comments
                     (account_id, node_path, parent_id, display_as, body)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id, node_path, parent_id, display_as, status, created_at`,
                [
                    req.account.id,
                    String(nodePath).trim(),
                    parentId ? String(parentId) : null,
                    displayAs,
                    String(body.body).trim(),
                ]
            ));
        } catch (err) {
            // The depth rule and the same-node rule are a trigger, so they
            // arrive as errors rather than as a check this route ran. Turned
            // back into the sentence the person needs.
            if (err && err.code === '23514') {
                return res.status(400).json({
                    error: 'Replies go one level deep. Answering a reply wants to be '
                         + 'a comment of its own, or a proposal.',
                });
            }
            if (err && /does not exist/.test(String(err.message))) {
                return res.status(400).json({ error: 'That comment is no longer there.' });
            }
            throw err;
        }

        return res.status(201).json({
            comment: {
                id: String(rows[0].id),
                nodePath: rows[0].node_path,
                parentId: rows[0].parent_id === null ? null : String(rows[0].parent_id),
                status: rows[0].status,
                createdAt: rows[0].created_at,
            },
            message: 'Posted. It appears on the node page once it has been read.',
        });
    } catch (err) {
        return next(err);
    }
});

module.exports = router;
