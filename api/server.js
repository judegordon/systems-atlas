//
// Systems Atlas accounts API.
//
// Everything is mounted under /atlas, which is what makes it safe to put this
// beside anything else later: no path here can collide with an app's.
//
if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config({ quiet: true });
}

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const session = require('./src/middleware/session');

const app = express();

// Railway terminates TLS and proxies, so without this every request appears to
// come from the proxy and the whole internet shares one rate limit. One hop.
app.set('trust proxy', 1);

app.disable('x-powered-by');

app.use(helmet());

// docs/ACCOUNTS.md: "The API allows exactly one origin ... No wildcard, ever."
// SITE_ORIGIN exists so a local site can talk to a local API; in production it
// is unset and the constant is the only value.
const ALLOWED_ORIGIN = process.env.SITE_ORIGIN || 'https://systemsatlasproject.com';

app.use(cors({
    origin: ALLOWED_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
    maxAge: 600,
}));

// A body larger than this is not a sign-up. The apps allow 10mb because they
// sync; nothing here is bigger than an email address and a password.
app.use(express.json({ limit: '16kb' }));

// Resolves the cookie to an account, or to null, on every request including
// the ones that do not need it — so that sign-out works when signed out, and
// so a suspended account is refused by the next request it makes rather than
// by whichever endpoint happens to check.
app.use(session.attach);

app.use('/atlas/accounts', require('./src/routes/accounts'));
app.use('/atlas/sessions', require('./src/routes/sessions'));
app.use('/atlas/passwords', require('./src/routes/passwords'));
app.use('/atlas/me', require('./src/routes/me'));
app.use('/atlas/admin', require('./src/routes/admin'));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Nothing from `err` reaches the client. An error here has passed through
// password hashes and session tokens on its way, and the log is the place for
// it. docs/ACCOUNTS.md: passwords are "never logged, never in an error
// message, never in a URL" — so the message is fixed and the detail is local.
app.use((err, req, res, next) => {                    // eslint-disable-line no-unused-vars
    if (err && err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Malformed JSON' });
    }
    console.error(`${req.method} ${req.path} —`, err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Server error' });
});

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Systems Atlas API on port ${PORT}`));
}

module.exports = app;
