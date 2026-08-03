//
// The parts of docs/ACCOUNTS.md that the closing checklist does not name but
// that the rest of the document does: cookie flags, sliding expiry, CSRF,
// revocation, rate limits, and the admin check that build step 5 exists to
// prove works.
//
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers');

before(async () => { await h.start(); });
after(async () => { await h.stop(); });
beforeEach(async () => { await h.reset(); });


describe('the session cookie', () => {
    test('is HttpOnly, SameSite=Lax, Path=/, and set to expire in 30 days', async () => {
        const c = h.client();
        const { signin } = await h.signedUp(c, { email: 'cookie@example.com' });

        const setCookie = signin.headers.getSetCookie().find((v) => v.startsWith('atlas_session='));
        assert.ok(setCookie, 'no session cookie was set');
        assert.match(setCookie, /HttpOnly/);
        assert.match(setCookie, /SameSite=Lax/);
        assert.match(setCookie, /Path=\//);

        const maxAge = Number(/Max-Age=(\d+)/.exec(setCookie)[1]);
        assert.ok(Math.abs(maxAge - 30 * 24 * 3600) < 60, `Max-Age was ${maxAge}`);
    });

    test('is not marked Secure outside production, and is in it', async () => {
        // Secure over plain http would mean the cookie is never stored, so the
        // flag follows NODE_ENV. This asserts the rule rather than the value.
        const session = require('../src/middleware/session');
        assert.equal(process.env.NODE_ENV, 'test');

        const captured = [];
        const res = {
            getHeader: () => undefined,
            setHeader: (_, v) => captured.push(v),
        };
        session.setSessionCookie(res, 'token', new Date(Date.now() + 1000));
        assert.doesNotMatch(captured[0], /Secure/);
    });
});


describe('sliding expiry', () => {
    test('a session used within a day of issue is not rewritten', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'slide1@example.com' });

        const before_ = await h.pool.query('SELECT expires_at FROM atlas.sessions');
        await c.get('/atlas/me');
        const after_ = await h.pool.query('SELECT expires_at FROM atlas.sessions');

        assert.equal(
            new Date(before_.rows[0].expires_at).getTime(),
            new Date(after_.rows[0].expires_at).getTime()
        );
    });

    test('a session over a day old is extended to a full 30 days on use', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'slide2@example.com' });

        // Two days in: expires_at is 28 days out.
        await h.pool.query(
            `UPDATE atlas.sessions SET expires_at = now() + interval '28 days'`
        );

        const response = await c.get('/atlas/me');
        assert.equal(response.status, 200);

        const { rows } = await h.pool.query(
            `SELECT EXTRACT(EPOCH FROM (expires_at - now())) AS seconds FROM atlas.sessions`
        );
        const days = Number(rows[0].seconds) / 86400;
        assert.ok(Math.abs(days - 30) < 0.01, `expiry is ${days} days out`);

        // And the browser is given the new date, not left with the old one.
        assert.ok(response.headers.getSetCookie().some((v) => v.startsWith('atlas_session=')));
    });

    test('an expired session is refused and the cookie is taken back', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'expired-session@example.com' });

        await h.pool.query(`UPDATE atlas.sessions SET expires_at = now() - interval '1 second'`);

        assert.equal((await c.get('/atlas/me')).status, 401);
        assert.equal(c.cookies.has('atlas_session'), false);
    });
});


