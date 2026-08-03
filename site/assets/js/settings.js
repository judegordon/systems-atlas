import { request, onSubmit, say, clearMessage, setCsrfToken, show, hide } from './api.js';

const loading = document.getElementById('loading');
const signedOut = document.getElementById('signed-out');
const signedIn = document.getElementById('signed-in');

const profileForm = document.getElementById('profile-form');
const profileMessage = document.getElementById('profile-message');
const passwordForm = document.getElementById('password-form');
const passwordMessage = document.getElementById('password-message');
const withdrawForm = document.getElementById('withdraw-form');
const withdrawMessage = document.getElementById('withdraw-message');
const sessionsMessage = document.getElementById('sessions-message');

// Load ------------------------------------------------------------------------

// GET /me is what re-establishes the CSRF token after a reload: the cookie
// survives, the token does not, and this is the first request the page makes.
(async () => {
    const { ok, data } = await request('GET', '/me');
    hide(loading);

    if (!ok) {
        show(signedOut);
        setCsrfToken(null);
        return;
    }

    setCsrfToken(data.csrfToken);
    fill(data.account);
    show(signedIn);
})();

function fill(account) {
    document.getElementById('fact-email').textContent = account.email;
    document.getElementById('fact-joined').textContent =
        new Date(account.createdAt).toISOString().slice(0, 10);
    document.getElementById('fact-verified').textContent =
        account.verified ? 'Verified' : 'Not yet verified';

    document.getElementById('displayName').value = account.displayName;
    document.getElementById('bio').value = account.bio || '';

    if (account.isAdmin) show(document.getElementById('admin-note'));
    if (!account.verified) show(document.getElementById('unverified-note'));
}

// Display name and bio ----------------------------------------------------------

onSubmit(profileForm, profileMessage, async (data) => {
    const bio = data.get('bio').trim();

    const { ok, data: body } = await request('PATCH', '/me', {
        displayName: data.get('displayName'),
        // An empty box means "remove it", which is null rather than "".
        bio: bio === '' ? null : bio,
    });

    if (!ok) {
        say(profileMessage, body.error || 'Could not save.', 'error');
        return;
    }
    say(profileMessage, 'Saved. This is the name that appears next to anything you publish.', 'ok');
});

// Password -----------------------------------------------------------------------

onSubmit(passwordForm, passwordMessage, async (data) => {
    const newPassword = data.get('newPassword');

    if (newPassword !== data.get('confirm')) {
        say(passwordMessage, 'The two new passwords do not match.', 'error');
        return;
    }

    const { ok, data: body } = await request('POST', '/me/password', {
        currentPassword: data.get('currentPassword'),
        newPassword,
    });

    if (!ok) {
        say(passwordMessage, body.error || 'Could not change the password.', 'error');
        return;
    }

    passwordForm.reset();
    const others = body.otherSessionsRevoked;
    say(
        passwordMessage,
        others > 0
            ? `Password changed. ${others} other ${others === 1 ? 'session was' : 'sessions were'} signed out.`
            : 'Password changed.',
        'ok'
    );
});

// Sessions --------------------------------------------------------------------------

document.getElementById('signout').addEventListener('click', async () => {
    clearMessage(sessionsMessage);
    await request('DELETE', '/sessions');
    setCsrfToken(null);
    window.location.assign('/account/');
});

document.getElementById('signout-all').addEventListener('click', async () => {
    clearMessage(sessionsMessage);
    const { ok, data } = await request('DELETE', '/sessions/all');
    if (!ok) {
        say(sessionsMessage, data.error || 'Could not sign out everywhere.', 'error');
        return;
    }
    setCsrfToken(null);
    window.location.assign('/account/');
});

// Withdrawal ---------------------------------------------------------------------------

onSubmit(withdrawForm, withdrawMessage, async (data) => {
    // The consequence is stated on the page above this form and again here.
    // Anything published stays published; this is the last point at which
    // that can be reconsidered.
    if (data.get('confirm') !== 'WITHDRAW') {
        say(withdrawMessage, 'Type WITHDRAW to confirm.', 'error');
        return;
    }

    const { ok, data: body } = await request('DELETE', '/me', {
        password: data.get('password'),
    });

    if (!ok) {
        say(withdrawMessage, body.error || 'Could not withdraw the account.', 'error');
        return;
    }

    setCsrfToken(null);
    window.location.assign('/account/withdrawn/');
});
