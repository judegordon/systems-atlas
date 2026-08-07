//
// Rate limits, from the table in docs/ACCOUNTS.md.
//
// The two dimensions behave differently on purpose, because the same document
// asks for two different things:
//
//   Per IP       — a visible 429. An address is not an account, so refusing it
//                  out loud tells an attacker nothing it did not already know.
//
//   Per account  — never a visible refusal. "On repeated sign-in failure, delay
//                  the response rather than locking the account — locking is
//                  itself a denial-of-service vector." A per-account 429 would
//                  also be an enumeration oracle: it would answer "is this
//                  address registered?" for anyone willing to send four
//                  requests. So a per-account limit either delays the response
//                  (sign-in) or quietly declines to send the email (reset,
//                  resend) while returning the same 202 as always.
//
const pool = require('./db');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const LIMITS = {
    signup:        { ip: { max: 3,  window: HOUR } },
    signin:        { ip: { max: 10, window: HOUR }, account: { max: 5, window: HOUR } },
    reset:         { ip: { max: 3,  window: HOUR }, account: { max: 3, window: DAY } },
    verify_resend: { account: { max: 3, window: HOUR } },

    // docs/PROPOSALS.md §4. Only the per-IP half is here: the per-account limit
    // is counted off atlas.proposals in the route, because a proposal leaves a
    // row of its own and counting those is exact where counting attempts is not.
    propose:       { ip: { max: 20, window: DAY } },

    // docs/PROPOSALS.md §5: "Same rate limits and honeypot." Same shape as
    // propose, and the per-account half is counted off atlas.comments.
    comment:       { ip: { max: 20, window: DAY } },
};

async function record(action, { accountId = null, ip, succeeded = false }) {
    await pool.query(
        `INSERT INTO atlas.auth_attempts (account_id, ip, action, succeeded)
         VALUES ($1, $2, $3, $4)`,
        [accountId, ip, action, succeeded]
    );
    await pruneOccasionally();
}

async function countByIp(action, ip, windowMs) {
    const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM atlas.auth_attempts
          WHERE action = $1 AND ip = $2
            AND created_at > now() - ($3::bigint * interval '1 millisecond')`,
        [action, ip, windowMs]
    );
    return rows[0].n;
}

// Successful sign-ins are not counted. Someone signing in from a new device
// five times in an afternoon is not the thing being defended against, and
// counting them would delay the person the delay is meant to protect.
async function countFailuresByAccount(action, accountId, windowMs) {
    const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM atlas.auth_attempts
          WHERE action = $1 AND account_id = $2 AND succeeded = FALSE
            AND created_at > now() - ($3::bigint * interval '1 millisecond')`,
        [action, accountId, windowMs]
    );
    return rows[0].n;
}

// For reset and verify_resend, `succeeded` records that an email was actually
// sent. The per-account limit counts those rather than requests, so that being
// refused does not use up the allowance — otherwise three requests an hour
// would buy two emails, and someone hammering the endpoint for an address they
// do not own could spend its owner's budget for them.
async function countSuccessesByAccount(action, accountId, windowMs) {
    const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM atlas.auth_attempts
          WHERE action = $1 AND account_id = $2 AND succeeded = TRUE
            AND created_at > now() - ($3::bigint * interval '1 millisecond')`,
        [action, accountId, windowMs]
    );
    return rows[0].n;
}

// Returns true and answers the request when the IP is over its limit.
async function ipLimited(req, res, action) {
    const rule = LIMITS[action] && LIMITS[action].ip;
    if (!rule) return false;

    const used = await countByIp(action, req.ip, rule.window);
    if (used < rule.max) return false;

    res.set('Retry-After', String(Math.ceil(rule.window / 1000)));
    res.status(429).json({ error: 'Too many attempts. Try again later.' });
    return true;
}

async function accountLimited(action, accountId) {
    const rule = LIMITS[action] && LIMITS[action].account;
    if (!rule || !accountId) return false;
    return (await countSuccessesByAccount(action, accountId, rule.window)) >= rule.max;
}

// Doubling from a quarter second, capped at four. Long enough that scripted
// guessing stops being worth the wall-clock, short enough that a person who
// mistyped their password twice barely notices.
async function signinDelayMs(accountId) {
    if (!accountId) return 0;
    const failures = await countFailuresByAccount('signin', accountId, HOUR);
    if (failures === 0) return 0;
    return Math.min(250 * 2 ** (failures - 1), 4000);
}

function sleep(ms) {
    return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

// The table is a rolling window, so old rows can only slow it down. Pruned on
// roughly one write in fifty rather than on a timer, so there is no scheduler
// to own and nothing to go wrong while the process is asleep.
let pruning = false;
async function pruneOccasionally() {
    if (pruning || Math.random() > 0.02) return;
    pruning = true;
    try {
        await pool.query(
            `DELETE FROM atlas.auth_attempts WHERE created_at < now() - interval '30 days'`
        );
    } catch (err) {
        console.error('auth_attempts prune failed:', err.message);
    } finally {
        pruning = false;
    }
}

module.exports = {
    LIMITS,
    record,
    ipLimited,
    accountLimited,
    signinDelayMs,
    countByIp,
    countSuccessesByAccount,
    countFailuresByAccount,
    sleep,
};
