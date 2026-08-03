//
// Sessions, not JWTs.
//
// docs/ACCOUNTS.md: "A JWT cannot be revoked before it expires. This system
// needs suspension to take effect immediately, and needs a signed-out session
// to be genuinely dead." So the token carries no claims at all — it is 32
// random bytes, and everything true about the session is read from the
// database on every request.
//
// The cost is one query per authenticated request. That is the feature: it is
// what makes `attach` below reject a suspended account on the next request it
// makes, rather than whenever its token happens to expire.
//
const crypto = require('crypto');
const pool = require('../db');

const COOKIE_NAME = 'atlas_session';

const LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
const SLIDE_AFTER_MS = 24 * 60 * 60 * 1000;     // refresh on use if over a day old

const PRODUCTION = process.env.NODE_ENV === 'production';

// State-changing methods need a CSRF token. SameSite=Lax alone is not relied
// on — docs/ACCOUNTS.md is explicit about that.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);


// Tokens ---------------------------------------------------------------------

function newToken() {
    return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

// Comparing a submitted CSRF token against the stored one leaks its length and
// its matching prefix under a naive ===. The tokens are the same length in
// practice, but that is a property of how they are generated, not something
// this function should assume.
function tokensEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}


// Cookie ---------------------------------------------------------------------

function readCookie(req, name) {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        if (part.slice(0, eq).trim() !== name) continue;
        try {
            return decodeURIComponent(part.slice(eq + 1).trim());
        } catch {
            return null;                 // malformed percent-encoding
        }
    }
    return null;
}

// No Domain attribute. The cookie is set by api.systemsatlasproject.com and is
// sent back to that host only. Widening it to .systemsatlasproject.com would
// hand the session to every other subdomain for no gain — the site's fetches
// carry it either way, because SameSite is judged on the registrable domain.
function setSessionCookie(res, token, expiresAt) {
    const parts = [
        `${COOKIE_NAME}=${encodeURIComponent(token)}`,
        'HttpOnly',
        'SameSite=Lax',
        'Path=/',
        `Expires=${expiresAt.toUTCString()}`,
        `Max-Age=${Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))}`,
    ];
    if (PRODUCTION) parts.push('Secure');
    appendSetCookie(res, parts.join('; '));
}

function clearSessionCookie(res) {
    const parts = [
        `${COOKIE_NAME}=`,
        'HttpOnly',
        'SameSite=Lax',
        'Path=/',
        'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        'Max-Age=0',
    ];
    if (PRODUCTION) parts.push('Secure');
    appendSetCookie(res, parts.join('; '));
}

function appendSetCookie(res, value) {
    const existing = res.getHeader('Set-Cookie');
    if (!existing) res.setHeader('Set-Cookie', value);
    else res.setHeader('Set-Cookie', [].concat(existing, value));
}


// Issue and revoke -------------------------------------------------------------

