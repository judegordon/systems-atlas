import { request, onSubmit, say, setCsrfToken, show, hide } from './api.js';

const loading = document.getElementById('loading');
const noNode = document.getElementById('no-node');
const threadWrap = document.getElementById('thread-wrap');
const thread = document.getElementById('thread');
const threadEmpty = document.getElementById('thread-empty');
const signedOut = document.getElementById('signed-out');
const signedIn = document.getElementById('signed-in');
const unverified = document.getElementById('unverified-note');

const form = document.getElementById('comment-form');
const message = document.getElementById('form-message');
const bodyField = document.getElementById('body');
const replyingTo = document.getElementById('replying-to');
const cancelReply = document.getElementById('cancel-reply');

const nodePath = new URLSearchParams(window.location.search).get('node') || '';

let formToken = null;
let parentId = null;

// As on the queue page: every node is built and its text set with textContent.
// Comments are written by whoever posted them.
function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
}

// Load ------------------------------------------------------------------------

(async () => {
    if (!nodePath) {
        hide(loading);
        show(noNode);
        return;
    }

    document.getElementById('node-label').textContent = nodePath;
    const link = document.getElementById('node-link');
    link.href = `/atlas/${nodePath}/`;
    link.textContent = `Read ${nodePath} →`;

    await loadThread();

    hide(loading);
    show(threadWrap);

    const me = await request('GET', '/me');
    if (!me.ok) {
        show(signedOut);
        setCsrfToken(null);
        return;
    }
    setCsrfToken(me.data.csrfToken);
    show(signedIn);

    if (me.data.account && !me.data.account.verified) {
        show(unverified);
        for (const field of form.elements) field.disabled = true;
    }

    const issued = await request('GET', '/comments/new');
    if (issued.ok) formToken = issued.data.formToken;
})();

// The thread ------------------------------------------------------------------
//
// Published comments only — the endpoint returns nothing else. Threaded one
// level: every reply hangs off a top-level comment, and the shape of the data
// cannot go deeper because the database will not let it.
async function loadThread() {
    const { ok, data } = await request('GET', '/comments');
    thread.replaceChildren();
    if (!ok) return;

    const mine = data.comments.filter((c) => c.nodePath === nodePath);
    const tops = mine.filter((c) => c.parentId === null);
    const repliesTo = new Map();
    for (const c of mine) {
        if (c.parentId === null) continue;
        if (!repliesTo.has(c.parentId)) repliesTo.set(c.parentId, []);
        repliesTo.get(c.parentId).push(c);
    }

    if (!tops.length) {
        show(threadEmpty);
        return;
    }
    hide(threadEmpty);

    for (const top of tops) {
        const block = el('article', 'comment');
        block.append(meta(top), el('p', 'comment__body', top.body));

        const reply = el('button', 'comment__reply', 'Reply');
        reply.type = 'button';
        reply.addEventListener('click', () => startReply(top));
        block.append(reply);

        for (const child of repliesTo.get(top.id) || []) {
            const sub = el('article', 'comment comment--reply');
            sub.append(meta(child), el('p', 'comment__body', child.body));
            block.append(sub);
        }

        thread.append(block);
    }
}

function meta(comment) {
    return el('p', 'comment__meta',
        `${comment.author} · ${String(comment.createdAt).slice(0, 10)}`);
}

function startReply(top) {
    parentId = top.id;
    replyingTo.textContent =
        `Replying to ${top.author}: “${top.body.slice(0, 90)}${top.body.length > 90 ? '…' : ''}”`;
    show(replyingTo);
    show(cancelReply);
    bodyField.focus();
}

cancelReply.addEventListener('click', () => {
    parentId = null;
    hide(replyingTo);
    hide(cancelReply);
});

// Count -----------------------------------------------------------------------

const count = document.getElementById('body-count');
function paintCount() {
    const used = bodyField.value.trim().length;
    count.textContent = `${used} / 2000`;
    count.className = 'form__count' + (used > 2000 ? ' form__count--over' : '');
}
bodyField.addEventListener('input', paintCount);
paintCount();

// Post ------------------------------------------------------------------------

onSubmit(form, message, async (data) => {
    if (!formToken) {
        say(message, 'This form did not finish loading. Reload the page.', 'error');
        return;
    }

    const { ok, status, data: body } = await request('POST', '/comments', {
        nodePath,
        parentId,
        body: data.get('body'),
        displayAs: data.get('displayAs'),
        formToken,
        website: data.get('website'),
    });

    if (!ok) {
        say(message, body.error || 'Could not post the comment.', 'error');
        if (status === 400) {
            const again = await request('GET', '/comments/new');
            if (again.ok) formToken = again.data.formToken;
        }
        return;
    }

    form.reset();
    paintCount();
    parentId = null;
    hide(replyingTo);
    hide(cancelReply);
    say(message, body.message || 'Posted.', 'ok');

    const next = await request('GET', '/comments/new');
    formToken = next.ok ? next.data.formToken : null;
});
