const express = require('express');
const router  = express.Router();
const Event   = require('../models/Event');
const Client  = require('../models/Client');

// POST /webhook
// Receives all Bitrix24 events — auto-routes to correct client by domain or falls back to most recent
router.post('/', async (req, res) => {
  try {
    const clientIdParam = req.query.clientId;
    const payload       = req.body;
    const eventType     = payload?.event;

    console.log('[Webhook] Incoming hit — clientId:', clientIdParam || 'NONE', '| event:', eventType || 'none', '| ip:', req.ip);

    // Identify which client this belongs to
    // Priority: 1) clientId in query param, 2) match by bitrixDomain, 3) most recently active client
    let client = null;

    if (clientIdParam) {
      client = await Client.findOne({ clientId: clientIdParam, isActive: true });
      if (!client) {
        console.warn(`[Webhook] clientId "${clientIdParam}" not found — falling back to domain match`);
      }
    }

    if (!client) {
      // Try to match by Bitrix24 domain from the incoming request
      // Bitrix24 sends the portal domain in the payload as auth.domain
      const bitrixDomain = payload?.auth?.domain || payload?.DOMAIN || '';
      if (bitrixDomain) {
        // Prefer OAuthToken lookup — it always has the canonical bx-{memberId} clientId
        // Client collection may have the stale domain-based clientId from old installs
        try {
          const OAuthToken = require('../models/OAuthToken');
          const oauthToken = await OAuthToken.findOne({ bitrixDomain }).lean();
          if (oauthToken?.clientId) {
            client = await Client.findOne({ clientId: oauthToken.clientId, isActive: true });
            if (!client) {
              // Client record may not exist yet — upsert it with canonical clientId
              client = await Client.findOneAndUpdate(
                { clientId: oauthToken.clientId },
                { clientId: oauthToken.clientId, bitrixDomain, isActive: true, lastSeenAt: new Date() },
                { upsert: true, new: true }
              );
            }
            if (client) {
              console.log(`[Webhook] Matched client via OAuthToken domain: ${bitrixDomain} → ${client.clientId}`);
            }
          }
        } catch (e) {
          console.error('[Webhook] OAuthToken domain lookup failed:', e.message);
        }
        // Fallback to Client collection direct lookup
        if (!client) {
          client = await Client.findOne({ bitrixDomain, isActive: true });
          if (client) {
            console.log(`[Webhook] Matched client by domain (Client collection): ${bitrixDomain} → ${client.clientId}`);
          }
        }
      }
    }

    if (!client) {
      // Last resort — use most recently active client
      client = await Client.findOne({ isActive: true }).sort({ lastSeenAt: -1 });
      if (client) {
        console.log(`[Webhook] No clientId or domain match — using most recently active client: ${client.clientId}`);
      }
    }

    if (!client) {
      console.error('[Webhook] No active clients registered — start your local service first');
      return res.status(200).json({ success: true });
    }

    // Update last seen
    await Client.updateOne({ _id: client._id }, { lastSeenAt: new Date() });

    if (!eventType) {
      return res.status(200).json({ success: true, message: 'No event type' });
    }

    // Store event in MongoDB under the resolved client
    const stored = await Event.create({
      clientId: client.clientId,
      eventType,
      payload,
      processed: false,
    });

    console.log(`[Webhook] ✓ Stored event: ${eventType} for client: ${client.clientId} | eventId: ${stored._id}`);

    // Always return 200 immediately — client processes async
    res.status(200).json({ success: true });

  } catch (err) {
    console.error('[Webhook] Error:', err.message);
    res.status(200).json({ success: true });
  }
});

module.exports = router;