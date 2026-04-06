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

async function handleCallback(req, res) {
  // HEAD request — Bitrix24 checks endpoint is alive before POST
  if (req.method === 'HEAD') {
    return res.status(200).end();
  }

  console.log('[OAuth] Callback hit — method:', req.method);
  console.log('[OAuth] Query params:', req.query);
  console.log('[OAuth] Body:', req.body);

  // ── Bitrix24 App Install flow (POST with AUTH_ID directly in body) ──
  const AUTH_ID      = req.body.AUTH_ID;
  const REFRESH_ID   = req.body.REFRESH_ID;
  const AUTH_EXPIRES = req.body.AUTH_EXPIRES;
  const MEMBER_ID    = req.body.member_id;
  const SERVER_ENDPOINT = req.body.SERVER_ENDPOINT; // e.g. https://oauth.bitrix.info/rest/
  const DOMAIN       = req.query.DOMAIN || req.body.DOMAIN;

  // ── Standard OAuth2 code flow (GET redirect from Bitrix24 marketplace) ──
  const code         = req.query.code || req.body.code;
  const domain       = req.query.domain || req.body.domain || DOMAIN;

  // Detect which flow we are in
  const isDirectTokenFlow = !!(AUTH_ID && MEMBER_ID);
  const isCodeFlow        = !!(code && domain);

  if (!isDirectTokenFlow && !isCodeFlow) {
    console.error('[OAuth] Missing required params', {
      AUTH_ID: !!AUTH_ID, MEMBER_ID: !!MEMBER_ID, code: !!code, domain: !!domain
    });
    return res.status(400).send(`
      <html><body style="font-family:Arial;text-align:center;padding:60px">
        <h2>❌ Missing Parameters</h2>
        <p>Expected either AUTH_ID+member_id (app install) or code+domain (OAuth redirect).</p>
        <p style="font-size:12px;color:#999;">
          method: ${req.method} | 
          query keys: ${Object.keys(req.query).join(', ')} | 
          body keys: ${Object.keys(req.body).join(', ')}
        </p>
      </body></html>
    `);
  }

  try {
    let access_token, refresh_token, expires_in, bitrixDomain, clientId, expiresAt, bitrixUrl;

    if (isDirectTokenFlow) {
      // ── App Install flow: Bitrix24 sends tokens directly ──
      console.log('[OAuth] Direct token flow detected (app install)');

      access_token  = AUTH_ID;
      refresh_token = REFRESH_ID;
      expires_in    = parseInt(AUTH_EXPIRES) || 3600;
      bitrixDomain  = DOMAIN || `portal-${MEMBER_ID}`;
      clientId      = `bx-${MEMBER_ID}`;
      expiresAt     = new Date(Date.now() + expires_in * 1000);

      // SERVER_ENDPOINT is like https://oauth.bitrix.info/rest/
      // The actual REST base for this portal is in the DOMAIN query param
      bitrixUrl = DOMAIN
        ? `https://${DOMAIN}/rest/`
        : (SERVER_ENDPOINT || '');

    } else {
      // ── Standard OAuth2 code exchange flow ──
      console.log('[OAuth] Code exchange flow detected');

      const tokenRes = await axios.post(`https://oauth.bitrix.info/oauth/token/`, null, {
        params: {
          grant_type:    'authorization_code',
          client_id:     CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code,
          redirect_uri:  `${APP_URL}/bitrix/oauth/callback`,
        },
        timeout: 10000,
      });

      console.log('[OAuth] Token response:', tokenRes.data);

      const { access_token: at, refresh_token: rt, expires_in: ei, user_id, member_id: tokenMemberId } = tokenRes.data;
      access_token  = at;
      refresh_token = rt;
      expires_in    = ei;
      bitrixDomain  = domain;
      clientId      = `bx-${tokenMemberId || MEMBER_ID || domain.replace(/\./g, '-')}`;
      expiresAt     = new Date(Date.now() + expires_in * 1000);
      bitrixUrl     = `https://${bitrixDomain}/rest/${user_id}/${access_token}/`;
    }

    if (!access_token) throw new Error('No access_token in response');

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

    // ── Step 6: Show success page ──
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
            Download the desktop app below to start syncing with Tally.
          </p>
          <a href="https://github.com/MrunmayeeCom/tally_bitrix_middleware/releases/latest/download/TallyBitrixSync.Setup.exe"
             style="display:inline-block;margin-top:12px;padding:12px 28px;
             background:#2d6ae0;color:#fff;border-radius:8px;text-decoration:none;
             font-size:14px;font-weight:600;">
            ⬇ Download TallyBitrixSync.exe
          </a>
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
}

// Bitrix24 sends HEAD to verify endpoint, then POST with tokens (app install)
// or GET with code (OAuth redirect from marketplace)
router.head('/callback', (req, res) => res.status(200).end());
router.post('/callback', handleCallback);
router.get('/callback',  handleCallback);

// ── Token refresh helper ──
async function getValidToken(bitrixDomain) {
  const record = await OAuthToken.findOne({ bitrixDomain });
  if (!record) throw new Error(`No token for domain: ${bitrixDomain}`);

  if (record.expiresAt < new Date(Date.now() + 5 * 60 * 1000)) {
    const res = await axios.post(`https://oauth.bitrix.info/oauth/token/`, null, {
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

// GET /bitrix/oauth/status — polling endpoint for Electron app
router.get('/status', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.json({ success: false, connected: false });

    // Look for a token updated in the last 10 minutes
    // (bumped from 5min because app-install flow can take longer)
    const allTokens = await OAuthToken.find({}).sort({ updatedAt: -1 }).limit(1);
    if (allTokens.length > 0) {
      const t = allTokens[0];
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      if (t.updatedAt > tenMinutesAgo) {
        return res.json({ success: true, connected: true, domain: t.bitrixDomain, clientId: t.clientId });
      }
    }
    return res.json({ success: false, connected: false });
  } catch(e) {
    res.json({ success: false, connected: false });
  }
});

// GET /bitrix/oauth/tokens — debug
router.get('/tokens', async (req, res) => {
  const tokens = await OAuthToken.find({}, { accessToken: 0, refreshToken: 0 }).lean();
  res.json({ success: true, count: tokens.length, tokens });
});

module.exports = router;
module.exports.getValidToken = getValidToken;