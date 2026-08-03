//
// "What to verify before calling it done" — docs/ACCOUNTS.md.
//
// One describe block per line of that list, in the order it is written, so the
// list and the tests can be read side by side.
//
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers');

before(async () => { await h.start(); });
after(async () => { await h.stop(); });
beforeEach(async () => { await h.reset(); });


describe('A suspended account cannot sign in, and an existing session stops working within one request', () => {
    test('an open session dies on the next request after suspension', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'suspended@example.com' });

        // Working before.
        const before_ = await c.get('/atlas/me');
        assert.equal(before_.status, 200);

        await h.pool.query(
            `UPDATE atlas.accounts
                SET suspended_at = now(), suspended_reason = 'Testing'
              WHERE email = 'suspended@example.com'`
        );

        // The very next request, with no sign-out and no expiry in between.
        const after_ = await c.get('/atlas/me');
        assert.equal(after_.status, 401);

        // And the browser is told to drop the cookie it is holding.
        assert.equal(c.cookies.has('atlas_session'), false);
    });

    test('a suspended account cannot sign in, and is told why', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'suspended2@example.com' });
        await h.pool.query(
            `UPDATE atlas.accounts
                SET suspended_at = now(), suspended_reason = 'Repeated bad faith'
              WHERE email = 'suspended2@example.com'`
        );

        const fresh = h.client();
        const signin = await fresh.post('/atlas/sessions', {
            email: 'suspended2@example.com',
            password: 'correct horse battery',
        });

        assert.equal(signin.status, 403);
        assert.equal(signin.data.reason, 'Repeated bad faith');
        assert.equal(fresh.cookies.has('atlas_session'), false);
    });

    test('a wrong password on a suspended account is refused as a wrong password', async () => {
        // Suspension is only named to someone who proved they own the account.
        const c = h.client();
        await h.signedUp(c, { email: 'suspended3@example.com' });
        await h.pool.query(
            `UPDATE atlas.accounts SET suspended_at = now(), suspended_reason = 'x'
              WHERE email = 'suspended3@example.com'`
        );

        const fresh = h.client();
        const signin = await fresh.post('/atlas/sessions', {
            email: 'suspended3@example.com',
            password: 'not the password',
        });

        assert.equal(signin.status, 401);
        assert.equal(signin.data.error, 'Incorrect email or password');
        assert.equal(signin.data.reason, undefined);
    });
});


describe('A used verification token cannot be used twice', () => {
    test('the second use is refused', async () => {
        const c = h.client();
        await c.post('/atlas/accounts', {
            email: 'verify@example.com',
            password: 'correct horse battery',
            displayName: 'Verifier',
        });

        const token = h.tokenFrom(h.mail.outbox.at(-1));

        const first = await c.post('/atlas/accounts/verify', { token });
        assert.equal(first.status, 200);
        assert.equal(first.data.verified, true);

        const second = await c.post('/atlas/accounts/verify', { token });
        assert.equal(second.status, 400);
        assert.match(second.data.error, /invalid, expired, or already used/);
    });

    test('two simultaneous uses of the same token yield exactly one success', async () => {
        // The single-use guarantee is one UPDATE with a WHERE clause, not a
        // read followed by a write, so a race cannot spend it twice.
        const c = h.client();
        await c.post('/atlas/accounts', {
            email: 'race@example.com',
            password: 'correct horse battery',
            displayName: 'Racer',
        });
        const token = h.tokenFrom(h.mail.outbox.at(-1));

        const results = await Promise.all([
            c.post('/atlas/accounts/verify', { token }),
            c.post('/atlas/accounts/verify', { token }),
            c.post('/atlas/accounts/verify', { token }),
        ]);

        assert.equal(results.filter((r) => r.status === 200).length, 1);
        assert.equal(results.filter((r) => r.status === 400).length, 2);
    });

    test('issuing a new verification token invalidates the previous one', async () => {
        const c = h.client();
        await c.post('/atlas/accounts', {
            email: 'resend@example.com',
            password: 'correct horse battery',
            displayName: 'Resender',
        });
        const first = h.tokenFrom(h.mail.outbox.at(-1));

        await c.post('/atlas/accounts/verify/resend', { email: 'resend@example.com' });
        const second = h.tokenFrom(h.mail.outbox.at(-1));
        assert.notEqual(first, second);

        assert.equal((await c.post('/atlas/accounts/verify', { token: first })).status, 400);
        assert.equal((await c.post('/atlas/accounts/verify', { token: second })).status, 200);
    });
});


