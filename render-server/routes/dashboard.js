const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');

// In-memory store keyed by clientId
// { [clientId]: { stats, history, lastSync, connStatus, pushedAt } }
const store = {};

// GET /dashboard — serve the dashboard HTML
// Bitrix24 sends member_id in query — use it to find clientId from MongoDB
router.get('/', async (req, res) => {
  const htmlPath = path.join(__dirname, '..', 'public', 'dashboard.html');
  if (!fs.existsSync(htmlPath)) {
    return res.status(404).send('Dashboard not found.');
  }

  // If clientId already in query — serve directly
  if (req.query.clientId) {
    return res.sendFile(htmlPath);
  }

  // Bitrix24 passes member_id in query when opening the app
  const memberId = req.query.member_id || req.query.MEMBER_ID;
  if (memberId) {
    try {
      const OAuthToken = require('../models/OAuthToken');
      const token = await OAuthToken.findOne({ memberId });
      if (token) {
        // Redirect to dashboard with clientId injected
        return res.redirect(`/dashboard?clientId=${token.clientId}`);
      }
    } catch (e) {
      console.error('[Dashboard] member_id lookup failed:', e.message);
    }
  }

  // Fallback — serve dashboard anyway, it will show "agent offline"
  res.sendFile(htmlPath);
});

// POST /dashboard/push?clientId=xxx — agent pushes its status up
router.post('/push', (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ success: false, message: 'clientId required' });

  store[clientId] = {
    ...req.body,
    pushedAt: new Date().toISOString(),
  };

  console.log(`[Dashboard] Push received from clientId: ${clientId}`);
  res.json({ success: true });
});

// GET /dashboard/data?clientId=xxx — dashboard fetches latest data
router.get('/data', (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ success: false, message: 'clientId required' });

  const data = store[clientId];
  if (!data) return res.json({ success: false, message: 'No data yet — agent may be offline' });

  // Mark agent as offline if no push in last 2 minutes
  const pushedAt  = new Date(data.pushedAt);
  const agentLive = (Date.now() - pushedAt.getTime()) < 2 * 60 * 1000;

  res.json({ success: true, agentLive, ...data });
});

module.exports = router;