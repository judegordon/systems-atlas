//
// Comments: the bounds, and the one public shape.
//
// docs/PROPOSALS.md §5. "Every node carries a thread. One level of replies, no
// deeper — nested argument past that point wants to be a proposal."
//
// The depth rule is enforced by a trigger in 003_comments.sql rather than here,
// because it has to hold for anything that writes the table. What is here is
// what a person needs told back to them when they get it wrong.
//
const BODY_MAX = 2000;          // §5

function bodyProblem(value) {
    if (typeof value !== 'string' || value.trim() === '') {
        return 'A comment needs something in it.';
    }
    if (value.trim().length > BODY_MAX) {
        return `A comment is limited to ${BODY_MAX} characters. `
             + 'An argument longer than that is a proposal.';
    }
    return null;
}

function parentProblem(value) {
    if (value === undefined || value === null || value === '') return null;
    if (!/^\d+$/.test(String(value))) return 'That is not a comment to reply to.';
    return null;
}

// The public shape, for the build. Same two rules as a proposal, in the same
// order and for the same reason: anonymous wins over withdrawn, so that
// deleting an account cannot turn an Anonymous comment into a Withdrawn one
// and disclose something to anyone who had read both.
function publicComment(row) {
    let author;
    if (row.display_as === 'anonymous') author = 'Anonymous';
    else if (row.withdrawn_at) author = 'Withdrawn';
    else author = row.display_name;

    return {
        id: String(row.id),
        nodePath: row.node_path,
        parentId: row.parent_id === null ? null : String(row.parent_id),
        author,
        body: row.body,
        createdAt: row.created_at,
    };
}

module.exports = {
    BODY_MAX,
    bodyProblem,
    parentProblem,
    publicComment,
};
