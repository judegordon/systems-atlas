//
// GET /atlas/admin/ping
//
// Build step 5 in docs/ACCOUNTS.md: "Admin flag and an admin-only ping
// endpoint, to prove the check works." It does nothing else, and there is
// nothing else here to do — moderation is a later document.
//
const express = require('express');

const router = express.Router();

router.get('/ping', require('../middleware/session').requireAdmin, (req, res) => {
    res.json({
        ok: true,
        account: req.account.displayName,
        checkedAt: new Date().toISOString(),
    });
});

module.exports = router;
