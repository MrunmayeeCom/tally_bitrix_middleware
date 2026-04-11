const logger = require('../utils/logger');
const os     = require('os');

const RENDER_URL       = process.env.RENDER_SERVER_URL || 'https://tally-bitrix-middleware.onrender.com';
const POLL_INTERVAL_MS = 5000;

// CLIENT_ID must be a function — reads env at call time, not module load time
function getClientId() {
  const email = (process.env.CUSTOMER_EMAIL || '').split('@')[0];
  return process.env.CLIENT_ID || (email ? `${os.hostname()}-${email}` : os.hostname());
}

let _pollerInterval = null;
let _isPolling      = false;
let _registered     = false;
let _lockedClientId = null; // locked at registration time, used for all subsequent polls

async function registerClient(cfg) {
  const clientId  = getClientId();
  _lockedClientId = clientId; // lock it so polls always use same ID
  const email     = cfg.customerEmail || process.env.CUSTOMER_EMAIL || '';
  const bitrixUrl = cfg.bitrixUrl     || process.env.BITRIX_WEBHOOK_URL || '';

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
      _registered = true;
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
    const clientId = _lockedClientId || getClientId();
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
    const clientId = _lockedClientId || getClientId();
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

async function pollOnce() {
  if (_isPolling) return;
  _isPolling = true;

  try {
    const events = await fetchPendingEvents();

    if (events.length === 0) {
      _isPolling = false;
      return;
    }
    logger.info(`[Poller] ${events.length} events received from Render server`);

    logger.info(`[Poller] Received ${events.length} pending events | clientId: ${getClientId()}`);

    // Sort ADD before UPDATE for the same entity — prevents UPDATE arriving
    // before the voucher exists in Tally when both are fetched in the same poll batch
    const sorted = [...events].sort((a, b) => {
      const isAddA = a.eventType && a.eventType.endsWith('ADD') ? 0 : 1;
      const isAddB = b.eventType && b.eventType.endsWith('ADD') ? 0 : 1;
      return isAddA - isAddB;
    });

    const confirmedIds = [];
    for (const event of sorted) {
      await processEvent(event);
      confirmedIds.push(event.eventId);
    }

    await confirmEvents(confirmedIds);

  } catch (err) {
    logger.warn(`[Poller] Poll cycle error: ${err.message}`);
  } finally {
    _isPolling = false;
  }
}

async function startPoller(cfg) {
  if (_pollerInterval) {
    logger.warn('[Poller] Already running — skipping duplicate start');
    return;
  }

  logger.info(`[Poller] Starting event poller | clientId: ${getClientId()}`);

  await registerClient(cfg);

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