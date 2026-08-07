//
// docs/PROPOSALS.md §6, for the two actions build step 3 opens: accept and
// reject. Supersede is a later step and there is no endpoint for it to test.
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
        body: 'Signalling and secretion at once, and there is no endocrine system to '
            + 'exclude it to.',
        sources: ['Kandel, Principles of Neural Science'],
        displayAs: 'name',
        formToken: proposals.issueFormToken(Date.now() - 30000),
        website: '',
        ...over,
    };
}

// A verified contributor who has submitted one break. Returns the proposal id.
async function withPending(email = 'sender@example.com', over = {}) {
    const c = h.client();
    await h.signedUp(c, { email });
    const r = await c.post('/atlas/proposals', aBreak(over));
    assert.equal(r.status, 201, `submission was ${r.status}`);
    return { client: c, id: r.data.proposal.id };
}

// An admin. The flag is set directly: promoting is not an endpoint, and the
// accounts suite already proves the flag takes effect on the next request.
async function admin(email = 'admin@example.com') {
    const c = h.client();
    await h.signedUp(c, { email });
    await h.pool.query('UPDATE atlas.accounts SET is_admin = TRUE WHERE email = $1', [email]);
    return c;
}


describe('who can see the queue', () => {
    test('a signed-out caller gets 401', async () => {
        const c = h.client();
        assert.equal((await c.get('/atlas/admin/queue')).status, 401);
    });

    test('an ordinary account gets 404, not 403 — the endpoint is invisible', async () => {
        await withPending();
        const c = h.client();
        await h.signedUp(c, { email: 'ordinary@example.com' });
        assert.equal((await c.get('/atlas/admin/queue')).status, 404);
    });

    test('an admin sees the pending proposal', async () => {
        await withPending();
        const a = await admin();
        const r = await a.get('/atlas/admin/queue');

        assert.equal(r.status, 200);
        assert.equal(r.data.pending, 1);
        assert.equal(r.data.items[0].nodePath, NODE);
        assert.equal(r.data.items[0].type, 'break');
    });

    test('the six rules come with the queue, so the page cannot invent a seventh', async () => {
        const a = await admin();
        const r = await a.get('/atlas/admin/queue');
        assert.equal(r.data.rules.length, 6);
        assert.deepEqual(r.data.rules.map(([id]) => id), ['01', '02', '03', '04', '05', '06']);
    });
});


describe('what the queue shows', () => {
    test('the node as the atlas currently has it', async () => {
        await withPending();
        const a = await admin();
        const { node } = (await a.get('/atlas/admin/queue')).data.items[0];

        assert.equal(node.name, 'Nervous system');
        assert.match(node.definition, /information processing/);
        // The exclusion this break is an argument about.
        assert.ok(node.exclusion.some((e) => e.goesTo === 'endocrine-system'),
            'the endocrine exclusion is missing from the node state');
        assert.equal(node.children.length, 2);
    });

    test('the submission, with the case kept apart from the argument', async () => {
        const { id } = await withPending();
        const a = await admin();
        const item = (await a.get('/atlas/admin/queue')).data.items[0];

        assert.equal(item.id, id);
        assert.match(item.submission.summary, /neuroendocrine/);
        assert.match(item.submission.body, /Signalling and secretion/);
        assert.deepEqual(item.submission.sources, ['Kandel, Principles of Neural Science']);
    });

    test('the account behind an anonymous submission is visible here', async () => {
        await withPending('hidden@example.com', { displayAs: 'anonymous' });
        const a = await admin();
        const item = (await a.get('/atlas/admin/queue')).data.items[0];

        // §3: "The account behind it is never exposed publicly. You can always
        // see it." This endpoint is the second half of that sentence.
        assert.equal(item.submission.displayAs, 'anonymous');
        assert.equal(item.account.email, 'hidden@example.com');
    });

    test('submission history comes with the account', async () => {
        const { client } = await withPending('repeat@example.com');
        await client.post('/atlas/proposals', aBreak({ case: 'A second case.' }));

        const a = await admin();
        const item = (await a.get('/atlas/admin/queue')).data.items[0];
        assert.equal(item.account.history.pending, 2);
    });

    test('oldest first', async () => {
        const first = await withPending('one@example.com');
        const second = await withPending('two@example.com');

        const a = await admin();
        const items = (await a.get('/atlas/admin/queue')).data.items;
        assert.deepEqual(items.map((i) => i.id), [first.id, second.id]);
    });

    test('a decided proposal leaves the queue', async () => {
        const { id } = await withPending();
        const a = await admin();
        await a.post(`/atlas/admin/proposals/${id}/accept`, { reason: 'A real break.' });

        const r = await a.get('/atlas/admin/queue');
        assert.equal(r.data.pending, 0);
        assert.equal(r.data.items.length, 0);
    });
});