// Returns the two values the caller must hand back to the browser: the session
// token, which goes in the cookie and is never stored, and the CSRF token,
// which goes in the response body for the page to echo on its next write.
async function issue(accountId, userAgent) {
    const token = newToken();
    const csrfToken = newToken();
    const expiresAt = new Date(Date.now() + LIFETIME_MS);

    await pool.query(
        `INSERT INTO atlas.sessions
             (account_id, token_hash, csrf_token, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [accountId, hashToken(token), csrfToken, truncate(userAgent, 400), expiresAt]
    );

    return { token, csrfToken, expiresAt };
}

async function revoke(token) {
    if (!token) return;
    await pool.query(
        `UPDATE atlas.sessions SET revoked_at = now()
         WHERE token_hash = $1 AND revoked_at IS NULL`,
        [hashToken(token)]
    );
}

async function revokeAll(accountId) {
    const result = await pool.query(
        `UPDATE atlas.sessions SET revoked_at = now()
         WHERE account_id = $1 AND revoked_at IS NULL`,
        [accountId]
    );
    return result.rowCount;
}

function truncate(value, max) {
    if (typeof value !== 'string') return null;
    return value.length > max ? value.slice(0, max) : value;
}


// Lookup -----------------------------------------------------------------------

// Every condition that can kill a session is one query. The account is joined
// rather than fetched separately so that suspension, withdrawal and revocation
// are all decided by the same row at the same instant.
const LOOKUP = `
    SELECT s.id            AS session_id,
           s.csrf_token,
           s.expires_at,
           s.revoked_at,
           a.id            AS account_id,
           a.email,
           a.display_name,
           a.bio,
           a.is_admin,
           a.verified_at,
           a.suspended_at,
           a.withdrawn_at,
           a.created_at
      FROM atlas.sessions s
      JOIN atlas.accounts a ON a.id = s.account_id
     WHERE s.token_hash = $1
`;

// Reads the cookie and resolves it to an account, or to null. Never throws for
// an absent or bad session — that is `require`'s job — so that endpoints which
// are happy to serve an anonymous caller can share this middleware.
async function attach(req, res, next) {
    req.session = null;
    req.account = null;

    const token = readCookie(req, COOKIE_NAME);
    if (!token) return next();

    let row;
    try {
        const result = await pool.query(LOOKUP, [hashToken(token)]);
        row = result.rows[0];
    } catch (err) {
        return next(err);
    }

    // Unknown token, revoked, expired, suspended, withdrawn. In every case the
    // browser is holding something worthless, so take it back.
    const now = Date.now();
    const dead =
        !row ||
        row.revoked_at !== null ||
        new Date(row.expires_at).getTime() <= now ||
        row.suspended_at !== null ||
        row.withdrawn_at !== null;

    if (dead) {
        clearSessionCookie(res);
        return next();
    }

    // Sliding expiry: 30 days from now, but only rewritten once a day, so a
    // busy session does not cost a write per request.
    let expiresAt = new Date(row.expires_at);
    if (expiresAt.getTime() - now < LIFETIME_MS - SLIDE_AFTER_MS) {
        expiresAt = new Date(now + LIFETIME_MS);
        try {
            await pool.query(
                'UPDATE atlas.sessions SET expires_at = $1 WHERE id = $2',
                [expiresAt, row.session_id]
            );
            setSessionCookie(res, token, expiresAt);
        } catch (err) {
            return next(err);
        }
    }

    req.session = {
        id: row.session_id,
        token,
        csrfToken: row.csrf_token,
        expiresAt,
    };
    req.account = {
        id: row.account_id,
        email: row.email,
        displayName: row.display_name,
        bio: row.bio,
        isAdmin: row.is_admin,
        verifiedAt: row.verified_at,
        createdAt: row.created_at,
    };

    next();
}


// Guards -------------------------------------------------------------------------

function require_(req, res, next) {
    if (!req.account) {
        return res.status(401).json({ error: 'Not signed in' });
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.account) {
        return res.status(401).json({ error: 'Not signed in' });
    }
    // 404 rather than 403: whether an admin endpoint exists is not something a
    // signed-in stranger needs to learn.
    if (!req.account.isAdmin) {
        return res.status(404).json({ error: 'Not found' });
    }
    next();
}

// Applied to writes that act on an existing session. Sign-up and sign-in carry
// no session yet and so have nothing to check here; they are covered by the
// single allowed CORS origin and by SameSite on the cookie they go on to set.
function requireCsrf(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();
    if (!req.session) return next();

    const submitted = req.get('X-CSRF-Token') || (req.body && req.body.csrfToken);
    if (!tokensEqual(submitted, req.session.csrfToken)) {
        return res.status(403).json({ error: 'Missing or invalid CSRF token' });
    }
    next();
}


module.exports = {
    COOKIE_NAME,
    LIFETIME_MS,
    SLIDE_AFTER_MS,
    attach,
    require: require_,
    requireAdmin,
    requireCsrf,
    issue,
    revoke,
    revokeAll,
    setSessionCookie,
    clearSessionCookie,
    readCookie,
    hashToken,
    newToken,
    tokensEqual,
};
