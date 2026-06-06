const logger = require('../utils/logger');
const os     = require('os');

const RENDER_URL       = process.env.RENDER_SERVER_URL || 'https://tally-bitrix-middleware.onrender.com';
const POLL_INTERVAL_MS = 5000;

// CLIENT_ID must be a function — reads env at call time, not module load time
function getClientId() {
  const email = (process.env.CUSTOMER_EMAIL || '').split('@')[0];
  return process.env.CLIENT_ID || (email ? `${os.hostname()}-${email}` : os.hostname());
}

// Process-level singleton guard — survives multiple require() calls
if (!global.__pollerState) {
  global.__pollerState = {
    pollerInterval: null,
    isPolling:      false,
    registered:     false,
    lockedClientId: null,
    pendingConfirmIds: new Set(),
    processingEntities: new Set(),
  };
}
const _state = global.__pollerState;

// Keep local aliases for readability
let _pollerInterval = null;

async function registerClient(cfg) {
  const clientId  = getClientId();
  _state.lockedClientId = clientId;
  const bitrixUrl = cfg.bitrixUrl || process.env.BITRIX_WEBHOOK_URL || '';

  // Fetch customerEmail from Render server (Option 2)
  // Falls back to env var only if Render is unreachable
  let email = cfg.customerEmail || process.env.CUSTOMER_EMAIL || '';
  try {
    const axios    = require('axios');
    const emailRes = await axios.get(
      `${RENDER_URL}/api/license/email?clientId=${clientId}`,
      { timeout: 5000 }
    );
    if (emailRes.data?.success && emailRes.data?.email) {
      email = emailRes.data.email;
      process.env.CUSTOMER_EMAIL = email;
      logger.info('[Poller] customerEmail fetched from Render server', { email });
    }
  } catch (e) {
    logger.warn('[Poller] Could not fetch customerEmail from Render — using local fallback', {
      message: e.message,
      fallback: email || 'none',
    });
  }

  if (!email || !bitrixUrl) {
    logger.warn('[Poller] Skipping registration — email or bitrixUrl not set');
    return;
  }

  try {
    const axios = require('axios');
    console.log('[Poller] Registering with Render server:', { url: `${RENDER_URL}/api/clients/register`, clientId, email, bitrixUrl: bitrixUrl ? bitrixUrl.substring(0, 40) + '...' : 'NOT SET' });
    const res = await axios.post(`${RENDER_URL}/api/clients/register`, {
      clientId,
      email,
      bitrixUrl,
    }, { timeout: 10000 });

    if (res.data.success) {
      _state.registered = true;
      logger.info('[Poller] Client registered with Render server', {
        clientId,
        webhooksRegistered: res.data.webhooksRegistered,
      });
    } else {
      logger.warn('[Poller] Registration failed:', res.data.message);
    }
  } catch (err) {
    logger.warn(`[Poller] Could not register with Render server: ${err.message}`);
  }
}

async function fetchPendingEvents() {
  try {
    const axios    = require('axios');
    const clientId = _state.lockedClientId || getClientId();
    const res = await axios.get(`${RENDER_URL}/api/events/pending`, {
      params:  { clientId },
      timeout: 8000,
    });
    return res.data.events || [];
  } catch (err) {
    return [];
  }
}

async function confirmEvents(eventIds) {
  if (!eventIds || eventIds.length === 0) return;
  try {
    const axios    = require('axios');
    const clientId = _state.lockedClientId || getClientId();
    const res = await axios.post(`${RENDER_URL}/api/events/confirm`, {
      clientId,
      eventIds,
    }, { timeout: 5000 });
    if (!res.data?.success) {
      logger.warn('[Poller] Event confirmation returned failure', {
        eventIds,
        response: res.data,
      });
    } else {
      logger.info('[Poller] Events confirmed successfully', { count: eventIds.length, eventIds });
    }
  } catch (err) {
    logger.warn(`[Poller] Could not confirm events: ${err.message}`, { eventIds });
  }
}

