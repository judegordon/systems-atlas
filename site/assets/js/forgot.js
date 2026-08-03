import { request, onSubmit, say } from './api.js';

const form = document.getElementById('forgot-form');
const message = document.getElementById('form-message');

onSubmit(form, message, async (data) => {
    const { ok, data: body } = await request('POST', '/passwords/reset', {
        email: data.get('email'),
    });

    if (!ok) {
        say(message, body.error || 'Could not send a reset link.', 'error');
        return;
    }
    form.reset();
    say(message, body.message || 'If that address has an account, a reset link is on its way.', 'ok');
});
