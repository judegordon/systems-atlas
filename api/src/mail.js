//
// Two templates. docs/ACCOUNTS.md: "No marketing, no mailing list, no digest."
// If a third template is ever wanted, it is a decision, not a convenience.
//
const { Resend } = require('resend');

const FROM = 'Systems Atlas <noreply@systemsatlasproject.com>';
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://systemsatlasproject.com';

// Constructed lazily. A missing key should fail when an email is sent, with a
// message that says so, rather than at require-time with a stack trace.
let client = null;
function resend() {
    if (!client) {
        if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
        client = new Resend(process.env.RESEND_API_KEY);
    }
    return client;
}

// A send that fails must not fail the request around it: sign-up returns 202
// whether or not the address exists, and it has to return the same 202 when
// Resend is down. The failure goes to the log, where it can be seen.
// Filled only when MAIL_TRANSPORT=log, so that a test can read the link that
// was sent. The link is the one thing a test cannot get any other way: the
// database holds a sha256 of the token and nothing that can be reversed.
const outbox = [];

async function send(message) {
    if (process.env.MAIL_TRANSPORT === 'log') {
        outbox.push({ to: message.to, subject: message.subject, link: message.link });
        console.log('[mail]', message.subject, '->', message.to);
        return { delivered: false, logged: true };
    }
    try {
        await resend().emails.send({
            from: FROM,
            to: message.to,
            subject: message.subject,
            text: message.text,
            html: message.html,
        });
        return { delivered: true };
    } catch (err) {
        console.error('Email send failed:', message.subject, err.message);
        return { delivered: false, error: err.message };
    }
}

function layout(heading, body, link, linkLabel, footer) {
    return `<!DOCTYPE html>
<html lang="en">
<body>
<div>
<h1>${heading}</h1>
${body.map((p) => `<p>${p}</p>`).join('\n')}
<p><a href="${link}">${linkLabel}</a></p>
<p>${footer}</p>
<p>Systems Atlas — ${SITE_ORIGIN}</p>
</div>
</body>
</html>`;
}

async function sendVerification(email, token) {
    const link = `${SITE_ORIGIN}/account/verify/?token=${encodeURIComponent(token)}`;
    return send({
        to: email,
        link,
        subject: 'Verify your email — Systems Atlas',
        text: [
            'Confirm your address to finish setting up your Systems Atlas account.',
            '',
            link,
            '',
            'The link works once and expires in 24 hours.',
            '',
            'If you did not create this account, nothing has been set up and you can',
            'ignore this. The address will not be written to again.',
        ].join('\n'),
        html: layout(
            'Verify your email',
            ['Confirm your address to finish setting up your Systems Atlas account.'],
            link,
            'Verify this address',
            'The link works once and expires in 24 hours. If you did not create this '
            + 'account, nothing has been set up and you can ignore this. The address '
            + 'will not be written to again.'
        ),
    });
}

async function sendPasswordReset(email, token) {
    const link = `${SITE_ORIGIN}/account/reset/?token=${encodeURIComponent(token)}`;
    return send({
        to: email,
        link,
        subject: 'Reset your password — Systems Atlas',
        text: [
            'Someone asked to reset the password on this Systems Atlas account.',
            '',
            link,
            '',
            'The link works once and expires in one hour.',
            '',
            'If that was not you, your password has not changed and no action is needed.',
        ].join('\n'),
        html: layout(
            'Reset your password',
            ['Someone asked to reset the password on this Systems Atlas account.'],
            link,
            'Set a new password',
            'The link works once and expires in one hour. If that was not you, your '
            + 'password has not changed and no action is needed.'
        ),
    });
}

module.exports = { sendVerification, sendPasswordReset, outbox };
