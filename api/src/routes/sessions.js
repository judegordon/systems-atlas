//
// POST   /atlas/sessions       sign in
// DELETE /atlas/sessions       sign out
// DELETE /atlas/sessions/all   sign out everywhere
//
const express = require('express');
const pool = require('../db');
const accounts = require('../accounts');
const limits = require('../rateLimit');
const session = require('../middleware/session');

const router = express.Router();

// docs/ACCOUNTS.md: "Sign-in returns one message for both a wrong password and
// an unknown address."
const REFUSED = 'Incorrect email or password';

// POST /atlas/sessions
router.post('/', async (req, res, next) => {
    const { email, password } = req.body || {};

    if (typeof email !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
        if (await limits.ipLimited(req, res, 'signin')) return;

        const { rows } = await pool.query(
            `SELECT id, password_hash, suspended_at, suspended_reason, withdrawn_at
               FROM atlas.accounts
              WHERE email = $1`,
            [email.trim()]
        );
        const account = rows[0] || null;

        // The delay is per account and grows with recent failures. It is not a
        // lock: the account is never closed to its owner, it is only made slow
        // to guess at. docs/ACCOUNTS.md is explicit that locking is itself a
        // denial-of-service vector.
        await limits.sleep(await limits.signinDelayMs(account ? account.id : null));

        // Runs even when there is no account, against a hash of a string
        // nobody kept, so that both answers cost the same.
        const correct = await accounts.checkPassword(password, account && account.password_hash);

        // A withdrawn account has no password_hash, so `correct` is already
        // false for it and it falls in with every other unknown address —
        // which is what it now is.
        if (!account || !correct || account.withdrawn_at) {
            await limits.record('signin', {
                accountId: account ? account.id : null,
                ip: req.ip,
                succeeded: false,
            });
            return res.status(401).json({ error: REFUSED });
        }

        // Reaching here means the password was right, so naming the suspension
        // tells its owner something they are entitled to know and tells a
        // stranger nothing they could not already have worked out.
        if (account.suspended_at) {
            await limits.record('signin', { accountId: account.id, ip: req.ip, succeeded: false });
            return res.status(403).json({
                error: 'This account is suspended',
                reason: account.suspended_reason,
            });
        }

        await limits.record('signin', { accountId: account.id, ip: req.ip, succeeded: true });

        const issued = await session.issue(account.id, req.get('User-Agent'));
        session.setSessionCookie(res, issued.token, issued.expiresAt);

        const { rows: fresh } = await pool.query(
            `SELECT id, email, display_name, bio, is_admin, verified_at, created_at
               FROM atlas.accounts WHERE id = $1`,
            [account.id]
        );

        return res.status(201).json({
            account: accounts.publicAccount(fresh[0]),
            csrfToken: issued.csrfToken,
            expiresAt: issued.expiresAt,
        });
    } catch (err) {
        return next(err);
    }
});

// DELETE /atlas/sessions
//
// No `session.require` in front of it. Signing out when already signed out is
// not an error worth reporting — the caller wanted no session and has none.
router.delete('/', session.requireCsrf, async (req, res, next) => {
    try {
        if (req.session) await session.revoke(req.session.token);
        session.clearSessionCookie(res);
        return res.status(204).end();
    } catch (err) {
        return next(err);
    }
});

// DELETE /atlas/sessions/all
router.delete('/all', session.require, session.requireCsrf, async (req, res, next) => {
    try {
        const revoked = await session.revokeAll(req.account.id);
        session.clearSessionCookie(res);
        return res.json({ revoked });
    } catch (err) {
        return next(err);
    }
});

module.exports = router;