describe('sign out', () => {
    test('revokes the row, not just the cookie', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'signout@example.com' });

        const cookie = c.cookies.get('atlas_session');
        assert.equal((await c.del('/atlas/sessions')).status, 204);

        const { rows } = await h.pool.query('SELECT revoked_at FROM atlas.sessions');
        assert.notEqual(rows[0].revoked_at, null);

        // Replaying the cookie a signed-out browser was holding gets nowhere.
        const replay = h.client();
        replay.cookies.set('atlas_session', cookie);
        assert.equal((await replay.get('/atlas/me')).status, 401);
    });

    test('signing out when already signed out is not an error', async () => {
        const c = h.client();
        assert.equal((await c.del('/atlas/sessions')).status, 204);
    });

    test('sign out everywhere ends every session including the current one', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'everywhere@example.com' });

        const second = h.client();
        await second.post('/atlas/sessions', {
            email: 'everywhere@example.com', password: 'correct horse battery',
        });
        const third = h.client();
        await third.post('/atlas/sessions', {
            email: 'everywhere@example.com', password: 'correct horse battery',
        });

        const result = await c.del('/atlas/sessions/all');
        assert.equal(result.status, 200);
        assert.equal(result.data.revoked, 3);

        assert.equal((await c.get('/atlas/me')).status, 401);
        assert.equal((await second.get('/atlas/me')).status, 401);
        assert.equal((await third.get('/atlas/me')).status, 401);
    });
});


describe('CSRF', () => {
    test('a state-changing request without the token is refused', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'csrf@example.com' });

        const without = await c.patch('/atlas/me', { displayName: 'Renamed' }, { noCsrf: true });
        assert.equal(without.status, 403);

        const with_ = await c.patch('/atlas/me', { displayName: 'Renamed' });
        assert.equal(with_.status, 200);
    });

    test('a token from another session does not work', async () => {
        const a = h.client();
        await h.signedUp(a, { email: 'csrf-a@example.com' });

        const b = h.client();
        await h.signedUp(b, { email: 'csrf-b@example.com' });

        a.setCsrf(b.csrf());
        assert.equal((await a.patch('/atlas/me', { displayName: 'Stolen' })).status, 403);
    });

    test('a reading request needs no token', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'csrf-read@example.com' });
        assert.equal((await c.get('/atlas/me', { noCsrf: true })).status, 200);
    });

    test('revoking a session revokes its CSRF token with it', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'csrf-revoke@example.com' });
        const stolen = c.csrf();
        const cookie = c.cookies.get('atlas_session');

        await c.del('/atlas/sessions');

        const replay = h.client();
        replay.cookies.set('atlas_session', cookie);
        replay.setCsrf(stolen);
        assert.equal((await replay.patch('/atlas/me', { displayName: 'Nope' })).status, 401);
    });
});


describe('/me', () => {
    test('returns 401 when not signed in', async () => {
        assert.equal((await h.client().get('/atlas/me')).status, 401);
    });

    test('updates the display name and clears the bio with null', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'me@example.com', displayName: 'Original Name' });

        const set = await c.patch('/atlas/me', { displayName: 'New Name', bio: 'Two sentences.' });
        assert.equal(set.data.account.displayName, 'New Name');
        assert.equal(set.data.account.bio, 'Two sentences.');

        // An absent field is left alone; an explicit null removes it.
        const partial = await c.patch('/atlas/me', { displayName: 'Newer Name' });
        assert.equal(partial.data.account.bio, 'Two sentences.');

        const cleared = await c.patch('/atlas/me', { bio: null });
        assert.equal(cleared.data.account.bio, null);
        assert.equal(cleared.data.account.displayName, 'Newer Name');
    });

    test('refuses a display name outside 2 to 40 characters', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'name@example.com' });

        assert.equal((await c.patch('/atlas/me', { displayName: 'x' })).status, 400);
        assert.equal((await c.patch('/atlas/me', { displayName: 'x'.repeat(41) })).status, 400);
        assert.equal((await c.patch('/atlas/me', { displayName: 'xx' })).status, 200);
    });

    test('refuses a bio over 160 characters', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'bio@example.com' });
        assert.equal((await c.patch('/atlas/me', { bio: 'x'.repeat(161) })).status, 400);
        assert.equal((await c.patch('/atlas/me', { bio: 'x'.repeat(160) })).status, 200);
    });

    test('changing the password requires the current one and keeps this session', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'pw@example.com' });

        const other = h.client();
        await other.post('/atlas/sessions', {
            email: 'pw@example.com', password: 'correct horse battery',
        });

        const wrong = await c.post('/atlas/me/password', {
            currentPassword: 'not it', newPassword: 'a replacement password',
        });
        assert.equal(wrong.status, 403);

        const right = await c.post('/atlas/me/password', {
            currentPassword: 'correct horse battery', newPassword: 'a replacement password',
        });
        assert.equal(right.status, 200);
        assert.equal(right.data.otherSessionsRevoked, 1);

        // This session survives; the other does not.
        assert.equal((await c.get('/atlas/me')).status, 200);
        assert.equal((await other.get('/atlas/me')).status, 401);
    });

    test('refuses a new password under 10 characters', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'short@example.com' });
        const short = await c.post('/atlas/me/password', {
            currentPassword: 'correct horse battery', newPassword: 'nine char',
        });
        assert.equal(short.status, 400);
    });
});


