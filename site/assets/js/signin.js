import { request, onSubmit, say, setCsrfToken } from './api.js';

const form = document.getElementById('signin-form');
const message = document.getElementById('form-message');

onSubmit(form, message, async (data) => {
    const { ok, status, data: body } = await request('POST', '/sessions', {
        email: data.get('email'),
        password: data.get('password'),
    });

    if (ok) {
        setCsrfToken(body.csrfToken);
        window.location.assign('/account/settings/');
        return;
    }

    if (status === 429) {
        say(message, body.error || 'Too many attempts. Try again later.', 'error');
        return;
    }
    if (status === 403 && body.reason) {
        say(message, body.error + ' — ' + body.reason, 'error');
        return;
    }
    say(message, body.error || 'Could not sign in.', 'error');
});
