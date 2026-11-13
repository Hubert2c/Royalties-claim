// =============================================================================
// routes/admin/index.js — API for the Government administration console
// -----------------------------------------------------------------------------
// "admin"   (Rwanda Intellectual Property Office) can read AND change things.
// "auditor" (independent auditor / Parliament) can only READ.
//
// Covers functional requirements:
//   FR-3  approve licences (issue invoices and clearance codes)
//   FR-5  airplay detection (incl. a "simulate airplay" demo)
//   FR-6  calculate royalties per period
//   FR-7  approve tariffs, licences and distribution runs before payment
//   FR-8  pay out (simulated) and produce statements
//   FR-9  decide claims on unmatched usage
//   FR-10 resolve disputes
//   FR-11 audit log (with hash-chain verification)
//   FR-13 API keys for monitors
// Plus the compliance view from the flowchart (Figure 7): who used music
// without a paid licence.
//
// Each area lives in its own file in this folder; this file only puts them
// together behind the login and role checks.
// =============================================================================

const express = require('express');
const { authRequired } = require('../../lib/security/auth');
const { readAccess } = require('./access');

const router = express.Router();
router.use(authRequired, readAccess);

router.use(require('./overview'));
router.use(require('./tariffs'));
router.use(require('./licences'));
router.use(require('./usage'));
router.use(require('./claims'));
router.use(require('./runs'));
router.use(require('./settings'));

module.exports = router;