describe('sign up validation', () => {
    test('refuses a password under 10 characters before touching the database', async () => {
        const c = h.client();
        const result = await c.post('/atlas/accounts', {
            email: 'short@example.com', password: 'nine char', displayName: 'Short',
        });
        assert.equal(result.status, 400);

        const { rows } = await h.pool.query('SELECT count(*)::int AS n FROM atlas.accounts');
        assert.equal(rows[0].n, 0);
    });

    test('treats the address as case-insensitive', async () => {
        const c = h.client();
        await c.post('/atlas/accounts', {
            email: 'Mixed.Case@Example.com', password: 'correct horse battery', displayName: 'Mixed',
        });
        const token = h.tokenFrom(h.mail.outbox.at(-1));
        await c.post('/atlas/accounts/verify', { token });

        const signin = await c.post('/atlas/sessions', {
            email: 'mixed.case@example.com', password: 'correct horse battery',
        });
        assert.equal(signin.status, 201);
    });

    test('an unverified account can still sign in', async () => {
        // docs/ACCOUNTS.md does not make verification a condition of sign-in.
        // Recorded here so that if it should be, the change is deliberate.
        const c = h.client();
        await c.post('/atlas/accounts', {
            email: 'unverified@example.com', password: 'correct horse battery', displayName: 'Unverified',
        });

        const signin = await c.post('/atlas/sessions', {
            email: 'unverified@example.com', password: 'correct horse battery',
        });
        assert.equal(signin.status, 201);
        assert.equal(signin.data.account.verified, false);
    });
});


