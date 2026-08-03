import { request, onSubmit, say } from './api.js';

const form = document.getElementById('signup-form');
const message = document.getElementById('form-message');

onSubmit(form, message, async (data) => {
    const { ok, data: body } = await request('POST', '/accounts', {
        email: data.get('email'),
        displayName: data.get('displayName'),
        password: data.get('password'),
    });

    if (!ok) {
        say(message, body.error || 'Could not create the account.', 'error');
        return;
    }

    // The same 202 whether or not the address was already registered, so this
    // page cannot say "account created" — it does not know, and it must not
    // be the thing that tells anyone which it was.
    form.reset();
    say(message, body.message || 'Check your email for a verification link.', 'ok');
});
