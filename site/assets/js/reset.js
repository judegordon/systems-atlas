import { request, onSubmit, tokenFromUrl, say } from './api.js';

const form = document.getElementById('reset-form');
const message = document.getElementById('form-message');
const token = tokenFromUrl();

if (!token) say(message, 'This link is missing its token.', 'error');

onSubmit(form, message, async (data) => {
    const password = data.get('password');

    if (password !== data.get('confirm')) {
        say(message, 'The two passwords do not match.', 'error');
        return;
    }

    const { ok, data: body } = await request('POST', '/passwords/reset/confirm', {
        token,
        password,
    });

    if (!ok) {
        say(message, body.error || 'Could not set a new password.', 'error');
        return;
    }

    // Every session was revoked, including any this browser was holding.
    say(message, 'Password changed. Sign in with the new one.', 'ok');
    form.reset();
    document.getElementById('after-reset').classList.remove('js-hidden');
});
