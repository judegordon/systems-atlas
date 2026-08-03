import { request, tokenFromUrl, say } from './api.js';

const message = document.getElementById('form-message');
const token = tokenFromUrl();

// Runs on load. The link in the email is the whole interaction; asking the
// reader to press a second button after they have already pressed one adds a
// step and proves nothing.
(async () => {
    if (!token) {
        say(message, 'This link is missing its token.', 'error');
        return;
    }

    say(message, 'Verifying…', 'working');
    const { ok, data } = await request('POST', '/accounts/verify', { token });

    if (ok) {
        say(message, 'Your email is verified. You can sign in.', 'ok');
        document.getElementById('after-verify').classList.remove('js-hidden');
        return;
    }
    say(message, data.error || 'This link could not be used.', 'error');
    document.getElementById('after-fail').classList.remove('js-hidden');
})();
