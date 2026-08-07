import { request, onSubmit, say, setCsrfToken, show, hide } from './api.js';

const loading = document.getElementById('loading');
const signedOut = document.getElementById('signed-out');
const signedIn = document.getElementById('signed-in');
const unverified = document.getElementById('unverified-note');

const form = document.getElementById('propose-form');
const message = document.getElementById('form-message');
const nodePath = document.getElementById('nodePath');

// Issued by GET /proposals/new and carried back on submit. It is what makes the
// twenty-second rule in PROPOSALS.md §4 a server-side check rather than a
// number this page could simply make up.
let formToken = null;

// Load ------------------------------------------------------------------------
//
// GET /me first, for the same reason as the settings page: the session cookie
// survives a reload and the CSRF token does not.
(async () => {
    const { ok, data } = await request('GET', '/me');
    hide(loading);

    if (!ok) {
        show(signedOut);
        setCsrfToken(null);
        return;
    }

    setCsrfToken(data.csrfToken);
    show(signedIn);

    // Submitting is refused server-side for an unverified account. Saying so
    // here as well means the form is not filled in before finding out.
    if (data.account && !data.account.verified) {
        show(unverified);
        for (const field of form.elements) field.disabled = true;
    }

    // A node page will eventually link here with the node already named. Until
    // then it is typed, and the query string is what a link would use.
    const asked = new URLSearchParams(window.location.search).get('node');
    if (asked) nodePath.value = asked;

    const issued = await request('GET', '/proposals/new');
    if (issued.ok) formToken = issued.data.formToken;
})();

// Type ------------------------------------------------------------------------
//
// The five types from PROPOSALS.md §4. Only the rows belonging to the chosen
// one are shown; the rest stay in the DOM so a half-filled block survives
// changing your mind and changing it back.

const CHILDREN_MAX = 7;   // Rule 01, the ceiling
const CHILDREN_WARN = 5;  // Rule 01, the target
const CHILDREN_MIN = 2;   // Rule 05, a division that divides nothing

const ARGUMENT = {
    break: ['Why the division cannot take it',
        'Which components it falls between or across, and why each one is wrong. Markdown is kept.'],
    subdivide: ['Why these parts, and why this many',
        'What question each part answers, and why the set is exhaustive at this level. Markdown is kept.'],
    redefine: ['What is wrong with the current wording',
        'What the current definition lets in or keeps out that it should not. Markdown is kept.'],
    relocate: ['Why it belongs under that parent',
        'What the current parent claims that this node does not answer. Markdown is kept.'],
    merge: ['Why these are not distinct',
        'What distinguishes them on paper, and why that distinction does not survive a case. Markdown is kept.'],
};

const bodyLabel = document.getElementById('body-label');
const bodyHint = document.getElementById('body-hint');
const childrenBox = document.getElementById('children');
const childrenMessage = document.getElementById('children-message');

function currentType() {
    const picked = form.querySelector('input[name="type"]:checked');
    return picked ? picked.value : 'break';
}

function showTypeRows() {
    const type = currentType();
    for (const row of form.querySelectorAll('[data-for]')) {
        row.classList.toggle('js-hidden', row.dataset.for !== type);
    }
    const [label, hint] = ARGUMENT[type] || ARGUMENT.break;
    bodyLabel.textContent = label;
    bodyHint.textContent = hint;

    if (type === 'subdivide' && childrenBox.children.length === 0) {
        for (let i = 0; i < CHILDREN_MIN; i += 1) addChild();
    }
    checkChildren();
}

for (const radio of form.querySelectorAll('input[name="type"]')) {
    radio.addEventListener('change', showTypeRows);
}

// Run once at load, so the page opens on Break with the other four types' rows
// already hidden rather than flashing all five.
showTypeRows();

// Subdivide: the six fields a node carries, one block per proposed component.
let childSeq = 0;

