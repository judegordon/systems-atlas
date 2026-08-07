//
// The third action in docs/PROPOSALS.md §6: "Supersede. For a proposal
// overtaken by a later decision. Stays visible, marked, linked to whatever
// replaced it."
//
// The link is the part with teeth. It is rendered onto a public page, so a
// replacement that does not exist, or one that points back, has to be refused
// here rather than discovered by a reader following it.
//
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers');
const proposals = require('../src/proposals');

before(async () => { await h.start(); });
after(async () => { await h.stop(); });
beforeEach(async () => { await h.reset(); });

const NODE = 'human-biological/nervous-system';
const OTHER = 'legal';

function aBreak(over = {}) {
    return {
        type: 'break',
        nodePath: NODE,
        case: 'A neuroendocrine cell.',
        body: 'Signalling and secretion at once.',
        sources: [],
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

// Two pending proposals from one contributor, so the per-IP sign-up allowance
// is not spent on making authors.
async function twoPending(email = 'author@example.com') {
    const c = h.client();
    await h.signedUp(c, { email });
    const a = await c.post('/atlas/proposals', aBreak({ case: 'The first case.' }));
    const b = await c.post('/atlas/proposals', aBreak({ case: 'The second case.' }));
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    return { first: a.data.proposal.id, second: b.data.proposal.id, client: c };
}

function anyone() {
    return h.client();
}


describe('superseding', () => {
    test('records the reason, the time and the replacement', async () => {
        const { first, second } = await twoPending();
        const a = await admin();

        const r = await a.post(`/atlas/admin/proposals/${first}/supersede`, {
            reason: 'The second statement of this is the one that got the boundary right.',
            supersededBy: second,
        });

        assert.equal(r.status, 200);
        assert.equal(r.data.proposal.status, 'superseded');
        assert.equal(r.data.proposal.supersededBy.id, String(second));
        assert.equal(r.data.proposal.supersededBy.nodePath, NODE);

        const { rows } = await h.pool.query(
            'SELECT status, decision_reason, decided_at, superseded_by FROM atlas.proposals WHERE id = $1',
            [first]);
        assert.equal(rows[0].status, 'superseded');
        assert.match(rows[0].decision_reason, /got the boundary right/);
        assert.ok(rows[0].decided_at instanceof Date);
        assert.equal(String(rows[0].superseded_by), String(second));
    });

    test('requires a reason, like every other decision', async () => {
        const { first, second } = await twoPending();
        const a = await admin();
        const r = await a.post(`/atlas/admin/proposals/${first}/supersede`,
            { supersededBy: second });
        assert.equal(r.status, 400);
        assert.match(r.data.error, /reason/i);
    });

    test('requires a replacement — that is what the action is for', async () => {
        const { first } = await twoPending();
        const a = await admin();
        const r = await a.post(`/atlas/admin/proposals/${first}/supersede`,
            { reason: 'Overtaken.' });
        assert.equal(r.status, 400);
        assert.match(r.data.error, /replaced it/i);
    });

    test('a replacement that does not exist is refused', async () => {
        const { first } = await twoPending();
        const a = await admin();
        const r = await a.post(`/atlas/admin/proposals/${first}/supersede`,
            { reason: 'Overtaken.', supersededBy: '999999' });
        assert.equal(r.status, 400);
        assert.match(r.data.error, /does not exist/i);
    });

    test('a proposal cannot replace itself', async () => {
        const { first } = await twoPending();
        const a = await admin();
        const r = await a.post(`/atlas/admin/proposals/${first}/supersede`,
            { reason: 'Overtaken.', supersededBy: first });
        assert.equal(r.status, 400);
        assert.match(r.data.error, /itself/i);
    });

    test('two proposals cannot supersede each other', async () => {
        const { first, second } = await twoPending();
        const a = await admin();

        const one = await a.post(`/atlas/admin/proposals/${first}/supersede`,
            { reason: 'Overtaken by the second.', supersededBy: second });
        assert.equal(one.status, 200);

        // second is still pending, so this would otherwise be a legal decision.
        const two = await a.post(`/atlas/admin/proposals/${second}/supersede`,
            { reason: 'And back again.', supersededBy: first });
        assert.equal(two.status, 400);
        assert.match(two.data.error, /replace each other/i);
    });

    test('a longer loop is refused too', async () => {
        const { first, second, client } = await twoPending();
        const third = await client.post('/atlas/proposals', aBreak({ case: 'The third case.' }));
        assert.equal(third.status, 201);
        const thirdId = third.data.proposal.id;

        const a = await admin();
        await a.post(`/atlas/admin/proposals/${first}/supersede`,
            { reason: 'Overtaken.', supersededBy: second });
        await a.post(`/atlas/admin/proposals/${second}/supersede`,
            { reason: 'Overtaken again.', supersededBy: thirdId });

        // third -> first would close the ring first -> second -> third -> first.
        const r = await a.post(`/atlas/admin/proposals/${thirdId}/supersede`,
            { reason: 'Closing the ring.', supersededBy: first });
        assert.equal(r.status, 400);
        assert.match(r.data.error, /replace each other/i);
    });

    test('a chain that does not loop is allowed', async () => {
        const { first, second, client } = await twoPending();
        const third = await client.post('/atlas/proposals', aBreak({ case: 'The third case.' }));
        const a = await admin();

        assert.equal((await a.post(`/atlas/admin/proposals/${first}/supersede`,
            { reason: 'One.', supersededBy: second })).status, 200);
        assert.equal((await a.post(`/atlas/admin/proposals/${second}/supersede`,
            { reason: 'Two.', supersededBy: third.data.proposal.id })).status, 200);
    });

    test('deciding twice is refused', async () => {
        const { first, second } = await twoPending();
        const a = await admin();

        await a.post(`/atlas/admin/proposals/${first}/accept`, { reason: 'Yes.' });
        const again = await a.post(`/atlas/admin/proposals/${first}/supersede`,
            { reason: 'Actually overtaken.', supersededBy: second });
        assert.equal(again.status, 409);
    });

    test('an ordinary account cannot supersede', async () => {
        const { first, second } = await twoPending();
        const meddler = h.client();
        await h.signedUp(meddler, { email: 'meddler@example.com' });

        const r = await meddler.post(`/atlas/admin/proposals/${first}/supersede`,
            { reason: 'Mine now.', supersededBy: second });
        assert.equal(r.status, 404);
    });
});


describe('the schema holds the link on its own', () => {
    test('a replacement cannot be attached to a proposal that is not superseded', async () => {
        const { first, second } = await twoPending();
        const a = await admin();
        await a.post(`/atlas/admin/proposals/${first}/accept`, { reason: 'Yes.' });

        await assert.rejects(
            () => h.pool.query(
                'UPDATE atlas.proposals SET superseded_by = $1 WHERE id = $2', [second, first]),
            /proposals_superseded_has_replacement/
        );
    });

    test('a superseded proposal cannot have its replacement removed', async () => {
        const { first, second } = await twoPending();
        const a = await admin();
        await a.post(`/atlas/admin/proposals/${first}/supersede`,
            { reason: 'Overtaken.', supersededBy: second });

        await assert.rejects(
            () => h.pool.query(
                'UPDATE atlas.proposals SET superseded_by = NULL WHERE id = $1', [first]),
            /proposals_superseded_has_replacement/
        );
    });
});


describe('what the site sees', () => {
    test('a superseded proposal stays visible, marked and linked', async () => {
        const { first, second } = await twoPending();
        const a = await admin();
        await a.post(`/atlas/admin/proposals/${first}/supersede`,
            { reason: 'Overtaken by the second.', supersededBy: second });

        const { data } = await anyone().get('/atlas/proposals');
        const shown = data.proposals.find((p) => p.id === String(first));

        // §6: "Stays visible, marked, linked to whatever replaced it."
        assert.ok(shown, 'a superseded proposal must still be published');
        assert.equal(shown.status, 'superseded');
        assert.equal(shown.supersededBy.id, String(second));
        assert.equal(shown.supersededBy.nodePath, NODE);
        assert.match(shown.decisionReason, /Overtaken by the second/);
    });

    test('the replacement can be on another node, and the path comes with it', async () => {
        const c = h.client();
        await h.signedUp(c, { email: 'across@example.com' });
        const here = await c.post('/atlas/proposals', aBreak());
        const there = await c.post('/atlas/proposals', aBreak({ nodePath: OTHER }));

        const a = await admin();
        await a.post(`/atlas/admin/proposals/${here.data.proposal.id}/supersede`, {
            reason: 'The argument moved to the other node.',
            supersededBy: there.data.proposal.id,
        });

        const { data } = await anyone().get('/atlas/proposals');
        const shown = data.proposals.find((p) => p.id === String(here.data.proposal.id));
        assert.equal(shown.supersededBy.nodePath, OTHER);
    });

    test('anything not superseded says so with a null, not a missing key', async () => {
        const { first } = await twoPending();
        const a = await admin();
        await a.post(`/atlas/admin/proposals/${first}/accept`, { reason: 'Yes.' });

        const { data } = await anyone().get('/atlas/proposals');
        const shown = data.proposals[0];
        assert.ok('supersededBy' in shown, 'the build reads this key on every proposal');
        assert.equal(shown.supersededBy, null);
    });
});
