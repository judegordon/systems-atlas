//
// The four proposal types build step 5 opens: subdivide, redefine, relocate,
// merge. docs/PROPOSALS.md §4.
//
// §4 gives the payload shape for `subdivide` only. The other three are designed
// in src/proposals.js from the one sentence each gets in the types table, so
// these tests are as much a record of that design as a check on it.
//
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers');
const proposals = require('../src/proposals');

before(async () => { await h.start(); });
after(async () => { await h.stop(); });
beforeEach(async () => { await h.reset(); });

// A node with two children, so merge and subdivide have something real to name.
const PARENT = 'human-biological/nervous-system';
const CHILD_A = 'central-nervous-system';
const CHILD_B = 'peripheral-nervous-system';

function base(over = {}) {
    return {
        nodePath: PARENT,
        body: 'The argument, at whatever length is needed to be checkable.',
        sources: [],
        displayAs: 'name',
        formToken: proposals.issueFormToken(Date.now() - 30000),
        website: '',
        ...over,
    };
}

function child(name, over = {}) {
    return { name, definition: `What ${name} is.`, inclusion: [], exclusion: [],
             sources: [], boundary_cases: [], uncertainty: [], ...over };
}

async function contributor(email) {
    const c = h.client();
    await h.signedUp(c, { email });
    return c;
}

async function payloadOf(id) {
    const { rows } = await h.pool.query(
        'SELECT type, payload FROM atlas.proposals WHERE id = $1', [id]);
    return rows[0];
}


describe('subdivide', () => {
    test('a division of three is accepted and its children stored in full', async () => {
        const c = await contributor('sub@example.com');
        const r = await c.post('/atlas/proposals', base({
            type: 'subdivide',
            children: [
                child('Afferent structures', { inclusion: ['sensory pathways'], sources: ['Kandel'] }),
                child('Efferent structures'),
                child('Integrative structures'),
            ],
        }));

        assert.equal(r.status, 201);
        const stored = await payloadOf(r.data.proposal.id);
        assert.equal(stored.type, 'subdivide');
        assert.equal(stored.payload.children.length, 3);
        assert.equal(stored.payload.children[0].name, 'Afferent structures');
        assert.deepEqual(stored.payload.children[0].inclusion, ['sensory pathways']);
        assert.deepEqual(stored.payload.children[0].sources, ['Kandel']);
        // The six fields are all present even when empty — a declared gap, as
        // on a real node.
        assert.deepEqual(stored.payload.children[1].boundary_cases, []);
    });

    test('eight components are refused, and Rule 01 is named', async () => {
        const c = await contributor('eight@example.com');
        const r = await c.post('/atlas/proposals', base({
            type: 'subdivide',
            children: Array.from({ length: 8 }, (_, i) => child(`Part ${i + 1}`)),
        }));
        assert.equal(r.status, 400);
        assert.match(r.data.error, /Rule 01/);
    });

    test('seven is allowed — the ceiling is inclusive', async () => {
        const c = await contributor('seven@example.com');
        const r = await c.post('/atlas/proposals', base({
            type: 'subdivide',
            children: Array.from({ length: 7 }, (_, i) => child(`Part ${i + 1}`)),
        }));
        assert.equal(r.status, 201);
    });

    test('one component is refused, and Rule 05 is named', async () => {
        const c = await contributor('one@example.com');
        const r = await c.post('/atlas/proposals', base({
            type: 'subdivide', children: [child('The only part')],
        }));
        assert.equal(r.status, 400);
        assert.match(r.data.error, /Rule 05/);
    });

    test('a component without a name is refused', async () => {
        const c = await contributor('noname@example.com');
        const r = await c.post('/atlas/proposals', base({
            type: 'subdivide', children: [child('Fine'), child('   ')],
        }));
        assert.equal(r.status, 400);
        assert.match(r.data.error, /name/i);
    });

    test('a component without a definition is allowed — an empty field is a gap', async () => {
        const c = await contributor('nodef@example.com');
        const r = await c.post('/atlas/proposals', base({
            type: 'subdivide',
            children: [child('One', { definition: '' }), child('Two', { definition: '' })],
        }));
        assert.equal(r.status, 201);
    });
});


describe('redefine', () => {
    test('a replacement definition is stored', async () => {
        const c = await contributor('redef@example.com');
        const r = await c.post('/atlas/proposals', base({
            type: 'redefine',
            definition: 'The system that transmits signals electrically and chemically.',
        }));
        assert.equal(r.status, 201);
        const stored = await payloadOf(r.data.proposal.id);
        assert.match(stored.payload.definition, /electrically and chemically/);
        // Only what was given. An untouched list is absent, not empty.
        assert.equal(stored.payload.inclusion, undefined);
    });

    test('inclusion or exclusion alone is enough', async () => {
        const c = await contributor('lists@example.com');
        const r = await c.post('/atlas/proposals', base({
            type: 'redefine', exclusion: ['hormonal signalling, which has nowhere to go'],
        }));
        assert.equal(r.status, 201);
        const stored = await payloadOf(r.data.proposal.id);
        assert.deepEqual(stored.payload.exclusion, ['hormonal signalling, which has nowhere to go']);
    });

    test('proposing nothing is refused', async () => {
        const c = await contributor('empty@example.com');
        const r = await c.post('/atlas/proposals', base({ type: 'redefine' }));
        assert.equal(r.status, 400);
        assert.match(r.data.error, /replacement/i);
    });
});


