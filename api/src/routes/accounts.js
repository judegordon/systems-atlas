//
// POST /atlas/accounts               sign up
// POST /atlas/accounts/verify        consume a verification token
// POST /atlas/accounts/verify/resend re-send verification
//
const express = require('express');
const pool = require('../db');
const accounts = require('../accounts');
const limits = require('../rateLimit');
const mail = require('../mail');

const router = express.Router();

// The one response sign-up is allowed to give. docs/ACCOUNTS.md: "Sign-up and
// password reset always return the same response regardless of whether the
// address is registered."
const ACCEPTED = {
    status: 'accepted',
    message: 'If that address can receive mail, a verification link is on its way.',
};

// POST /atlas/accounts
router.post('/', async (req, res, next) => {
    const { email, password, displayName } = req.body || {};

    // Malformed input is answered plainly. None of these checks touch the
    // database, so none of them can distinguish a registered address from an
    // unregistered one — which is the only thing that has to stay hidden.
    if (!accounts.validEmail(email)) {
        return res.status(400).json({ error: 'A valid email address is required' });
    }
    const nameProblem = accounts.displayNameProblem(displayName);
    if (nameProblem) return res.status(400).json({ error: nameProblem });

    const pwProblem = accounts.passwordProblem(password);
    if (pwProblem) return res.status(400).json({ error: pwProblem });

    try {
        if (await limits.ipLimited(req, res, 'signup')) return;
        await limits.record('signup', { ip: req.ip });

        // Hashed before the address is looked up, and in both branches. If the
        // hash only ran when the account was new, an existing address would
        // return in five milliseconds and a new one in three hundred, and the
        // identical response body would not matter in the slightest.
        const passwordHash = await accounts.hashPassword(password);

        const normalised = String(email).trim();
        let created;
        try {
            const { rows } = await pool.query(
                `INSERT INTO atlas.accounts (email, password_hash, display_name)
                 VALUES ($1, $2, $3)
                 RETURNING id, email`,
                [normalised, passwordHash, String(displayName).trim()]
            );
            created = rows[0];
        } catch (err) {
            // 23505 is the unique violation on email: the address is already
            // registered, or two sign-ups for it raced. Either way this branch
            // does nothing further and returns what the other branch returns.
            if (err.code !== '23505') throw err;
            return res.status(202).json(ACCEPTED);
        }

        const token = await accounts.issueToken(created.id, 'verify');
        await mail.sendVerification(created.email, token);

        return res.status(202).json(ACCEPTED);
    } catch (err) {
        return next(err);
    }
});

// POST /atlas/accounts/verify
router.post('/verify', async (req, res, next) => {
    const { token } = req.body || {};

    try {
        const accountId = await accounts.consumeToken('verify', token);
        if (!accountId) {
            // Expired, already used, or never existed. The three are not
            // distinguished: a token is a secret, and which kind of dead it is
            // is information about somebody else's account.
            return res.status(400).json({
                error: 'This verification link is invalid, expired, or already used',
            });
        }

        // COALESCE so that verifying twice does not move the date. It cannot
        // happen through this endpoint, since the token is spent, but the
        // column means "when this address was first proven" and should keep
        // meaning that if a second path to it is ever added.
        await pool.query(
            `UPDATE atlas.accounts
                SET verified_at = COALESCE(verified_at, now())
              WHERE id = $1`,
            [accountId]
        );

        return res.json({ verified: true });
    } catch (err) {
        return next(err);
    }
});

// POST /atlas/accounts/verify/resend
router.post('/verify/resend', async (req, res, next) => {
    const { email } = req.body || {};

    // Same shape as sign-up, and for the same reason: this endpoint must not
    // become the enumeration hole that sign-up refuses to be.
    if (!accounts.validEmail(email)) {
        return res.status(202).json(ACCEPTED);
    }

    try {
        const { rows } = await pool.query(
            `SELECT id, email, verified_at, suspended_at
               FROM atlas.accounts
              WHERE email = $1 AND withdrawn_at IS NULL`,
            [String(email).trim()]
        );
        const account = rows[0];

        // Nothing to send to: no such account, already verified, or suspended.
        // Over the limit, the answer is also 202 and also says a link is on its
        // way — a visible 429 here would confirm the address is registered.
        let sent = false;
        if (account
            && !account.verified_at
            && !account.suspended_at
            && !(await limits.accountLimited('verify_resend', account.id))) {
            const token = await accounts.issueToken(account.id, 'verify');
            await mail.sendVerification(account.email, token);
            sent = true;
        }

        // The account limit counts rows marked succeeded, so it counts emails
        // rather than requests: being refused does not spend the allowance, and
        // three attempts in an hour buy three emails rather than two.
        if (account) {
            await limits.record('verify_resend', {
                accountId: account.id,
                ip: req.ip,
                succeeded: sent,
            });
        }

        return res.status(202).json(ACCEPTED);
    } catch (err) {
        return next(err);
    }
});

module.exports = router;
