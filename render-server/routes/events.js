const express = require('express');
const router  = express.Router();
const Event   = require('../models/Event');
const Client  = require('../models/Client');

// POST /api/clients/register
// Called by client machine after installation
router.post('/clients/register', async (req, res) => {
  try {
    const { clientId, email, bitrixUrl } = req.body;

    if (!clientId || !email || !bitrixUrl) {
      return res.status(400).json({
        success: false,
        message: 'clientId, email and bitrixUrl are required'
      });
    }

    // Extract domain from bitrixUrl
    const bitrixDomain = new URL(bitrixUrl).hostname;

    // Upsert client
    await Client.findOneAndUpdate(
      { clientId },
      {
        clientId,
        email,
        bitrixUrl,
        bitrixDomain,
        lastSeenAt: new Date(),
        isActive: true,
      },
      { upsert: true, new: true }
    );

    // Register webhooks in Bitrix24 using client's inbound URL
    const webhookResult = await registerBitrixWebhooks(bitrixUrl, clientId);

    console.log(`[Register] Client registered: ${clientId} | ${email} | webhooks: ${webhookResult}`);

    res.json({
      success: true,
      clientId,
      webhooksRegistered: webhookResult,
      message: webhookResult
        ? 'Client registered and webhooks configured'
        : 'Client registered — webhook registration failed, will retry'
    });

  } catch (err) {
    console.error('[Register] Error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/events/pending?clientId=xxx
// Client polls this every 5 seconds to get unprocessed events
router.get('/events/pending', async (req, res) => {
  try {
    const { clientId } = req.query;

    if (!clientId) {
      return res.status(400).json({ success: false, message: 'clientId required' });
    }

    // Update client last seen
    await Client.updateOne({ clientId }, { lastSeenAt: new Date() });

    // Get up to 10 unprocessed events for this client
    const events = await Event.find({
      clientId,
      processed: false,
    })
    .sort({ createdAt: 1 }) // oldest first
    .limit(10);

    res.json({
      success: true,
      count: events.length,
      events: events.map(e => ({
        eventId:   e._id.toString(),
        eventType: e.eventType,
        payload:   e.payload,
        createdAt: e.createdAt,
      }))
    });

  } catch (err) {
    console.error('[Events] Pending error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/events/confirm
// Client confirms it has processed these events
router.post('/events/confirm', async (req, res) => {
  try {
    const { clientId, eventIds } = req.body;

    if (!clientId || !eventIds || !eventIds.length) {
      return res.status(400).json({
        success: false,
        message: 'clientId and eventIds required'
      });
    }

    await Event.updateMany(
      { _id: { $in: eventIds }, clientId },
      { processed: true, processedAt: new Date() }
    );

    console.log(`[Events] Confirmed ${eventIds.length} events for client: ${clientId}`);

    res.json({ success: true, confirmed: eventIds.length });

  } catch (err) {
    console.error('[Events] Confirm error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/clients/status?clientId=xxx
// Check if client is registered
router.get('/clients/status', async (req, res) => {
  try {
    const { clientId } = req.query;
    const client = await Client.findOne({ clientId });

    if (!client) {
      return res.json({ success: false, registered: false });
    }

    res.json({
      success: true,
      registered: true,
      webhooksRegistered: client.webhooksRegistered,
      lastSeenAt: client.lastSeenAt,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Register webhooks in Bitrix24 ──────────────────────────────────────────
async function registerBitrixWebhooks(bitrixUrl, clientId) {
  const APP_URL = process.env.APP_URL;
  if (!APP_URL) {
    console.warn('[Webhooks] APP_URL not set — skipping webhook registration');
    return false;
  }

  const handlerBase = `${APP_URL}/webhook?clientId=${clientId}`;

  const events = [
    'ONCRMCONTACTADD',
    'ONCRMCONTACTUPDATE',
    'ONCRMCOMPANYADD',
    'ONCRMCOMPANYUPDATE',
    'ONCRMINVOICEADD',
    'ONCRMINVOICEUPDATE',
    'ONCRMSMARTINVOICEADD',
    'ONCRMSMARTINVOICEUPDATE',
    'ONCRMQUOTEADD',
    'ONCRMQUOTEUPDATE',
  ];

  try {
    const axios = require('axios');
    let allOk = true;

    for (const event of events) {
      try {
        const url = bitrixUrl.replace(/\/$/, '') + '/event.bind';
        await axios.post(url, {
          event,
          handler: handlerBase,
        });
        console.log(`[Webhooks] Registered: ${event}`);
      } catch (e) {
        console.warn(`[Webhooks] Failed to register ${event}: ${e.message}`);
        allOk = false;
      }
    }

    // Mark webhooks as registered in DB
    await Client.updateOne(
      { clientId },
      { webhooksRegistered: allOk }
    );

    return allOk;
  } catch (err) {
    console.error('[Webhooks] Registration error:', err.message);
    return false;
  }
}

module.exports = router;