async function processEvent(event) {
  try {
    logger.info(`[Poller] Processing event: ${event.eventType}`);
    const { handleWebhookPayload } = require('../controllers/webhookController');
    await handleWebhookPayload(event.payload);
    logger.info(`[Poller] Event processed: ${event.eventType}`);
  } catch (err) {
    logger.error(`[Poller] Event processing failed: ${event.eventType}`, {
      message: err.message
    });
  }
}

// _processingEntities and _pendingConfirmIds live in _state — do not redeclare here

async function pollOnce() {
  if (_state.isPolling) return;
  _state.isPolling = true;

  try {
    // Flush any previously confirmed-but-not-yet-ACKed events first
    if (_state.pendingConfirmIds.size > 0) {
      const toFlush = [..._state.pendingConfirmIds];
      _state.pendingConfirmIds.clear();
      await confirmEvents(toFlush);
    }

    const events = await fetchPendingEvents();

    if (events.length === 0) return;

    logger.info(`[Poller] ${events.length} events received from Render server`);
    logger.info(`[Poller] Received ${events.length} pending events | clientId: ${getClientId()}`);

    // Filter out events already confirmed or currently being processed
    const filteredEvents = events.filter(event => {
      if (_state.pendingConfirmIds.has(event.eventId)) {
        logger.info(`[Poller] Skipping already-confirmed event`, { eventId: event.eventId });
        return false;
      }
      const entityId = event.payload?.entityId || event.entityId;
      if (_state.processingEntities.has(entityId)) {
        logger.info(`[Poller] Skipping entity being processed in previous cycle`, { entityId, eventId: event.eventId });
        return false;
      }
      return true;
    });

    // Deduplicate by entityId within the same poll cycle
    const seenEntities = new Set();
    const uniqueEvents = [];
    for (const event of filteredEvents) {
      const entityId = event.payload?.entityId || event.entityId;
      if (!seenEntities.has(entityId)) {
        seenEntities.add(entityId);
        _state.processingEntities.add(entityId);
        uniqueEvents.push(event);
      } else {
        logger.info(`[Poller] Skipping duplicate entity in same poll cycle`, { entityId, eventId: event.eventId });
      }
    }

    const sorted = [...uniqueEvents].sort((a, b) => {
      const isAddA = a.eventType && a.eventType.endsWith('ADD') ? 0 : 1;
      const isAddB = b.eventType && b.eventType.endsWith('ADD') ? 0 : 1;
      return isAddA - isAddB;
    });

    const confirmedIds = [];
    for (const event of sorted) {
      try {
        await processEvent(event);
        confirmedIds.push(event.eventId);
        // Mark confirmed immediately so next poll cycle skips it
        _state.pendingConfirmIds.add(event.eventId);
      } catch (err) {
        logger.warn(`[Poller] Skipping confirmation for failed event: ${event.eventId}`, { error: err.message });
      } finally {
        const entityId = event.payload?.entityId || event.entityId;
        _state.processingEntities.delete(entityId);
      }
    }

    if (confirmedIds.length > 0) {
      // Fire without awaiting — next poll will flush if this fails
      confirmEvents(confirmedIds).catch(err => {
        logger.warn(`[Poller] Confirm failed — will retry on next cycle: ${err.message}`);
      });
    }

  } catch (err) {
    logger.warn(`[Poller] Poll cycle error: ${err.message}`);
  } finally {
    _state.isPolling = false;
  }
}

async function startPoller(cfg) {
  if (_state.pollerInterval) {
    logger.warn('[Poller] Already running — skipping duplicate start');
    return;
  }

  logger.info(`[Poller] Starting event poller | clientId: ${getClientId()}`);

  await registerClient(cfg);

  _state.pollerInterval = setInterval(pollOnce, POLL_INTERVAL_MS);
  _pollerInterval = _state.pollerInterval; // keep local alias in sync

  logger.info(`[Poller] Polling every ${POLL_INTERVAL_MS / 1000}s`);
}

function stopPoller() {
  if (_state.pollerInterval) {
    clearInterval(_state.pollerInterval);
    _state.pollerInterval = null;
    _pollerInterval = null;
    logger.info('[Poller] Stopped');
  }
}

function isRegistered() { return _state.registered; }

module.exports = { startPoller, stopPoller, isRegistered, registerClient };