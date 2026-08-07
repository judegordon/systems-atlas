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

    const { ok, status, data: body } = await request('POST', '/proposals', {
        type: 'break',
        nodePath: String(data.get('nodePath') || '').trim(),
        case: data.get('case'),
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
    for (const paint of repaint) paint();
    say(message, body.message || 'Submitted.', 'ok');

    // A fresh token, so a second break can be sent without reloading — and the
    // twenty seconds start again with it.
    const next = await request('GET', '/proposals/new');
    formToken = next.ok ? next.data.formToken : null;
});
