//
// docs/PROPOSALS.md §4, for the one type build step 2 opens: `break`.
//
// The twenty-second minimum in that section would make every success case here
// take twenty seconds. Rather than wait, or reach in and shorten the rule for
// the tests, these mint a token dated far enough in the past — which is exactly
// what the rule is checking and is the honest way to satisfy it.
//
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers');
const proposals = require('../src/proposals');

before(async () => { await h.start(); });
after(async () => { await h.stop(); });
beforeEach(async () => { await h.reset(); });

// A node that exists in the committed atlas manifest.
const NODE = 'human-biological/nervous-system';

function agedToken(secondsAgo = 30) {
    return proposals.issueFormToken(Date.now() - secondsAgo * 1000);
}

function aBreak(over = {}) {
    return {
        type: 'break',
        nodePath: NODE,
        case: 'A neuroendocrine cell releasing a hormone in response to a nerve impulse.',
        body: 'It is signalling and it is secretion at once. Nervous system excludes '
            + 'hormonal signalling, and there is no endocrine system in the atlas to '
            + 'exclude it to, so the case falls out of the division entirely.',
        sources: [],
        displayAs: 'name',
        formToken: agedToken(),
        website: '',
        ...over,
    };
}

// A signed-in, verified account.
async function contributor(email) {
    const c = h.client();
    await h.signedUp(c, { email });
    return c;
}


describe('who may submit', () => {
    test('a signed-out caller gets 401', async () => {
        const c = h.client();
        const r = await c.post('/atlas/proposals', aBreak());
        assert.equal(r.status, 401);
    });

    test('an unverified account is refused, and told the one thing to do', async () => {
        const c = h.client();
        await c.post('/atlas/accounts', {
            email: 'unverified@example.com',
            password: 'correct horse battery',
            displayName: 'Not Yet',
        });
        // Signing in works without verification; submitting does not.
        const signin = await c.post('/atlas/sessions', {
            email: 'unverified@example.com',
            password: 'correct horse battery',
        });
        assert.equal(signin.status, 201);

        const r = await c.post('/atlas/proposals', aBreak());
        assert.equal(r.status, 403);
        assert.match(r.data.error, /verify/i);
    });

    test('a verified account submits, and gets the proposal back', async () => {
        const c = await contributor('breaker@example.com');
        const r = await c.post('/atlas/proposals', aBreak());

        assert.equal(r.status, 201);
        assert.equal(r.data.proposal.type, 'break');
        assert.equal(r.data.proposal.nodePath, NODE);
        assert.equal(r.data.proposal.status, 'pending');
    });

    test('a state-changing submit without the CSRF token is refused', async () => {
        const c = await contributor('csrf@example.com');
        const r = await c.post('/atlas/proposals', aBreak(), { noCsrf: true });
        assert.equal(r.status, 403);
    });
});


describe('what is stored', () => {
    test('the case goes in payload, the argument in body, sources in sources', async () => {
        const c = await contributor('stored@example.com');
        const sent = aBreak({ sources: ['Kandel, Principles of Neural Science', '  '] });
        await c.post('/atlas/proposals', sent);

        const { rows } = await h.pool.query(
            'SELECT node_path, type, display_as, body, payload, sources, status, decision_reason, decided_at FROM atlas.proposals'
        );
        assert.equal(rows.length, 1);
        const row = rows[0];

        assert.equal(row.node_path, NODE);
        assert.equal(row.type, 'break');
        assert.equal(row.display_as, 'name');
        assert.equal(row.body, sent.body);
        assert.equal(row.payload.case, sent.case);

        // Blank lines dropped rather than stored as empty citations.
        assert.deepEqual(row.sources, ['Kandel, Principles of Neural Science']);

        // Pending means undecided, and the constraint says so.
        assert.equal(row.status, 'pending');
        assert.equal(row.decision_reason, null);
        assert.equal(row.decided_at, null);
    });

    test('anonymous is recorded on the submission, not on the account', async () => {
        const c = await contributor('anon@example.com');
        await c.post('/atlas/proposals', aBreak({ displayAs: 'anonymous' }));

        const { rows } = await h.pool.query(
            'SELECT p.display_as, p.account_id, a.email FROM atlas.proposals p '
            + 'JOIN atlas.accounts a ON a.id = p.account_id'
        );
        assert.equal(rows[0].display_as, 'anonymous');
        // §3: "The account behind it is never exposed publicly. You can always
        // see it." The row still knows who wrote it.
        assert.equal(rows[0].email, 'anon@example.com');
    });

    test('a decision without a reason cannot be written', async () => {
        const c = await contributor('constraint@example.com');
        await c.post('/atlas/proposals', aBreak());

        await assert.rejects(
            () => h.pool.query("UPDATE atlas.proposals SET status = 'rejected'"),
            /proposals_decision_has_reason/
        );
    });
});


