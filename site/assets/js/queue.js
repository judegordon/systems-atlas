import { request, say, setCsrfToken, show, hide } from './api.js';

const loading = document.getElementById('loading');
const denied = document.getElementById('denied');
const queue = document.getElementById('queue');
const summary = document.getElementById('queue-summary');
const list = document.getElementById('items');
const empty = document.getElementById('empty');

// Everything below builds nodes and sets textContent. Nothing on this page is
// assembled by string concatenation into innerHTML, and that is not a style
// preference: the case and the argument are written by whoever submitted them,
// and this is the one page where an administrator's session is in the room.
function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
}

// docs/PROPOSALS.md §6: "Prewritten per rule, each editable before sending.
// The point is that a rejection should say which rule and why this submission
// fails it, not 'thanks but no'." These are openings, not verdicts — every one
// of them stops where the specific argument has to start.
const CANNED = {
    '': '',
    '01': 'The division this would produce goes past the ceiling of seven, and the '
        + 'ceiling is the cautious end of Miller rather than a target. What would you '
        + 'drop or combine?\n\nSpecifically: ',
    '02': 'The components overlap: the case you describe belongs to more than one of '
        + 'them, which means the division is not doing the work of separating them.\n\n'
        + 'Specifically: ',
    '03': 'The case is real, but it sits inside what the division already claims to '
        + 'cover rather than outside it.\n\nSpecifically: ',
    '04': 'The parts here answer different question types, so the case is not a break '
        + 'in the division so much as evidence the level is mixed.\n\nSpecifically: ',
    '05': 'This asks a node to be both divided and an endpoint.\n\nSpecifically: ',
    '06': 'The case is stated but not justified — there is nothing here a reader could '
        + 'check or disagree with precisely.\n\nSpecifically: ',
};

let rules = [];

// Load ------------------------------------------------------------------------

(async () => {
    const me = await request('GET', '/me');
    hide(loading);

    if (!me.ok) {
        show(denied);
        setCsrfToken(null);
        return;
    }
    setCsrfToken(me.data.csrfToken);

    if (!me.data.account || !me.data.account.isAdmin) {
        show(denied);
        return;
    }

    show(queue);
    await load();
})();

async function load() {
    const { ok, data } = await request('GET', '/admin/queue');
    if (!ok) {
        summary.textContent = 'Could not read the queue.';
        return;
    }

    rules = data.rules || [];
    list.replaceChildren();

    const comments = data.comments || [];
    const parts = [];
    if (data.items.length) {
        parts.push(`${data.items.length} proposal${data.items.length === 1 ? '' : 's'}`);
    }
    if (comments.length) {
        parts.push(`${comments.length} comment${comments.length === 1 ? '' : 's'}`);
    }
    summary.textContent = parts.length ? `${parts.join(' and ')} waiting.` : '';

    if (!data.items.length && !comments.length) {
        show(empty);
        return;
    }
    hide(empty);

    for (const item of data.items) list.append(render(item));
    for (const item of comments) list.append(renderComment(item));
}

// Render ----------------------------------------------------------------------

function render(item) {
    const article = el('article', 'queue-item');

    const head = el('header', 'queue-item__head');
    head.append(el('p', 'queue-item__meta',
        `#${item.id} · ${item.type} · submitted ${date(item.submission.createdAt)}`));

    const heading = el('h2', 'queue-item__node');
    const link = el('a', null, item.nodePath);
    link.href = `/atlas/${item.nodePath}/`;
    heading.append(link);
    head.append(heading);
    article.append(head);

    article.append(nodePanel(item.node, item.nodePath));
    article.append(submissionPanel(item.submission, item.type));
    article.append(accountPanel(item.account));
    article.append(decisionForm(item));

    return article;
}