describe('accept and reject', () => {
    test('accept requires a reason', async () => {
        const { id } = await withPending();
        const a = await admin();

        const blank = await a.post(`/atlas/admin/proposals/${id}/accept`, { reason: '   ' });
        assert.equal(blank.status, 400);
        assert.match(blank.data.error, /reason/i);

        const { rows } = await h.pool.query('SELECT status FROM atlas.proposals WHERE id = $1', [id]);
        assert.equal(rows[0].status, 'pending', 'a refused decision must not be written');
    });

    test('reject requires a reason', async () => {
        const { id } = await withPending();
        const a = await admin();
        const r = await a.post(`/atlas/admin/proposals/${id}/reject`, { rule: '03' });
        assert.equal(r.status, 400);
    });

    test('accept records the reason and the time', async () => {
        const { id } = await withPending();
        const a = await admin();
        const r = await a.post(`/atlas/admin/proposals/${id}/accept`,
            { reason: 'The endocrine gap is real and this is the cleanest statement of it.' });

        assert.equal(r.status, 200);
        assert.equal(r.data.proposal.status, 'accepted');

        const { rows } = await h.pool.query(
            'SELECT status, decision_reason, decision_rule, decided_at FROM atlas.proposals WHERE id = $1',
            [id]
        );
        assert.equal(rows[0].status, 'accepted');
        assert.match(rows[0].decision_reason, /endocrine gap is real/);
        assert.ok(rows[0].decided_at instanceof Date);
        // Accepting names no rule: a rule is what a rejection cites.
        assert.equal(rows[0].decision_rule, null);
    });

    test('reject records which rule failed', async () => {
        const { id } = await withPending();
        const a = await admin();
        const r = await a.post(`/atlas/admin/proposals/${id}/reject`,
            { reason: 'Inside what the division already covers.', rule: '03' });

        assert.equal(r.status, 200);
        const { rows } = await h.pool.query(
            'SELECT status, decision_rule FROM atlas.proposals WHERE id = $1', [id]);
        assert.equal(rows[0].status, 'rejected');
        assert.equal(rows[0].decision_rule, '03');
    });

    test('reject without a rule is allowed — §6 says "where one applies"', async () => {
        const { id } = await withPending();
        const a = await admin();
        const r = await a.post(`/atlas/admin/proposals/${id}/reject`,
            { reason: 'The case is not a case: it names a category, not an object.' });

        assert.equal(r.status, 200);
        const { rows } = await h.pool.query(
            'SELECT decision_rule FROM atlas.proposals WHERE id = $1', [id]);
        assert.equal(rows[0].decision_rule, null);
    });

    test('a rule outside the six is refused', async () => {
        const { id } = await withPending();
        const a = await admin();
        const r = await a.post(`/atlas/admin/proposals/${id}/reject`,
            { reason: 'A reason.', rule: '07' });
        assert.equal(r.status, 400);
        assert.match(r.data.error, /six rules/i);
    });

    test('deciding twice is refused by the database, not by a stale read', async () => {
        const { id } = await withPending();
        const a = await admin();

        const first = await a.post(`/atlas/admin/proposals/${id}/accept`, { reason: 'Yes.' });
        assert.equal(first.status, 200);

        const second = await a.post(`/atlas/admin/proposals/${id}/reject`, { reason: 'No.' });
        assert.equal(second.status, 409);
        assert.match(second.data.error, /already accepted/i);

        const { rows } = await h.pool.query(
            'SELECT status, decision_reason FROM atlas.proposals WHERE id = $1', [id]);
        assert.equal(rows[0].status, 'accepted');
        assert.equal(rows[0].decision_reason, 'Yes.');
    });

    test('an unknown id is 404', async () => {
        const a = await admin();
        const r = await a.post('/atlas/admin/proposals/999999/accept', { reason: 'A reason.' });
        assert.equal(r.status, 404);
    });

    test('a non-numeric id is refused before it reaches the database', async () => {
        const a = await admin();
        const r = await a.post('/atlas/admin/proposals/abc/accept', { reason: 'A reason.' });
        assert.equal(r.status, 400);
    });

    test('an ordinary account cannot decide', async () => {
        const { id } = await withPending();
        const c = h.client();
        await h.signedUp(c, { email: 'meddler@example.com' });

        const r = await c.post(`/atlas/admin/proposals/${id}/accept`, { reason: 'Mine now.' });
        assert.equal(r.status, 404);

        const { rows } = await h.pool.query('SELECT status FROM atlas.proposals WHERE id = $1', [id]);
        assert.equal(rows[0].status, 'pending');
    });

    test('a decision without the CSRF token is refused', async () => {
        const { id } = await withPending();
        const a = await admin();
        const r = await a.post(`/atlas/admin/proposals/${id}/accept`,
            { reason: 'A reason.' }, { noCsrf: true });
        assert.equal(r.status, 403);
    });
});
