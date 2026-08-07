//
// GET /atlas/proposals — the public read that scripts/build.mjs writes into
// the node pages. docs/PROPOSALS.md §7, build step 4.
//
// Everything this returns is already published. The tests that matter are the
// ones about what it must never return: a pending proposal, and the account
// behind an anonymous submission.
//
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers');
const proposals = require('../src/proposals');

before(async () => { await h.start(); });
after(async () => { await h.stop(); });
beforeEach(async () => { await h.reset(); });

const NODE = 'human-biological/nervous-system';

function aBreak(over = {}) {
    return {
        type: 'break',
        nodePath: NODE,
        case: 'A neuroendocrine cell releasing a hormone in response to a nerve impulse.',
        body: 'Signalling and secretion at once.',
        sources: ['Kandel, Principles of Neural Science'],
        displayAs: 'name',
        formToken: proposals.issueFormToken(Date.now() - 30000),
        website: '',
        ...over,
    };
}

async function admin(email = 'admin@example.com') {
    const c = h.client();
    await h.signedUp(c, { email });
    await h.pool.query('UPDATE atlas.accounts SET is_admin = TRUE WHERE email = $1', [email]);
    return c;
}

// Submit, then decide. Returns the proposal id.
//
// `by` reuses an admin across calls. Sign-up is limited to three per address
// per hour and every account here comes from the same 127.0.0.1, so a test that
// decides twice has to share one moderator or spend its whole allowance on
// creating them.
async function decided(status, { email = 'author@example.com', displayName = 'A Contributor',
                                 over = {}, reason = 'A reason.', rule, by } = {}) {
    const c = h.client();
    await h.signedUp(c, { email, displayName });
    const r = await c.post('/atlas/proposals', aBreak(over));
    assert.equal(r.status, 201);

    const a = by || await admin(`admin-${email}`);
    const body = { reason };
    if (rule) body.rule = rule;

    // The route is the action; the column is the state it leaves behind.
    const action = status === 'accepted' ? 'accept' : 'reject';
    const d = await a.post(`/atlas/admin/proposals/${r.data.proposal.id}/${action}`, body);
    assert.equal(d.status, 200, `deciding was ${d.status}`);
    return { id: r.data.proposal.id, client: c };
}

// The endpoint is public, so an anonymous client is the right caller.
function anyone() {
    return h.client();
}


describe('what is published', () => {
    test('a pending proposal is not published', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'pending@example.com' });
        await c.post('/atlas/proposals', aBreak());

        const r = await anyone().get('/atlas/proposals');
        assert.equal(r.status, 200);
        assert.equal(r.data.proposals.length, 0);
    });

    test('accepted and rejected are both published, with their reasons', async () => {
        const moderator = await admin();
        await decided('accepted', {
            email: 'yes@example.com', reason: 'A real break.', by: moderator,
        });
        await decided('rejected', {
            email: 'no@example.com',
            reason: 'Inside what the division already covers.',
            rule: '03',
            by: moderator,
        });

        const { data } = await anyone().get('/atlas/proposals');
        assert.equal(data.proposals.length, 2);

        const accepted = data.proposals.find((p) => p.status === 'accepted');
        const rejected = data.proposals.find((p) => p.status === 'rejected');

        assert.equal(accepted.decisionReason, 'A real break.');
        assert.equal(accepted.decisionRule, null);
        assert.equal(rejected.decisionReason, 'Inside what the division already covers.');
        assert.equal(rejected.decisionRule, '03');
    });

    test('the case, the argument and the sources come with it', async () => {
        await decided('accepted');
        const { data } = await anyone().get('/atlas/proposals');
        const p = data.proposals[0];

        assert.equal(p.nodePath, NODE);
        assert.equal(p.type, 'break');
        assert.match(p.case, /neuroendocrine/);
        assert.match(p.body, /Signalling and secretion/);
        assert.deepEqual(p.sources, ['Kandel, Principles of Neural Science']);
    });

    test('no session is needed — the build is not signed in', async () => {
        await decided('accepted');
        const r = await anyone().get('/atlas/proposals');
        assert.equal(r.status, 200);
        assert.ok(r.data.generatedAt, 'the response should say when it was made');
    });
});


describe('who is named', () => {
    test('a named submission carries the display name', async () => {
        await decided('accepted', { email: 'named@example.com', displayName: 'Jo Bloggs' });
        const { data } = await anyone().get('/atlas/proposals');
        assert.equal(data.proposals[0].author, 'Jo Bloggs');
    });

    test('an anonymous submission is Anonymous, and nothing else leaks', async () => {
        await decided('accepted', {
            email: 'secret@example.com',
            displayName: 'Should Not Appear',
            over: { displayAs: 'anonymous' },
        });

        const { data } = await anyone().get('/atlas/proposals');
        const p = data.proposals[0];

        assert.equal(p.author, 'Anonymous');

        // The whole payload, not just the fields this test happens to name.
        const serialised = JSON.stringify(p);
        assert.doesNotMatch(serialised, /secret@example\.com/);
        assert.doesNotMatch(serialised, /Should Not Appear/);
        assert.equal(p.accountId, undefined);
        assert.equal(p.email, undefined);
    });

    test('a withdrawn account becomes Withdrawn, and its argument stays', async () => {
        const { client } = await decided('accepted', {
            email: 'leaving@example.com', displayName: 'Departing',
        });
        const gone = await client.del('/atlas/me', { password: 'correct horse battery' });
        assert.ok(gone.status === 200 || gone.status === 204, `withdrawal was ${gone.status}`);

        const { data } = await anyone().get('/atlas/proposals');
        // §3: "Published proposals and comments remain, with the author
        // reattributed to Withdrawn."
        assert.equal(data.proposals.length, 1);
        assert.equal(data.proposals[0].author, 'Withdrawn');
        assert.match(data.proposals[0].body, /Signalling and secretion/);
    });

    test('anonymous wins over withdrawn', async () => {
        const { client } = await decided('accepted', {
            email: 'both@example.com',
            displayName: 'Neither Shown',
            over: { displayAs: 'anonymous' },
        });
        await client.del('/atlas/me', { password: 'correct horse battery' });

        // If withdrawal turned an Anonymous entry into Withdrawn, the change
        // itself would disclose something to anyone who had read both.
        const { data } = await anyone().get('/atlas/proposals');
        assert.equal(data.proposals[0].author, 'Anonymous');
    });
});