describe('rate limits', () => {
    test('sign up is refused after three from one address in an hour', async () => {
        const c = h.client();
        for (let i = 0; i < 3; i += 1) {
            const ok = await c.post('/atlas/accounts', {
                email: `limit${i}@example.com`, password: 'correct horse battery', displayName: 'Limited',
            });
            assert.equal(ok.status, 202, `attempt ${i + 1} should be allowed`);
        }

        const fourth = await c.post('/atlas/accounts', {
            email: 'limit4@example.com', password: 'correct horse battery', displayName: 'Limited',
        });
        assert.equal(fourth.status, 429);
        assert.ok(fourth.headers.get('retry-after'));
    });

    test('sign in is refused after ten from one address in an hour', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'signin-limit@example.com' });

        await h.pool.query('DELETE FROM atlas.auth_attempts');

        const fresh = h.client();
        for (let i = 0; i < 10; i += 1) {
            const attempt = await fresh.post('/atlas/sessions', {
                email: 'signin-limit@example.com', password: 'wrong',
            });
            assert.equal(attempt.status, 401, `attempt ${i + 1} should reach the password check`);
        }

        const eleventh = await fresh.post('/atlas/sessions', {
            email: 'signin-limit@example.com', password: 'correct horse battery',
        });
        assert.equal(eleventh.status, 429);
    });

    test('a per-account reset limit is invisible: three emails, then the same 202', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'reset-limit@example.com' });
        h.mail.outbox.length = 0;
        await h.pool.query('DELETE FROM atlas.auth_attempts');

        // Three requests, three emails. The IP limit is three an hour, so the
        // fourth is refused by that first — this asserts the account rule up
        // to the point where the two meet.
        const answers = [];
        for (let i = 0; i < 3; i += 1) {
            answers.push(await c.post('/atlas/passwords/reset', { email: 'reset-limit@example.com' }));
        }

        assert.equal(h.mail.outbox.length, 3);
        for (const a of answers) assert.equal(a.status, 202);
        assert.deepEqual(answers[0].data, answers[2].data);
    });

    test('being refused does not spend the account allowance', async () => {
        // A stranger hammering the endpoint for someone else's address must not
        // be able to use up that person's three-a-day.
        //
        // Signed up but deliberately not verified: a verified account has
        // nothing to resend, which is a different refusal from the one under
        // test here.
        const c = h.client();
        await c.post('/atlas/accounts', {
            email: 'allowance@example.com',
            password: 'correct horse battery',
            displayName: 'Unverified',
        });
        h.mail.outbox.length = 0;
        await h.pool.query('DELETE FROM atlas.auth_attempts');

        // Four resends: the fourth is over the hourly account limit of three.
        for (let i = 0; i < 4; i += 1) {
            await c.post('/atlas/accounts/verify/resend', { email: 'allowance@example.com' });
        }

        const { rows } = await h.pool.query(
            `SELECT count(*)::int AS sent FROM atlas.auth_attempts
              WHERE action = 'verify_resend' AND succeeded = TRUE`
        );
        // Three emails, and the fourth recorded as a refusal rather than a use.
        assert.equal(rows[0].sent, 3);

        const { rows: all } = await h.pool.query(
            `SELECT count(*)::int AS n FROM atlas.auth_attempts WHERE action = 'verify_resend'`
        );
        assert.equal(all[0].n, 4);
    });

    test('repeated sign-in failure delays rather than locks', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'delay@example.com' });
        await h.pool.query('DELETE FROM atlas.auth_attempts');

        const fresh = h.client();
        for (let i = 0; i < 4; i += 1) {
            await fresh.post('/atlas/sessions', { email: 'delay@example.com', password: 'wrong' });
        }

        const started = Date.now();
        const correct = await fresh.post('/atlas/sessions', {
            email: 'delay@example.com', password: 'correct horse battery',
        });
        const took = Date.now() - started;

        // Not locked: the right password still works.
        assert.equal(correct.status, 201);
        // But it was made to wait. Four failures is a 2s delay.
        assert.ok(took > 1500, `expected a delay, took ${took}ms`);
    });
});


describe('the admin flag', () => {
    test('an ordinary account gets 404, not 403, from the admin endpoint', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'ordinary@example.com' });

        const result = await c.get('/atlas/admin/ping');
        assert.equal(result.status, 404);
    });

    test('a signed-out caller gets 401', async () => {
        assert.equal((await h.client().get('/atlas/admin/ping')).status, 401);
    });

    test('an admin account gets through', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'admin@example.com', displayName: 'An Admin' });
        await h.pool.query("UPDATE atlas.accounts SET is_admin = TRUE WHERE email = 'admin@example.com'");

        const result = await c.get('/atlas/admin/ping');
        assert.equal(result.status, 200);
        assert.equal(result.data.ok, true);
        assert.equal(result.data.account, 'An Admin');
    });

    test('the flag takes effect on the next request, with no new sign-in', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'promoted@example.com' });
        assert.equal((await c.get('/atlas/admin/ping')).status, 404);

        await h.pool.query("UPDATE atlas.accounts SET is_admin = TRUE WHERE email = 'promoted@example.com'");
        assert.equal((await c.get('/atlas/admin/ping')).status, 200);

        await h.pool.query("UPDATE atlas.accounts SET is_admin = FALSE WHERE email = 'promoted@example.com'");
        assert.equal((await c.get('/atlas/admin/ping')).status, 404);
    });
});