// A pending comment. §5 gives it three states and no rule field, so the two
// actions are publish and reject, and only the rejection needs a reason —
// there is nothing to explain about letting an argument stand.
function renderComment(item) {
    const article = el('article', 'queue-item queue-item--comment');

    const head = el('header', 'queue-item__head');
    head.append(el('p', 'queue-item__meta',
        `#${item.id} · comment${item.parentId ? ' · reply' : ''} · `
        + `posted ${date(item.submission.createdAt)}`));

    const heading = el('h2', 'queue-item__node');
    const link = el('a', null, item.nodePath);
    link.href = `/atlas/${item.nodePath}/`;
    heading.append(link);
    head.append(heading);
    article.append(head);

    if (item.replyingTo) {
        const panel = el('section', 'queue-panel');
        panel.append(el('h3', 'queue-panel__title', 'Answering'));
        panel.append(el('pre', 'queue-body', item.replyingTo));
        article.append(panel);
    }

    const body = el('section', 'queue-panel');
    body.append(el('h3', 'queue-panel__title', 'The comment'));
    body.append(el('pre', 'queue-body', item.submission.body));
    body.append(el('p', 'queue-field__label',
        item.submission.displayAs === 'anonymous'
            ? 'To be published anonymously'
            : 'To be published under their display name'));
    article.append(body);

    const who = el('section', 'queue-panel');
    who.append(el('h3', 'queue-panel__title', 'Who sent it'));
    const facts = el('dl', 'queue-facts');
    for (const [k, v] of [
        ['Display name', item.account.displayName],
        ['Email', item.account.email],
        ['Verified', item.account.verified ? 'Yes' : 'No'],
        ['Joined', date(item.account.createdAt)],
    ]) {
        facts.append(el('dt', null, k), el('dd', null, v));
    }
    who.append(facts);
    article.append(who);

    article.append(commentDecision(item));
    return article;
}

function commentDecision(item) {
    const form = el('form', 'form queue-decision');
    form.append(el('p', 'queue-panel__title', 'Decide'));

    const row = el('div', 'form__row');
    const label = el('label', 'form__label', 'Reason — required to reject, published with it');
    const reason = el('textarea', 'form__input');
    reason.id = `comment-reason-${item.id}`;
    reason.maxLength = 4000;
    label.htmlFor = reason.id;
    row.append(label, reason);

    const buttons = el('div', 'queue-actions');
    const publish = el('button', 'form__button', 'Publish');
    publish.type = 'button';
    const reject = el('button', 'form__button form__button--quiet', 'Reject');
    reject.type = 'button';
    buttons.append(publish, reject);

    const message = el('p', 'form__message');
    message.setAttribute('role', 'status');
    message.setAttribute('aria-live', 'polite');

    form.append(row, buttons, message);

    const send = async (action) => {
        publish.disabled = true;
        reject.disabled = true;
        say(message, 'Working…', 'working');

        const payload = action === 'reject' ? { reason: reason.value } : {};
        const { ok, data } = await request(
            'POST', `/admin/comments/${item.id}/${action}`, payload);

        if (!ok) {
            say(message, data.error || 'Could not record the decision.', 'error');
            publish.disabled = false;
            reject.disabled = false;
            return;
        }
        say(message, `Recorded as ${data.comment.status}.`, 'ok');
        await load();
    };

    publish.addEventListener('click', () => send('publish'));
    reject.addEventListener('click', () => send('reject'));

    return form;
}

// The node as the atlas currently has it. Generated at build time and shipped
// with the API, so it is as current as the last deploy — the link above is the
// live page and is the thing to trust if the two disagree.
function nodePanel(node, path) {
    const panel = el('section', 'queue-panel');
    panel.append(el('h3', 'queue-panel__title', 'The node as it stands'));

    if (!node) {
        panel.append(el('p', 'queue-panel__gap',
            `${path} is not in the atlas any more. It was when the proposal was made.`));
        return panel;
    }

    panel.append(el('p', 'queue-panel__name', node.name));
    panel.append(el('p', null, node.definition || 'No definition. A declared gap.'));

    panel.append(fieldList('Includes', node.inclusion,
        'Nothing listed — a declared gap.'));

    panel.append(fieldList('Excludes',
        node.exclusion.map((e) => e.goesTo ? `${e.text} → ${e.goesTo}` : e.text),
        'Nothing listed — a declared gap.'));

    panel.append(fieldList(
        node.terminal ? 'Terminal' : `Divides into ${node.children.length}`,
        node.children.map((c) => c.name),
        node.terminal ? 'A declared endpoint.' : 'No children and not marked terminal.'));

    return panel;
}

