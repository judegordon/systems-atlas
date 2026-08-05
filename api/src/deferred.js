//
// Work that must not happen on the request's clock.
//
// Sign-up and password reset do strictly more for an address that exists than
// for one that does not: a token is issued, which is a transaction, and an
// email is sent, which is a call to Resend. Neither happens for an address
// with no account behind it.
//
// docs/ACCOUNTS.md requires the two answers to be indistinguishable, and is
// explicit about why: "an email enumeration hole on a site where contributions
// are public is a way to link pseudonymous accounts to real addresses." An
// identical response body does not achieve that on its own. A stopwatch reads
// the difference just as well as a response body does, and the gap here is not
// subtle — the Resend call alone is hundreds of milliseconds that the other
// branch never spends.
//
// Hashing the password in both branches, which `routes/accounts.js` already
// does, equalises the most expensive part. This equalises the rest by removing
// it from the measurement entirely: the response is flushed first, and the
// side effects run afterwards. What the caller can time is then the same set
// of operations either way.
//
// The cost is that a failure after the response cannot be reported in it. That
// is already the intended behaviour — docs/ACCOUNTS.md wants sign-up to return
// the same 202 when Resend is down — so the failure goes to the log, which is
// where it went before.
//
// This assumes a long-lived process. Railway runs one, so work scheduled here
// is not lost between the response and its completion.
//

const pending = new Set();

// Runs `work` once the response has been flushed. Never rejects into the
// request: an error here is logged and goes no further, because there is no
// longer a response to put it in.
function after(res, work) {
    let started = false;

    const run = () => {
        if (started) return;
        started = true;

        const task = Promise.resolve()
            .then(work)
            .catch((err) => {
                console.error('deferred work failed:', err && err.stack ? err.stack : err);
            })
            .finally(() => pending.delete(task));

        pending.add(task);
    };

    // 'finish' is the response leaving this process. 'close' covers the case
    // where the connection died first — the work still needs doing, since the
    // account was created whether or not anyone was left to read about it.
    if (res.writableEnded) run();
    else {
        res.once('finish', run);
        res.once('close', run);
    }
}

// Resolves when everything scheduled so far has finished. The test suite awaits
// this after each request, so that a test can read the outbox without racing
// the send. Nothing in production calls it.
async function settled() {
    while (pending.size) {
        await Promise.all([...pending]);
    }
}

module.exports = { after, settled };