function addChild() {
    childSeq += 1;
    const n = childSeq;

    const block = document.createElement('fieldset');
    block.className = 'child';

    const legend = document.createElement('legend');
    legend.className = 'child__legend';
    legend.textContent = `Component ${childrenBox.children.length + 1}`;
    block.append(legend);

    const field = (tag, id, label, hint, attrs = {}) => {
        const row = document.createElement('div');
        row.className = 'form__row';
        const l = document.createElement('label');
        l.className = 'form__label';
        l.htmlFor = `${id}-${n}`;
        l.textContent = label;
        const input = document.createElement(tag);
        input.className = 'form__input';
        input.id = `${id}-${n}`;
        input.dataset.field = id;
        for (const [k, v] of Object.entries(attrs)) input.setAttribute(k, v);
        const h = document.createElement('p');
        h.className = 'form__hint';
        h.textContent = hint;
        row.append(l, input, h);
        return row;
    };

    block.append(field('input', 'name', 'Name', 'Required. Sentence case.', { maxlength: 80 }));
    block.append(field('textarea', 'definition', 'Definition',
        'What this component is. Empty is a declared gap.', { maxlength: 1000 }));
    block.append(field('textarea', 'inclusion', 'Inclusion', 'One per line.'));
    block.append(field('textarea', 'exclusion', 'Exclusion', 'One per line.'));
    block.append(field('textarea', 'sources', 'Sources', 'One per line.'));
    block.append(field('textarea', 'boundary_cases', 'Boundary cases', 'One per line.'));
    block.append(field('textarea', 'uncertainty', 'Uncertainty', 'One per line.'));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'form__button form__button--quiet';
    remove.textContent = 'Remove this component';
    remove.addEventListener('click', () => {
        block.remove();
        renumberChildren();
        checkChildren();
    });
    block.append(remove);

    childrenBox.append(block);
    renumberChildren();
    checkChildren();
}

function renumberChildren() {
    [...childrenBox.children].forEach((block, i) => {
        const legend = block.querySelector('.child__legend');
        if (legend) legend.textContent = `Component ${i + 1}`;
    });
}

document.getElementById('add-child').addEventListener('click', () => {
    if (childrenBox.children.length >= CHILDREN_MAX) {
        checkChildren();
        return;
    }
    addChild();
});

// §4's client-side checks. "These are not security, they are teaching" — every
// one of them restates the rule it comes from, and the server refuses the same
// things again for the ones that are refusals.
function checkChildren() {
    if (currentType() !== 'subdivide') {
        say(childrenMessage, '', null);
        childrenMessage.textContent = '';
        return null;
    }

    const blocks = [...childrenBox.children];
    const n = blocks.length;

    if (n > CHILDREN_MAX) {
        say(childrenMessage,
            `Rule 01 — five parts, at most seven. This is ${n}. The ceiling is `
            + 'Miller (1956) at the cautious end, not a target to reach.', 'error');
        return 'refused';
    }
    if (n < CHILDREN_MIN) {
        say(childrenMessage,
            `Rule 05 — decomposable or terminal. ${n === 1 ? 'One part divides nothing' : 'A division needs parts'}; `
            + 'either give it two or more, or the node is an endpoint.', 'error');
        return 'refused';
    }
    if (n > CHILDREN_WARN) {
        say(childrenMessage,
            `Rule 01 — ${n} parts is within the ceiling of seven but above the target `
            + 'of five. Worth asking whether two of them are the same.', 'working');
        return 'warned';
    }

    const missingDefinition = blocks.filter(
        (b) => b.querySelector('[data-field="definition"]').value.trim() === '').length;
    if (missingDefinition) {
        say(childrenMessage,
            `${missingDefinition} component${missingDefinition === 1 ? ' has' : 's have'} no `
            + 'definition. Allowed — it is a declared gap — but a reviewer cannot judge '
            + 'a part they cannot read.', 'working');
        return 'warned';
    }

    say(childrenMessage, `${n} components. Within the bound.`, 'ok');
    return 'ok';
}

