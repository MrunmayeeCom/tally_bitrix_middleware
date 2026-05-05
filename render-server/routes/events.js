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

    console.log(`[Register] Client registered: ${clientId} | ${email} | domain: ${bitrixDomain}`);
    console.log(`[Register] Bitrix24 outbound webhook URL: ${process.env.APP_URL}/webhook`);

    res.json({
      success: true,
      clientId,
      webhooksRegistered: false,
      manualWebhookUrl: `${process.env.APP_URL}/webhook`,
      message: `Client registered. Set Bitrix24 outbound webhook URL to: ${process.env.APP_URL}/webhook`
    });

  } catch (err) {
    console.error('[Register] Error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Per-client in-flight set — tracks eventIds currently delivered but not yet confirmed
// Prevents re-delivering the same event in overlapping poll cycles
const _inFlightEvents = new Map(); // clientId → Set of eventId strings

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

    // Get in-flight set for this client
    if (!_inFlightEvents.has(clientId)) {
      _inFlightEvents.set(clientId, new Set());
    }
    const inFlight = _inFlightEvents.get(clientId);

    // Get up to 10 unprocessed events, excluding ones already delivered
    const allPending = await Event.find({
      clientId,
      processed: false,
    })
    .sort({ createdAt: 1 })
    .limit(50);

    // Filter out events currently in-flight (delivered but not yet confirmed)
    const events = allPending
      .filter(e => !inFlight.has(e._id.toString()))
      .slice(0, 10);

    // Mark these as in-flight
    events.forEach(e => inFlight.add(e._id.toString()));

    // Auto-expire in-flight entries after 30s in case client crashes without confirming
    events.forEach(e => {
      const eid = e._id.toString();
      setTimeout(() => inFlight.delete(eid), 30000);
    });

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

    // Remove confirmed events from in-flight set
    if (_inFlightEvents.has(clientId)) {
      const inFlight = _inFlightEvents.get(clientId);
      eventIds.forEach(id => inFlight.delete(id));
    }

    console.log(`[Events] Confirmed ${eventIds.length} events for client: ${clientId}`);

    res.json({ success: true, confirmed: eventIds.length });

  } catch (err) {
    console.error('[Events] Confirm error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/clients/list — debug: see all registered clients
router.get('/clients/list', async (req, res) => {
  try {
    const clients = await Client.find({}).lean();
    res.json({ success: true, count: clients.length, clients });
  } catch (err) {
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
  console.log('[Webhooks] APP_URL =', APP_URL || 'NOT SET');
  if (!APP_URL) {
    console.error('[Webhooks] APP_URL not set in environment — Bitrix24 webhooks will NOT be registered. Set APP_URL=https://your-render-url.onrender.com in Render environment variables.');
    return false;
  }

  const handlerBase = `${APP_URL}/webhook?clientId=${clientId}`;
  console.log('[Webhooks] Registering handler URL:', handlerBase);

  const events = [
    'ONCRMCONTACTADD',
    'ONCRMCONTACTUPDATE',
    'ONCRMCOMPANYADD',
    'ONCRMCOMPANYUPDATE',
    'ONCRMINVOICEADD',
    'ONCRMINVOICEUPDATE',
    'ONCRMDYNAMICITEMADD', 
    'ONCRMDYNAMICITEMUPDATE',
    'ONCRMDYNAMICITEMDELETE' ,
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
        console.log(`[Webhooks] ✓ Registered ${event} → ${handlerBase}`);
        console.log(`[Webhooks] Registered: ${event}`);
      } catch (e) {
        console.warn(`[Webhooks] Failed to register ${event}: ${e.message}`, e.response?.data || '');
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

// POST /api/clients/reregister — force re-register webhooks for a client
router.post('/clients/reregister', async (req, res) => {
  try {
    const { clientId } = req.body;
    if (!clientId) return res.status(400).json({ success: false, message: 'clientId required' });

    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    const result = await registerBitrixWebhooks(client.bitrixUrl, clientId);
    res.json({ success: true, webhooksRegistered: result, handlerUrl: `${process.env.APP_URL}/webhook?clientId=${clientId}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;