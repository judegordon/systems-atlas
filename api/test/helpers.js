//
// Test harness. Runs against a real Postgres, because every guarantee worth
// checking here — single-use tokens, expiry, cascade, the check constraint on
// withdrawal — lives in the database and a mock would only restate what the
// test already assumes.
//
// That Postgres is `atlas_test` on the `Postgres-6dNn` Railway service, which
// has a public TCP proxy. There is no default — see below.
//
//     TEST_DATABASE_URL=postgres://postgres:PASSWORD@HOST:PORT/atlas_test npm test
//
// It used to have no public URL and was reached through
// `railway connect Postgres-6dNn --tunnel-only`, which still works and is still
// accepted. The tunnel was dropped roughly every five minutes and the suite
// takes longer than that, so no single run could finish; the proxy is what
// makes one run possible.
//
// `reset()` truncates every table it names, so a suite aimed at the wrong
// database destroys it. assertTestDatabase() is what stands between a mistyped
// host and the production accounts table.
//

// So that TEST_DATABASE_URL can live in api/.env rather than on the command
// line, where the tunnel's password would end up in shell history. This has to
// run before the guard below. dotenv never overrides a variable that is already
// set, so `TEST_DATABASE_URL=... npm test` still wins over the file.
require('dotenv').config({ quiet: true });

const REQUIRED_DATABASE = 'atlas_test';

// The database name carries almost all of the weight, and deliberately.
//
// Both Railway Postgres services answer as user `postgres` on a database named
// `railway`, so the credentials cannot tell them apart. The host used to help,
// because the test instance was reachable only through a tunnel and so always
// on loopback — that check is gone now that it has a public proxy, and this is
// what is left:
//
//   - the database must be `atlas_test`, and production has no such database,
//     so a run misdirected at it fails to connect rather than truncating the
//     accounts table;
//   - production's two hostnames are refused by name, so the failure says which
//     mistake was made rather than only that the database was wrong;
//   - and start() asks the server it actually reached what database it is,
//     before migrating, which is the check no connection string can talk its
//     way past.
//
// What was traded away: a string that is wrong in a way none of these three
// catch would now be attempted rather than refused outright. Keeping
// `atlas_test` off the production instance is what keeps that from mattering.
const PRODUCTION_HOSTS = new Set([
    'postgres.railway.internal',
    'tokaido.proxy.rlwy.net',
]);

function assertTestDatabase(raw) {
    const how =
        'Set TEST_DATABASE_URL to the atlas_test database on Postgres-6dNn — ' +
        '`railway variables --service Postgres-6dNn` has the host and password.';

    if (!raw) {
        // Deliberately no default. The old one was postgres://localhost/atlas_test,
        // which quietly resolved to whatever Postgres happened to be on 5432.
        throw new Error(`TEST_DATABASE_URL is not set. ${how}`);
    }

    let url;
    try {
        url = new URL(raw);
    } catch {
        throw new Error(`TEST_DATABASE_URL is not a URL. ${how}`);
    }

    const host = url.hostname;
    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));

    if (PRODUCTION_HOSTS.has(host)) {
        throw new Error(`Refusing to run: ${host} is the production Postgres. ${how}`);
    }
    if (database !== REQUIRED_DATABASE) {
        throw new Error(
            `Refusing to run: TEST_DATABASE_URL names database ` +
            `"${database || '(none)'}", not "${REQUIRED_DATABASE}". ` +
            `This suite truncates every table it finds. ${how}`
        );
    }

    return raw;
}

process.env.NODE_ENV = 'test';
process.env.MAIL_TRANSPORT = 'log';
process.env.DATABASE_URL = assertTestDatabase(process.env.TEST_DATABASE_URL);
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
    // The string was checked before the pool was built. This checks the server
    // the pool actually reached, which is the only answer that cannot be wrong:
    // a tunnel forwarded to the wrong service, or a PG* variable overriding the
    // database, would both get past the parse above and are caught here. It
    // runs before migrate.js, so a misdirected run creates nothing either.
    const { rows } = await pool.query('SELECT current_database() AS name');
    if (rows[0].name !== REQUIRED_DATABASE) {
        await pool.end();
        throw new Error(
            `Refusing to run: connected to database "${rows[0].name}", not ` +
            `"${REQUIRED_DATABASE}". Check which service TEST_DATABASE_URL reaches, ` +
            `and whether a PG* variable is overriding the database it names.`
        );
    }

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
        'TRUNCATE atlas.accounts, atlas.tokens, atlas.sessions, atlas.auth_attempts, atlas.proposals, atlas.comments RESTART IDENTITY CASCADE'
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
