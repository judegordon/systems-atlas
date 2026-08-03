//
// Password handling, single-use tokens, and the one shape in which an account
// is ever allowed to leave this service.
//
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const pool = require('./db');

const COST = 12;                              // as the apps already use
const MIN_PASSWORD_LENGTH = 10;               // no composition rules

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;    // 24 hours
const RESET_TTL_MS = 60 * 60 * 1000;          // 1 hour

// A real bcrypt hash of a random string nobody kept. Sign-in compares against
// this when the address is unknown, so that "no such account" costs the same
// quarter-second as "wrong password". Skipping the comparison would answer the
// enumeration question with a stopwatch, which is exactly what the equal
// wording of the two errors is there to prevent.
const DUMMY_HASH = '$2b$12$xrNuDs2t5UTvgyOaG1ODIum3PH.QNxn630KZVVTjN6RZ39H4LSlmC';

function hashPassword(password) {
    return bcrypt.hash(password, COST);
}

// `hash` may be null, for a withdrawn account. bcrypt.compare rejects a null
// hash by throwing, so the dummy stands in and the answer is still no.
function checkPassword(password, hash) {
    return bcrypt.compare(password, hash || DUMMY_HASH);
}


// Validation -------------------------------------------------------------------

// Deliberately permissive. The address is proven by the verification email,
// not by a regex, and every regex strict enough to be worth writing rejects
// somebody's real address.
function validEmail(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (trimmed.length < 3 || trimmed.length > 254) return false;
    if (/\s/.test(trimmed)) return false;
    const at = trimmed.indexOf('@');
    return at > 0 && at === trimmed.lastIndexOf('@') && at < trimmed.length - 1;
}

function passwordProblem(password) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
        return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
    }
    if (password.length > 200) {
        // bcrypt truncates at 72 bytes; a longer field is accepted and simply
        // has no further effect, but an unbounded one is a way to spend the
        // server's time.
        return 'Password must be 200 characters or fewer';
    }
    return null;
}

function displayNameProblem(name) {
    if (typeof name !== 'string') return 'Display name is required';
    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed.length > 40) {
        return 'Display name must be between 2 and 40 characters';
    }
    // The name appears on the public site next to an argument. Control
    // characters in it are never a name, only a way to break the page it
    // lands on.
    if (/[\u0000-\u001F\u007F]/.test(trimmed)) {
        return 'Display name may not contain control characters';
    }
    return null;
}

function bioProblem(bio) {
    if (bio === null || bio === undefined) return null;
    if (typeof bio !== 'string') return 'Bio must be text';
    if (bio.length > 160) return 'Bio must be 160 characters or fewer';
    if (/[\u0000-\u001F\u007F]/.test(bio)) return 'Bio may not contain control characters';
    return null;
}


// Single-use tokens ---------------------------------------------------------------

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

// Issuing invalidates any earlier unused token of the same kind. Three live
// reset links at once is three chances for the oldest to be found in a mailbox
// later; the newest request is the one the person is looking at.
async function issueToken(accountId, kind) {
    const token = crypto.randomBytes(32).toString('base64url');
    const ttl = kind === 'verify' ? VERIFY_TTL_MS : RESET_TTL_MS;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `UPDATE atlas.tokens SET used_at = now()
              WHERE account_id = $1 AND kind = $2 AND used_at IS NULL`,
            [accountId, kind]
        );
        await client.query(
            `INSERT INTO atlas.tokens (account_id, kind, token_hash, expires_at)
             VALUES ($1, $2, $3, now() + ($4::bigint * interval '1 millisecond'))`,
            [accountId, kind, hashToken(token), ttl]
        );
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }

    return token;
}

// One statement, so that two requests carrying the same token cannot both find
// it unused. The row is claimed by whichever UPDATE gets there first; the other
// matches nothing and is told the link is invalid.
async function consumeToken(kind, token) {
    if (typeof token !== 'string' || token.length === 0) return null;

    const { rows } = await pool.query(
        `UPDATE atlas.tokens SET used_at = now()
          WHERE token_hash = $1
            AND kind = $2
            AND used_at IS NULL
            AND expires_at > now()
      RETURNING account_id`,
        [hashToken(token), kind]
    );
    return rows.length ? rows[0].account_id : null;
}


// Serialisation ---------------------------------------------------------------------

// The only function that builds an account for a response body. There is no
// path from a database row to the client that does not pass through here, so
// there is one place to check that a password hash cannot escape.
function publicAccount(account) {
    return {
        id: String(account.id),
        email: account.email,
        displayName: account.displayName ?? account.display_name,
        bio: account.bio ?? null,
        isAdmin: account.isAdmin ?? account.is_admin,
        verified: Boolean(account.verifiedAt ?? account.verified_at),
        createdAt: account.createdAt ?? account.created_at,
    };
}

module.exports = {
    COST,
    MIN_PASSWORD_LENGTH,
    VERIFY_TTL_MS,
    RESET_TTL_MS,
    hashPassword,
    checkPassword,
    validEmail,
    passwordProblem,
    displayNameProblem,
    bioProblem,
    issueToken,
    consumeToken,
    hashToken,
    publicAccount,
};
