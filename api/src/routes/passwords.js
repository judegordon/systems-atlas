//
// POST /atlas/passwords/reset          request a reset
// POST /atlas/passwords/reset/confirm  consume a reset token, set a new password
//
const express = require('express');
const pool = require('../db');
const accounts = require('../accounts');
const limits = require('../rateLimit');
const mail = require('../mail');
const session = require('../middleware/session');
const deferred = require('../deferred');

const router = express.Router();

const ACCEPTED = {
    status: 'accepted',
    message: 'If that address has an account, a reset link is on its way.',
};

// POST /atlas/passwords/reset
router.post('/reset', async (req, res, next) => {
    const { email } = req.body || {};

    try {
        if (await limits.ipLimited(req, res, 'reset')) return;

        let account = null;
        if (accounts.validEmail(email)) {
            const { rows } = await pool.query(
                `SELECT id, email FROM atlas.accounts
                  WHERE email = $1 AND withdrawn_at IS NULL`,
                [String(email).trim()]
            );
            account = rows[0] || null;
        }

        // No account, or already three emails in a day: nothing is sent, and
        // the response is the same 202. The per-account limit is invisible for
        // the same reason the unknown-address case is.
        const sent = Boolean(account && !(await limits.accountLimited('reset', account.id)));

        // Off the request's clock, as with sign-up. An address with an account
        // behind it costs a transaction and a call to Resend; one without costs
        // neither, and the difference is plainly visible in the response time
        // unless it is moved after the response. See src/deferred.js.
        if (sent) {
            deferred.after(res, async () => {
                const token = await accounts.issueToken(account.id, 'reset');
                await mail.sendPasswordReset(account.email, token);
            });
        }

        // Exactly one row per request, whatever happened. The IP limit counts
        // rows, so writing two would halve it; the account limit counts the
        // ones marked succeeded, so a refusal costs the owner nothing.
        await limits.record('reset', {
            accountId: account ? account.id : null,
            ip: req.ip,
            succeeded: sent,
        });

        return res.status(202).json(ACCEPTED);
    } catch (err) {
        return next(err);
    }
});

// POST /atlas/passwords/reset/confirm
router.post('/reset/confirm', async (req, res, next) => {
    const { token, password } = req.body || {};

    const problem = accounts.passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });

    try {
        const accountId = await accounts.consumeToken('reset', token);
        if (!accountId) {
            return res.status(400).json({
                error: 'This reset link is invalid, expired, or already used',
            });
        }

        const passwordHash = await accounts.hashPassword(password);
        const { rowCount } = await pool.query(
            `UPDATE atlas.accounts SET password_hash = $1
              WHERE id = $2 AND withdrawn_at IS NULL`,
            [passwordHash, accountId]
        );

        if (rowCount === 0) {
            // The account was withdrawn between the link being sent and used.
            return res.status(400).json({ error: 'This reset link is no longer valid' });
        }

        // Whoever was signed in with the old password is signed out. A reset is
        // most often used because the password is believed to be in someone
        // else's hands, and leaving their session alive would answer the wrong
        // half of the problem.
        const revoked = await session.revokeAll(accountId);
        session.clearSessionCookie(res);

        return res.json({ reset: true, sessionsRevoked: revoked });
    } catch (err) {
        return next(err);
    }
});

module.exports = router;