function fieldList(label, values, whenEmpty) {
    const wrap = el('div', 'queue-field');
    wrap.append(el('p', 'queue-field__label', label));
    if (!values || !values.length) {
        wrap.append(el('p', 'queue-panel__gap', whenEmpty));
        return wrap;
    }
    const ul = el('ul', 'queue-field__list');
    for (const v of values) ul.append(el('li', null, v));
    wrap.append(ul);
    return wrap;
}

// Every type has an argument; what the argument is for differs, and a label
// that says "why the division cannot take it" above a relocation is a label
// that stopped being read.
const ARGUMENT_LABEL = {
    break: 'Why the division cannot take it',
    subdivide: 'Why these parts, and why this many',
    redefine: 'What is wrong with the current wording',
    relocate: 'Why it belongs under that parent',
    merge: 'Why these are not distinct',
};

// The whole payload, laid out per type. A subdivision cannot be judged from a
// one-line summary — the six fields of each proposed child are the submission.
function payloadDetail(type, payload) {
    const wrap = el('div', 'queue-field');
    if (!payload) return wrap;

    if (type === 'subdivide') {
        for (const child of payload.children || []) {
            const block = el('div', 'queue-child');
            block.append(el('p', 'queue-child__name', child.name));
            block.append(el('p', null, child.definition || 'No definition. A declared gap.'));
            for (const [key, label] of [
                ['inclusion', 'Includes'], ['exclusion', 'Excludes'],
                ['sources', 'Sources'], ['boundary_cases', 'Boundary cases'],
                ['uncertainty', 'Uncertainty'],
            ]) {
                if (child[key] && child[key].length) {
                    block.append(fieldList(label, child[key], ''));
                }
            }
            wrap.append(block);
        }
        return wrap;
    }

    if (type === 'redefine') {
        if (payload.definition) {
            wrap.append(el('p', 'queue-field__label', 'Proposed definition'));
            wrap.append(el('p', 'queue-body', payload.definition));
        }
        if (payload.inclusion) wrap.append(fieldList('Proposed inclusion', payload.inclusion, ''));
        if (payload.exclusion) wrap.append(fieldList('Proposed exclusion', payload.exclusion, ''));
        return wrap;
    }

    if (type === 'relocate') {
        wrap.append(el('p', 'queue-field__label', 'Proposed parent'));
        const p = el('p', null);
        const a = el('a', null, payload.newParent);
        a.href = `/atlas/${payload.newParent}/`;
        p.append(a);
        wrap.append(p);
        return wrap;
    }

    if (type === 'merge') {
        wrap.append(fieldList('Components to join', payload.siblings || [], ''));
        return wrap;
    }

    return wrap;      // break — the summary is the case, and that is all of it
}

function submissionPanel(submission, type) {
    const panel = el('section', 'queue-panel');
    panel.append(el('h3', 'queue-panel__title', 'The submission'));

    panel.append(el('p', 'queue-field__label', 'What it proposes'));
    panel.append(el('p', 'queue-case', submission.summary || '—'));
    panel.append(payloadDetail(type, submission.payload));

    panel.append(el('p', 'queue-field__label', ARGUMENT_LABEL[type] || 'The argument'));
    // Markdown is kept as written and shown as written. Rendering it would mean
    // turning contributor text into markup on the page that decides its fate.
    panel.append(el('pre', 'queue-body', submission.body));

    panel.append(fieldList('Sources', submission.sources,
        'None given. Allowed — a case nobody wrote up is still a case.'));

    panel.append(el('p', 'queue-field__label',
        submission.displayAs === 'anonymous'
            ? 'To be published anonymously'
            : 'To be published under their display name'));

    return panel;
}

function accountPanel(account) {
    const panel = el('section', 'queue-panel');
    panel.append(el('h3', 'queue-panel__title', 'Who sent it'));

    const facts = el('dl', 'queue-facts');
    const fact = (k, v) => {
        facts.append(el('dt', null, k));
        facts.append(el('dd', null, v));
    };
    fact('Display name', account.displayName);
    fact('Email', account.email);
    fact('Verified', account.verified ? 'Yes' : 'No');
    fact('Joined', date(account.createdAt));
    if (account.bio) fact('Bio', account.bio);

    const h = account.history || {};
    const parts = ['pending', 'accepted', 'rejected', 'superseded']
        .filter((k) => h[k])
        .map((k) => `${h[k]} ${k}`);
    fact('Proposals', parts.length ? parts.join(', ') : 'This is the first.');

    panel.append(facts);
    return panel;
}

