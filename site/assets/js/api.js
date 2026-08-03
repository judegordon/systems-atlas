//
// The only file that talks to the API. Self-hosted, no bundler, no framework.
// docs/ACCOUNTS.md: "Form submission and fetch, nothing more."
//
// This runs on /account/*, /propose/* and /discuss/* only. Every other page on
// the site keeps script-src 'none' and has nothing to load.
//
const API = 'https://api.systemsatlasproject.com/atlas';

// The CSRF token is handed out by sign-in and by GET /me, and lives only in
// this tab. sessionStorage rather than localStorage: a second tab fetches its
// own from /me, and closing the tab takes it with it.
const CSRF_KEY = 'atlas.csrf';

export function csrfToken() {
    try {
        return sessionStorage.getItem(CSRF_KEY);
    } catch {
        return null;                 // storage disabled; /me will re-fetch
    }
}

export function setCsrfToken(token) {
    try {
        if (token) sessionStorage.setItem(CSRF_KEY, token);
        else sessionStorage.removeItem(CSRF_KEY);
    } catch {
        /* nothing to do; the request will 403 and the page will say so */
    }
}

// Returns { ok, status, data }. Never throws for an HTTP error — a 401 from
// /me is an answer, not an exception. Only a dead network rejects.
export async function request(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const token = csrfToken();
    if (token && method !== 'GET') headers['X-CSRF-Token'] = token;

    let response;
    try {
        response = await fetch(API + path, {
            method,
            headers,
            credentials: 'include',          // the session cookie
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    } catch {
        return { ok: false, status: 0, data: { error: 'Could not reach the server.' } };
    }

    let data = {};
    if (response.status !== 204) {
        try {
            data = await response.json();
        } catch {
            data = {};
        }
    }

    if (data && data.csrfToken) setCsrfToken(data.csrfToken);

    return { ok: response.ok, status: response.status, data };
}

// Page plumbing ---------------------------------------------------------------

export function say(element, text, kind) {
    element.textContent = text;
    element.className = 'form__message' + (kind ? ' form__message--' + kind : '');
}

export function clearMessage(element) {
    element.textContent = '';
    element.className = 'form__message';
}

// Wraps a submit handler so the button cannot be pressed twice and the message
// line always ends up saying something.
export function onSubmit(form, message, handler) {
    const button = form.querySelector('button[type="submit"]');

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (button) button.disabled = true;
        say(message, 'Working…', 'working');

        try {
            await handler(new FormData(form));
        } catch {
            say(message, 'Something went wrong. Try again.', 'error');
        } finally {
            if (button) button.disabled = false;
        }
    });
}

export function tokenFromUrl() {
    return new URLSearchParams(window.location.search).get('token') || '';
}

export function show(element) {
    element.classList.remove('js-hidden');
}

export function hide(element) {
    element.classList.add('js-hidden');
}