describe('A reset token expires at one hour and cannot be replayed', () => {
    test('the expiry written to the database is one hour', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'reset@example.com' });

        await c.post('/atlas/passwords/reset', { email: 'reset@example.com' });

        const { rows } = await h.pool.query(
            `SELECT EXTRACT(EPOCH FROM (expires_at - created_at)) AS seconds
               FROM atlas.tokens WHERE kind = 'reset' ORDER BY id DESC LIMIT 1`
        );
        assert.equal(Math.round(Number(rows[0].seconds)), 3600);
    });

    test('a token one second past the hour is refused', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'expired@example.com' });
        await c.post('/atlas/passwords/reset', { email: 'expired@example.com' });
        const token = h.tokenFrom(h.mail.outbox.at(-1));

        // Wind the clock forward in the row rather than waiting an hour.
        await h.pool.query(
            `UPDATE atlas.tokens SET expires_at = now() - interval '1 second'
              WHERE kind = 'reset' AND used_at IS NULL`
        );

        const confirm = await c.post('/atlas/passwords/reset/confirm', {
            token,
            password: 'a brand new password',
        });
        assert.equal(confirm.status, 400);

        // And the old password still works, so nothing was half-applied.
        const fresh = h.client();
        const signin = await fresh.post('/atlas/sessions', {
            email: 'expired@example.com',
            password: 'correct horse battery',
        });
        assert.equal(signin.status, 201);
    });

    test('a token just inside the hour is accepted', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'justintime@example.com' });
        await c.post('/atlas/passwords/reset', { email: 'justintime@example.com' });
        const token = h.tokenFrom(h.mail.outbox.at(-1));

        await h.pool.query(
            `UPDATE atlas.tokens SET expires_at = now() + interval '1 second'
              WHERE kind = 'reset' AND used_at IS NULL`
        );

        const confirm = await c.post('/atlas/passwords/reset/confirm', {
            token,
            password: 'a brand new password',
        });
        assert.equal(confirm.status, 200);
    });

    test('a reset token cannot be replayed, and the first use revokes every session', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'replay@example.com' });

        // A second device, signed in on the same account.
        const other = h.client();
        await other.post('/atlas/sessions', {
            email: 'replay@example.com',
            password: 'correct horse battery',
        });
        assert.equal((await other.get('/atlas/me')).status, 200);

        await c.post('/atlas/passwords/reset', { email: 'replay@example.com' });
        const token = h.tokenFrom(h.mail.outbox.at(-1));

        const first = await c.post('/atlas/passwords/reset/confirm', {
            token,
            password: 'the replacement password',
        });
        assert.equal(first.status, 200);

        const second = await c.post('/atlas/passwords/reset/confirm', {
            token,
            password: 'a third password entirely',
        });
        assert.equal(second.status, 400);

        // The other device is signed out, which is the point of a reset.
        assert.equal((await other.get('/atlas/me')).status, 401);

        // The replacement password works; the third one was never applied.
        const fresh = h.client();
        assert.equal((await fresh.post('/atlas/sessions', {
            email: 'replay@example.com', password: 'the replacement password',
        })).status, 201);

        const alsoFresh = h.client();
        assert.equal((await alsoFresh.post('/atlas/sessions', {
            email: 'replay@example.com', password: 'a third password entirely',
        })).status, 401);
    });
});