describe('the fields', () => {
    test('a node that is not in the atlas is refused', async () => {
        const c = await contributor('badnode@example.com');
        const r = await c.post('/atlas/proposals', aBreak({ nodePath: 'invented/node' }));
        assert.equal(r.status, 400);
        assert.match(r.data.error, /not in the atlas/i);
    });

    test('every domain in the manifest resolves', async () => {
        // The manifest is generated from atlas/ and committed. If it drifts,
        // this is the test that says so rather than a contributor's refusal.
        for (const domain of ['human-biological', 'legal', 'meta', 'academic']) {
            assert.equal(proposals.knownNodePath(domain), true, `${domain} missing`);
        }
        assert.ok(proposals.pathCount > 100, `only ${proposals.pathCount} paths`);
    });

    test('an argument over 4000 characters is refused', async () => {
        const c = await contributor('long@example.com');
        const r = await c.post('/atlas/proposals', aBreak({ body: 'x'.repeat(4001) }));
        assert.equal(r.status, 400);
        assert.match(r.data.error, /4000/);
    });

    test('an empty case is refused', async () => {
        const c = await contributor('nocase@example.com');
        const r = await c.post('/atlas/proposals', aBreak({ case: '   ' }));
        assert.equal(r.status, 400);
    });

    test('no sources is allowed — a case nobody wrote up is still a case', async () => {
        const c = await contributor('nosources@example.com');
        const r = await c.post('/atlas/proposals', aBreak({ sources: [] }));
        assert.equal(r.status, 201);
    });

    test('a display_as the schema does not know is refused', async () => {
        const c = await contributor('display@example.com');
        const r = await c.post('/atlas/proposals', aBreak({ displayAs: 'pseudonym' }));
        assert.equal(r.status, 400);
    });
});


describe('the types that are not built yet', () => {
    test('subdivide is open as of step 5, and refused only on its own payload', async () => {
        const c = await contributor('subdivide@example.com');
        // The break payload carries no `children`, so this is refused for the
        // reason a subdivide is refused — not for being a type nobody built.
        const r = await c.post('/atlas/proposals', aBreak({ type: 'subdivide' }));
        assert.equal(r.status, 400);
        assert.doesNotMatch(r.data.error, /only break/i);
        assert.match(r.data.error, /components/i);
    });

    test('a type that is not in the document at all is refused as unknown', async () => {
        const c = await contributor('unknown@example.com');
        const r = await c.post('/atlas/proposals', aBreak({ type: 'rewrite' }));
        assert.equal(r.status, 400);
        assert.match(r.data.error, /unknown/i);
    });
});


describe('the honeypot and the clock', () => {
    test('a filled honeypot is accepted out loud and stored nowhere', async () => {
        const c = await contributor('bot@example.com');
        const r = await c.post('/atlas/proposals', aBreak({ website: 'http://example.com' }));

        // 202 rather than 400: telling a bot which check it failed is how the
        // next version of it passes.
        assert.equal(r.status, 202);
        const { rows } = await h.pool.query('SELECT count(*)::int AS n FROM atlas.proposals');
        assert.equal(rows[0].n, 0);
    });

    test('a form submitted inside twenty seconds is refused', async () => {
        const c = await contributor('fast@example.com');
        const r = await c.post('/atlas/proposals', aBreak({ formToken: agedToken(2) }));
        assert.equal(r.status, 400);
        assert.match(r.data.error, /moment longer/i);
    });

    test('a forged form token is refused', async () => {
        const c = await contributor('forger@example.com');
        const forged = `${Date.now() - 60000}.${'0'.repeat(64)}`;
        const r = await c.post('/atlas/proposals', aBreak({ formToken: forged }));
        assert.equal(r.status, 400);
        assert.match(r.data.error, /expired/i);
    });

    test('a token older than a day is refused', async () => {
        const c = await contributor('stale@example.com');
        const r = await c.post('/atlas/proposals', aBreak({ formToken: agedToken(25 * 3600) }));
        assert.equal(r.status, 400);
        assert.match(r.data.error, /expired/i);
    });

    test('the issued token satisfies the rule once the time has passed', async () => {
        const c = await contributor('issued@example.com');
        const issued = await c.get('/atlas/proposals/new');
        assert.equal(issued.status, 200);
        assert.equal(issued.data.minSeconds, 20);

        // Submitted immediately, it is too fresh — which is the rule working.
        const tooSoon = await c.post('/atlas/proposals',
            aBreak({ formToken: issued.data.formToken }));
        assert.equal(tooSoon.status, 400);
        assert.match(tooSoon.data.error, /moment longer/i);
    });
});


describe('rate limits', () => {
    test('five proposals a day per account, and the sixth is refused', async () => {
        const c = await contributor('prolific@example.com');

        for (let i = 0; i < 5; i += 1) {
            const r = await c.post('/atlas/proposals', aBreak({ case: `Case number ${i}.` }));
            assert.equal(r.status, 201, `proposal ${i + 1} was ${r.status}`);
        }

        const sixth = await c.post('/atlas/proposals', aBreak({ case: 'One too many.' }));
        assert.equal(sixth.status, 429);
        assert.equal(sixth.headers.get('retry-after'), String(24 * 60 * 60));

        const { rows } = await h.pool.query('SELECT count(*)::int AS n FROM atlas.proposals');
        assert.equal(rows[0].n, 5);
    });

    test('the limit is per account, so a second account is unaffected', async () => {
        const first = await contributor('first@example.com');
        for (let i = 0; i < 5; i += 1) {
            await first.post('/atlas/proposals', aBreak({ case: `First ${i}.` }));
        }
        assert.equal((await first.post('/atlas/proposals', aBreak())).status, 429);

        const second = await contributor('second@example.com');
        const r = await second.post('/atlas/proposals', aBreak({ case: 'A different person.' }));
        assert.equal(r.status, 201);
    });
});
