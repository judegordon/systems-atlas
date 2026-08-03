//
// GET    /atlas/me           current account, or 401
// PATCH  /atlas/me           update display name, bio
// POST   /atlas/me/password  change password, requires the current one
// DELETE /atlas/me           withdraw, requires password confirmation
//
const express = require('express');
const pool = require('../db');
const accounts = require('../accounts');
const session = require('../middleware/session');

const router = express.Router();

router.use(session.require);

// GET /atlas/me
//
// The CSRF token is returned here because a page that has been reloaded holds
// the cookie but not the token, and this is the request it makes first.
router.get('/', (req, res) => {
    res.json({
        account: accounts.publicAccount(req.account),
        csrfToken: req.session.csrfToken,
    });
});

// PATCH /atlas/me
router.patch('/', session.requireCsrf, async (req, res, next) => {
    const body = req.body || {};

    // Absent means "leave it"; null means "clear it". Without the distinction
    // a bio could be set but never removed.
    const changingName = Object.prototype.hasOwnProperty.call(body, 'displayName');
    const changingBio = Object.prototype.hasOwnProperty.call(body, 'bio');

    if (!changingName && !changingBio) {
        return res.status(400).json({ error: 'Nothing to update' });
    }

    if (changingName) {
        const problem = accounts.displayNameProblem(body.displayName);
        if (problem) return res.status(400).json({ error: problem });
    }
    if (changingBio && body.bio !== null) {
        const problem = accounts.bioProblem(body.bio);
        if (problem) return res.status(400).json({ error: problem });
    }

    try {
        const { rows } = await pool.query(
            `UPDATE atlas.accounts
                SET display_name = COALESCE($2, display_name),
                    bio          = CASE WHEN $3::boolean THEN $4 ELSE bio END
              WHERE id = $1 AND withdrawn_at IS NULL
          RETURNING id, email, display_name, bio, is_admin, verified_at, created_at`,
            [
                req.account.id,
                changingName ? String(body.displayName).trim() : null,
                changingBio,
                changingBio && body.bio !== null ? String(body.bio).trim() : null,
            ]
        );

        if (rows.length === 0) return res.status(401).json({ error: 'Not signed in' });

        return res.json({ account: accounts.publicAccount(rows[0]) });
    } catch (err) {
        return next(err);
    }
});

// POST /atlas/me/password
router.post('/password', session.requireCsrf, async (req, res, next) => {
    const { currentPassword, newPassword } = req.body || {};

    if (typeof currentPassword !== 'string') {
        return res.status(400).json({ error: 'Current password is required' });
    }
    const problem = accounts.passwordProblem(newPassword);
    if (problem) return res.status(400).json({ error: problem });

    try {
        const { rows } = await pool.query(
            'SELECT password_hash FROM atlas.accounts WHERE id = $1 AND withdrawn_at IS NULL',
            [req.account.id]
        );
        if (rows.length === 0) return res.status(401).json({ error: 'Not signed in' });

        const correct = await accounts.checkPassword(currentPassword, rows[0].password_hash);
        if (!correct) {
            // 403, not 401. The session is fine; it is the password that was
            // wrong, and the page needs to tell those two apart.
            return res.status(403).json({ error: 'Current password is incorrect' });
        }

        const passwordHash = await accounts.hashPassword(newPassword);
        await pool.query(
            'UPDATE atlas.accounts SET password_hash = $1 WHERE id = $2',
            [passwordHash, req.account.id]
        );

        // Every other session dies. The one that made the change survives,
        // because signing someone out of the tab they are looking at is not a
        // security property, it is an annoyance.
        const revoked = await pool.query(
            `UPDATE atlas.sessions SET revoked_at = now()
              WHERE account_id = $1 AND id <> $2 AND revoked_at IS NULL`,
            [req.account.id, req.session.id]
        );

        return res.json({ changed: true, otherSessionsRevoked: revoked.rowCount });
    } catch (err) {
        return next(err);
    }
});

// DELETE /atlas/me
//
// docs/ACCOUNTS.md: "DELETE FROM accounts is never issued." The row stays, and
// what is published stays published, attributed to Withdrawn.
router.delete('/', session.requireCsrf, async (req, res, next) => {
    const { password } = req.body || {};

    if (typeof password !== 'string') {
        return res.status(400).json({ error: 'Password is required to withdraw' });
    }

    try {
        const { rows } = await pool.query(
            'SELECT password_hash FROM atlas.accounts WHERE id = $1 AND withdrawn_at IS NULL',
            [req.account.id]
        );
        if (rows.length === 0) return res.status(401).json({ error: 'Not signed in' });

        const correct = await accounts.checkPassword(password, rows[0].password_hash);
        if (!correct) return res.status(403).json({ error: 'Password is incorrect' });

        // is_admin is cleared with the rest. A withdrawn account that could be
        // restored to administrative rights by setting one column back is a
        // door left open for no one's benefit.
        await pool.query(
            `UPDATE atlas.accounts
                SET withdrawn_at  = now(),
                    email         = NULL,
                    password_hash = NULL,
                    bio           = NULL,
                    display_name  = 'Withdrawn',
                    is_admin      = FALSE
              WHERE id = $1 AND withdrawn_at IS NULL`,
            [req.account.id]
        );

        await session.revokeAll(req.account.id);
        session.clearSessionCookie(res);

        return res.json({ withdrawn: true });
    } catch (err) {
        return next(err);
    }
});

module.exports = router;