describe('Withdrawal leaves published content attributed to Withdrawn and removes the email', () => {
    test('the row survives, the email and password are gone, the name is Withdrawn', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'withdraw@example.com', displayName: 'Someone Real' });

        const withdraw = await c.del('/atlas/me', { password: 'correct horse battery' });
        assert.equal(withdraw.status, 200);

        const { rows } = await h.pool.query(
            `SELECT id, email, password_hash, bio, display_name, is_admin, withdrawn_at
               FROM atlas.accounts`
        );

        // docs/ACCOUNTS.md: "DELETE FROM accounts is never issued."
        assert.equal(rows.length, 1);
        assert.equal(rows[0].email, null);
        assert.equal(rows[0].password_hash, null);
        assert.equal(rows[0].bio, null);
        assert.equal(rows[0].display_name, 'Withdrawn');
        assert.equal(rows[0].is_admin, false);
        assert.notEqual(rows[0].withdrawn_at, null);
    });

    test('withdrawal ends every session on the account', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'withdraw2@example.com' });

        const other = h.client();
        await other.post('/atlas/sessions', {
            email: 'withdraw2@example.com',
            password: 'correct horse battery',
        });

        await c.del('/atlas/me', { password: 'correct horse battery' });

        assert.equal((await c.get('/atlas/me')).status, 401);
        assert.equal((await other.get('/atlas/me')).status, 401);
    });

    test('a withdrawn account cannot sign in, and is indistinguishable from an unknown address', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'gone@example.com' });
        await c.del('/atlas/me', { password: 'correct horse battery' });

        const fresh = h.client();
        const withdrawn = await fresh.post('/atlas/sessions', {
            email: 'gone@example.com', password: 'correct horse battery',
        });
        const unknown = await fresh.post('/atlas/sessions', {
            email: 'never-existed@example.com', password: 'correct horse battery',
        });

        assert.equal(withdrawn.status, 401);
        assert.deepEqual(withdrawn.data, unknown.data);
    });

    test('withdrawal requires the password', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'withdraw3@example.com' });

        const wrong = await c.del('/atlas/me', { password: 'not the password' });
        assert.equal(wrong.status, 403);

        assert.equal((await c.get('/atlas/me')).status, 200);
    });

    test('the constraint refuses a half-withdrawn row', async () => {
        // The guarantee is in the database, not only in the endpoint: a row
        // cannot be marked withdrawn while it still carries an address.
        const c = h.client();
        await h.signedUp(c, { email: 'constraint@example.com' });

        await assert.rejects(
            () => h.pool.query(
                `UPDATE atlas.accounts SET withdrawn_at = now()
                  WHERE email = 'constraint@example.com'`
            ),
            (err) => err.code === '23514'
        );
    });
});


describe('Sign-up with an existing address returns exactly what sign-up with a new one returns', () => {
    test('status and body are identical, byte for byte', async () => {
        const c = h.client();

        const fresh = await c.post('/atlas/accounts', {
            email: 'taken@example.com',
            password: 'correct horse battery',
            displayName: 'First Person',
        });

        const repeat = await c.post('/atlas/accounts', {
            email: 'taken@example.com',
            password: 'a different password',
            displayName: 'Second Person',
        });

        const brandNew = await c.post('/atlas/accounts', {
            email: 'untaken@example.com',
            password: 'correct horse battery',
            displayName: 'Third Person',
        });

        assert.equal(fresh.status, 202);
        assert.equal(repeat.status, brandNew.status);
        assert.deepEqual(repeat.data, brandNew.data);
        assert.deepEqual(repeat.data, fresh.data);
    });

    test('the second sign-up does not overwrite the first account or send an email', async () => {
        const c = h.client();
        await c.post('/atlas/accounts', {
            email: 'taken2@example.com', password: 'correct horse battery', displayName: 'First Person',
        });
        h.mail.outbox.length = 0;

        await c.post('/atlas/accounts', {
            email: 'taken2@example.com', password: 'attacker password', displayName: 'Impostor',
        });

        assert.equal(h.mail.outbox.length, 0);

        const { rows } = await h.pool.query('SELECT display_name FROM atlas.accounts');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].display_name, 'First Person');
    });

    test('an address that is taken is not revealed by how long the answer takes', async () => {
        const c = h.client();
        await c.post('/atlas/accounts', {
            email: 'timing@example.com', password: 'correct horse battery', displayName: 'Timed',
        });

        const time = async (email) => {
            const started = process.hrtime.bigint();
            await c.post('/atlas/accounts', {
                email, password: 'correct horse battery', displayName: 'Timed',
            });
            return Number(process.hrtime.bigint() - started) / 1e6;
        };

        // bcrypt at cost 12 dominates both paths, which is the point: the
        // existing-address branch hashes a password it then throws away.
        const taken = await time('timing@example.com');
        const free = await time(`free-${Date.now()}@example.com`);

        const ratio = Math.max(taken, free) / Math.min(taken, free);
        assert.ok(ratio < 2, `sign-up timing differs by ${ratio.toFixed(2)}x (taken ${taken.toFixed(0)}ms, new ${free.toFixed(0)}ms)`);
    });

    test('password reset gives the same answer for a known and an unknown address', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'known@example.com' });

        const known = await c.post('/atlas/passwords/reset', { email: 'known@example.com' });
        const unknown = await c.post('/atlas/passwords/reset', { email: 'unknown@example.com' });

        assert.equal(known.status, 202);
        assert.equal(unknown.status, 202);
        assert.deepEqual(known.data, unknown.data);
    });

    test('sign-in gives one message for a wrong password and for an unknown address', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'oneMessage@example.com' });

        const fresh = h.client();
        const wrongPassword = await fresh.post('/atlas/sessions', {
            email: 'oneMessage@example.com', password: 'wrong',
        });
        const noSuchAccount = await fresh.post('/atlas/sessions', {
            email: 'nobody@example.com', password: 'wrong',
        });

        assert.equal(wrongPassword.status, noSuchAccount.status);
        assert.deepEqual(wrongPassword.data, noSuchAccount.data);
    });
});


