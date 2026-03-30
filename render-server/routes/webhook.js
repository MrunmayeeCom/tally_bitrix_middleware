const express = require('express');
const router  = express.Router();
const Event   = require('../models/Event');
const Client  = require('../models/Client');

// POST /webhook?clientId=xxx
// Receives all Bitrix24 events for a specific client
router.post('/', async (req, res) => {
  try {
    const clientId = req.query.clientId;

    if (!clientId) {
      return res.status(400).json({ success: false, message: 'clientId required' });
    }

    // Verify client exists
    const client = await Client.findOne({ clientId, isActive: true });
    if (!client) {
      console.warn(`[Webhook] Unknown clientId: ${clientId}`);
      // Still return 200 to Bitrix24 so it doesn't retry
      return res.status(200).json({ success: true });
    }

    // Update last seen
    await Client.updateOne({ clientId }, { lastSeenAt: new Date() });

    const payload = req.body;
    const eventType = payload.event;

    if (!eventType) {
      return res.status(200).json({ success: true, message: 'No event type' });
    }

    // Store event in MongoDB for client to pick up
    await Event.create({
      clientId,
      eventType,
      payload,
      processed: false,
    });

    console.log(`[Webhook] Stored event: ${eventType} for client: ${clientId}`);

    // Always return 200 immediately — client processes async
    res.status(200).json({ success: true });

  } catch (err) {
    console.error('[Webhook] Error:', err.message);
    // Still return 200 to prevent Bitrix24 retries
    res.status(200).json({ success: true });
  }
});

module.exports = router;