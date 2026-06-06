const express    = require('express');
const router     = express.Router();
const OAuthToken = require('../models/OAuthToken');
const Client     = require('../models/Client');

// ── POST /api/license/link ─────────────────────────────────────────────────
// Called by purchase page after Razorpay payment is verified by LMS.
// Links the LMS license to the Bitrix24 portal via clientId or bitrixDomain.
//
// Body: { clientId, bitrixDomain, customerEmail, licenseId, licensePlan, licenseStatus }
router.post('/link', async (req, res) => {
  try {
    const {
      clientId,
      bitrixDomain,
      customerEmail,
      licenseId,
      licensePlan,
      licenseStatus,
    } = req.body;

    if (!customerEmail || !licenseId) {
      return res.status(400).json({
        success: false,
        message: 'customerEmail and licenseId are required',
      });
    }

    if (!clientId && !bitrixDomain) {
      return res.status(400).json({
        success: false,
        message: 'clientId or bitrixDomain is required',
      });
    }

    // Find the OAuthToken record for this portal
    const filter = clientId ? { clientId } : { bitrixDomain };
    const update = {
      customerEmail,
      licenseId,
      licensePlan:    licensePlan    || '',
      licenseStatus:  licenseStatus  || 'active',
      licenseLinkedAt: new Date(),
      updatedAt:      new Date(),
    };

    const token = await OAuthToken.findOneAndUpdate(filter, update, {
      new: true,
      upsert: false,
    });

    if (!token) {
      return res.status(404).json({
        success: false,
        message: 'No Bitrix24 portal found for this clientId/domain. Make sure the app is installed first.',
      });
    }

    // Also update the Client record so agent fetches the right email
    await Client.findOneAndUpdate(
      { clientId: token.clientId },
      { email: customerEmail, updatedAt: new Date() }
    );

    console.log(`[License] Linked license ${licenseId} (${licensePlan}) to portal ${token.bitrixDomain} | email: ${customerEmail}`);

    res.json({
      success: true,
      clientId:     token.clientId,
      bitrixDomain: token.bitrixDomain,
      customerEmail,
      licenseId,
      licensePlan,
      licenseStatus,
    });

  } catch (err) {
    console.error('[License] Link error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/license/status?clientId=xxx ──────────────────────────────────
// Called by the agent on startup and by the dashboard to check license state.
// Returns the linked email + licenseId so agent can call LMS without env var.
router.get('/status', async (req, res) => {
  try {
    const { clientId, bitrixDomain } = req.query;

    if (!clientId && !bitrixDomain) {
      return res.status(400).json({ success: false, message: 'clientId or bitrixDomain required' });
    }

    const filter = clientId ? { clientId } : { bitrixDomain };
    const token  = await OAuthToken.findOne(filter).lean();

    if (!token) {
      return res.json({ success: false, linked: false, message: 'Portal not found' });
    }

    const isLinked = !!(token.customerEmail && token.licenseId);

    res.json({
      success:       true,
      linked:        isLinked,
      clientId:      token.clientId,
      bitrixDomain:  token.bitrixDomain,
      customerEmail: token.customerEmail || '',
      licenseId:     token.licenseId     || '',
      licensePlan:   token.licensePlan   || '',
      licenseStatus: token.licenseStatus || '',
      licenseLinkedAt: token.licenseLinkedAt || null,
    });

  } catch (err) {
    console.error('[License] Status error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/license/email?clientId=xxx ───────────────────────────────────
// Lightweight endpoint called by agent during registerClient().
// Returns just the customerEmail so agent can call validateLicense(email)
// without relying on process.env.CUSTOMER_EMAIL.
router.get('/email', async (req, res) => {
  try {
    const { clientId } = req.query;
    if (!clientId) return res.status(400).json({ success: false, message: 'clientId required' });

    const token = await OAuthToken.findOne({ clientId }).lean();

    if (!token || !token.customerEmail) {
      return res.json({ success: false, email: null, message: 'No license linked yet' });
    }

    res.json({ success: true, email: token.customerEmail, licenseId: token.licenseId });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/license/unlink ──────────────────────────────────────────────
// Clears the license link — used when license expires or is transferred.
router.post('/unlink', async (req, res) => {
  try {
    const { clientId, bitrixDomain } = req.body;
    const filter = clientId ? { clientId } : { bitrixDomain };

    await OAuthToken.findOneAndUpdate(filter, {
      customerEmail:   '',
      licenseId:       '',
      licensePlan:     '',
      licenseStatus:   'unlinked',
      updatedAt:       new Date(),
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;