// Decide ----------------------------------------------------------------------

function decisionForm(item) {
    const form = el('form', 'form queue-decision');
    form.append(el('p', 'queue-panel__title', 'Decide'));

    // Rule first, because choosing one fills the reason with its opening — the
    // order teaches which rule the rejection is about before the writing starts.
    const ruleRow = el('div', 'form__row');
    const ruleLabel = el('label', 'form__label', 'Which rule failed, if one did');
    const select = el('select', 'form__input');
    select.id = `rule-${item.id}`;
    ruleLabel.htmlFor = select.id;

    const none = el('option', null, 'No rule applies');
    none.value = '';
    select.append(none);
    for (const [id, name] of rules) {
        const option = el('option', null, `${id} — ${name}`);
        option.value = id;
        select.append(option);
    }
    ruleRow.append(ruleLabel, select);

    const reasonRow = el('div', 'form__row');
    const reasonLabel = el('label', 'form__label', 'Reason — published either way');
    const reason = el('textarea', 'form__input');
    reason.id = `reason-${item.id}`;
    reason.maxLength = 4000;
    reasonLabel.htmlFor = reason.id;
    const hint = el('p', 'form__hint',
        'Required for both. Say which rule and why this submission fails it.');
    reasonRow.append(reasonLabel, reason, hint);

    // Prewritten, and then edited. Only ever fills an empty box or one still
    // holding an untouched opening, so a half-written rejection is not wiped by
    // a change of mind about the rule.
    let untouched = '';
    select.addEventListener('change', () => {
        const next = CANNED[select.value] || '';
        if (reason.value.trim() === '' || reason.value === untouched) {
            reason.value = next;
            untouched = next;
        }
    });

    // §6's third action. It needs a target, so it carries its own field rather
    // than borrowing the rule select — a supersede names a proposal, not a rule.
    const replacedRow = el('div', 'form__row');
    const replacedLabel = el('label', 'form__label',
        'Superseded by — the proposal id that overtook it');
    const replacedBy = el('input', 'form__input');
    replacedBy.type = 'text';
    replacedBy.inputMode = 'numeric';
    replacedBy.id = `replaced-${item.id}`;
    replacedLabel.htmlFor = replacedBy.id;
    replacedRow.append(replacedLabel, replacedBy,
        el('p', 'form__hint', 'Only needed to supersede. It stays visible and links to that one.'));

    const buttons = el('div', 'queue-actions');
    const accept = el('button', 'form__button', 'Accept');
    accept.type = 'button';
    const reject = el('button', 'form__button form__button--quiet', 'Reject');
    reject.type = 'button';
    const supersede = el('button', 'form__button form__button--quiet', 'Supersede');
    supersede.type = 'button';
    buttons.append(accept, reject, supersede);

    const message = el('p', 'form__message');
    message.setAttribute('role', 'status');
    message.setAttribute('aria-live', 'polite');

    form.append(ruleRow, reasonRow, replacedRow, buttons, message);

    const send = async (status) => {
        accept.disabled = true;
        reject.disabled = true;
        supersede.disabled = true;
        say(message, 'Working…', 'working');

        const body = { reason: reason.value };
        if (status === 'reject' && select.value) body.rule = select.value;
        if (status === 'supersede') body.supersededBy = replacedBy.value.trim();

        const { ok, data } = await request(
            'POST', `/admin/proposals/${item.id}/${status}`, body);

        if (!ok) {
            say(message, data.error || 'Could not record the decision.', 'error');
            accept.disabled = false;
            reject.disabled = false;
            supersede.disabled = false;
            return;
        }

        say(message, `Recorded as ${data.proposal.status}.`, 'ok');
        form.querySelectorAll('select, textarea').forEach((f) => { f.disabled = true; });
        // Reloaded rather than removed, so the count and the ordering come from
        // the server and two open tabs cannot disagree about what is left.
        await load();
    };

    accept.addEventListener('click', () => send('accept'));
    reject.addEventListener('click', () => send('reject'));
    supersede.addEventListener('click', () => send('supersede'));

    return form;
}

function date(value) {
    return new Date(value).toISOString().slice(0, 10);
}