childrenBox.addEventListener('input', checkChildren);

function readChildren() {
    return [...childrenBox.children].map((block) => {
        const get = (f) => block.querySelector(`[data-field="${f}"]`).value;
        const lines = (f) => get(f).split('\n').map((s) => s.trim()).filter(Boolean);
        return {
            name: get('name').trim(),
            definition: get('definition').trim(),
            inclusion: lines('inclusion'),
            exclusion: lines('exclusion'),
            sources: lines('sources'),
            boundary_cases: lines('boundary_cases'),
            uncertainty: lines('uncertainty'),
        };
    });
}

// Counts ----------------------------------------------------------------------
//
// The bound is on the textarea as maxlength, so this cannot be exceeded by
// typing. It is here so the limit is visible before it is hit rather than felt
// as a keystroke that does nothing.
// Returns its own repaint, so that form.reset() can be followed by a redraw
// rather than by registering the listener a second time.
function countTo(field, output, max) {
    const paint = () => {
        const used = field.value.trim().length;
        output.textContent = `${used} / ${max}`;
        output.className = 'form__count' + (used > max ? ' form__count--over' : '');
    };
    field.addEventListener('input', paint);
    paint();
    return paint;
}

const repaint = [
    countTo(document.getElementById('case'), document.getElementById('case-count'), 1000),
    countTo(document.getElementById('body'), document.getElementById('body-count'), 4000),
];

// Submit ----------------------------------------------------------------------

onSubmit(form, message, async (data) => {
    if (!formToken) {
        say(message, 'This form did not finish loading. Reload the page.', 'error');
        return;
    }

    // One per line, blanks dropped. A textarea rather than repeated inputs
    // because a citation is a line of text and adding rows needs a button that
    // would do nothing but add rows.
    const sources = String(data.get('sources') || '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');

    const type = currentType();

    if (type === 'subdivide' && checkChildren() === 'refused') {
        say(message, 'The components break a rule — see the message above them.', 'error');
        return;
    }

    // §4 again: "No sources anywhere — warned". A warning, so it does not stop
    // the send; it is said once, on the way out, where it is still true.
    const lines = (name) => String(data.get(name) || '')
        .split('\n').map((s) => s.trim()).filter(Boolean);

    const payload = { break: () => ({ case: data.get('case') }),
        subdivide: () => ({ children: readChildren() }),
        redefine: () => ({
            definition: data.get('newDefinition'),
            inclusion: lines('newInclusion'),
            exclusion: lines('newExclusion'),
        }),
        relocate: () => ({ newParent: String(data.get('newParent') || '').trim() }),
        merge: () => ({ siblings: lines('siblings') }),
    }[type]();

    const { ok, status, data: body } = await request('POST', '/proposals', {
        type,
        nodePath: String(data.get('nodePath') || '').trim(),
        ...payload,
        body: data.get('body'),
        sources,
        displayAs: data.get('displayAs'),
        formToken,
        website: data.get('website'),      // the honeypot; empty for a person
    });

    if (!ok) {
        say(message, body.error || 'Could not submit the proposal.', 'error');

        // A spent or expired token cannot be reused, and the next attempt would
        // fail the same way with no explanation. Ask for another.
        if (status === 400) {
            const again = await request('GET', '/proposals/new');
            if (again.ok) formToken = again.data.formToken;
        }
        return;
    }

    form.reset();
    childrenBox.replaceChildren();
    showTypeRows();
    for (const paint of repaint) paint();

    const noSources = sources.length === 0
        ? ' No sources were given — allowed, but a definition without one is an '
          + 'opinion with formatting.'
        : '';
    say(message, (body.message || 'Submitted.') + noSources, 'ok');

    // A fresh token, so a second break can be sent without reloading — and the
    // twenty seconds start again with it.
    const next = await request('GET', '/proposals/new');
    formToken = next.ok ? next.data.formToken : null;
});
