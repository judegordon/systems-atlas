//
// Test harness. Runs against a real Postgres, because every guarantee worth
// checking here — single-use tokens, expiry, cascade, the check constraint on
// withdrawal — lives in the database and a mock would only restate what the
// test already assumes.
//
process.env.NODE_ENV = 'test';
process.env.MAIL_TRANSPORT = 'log';
process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL || 'postgres://localhost/atlas_test';
process.env.SITE_ORIGIN = 'http://localhost:8788';

const { execFileSync } = require('child_process');
const path = require('path');

const app = require('../server');
const pool = require('../src/db');
const mail = require('../src/mail');
const deferred = require('../src/deferred');

let server;
let base;

async function start() {
    execFileSync('node', [path.join(__dirname, '..', 'scripts', 'migrate.js')], {
        stdio: 'pipe',
        env: process.env,
    });

    await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
    return base;
}

async function stop() {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.end();
}

// Between tests. TRUNCATE rather than DELETE so the sequences restart and an
// id from one test cannot be mistaken for an id from another.
async function reset() {
    await pool.query(
        'TRUNCATE atlas.accounts, atlas.tokens, atlas.sessions, atlas.auth_attempts RESTART IDENTITY CASCADE'
    );
    mail.outbox.length = 0;
}

// A client with its own cookie jar, so two of them are two browsers.
function client() {
    const cookies = new Map();
    let csrf = null;

    async function send(method, path, body, options = {}) {
        const headers = {};
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (cookies.size) {
            headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
        }
        if (csrf && method !== 'GET' && !options.noCsrf) headers['X-CSRF-Token'] = csrf;
        if (options.headers) Object.assign(headers, options.headers);

        // Timed around the fetch alone. What an attacker with a stopwatch can
        // measure is the response, not what the server does afterwards, so this
        // is the number the enumeration test has to assert on.
        const startedAt = process.hrtime.bigint();
        const response = await fetch(base + path, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

        for (const raw of response.headers.getSetCookie()) {
            const [pair] = raw.split(';');
            const eq = pair.indexOf('=');
            const name = pair.slice(0, eq).trim();
            const value = pair.slice(eq + 1).trim();
            // An expiry in the past is the server taking the cookie back.
            if (value === '' || /Max-Age=0/i.test(raw)) cookies.delete(name);
            else cookies.set(name, value);
        }

        let data = {};
        if (response.status !== 204) {
            const text = await response.text();
            try {
                data = JSON.parse(text);
            } catch {
                data = { raw: text };
            }
        }
        if (data && data.csrfToken) csrf = data.csrfToken;

        // Sign-up and password reset send their mail after the response, so
        // that the response time does not disclose whether the address exists.
        // A test reading the outbox would otherwise race the send. Waiting here
        // rather than in each test keeps that detail out of the assertions;
        // `elapsedMs` was taken before it and is unaffected.
        await deferred.settled();

        return { status: response.status, data, headers: response.headers, elapsedMs };
    }

    return {
        get: (p, o) => send('GET', p, undefined, o),
        post: (p, b, o) => send('POST', p, b, o),
        patch: (p, b, o) => send('PATCH', p, b, o),
        del: (p, b, o) => send('DELETE', p, b, o),
        cookies,
        csrf: () => csrf,
        setCsrf: (v) => { csrf = v; },
        clearCookies: () => cookies.clear(),
    };
}

// Sign-up, verify, sign in. Returns a signed-in client and the account id.
async function signedUp(c, { email, password = 'correct horse battery', displayName = 'A Contributor' } = {}) {
    await c.post('/atlas/accounts', { email, password, displayName });

    const link = mail.outbox.at(-1).link;
    const token = new URL(link).searchParams.get('token');
    await c.post('/atlas/accounts/verify', { token });

    const signin = await c.post('/atlas/sessions', { email, password });
    return { signin, accountId: signin.data.account && signin.data.account.id };
}

function tokenFrom(entry) {
    return new URL(entry.link).searchParams.get('token');
}

module.exports = { start, stop, reset, client, signedUp, tokenFrom, pool, mail };
