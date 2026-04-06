const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const OAuthToken = require('../models/OAuthToken');
const Client     = require('../models/Client');

const CLIENT_ID     = process.env.BITRIX_CLIENT_ID;
const CLIENT_SECRET = process.env.BITRIX_CLIENT_SECRET;
const APP_URL       = process.env.APP_URL;

const EVENTS_TO_BIND = [
  'ONCRMCONTACTADD',    'ONCRMCONTACTUPDATE',
  'ONCRMCOMPANYADD',    'ONCRMCOMPANYUPDATE',
  'ONCRMINVOICEADD',    'ONCRMINVOICEUPDATE',
  'ONCRMSMARTINVOICEADD', 'ONCRMSMARTINVOICEUPDATE',
  'ONCRMQUOTEADD',      'ONCRMQUOTEUPDATE',
];

// ── Step 1: Bitrix24 redirects here after client installs app ──
// GET /bitrix/oauth/callback?code=xxx&domain=xxx&member_id=xxx
router.get('/callback', async (req, res) => {
  const { code, domain, member_id, server_domain } = req.query;

  if (!code || !domain) {
    return res.status(400).send(`
      <html><body style="font-family:Arial;text-align:center;padding:60px">
        <h2>❌ Missing Parameters</h2>
        <p>code or domain missing from Bitrix24 redirect.</p>
      </body></html>
    `);
  }

  try {
    // ── Step 2: Exchange code for tokens ──
    const tokenRes = await axios.get(`https://${domain}/oauth/token/`, {
      params: {
        grant_type:    'authorization_code',
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri:  `${APP_URL}/bitrix/oauth/callback`,
      },
      timeout: 10000,
    });

    const {
      access_token,
      refresh_token,
      expires_in,
      user_id,
      member_id: tokenMemberId,
    } = tokenRes.data;

    if (!access_token) throw new Error('No access_token in response');

    const bitrixDomain = domain;
    const bitrixUrl    = `https://${bitrixDomain}/rest/${user_id}/${access_token}/`;
    const clientId     = `bx-${tokenMemberId || member_id || domain.replace(/\./g, '-')}`;
    const expiresAt    = new Date(Date.now() + (expires_in * 1000));

    // ── Step 3: Save tokens to MongoDB ──
    await OAuthToken.findOneAndUpdate(
      { bitrixDomain },
      {
        clientId,
        bitrixDomain,
        accessToken:  access_token,
        refreshToken: refresh_token,
        expiresAt,
        memberId:     tokenMemberId || member_id,
        updatedAt:    new Date(),
      },
      { upsert: true, new: true }
    );

    // ── Step 4: Upsert Client record ──
    await Client.findOneAndUpdate(
      { clientId },
      { clientId, email: '', bitrixUrl, bitrixDomain, lastSeenAt: new Date(), isActive: true },
      { upsert: true, new: true }
    );

    // ── Step 5: Register all event webhooks ──
    const webhookBase = `${APP_URL}/webhook?clientId=${clientId}`;
    let allOk = true;

    for (const event of EVENTS_TO_BIND) {
      try {
        await axios.post(
          `https://${bitrixDomain}/rest/${user_id}/${access_token}/event.bind.json`,
          { event, handler: webhookBase },
          { timeout: 8000 }
        );
        console.log(`[OAuth] ✓ Registered ${event}`);
      } catch (e) {
        console.warn(`[OAuth] Failed to register ${event}:`, e.response?.data || e.message);
        allOk = false;
      }
    }

    await OAuthToken.updateOne({ bitrixDomain }, { webhooksRegistered: allOk });
    await Client.updateOne({ clientId }, { webhooksRegistered: allOk });

    console.log(`[OAuth] Installation complete — domain: ${bitrixDomain} | clientId: ${clientId}`);

    // ── Step 6: Show success page to client ──
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8"/>
        <style>
          body { font-family: Arial, sans-serif; background: #f4f6fa;
                 display: flex; align-items: center; justify-content: center;
                 min-height: 100vh; margin: 0; }
          .box { background: #fff; border-radius: 12px; padding: 48px;
                 text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,.08);
                 max-width: 460px; }
          h2  { color: #0a8a5c; margin-bottom: 8px; }
          p   { color: #555; line-height: 1.6; }
          .check { font-size: 56px; margin-bottom: 16px; }
          ul  { text-align: left; color: #333; line-height: 2; }
        </style>
      </head>
      <body>
        <div class="box">
          <div class="check">✅</div>
          <h2>TallyBitrixSync Connected!</h2>
          <p>Your Bitrix24 portal <strong>${bitrixDomain}</strong> is now linked.</p>
          <ul>
            <li>✓ CRM events registered</li>
            <li>✓ Contact & Company sync active</li>
            <li>✓ Invoice sync active</li>
            <li>✓ Quote sync active</li>
          </ul>
          <p style="margin-top:16px;color:#888;font-size:13px;">
            You can now close this tab and open your TallyBitrixSync desktop app.
          </p>
        </div>
      </body>
      </html>
    `);

  } catch (err) {
    console.error('[OAuth] Callback error:', err.response?.data || err.message);
    res.status(500).send(`
      <html><body style="font-family:Arial;text-align:center;padding:60px">
        <h2>❌ Connection Failed</h2>
        <p>${err.message}</p>
        <p>Please try installing the app again or contact support.</p>
      </body></html>
    `);
  }
});

// ── Token refresh helper (call before any API request) ──
async function getValidToken(bitrixDomain) {
  const record = await OAuthToken.findOne({ bitrixDomain });
  if (!record) throw new Error(`No token for domain: ${bitrixDomain}`);

  // Refresh if expiring within 5 minutes
  if (record.expiresAt < new Date(Date.now() + 5 * 60 * 1000)) {
    const res = await axios.get(`https://${bitrixDomain}/oauth/token/`, {
      params: {
        grant_type:    'refresh_token',
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: record.refreshToken,
      },
      timeout: 10000,
    });

    const { access_token, refresh_token, expires_in } = res.data;
    await OAuthToken.updateOne(
      { bitrixDomain },
      {
        accessToken:  access_token,
        refreshToken: refresh_token,
        expiresAt:    new Date(Date.now() + expires_in * 1000),
        updatedAt:    new Date(),
      }
    );
    return access_token;
  }

  return record.accessToken;
}

// GET /bitrix/oauth/tokens — debug: list all connected portals
router.get('/tokens', async (req, res) => {
  const tokens = await OAuthToken.find({}, { accessToken: 0, refreshToken: 0 }).lean();
  res.json({ success: true, count: tokens.length, tokens });
});

module.exports = router;
module.exports.getValidToken = getValidToken;