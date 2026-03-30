const logger = require('../utils/logger');

const RENDER_URL  = process.env.RENDER_SERVER_URL || 'https://yourapp.onrender.com';
const POLL_INTERVAL_MS = 5000; // poll every 5 seconds
const CLIENT_ID   = process.env.CLIENT_ID || require('os').hostname();

let _pollerInterval = null;
let _isPolling      = false;
let _registered     = false;

// ── Register this client with Render server ───────────────────────────────────
async function registerClient(cfg) {
  try {
    const http  = require('https');
    const axios = require('axios');

    const res = await axios.post(`${RENDER_URL}/api/clients/register`, {
      clientId: CLIENT_ID,
      email:    cfg.customerEmail || '',
      bitrixUrl:cfg.bitrixUrl     || process.env.BITRIX_WEBHOOK_URL,
    }, { timeout: 10000 });

    if (res.data.success) {
      _registered = true;
      logger.info(`[Poller] Client registered with Render server`, {
        clientId: CLIENT_ID,
        webhooksRegistered: res.data.webhooksRegistered,
      });
    } else {
      logger.warn('[Poller] Registration failed:', res.data.message);
    }
  } catch (err) {
    logger.warn(`[Poller] Could not register with Render server: ${err.message}`);
    // Non-fatal — will retry on next poll cycle
  }
}

// ── Fetch pending events from Render ─────────────────────────────────────────
async function fetchPendingEvents() {
  try {
    const axios = require('axios');
    const res = await axios.get(`${RENDER_URL}/api/events/pending`, {
      params:  { clientId: CLIENT_ID },
      timeout: 8000,
    });
    return res.data.events || [];
  } catch (err) {
    // Silently fail — Render may be briefly unavailable
    return [];
  }
}

// ── Confirm processed events ──────────────────────────────────────────────────
async function confirmEvents(eventIds) {
  if (!eventIds || eventIds.length === 0) return;
  try {
    const axios = require('axios');
    await axios.post(`${RENDER_URL}/api/events/confirm`, {
      clientId: CLIENT_ID,
      eventIds,
    }, { timeout: 5000 });
  } catch (err) {
    logger.warn(`[Poller] Could not confirm events: ${err.message}`);
  }
}

// ── Process a single event ────────────────────────────────────────────────────
async function processEvent(event) {
  try {
    logger.info(`[Poller] Processing event: ${event.eventType}`);

    // Route to existing webhook handler
    const { handleWebhookPayload } = require('../controllers/webhookController');
    await handleWebhookPayload(event.payload);

    logger.info(`[Poller] Event processed: ${event.eventType}`);
  } catch (err) {
    logger.error(`[Poller] Event processing failed: ${event.eventType}`, {
      message: err.message
    });
    // Still confirm — prevents infinite retry loop for bad events
  }
}

// ── Main poll loop ────────────────────────────────────────────────────────────
async function pollOnce() {
  if (_isPolling) return; // prevent overlapping polls
  _isPolling = true;

  try {
    const events = await fetchPendingEvents();

    if (events.length === 0) {
      _isPolling = false;
      return;
    }

    logger.info(`[Poller] Received ${events.length} pending events`);

    const confirmedIds = [];

    for (const event of events) {
      await processEvent(event);
      confirmedIds.push(event.eventId);
    }

    // Confirm all processed events
    await confirmEvents(confirmedIds);

  } catch (err) {
    logger.warn(`[Poller] Poll cycle error: ${err.message}`);
  } finally {
    _isPolling = false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
async function startPoller(cfg) {
  if (_pollerInterval) {
    logger.warn('[Poller] Already running');
    return;
  }

  logger.info(`[Poller] Starting event poller | clientId: ${CLIENT_ID}`);

  // Register with Render server first
  await registerClient(cfg);

  // Start polling
  _pollerInterval = setInterval(pollOnce, POLL_INTERVAL_MS);

  logger.info(`[Poller] Polling every ${POLL_INTERVAL_MS / 1000}s`);
}

function stopPoller() {
  if (_pollerInterval) {
    clearInterval(_pollerInterval);
    _pollerInterval = null;
    logger.info('[Poller] Stopped');
  }
}

function isRegistered() { return _registered; }

module.exports = { startPoller, stopPoller, isRegistered, registerClient };