describe('relocate', () => {
    test('a move to another parent is stored', async () => {
        const c = await contributor('move@example.com');
        const r = await c.post('/atlas/proposals', base({
            type: 'relocate', nodePath: PARENT, newParent: 'technological',
        }));
        assert.equal(r.status, 201);
        const stored = await payloadOf(r.data.proposal.id);
        assert.equal(stored.payload.newParent, 'technological');
    });

    test('a parent that is not in the atlas is refused', async () => {
        const c = await contributor('nowhere@example.com');
        const r = await c.post('/atlas/proposals', base({
            type: 'relocate', newParent: 'invented/parent',
        }));
        assert.equal(r.status, 400);
        assert.match(r.data.error, /not in the atlas/i);
    });

    test('a node cannot become its own parent', async () => {
        const c = await contributor('self@example.com');
        const r = await c.post('/atlas/proposals', base({
            type: 'relocate', newParent: PARENT,
        }));
        assert.equal(r.status, 400);
        assert.match(r.data.error, /its own parent/i);
    });

    test('a node cannot move under its own descendant — that is a loop', async () => {
        const c = await contributor('loop@example.com');
        const r = await c.post('/atlas/proposals', base({
            type: 'relocate', newParent: `${PARENT}/${CHILD_A}`,
        }));
        assert.equal(r.status, 400);
        assert.match(r.data.error, /loop/i);
    });

    test('proposing the parent it already has is refused', async () => {
        const c = await contributor('same@example.com');
        const r = await c.post('/atlas/proposals', base({
            type: 'relocate', newParent: 'human-biological',
        }));
        assert.equal(r.status, 400);
        assert.match(r.data.error, /already its parent/i);
    });
});


describe('merge', () => {
    test('two components of the named node are stored', async () => {
        const c = await contributor('merge@example.com');
        const r = await c.post('/atlas/proposals', base({
            type: 'merge', nodePath: PARENT, siblings: [CHILD_A, CHILD_B],
        }));
        assert.equal(r.status, 201);
        const stored = await payloadOf(r.data.proposal.id);
        assert.deepEqual(stored.payload.siblings, [CHILD_A, CHILD_B]);
    });

    test('something that is not a component of that node is refused', async () => {
        const c = await contributor('notchild@example.com');
        const r = await c.post('/atlas/proposals', base({
            type: 'merge', siblings: [CHILD_A, 'invented-sibling'],
        }));
        assert.equal(r.status, 400);
        assert.match(r.data.error, /not a component/i);
    });

    test('one component is not a merge', async () => {
        const c = await contributor('lonely@example.com');
        const r = await c.post('/atlas/proposals', base({
            type: 'merge', siblings: [CHILD_A],
        }));
        assert.equal(r.status, 400);
        assert.match(r.data.error, /at least two/i);
    });

    test('the same component twice is refused', async () => {
        const c = await contributor('dup@example.com');
        const r = await c.post('/atlas/proposals', base({
            type: 'merge', siblings: [CHILD_A, CHILD_A],
        }));
        assert.equal(r.status, 400);
        assert.match(r.data.error, /twice/i);
    });

    test('a node with no components has nothing to merge', async () => {
        const c = await contributor('leaf@example.com');
        const leaf = `${PARENT}/${CHILD_A}/brain/cerebrum/left-cerebral-hemisphere/left-frontal-lobe`;
        assert.equal(proposals.knownNodePath(leaf), true, 'the test leaf must exist');

        const r = await c.post('/atlas/proposals', base({
            type: 'merge', nodePath: leaf, siblings: ['a', 'b'],
        }));
        assert.equal(r.status, 400);
        assert.match(r.data.error, /no components/i);
    });
});


describe('all five are open', () => {
    test('none of the five is refused as not yet built', async () => {
        // Step 5 is the step that removes that refusal. If any type still
        // answers "not open", this is the test that says which.
        for (const type of ['break', 'subdivide', 'redefine', 'relocate', 'merge']) {
            const problem = proposals.payloadProblem(type, {}, PARENT);
            assert.doesNotMatch(String(problem), /unknown proposal type/i, `${type} is not wired`);
        }
    });

    test('a type outside the five is still unknown', async () => {
        const c = await contributor('bogus@example.com');
        const r = await c.post('/atlas/proposals', base({ type: 'rewrite' }));
        assert.equal(r.status, 400);
        assert.match(r.data.error, /unknown/i);
    });

    test('every type gets a one-line summary for the queue and the node page', () => {
        assert.match(proposals.summarisePayload('break', { case: 'A case.' }), /A case/);
        assert.match(proposals.summarisePayload('subdivide',
            { children: [{ name: 'A' }, { name: 'B' }] }), /Divide into 2: A, B/);
        assert.match(proposals.summarisePayload('redefine', { definition: 'x' }), /definition/);
        assert.match(proposals.summarisePayload('relocate', { newParent: 'legal' }), /legal/);
        assert.match(proposals.summarisePayload('merge', { siblings: ['a', 'b'] }), /a \+ b/);
    });
});