describe('No endpoint returns a password hash, a token, or another account\'s email', () => {
    // Every response the API can produce for a signed-in caller, collected and
    // then searched as text. A field added later that leaks a hash fails this
    // without anyone having to remember to extend the test.
    test('no response body contains a hash, a session token, or a bcrypt prefix', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'leak@example.com', displayName: 'Leak Check' });

        await h.pool.query("UPDATE atlas.accounts SET is_admin = TRUE WHERE email = 'leak@example.com'");
        await c.post('/atlas/passwords/reset', { email: 'leak@example.com' });

        const bodies = [];
        bodies.push((await c.get('/atlas/me')).data);
        bodies.push((await c.patch('/atlas/me', { displayName: 'Renamed', bio: 'A bio' })).data);
        bodies.push((await c.get('/atlas/admin/ping')).data);
        bodies.push((await c.post('/atlas/me/password', {
            currentPassword: 'correct horse battery',
            newPassword: 'another good password',
        })).data);
        bodies.push((await c.post('/atlas/accounts', {
            email: 'other@example.com', password: 'correct horse battery', displayName: 'Other',
        })).data);
        bodies.push((await c.post('/atlas/accounts/verify', { token: 'nonsense' })).data);
        bodies.push((await c.del('/atlas/sessions/all')).data);

        const text = JSON.stringify(bodies);

        assert.doesNotMatch(text, /\$2[aby]\$/, 'a bcrypt hash appeared in a response');
        assert.doesNotMatch(text, /password_hash|passwordHash/, 'a password hash field appeared');
        assert.doesNotMatch(text, /token_hash|tokenHash/, 'a token hash field appeared');

        // The live reset token, which exists at this moment, must not be in any
        // of them. csrfToken is the one token that is deliberately returned.
        const resetToken = h.tokenFrom(h.mail.outbox.find((m) => /Reset/.test(m.subject)));
        assert.ok(!text.includes(resetToken), 'a reset token appeared in a response');
    });

    test('no endpoint returns another account\'s email', async () => {
        const a = h.client();
        await h.signedUp(a, { email: 'first@example.com', displayName: 'First' });

        const b = h.client();
        await h.signedUp(b, { email: 'second@example.com', displayName: 'Second' });

        const bodies = JSON.stringify([
            (await b.get('/atlas/me')).data,
            (await b.patch('/atlas/me', { bio: 'Trying' })).data,
            (await b.get('/atlas/admin/ping')).data,
        ]);

        assert.ok(!bodies.includes('first@example.com'), 'another account\'s email leaked');
        assert.ok(bodies.includes('second@example.com'), 'the caller\'s own email should be returned');
    });

    test('the session cookie carries no readable claim', async () => {
        // The point of opaque tokens: the cookie says nothing about who it is.
        const c = h.client();
        await h.signedUp(c, { email: 'opaque@example.com', displayName: 'Opaque' });

        const cookie = c.cookies.get('atlas_session');
        assert.ok(cookie);
        assert.match(cookie, /^[A-Za-z0-9_-]+$/);
        assert.equal(cookie.split('.').length, 1, 'the cookie looks like a JWT');

        const decoded = Buffer.from(cookie, 'base64url').toString('latin1');
        assert.ok(!decoded.includes('opaque@example.com'));
        assert.ok(!decoded.includes('Opaque'));
    });

    test('the stored session token is a hash, not the token', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'stored@example.com' });

        const cookie = c.cookies.get('atlas_session');
        const { rows } = await h.pool.query('SELECT token_hash FROM atlas.sessions');

        assert.equal(rows.length, 1);
        assert.notEqual(rows[0].token_hash, cookie);
        assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
    });

    test('the stored verification token is a hash, not the token', async () => {
        const c = h.client();
        await c.post('/atlas/accounts', {
            email: 'hashed@example.com', password: 'correct horse battery', displayName: 'Hashed',
        });
        const token = h.tokenFrom(h.mail.outbox.at(-1));

        const { rows } = await h.pool.query('SELECT token_hash FROM atlas.tokens');
        assert.equal(rows.length, 1);
        assert.notEqual(rows[0].token_hash, token);
        assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
    });
});
